import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { IsOptional, IsString } from 'class-validator'
import { randomBytes } from 'crypto'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'

// Gdy API żyje na Fly.io z tailscaled w userspace mode, jedyna droga do hostów
// w tailnecie (np. Edge na 100.90.244.90:4000) wiedzie przez lokalny HTTP proxy
// wystawiony przez tailscaled (`--outbound-http-proxy-listen=localhost:1055`).
// `entrypoint-api.sh` ustawia `TS_HTTP_PROXY=http://localhost:1055` po `tailscale up`.
//
// Konstruujemy ProxyAgent raz przy ładowaniu modułu (singleton) — taniej niż
// per-fetch i undici trzyma keep-alive pool. Gdy proxy nie jest ustawiony
// (dev / Docker compose), `edgeDispatcher === undefined` i undiciFetch zachowuje
// się jak natywny fetch — bezpieczny no-op fallback.
const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

export class GenerateActivationCodeDto {
  buildingId: number
  type?: 'EDGE' | 'EDGE_AI'
  name?: string
}

export class ActivateEdgeDto {
  @IsString() activationCode: string
  @IsOptional() @IsString() version?: string
  @IsOptional() machineInfo?: Record<string, any>
}

export class RefreshEdgeTokenDto {
  @IsString() refreshToken: string
}

@Injectable()
export class EdgeService {
  private readonly logger = new Logger(EdgeService.name)

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  // ── Generate one-time activation code (called from superadmin panel) ─────────
  async generateActivationCode(adminId: number, dto: GenerateActivationCodeDto) {
    // Verify building belongs to admin
    const building = await this.prisma.building.findFirst({
      where: { id: dto.buildingId, adminId },
    })
    if (!building) throw new NotFoundException('Budynek nie znaleziony')

    const code = this.genCode()
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h

    const device = await this.prisma.edgeDevice.create({
      data: {
        buildingId: dto.buildingId,
        type: dto.type ?? 'EDGE',
        name: dto.name ?? `GateLynk ${dto.type ?? 'Edge'} — ${building.name}`,
        activationCode: code,
        activationCodeExpiresAt: expiresAt,
      },
    })

    this.logger.log(`Generated activation code for building ${dto.buildingId}: ${code}`)
    return { code, deviceId: device.id, expiresAt }
  }

  // ── Activate device with one-time code ───────────────────────────────────────
  async activate(dto: ActivateEdgeDto) {
    const device = await this.prisma.edgeDevice.findUnique({
      where: { activationCode: dto.activationCode },
      include: { building: true },
    })

    if (!device) throw new BadRequestException('Nieprawidłowy kod aktywacyjny')
    if (device.isActivated) throw new BadRequestException('Urządzenie już aktywowane')
    if (device.activationCodeExpiresAt && device.activationCodeExpiresAt < new Date()) {
      throw new BadRequestException('Kod aktywacyjny wygasł')
    }

    const updated = await this.prisma.edgeDevice.update({
      where: { id: device.id },
      data: {
        isActivated: true,
        activatedAt: new Date(),
        activationCode: null, // consume code
        activationCodeExpiresAt: null,
        version: dto.version,
        machineInfo: dto.machineInfo,
        lastSeenAt: new Date(),
      },
    })

    const payload = {
      sub: device.id,
      buildingId: device.buildingId,
      type: device.type,
      role: 'EDGE',
    }

    const token = this.jwt.sign(payload, { expiresIn: '24h' })
    const refreshToken = this.jwt.sign({ sub: device.id, role: 'EDGE_REFRESH' }, { expiresIn: '90d' })

    this.logger.log(`Edge device activated: ${device.id} for building ${device.buildingId}`)

    return {
      token,
      refreshToken,
      deviceId: device.id,
      buildingId: device.buildingId,
      buildingName: device.building.name,
    }
  }

