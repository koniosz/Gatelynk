import * as crypto from 'crypto'
import { Injectable, UnauthorizedException, NotFoundException, BadGatewayException, BadRequestException, Logger } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { PrismaService } from '../prisma/prisma.service'
import { EdgeGateway } from '../edge/edge.gateway'
import { EdgeService } from '../edge/edge.service'
import { EdgeOutboxService } from '../edge/edge-outbox.service'
import { MailService } from '../mail/mail.service'
import { IntegratorReadinessService, type ReadinessSummary } from './readiness.service'
import { StairwellIntercomDto, UpdateLprCameraDto } from '../buildings/buildings.service'
import {
  DEFAULT_FEATURES,
  DEFAULT_EXIT_GRACE,
  EXIT_GRACE_MIN_MINUTES,
  EXIT_GRACE_MAX_MINUTES,
  isObjectType,
  normalizeFeatures,
  normalizeExitGrace,
  type BuildingFeatures,
  type ExitGraceConfig,
  type ObjectType,
} from '../buildings/buildings.constants'
import {
  SYSTEM_FEATURES,
  FEATURE_LABELS,
  ROLE_LABELS,
  ROLES,
  normalizePermissions,
  defaultPermissionsFor,
  type BuildingFeaturePermissions,
  type Role,
} from '../buildings/feature-permissions.constants'
import {
  AP_CATEGORIES,
  isApCategory,
  isLprDirection,
  type ApCategory,
  type LprDirection,
} from '../access-points/access-points.constants'
import { CAMERA_ROLES, isCameraRole, type CameraRole } from '../cameras/cameras.constants'
import { findDriver, certifiedFor } from '@gatelynk/device-drivers'
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, ValidateIf } from 'class-validator'
import { sortUnits } from '../common/natural-sort'

// 2026-06-02: Integrator dostaje pełne sterowanie nad bindingiem AP →
// urządzenie/wyjście oraz LPR camera → AP. BA ma te endpointy READ-ONLY
// (`BaUpdateAccessPointDto` w UI nie wystawia binding fields, ale samo API
// nadal przyjmuje — defense-in-depth zostawione na osobną sesję, patrz
// sekcja E. zadania).
//
// Decyzja: zamiast injekcji `BuildingAdminService` do `IntegratorModule`
// (ryzyko circular dep + zmiana exports BuildingAdminModule), duplikujemy
// logikę 1:1. Patrz `// DUP z building-admin.service.ts:<method>` komentarze
// — gdyby kod BA zmienił semantykę, te dwa muszą być zsynchronizowane.
const INTEGRATOR_AP_ICONS = ['door', 'garage', 'gate', 'elevator', 'barrier'] as const
type IntegratorApIcon = typeof INTEGRATOR_AP_ICONS[number]
const INTEGRATOR_AP_SCOPES = ['PUBLIC', 'RESIDENT', 'ADMIN_ONLY'] as const
type IntegratorApScope = typeof INTEGRATOR_AP_SCOPES[number]

export class IntegratorUpdateAccessPointDto {
  @IsOptional() @IsString() label?: string
  @IsOptional() @IsIn(INTEGRATOR_AP_ICONS) icon?: IntegratorApIcon
  @IsOptional() @IsBoolean() isActive?: boolean
  @IsOptional() @IsIn(INTEGRATOR_AP_SCOPES) scope?: IntegratorApScope
  // Binding device→output — to jest core dodatkowego scope integratora.
  // `outputDeviceId` może być null (rozłączenie), wtedy też `outputIndex`
  // powinien być null. `ValidateIf` pozwala pominąć walidatory dla null.
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() outputDeviceId?: string | null
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt()    outputIndex?: number | null
  @IsOptional() @IsInt() durationMs?: number
}

// Tailscale userspace HTTP proxy — ten sam pattern co w EdgeService /
// LprReadsController / ResidentService. Cloud na Fly.io nie ma /dev/net/tun,
// więc tailscaled chodzi w userspace mode i routujemy ruch do Edge przez
// localhost:1055. Bez tego natywny fetch nie ma routingu do tailnetu.
const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

@Injectable()
export class IntegratorService {
  private readonly logger = new Logger(IntegratorService.name)

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private edgeGateway: EdgeGateway,
    private edge: EdgeService,
    private edgeOutbox: EdgeOutboxService,
    private mail: MailService,
    private readiness: IntegratorReadinessService,
  ) {}

  async login(email: string, password: string) {
    const integrator = await this.prisma.integrator.findUnique({ where: { email } })
    if (!integrator) throw new UnauthorizedException('Nieprawidłowy email lub hasło')
    const bcrypt = await import('bcrypt')
    const valid = await bcrypt.compare(password, integrator.passwordHash)
    if (!valid) throw new UnauthorizedException('Nieprawidłowy email lub hasło')
    const payload = {
      sub: integrator.id,
      email: integrator.email,
      type: 'integrator',
      adminId: integrator.adminId,
    }
    return {
      access_token: this.jwtService.sign(payload),
      integrator: { id: integrator.id, name: integrator.name, email: integrator.email },
    }
  }

  // ── Budynki ─────────────────────────────────────────────────────────────────
  async getBuildings(adminId: number) {
    return this.prisma.building.findMany({
      where: { adminId, isArchived: false },
      include: {
        stairwells: { orderBy: { createdAt: 'asc' } },
        _count: { select: { units: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async getBuilding(buildingId: number, adminId: number) {
    const building = await this.prisma.building.findFirst({
      where: { id: buildingId, adminId, isArchived: false },
      include: {
        stairwells: {
          orderBy: { createdAt: 'asc' },
          include: { intercom: true },
        },
        lprCameras: { orderBy: { id: 'asc' } },
      },
    })
    if (!building) throw new NotFoundException('Budynek nie istnieje')
    return building
  }

  // ── Domofon klatki ──────────────────────────────────────────────────────────
  async getStairwellDetail(buildingId: number, stairwellId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    const sw = await this.prisma.stairwell.findFirst({
      where: { id: stairwellId, buildingId },
      include: { intercom: true },
    })
    if (!sw) throw new NotFoundException('Klatka nie istnieje')

    // Wzbogać `intercom` o `driverId` + `config` — Prisma client nie zna tych
    // kolumn (patrz CLAUDE.md, znany problem z Prismą 7.5/5.22).
    if (sw.intercom) {
      const [extra] = await this.prisma.$queryRaw<{ driverId: string | null; config: any }[]>`
        SELECT "driverId", config
        FROM stairwell_intercoms
        WHERE "stairwellId" = ${stairwellId}
      `
      ;(sw.intercom as any).driverId = extra?.driverId ?? null
      ;(sw.intercom as any).config   = extra?.config   ?? null
    }
    return sw
  }

  /**
   * Patrz `BuildingsService.upsertStairwellIntercom` — ta wersja (integrator)
   * dzieli logikę 1:1, ale używa innej autoryzacji (`getBuilding` zamiast
   * `findOne`). Cały merge-and-save przerzucamy do BuildingsService, żeby
   * pojedyncze źródło prawdy.
   */
  async upsertStairwellIntercom(
    buildingId: number,
    stairwellId: number,
    adminId: number,
    dto: StairwellIntercomDto,
  ) {
    await this.getBuilding(buildingId, adminId)
    const stairwell = await this.prisma.stairwell.findFirst({
      where: { id: stairwellId, buildingId },
    })
    if (!stairwell) throw new NotFoundException('Klatka nie istnieje')

    // Scal legacy + nowy format (driverId + config blob).
    const cfg = (dto.config ?? {}) as Record<string, unknown>
    const merged = {
      manufacturer: dto.manufacturer ?? (typeof cfg.manufacturer === 'string' ? cfg.manufacturer : undefined) ?? 'Akuvox',
      model:        dto.model        ?? (typeof cfg.model        === 'string' ? cfg.model        : undefined) ?? null,
      ipAddress:    dto.ipAddress    ?? (typeof cfg.ipAddress    === 'string' ? cfg.ipAddress    : undefined) ?? null,
      login:        dto.login        ?? (typeof cfg.login        === 'string' ? cfg.login        : undefined) ?? null,
      password:     dto.password     ?? (typeof cfg.password     === 'string' ? cfg.password     : undefined) ?? null,
      relays:       dto.relays       ?? (Array.isArray(cfg.relays) ? cfg.relays : undefined) ?? null,
    }

    await this.prisma.stairwellIntercom.upsert({
      where: { stairwellId },
      create: {
        stairwellId,
        manufacturer: merged.manufacturer,
        model:        merged.model,
        ipAddress:    merged.ipAddress,
        login:        merged.login,
        password:     merged.password,
        relays:       merged.relays as any,
      },
      update: {
        manufacturer: merged.manufacturer,
        model:        merged.model,
        ipAddress:    merged.ipAddress,
        login:        merged.login,
        password:     merged.password,
        relays:       merged.relays as any,
      },
    })

    if (dto.driverId !== undefined || dto.config !== undefined) {
      const configJson = dto.config !== undefined ? JSON.stringify(dto.config) : null
      await this.prisma.$executeRaw`
        UPDATE stairwell_intercoms
        SET "driverId" = ${dto.driverId ?? null},
            config     = ${configJson}::jsonb
        WHERE "stairwellId" = ${stairwellId}
      `
    }

    const [row] = await this.prisma.$queryRaw<any[]>`
      SELECT id, "stairwellId", manufacturer, model, "ipAddress", login, password,
             relays, "driverId", config, "updatedAt"
      FROM stairwell_intercoms
      WHERE "stairwellId" = ${stairwellId}
    `
    return row
  }

  // ── Domofony budynku ────────────────────────────────────────────────────────
  async createIntercom(
    buildingId: number,
    adminId: number,
    dto: { name: string; model?: string | null; edgeDeviceId?: string | null },
  ) {
    await this.getBuilding(buildingId, adminId)
    const created = await this.prisma.buildingIntercom.create({
      data: {
        buildingId,
        name: dto.name,
        model: dto.model ?? null,
      },
    })
    if (dto.edgeDeviceId) {
      await this.prisma.$executeRaw`
        UPDATE building_intercoms SET "edgeDeviceId" = ${dto.edgeDeviceId} WHERE id = ${created.id}
      `
    }
    const [row] = await this.prisma.$queryRaw<any[]>`
      SELECT id, "buildingId", name, model, "ipAddress", "sipServer", "sipAccount", "sipPassword",
             "edgeDeviceId", "createdAt", "updatedAt"
      FROM building_intercoms WHERE id = ${created.id}
    `
    return row
  }

  async getIntercoms(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    // Raw SELECT włącza też "edgeDeviceId" (Prisma client nie zna tego pola — patrz CLAUDE.md pitfall #2)
    return this.prisma.$queryRaw<any[]>`
      SELECT id, "buildingId", name, model, "ipAddress", "sipServer", "sipAccount", "sipPassword",
             "edgeDeviceId", "bridgeEnabled", "createdAt", "updatedAt"
      FROM building_intercoms
      WHERE "buildingId" = ${buildingId}
      ORDER BY id ASC
    `
  }

  async updateIntercom(
    buildingId: number,
    intercomId: number,
    adminId: number,
    data: {
      name?: string
      ipAddress?: string | null
      login?: string | null
      password?: string | null
      edgeDeviceId?: string | null
      /** Multi-station call bridge (2026-07-05) — most rozmów per stacja. */
      bridgeEnabled?: boolean
    },
  ) {
    await this.getBuilding(buildingId, adminId)
    const intercom = await this.prisma.buildingIntercom.findFirst({ where: { id: intercomId, buildingId } })
    if (!intercom) throw new NotFoundException('Domofon nie istnieje')

    // Aktualizacja pól znanych Prismie
    await this.prisma.buildingIntercom.update({
      where: { id: intercomId },
      data: {
        name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined,
        ipAddress: data.ipAddress ?? undefined,
        sipAccount: data.login ?? undefined,
        sipPassword: data.password ?? undefined,
      },
    })

    // Aktualizacja edgeDeviceId (Prisma client nie zna pola — raw SQL)
    if (data.edgeDeviceId !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE building_intercoms SET "edgeDeviceId" = ${data.edgeDeviceId} WHERE id = ${intercomId}
      `
    }

    // Multi-station: bridgeEnabled per stacja (raw SQL jak edgeDeviceId).
    if (typeof data.bridgeEnabled === 'boolean') {
      await this.prisma.$executeRaw`
        UPDATE building_intercoms SET "bridgeEnabled" = ${data.bridgeEnabled} WHERE id = ${intercomId}
      `
    }

    const [updated] = await this.prisma.$queryRaw<any[]>`
      SELECT id, "buildingId", name, model, "ipAddress", "sipServer", "sipAccount", "sipPassword",
             "edgeDeviceId", "bridgeEnabled", "createdAt", "updatedAt"
      FROM building_intercoms WHERE id = ${intercomId}
    `

    // Live push rejestru stacji do Edge (INTERCOM_SYNC_ALL, replace-all —
    // idempotentne jak sync przy reconnect). Bez tego zmiana bridgeEnabled/
    // nazwy czekałaby na restart tunelu.
    this.pushIntercomSyncAll(buildingId).catch((err: Error) =>
      this.logger.warn(`INTERCOM_SYNC_ALL push failed b#${buildingId}: ${err.message}`),
    )

    return updated
  }

  /**
   * Pełny rejestr stacji budynku → Edge (`INTERCOM_SYNC_ALL`). Ten sam payload
   * co w EdgeGateway.pushAccessPointSync (reconnect) — tu wysyłany po każdej
   * edycji domofonu w panelu Integratora, żeby Edge miał świeżą mapę
   * fromUri→stacja bez czekania na reconnect.
   */
  private async pushIntercomSyncAll(buildingId: number): Promise<void> {
    const intercoms = await this.prisma.$queryRaw<Array<{
      id: number; name: string; edgeDeviceId: string | null;
      ipAddress: string | null; bridgeEnabled: boolean;
    }>>`
      SELECT id, name, "edgeDeviceId", "ipAddress", "bridgeEnabled"
        FROM building_intercoms
       WHERE "buildingId" = ${buildingId}
       ORDER BY id ASC
    `
    await this.edgeGateway.sendToBuilding(buildingId, 'INTERCOM_SYNC_ALL', {
      items: intercoms.map((i) => ({
        intercomId: i.id,
        buildingId,
        name: i.name,
        edgeDeviceId: i.edgeDeviceId,
        ipAddress: i.ipAddress,
        bridgeEnabled: i.bridgeEnabled === true,
      })),
    })
  }

  // ── Kamery LPR ──────────────────────────────────────────────────────────────
  // Architecture: Edge owns the whitelist (SQLite `lpr_plates`). Camera is a
  // dumb detector that POSTs ANPR events; Edge matches and triggers the linked
  // intercom relay to open the gate.
  //
  // Columns `whitelistMode` / `cameraListSyncMethod` remain in the schema for
  // backward compat, but are no longer written from the API. They default to
  // 'edge' / NULL server-side.
  async createLprCamera(
    buildingId: number,
    adminId: number,
    dto: {
      name: string
      manufacturer?: string | null
      model?: string | null
      edgeDeviceId?: string | null
      linkedIntercomEdgeId?: string | null
      linkedRelayIndex?: number | null
      // FAZA 8.h (2026-06-03) — opcjonalna rola przy tworzeniu. Default 'LPR'
      // (backwards-compat z assignTo z DeviceTreeSection — historycznie
      // tworzony jako kamera LPR).
      role?: CameraRole
      aiAnalysisEnabled?: boolean
    },
  ) {
    await this.getBuilding(buildingId, adminId)
    const created = await this.prisma.lprCamera.create({
      data: {
        buildingId,
        name: dto.name,
        manufacturer: dto.manufacturer ?? 'Hikvision',
        model: dto.model ?? null,
      },
    })
    // Additional fields via raw SQL — Prisma generate is flaky in this
    // monorepo (see CLAUDE.md #Prisma). FAZA 8.h: role + aiAnalysisEnabled
    // też idą raw SQL bo Prisma Client jeszcze nie zna nowych kolumn.
    const role: CameraRole = isCameraRole(dto.role) ? dto.role : 'LPR'
    const aiAnalysisEnabled = dto.aiAnalysisEnabled === false ? false : true
    await this.prisma.$executeRaw`
      UPDATE lpr_cameras
         SET "edgeDeviceId"         = ${dto.edgeDeviceId ?? null},
             "linkedIntercomEdgeId" = ${dto.linkedIntercomEdgeId ?? null},
             "linkedRelayIndex"     = ${dto.linkedRelayIndex ?? null},
             "role"                 = ${role},
             "aiAnalysisEnabled"    = ${aiAnalysisEnabled}
       WHERE id = ${created.id}
    `
    const [row] = await this.prisma.$queryRaw<any[]>`
      SELECT id, "buildingId", name, manufacturer, model, "ipAddress", login, password,
             "edgeDeviceId",
             "linkedIntercomEdgeId", "linkedRelayIndex",
             "role", "aiAnalysisEnabled",
             "updatedAt"
      FROM lpr_cameras WHERE id = ${created.id}
    `

    // FAZA 8.h — seed config do Edge od razu (jeśli mamy edgeDeviceId), żeby
    // VisionDetectService cycle widział poprawny state od pierwszego ticka.
    // Bez tego Edge ma defaults (LPR + AI ON), które są OK dla LPR ale błędne
    // gdy integrator od razu tworzy STANDARD CCTV.
    if (dto.edgeDeviceId) {
      this.edgeGateway
        .sendToBuilding(buildingId, 'CAMERA_CONFIG_UPDATE', {
          cameraDeviceId: dto.edgeDeviceId,
          role,
          aiAnalysisEnabled,
        })
        .catch((err) =>
          this.logger.warn(`CAMERA_CONFIG_UPDATE seed failed for b#${buildingId}: ${err.message}`),
        )
    }

    return row
  }

  async getLprCameras(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    // FAZA 8.h.1+ (2026-06-05) — IP fallback z edge_device_mirror.config +
    // edgeMirrorType na potrzeby UI mismatch hints.
    //
    // WAŻNE — semantyka kluczy:
    //   `LprCamera.edgeDeviceId`  = UUID konkretnego urządzenia w Edge sqlite
    //   `EdgeDeviceMirror.deviceUuid` = TEN SAM UUID urządzenia
    //   `EdgeDeviceMirror.edgeDeviceId` = cuid serwera Edge (Mac Mini)
    // JOIN po `m.deviceUuid = lc.edgeDeviceId` (poprzednia próba po
    // m.edgeDeviceId była błędna — 0 matches).
    //
    // `lpr_cameras.ipAddress` często jest NULL (legacy entries dodane przez
    // Edge wizard z assignment-em bez explicit IP), ale Edge mirror ZAWSZE
    // ma `config.ipAddress` bo wizard tego wymaga.
    return this.prisma.$queryRaw<any[]>`
      SELECT lc.id, lc."buildingId", lc.name, lc.manufacturer, lc.model,
             COALESCE(lc."ipAddress", m."config"->>'ipAddress') AS "ipAddress",
             lc.login, lc.password,
             lc."edgeDeviceId",
             lc."linkedIntercomEdgeId", lc."linkedRelayIndex",
             lc."role", lc."aiAnalysisEnabled",
             m."type" AS "edgeMirrorType",
             lc."updatedAt"
        FROM lpr_cameras lc
   LEFT JOIN edge_device_mirror m ON m."deviceUuid" = lc."edgeDeviceId"
                                 AND m."buildingId" = lc."buildingId"
       WHERE lc."buildingId" = ${buildingId}
       ORDER BY lc.id ASC
    `
  }

  async updateLprCamera(
    buildingId: number,
    cameraId: number,
    adminId: number,
    dto: UpdateLprCameraDto & {
      edgeDeviceId?: string | null
      linkedIntercomEdgeId?: string
      linkedRelayIndex?: number
    },
  ) {
    await this.getBuilding(buildingId, adminId)
    const cam = await this.prisma.lprCamera.findFirst({ where: { id: cameraId, buildingId } })
    if (!cam) throw new NotFoundException('Kamera nie istnieje')

    // Split: Prisma handles columns that existed before the whitelist-mode
    // migration; raw SQL handles the newer ones (schema-drift workaround —
    // see CLAUDE.md).
    const {
      edgeDeviceId,
      linkedIntercomEdgeId,
      linkedRelayIndex,
      ...known
    } = dto
    if (Object.keys(known).length > 0) {
      await this.prisma.lprCamera.update({ where: { id: cameraId }, data: known })
    }

    if (edgeDeviceId !== undefined) {
      await this.prisma.$executeRaw`UPDATE lpr_cameras SET "edgeDeviceId" = ${edgeDeviceId} WHERE id = ${cameraId}`
    }
    if (linkedIntercomEdgeId !== undefined) {
      await this.prisma.$executeRaw`UPDATE lpr_cameras SET "linkedIntercomEdgeId" = ${linkedIntercomEdgeId} WHERE id = ${cameraId}`
    }
    if (linkedRelayIndex !== undefined) {
      await this.prisma.$executeRaw`UPDATE lpr_cameras SET "linkedRelayIndex" = ${linkedRelayIndex} WHERE id = ${cameraId}`
    }

    const [updated] = await this.prisma.$queryRaw<any[]>`
      SELECT id, "buildingId", name, manufacturer, model, "ipAddress", login, password,
             "edgeDeviceId",
             "linkedIntercomEdgeId", "linkedRelayIndex",
             "role", "aiAnalysisEnabled",
             "updatedAt"
      FROM lpr_cameras WHERE id = ${cameraId}
    `
    return updated
  }

  // ── FAZA 8.h (2026-06-03) — Camera role + AI toggle ───────────────────────
  /**
   * PATCH /integrator/buildings/:id/cameras/:cameraId
   *
   * Partial update: role i/lub aiAnalysisEnabled. Wymaga ownership buildingId
   * po `Building.adminId`. Raw SQL bo Prisma Client jeszcze nie zna pól
   * przed `prisma generate`. Po update wysyła `CAMERA_CONFIG_UPDATE` przez
   * tunnel + outbox; Edge filtruje VisionDetectService.listCameras() po
   * `aiAnalysisEnabled`.
   *
   * Zwraca pełny camera-row po update (jak getLprCameras item).
   */
  async updateCamera(
    buildingId: number,
    cameraId: number,
    adminId: number,
    integratorId: number,
    body: { role?: string; aiAnalysisEnabled?: boolean },
  ) {
    await this.getBuilding(buildingId, adminId)
    const [cam] = await this.prisma.$queryRaw<Array<{
      id: number
      edgeDeviceId: string | null
      role: string
      aiAnalysisEnabled: boolean
    }>>`
      SELECT id, "edgeDeviceId", role, "aiAnalysisEnabled"
        FROM lpr_cameras
       WHERE id = ${cameraId} AND "buildingId" = ${buildingId}
    `
    if (!cam) throw new NotFoundException('Kamera nie istnieje')

    // Walidacja role — defense-in-depth poza CHECK constraint w DB.
    let nextRole: CameraRole | undefined
    if (body.role !== undefined) {
      if (!isCameraRole(body.role)) {
        throw new BadRequestException(
          `Nieprawidłowa rola — dozwolone: ${CAMERA_ROLES.join(', ')}`,
        )
      }
      nextRole = body.role
    }
    const nextAi = typeof body.aiAnalysisEnabled === 'boolean' ? body.aiAnalysisEnabled : undefined

    if (nextRole === undefined && nextAi === undefined) {
      throw new BadRequestException('Brak pól do aktualizacji (role lub aiAnalysisEnabled)')
    }

    // Raw SQL — Prisma Client może nie znać nowych kolumn przed `prisma generate`.
    if (nextRole !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE lpr_cameras SET "role" = ${nextRole} WHERE id = ${cameraId}
      `
    }
    if (nextAi !== undefined) {
      await this.prisma.$executeRaw`
        UPDATE lpr_cameras SET "aiAnalysisEnabled" = ${nextAi} WHERE id = ${cameraId}
      `
    }

    // Push do Edge (tunnel + outbox). Bez edgeDeviceId Edge nie wie o czym
    // mówimy — skip; Cloud-only zmiana zostanie zsync-owana przy następnym
    // CAMERA_CONFIG_UPDATE po assigned-iu do device-a.
    if (cam.edgeDeviceId) {
      const payload: Record<string, unknown> = { cameraDeviceId: cam.edgeDeviceId }
      if (nextRole !== undefined) payload.role = nextRole
      if (nextAi !== undefined) payload.aiAnalysisEnabled = nextAi
      this.edgeGateway
        .sendToBuilding(buildingId, 'CAMERA_CONFIG_UPDATE', payload)
        .catch((err) =>
          this.logger.warn(`CAMERA_CONFIG_UPDATE push failed for b#${buildingId} cam#${cameraId}: ${err.message}`),
        )
    }

    this.logAudit(integratorId, 'CAMERA_CONFIG_UPDATE', {
      targetType: 'CAMERA',
      targetId: String(cameraId),
      buildingId,
      meta: {
        role: nextRole,
        aiAnalysisEnabled: nextAi,
        edgeDeviceId: cam.edgeDeviceId,
      },
    })

    const [updated] = await this.prisma.$queryRaw<any[]>`
      SELECT id, "buildingId", name, manufacturer, model, "ipAddress", login, password,
             "edgeDeviceId",
             "linkedIntercomEdgeId", "linkedRelayIndex",
             "role", "aiAnalysisEnabled",
             "updatedAt"
      FROM lpr_cameras WHERE id = ${cameraId}
    `
    return updated
  }

  // ── Edge — status ────────────────────────────────────────────────────────────
  async getEdgeStatus(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    const devices = await this.prisma.edgeDevice.findMany({
      where: { buildingId },
      select: {
        id: true, type: true, name: true,
        isActivated: true, activatedAt: true,
        lastSeenAt: true, ipAddress: true, version: true,
      },
      orderBy: { createdAt: 'asc' },
    })
    return devices.map((d) => ({
      ...d,
      isOnline: this.edgeGateway.isOnline(d.id),
    }))
  }

  // ── Edge — proxy HTTP to Edge device ─────────────────────────────────────────
  private async getActiveEdgeIp(buildingId: number): Promise<string> {
    // 1. Najpierw sprawdź live połączenie w gateway (najświeższe IP)
    const liveIp = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (liveIp) return liveIp

    // 2. Fallback: IP zapisane w bazie podczas ostatniego połączenia
    const edge = await this.prisma.edgeDevice.findFirst({
      where: { buildingId, type: 'EDGE', isActivated: true },
      orderBy: { lastSeenAt: 'desc' },
    })
    if (!edge?.ipAddress) throw new NotFoundException('Brak aktywnego urządzenia Edge z adresem IP')
    return edge.ipAddress
  }

  async getEdgeDevices(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    const ip = await this.getActiveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices`, {
        signal: AbortSignal.timeout(8000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    } catch (err: any) {
      throw new BadGatewayException(`Brak odpowiedzi z Edge: ${err.message}`)
    }
  }

  async triggerEdgeRelay(buildingId: number, adminId: number, deviceId: string, relayIndex: number) {
    await this.getBuilding(buildingId, adminId)
    const ip = await this.getActiveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices/${deviceId}/relay/${relayIndex}`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    } catch (err: any) {
      throw new BadGatewayException(`Błąd relay: ${err.message}`)
    }
  }

  async getEdgeSnapshot(buildingId: number, adminId: number, deviceId: string) {
    await this.getBuilding(buildingId, adminId)
    const ip = await this.getActiveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices/${deviceId}/snapshot`, {
        signal: AbortSignal.timeout(15000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    } catch (err: any) {
      throw new BadGatewayException(`Błąd snapshot: ${err.message}`)
    }
  }

  async getEdgeStreamUrl(buildingId: number, adminId: number, deviceId: string): Promise<{ url: string }> {
    await this.getBuilding(buildingId, adminId)
    const ip = await this.getActiveEdgeIp(buildingId)
    return { url: `http://${ip}:4000/devices/${deviceId}/stream` }
  }

  async restartEdgeDevice(buildingId: number, adminId: number, deviceId: string) {
    await this.getBuilding(buildingId, adminId)
    const ip = await this.getActiveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices/${deviceId}/restart`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    } catch (err: any) {
      throw new BadGatewayException(`Błąd restartu: ${err.message}`)
    }
  }

  // ── Smart locks — Nuki (2026-07-08) ─────────────────────────────────────────
  //
  // Zamek Nuki = urządzenie SMART_LOCK na Edge + AccessPoint category=UNIT_DOOR
  // z `unitId` (przypisanie do lokalu). BEZPIECZEŃSTWO TOKENU (wiążąca decyzja
  // właściciela): token API Nuki żyje WYŁĄCZNIE na Edge (device_config sqlite,
  // jak hasła kamer). Cloud NIGDY go nie zapisuje — przekazujemy pass-through
  // bezpośrednim HTTP do Edge (`POST/PATCH /devices`), NIE przez tunel/outbox
  // (outbox trzyma payloady w Postgres). Konsekwencja: dodanie/edycja tokenu
  // wymaga Edge ONLINE (instalator i tak jest na obiekcie). Mirror urządzeń
  // (DEVICE_UPSERT) sanityzuje `apiToken` → `apiTokenIsSet` po stronie Cloud
  // (EdgeGateway.sanitizeDeviceConfig).

  /** Lista zamków (AP category=UNIT_DOOR) z lokalem. Bez tokenów. */
  async listSmartLocks(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    const aps = await this.prisma.accessPoint.findMany({
      where: { buildingId, category: 'UNIT_DOOR' },
      include: { unit: { select: { id: true, number: true, street: true } } },
      orderBy: { id: 'asc' },
    })
    return aps.map((ap) => ({
      apId: ap.id,
      label: ap.label,
      unitId: ap.unitId,
      unitLabel: ap.unit
        ? [ap.unit.street, ap.unit.number].filter(Boolean).join(' ') || `Lokal ${ap.unit.id}`
        : null,
      deviceUuid: ap.deviceId,
      isActive: ap.isActive,
      createdAt: ap.createdAt,
    }))
  }

  /** Lokale budynku do selecta w formularzu dodawania zamka. */
  async listUnitsForSmartLock(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    const units = await this.prisma.unit.findMany({
      where: { buildingId },
      select: { id: true, number: true, street: true, houseType: true },
      orderBy: [{ street: 'asc' }, { number: 'asc' }],
    })
    return sortUnits(units).map((u) => ({
      id: u.id,
      label: [u.street, u.number].filter(Boolean).join(' ') || `Lokal ${u.id}`,
      houseType: u.houseType,
    }))
  }

  /**
   * POST /integrator/buildings/:id/smart-locks
   * Body: `{ name, unitId, smartlockId, apiToken }`.
   *
   * Kolejność: najpierw token → Edge (jeśli Edge offline, NIC nie tworzymy),
   * potem AccessPoint (metadane bez tokenu) + AP_UPSERT przez tunel.
   */
  async createSmartLock(
    buildingId: number,
    adminId: number,
    integratorId: number,
    body: { name?: unknown; unitId?: unknown; smartlockId?: unknown; apiToken?: unknown },
  ) {
    await this.getBuilding(buildingId, adminId)

    const name = String(body.name ?? '').trim() || 'Drzwi mieszkania'
    const unitId = Number(body.unitId)
    const smartlockId = String(body.smartlockId ?? '').trim()
    const apiToken = String(body.apiToken ?? '').trim()
    if (!Number.isInteger(unitId) || unitId <= 0) {
      throw new BadRequestException('Wybierz lokal (unitId)')
    }
    if (!/^\d{5,20}$/.test(smartlockId)) {
      throw new BadRequestException('smartlockId musi być liczbą (ID zamka z Nuki Web)')
    }
    if (apiToken.length < 10) {
      throw new BadRequestException('Podaj token API Nuki (Nuki Web → API)')
    }
    const unit = await this.prisma.unit.findFirst({ where: { id: unitId, buildingId } })
    if (!unit) throw new NotFoundException('Lokal nie istnieje w tym budynku')

    // 1. Urządzenie SMART_LOCK na Edge — token pass-through (NIE do Postgres).
    const deviceUuid = crypto.randomUUID()
    const ip = await this.getActiveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'SMART_LOCK',
          config: {
            id: deviceUuid,
            name,
            manufacturer: 'Nuki',
            smartlockId,
            apiToken,
            driverId: 'nuki-web-api',
          },
        }),
        signal: AbortSignal.timeout(10_000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
    } catch (err: any) {
      throw new BadGatewayException(
        `Nie udało się zapisać zamka na Edge (token NIE został nigdzie zapisany): ${err.message}`,
      )
    }

    // 2. AccessPoint — metadane w Cloud (bez tokenu).
    const edge = await this.prisma.edgeDevice.findFirst({
      where: { buildingId, type: 'EDGE', isActivated: true },
      orderBy: { lastSeenAt: 'desc' },
    })
    const ap = await this.prisma.accessPoint.create({
      data: {
        buildingId,
        label: name,
        icon: 'door',
        edgeDeviceId: edge?.id ?? null,
        deviceId: deviceUuid,
        relayIndex: 0,
        outputDeviceId: deviceUuid,
        outputIndex: 0,
        durationMs: 800,
        scope: 'RESIDENT',
        category: 'UNIT_DOOR',
        unitId,
        sortOrder: 100,
      },
    })

    // 3. AP_UPSERT przez tunel — Edge zna AP (kategoria/binding) do audytu
    //    i AccessPointExecutor (schedule/PIN nie dotyczą, ale spójność syncu).
    this.pushSmartLockApUpsert(ap).catch((err) =>
      this.logger.warn(`AP_UPSERT (smart lock) push failed for ap#${ap.id}: ${err.message}`),
    )

    // 4. Audit — BEZ tokenu (tylko fakt konfiguracji).
    this.logAudit(integratorId, 'SMART_LOCK_CREATE', {
      targetType: 'ACCESS_POINT',
      targetId: String(ap.id),
      buildingId,
      meta: { name, unitId, smartlockId, deviceUuid, apiToken: '(pass-through→Edge)' },
    })

    return {
      apId: ap.id,
      label: ap.label,
      unitId: ap.unitId,
      deviceUuid,
      isActive: ap.isActive,
    }
  }

  /**
   * PATCH /integrator/buildings/:id/smart-locks/:apId
   * Body: `{ name?, isActive?, smartlockId?, apiToken? }`.
   * name/isActive → Postgres + AP_UPSERT; smartlockId/apiToken → Edge PATCH
   * (merge configu, token dalej tylko na Edge).
   */
  async updateSmartLock(
    buildingId: number,
    adminId: number,
    integratorId: number,
    apId: number,
    body: { name?: unknown; isActive?: unknown; smartlockId?: unknown; apiToken?: unknown },
  ) {
    await this.getBuilding(buildingId, adminId)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId, category: 'UNIT_DOOR' },
    })
    if (!ap) throw new NotFoundException('Zamek nie istnieje')

    // Edge-side config (token / smartlockId) — pass-through.
    const configPatch: Record<string, string> = {}
    if (typeof body.smartlockId === 'string' && body.smartlockId.trim()) {
      if (!/^\d{5,20}$/.test(body.smartlockId.trim())) {
        throw new BadRequestException('smartlockId musi być liczbą')
      }
      configPatch.smartlockId = body.smartlockId.trim()
    }
    if (typeof body.apiToken === 'string' && body.apiToken.trim()) {
      configPatch.apiToken = body.apiToken.trim()
    }
    if (Object.keys(configPatch).length > 0) {
      const ip = await this.getActiveEdgeIp(buildingId)
      try {
        const res = await undiciFetch(`http://${ip}:4000/devices/${ap.deviceId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'SMART_LOCK', config: configPatch }),
          signal: AbortSignal.timeout(10_000),
          dispatcher: edgeDispatcher,
        })
        if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
      } catch (err: any) {
        throw new BadGatewayException(`Nie udało się zaktualizować zamka na Edge: ${err.message}`)
      }
    }

    // Cloud-side metadane.
    const data: { label?: string; isActive?: boolean } = {}
    if (typeof body.name === 'string' && body.name.trim()) data.label = body.name.trim()
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive
    const updated = Object.keys(data).length > 0
      ? await this.prisma.accessPoint.update({ where: { id: apId }, data })
      : ap
    if (Object.keys(data).length > 0) {
      this.pushSmartLockApUpsert(updated).catch((err) =>
        this.logger.warn(`AP_UPSERT (smart lock update) push failed: ${err.message}`),
      )
    }

    this.logAudit(integratorId, 'SMART_LOCK_UPDATE', {
      targetType: 'ACCESS_POINT',
      targetId: String(apId),
      buildingId,
      meta: {
        ...data,
        ...(configPatch.smartlockId ? { smartlockId: configPatch.smartlockId } : {}),
        ...(configPatch.apiToken ? { apiToken: '(pass-through→Edge)' } : {}),
      },
    })

    return { apId: updated.id, label: updated.label, isActive: updated.isActive }
  }

  /** DELETE — kasuje urządzenie na Edge (razem z tokenem) + AccessPoint. */
  async deleteSmartLock(buildingId: number, adminId: number, integratorId: number, apId: number) {
    await this.getBuilding(buildingId, adminId)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId, category: 'UNIT_DOOR' },
    })
    if (!ap) throw new NotFoundException('Zamek nie istnieje')

    // Edge best-effort — jeśli offline, AP i tak kasujemy (token zostaje w
    // sqlite Edge do ręcznego cleanupu; logujemy WARN).
    try {
      const ip = await this.getActiveEdgeIp(buildingId)
      const res = await undiciFetch(`http://${ip}:4000/devices/${ap.deviceId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10_000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
    } catch (err: any) {
      this.logger.warn(
        `Smart lock Edge delete failed (device ${ap.deviceId}): ${err.message} — usuń ręcznie w Edge UI`,
      )
    }

    await this.prisma.accessPoint.delete({ where: { id: apId } })
    this.edgeGateway
      .sendToBuilding(buildingId, 'AP_DELETE', { id: apId })
      .catch((err) => this.logger.warn(`AP_DELETE push failed for ap#${apId}: ${err.message}`))

    this.logAudit(integratorId, 'SMART_LOCK_DELETE', {
      targetType: 'ACCESS_POINT',
      targetId: String(apId),
      buildingId,
      meta: { label: ap.label, deviceUuid: ap.deviceId },
    })
    return { deleted: true }
  }

  /**
   * POST /integrator/buildings/:id/smart-locks/:apId/test — „Testuj":
   * Edge woła Nuki Web API `GET /smartlock/{id}` i zwraca stan (state,
   * batteryCritical, name) synchronicznie przez HTTP.
   */
  async testSmartLock(buildingId: number, adminId: number, apId: number) {
    await this.getBuilding(buildingId, adminId)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId, category: 'UNIT_DOOR' },
    })
    if (!ap) throw new NotFoundException('Zamek nie istnieje')
    const ip = await this.getActiveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices/${ap.deviceId}/smart-lock/state`, {
        signal: AbortSignal.timeout(15_000),
        dispatcher: edgeDispatcher,
      })
      const data: any = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.message ?? `Edge HTTP ${res.status}`)
      }
      return data
    } catch (err: any) {
      throw new BadGatewayException(`Test zamka nie powiódł się: ${err.message}`)
    }
  }

  /** Wspólny AP_UPSERT payload dla zamków (shape jak updateAccessPointCategory). */
  private async pushSmartLockApUpsert(ap: {
    id: number; buildingId: number; label: string; icon: string; scope: string | null
    category: string; outputDeviceId: string | null; outputIndex: number | null
    durationMs: number | null; isActive: boolean; sortOrder: number | null
    deviceId: string; relayIndex: number
  }): Promise<void> {
    await this.edgeGateway.sendToBuilding(ap.buildingId, 'AP_UPSERT', {
      id: ap.id,
      buildingId: ap.buildingId,
      label: ap.label,
      icon: ap.icon,
      scope: ap.scope ?? 'RESIDENT',
      category: ap.category,
      outputDeviceId: ap.outputDeviceId ?? null,
      outputIndex: ap.outputIndex ?? null,
      durationMs: ap.durationMs ?? 800,
      isActive: ap.isActive,
      sortOrder: ap.sortOrder ?? 0,
      deviceId: ap.deviceId,
      relayIndex: ap.relayIndex,
    })
  }

  // ────────────────────────────────────────────────────────────────────────
  //  PR-1 (2026-07): karta „Edge / kod aktywacyjny" w panelu Integratora.
  //  Przeniesienie funkcji z legacy panelu superadmina — generowanie kodu,
  //  lista EdgeDevice (z pending kodem) i usuwanie/dezaktywacja urządzenia.
  //  Tenant-check: `getBuilding(buildingId, adminId)` rzuca NotFound gdy
  //  budynek nie należy do admina integratora; `EdgeService` dodatkowo
  //  waliduje adminId po swojej stronie (defense in depth).
  // ────────────────────────────────────────────────────────────────────────

  /** Lista EdgeDevice budynku — z kodem aktywacyjnym (pending) i online z gateway. */
  async listEdgeDevicesForBuilding(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    const devices = await this.edge.listForBuilding(buildingId)
    return devices.map((d) => ({
      ...d,
      isOnline: this.edgeGateway.isOnline(d.id),
    }))
  }

  /** Generuje jednorazowy kod aktywacyjny (24h TTL) — tworzy pending EdgeDevice. */
  async generateEdgeActivationCode(
    buildingId: number,
    adminId: number,
    dto: { type?: 'EDGE' | 'EDGE_AI'; name?: string },
  ) {
    await this.getBuilding(buildingId, adminId)
    return this.edge.generateActivationCode(adminId, {
      buildingId,
      type: dto.type,
      name: dto.name,
    })
  }

  /** Usuwa EdgeDevice (dezaktywacja — urządzenie traci refresh po TTL tokenu). */
  async removeEdgeDevice(buildingId: number, adminId: number, deviceId: string) {
    await this.getBuilding(buildingId, adminId)
    const device = await this.prisma.edgeDevice.findUnique({ where: { id: deviceId } })
    if (!device || device.buildingId !== buildingId) {
      throw new NotFoundException('Urządzenie Edge nie znalezione w tym budynku')
    }
    // EdgeService.remove ponownie sprawdza building.adminId (defense in depth)
    return this.edge.remove(deviceId, adminId)
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Faza B-5 (2026-05-14): Integrator panel devices page
  //
  //  Analogiczne metody do `BuildingAdminService.listDevices` /
  //  `updateDeviceDisplayLabel`, ale w kontekście integratora (panel cloud
  //  z pełnym widokiem mirror + zaszytą etykietą po stronie integratora).
  //  Różnice względem BA:
  //   • Guard przez `getBuilding(adminId)` zamiast `guardBuilding(buildingIds)`
  //   • `setMirrorDisplayLabel(..., updatedBy: 'integrator')` — audit kto edytuje
  //   • Zwracamy też `edgeIpAddress` w odpowiedzi żeby Web mógł zbudować link
  //     „Otwórz Edge wizard" → http://<edgeIp>:4000/ui/wizard.html
  // ────────────────────────────────────────────────────────────────────────

  async listDevices(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)

    type MirrorRow = {
      id: number; deviceUuid: string; edgeDeviceId: string | null;
      type: string; driverId: string | null; config: any;
      displayLabel: string | null; labelUpdatedBy: string | null; labelUpdatedAt: Date | null;
      lastSyncedAt: Date; createdAt: Date;
    }
    const [edges, mirrorDevices] = await Promise.all([
      this.prisma.edgeDevice.findMany({
        where: { buildingId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.$queryRaw<MirrorRow[]>`
        SELECT id, "deviceUuid", "edgeDeviceId", "type", "driverId",
               "config", "displayLabel", "labelUpdatedBy", "labelUpdatedAt",
               "lastSyncedAt", "createdAt"
          FROM "edge_device_mirror"
         WHERE "buildingId" = ${buildingId}
         ORDER BY "type", "createdAt" ASC
      `,
    ])

    const onlineEdgeIds = new Set<string>()
    for (const e of edges) {
      if (this.edgeGateway.isOnline(e.id)) onlineEdgeIds.add(e.id)
    }
    const outboxStats = await this.edgeOutbox.statsForBuilding(buildingId)

    return {
      edges: edges.map((e) => ({
        ...e,
        online: onlineEdgeIds.has(e.id),
        outbox: outboxStats.get(e.id) ?? { pending: 0, failed: 0 },
        // Integrator dostaje hint do Edge wizard — link relatywny do IP w LAN.
        // Klient (UI) sklei `http://<edgeIp>:4000/ui/wizard.html` jeśli IP znany.
        wizardUrlHint: e.ipAddress ? `http://${e.ipAddress}:4000/ui/wizard.html` : null,
      })),
      mirrorDevices: mirrorDevices.map((m) => {
        const driver = m.driverId ? findDriver(m.driverId) : null
        const model = (m.config as any)?.model as string | undefined
        const modelCert = driver && model
          ? certifiedFor(driver.id).find(
              (c) => c.model.toLowerCase() === model.toLowerCase(),
            )
          : null
        return {
          id: m.id,
          deviceUuid: m.deviceUuid,
          edgeDeviceId: m.edgeDeviceId,
          type: m.type,
          driverId: m.driverId,
          config: m.config,
          displayLabel: m.displayLabel ?? (m.config as any)?.name ?? null,
          labelUpdatedBy: m.labelUpdatedBy,
          labelUpdatedAt: m.labelUpdatedAt,
          lastSyncedAt: m.lastSyncedAt,
          createdAt: m.createdAt,
          online: m.edgeDeviceId ? onlineEdgeIds.has(m.edgeDeviceId) : false,
          driver: driver ? {
            id: driver.id,
            label: driver.label,
            icon: driver.icon,
            manufacturer: driver.manufacturer,
            capabilities: driver.capabilities,
          } : null,
          certification: modelCert
            ? {
                status: 'certified' as const,
                model: modelCert.model,
                firmwareVersions: modelCert.firmwareVersions,
                testedAt: modelCert.testedAt,
                testedBy: modelCert.testedBy,
                knownIssues: modelCert.knownIssues,
              }
            : driver?.certification ?? { status: 'untested' as const },
        }
      }),
    }
  }

  async updateDeviceDisplayLabel(
    buildingId: number,
    mirrorId: number,
    displayLabel: string,
    adminId: number,
  ) {
    await this.getBuilding(buildingId, adminId)
    const result = await this.edge.setMirrorDisplayLabel({
      buildingId,
      mirrorId,
      displayLabel,
      updatedBy: 'integrator',
    })
    if (!result) throw new NotFoundException('Urządzenie nie istnieje w mirror')
    return result
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Sesja 3 Panel Integratora — globalna lista Edge + profil + powiadomienia
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Wszystkie Edge ze wszystkich obiektów integratora. Używane przez
   * <EdgesPage> — globalna tabela do masowego monitoringu/diagnozy.
   *
   * Multi-tenancy: filtruje po `Building.adminId = req.user.adminId` (current
   * model Integrator 1:1 Admin). Sesja 5 wprowadzi IntegratorScope dla
   * portfolio integrator-firmy obsługującej wielu adminów.
   */
  async listAllEdges(adminId: number) {
    const edges = await this.prisma.edgeDevice.findMany({
      where: { building: { adminId, isArchived: false } },
      select: {
        id: true, type: true, name: true,
        isActivated: true, activatedAt: true,
        lastSeenAt: true, ipAddress: true, version: true,
        buildingId: true,
        building: { select: { id: true, name: true, address: true, objectType: true } },
      },
      orderBy: [{ buildingId: 'asc' }, { createdAt: 'asc' }],
    })
    return edges.map((d) => ({
      id: d.id,
      type: d.type,
      name: d.name,
      isActivated: d.isActivated,
      activatedAt: d.activatedAt,
      lastSeenAt: d.lastSeenAt,
      ipAddress: d.ipAddress,
      version: d.version,
      isOnline: this.edgeGateway.isOnline(d.id),
      building: d.building,
    }))
  }

  /** Profil zalogowanego integratora — dla <SettingsPage> i Sidebar widget. */
  async getMe(integratorId: number) {
    const integrator = await this.prisma.integrator.findUnique({
      where: { id: integratorId },
      select: {
        id: true, name: true, email: true, company: true,
        createdAt: true, updatedAt: true,
        notificationPrefs: true,
      },
    })
    if (!integrator) throw new NotFoundException('Integrator nie istnieje')
    return integrator
  }

  /** Update profilu (name, company). Email nie edytowalny przez UI — wymaga
   *  zmiany login credentials, bezpieczniej z osobnego flow w przyszłości. */
  async updateMe(integratorId: number, body: { name?: string; company?: string | null }) {
    const data: Record<string, unknown> = {}
    if (body.name !== undefined) data.name = body.name
    if (body.company !== undefined) data.company = body.company

    const updated = await this.prisma.integrator.update({
      where: { id: integratorId },
      data,
      select: {
        id: true, name: true, email: true, company: true,
        createdAt: true, updatedAt: true,
      },
    })

    this.logAudit(integratorId, 'PROFILE_UPDATE', {
      targetType: 'INTEGRATOR',
      targetId: String(integratorId),
      meta: { fieldsChanged: Object.keys(data) },
    })

    return updated
  }

  /** Powiadomienia — domyślne wartości gdy nigdy nie zapisane. */
  private defaultNotificationPrefs(): Record<string, boolean> {
    return {
      offlineAlerts: true,
      heartbeatDropAlerts: true,
      firmwareUpdates: false,
      emailChannel: true,
      pushChannel: false,
      weeklySummary: false,
    }
  }

  async getNotificationPrefs(integratorId: number) {
    const me = await this.prisma.integrator.findUnique({
      where: { id: integratorId },
      select: { notificationPrefs: true },
    })
    if (!me) throw new NotFoundException('Integrator nie istnieje')
    const stored = (me.notificationPrefs ?? {}) as Record<string, boolean>
    return { ...this.defaultNotificationPrefs(), ...stored }
  }

  async updateNotificationPrefs(integratorId: number, body: Record<string, boolean>) {
    // Merge z defaults — pozwala UI wysłać tylko zmienione pola.
    const current = await this.getNotificationPrefs(integratorId)
    const merged = { ...current, ...body }
    await this.prisma.integrator.update({
      where: { id: integratorId },
      data: { notificationPrefs: merged },
    })

    this.logAudit(integratorId, 'NOTIFICATION_PREFS_UPDATE', {
      targetType: 'INTEGRATOR',
      targetId: String(integratorId),
      meta: { changes: body },
    })

    return merged
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Sesja 4 — Deeplink SSO do Edge UI
  // ────────────────────────────────────────────────────────────────────────
  //
  //  Flow:
  //    1. Frontend wywołuje GET /integrator/buildings/:bid/edges/:eid/deeplink
  //       → backend generuje UUID token, zapisuje w mapie in-memory z TTL 60s
  //       → zwraca { url: 'https://api.gatelynk.com/api/integrator/edge-sso?token=X',
  //                  expiresAt: ISO }
  //    2. Frontend otwiera `url` w nowej karcie
  //    3. Backend GET /integrator/edge-sso?token=X
  //       → walidacja tokenu (existence + TTL + match na adminId/buildingId)
  //       → wykasowanie z mapy (one-time use)
  //       → resolve aktualnego IP Edge (z gateway / DB)
  //       → 302 redirect do `http://<ip>:4000/ui` (z opcjonalnym `?source=integrator`
  //         w przyszłości żeby Edge wiedział że to autentyczny entry — wymaga
  //         dodania session-cookie w Edge — Sesja 5+)
  //
  //  Bezpieczeństwo MVP: token jednorazowy + TTL = minimalna ochrona przed
  //  bookmark-replay. Edge nie wymaga jeszcze auth (LAN-only), więc deeplink
  //  pełni głównie funkcję wygodnego proxy. Sesja 5+ dorzuci Edge session cookie.

  private deeplinkTokens = new Map<string, {
    edgeDeviceId: string
    buildingId: number
    adminId: number
    expiresAt: number
  }>()

  /** Periodic cleanup expired tokens. Co 5 min — wystarczająco rzadko żeby nie
   *  obciążać, wystarczająco często żeby mapa nie rośła. */
  private cleanupDeeplinkTokens() {
    const now = Date.now()
    for (const [token, entry] of this.deeplinkTokens.entries()) {
      if (entry.expiresAt < now) this.deeplinkTokens.delete(token)
    }
  }

  async generateEdgeDeeplink(
    buildingId: number,
    edgeDeviceId: string,
    adminId: number,
    integratorId?: number,
  ) {
    await this.getBuilding(buildingId, adminId)
    // Verify edge belongs to this building
    const edge = await this.prisma.edgeDevice.findFirst({
      where: { id: edgeDeviceId, buildingId },
    })
    if (!edge) throw new NotFoundException('Edge nie należy do tego obiektu')

    // Lazy cleanup
    if (this.deeplinkTokens.size > 100) this.cleanupDeeplinkTokens()

    const token = `dl_${crypto.randomUUID()}`
    const expiresAt = Date.now() + 60_000   // 60 sekund

    this.deeplinkTokens.set(token, {
      edgeDeviceId,
      buildingId,
      adminId,
      expiresAt,
    })

    this.logAudit(integratorId, 'EDGE_DEEPLINK_GENERATE', {
      targetType: 'EDGE',
      targetId: edgeDeviceId,
      buildingId,
      meta: { edgeName: edge.name ?? null },
    })

    // Backend nie zna swojej własnej publicznej domeny — używamy `PUBLIC_BASE_URL`
    // z env (Fly) lub fallback do `api.gatelynk.com`. Frontend i tak otwiera
    // URL w nowej karcie, więc nie trzeba absolutny.
    const baseUrl = process.env.PUBLIC_BASE_URL ?? 'https://api.gatelynk.com'
    return {
      url: `${baseUrl}/api/integrator/edge-sso?token=${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  /**
   * Walidacja tokenu + redirect na Edge UI. Wywoływane przez controller jako
   * GET /integrator/edge-sso?token=X. Controller zwraca Response z 302
   * Location header.
   *
   * Zwraca docelowy URL (controller robi redirect) ALBO `null` gdy token
   * invalid/expired.
   */
  async resolveDeeplink(token: string): Promise<string | null> {
    const entry = this.deeplinkTokens.get(token)
    if (!entry) return null
    if (entry.expiresAt < Date.now()) {
      this.deeplinkTokens.delete(token)
      return null
    }

    // One-time use — usuń od razu
    this.deeplinkTokens.delete(token)

    // Resolve current Edge IP (live gateway preferred, fallback DB)
    try {
      const ip = await this.getActiveEdgeIp(entry.buildingId)
      return `http://${ip}:4000/ui`
    } catch {
      return null
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Sesja 4 — LAN discovery scan (proxy do Edge `/devices/discover`)
  // ────────────────────────────────────────────────────────────────────────

  /** Triggeruje discovery na Edge konkretnego obiektu. Proxy POST. */
  async startLanScan(
    buildingId: number,
    adminId: number,
    opts: { protocols?: string[]; timeoutMs?: number },
  ): Promise<{ runId: string }> {
    await this.getBuilding(buildingId, adminId)
    const ip = await this.getActiveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocols: opts.protocols ?? ['mdns', 'knxnet-ip'],
          timeoutMs: opts.timeoutMs ?? 15000,
        }),
        signal: AbortSignal.timeout(8000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<{ runId: string }>
    } catch (err: any) {
      throw new BadGatewayException(`Brak odpowiedzi z Edge przy starcie skanu: ${err.message}`)
    }
  }

  /** Status discovery run-a. Proxy GET — polled z frontendu co 1-2s. */
  async getLanScanStatus(
    buildingId: number,
    adminId: number,
    runId: string,
  ) {
    await this.getBuilding(buildingId, adminId)
    const ip = await this.getActiveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices/discover/${runId}`, {
        signal: AbortSignal.timeout(8000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    } catch (err: any) {
      throw new BadGatewayException(`Brak odpowiedzi z Edge: ${err.message}`)
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Sesja 5 — audit log + diagnostyka per-device + eksport JSON
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Helper — zapisuje wpis audit log fire-and-forget. NIE rzuca exceptions —
   * audit failure nie powinno blokować głównej akcji. Logujemy ostrzeżenie
   * w konsoli ale operacja idzie dalej.
   */
  private logAudit(
    integratorId: number | null | undefined,
    action: string,
    opts: {
      targetType?: string
      targetId?: string
      buildingId?: number
      meta?: Record<string, unknown>
    } = {},
  ): void {
    if (!integratorId) return  // bezpiecznik: brak ID = no-op (np. token-based deeplink)
    this.prisma.integratorAuditLog.create({
      data: {
        integratorId,
        action,
        targetType: opts.targetType ?? null,
        targetId: opts.targetId ?? null,
        buildingId: opts.buildingId ?? null,
        meta: opts.meta ? JSON.parse(JSON.stringify(opts.meta)) : null,
      },
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[IntegratorAudit] Nie zapisano wpisu ${action}:`, err.message)
    })
  }

  /** GET /integrator/me/audit?limit=&buildingId= — historia operacji. */
  async listAuditLog(
    integratorId: number,
    opts: { limit?: number; buildingId?: number } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
    const rows = await this.prisma.integratorAuditLog.findMany({
      where: {
        integratorId,
        ...(opts.buildingId ? { buildingId: opts.buildingId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, action: true,
        targetType: true, targetId: true,
        buildingId: true, meta: true,
        createdAt: true,
      },
    })
    return rows.map((r) => ({
      ...r,
      id: r.id.toString(),  // BigInt → string dla JSON
    }))
  }

  /** Diagnostyka per-device — proxy do Edge `/devices/:id/test-matrix`. */
  async runDeviceTestMatrix(
    buildingId: number,
    adminId: number,
    deviceId: string,
    integratorId: number,
  ) {
    await this.getBuilding(buildingId, adminId)
    const ip = await this.getActiveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices/${deviceId}/test-matrix`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),  // test-matrix może trwać kilka sek
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const result = await res.json() as Record<string, unknown>
      this.logAudit(integratorId, 'DIAGNOSTICS_RUN', {
        targetType: 'EDGE_DEVICE',
        targetId: deviceId,
        buildingId,
        meta: { online: (result as { online?: boolean }).online ?? null },
      })
      return result
    } catch (err: any) {
      throw new BadGatewayException(`Test-matrix z Edge nie powiódł się: ${err.message}`)
    }
  }

  /**
   * Eksport konfiguracji obiektu jako JSON. Zwraca pełen dump:
   *   - building metadata
   *   - intercomy (config IP + login, BEZ haseł plain-text — tylko hash flag)
   *   - kamery LPR (j.w.)
   *   - lista Edge + status
   *   - modułowe flags (hasIntercom, hasLprSystem, ...)
   *
   * Hasła i wrażliwe dane są maskowane jako '***' żeby eksport mógł być
   * legitnym backupem ale nie wyciekiem. Logowane do audit z meta.
   */
  async exportBuildingConfig(buildingId: number, adminId: number, integratorId: number) {
    const building = await this.prisma.building.findFirst({
      where: { id: buildingId, adminId, isArchived: false },
      include: {
        stairwells: { include: { intercom: true } },
        lprCameras: true,
      },
    })
    if (!building) throw new NotFoundException('Obiekt nie istnieje')

    const edges = await this.prisma.edgeDevice.findMany({
      where: { buildingId },
      select: {
        id: true, type: true, name: true,
        ipAddress: true, version: true, isActivated: true,
        activatedAt: true, lastSeenAt: true,
      },
    })

    const dump = {
      gatelynk: {
        exportedAt: new Date().toISOString(),
        exportedBy: { integratorId },
        schemaVersion: 1,
      },
      building: {
        id: building.id,
        name: building.name,
        address: building.address,
        objectType: building.objectType,
        nip: building.nip,
        regon: building.regon,
        createdAt: building.createdAt.toISOString(),
        modules: {
          hasIntercom: (building as { hasIntercom?: boolean }).hasIntercom ?? false,
          hasLprSystem: (building as { hasLprSystem?: boolean }).hasLprSystem ?? false,
          hasCctv: (building as { hasCctv?: boolean }).hasCctv ?? false,
          hasLightingControl: (building as { hasLightingControl?: boolean }).hasLightingControl ?? false,
          hasEdgeAI: (building as { hasEdgeAI?: boolean }).hasEdgeAI ?? false,
          hasPhotovoltaics: (building as { hasPhotovoltaics?: boolean }).hasPhotovoltaics ?? false,
          hasSmartBuilding: (building as { hasSmartBuilding?: boolean }).hasSmartBuilding ?? false,
          packageHandling: (building as { packageHandling?: string }).packageHandling ?? 'NONE',
        },
      },
      stairwells: building.stairwells.map((s) => ({
        id: s.id,
        name: s.name,
        intercom: s.intercom ? maskCredentials(s.intercom) : null,
      })),
      lprCameras: building.lprCameras.map(maskCredentials),
      edges: edges.map((e) => ({
        ...e,
        activatedAt: e.activatedAt?.toISOString() ?? null,
        lastSeenAt: e.lastSeenAt?.toISOString() ?? null,
      })),
    }

    this.logAudit(integratorId, 'CONFIG_EXPORT', {
      targetType: 'BUILDING',
      targetId: String(buildingId),
      buildingId,
      meta: { intercomCount: building.stairwells.length, lprCount: building.lprCameras.length },
    })

    return dump
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Sesja 6 — email change z weryfikacją + health report
  // ────────────────────────────────────────────────────────────────────────

  /**
   * User wpisuje nowy email + hasło. Backend weryfikuje password, generuje
   * token UUID + TTL 24h, zapisuje w `pendingEmail*`, wysyła link weryfikacyjny
   * na NOWY adres. Klik w link → `verifyEmailChange(token)`.
   *
   * Wymaga: nowy email różny od obecnego, nie zarejestrowany przez innego integrator-a.
   */
  async requestEmailChange(
    integratorId: number,
    newEmail: string,
    currentPassword: string,
  ): Promise<{ requested: boolean; verifyExpiresAt: string; emailSent: boolean }> {
    const normalized = newEmail.trim().toLowerCase()
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new BadRequestException('Nieprawidłowy format emaila')
    }

    const integrator = await this.prisma.integrator.findUnique({
      where: { id: integratorId },
    })
    if (!integrator) throw new NotFoundException('Integrator nie istnieje')
    if (normalized === integrator.email.toLowerCase()) {
      throw new BadRequestException('Nowy email jest taki sam jak obecny')
    }

    // Weryfikacja hasła
    const bcrypt = await import('bcrypt')
    const valid = await bcrypt.compare(currentPassword, integrator.passwordHash)
    if (!valid) throw new UnauthorizedException('Nieprawidłowe hasło')

    // Sprawdź czy nowy email nie jest zajęty przez innego integratora
    const existing = await this.prisma.integrator.findFirst({
      where: { email: normalized, NOT: { id: integratorId } },
    })
    if (existing) {
      throw new BadRequestException('Ten email jest już używany przez inne konto')
    }

    const token = `ec_${crypto.randomUUID()}${crypto.randomUUID().replace(/-/g, '')}`
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000)  // 24h TTL

    await this.prisma.integrator.update({
      where: { id: integratorId },
      data: {
        pendingEmail: normalized,
        pendingEmailToken: token,
        pendingEmailExpiresAt: expiresAt,
      },
    })

    const baseUrl = process.env.PANEL_BASE_URL ?? 'https://panel.gatelynk.com'
    const verifyUrl = `${baseUrl}/integrator/verify-email?token=${token}`
    const result = await this.mail.sendEmailChangeVerification({
      toEmail: normalized,
      integratorName: integrator.name,
      verifyUrl,
    })

    this.logAudit(integratorId, 'EMAIL_CHANGE_REQUEST', {
      targetType: 'INTEGRATOR',
      targetId: String(integratorId),
      meta: { newEmailDomain: normalized.split('@')[1], emailSent: result.sent },
    })

    return {
      requested: true,
      verifyExpiresAt: expiresAt.toISOString(),
      emailSent: result.sent,
    }
  }

  /** Weryfikacja tokenu z linka w emailu. Swap email + clear pending. */
  async verifyEmailChange(token: string): Promise<{ verified: boolean; newEmail: string }> {
    const integrator = await this.prisma.integrator.findFirst({
      where: { pendingEmailToken: token },
    })
    if (!integrator) {
      throw new NotFoundException('Token nieprawidłowy lub już użyty')
    }
    if (!integrator.pendingEmail || !integrator.pendingEmailExpiresAt) {
      throw new BadRequestException('Nieprawidłowy stan zmiany emaila')
    }
    if (integrator.pendingEmailExpiresAt < new Date()) {
      // Wyczyść stale pending state
      await this.prisma.integrator.update({
        where: { id: integrator.id },
        data: {
          pendingEmail: null,
          pendingEmailToken: null,
          pendingEmailExpiresAt: null,
        },
      })
      throw new BadRequestException('Link wygasł — wygeneruj nowy w panelu')
    }

    // Race-condition safety — sprawdź czy nowy email nie został zajęty
    const newEmail = integrator.pendingEmail
    const taken = await this.prisma.integrator.findFirst({
      where: { email: newEmail, NOT: { id: integrator.id } },
    })
    if (taken) {
      throw new BadRequestException('Ten email został w międzyczasie przejęty')
    }

    await this.prisma.integrator.update({
      where: { id: integrator.id },
      data: {
        email: newEmail,
        pendingEmail: null,
        pendingEmailToken: null,
        pendingEmailExpiresAt: null,
      },
    })

    this.logAudit(integrator.id, 'EMAIL_CHANGE_CONFIRM', {
      targetType: 'INTEGRATOR',
      targetId: String(integrator.id),
      meta: { newEmailDomain: newEmail.split('@')[1] },
    })

    return { verified: true, newEmail }
  }

  /**
   * Health report — agreguje wszystkie Edge z portfolio integratora.
   * Per-Edge: status online, uptime % za 7/30 dni (z lastSeenAt heartbeat),
   * version firmware, ostatnia diagnostyka (z audit log).
   *
   * Frontend renderuje jako tabelę + opcjonalnie `window.print()` dla PDF.
   * Server-side PDF generation byłaby cięższa (potrzebny libreoffice/puppeteer)
   * — w MVP wystarczy browser print-to-pdf.
   */
  async getHealthReport(adminId: number, integratorId: number) {
    const edges = await this.prisma.edgeDevice.findMany({
      where: { building: { adminId, isArchived: false } },
      select: {
        id: true, type: true, name: true,
        isActivated: true, activatedAt: true,
        lastSeenAt: true, ipAddress: true, version: true,
        createdAt: true,
        building: { select: { id: true, name: true, address: true } },
      },
      orderBy: [{ buildingId: 'asc' }, { createdAt: 'asc' }],
    })

    // Ostatnie diagnostyki per-device (z audit log) — limit 1 per device
    const diagAudits = await this.prisma.integratorAuditLog.findMany({
      where: { integratorId, action: 'DIAGNOSTICS_RUN' },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { targetId: true, createdAt: true, meta: true },
    })
    const lastDiagByDevice = new Map<string, { at: string; online: boolean | null }>()
    for (const a of diagAudits) {
      if (!a.targetId) continue
      if (lastDiagByDevice.has(a.targetId)) continue   // pierwszy w desc order = najnowszy
      const meta = (a.meta as { online?: boolean } | null) ?? null
      lastDiagByDevice.set(a.targetId, {
        at: a.createdAt.toISOString(),
        online: meta?.online ?? null,
      })
    }

    const now = Date.now()
    const rows = edges.map((e) => {
      const isOnline = this.edgeGateway.isOnline(e.id)
      // Uproszczone uptime: stosunek (now - activatedAt) - (offline windows) → trudne bez heartbeat history.
      // Na MVP estimate: jeśli online TERAZ i lastSeenAt < 5min → uptime ~100%.
      // Jeśli online ale lastSeenAt > 1h → ~50% (degraded). Offline → 0%.
      // Pełniejszą metrykę dorzucimy gdy Edge zacznie heartbeat-ować do `edge_heartbeats` table.
      const lastSeenMs = e.lastSeenAt?.getTime() ?? 0
      const sinceLastSeenMin = lastSeenMs ? (now - lastSeenMs) / 60_000 : Infinity
      const uptimePct =
        isOnline && sinceLastSeenMin < 5  ? 100
        : isOnline && sinceLastSeenMin < 60 ? 90
        : isOnline                          ? 75
        : sinceLastSeenMin < 60             ? 30
        : sinceLastSeenMin < 1440           ? 10
        : 0
      const diag = lastDiagByDevice.get(e.id)

      return {
        edgeId: e.id,
        edgeName: e.name ?? 'GateLynk Edge',
        building: e.building,
        ipAddress: e.ipAddress,
        version: e.version,
        isActivated: e.isActivated,
        activatedAt: e.activatedAt?.toISOString() ?? null,
        isOnline,
        lastSeenAt: e.lastSeenAt?.toISOString() ?? null,
        uptimePct,
        lastDiagnostic: diag ?? null,
        ageDays: Math.floor((now - e.createdAt.getTime()) / 86400_000),
      }
    })

    // Summary stats
    const summary = {
      totalEdges: rows.length,
      onlineCount: rows.filter((r) => r.isOnline).length,
      offlineCount: rows.filter((r) => !r.isOnline).length,
      activatedCount: rows.filter((r) => r.isActivated).length,
      avgUptimePct: rows.length
        ? Math.round(rows.reduce((s, r) => s + r.uptimePct, 0) / rows.length)
        : 0,
      firmwareVersions: Array.from(new Set(rows.map((r) => r.version).filter(Boolean))).sort(),
    }

    this.logAudit(integratorId, 'HEALTH_REPORT_GENERATE', {
      meta: { totalEdges: rows.length, online: summary.onlineCount },
    })

    return {
      generatedAt: new Date().toISOString(),
      summary,
      edges: rows,
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  2026-06-02 — AccessPoint binding + LPR linkage (panel Integratora)
  // ────────────────────────────────────────────────────────────────────────
  //
  //  Integrator dostaje pełną edycję wiringu device→output i LPR camera→AP.
  //  W panelu BA te same pola są READ-ONLY (logiczna konfiguracja vs wiring
  //  techniczny). Kod jest świadomie zduplikowany z `BuildingAdminService`
  //  (`updateAccessPoint`, `setLprLinkedAccessPoint`, `testFireAccessPoint`)
  //  żeby nie wymuszać zmian w eksportach `BuildingAdminModule` (ryzyko
  //  circular dep). Patrz `// DUP z building-admin.service.ts:<method>`.

  /** GET /integrator/buildings/:id/access-points — lista AP dla dropdown. */
  async listAccessPointsForIntegrator(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    const rows = await this.prisma.accessPoint.findMany({
      where: { buildingId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true, label: true, icon: true, sortOrder: true,
        isActive: true, scope: true,
        // FAZA c — kategoria semantyczna (MAIN_ENTRY/FIRE_ESCAPE/...).
        category: true,
        outputDeviceId: true, outputIndex: true, durationMs: true,
        deviceId: true, relayIndex: true,
      },
    })
    return rows
  }

  /**
   * PATCH /integrator/buildings/:id/access-points/:apId
   *
   * Body przyjmuje WSZYSTKO co BA (label/icon/isActive/scope) ORAZ binding
   * (outputDeviceId/outputIndex/durationMs). `outputDeviceId=null` rozłącza
   * AP od urządzenia — Edge fallbackuje na legacy `deviceId/relayIndex`.
   *
   * Walidacja:
   *   - outputDeviceId non-null musi istnieć w `edge_device_mirror` (tego budynku)
   *   - outputIndex w [0, 16]
   *   - durationMs w [100, 30000]
   *
   * Po update wysyła AP_UPSERT przez tunel (outbox → WS). DUP z BA.
   */
  async updateAccessPointForIntegrator(
    buildingId: number,
    apId: number,
    adminId: number,
    dto: IntegratorUpdateAccessPointDto,
  ) {
    await this.getBuilding(buildingId, adminId)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    // outputDeviceId non-null → musi istnieć w mirror dla tego buildingu.
    // null jest dozwolony (= rozłączenie).
    if (dto.outputDeviceId !== undefined && dto.outputDeviceId !== null) {
      const mirror = await this.prisma.edgeDeviceMirror.findFirst({
        where: { buildingId, deviceUuid: dto.outputDeviceId },
        select: { id: true },
      })
      if (!mirror) {
        throw new BadRequestException(
          `Urządzenie ${dto.outputDeviceId} nie znalezione w mirrorze tego budynku`,
        )
      }
    }
    if (dto.outputIndex !== undefined && dto.outputIndex !== null) {
      if (!Number.isInteger(dto.outputIndex) || dto.outputIndex < 0 || dto.outputIndex > 16) {
        throw new BadRequestException('outputIndex musi być w zakresie 0..16')
      }
    }
    let durationToSet: number | undefined = undefined
    if (dto.durationMs !== undefined) {
      if (!Number.isInteger(dto.durationMs)) {
        throw new BadRequestException('durationMs musi być liczbą całkowitą')
      }
      durationToSet = Math.max(100, Math.min(dto.durationMs, 30_000))
    }

    // DUP z building-admin.service.ts:updateAccessPoint
    const updated = await this.prisma.accessPoint.update({
      where: { id: apId },
      data: {
        label:     dto.label !== undefined     ? (dto.label.trim() || ap.label) : undefined,
        icon:      dto.icon !== undefined      ? dto.icon                       : undefined,
        isActive:  dto.isActive !== undefined  ? dto.isActive                   : undefined,
        scope:     dto.scope !== undefined     ? dto.scope                      : undefined,
        outputDeviceId: dto.outputDeviceId !== undefined ? dto.outputDeviceId   : undefined,
        outputIndex:    dto.outputIndex    !== undefined ? dto.outputIndex      : undefined,
        durationMs:     durationToSet,
      },
    })

    // Push AP_UPSERT — fire-and-forget, outbox zapewnia retry.
    this.edgeGateway
      .sendToBuilding(buildingId, 'AP_UPSERT', {
        id: updated.id,
        buildingId: updated.buildingId,
        label: updated.label,
        icon: updated.icon,
        scope: updated.scope ?? 'RESIDENT',
        outputDeviceId: updated.outputDeviceId ?? null,
        outputIndex: updated.outputIndex ?? null,
        durationMs: updated.durationMs ?? 800,
        isActive: updated.isActive,
        sortOrder: updated.sortOrder ?? 0,
        deviceId: updated.deviceId,
        relayIndex: updated.relayIndex,
      })
      .catch((err) =>
        this.logger.warn(`AP_UPSERT push (integrator) failed for ap#${apId}: ${err.message}`),
      )

    return updated
  }

  /**
   * PATCH /integrator/buildings/:id/lpr-cameras/:deviceUuid/linked-ap
   *
   * Logika identyczna jak `BuildingAdminService.setLprLinkedAccessPoint`:
   *   - walidacja AP istnieje w budynku (lub null = unlink)
   *   - znalezienie mirror device po (buildingId, deviceUuid, type='LPR_CAMERA')
   *   - merge `{ linkedAccessPointId }` w `mirror.config` JSON
   *   - push `DEVICE_CONFIG_UPDATE` przez tunnel z pełnym merged configiem
   *
   * DUP z building-admin.service.ts:setLprLinkedAccessPoint
   */
  async setLprLinkedAccessPointForIntegrator(
    buildingId: number,
    deviceUuid: string,
    accessPointId: number | null,
    adminId: number,
  ) {
    await this.getBuilding(buildingId, adminId)

    if (accessPointId !== null) {
      const ap = await this.prisma.accessPoint.findFirst({
        where: { id: accessPointId, buildingId },
      })
      if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje w tym budynku')
    }

    const mirror = await this.prisma.edgeDeviceMirror.findFirst({
      where: { buildingId, deviceUuid, type: 'LPR_CAMERA' },
    })
    if (!mirror) throw new NotFoundException('Kamera LPR nie znaleziona w mirror')

    const currentConfig = (mirror.config as Record<string, unknown>) ?? {}
    const newConfig = {
      ...currentConfig,
      linkedAccessPointId: accessPointId,
    }

    await this.prisma.edgeDeviceMirror.update({
      where: { id: mirror.id },
      data: { config: newConfig as any, lastSyncedAt: new Date() },
    })

    await this.edgeGateway.sendToBuilding(buildingId, 'DEVICE_CONFIG_UPDATE', {
      deviceId: deviceUuid,
      type: mirror.type,
      config: newConfig,
    })

    return {
      ok: true,
      deviceUuid,
      linkedAccessPointId: accessPointId,
    }
  }

  /**
   * POST /integrator/buildings/:id/access-points/:apId/test-fire
   *
   * Wzorowane na BA `testFireAccessPoint`. Audit `MANUAL_OPEN` z meta
   * `source='integrator-test'`. DUP z building-admin.service.ts.
   */
  async testFireAccessPointForIntegrator(
    buildingId: number,
    apId: number,
    adminId: number,
    integratorId: number,
  ) {
    await this.getBuilding(buildingId, adminId)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    await this.edgeGateway.sendToBuilding(buildingId, 'AP_TEST_FIRE', {
      apId: ap.id,
      actor: `INTEGRATOR_TEST:${integratorId}`,
      meta: { source: 'integrator-test' },
    })

    // Audit — `openedByType='ADMIN'` z meta `source: 'integrator-test'`,
    // żeby raporty rozróżniały. NIE używamy 'INTEGRATOR' bo schema enum
    // dla `openedByType` to TEXT bez constraint-ów (patrz schema.prisma),
    // ale w access_events sąsiednie wpisy są 'RESIDENT'/'ADMIN'/'CONCIERGE'
    // — utrzymujemy konwencję.
    this.prisma.$executeRaw`
      INSERT INTO "access_events" ("buildingId", type, "accessPointId", "gateOpened",
                                   "openedById", "openedByType", meta, ts, "createdAt")
      VALUES (${buildingId}, 'MANUAL_OPEN'::"AccessEventType", ${ap.id}, true,
              ${integratorId}, 'ADMIN',
              ${JSON.stringify({ source: 'integrator-test' })}::jsonb,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `.catch(() => { /* audit fail-silent */ })

    this.logAudit(integratorId, 'AP_TEST_FIRE', {
      targetType: 'ACCESS_POINT',
      targetId: String(ap.id),
      buildingId,
      meta: { label: ap.label },
    })

    return { success: true, apId: ap.id, label: ap.label }
  }

  // ── 2026-06-02 (FAZA b) — Universal object types ─────────────────────────
  /**
   * PATCH /integrator/buildings/:id/object-type
   *
   * Body: `{ objectType, features? }`. Zmiana `objectType` nadpisuje features
   * defaultami chyba że jawnie podane.
   *
   * Walidacja:
   *   - `objectType` musi być w `OBJECT_TYPES`
   *   - jeśli `features` podane — fuzja z defaultami nowego typu
   *
   * Push `BUILDING_CONFIG_UPDATE` przez tunnel z `{ objectType, features }`
   * — Edge może w przyszłości filtrować zachowanie offline na tej podstawie
   * (na razie nie wymagane, ale outbox zapewnia delivery).
   */
  async updateObjectType(
    buildingId: number,
    adminId: number,
    integratorId: number,
    body: { objectType?: unknown; features?: Partial<BuildingFeatures> | null },
  ) {
    await this.getBuilding(buildingId, adminId)
    const objectType = body.objectType
    if (!isObjectType(objectType)) {
      throw new BadRequestException(
        `objectType musi być jednym z: BUILDING, HOUSING_ESTATE, MIXED_USE, CAMPUS, PARKING`,
      )
    }
    const features: BuildingFeatures =
      body.features !== undefined && body.features !== null
        ? normalizeFeatures(objectType, body.features)
        : { ...DEFAULT_FEATURES[objectType] }

    // 2026-07-30 — exitGrace (przepustka wyjazdowa) NIE jest zależne od
    // objectType i nie może zostać zgubione przy zmianie typu obiektu:
    // gdy body jawnie go nie podaje, przenosimy dotychczasową konfigurację.
    if ((body.features as Partial<BuildingFeatures> | null | undefined)?.exitGrace === undefined) {
      const current = await this.prisma.building.findUnique({
        where: { id: buildingId },
        select: { features: true },
      })
      const currentExitGrace = (current?.features as Partial<BuildingFeatures> | null)?.exitGrace
      if (currentExitGrace !== undefined) {
        features.exitGrace = normalizeExitGrace(currentExitGrace)
      }
    }

    const updated = await this.prisma.building.update({
      where: { id: buildingId },
      data: {
        objectType,
        features: features as unknown as object,
      },
      select: { id: true, objectType: true, features: true },
    })

    this.edgeGateway
      .sendToBuilding(buildingId, 'BUILDING_CONFIG_UPDATE', {
        buildingId,
        objectType,
        features,
      })
      .catch((err) =>
        this.logger.warn(`BUILDING_CONFIG_UPDATE push failed for b#${buildingId}: ${err.message}`),
      )

    this.logAudit(integratorId, 'BUILDING_OBJECT_TYPE_UPDATE', {
      targetType: 'BUILDING',
      targetId: String(buildingId),
      buildingId,
      meta: { objectType, features },
    })

    return updated
  }

  // ── FAZA c — AccessPoint.category + multi-LPR links (2026-06-02) ─────────

  /**
   * PATCH /integrator/buildings/:id/access-points/:apId/category
   *
   * Body: `{ category }`. Walidacja: w AP_CATEGORIES.
   * Push AP_UPSERT przez tunel (outbox + WS) — Edge zna kategorię żeby logować
   * w access_events i decydować routing notyfikacji.
   */
  async updateAccessPointCategory(
    buildingId: number,
    apId: number,
    adminId: number,
    integratorId: number,
    body: { category?: unknown },
  ) {
    await this.getBuilding(buildingId, adminId)
    if (!isApCategory(body.category)) {
      throw new BadRequestException(
        `category musi być jednym z: ${AP_CATEGORIES.join(', ')}`,
      )
    }
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    const updated = await this.prisma.accessPoint.update({
      where: { id: apId },
      data: { category: body.category },
    })

    this.edgeGateway
      .sendToBuilding(buildingId, 'AP_UPSERT', {
        id: updated.id,
        buildingId: updated.buildingId,
        label: updated.label,
        icon: updated.icon,
        scope: updated.scope ?? 'RESIDENT',
        category: updated.category,
        outputDeviceId: updated.outputDeviceId ?? null,
        outputIndex: updated.outputIndex ?? null,
        durationMs: updated.durationMs ?? 800,
        isActive: updated.isActive,
        sortOrder: updated.sortOrder ?? 0,
        deviceId: updated.deviceId,
        relayIndex: updated.relayIndex,
      })
      .catch((err) =>
        this.logger.warn(`AP_UPSERT (category) push failed for ap#${apId}: ${err.message}`),
      )

    this.logAudit(integratorId, 'AP_CATEGORY_UPDATE', {
      targetType: 'ACCESS_POINT',
      targetId: String(ap.id),
      buildingId,
      meta: { category: body.category, label: ap.label },
    })

    return updated
  }

  /** GET — lista linked LPR cameras dla danego AP. */
  async listLprLinksForAccessPoint(buildingId: number, apId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId },
      select: { id: true },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')
    return this.prisma.lprCameraAccessPointLink.findMany({
      where: { accessPointId: apId, buildingId },
      orderBy: { id: 'asc' },
    })
  }

  /** GET — wszystkie linki dla budynku (wygodne dla UI integratora). */
  async listLprLinksForBuilding(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    return this.prisma.lprCameraAccessPointLink.findMany({
      where: { buildingId },
      orderBy: { id: 'asc' },
    })
  }

  /**
   * POST /integrator/buildings/:id/access-points/:apId/cameras
   * Body: `{ cameraDeviceUuid, direction }`. Tworzy link (na duplikat 409).
   *
   * Walidacja:
   *   - kamera istnieje w `edge_device_mirror` z type='LPR_CAMERA' i buildingId
   *   - direction in {IN, OUT}
   *   - unique(cameraDeviceUuid, accessPointId) — duplikat → BadRequest
   *
   * Push `LPR_AP_LINK_UPSERT` przez tunnel — Edge SQLite synchronizuje.
   */
  async createLprApLink(
    buildingId: number,
    apId: number,
    adminId: number,
    integratorId: number,
    body: { cameraDeviceUuid?: unknown; direction?: unknown },
  ) {
    await this.getBuilding(buildingId, adminId)
    const cameraDeviceUuid = body.cameraDeviceUuid
    if (typeof cameraDeviceUuid !== 'string' || !cameraDeviceUuid) {
      throw new BadRequestException('cameraDeviceUuid jest wymagane')
    }
    const direction: LprDirection = isLprDirection(body.direction) ? body.direction : 'IN'

    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId },
      select: { id: true },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    const mirror = await this.prisma.edgeDeviceMirror.findFirst({
      where: { buildingId, deviceUuid: cameraDeviceUuid, type: 'LPR_CAMERA' },
      select: { id: true },
    })
    if (!mirror) {
      throw new BadRequestException(
        `Kamera LPR ${cameraDeviceUuid} nie istnieje w mirrorze tego budynku`,
      )
    }

    // Duplikat — łapiemy unique constraint, mapujemy na 400 z czytelnym message.
    try {
      const created = await this.prisma.lprCameraAccessPointLink.create({
        data: {
          cameraDeviceUuid,
          accessPointId: apId,
          direction,
          buildingId,
        },
      })

      this.edgeGateway
        .sendToBuilding(buildingId, 'LPR_AP_LINK_UPSERT', {
          id: created.id,
          cameraDeviceUuid: created.cameraDeviceUuid,
          accessPointId: created.accessPointId,
          direction: created.direction,
          buildingId: created.buildingId,
        })
        .catch((err) =>
          this.logger.warn(`LPR_AP_LINK_UPSERT push failed: ${err.message}`),
        )

      this.logAudit(integratorId, 'LPR_AP_LINK_CREATE', {
        targetType: 'LPR_CAMERA',
        targetId: cameraDeviceUuid,
        buildingId,
        meta: { accessPointId: apId, direction },
      })

      return created
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new BadRequestException(
          `Kamera ${cameraDeviceUuid} jest już powiązana z tym punktem dostępu`,
        )
      }
      throw e
    }
  }

  /** PATCH — zmiana direction w istniejącym linku. */
  async updateLprApLink(
    buildingId: number,
    apId: number,
    linkId: number,
    adminId: number,
    integratorId: number,
    body: { direction?: unknown },
  ) {
    await this.getBuilding(buildingId, adminId)
    if (!isLprDirection(body.direction)) {
      throw new BadRequestException('direction musi być IN lub OUT')
    }
    const link = await this.prisma.lprCameraAccessPointLink.findFirst({
      where: { id: linkId, accessPointId: apId, buildingId },
    })
    if (!link) throw new NotFoundException('Powiązanie nie istnieje')

    const updated = await this.prisma.lprCameraAccessPointLink.update({
      where: { id: linkId },
      data: { direction: body.direction },
    })

    this.edgeGateway
      .sendToBuilding(buildingId, 'LPR_AP_LINK_UPSERT', {
        id: updated.id,
        cameraDeviceUuid: updated.cameraDeviceUuid,
        accessPointId: updated.accessPointId,
        direction: updated.direction,
        buildingId: updated.buildingId,
      })
      .catch((err) =>
        this.logger.warn(`LPR_AP_LINK_UPSERT push failed: ${err.message}`),
      )

    this.logAudit(integratorId, 'LPR_AP_LINK_UPDATE', {
      targetType: 'LPR_CAMERA',
      targetId: updated.cameraDeviceUuid,
      buildingId,
      meta: { linkId, direction: body.direction },
    })

    return updated
  }

  /** DELETE — usuwa link. */
  async deleteLprApLink(
    buildingId: number,
    apId: number,
    linkId: number,
    adminId: number,
    integratorId: number,
  ) {
    await this.getBuilding(buildingId, adminId)
    const link = await this.prisma.lprCameraAccessPointLink.findFirst({
      where: { id: linkId, accessPointId: apId, buildingId },
    })
    if (!link) throw new NotFoundException('Powiązanie nie istnieje')

    await this.prisma.lprCameraAccessPointLink.delete({ where: { id: linkId } })

    this.edgeGateway
      .sendToBuilding(buildingId, 'LPR_AP_LINK_DELETE', {
        id: linkId,
        cameraDeviceUuid: link.cameraDeviceUuid,
        accessPointId: link.accessPointId,
      })
      .catch((err) =>
        this.logger.warn(`LPR_AP_LINK_DELETE push failed: ${err.message}`),
      )

    this.logAudit(integratorId, 'LPR_AP_LINK_DELETE', {
      targetType: 'LPR_CAMERA',
      targetId: link.cameraDeviceUuid,
      buildingId,
      meta: { linkId, accessPointId: apId },
    })

    return { ok: true }
  }

  /** GET — convenience: zwraca tylko `{ objectType, features }`. */
  async getObjectTypeConfig(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    const row = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { id: true, objectType: true, features: true },
    })
    if (!row) throw new NotFoundException('Budynek nie istnieje')
    const objectType: ObjectType = isObjectType(row.objectType) ? row.objectType : 'BUILDING'
    const features = normalizeFeatures(
      objectType,
      (row.features as Partial<BuildingFeatures> | null) ?? null,
    )
    return { id: row.id, objectType, features }
  }

  // ── 2026-07-30 — Przepustka wyjazdowa (exit grace pass) ──────────────────
  //
  // docs/exit-grace-pass.md. Konfiguracja żyje w Building.features.exitGrace
  // (JSON — bez migracji), edytowalna w panelu Integratora (karta w devices).
  // Po zapisie push BUILDING_CONFIG_UPDATE (outbox + tunnel) — Edge konsumuje
  // w HikvisionLprService (ścieżka LPR no-match).

  /** GET /integrator/buildings/:id/exit-grace */
  async getExitGraceConfig(buildingId: number, adminId: number): Promise<{
    buildingId: number
    exitGrace: ExitGraceConfig
    limits: { minMinutes: number; maxMinutes: number }
  }> {
    await this.getBuilding(buildingId, adminId)
    const row = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { features: true },
    })
    const raw = (row?.features as Partial<BuildingFeatures> | null)?.exitGrace
    return {
      buildingId,
      exitGrace: raw !== undefined ? normalizeExitGrace(raw) : { ...DEFAULT_EXIT_GRACE },
      limits: { minMinutes: EXIT_GRACE_MIN_MINUTES, maxMinutes: EXIT_GRACE_MAX_MINUTES },
    }
  }

  /**
   * PATCH /integrator/buildings/:id/exit-grace
   * Body: `{ enabled?: boolean, minutes?: number (5–120), afterExpiry?: 'OPEN_AND_FLAG'|'DENY' }`
   * Partial update — pola pominięte zachowują obecną wartość.
   */
  async updateExitGrace(
    buildingId: number,
    adminId: number,
    integratorId: number,
    body: { enabled?: unknown; minutes?: unknown; afterExpiry?: unknown },
  ) {
    await this.getBuilding(buildingId, adminId)

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw new BadRequestException('enabled musi być boolean')
    }
    if (body.minutes !== undefined) {
      const m = Number(body.minutes)
      if (!Number.isInteger(m) || m < EXIT_GRACE_MIN_MINUTES || m > EXIT_GRACE_MAX_MINUTES) {
        throw new BadRequestException(
          `minutes musi być liczbą całkowitą ${EXIT_GRACE_MIN_MINUTES}–${EXIT_GRACE_MAX_MINUTES}`,
        )
      }
    }
    if (body.afterExpiry !== undefined && body.afterExpiry !== 'OPEN_AND_FLAG' && body.afterExpiry !== 'DENY') {
      throw new BadRequestException(`afterExpiry musi być 'OPEN_AND_FLAG' albo 'DENY'`)
    }

    const row = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { objectType: true, features: true },
    })
    if (!row) throw new NotFoundException('Budynek nie istnieje')

    const currentFeatures = (row.features as Partial<BuildingFeatures> | null) ?? {}
    const current = currentFeatures.exitGrace !== undefined
      ? normalizeExitGrace(currentFeatures.exitGrace)
      : { ...DEFAULT_EXIT_GRACE }
    const exitGrace: ExitGraceConfig = normalizeExitGrace({
      enabled: body.enabled !== undefined ? body.enabled : current.enabled,
      minutes: body.minutes !== undefined ? body.minutes : current.minutes,
      afterExpiry: body.afterExpiry !== undefined ? body.afterExpiry : current.afterExpiry,
    })

    // Merge do istniejącego JSON-a features (NIE normalizujemy pozostałych
    // pól — PATCH exit-grace nie powinien ruszać has_concierge itd.).
    const features = { ...currentFeatures, exitGrace }
    await this.prisma.building.update({
      where: { id: buildingId },
      data: { features: features as unknown as object },
    })

    // Push do Edge — pełen payload jak updateObjectType (Edge zapisuje całość
    // do kv `building:<id>:config`; konsument: HikvisionLprService).
    this.edgeGateway
      .sendToBuilding(buildingId, 'BUILDING_CONFIG_UPDATE', {
        buildingId,
        objectType: row.objectType,
        features,
      })
      .catch((err) =>
        this.logger.warn(`BUILDING_CONFIG_UPDATE (exit-grace) push failed for b#${buildingId}: ${err.message}`),
      )

    this.logAudit(integratorId, 'EXIT_GRACE_UPDATE', {
      targetType: 'BUILDING',
      targetId: String(buildingId),
      buildingId,
      meta: { exitGrace },
    })

    return { buildingId, exitGrace }
  }

  // ── 2026-06-02 (FAZA e) — Permissions Matrix per role ──────────────────
  //
  // Integrator widzi macierz 3 ról × N feature/AP. Backend filtruje API zwroty
  // (resident dostaje permissions w `/me`, BA/Concierge w `/me`). Każdy serwis
  // używa `hasPermission` przy guard-zie na endpointach które są opcjonalne.
  //
  // Defaulty per objectType — patrz `defaultPermissionsFor()` w constants.

  /**
   * GET /integrator/buildings/:id/permissions
   *
   * Zwraca pełny payload potrzebny do wyrenderowania visual matrix:
   *   - `permissions` — bieżąca konfiguracja z DB
   *   - `accessPoints` — lista AP do oznaczenia per rola
   *   - `systemFeatures` — slownik `{ key, label }` (UI ma fallback labels)
   *   - `roles` — slownik `{ key, label }`
   *   - `objectType` — żeby UI pokazało który preset jest defaultem
   */
  async getPermissions(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    // Raw SQL — `featurePermissions` to nowa kolumna, Prisma Client może nie
    // mieć jej w typach do czasu `prisma generate`. Defensywnie używamy raw.
    const rows = await this.prisma.$queryRaw<
      { id: number; objectType: string; featurePermissions: unknown }[]
    >`
      SELECT id, "objectType", "featurePermissions"
        FROM "buildings" WHERE id = ${buildingId} LIMIT 1
    `
    const row = rows[0]
    if (!row) throw new NotFoundException('Budynek nie istnieje')

    const accessPoints = await this.prisma.accessPoint.findMany({
      where: { buildingId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true, label: true, icon: true, category: true, isActive: true,
      },
    })

    const objectType: ObjectType = isObjectType(row.objectType) ? row.objectType : 'BUILDING'
    const permissions = normalizePermissions(row.featurePermissions)

    return {
      id: row.id,
      objectType,
      permissions,
      accessPoints,
      systemFeatures: SYSTEM_FEATURES.map((key) => ({
        key,
        label: FEATURE_LABELS[key],
      })),
      roles: ROLES.map((role) => ({
        key: role,
        label: ROLE_LABELS[role],
      })),
    }
  }

  /**
   * PATCH /integrator/buildings/:id/permissions
   *
   * Body: `{ permissions: BuildingFeaturePermissions }`. Walidacja: tylko
   * boolean wartości, klucze pasują do regex `^(feat_|ap_)` — wszystko inne
   * ignorowane (forward-compat dla nowych feature, oraz defense vs garbage).
   *
   * Po PATCH wysyłamy `BUILDING_CONFIG_UPDATE` do Edge (outbox + tunnel) —
   * Edge nie potrzebuje permissions per se, ale konsystentnie aktualizuje
   * snapshot konfiguracji.
   */
  async setPermissions(
    buildingId: number,
    adminId: number,
    integratorId: number,
    body: { permissions?: unknown },
  ) {
    await this.getBuilding(buildingId, adminId)
    if (!body || typeof body !== 'object' || !body.permissions) {
      throw new BadRequestException('Brak `permissions` w body')
    }
    const normalized = normalizePermissions(body.permissions)
    // Dodatkowy filter: tylko klucze `feat_*` lub `ap_*` (forward-compat —
    // nowe feature klient może wysłać przed wdrożeniem backendu).
    for (const role of ROLES) {
      const roleData = normalized[role] ?? {}
      const filtered: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(roleData)) {
        if (typeof v !== 'boolean') continue
        if (k.startsWith('feat_') || k.startsWith('ap_')) {
          filtered[k] = v
        }
      }
      normalized[role] = filtered
    }

    // Raw SQL UPDATE — Prisma Client może jeszcze nie znać `featurePermissions`.
    await this.prisma.$executeRaw`
      UPDATE "buildings"
         SET "featurePermissions" = ${JSON.stringify(normalized)}::jsonb
       WHERE id = ${buildingId}
    `
    const rows = await this.prisma.$queryRaw<
      { id: number; objectType: string; features: unknown; featurePermissions: unknown }[]
    >`
      SELECT id, "objectType", features, "featurePermissions"
        FROM "buildings" WHERE id = ${buildingId} LIMIT 1
    `
    const row = rows[0]
    const objectType: ObjectType = isObjectType(row?.objectType) ? row!.objectType as ObjectType : 'BUILDING'
    const features = normalizeFeatures(
      objectType,
      (row?.features as Partial<BuildingFeatures> | null) ?? null,
    )
    this.edgeGateway
      .sendToBuilding(buildingId, 'BUILDING_CONFIG_UPDATE', {
        buildingId,
        objectType,
        features,
        permissions: normalized,
      })
      .catch((err) =>
        this.logger.warn(`BUILDING_CONFIG_UPDATE (permissions) push failed for b#${buildingId}: ${err.message}`),
      )

    this.logAudit(integratorId, 'BUILDING_PERMISSIONS_UPDATE', {
      targetType: 'BUILDING',
      targetId: String(buildingId),
      buildingId,
      meta: { permissions: normalized },
    })

    return {
      id: buildingId,
      objectType,
      permissions: normalized,
    }
  }

  /**
   * POST /integrator/buildings/:id/permissions/reset
   *
   * Przywraca defaulty dla obecnego `objectType` (synced z migration backfill).
   * Per-AP klucze (`ap_<id>`) nie są resetowane — zostają takie jak były
   * (jeśli były) bo defaulty per objectType nie znają konkretnych AP-ów
   * tego budynku.
   */
  async resetPermissions(
    buildingId: number,
    adminId: number,
    integratorId: number,
  ) {
    await this.getBuilding(buildingId, adminId)
    const rows = await this.prisma.$queryRaw<
      { id: number; objectType: string; featurePermissions: unknown }[]
    >`
      SELECT id, "objectType", "featurePermissions"
        FROM "buildings" WHERE id = ${buildingId} LIMIT 1
    `
    const row = rows[0]
    if (!row) throw new NotFoundException('Budynek nie istnieje')

    const objectType: ObjectType = isObjectType(row.objectType) ? row.objectType : 'BUILDING'
    const defaults = defaultPermissionsFor(objectType)

    // Zachowaj `ap_*` wpisy z istniejących permissions — to per-budynek
    // konfiguracja AP która nie jest w defaultach.
    const current = normalizePermissions(row.featurePermissions)
    const merged: BuildingFeaturePermissions = {
      ba: { ...(defaults.ba ?? {}) },
      concierge: { ...(defaults.concierge ?? {}) },
      resident: { ...(defaults.resident ?? {}) },
    }
    for (const role of ROLES) {
      const existing = current[role] ?? {}
      for (const [k, v] of Object.entries(existing)) {
        if (k.startsWith('ap_') && typeof v === 'boolean') {
          merged[role]![k] = v
        }
      }
    }

    await this.prisma.$executeRaw`
      UPDATE "buildings"
         SET "featurePermissions" = ${JSON.stringify(merged)}::jsonb
       WHERE id = ${buildingId}
    `

    this.edgeGateway
      .sendToBuilding(buildingId, 'BUILDING_CONFIG_UPDATE', {
        buildingId,
        objectType,
        permissions: merged,
      })
      .catch((err) =>
        this.logger.warn(`BUILDING_CONFIG_UPDATE (permissions reset) push failed for b#${buildingId}: ${err.message}`),
      )

    this.logAudit(integratorId, 'BUILDING_PERMISSIONS_RESET', {
      targetType: 'BUILDING',
      targetId: String(buildingId),
      buildingId,
      meta: { objectType },
    })

    return {
      id: buildingId,
      objectType,
      permissions: merged,
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  FAZA f (2026-06-02) — Multi-budynkowy dashboard
  // ────────────────────────────────────────────────────────────────────────
  //
  // Agregowany widok wszystkich budynków integratora. Pierwsza strona po
  // login. Karty per budynek: status Edge (online/offline + uptime + queue
  // + outbox pending/failed), kluczowe statystyki (urządzenia, mieszkańcy,
  // lokale, AP, anomalie 24h, LPR 24h, kurierzy 24h) + computed health
  // (ok/warning/critical) z human-readable PL issues.
  //
  // Performance budget: <1s przy 50 budynkach. Zamiast N+1 (per-building
  // SELECT-y) używamy 1× raw SQL z LATERAL subquery per metryka. Edge
  // status idzie z `EdgeGateway.getLastStatus()` (cache STATUS message-y) —
  // bez HTTP calls.
  async getDashboard(adminId: number): Promise<{
    generatedAt: string
    totals: {
      buildings: number
      online: number
      offline: number
      withAnomalies24h: number
      withFailedOutbox: number
    }
    buildings: Array<{
      id: number
      name: string
      address: string
      objectType: string
      features: BuildingFeatures
      edge: {
        hasActivated: boolean
        online: boolean
        uptime: number | null
        queueSize: number | null
        lastSeenAt: string | null
        ipAddress: string | null
        outbox: { pending: number; failed: number }
        version: string | null
      }
      stats: {
        devices: number
        residents: number
        units: number
        accessPoints: number
        anomaliesLast24h: number
        lprReadsLast24h: number
        couriersLast24h: number
      }
      health: {
        status: 'ok' | 'warning' | 'critical'
        issues: string[]
      }
      // PR-3 — badge gotowości obiektu (batch z IntegratorReadinessService,
      // bez N+1: stały koszt ~5 zapytań dla całego portfolio).
      readiness: ReadinessSummary | null
    }>
  }> {
    // 1) Pobierz wszystkie budynki integratora z agregowanymi statystykami
    //    w jednym query. Każda metryka per-budynek jako sub-select scalar —
    //    Postgres jest w tym dobry, planner robi index-only scan po
    //    indeksach (buildingId, ts DESC) które już mamy.
    type Row = {
      id: number
      name: string
      address: string
      objectType: string
      features: any
      devicesCount: number
      residentsCount: number
      unitsCount: number
      apsCount: number
      anomalies24h: number
      lprReads24h: number
      couriers24h: number
      unresolvedAnomaliesOld: number  // anomaly bez resolve > 24h (warning trigger)
    }
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        b.id,
        b.name,
        b.address,
        b."objectType",
        b.features,
        (SELECT COUNT(*)::int FROM edge_device_mirror m  WHERE m."buildingId" = b.id) AS "devicesCount",
        (SELECT COUNT(*)::int FROM residents r           WHERE r."buildingId" = b.id) AS "residentsCount",
        (SELECT COUNT(*)::int FROM units u               WHERE u."buildingId" = b.id) AS "unitsCount",
        (SELECT COUNT(*)::int FROM access_points ap      WHERE ap."buildingId" = b.id) AS "apsCount",
        (SELECT COUNT(*)::int FROM anomaly_events ae
           WHERE ae."buildingId" = b.id AND ae.ts > NOW() - INTERVAL '24 hours') AS "anomalies24h",
        (SELECT COUNT(*)::int FROM lpr_reads lr
           WHERE lr."buildingId" = b.id AND lr.ts > NOW() - INTERVAL '24 hours') AS "lprReads24h",
        (SELECT COUNT(*)::int FROM courier_visits cv
           WHERE cv."buildingId" = b.id AND cv."createdAt" > NOW() - INTERVAL '24 hours') AS "couriers24h",
        (SELECT COUNT(*)::int FROM anomaly_events ae
           WHERE ae."buildingId" = b.id
             AND ae."resolvedAt" IS NULL
             AND ae.ts < NOW() - INTERVAL '24 hours') AS "unresolvedAnomaliesOld"
      FROM buildings b
      WHERE b."adminId" = ${adminId} AND b."isArchived" = false
      ORDER BY b."createdAt" ASC
    `

    if (rows.length === 0) {
      return {
        generatedAt: new Date().toISOString(),
        totals: { buildings: 0, online: 0, offline: 0, withAnomalies24h: 0, withFailedOutbox: 0 },
        buildings: [],
      }
    }

    // 2) Pobierz wszystkie EdgeDevice naraz (po buildingIds) — jeden SELECT
    //    + group-by per building w pamięci. EDGE-y zwykle są 1 per budynek
    //    ale model dopuszcza N (Cloud + Edge_AI).
    const buildingIds = rows.map((r) => r.id)

    // PR-3 — readiness badge per budynek. Batch (5 zapytań łącznie dla
    // wszystkich budynków); fail-soft — błąd readiness nie ubija dashboardu.
    const readinessByBuilding = await this.readiness
      .summarizeForBuildings(buildingIds)
      .catch((err) => {
        this.logger.warn(`Dashboard readiness batch failed: ${err?.message ?? err}`)
        return new Map<number, ReadinessSummary>()
      })

    const edges = await this.prisma.edgeDevice.findMany({
      where: { buildingId: { in: buildingIds } },
      select: {
        id: true,
        buildingId: true,
        type: true,
        isActivated: true,
        activatedAt: true,
        lastSeenAt: true,
        ipAddress: true,
        version: true,
      },
      orderBy: { createdAt: 'asc' },
    })
    const edgesByBuilding = new Map<number, typeof edges>()
    for (const e of edges) {
      const list = edgesByBuilding.get(e.buildingId) ?? []
      list.push(e)
      edgesByBuilding.set(e.buildingId, list)
    }

    // 3) Outbox stats per building (1 query agregowane).
    type OutboxRow = { buildingId: number; pending: number; failed: number }
    const outboxRows = await this.prisma.$queryRaw<OutboxRow[]>`
      SELECT
        "buildingId",
        COUNT(*) FILTER (WHERE "deliveredAt" IS NULL AND "failedAt" IS NULL)::int AS pending,
        COUNT(*) FILTER (WHERE "failedAt" IS NOT NULL)::int                       AS failed
      FROM "edge_sync_outbox"
      WHERE "buildingId" = ANY(${buildingIds}::int[])
      GROUP BY "buildingId"
    `
    const outboxByBuilding = new Map<number, { pending: number; failed: number }>()
    for (const o of outboxRows) {
      outboxByBuilding.set(o.buildingId, { pending: o.pending, failed: o.failed })
    }

    // 4) Render per-building cards. Edge status: bierzemy najświeższy
    //    aktywowany Edge per budynek (jeśli istnieje wiele).
    const now = Date.now()
    const cards = rows.map((r) => {
      const features = normalizeFeatures(
        (isObjectType(r.objectType) ? r.objectType : 'BUILDING') as ObjectType,
        r.features as Partial<BuildingFeatures> | null,
      )

      const buildingEdges = edgesByBuilding.get(r.id) ?? []
      const primaryEdge = buildingEdges.find((e) => e.isActivated) ?? buildingEdges[0] ?? null

      const online = primaryEdge ? this.edgeGateway.isOnline(primaryEdge.id) : false
      const lastStatus = primaryEdge ? this.edgeGateway.getLastStatus(primaryEdge.id) : null
      const outbox = outboxByBuilding.get(r.id) ?? { pending: 0, failed: 0 }
      const lastSeenMs = primaryEdge?.lastSeenAt?.getTime() ?? 0
      const offlineSec = lastSeenMs ? Math.floor((now - lastSeenMs) / 1000) : Infinity

      // Health computation. Helper żeby TypeScript nie narrowował literalu po
      // dosłownym przypisaniu i nie blokował kolejnych przejść status-u
      // (`'ok' → 'warning' → 'critical'`).
      const issues: string[] = []
      const statusRank: Record<'ok' | 'warning' | 'critical', number> = { ok: 0, warning: 1, critical: 2 }
      let status: 'ok' | 'warning' | 'critical' = 'ok'
      const escalate = (next: 'ok' | 'warning' | 'critical') => {
        if (statusRank[next] > statusRank[status]) status = next
      }

      if (!primaryEdge) {
        issues.push('Brak aktywowanego Edge w budynku')
        escalate('critical')
      } else if (!primaryEdge.isActivated) {
        issues.push('Edge nieaktywowany — wpisz kod aktywacyjny')
        escalate('critical')
      } else if (!online) {
        const human = humanizePolishDuration(offlineSec)
        issues.push(`Edge offline ${human}`)
        if (offlineSec > 3600) escalate('critical')
        else if (offlineSec >= 300) escalate('warning')
      }

      if (outbox.failed > 0) {
        issues.push(`Outbox: ${outbox.failed} niedostarczonych wiadomości`)
        escalate('critical')
      }

      if (lastStatus && typeof lastStatus.queueSize === 'number' && lastStatus.queueSize > 100) {
        issues.push(`Edge kolejka: ${lastStatus.queueSize} eventów oczekujących`)
        escalate('warning')
      }

      if (r.unresolvedAnomaliesOld > 0) {
        issues.push(
          r.unresolvedAnomaliesOld === 1
            ? '1 anomalia bez obsługi > 24h'
            : `${r.unresolvedAnomaliesOld} anomalii bez obsługi > 24h`,
        )
        escalate('warning')
      }

      return {
        id: r.id,
        name: r.name,
        address: r.address,
        objectType: r.objectType,
        features,
        edge: {
          hasActivated: !!(primaryEdge?.isActivated),
          online,
          uptime: lastStatus?.uptime ?? null,
          queueSize: lastStatus?.queueSize ?? null,
          lastSeenAt: primaryEdge?.lastSeenAt?.toISOString() ?? null,
          ipAddress: primaryEdge?.ipAddress ?? null,
          outbox,
          version: lastStatus?.version ?? primaryEdge?.version ?? null,
        },
        stats: {
          devices: r.devicesCount,
          residents: r.residentsCount,
          units: r.unitsCount,
          accessPoints: r.apsCount,
          anomaliesLast24h: r.anomalies24h,
          lprReadsLast24h: r.lprReads24h,
          couriersLast24h: r.couriers24h,
        },
        health: { status, issues },
        readiness: readinessByBuilding.get(r.id) ?? null,
      }
    })

    const onlineCount  = cards.filter((c) => c.edge.online).length
    const offlineCount = cards.filter((c) => !c.edge.online).length
    const withAnomalies24h = cards.filter((c) => c.stats.anomaliesLast24h > 0).length
    const withFailedOutbox = cards.filter((c) => c.edge.outbox.failed > 0).length

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        buildings: cards.length,
        online: onlineCount,
        offline: offlineCount,
        withAnomalies24h,
        withFailedOutbox,
      },
      buildings: cards,
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  FAZA 8.g (2026-06-03) — AI Engine config
  // ────────────────────────────────────────────────────────────────────────

  /**
   * GET /integrator/buildings/:id/ai-engine
   *
   * Zwraca aktualny config + ostatni test (z `lastTest*` kolumn). Frontend
   * polluje co 2s po kliknięciu "Testuj" żeby zobaczyć wynik.
   */
  async getAiEngineConfig(buildingId: number, adminId: number) {
    await this.getBuilding(buildingId, adminId)
    // FAZA 8.h.7 — LLM fields w SELECT
    const rows = await this.prisma.$queryRaw<Array<{
      id: number
      buildingId: number
      url: string
      healthPath: string
      model: string
      enabled: boolean
      lastTestAt: Date | null
      lastTestOk: boolean | null
      lastTestMs: number | null
      lastTestErr: string | null
      lastTestCode: number | null
      llmUrl: string | null
      llmModel: string
      llmEnabled: boolean
      llmLastTestAt: Date | null
      llmLastTestOk: boolean | null
      llmLastTestMs: number | null
      llmLastTestErr: string | null
      llmLastTestCode: number | null
      llmAvailableModels: unknown
      createdAt: Date
      updatedAt: Date
    }>>`
      SELECT id, "buildingId", url, "healthPath", model, enabled,
             "lastTestAt", "lastTestOk", "lastTestMs", "lastTestErr", "lastTestCode",
             "llmUrl", "llmModel", "llmEnabled",
             "llmLastTestAt", "llmLastTestOk", "llmLastTestMs", "llmLastTestErr", "llmLastTestCode",
             "llmAvailableModels",
             "createdAt", "updatedAt"
        FROM "ai_engines" WHERE "buildingId" = ${buildingId} LIMIT 1
    `
    const row = rows[0] ?? null
    if (!row) {
      return {
        configured: false,
        buildingId,
        url: null,
        healthPath: '/health',
        model: 'yolov8n',
        enabled: false,
        lastTest: null,
        llmUrl: null,
        llmModel: 'qwen2.5:14b',
        llmEnabled: false,
        llmLastTest: null,
        llmAvailableModels: [],
      }
    }
    return {
      configured: true,
      buildingId: row.buildingId,
      url: row.url,
      healthPath: row.healthPath,
      model: row.model,
      enabled: row.enabled,
      lastTest: row.lastTestAt
        ? {
            at: row.lastTestAt,
            ok: row.lastTestOk,
            ms: row.lastTestMs,
            error: row.lastTestErr,
            statusCode: row.lastTestCode,
          }
        : null,
      // FAZA 8.h.7 — LLM
      llmUrl: row.llmUrl,
      llmModel: row.llmModel,
      llmEnabled: row.llmEnabled,
      llmLastTest: row.llmLastTestAt
        ? {
            at: row.llmLastTestAt,
            ok: row.llmLastTestOk,
            ms: row.llmLastTestMs,
            error: row.llmLastTestErr,
            statusCode: row.llmLastTestCode,
          }
        : null,
      // FAZA 8.h.8 — lista zainstalowanych modeli z ostatniego LLM_TEST.
      // Pusta tablica gdy brak testu lub Ollama nieosiągalny.
      llmAvailableModels: Array.isArray(row.llmAvailableModels)
        ? (row.llmAvailableModels as string[]).filter((m) => typeof m === 'string')
        : [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  /**
   * PATCH /integrator/buildings/:id/ai-engine
   *
   * Body: `{ url, healthPath?, model?, enabled? }`. Upsert per buildingId
   * (UNIQUE). Po zapisie wysyłamy `AI_ENGINE_CONFIG_UPDATE` przez tunnel +
   * outbox.
   */
  async upsertAiEngineConfig(
    buildingId: number,
    adminId: number,
    integratorId: number,
    body: {
      url?: string
      healthPath?: string | null
      model?: string | null
      enabled?: boolean
      // FAZA 8.h.7 — LLM fields
      llmUrl?: string | null
      llmModel?: string | null
      llmEnabled?: boolean
    },
  ) {
    await this.getBuilding(buildingId, adminId)
    const url = (body.url ?? '').trim().replace(/\/+$/, '')
    if (!url) throw new BadRequestException('Brak `url` (np. http://192.168.1.109:8080)')
    // Walidacja URL — dopuszczamy http/https + IP/host + port.
    try {
      const u = new URL(url)
      if (!['http:', 'https:'].includes(u.protocol)) {
        throw new Error('protocol')
      }
    } catch {
      throw new BadRequestException('Nieprawidłowy URL — wymagany http(s)://host[:port]')
    }
    const healthPath = typeof body.healthPath === 'string' && body.healthPath.length > 0
      ? (body.healthPath.startsWith('/') ? body.healthPath : `/${body.healthPath}`)
      : '/health'
    const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : 'yolov8n'
    const enabled = body.enabled === false ? false : true

    // LLM walidacja — opcjonalna sekcja. null oznacza "wyczyść URL", pusta string traktowana jako null.
    let llmUrl: string | null | undefined = undefined
    if (body.llmUrl !== undefined) {
      const trimmed = (body.llmUrl ?? '').trim().replace(/\/+$/, '')
      if (trimmed === '') {
        llmUrl = null
      } else {
        try {
          const u = new URL(trimmed)
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error('protocol')
          llmUrl = trimmed
        } catch {
          throw new BadRequestException('Nieprawidłowy LLM URL — wymagany http(s)://host[:port]')
        }
      }
    }
    const llmModel = body.llmModel !== undefined && body.llmModel
      ? body.llmModel.trim()
      : undefined
    const llmEnabled = body.llmEnabled

    // Raw SQL — Prisma Client może nie znać `ai_engines.llm*` przed `prisma generate`.
    // COALESCE w ON CONFLICT zachowuje istniejące LLM gdy partial update.
    await this.prisma.$executeRaw`
      INSERT INTO "ai_engines" (
        "buildingId", url, "healthPath", model, enabled,
        "llmUrl", "llmModel", "llmEnabled",
        "updatedAt"
      )
      VALUES (
        ${buildingId}, ${url}, ${healthPath}, ${model}, ${enabled},
        ${llmUrl ?? null}, ${llmModel ?? 'qwen2.5:14b'}, ${llmEnabled ?? true},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("buildingId") DO UPDATE
         SET url           = EXCLUDED.url,
             "healthPath"  = EXCLUDED."healthPath",
             model         = EXCLUDED.model,
             enabled       = EXCLUDED.enabled,
             "llmUrl"      = COALESCE(${llmUrl}, "ai_engines"."llmUrl"),
             "llmModel"    = COALESCE(${llmModel}, "ai_engines"."llmModel"),
             "llmEnabled"  = COALESCE(${llmEnabled}, "ai_engines"."llmEnabled"),
             "updatedAt"   = CURRENT_TIMESTAMP
    `

    // Po zapisie pobierz aktualny state (po COALESCE) żeby push do Edge zawierał properly.
    const current = await this.getAiEngineConfig(buildingId, adminId)

    this.edgeGateway
      .sendToBuilding(buildingId, 'AI_ENGINE_CONFIG_UPDATE', {
        buildingId,
        url: current.url,
        healthPath: current.healthPath,
        model: current.model,
        enabled: current.enabled,
        // FAZA 8.h.7 — propagate LLM
        llmUrl: current.llmUrl,
        llmModel: current.llmModel,
        llmEnabled: current.llmEnabled,
      })
      .catch((err) =>
        this.logger.warn(`AI_ENGINE_CONFIG_UPDATE push failed for b#${buildingId}: ${err.message}`),
      )

    this.logAudit(integratorId, 'AI_ENGINE_CONFIG_UPDATE', {
      targetType: 'BUILDING',
      targetId: String(buildingId),
      buildingId,
      meta: {
        url: current.url, healthPath: current.healthPath, model: current.model, enabled: current.enabled,
        llmUrl: current.llmUrl, llmModel: current.llmModel, llmEnabled: current.llmEnabled,
      },
    })

    return current
  }

  /**
   * POST /integrator/buildings/:id/ai-engine/test
   *
   * Wysyła `AI_ENGINE_TEST` przez tunnel. Edge GET /<healthPath> i wysyła
   * wynik jako EVT `AI_ENGINE_TEST_RESULT`, który EdgeGateway zapisuje do
   * `ai_engines.lastTest*`. Frontend dostaje `{queued: true}` od razu i
   * polluje GET /ai-engine co ~2s żeby zobaczyć fresh `lastTest`.
   *
   * Edge może być offline — outbox zachowa command do reconnect.
   */
  async testAiEngineConnection(
    buildingId: number,
    adminId: number,
    integratorId: number,
    body: { urlOverride?: string; healthPathOverride?: string },
  ) {
    await this.getBuilding(buildingId, adminId)

    const payload: Record<string, unknown> = {}
    if (body?.urlOverride) payload.urlOverride = body.urlOverride
    if (body?.healthPathOverride) payload.healthPathOverride = body.healthPathOverride

    await this.edgeGateway.sendToBuilding(buildingId, 'AI_ENGINE_TEST', payload)

    this.logAudit(integratorId, 'AI_ENGINE_TEST', {
      targetType: 'BUILDING',
      targetId: String(buildingId),
      buildingId,
      meta: payload,
    })

    return { queued: true, buildingId }
  }

  /**
   * POST /integrator/buildings/:id/ai-engine/test-llm
   *
   * Wysyła `LLM_TEST` do Edge. Edge robi GET /api/tags na Ollama, zwraca
   * EVT `LLM_TEST_RESULT` z `availableModels: string[]`. EdgeGateway
   * zapisuje wynik do `ai_engines.llmLastTest*` + `llmAvailableModels`
   * (JSON kolumna). Frontend polluje GET /ai-engine żeby zobaczyć fresh result.
   *
   * FAZA 8.h.8 (2026-06-08) — pozwala integratorowi zobaczyć JAKIE modele
   * są faktycznie zainstalowane w Ollamie zanim wybierze z dropdownu (który
   * to tylko popularne PRESETY, nie wszystkie są pulled).
   */
  async testLlmConnection(
    buildingId: number,
    adminId: number,
    integratorId: number,
    body: { urlOverride?: string },
  ) {
    await this.getBuilding(buildingId, adminId)

    const payload: Record<string, unknown> = {}
    if (body?.urlOverride) payload.urlOverride = body.urlOverride

    await this.edgeGateway.sendToBuilding(buildingId, 'LLM_TEST', payload)

    this.logAudit(integratorId, 'LLM_TEST', {
      targetType: 'BUILDING',
      targetId: String(buildingId),
      buildingId,
      meta: payload,
    })

    return { queued: true, buildingId }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  FAZA 8.h.25 (2026-06-12) — logi pytań GateLynk AI + ocena (tymczasowy
  //  panel do zbierania datasetu Q/A pod dostrojenie LLM)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * GET /integrator/buildings/:id/assistant-logs
   * Filtr `rating`: 'unrated' | 'ok' | 'bad' | undefined (wszystkie).
   * Paginacja limit/offset, sort createdAt DESC (najnowsze pierwsze).
   */
  async getAssistantLogs(
    buildingId: number,
    adminId: number,
    opts: { limit?: number; offset?: number; rating?: string } = {},
  ) {
    await this.getBuilding(buildingId, adminId)

    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const offset = Math.max(opts.offset ?? 0, 0)
    const where: Record<string, unknown> = { buildingId }
    if (opts.rating === 'unrated') where.ratingOk = null
    else if (opts.rating === 'ok') where.ratingOk = true
    else if (opts.rating === 'bad') where.ratingOk = false

    const [items, total, unrated] = await Promise.all([
      this.prisma.assistantQueryLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.assistantQueryLog.count({ where }),
      this.prisma.assistantQueryLog.count({ where: { buildingId, ratingOk: null } }),
    ])

    return { items, total, unrated, limit, offset }
  }

  /**
   * PATCH /integrator/buildings/:id/assistant-logs/:logId
   * Body `{ ratingOk: true | false | null }` — null cofa ocenę.
   * Tenant guard: log musi należeć do budynku, budynek do admina.
   */
  async rateAssistantLog(
    buildingId: number,
    adminId: number,
    logId: number,
    ratingOk: boolean | null,
  ) {
    await this.getBuilding(buildingId, adminId)

    const log = await this.prisma.assistantQueryLog.findFirst({
      where: { id: logId, buildingId },
      select: { id: true },
    })
    if (!log) throw new NotFoundException(`Log ${logId} nie istnieje w budynku ${buildingId}`)

    return this.prisma.assistantQueryLog.update({
      where: { id: logId },
      data: { ratingOk, ratedAt: ratingOk === null ? null : new Date() },
    })
  }
}

/**
 * Human-readable czas trwania po polsku — dla `health.issues` w dashboardzie.
 * Sekundy → "12 sek", "5 min", "2h 15min", "3d 4h".
 *
 * Edge case: Infinity (nigdy nie widziany) → 'od bardzo dawna'.
 */
function humanizePolishDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec)) return 'od bardzo dawna'
  if (totalSec < 60) return `${Math.max(0, Math.floor(totalSec))} sek`
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)} min`
  if (totalSec < 86400) {
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    return m > 0 ? `${h}h ${m}min` : `${h}h`
  }
  const d = Math.floor(totalSec / 86400)
  const h = Math.floor((totalSec % 86400) / 3600)
  return h > 0 ? `${d}d ${h}h` : `${d}d`
}

/**
 * Helper — maskuje hasła/login z obiektu konfiguracyjnego. Działa generycznie
 * dla intercom (sipPassword, ipAddress) i LPR (password, login).
 */
function maskCredentials<T extends Record<string, unknown>>(obj: T): T {
  const masked: Record<string, unknown> = { ...obj }
  const SECRETS = ['password', 'sipPassword', 'sipAccount']
  for (const k of SECRETS) {
    if (k in masked && masked[k]) masked[k] = '***'
  }
  return masked as T
}