  // ── Refresh token ─────────────────────────────────────────────────────────────
  /**
   * Konkretny powód błędu loggujemy zawsze (warn), bo bez tego diagnoza
   * „dlaczego Edge ciągle dostaje 401 z /refresh" jest detektywistyczna —
   * realny przypadek z 27.04.2026: rotacja JWT_SECRET, refresh token podpisany
   * starym sekretem, catch{} połykał `JsonWebTokenError: invalid signature`
   * i Edge dostawał tylko anonimowe „Nieprawidłowy refresh token".
   *
   * Klient nadal dostaje generic 401 (żeby nie wystawiać szczegółów do
   * publicznego endpointu) — log jest tylko po stronie serwera.
   */
  async refreshToken(dto: RefreshEdgeTokenDto) {
    try {
      const payload = this.jwt.verify(dto.refreshToken) as any
      if (payload.role !== 'EDGE_REFRESH') {
        this.logger.warn(`Refresh rejected — wrong role: ${payload.role}`)
        throw new UnauthorizedException()
      }

      const device = await this.prisma.edgeDevice.findUnique({ where: { id: payload.sub } })
      if (!device) {
        this.logger.warn(`Refresh rejected — device ${payload.sub} not found in DB`)
        throw new UnauthorizedException('Urządzenie nieaktywne')
      }
      if (!device.isActivated) {
        this.logger.warn(`Refresh rejected — device ${device.id} is deactivated`)
        throw new UnauthorizedException('Urządzenie nieaktywne')
      }

      const newPayload = { sub: device.id, buildingId: device.buildingId, type: device.type, role: 'EDGE' }
      const token = this.jwt.sign(newPayload, { expiresIn: '24h' })
      const refreshToken = this.jwt.sign({ sub: device.id, role: 'EDGE_REFRESH' }, { expiresIn: '90d' })

      this.logger.log(`Token refreshed for device ${device.id} (building ${device.buildingId})`)
      return { token, refreshToken }
    } catch (err: any) {
      // Najczęstsze przyczyny: TokenExpiredError, JsonWebTokenError
      // (invalid signature po rotacji JWT_SECRET), albo nasze własne
      // UnauthorizedException — w obu wypadkach klient widzi 401.
      const reason = err?.name && err?.message ? `${err.name}: ${err.message}` : String(err?.message ?? err)
      this.logger.warn(`Refresh token rejected — ${reason}`)
      throw new UnauthorizedException('Nieprawidłowy refresh token')
    }
  }

  // ── Verify edge JWT (used by gateway) ────────────────────────────────────────
  verifyToken(token: string): { deviceId: string; buildingId: number; type: string } | null {
    try {
      const payload = this.jwt.verify(token) as any
      if (payload.role !== 'EDGE') return null
      return { deviceId: payload.sub, buildingId: payload.buildingId, type: payload.type }
    } catch {
      return null
    }
  }

  // ── Sync access points from Edge → Cloud DB ──────────────────────────────────
  async syncAccessPoints(edgeDeviceId: string, buildingId: number, ipAddress: string): Promise<void> {
    try {
      // undiciFetch + dispatcher → ruch leci przez Tailscale userspace HTTP proxy
      // (gdy `TS_HTTP_PROXY` jest ustawiony). Bez proxy zachowuje się jak natywny fetch.
      const res = await undiciFetch(`http://${ipAddress}:4000/devices`, {
        signal: AbortSignal.timeout(8000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) return
      const devices: any[] = await res.json() as any[]

      for (const d of devices) {
        if (d.type !== 'INTERCOM') continue
        const cfg = d.config ?? {}
        const deviceName = cfg.name || d.deviceId
        const relays: { index: number; name: string }[] = Array.isArray(cfg.relays) && cfg.relays.length > 0
          ? cfg.relays.map((r: any) => ({ index: r.index ?? 0, name: r.name || `Przekaźnik ${r.index ?? 0}` }))
          : [{ index: cfg.doorRelayIndex ?? 0, name: deviceName }]

        for (const relay of relays) {
          // Faza 5 — przy update NIE nadpisujemy `label`/`icon`. Admin może
          // override-ować nazwę („Brama N" zamiast „Przekaźnik 0") w panelu
          // BA, a sync co 5 min nie powinien tego cofać. Update tylko refresh-uje
          // `edgeDeviceId` (gdyby Edge został wymieniony) i `isActive=true`
          // (gdyby admin wcześniej dezaktywował AP, ale Edge dalej widzi go
          // jako działający — przywracamy stan „dostępny", ale resident może
          // dalej go nie widzieć przez `displayedToResident` flag w przyszłości).
          await this.prisma.accessPoint.upsert({
            where: { buildingId_deviceId_relayIndex: { buildingId, deviceId: d.deviceId, relayIndex: relay.index } },
            create: {
              buildingId,
              edgeDeviceId,
              deviceId: d.deviceId,
              relayIndex: relay.index,
              label: relay.name,
              icon: this.guessIcon(relay.name),
              isActive: true,
            },
            update: {
              edgeDeviceId,
            },
          })
        }
      }
      this.logger.log(`Access points synced for building ${buildingId} (${devices.length} devices)`)
    } catch (err: any) {
      this.logger.warn(`Access point sync failed for building ${buildingId}: ${err.message}`)
    }
  }

  private guessIcon(label: string): string {
    const l = label.toLowerCase()
    if (l.includes('garaż') || l.includes('garaz') || l.includes('garage')) return 'garage'
    if (l.includes('furtka') || l.includes('wicket') || l.includes('gate')) return 'gate'
    if (l.includes('winda') || l.includes('elevator')) return 'elevator'
    if (l.includes('szlaban') || l.includes('barrier')) return 'barrier'
    return 'door'
  }

  // ── Update last seen ──────────────────────────────────────────────────────────
  /**
   * Ostatni znany adres HTTP Edge'a z bazy (tailnetowy — ustawiany ręcznie
   * przy instalacji obiektu albo z poprzednich połączeń tailnetowych).
   * Gateway sięga po niego, gdy WS przyszedł po publicznym internecie
   * i źródłowy adres nie nadaje się do HTTP.
   */
  async getStoredIp(deviceId: string): Promise<string | undefined> {
    const row = await this.prisma.edgeDevice
      .findUnique({ where: { id: deviceId }, select: { ipAddress: true } })
      .catch(() => null)
    return row?.ipAddress ?? undefined
  }

  async touch(deviceId: string, ipAddress?: string, version?: string) {
    // `ipAddress: undefined` = Prisma nie dotyka kolumny — dzięki temu
    // heartbeat bez adresu NIE kasuje ostatniego dobrego IP z bazy.
    await this.prisma.edgeDevice.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date(), ipAddress, version },
    }).catch(() => {})
  }

  // ── List edge devices for a building ─────────────────────────────────────────
  async listForBuilding(buildingId: number) {
    return this.prisma.edgeDevice.findMany({
      where: { buildingId },
      select: {
        id: true, type: true, name: true,
        isActivated: true, activatedAt: true,
        lastSeenAt: true, ipAddress: true, version: true,
        activationCode: true, activationCodeExpiresAt: true,
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  // ── Delete edge device ────────────────────────────────────────────────────────
  async remove(deviceId: string, adminId: number) {
    const device = await this.prisma.edgeDevice.findUnique({
      where: { id: deviceId },
      include: { building: true },
    })
    if (!device || device.building.adminId !== adminId) throw new NotFoundException()
    await this.prisma.edgeDevice.delete({ where: { id: deviceId } })
    return { deleted: true }
  }

  // ── Device tree proxy ─────────────────────────────────────────────────────────

  /** Resolve live Edge IP for a building (DB fallback when WS not connected) */
  async resolveEdgeIp(buildingId: number): Promise<string | null> {
    const edge = await this.prisma.edgeDevice.findFirst({
      where: { buildingId, isActivated: true },
      orderBy: { lastSeenAt: 'desc' },
    })
    return edge?.ipAddress ?? null
  }

  /** Fetch device tree from Edge and return it */
  async getDeviceTreeFromEdge(ip: string): Promise<any[]> {
    const res = await undiciFetch(`http://${ip}:4000/devices/tree`, {
      signal: AbortSignal.timeout(10_000),
      dispatcher: edgeDispatcher,
    })
    if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
    return res.json() as Promise<any[]>
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  /**
   * PR-1 (2026-07): entropia podniesiona z 8 → 12 znaków (Crockford-like
   * base32 bez O/0/I/1 — 32 znaki × 12 pozycji = 60 bitów). Stare kody
   * `GLEX-XXXX-XXXX` (40 bitów) pozostają WAŻNE — lookup w `activate()` idzie
   * po unikalnej kolumnie `activationCode`, format nie jest walidowany.
   * `rand[i] % 32` nie ma modulo-bias, bo 256 % 32 === 0.
   */
  private genCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const rand = randomBytes(12)
    let code = 'GLEX'
    for (let i = 0; i < 12; i++) {
      if (i % 4 === 0) code += '-'
      code += chars[rand[i] % chars.length]
    }
    return code // e.g. GLEX-A7B2-XK9R-M3TQ
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Faza B-2 (2026-05-13): Edge → Cloud sync urządzeń wizardem
  //
  //  Edge wysyła DEVICE_UPSERT / DEVICE_DELETE / DEVICE_SYNC_ALL przez WS
  //  tunnel. EdgeGateway przekazuje tu — my upsertujemy do `edge_device_mirror`.
  //  Source of truth = Edge sqlite; ten mirror jest TYLKO dla Cloud panelu BA.
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Upsert pojedynczego urządzenia. Idempotentne — wywołane wielokrotnie
   * z tym samym `deviceUuid` zaktualizuje config (np. po edycji w wizardzie).
   *
   * Raw SQL bo Prisma generate jest niespójny w monorepo (5.22 drift) i
   * `prisma.edgeDeviceMirror` typedClient może nie być znany po prosto-
   * generate na tej maszynie. Surowy SQL działa zawsze.
   */
  async mirrorUpsertDevice(opts: {
    buildingId: number
    edgeDeviceId: string         // cuid Cloud EdgeDevice (Mac Mini)
    deviceUuid: string           // UUID z Edge sqlite
    type: string
    driverId?: string | null
    config: Record<string, any>
  }): Promise<void> {
    // Faza B-4: init displayLabel z `config.name` przy INSERT. Przy ON CONFLICT
    // zachowujemy istniejący displayLabel (BA mógł go nadpisać przez panel) —
    // używamy COALESCE(stary, nowy) żeby Cloud nigdy nie wymazał BA-edytowanego
    // labela. labelUpdatedBy ustawiamy na 'edge-init' tylko gdy faktycznie
    // wstawiamy nowy (CASE WHEN labelUpdatedBy IS NULL).
    const initialLabel = typeof opts.config?.name === 'string' && opts.config.name.trim() !== ''
      ? opts.config.name.trim()
      : null
    await this.prisma.$executeRaw`
      INSERT INTO "edge_device_mirror"
        ("buildingId", "edgeDeviceId", "deviceUuid", "type", "driverId", "config",
         "displayLabel", "labelUpdatedBy", "labelUpdatedAt", "lastSyncedAt", "createdAt")
      VALUES
        (${opts.buildingId}, ${opts.edgeDeviceId}, ${opts.deviceUuid}, ${opts.type},
         ${opts.driverId ?? null}, ${JSON.stringify(opts.config)}::jsonb,
         ${initialLabel}, ${initialLabel ? 'edge-init' : null},
         ${initialLabel ? new Date() : null},
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("buildingId", "deviceUuid") DO UPDATE SET
        "edgeDeviceId" = EXCLUDED."edgeDeviceId",
        "type"         = EXCLUDED."type",
        "driverId"     = EXCLUDED."driverId",
        "config"       = EXCLUDED."config",
        -- displayLabel zostaje, gdy ktoś go już edytował (BA/Integrator). Jeśli
        -- był null (np. config bez .name) — przyjmujemy z nowego INSERT-a.
        "displayLabel"    = COALESCE("edge_device_mirror"."displayLabel", EXCLUDED."displayLabel"),
        "labelUpdatedBy"  = COALESCE("edge_device_mirror"."labelUpdatedBy", EXCLUDED."labelUpdatedBy"),
        "labelUpdatedAt"  = COALESCE("edge_device_mirror"."labelUpdatedAt", EXCLUDED."labelUpdatedAt"),
        "lastSyncedAt"    = CURRENT_TIMESTAMP
    `
    this.logger.debug(
      `Mirror upsert: building=${opts.buildingId} device=${opts.deviceUuid} type=${opts.type}`,
    )
  }

  /**
   * Faza B-4: nadpisuje displayLabel przez BA / Integrator panel. Edge sync nie
   * wpływa na ten field po pierwszym save (chroniony przez COALESCE w upsert).
   *
   * `updatedBy` to identyfikator źródła zmiany: `'building-admin'` lub
   * `'integrator'`. Audit przez `labelUpdatedAt`.
   *
   * Zwraca nowy displayLabel lub null jeśli urządzenia nie ma w mirror.
   */
  async setMirrorDisplayLabel(opts: {
    buildingId: number
    mirrorId: number
    displayLabel: string
    updatedBy: 'building-admin' | 'integrator'
  }): Promise<{ displayLabel: string } | null> {
    const trimmed = opts.displayLabel.trim()
    if (trimmed === '') {
      throw new BadRequestException('displayLabel nie może być pusty')
    }
    const updated = await this.prisma.$executeRaw`
      UPDATE "edge_device_mirror"
         SET "displayLabel"   = ${trimmed},
             "labelUpdatedBy" = ${opts.updatedBy},
             "labelUpdatedAt" = CURRENT_TIMESTAMP
       WHERE "id"         = ${opts.mirrorId}
         AND "buildingId" = ${opts.buildingId}
    `
    if (Number(updated) === 0) return null
    return { displayLabel: trimmed }
  }

  /** Usuwa wpis mirror (gdy user usunął device w wizardzie / panelu Edge). */
  async mirrorDeleteDevice(opts: { buildingId: number; deviceUuid: string }): Promise<void> {
    const count = await this.prisma.$executeRaw`
      DELETE FROM "edge_device_mirror"
       WHERE "buildingId" = ${opts.buildingId}
         AND "deviceUuid" = ${opts.deviceUuid}
    `
    this.logger.debug(
      `Mirror delete: building=${opts.buildingId} device=${opts.deviceUuid} (${count} rows)`,
    )
  }

  /**
   * Full-sync — Edge po reconnect WS wysyła listę WSZYSTKICH swoich urządzeń.
   *   1. Upsert każdego z listy (idempotent).
   *   2. Usuń te wpisy w mirror dla tego `edgeDeviceId`, których NIE ma już
   *      w nadesłanej liście (urządzenie zostało usunięte gdy Edge był
   *      offline → cloud nie dostał DEVICE_DELETE).
   *
   * Konsekwencja: jeśli Edge zostanie wymieniony (nowy Mac Mini, nowy cuid),
   * stare wpisy pozostaną w mirror dopóki ktoś manualnie ich nie usunie.
   * To celowe — chroni przed utratą widoczności przy chwilowych awariach
   * (gdy Edge stracił sqlite, ale Cloud dalej zna co tam było).
   */
  async mirrorSyncAll(opts: {
    buildingId: number
    edgeDeviceId: string
    devices: Array<{
      deviceUuid: string
      type: string
      driverId?: string | null
      config: Record<string, any>
    }>
  }): Promise<{ upserted: number; deleted: number }> {
    // 1. Upsert wszystkich
    for (const d of opts.devices) {
      await this.mirrorUpsertDevice({
        buildingId: opts.buildingId,
        edgeDeviceId: opts.edgeDeviceId,
        deviceUuid: d.deviceUuid,
        type: d.type,
        driverId: d.driverId ?? null,
        config: d.config,
      })
    }

    // 2. Cleanup brakujących: znajdź wpisy z tego edgeDeviceId których nie ma w liście
    const uuids = opts.devices.map((d) => d.deviceUuid)
    let deleted = 0
    if (uuids.length > 0) {
      deleted = await this.prisma.$executeRaw`
        DELETE FROM "edge_device_mirror"
         WHERE "buildingId"   = ${opts.buildingId}
           AND "edgeDeviceId" = ${opts.edgeDeviceId}
           AND "deviceUuid" NOT IN (${Prisma.join(uuids)})
      `
    } else {
      // Edge zgłosił 0 urządzeń → kasuj wszystkie dla tego edgeDeviceId
      deleted = await this.prisma.$executeRaw`
        DELETE FROM "edge_device_mirror"
         WHERE "buildingId"   = ${opts.buildingId}
           AND "edgeDeviceId" = ${opts.edgeDeviceId}
      `
    }

    this.logger.log(
      `Mirror sync-all: building=${opts.buildingId} edge=${opts.edgeDeviceId} ` +
      `upserted=${opts.devices.length} deleted=${deleted}`,
    )
    return { upserted: opts.devices.length, deleted: Number(deleted) }
  }
}
