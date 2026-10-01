import {
  Injectable,
  Logger,
  UnauthorizedException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Prisma } from '@prisma/client'
import * as crypto from 'crypto'
import { PrismaService } from '../prisma/prisma.service'
import { PushService } from '../push/push.service'
import { EdgeGateway } from '../edge/edge.gateway'
import { EdgeOutboxService } from '../edge/edge-outbox.service'
import { EdgeService } from '../edge/edge.service'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'

// Tailscale userspace HTTP proxy — pattern z resident.service / integrator.service.
// Cloud na Fly.io nie ma /dev/net/tun, więc tailscaled chodzi w userspace
// mode i routujemy ruch do Edge przez `localhost:1055`. Bez tego natywny
// fetch nie ma routingu do tailnetu.
const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined
import { MailService } from '../mail/mail.service'
import { getGuestsHistoryFor } from '../guest-events/guest-history.helper'
import { sortUnits, compareNatural } from '../common/natural-sort'
import { formatUnitLabel, unitLabelSql } from '../common/unit-label'
import { normalizeTicketPhoto } from '../common/ticket-photo'
import { findDriver, certifiedFor } from '@gatelynk/device-drivers'
import { StairwellIntercomDto } from '../buildings/buildings.service'
import { IntercomPhonebookController } from '../resident/intercom-phonebook.controller'
import {
  isObjectType,
  normalizeFeatures,
  type BuildingFeatures,
  type ObjectType,
} from '../buildings/buildings.constants'
import {
  hasPermission,
  normalizePermissions,
  flattenForRole,
  featKey,
  FEATURE_DISABLED_CODE,
  FEATURE_DISABLED_MESSAGE,
  type BuildingFeaturePermissions,
  type SystemFeature,
} from '../buildings/feature-permissions.constants'
import { IsArray, IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

export class BaCreateResidentDto {
  @IsString() firstName: string
  @IsString() lastName: string
  @IsEmail() email: string
  @IsOptional() @IsString() phone?: string
}

export class BaCreateUnitDto {
  @IsInt() unitTypeId: number
  @IsString() number: string
  @IsOptional() @IsInt() floor?: number
  @IsOptional() @IsNumber() areaSqm?: number
  @IsOptional() @IsString() description?: string
  @IsOptional() @IsInt() stairwellId?: number
}

export class BaCreateUnitTypeDto {
  @IsString() name: string
  @IsString() icon: string
  @IsOptional() @IsBoolean() isCommonArea?: boolean
}

export class BaUpsertCommonAreaSettingsDto {
  @IsOptional() @IsInt() maxSlotMinutes?: number
  @IsOptional() @IsString() openTime?: string
  @IsOptional() @IsString() closeTime?: string
  @IsOptional() @IsBoolean() isPaid?: boolean
  @IsOptional() @IsNumber() pricePerHour?: number
}

export class BaAssignResidentDto {
  @IsInt() residentId: number
  @IsString() role: 'OWNER' | 'TENANT'
  @IsDateString() sinceDate: string
}

export class BaSendNotificationDto {
  @IsString() title: string
  @IsString() body: string
  @IsOptional() @IsInt() residentId?: number
}

export class BaUpdateTicketStatusDto {
  @IsString() status: 'OPEN' | 'IN_PROGRESS' | 'DONE'
}

export class BaAddTicketReplyDto {
  @IsString() body: string
  // Zdjęcie w odpowiedzi (2026-08-13) — data-URI, walidacja w serwisie.
  @IsOptional() @IsString() photo?: string
}

// Faza 5 — punkty dostępu i urządzenia
//
// AccessPoint jest auto-syncowany z Edge co 5 min (`EdgeService.syncAccessPoints`).
// Admin nie może go usuwać ani tworzyć ręcznie — Edge wie najlepiej jakie ma
// przekaźniki. Może tylko: zmienić label/ikonę, zmienić sortOrder (drag-drop),
// toggle isActive (na liście rezydenta = ukrycie, ale Edge dalej obsługuje).
//
// Sync NIE nadpisuje już label/icon (tylko isActive + edgeDeviceId), żeby
// override-y admina były trwałe — patrz `edge.service.syncAccessPoints` po
// modyfikacji w Fazie 5.

export const ACCESS_POINT_ICONS = ['door', 'garage', 'gate', 'elevator', 'barrier'] as const
export type AccessPointIcon = typeof ACCESS_POINT_ICONS[number]

// Refactor 2026-06-01: scope wprowadza kontrolę widoczności AP.
// PUBLIC = każdy widzi i może otworzyć (np. furtka)
// RESIDENT = tylko mieszkańcy budynku
// ADMIN_ONLY = nie pokazywany w iOS apce, tylko BA może wystrzelić
export const ACCESS_POINT_SCOPES = ['PUBLIC', 'RESIDENT', 'ADMIN_ONLY'] as const
export type AccessPointScope = typeof ACCESS_POINT_SCOPES[number]

export class BaUpdateAccessPointDto {
  @IsOptional() @IsString() label?: string
  @IsOptional() @IsIn(ACCESS_POINT_ICONS) icon?: AccessPointIcon
  @IsOptional() @IsInt() sortOrder?: number
  @IsOptional() @IsBoolean() isActive?: boolean
  // Refactor 2026-06-01 — binding device→output:
  @IsOptional() @IsString() outputDeviceId?: string
  @IsOptional() @IsInt() outputIndex?: number
  @IsOptional() @IsInt() durationMs?: number
  @IsOptional() @IsIn(ACCESS_POINT_SCOPES) scope?: AccessPointScope
}

export class BaReorderAccessPointsDto {
  // Kolejność: lista id punktów w nowej kolejności od 0. Frontend wysyła to
  // po drag-drop, backend assignuje sortOrder = index w array.
  @IsArray() @IsInt({ each: true }) ids: number[]
}

// ── Grupy kontaktowe (2026-07-30) ────────────────────────────────────────────
//
// BA tworzy grupy (np. „Budynek 1", „ulica Komfortowa") i przypisuje lokale.
// Lokal należy do maks. 1 grupy (Unit.contactGroupId). Grupy trafiają na ekran
// domofonu Akuvox: E18C przez UserData.tgz (atrybut Group), R29 przez Remote
// Phonebook (format płaski → prefiks nazwy + sortowanie po grupie).

export class BaCreateContactGroupDto {
  @IsString() name: string
  @IsOptional() @IsInt() sortOrder?: number
}

export class BaUpdateContactGroupDto {
  @IsOptional() @IsString() name?: string
  @IsOptional() @IsInt() sortOrder?: number
}

export class BaSetContactGroupUnitsDto {
  // Replace-all: pełna lista id lokali które mają należeć do grupy. Lokale
  // spoza listy (a obecnie w grupie) są odpinane. Wzorzec cross-tenant guard
  // jak BaReorderAccessPointsDto.
  @IsArray() @IsInt({ each: true }) unitIds: number[]
}

// ── Access Point Schedules (cron, Refactor 2026-06-01) ──────────────────────
export class BaCreateAccessPointScheduleDto {
  @IsString() cronExpr: string
  @IsOptional() @IsString() label?: string
  @IsOptional() @IsBoolean() enabled?: boolean
}

export class BaUpdateAccessPointScheduleDto {
  @IsOptional() @IsString() cronExpr?: string
  @IsOptional() @IsString() label?: string
  @IsOptional() @IsBoolean() enabled?: boolean
}

// Allowed values for the `kind` field on DTOs. Kept in sync with the
// VehicleKind Postgres enum (see migration 20260424210000_add_vehicle_kind).
// We validate the string here instead of relying on Prisma's enum type
// because `prisma generate` isn't reliable in this monorepo (see CLAUDE.md).
export const VEHICLE_KINDS = ['RESIDENT', 'SERVICE', 'DELIVERY', 'EMERGENCY', 'PUBLIC'] as const
export type VehicleKindStr = typeof VEHICLE_KINDS[number]

// VehicleStatus enum (Postgres) — patrz migracja 20260430100000.
// Cykl życia pojazdu z fazy 1 bety: resident tworzy → PENDING → admin
// approve/reject. Tylko APPROVED jest synchronizowany do allowlisty LPR.
export const VEHICLE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'BLOCKED', 'EXPIRED'] as const
export type VehicleStatusStr = typeof VEHICLE_STATUSES[number]

// Akcje admina na pojeździe (PATCH .../status). Mapowanie do statusu:
//   approve → APPROVED  (+ addPlate do LPR)
//   reject  → REJECTED  (wymaga reason)
//   block   → BLOCKED   (- removePlate z LPR)
//   unblock → APPROVED  (+ addPlate do LPR)  — przywraca po BLOCKED
export const VEHICLE_STATUS_ACTIONS = ['approve', 'reject', 'block', 'unblock'] as const
export type VehicleStatusAction = typeof VEHICLE_STATUS_ACTIONS[number]

export class BaCreateVehicleDto {
  // `residentId` is optional because building-wide services (kind != RESIDENT)
  // have no owning resident. Service-level validation then ensures
  // RESIDENT cars always carry a residentId.
  @IsOptional() @IsInt() residentId?: number
  // 2026-09-07 — lokal (zamiast lub obok mieszkańca). RESIDENT: residentId LUB unitId.
  @IsOptional() @IsInt() unitId?: number | null
  @IsOptional() @IsIn(VEHICLE_KINDS) kind?: VehicleKindStr
  @IsString() make: string
  @IsOptional() @IsString() model?: string
  @IsString() color: string
  @IsString() licensePlate: string
  @IsOptional() @IsString() serviceName?: string
  @IsOptional() @IsString() notes?: string
  // Tagi opisowe — multi-select w UI. Wartości są free-form (sklasyfikowane
  // wg słownika w `apps/web/src/lib/vehicle-tags.ts`, ale backend nie waliduje).
  @IsOptional() @IsString({ each: true }) tags?: string[]
}

export class BaUpdateVehicleDto {
  @IsOptional() @IsInt() residentId?: number
  // undefined = bez zmian, null = odpięcie lokalu, liczba = nowy lokal.
  @IsOptional() @IsInt() unitId?: number | null
  @IsOptional() @IsIn(VEHICLE_KINDS) kind?: VehicleKindStr
  @IsOptional() @IsString() make?: string
  @IsOptional() @IsString() model?: string
  @IsOptional() @IsString() color?: string
  @IsOptional() @IsString() licensePlate?: string
  @IsOptional() @IsString() serviceName?: string
  @IsOptional() @IsString() notes?: string
  @IsOptional() @IsString({ each: true }) tags?: string[]
  // 2026-10-01 — przełącznik „otwieraj szlaban po rozpoznaniu tablicy" w panelu
  // (ten sam co w karcie pojazdu w iOS). false = tablica rozpoznawana, Edge
  // NIE wyzwala przekaźnika (reason auto_open_disabled).
  @IsOptional() @IsBoolean() autoOpen?: boolean
}

// PATCH /buildings/:id/vehicles/:vehicleId/status
//   action: approve | reject | block | unblock
//   reason: wymagany tylko gdy action = reject (powód odmowy widoczny dla
//           mieszkańca w iOS).
// Dlaczego osobny endpoint a nie POST/PATCH ogólny: chcemy oddzielić zmianę
// stanu (event-stylowa: aprovaval/rejection/blockada) od edycji danych pojazdu
// (literówka w tablicy, kolor itp.) — to dwa różne audity i dwie różne reakcje
// na LPR-sync (status zmienia allowlistę, edycja make/model nic nie robi).
export class BaUpdateVehicleStatusDto {
  @IsIn(VEHICLE_STATUS_ACTIONS) action: VehicleStatusAction
  @IsOptional() @IsString() reason?: string
}

@Injectable()
export class BuildingAdminService {
  private readonly logger = new Logger(BuildingAdminService.name)

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private push: PushService,
    private edgeGateway: EdgeGateway,
    private edgeOutbox: EdgeOutboxService,
    private edge: EdgeService,
    // MailService z @Global MailModule — używamy przy zapraszaniu gościa
    // (Cloud wysyła link do portalu przez Resend).
    private mail: MailService,
  ) {}

  // ── Auth ─────────────────────────────────────────────────────────────────
  async login(email: string, password: string) {
    const ba = await this.prisma.buildingAdmin.findUnique({
      where: { email },
      include: { buildings: { select: { buildingId: true } } },
    })
    if (!ba) throw new UnauthorizedException('Nieprawidłowy email lub hasło')
    const bcrypt = await import('bcrypt')
    const valid = await bcrypt.compare(password, ba.passwordHash)
    if (!valid) throw new UnauthorizedException('Nieprawidłowy email lub hasło')
    const buildingIds = ba.buildings.map((b) => b.buildingId)
    const payload = { sub: ba.id, email: ba.email, type: 'building-admin', buildingIds }
    return {
      access_token: this.jwtService.sign(payload),
      buildingAdmin: { id: ba.id, name: ba.name, email: ba.email, buildingIds },
    }
  }

  // ── Reset hasła przez link e-mail (2026-07-18) ───────────────────────────
  //
  // forgot-password ZAWSZE zwraca { ok: true } — bez enumeracji kont
  // (odpowiedź nie zdradza, czy email istnieje). Token: 32 losowe bajty hex,
  // w bazie tylko sha256, ważność 60 min, jednorazowy. Nowe żądanie
  // unieważnia poprzednie niewykorzystane tokeny tego konta.

  /** Throttle w pamięci — max 1 mail / 60 s per email (anty-spam). */
  private forgotPasswordLast = new Map<string, number>()

  async forgotPassword(rawEmail: string) {
    const email = (rawEmail ?? '').trim()
    if (!email) return { ok: true }

    const last = this.forgotPasswordLast.get(email.toLowerCase()) ?? 0
    if (Date.now() - last < 60_000) return { ok: true }
    this.forgotPasswordLast.set(email.toLowerCase(), Date.now())

    const ba =
      (await this.prisma.buildingAdmin.findUnique({ where: { email } })) ??
      (await this.prisma.buildingAdmin.findUnique({ where: { email: email.toLowerCase() } }))
    if (!ba) return { ok: true }

    const token = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const expiresAt = new Date(Date.now() + 60 * 60_000)

    await this.prisma.$executeRaw`
      UPDATE "password_reset_tokens" SET "usedAt" = NOW()
       WHERE "role" = 'BUILDING_ADMIN' AND "userId" = ${ba.id} AND "usedAt" IS NULL`
    await this.prisma.$executeRaw`
      INSERT INTO "password_reset_tokens" ("role", "userId", "tokenHash", "expiresAt")
      VALUES ('BUILDING_ADMIN', ${ba.id}, ${tokenHash}, ${expiresAt})`

    const baseUrl = (process.env.PANEL_BASE_URL ?? 'https://panel.gatelynk.com').replace(/\/+$/, '')
    const resetUrl = `${baseUrl}/building-admin/reset-password?token=${token}`
    void this.mail
      .sendPasswordReset({ toEmail: ba.email, name: ba.name, resetUrl })
      .then((r) => {
        if (!r.sent) this.logger.warn(`Password reset mail NOT sent (${r.reason}) for BA ${ba.id}`)
      })

    return { ok: true }
  }

  async resetPassword(token: string, password: string) {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Nieprawidłowy link resetu hasła.')
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new BadRequestException('Hasło musi mieć co najmniej 8 znaków.')
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const rows = await this.prisma.$queryRaw<{ id: number; userId: number }[]>`
      SELECT "id", "userId" FROM "password_reset_tokens"
       WHERE "tokenHash" = ${tokenHash} AND "role" = 'BUILDING_ADMIN'
         AND "usedAt" IS NULL AND "expiresAt" > NOW()
       LIMIT 1`
    if (!rows.length) {
      throw new BadRequestException('Link wygasł lub został już użyty. Poproś o nowy link resetu.')
    }

    const bcrypt = await import('bcrypt')
    const passwordHash = await bcrypt.hash(password, 10)
    await this.prisma.buildingAdmin.update({
      where: { id: rows[0].userId },
      data: { passwordHash },
    })
    await this.prisma.$executeRaw`
      UPDATE "password_reset_tokens" SET "usedAt" = NOW() WHERE "id" = ${rows[0].id}`

    return { ok: true }
  }

  // ── Me ────────────────────────────────────────────────────────────────────
  async getMe(baId: number) {
    const ba = await this.prisma.buildingAdmin.findUnique({
      where: { id: baId },
      include: { buildings: { select: { buildingId: true } } },
    })
    if (!ba) throw new NotFoundException()
    const buildingIds = ba.buildings.map((b) => b.buildingId)
    return { id: ba.id, name: ba.name, email: ba.email, buildingIds }
  }

  // ── Access guard helper ──────────────────────────────────────────────────
  private guardBuilding(buildingId: number, buildingIds: number[]) {
    if (!buildingIds.includes(buildingId)) throw new ForbiddenException()
  }

  // ── FAZA e (2026-06-02) — Feature permissions ─────────────────────────
  private async loadFeaturePermissions(buildingId: number): Promise<BuildingFeaturePermissions> {
    const rows = await this.prisma.$queryRaw<{ featurePermissions: unknown }[]>`
      SELECT "featurePermissions"
        FROM "buildings" WHERE id = ${buildingId} LIMIT 1
    `
    return normalizePermissions(rows[0]?.featurePermissions)
  }

  private async requireBaFeature(buildingId: number, feature: SystemFeature) {
    const perms = await this.loadFeaturePermissions(buildingId)
    if (!hasPermission(perms, 'ba', featKey(feature))) {
      throw new ForbiddenException({
        message: FEATURE_DISABLED_MESSAGE,
        code: FEATURE_DISABLED_CODE,
        feature,
      })
    }
  }

  // ── Budynki ──────────────────────────────────────────────────────────────
  /**
   * Portal wyboru obiektu (2026-07-18, wg PORTAL-HANDOFF.md) — jeden request
   * po loginie: powitanie (imię), lista obiektów admina z licznikami alertów
   * (otwarte zgłoszenia, sprawy w toku, zaległości, aktywni goście, pojazdy
   * PENDING) + sumy zbiorcze `totals` liczone backendowo.
   * Zaległość lokalu = ujemne saldo SUM(payment_entries.amount) — konwencja
   * ledgera: dodatnia kwota to wpłata, ujemna to obciążenie.
   */
  async getBuildingsOverview(adminId: number, buildingIds: number[]) {
    const ba = await this.prisma.buildingAdmin.findUnique({
      where: { id: adminId },
      select: { name: true },
    })
    const firstName = (ba?.name ?? '').trim().split(/\s+/)[0] ?? ''
    const empty = {
      admin: { firstName },
      properties: [] as unknown[],
      totals: { tickets: 0, inProgress: 0, overdueAmount: 0 },
    }
    if (!buildingIds.length) return empty

    const buildings = await this.prisma.building.findMany({
      where: { id: { in: buildingIds }, isArchived: false },
      select: {
        id: true,
        name: true,
        address: true,
        objectType: true,
        _count: { select: { units: true, residents: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
    const ids = buildings.map((b) => b.id)
    if (!ids.length) return empty

    const [ticketRows, pendingVehicles, activeGuests, arrears] = await Promise.all([
      this.prisma.ticket.groupBy({
        by: ['buildingId', 'status'],
        where: { buildingId: { in: ids }, status: { in: ['OPEN', 'IN_PROGRESS'] } },
        _count: { _all: true },
      }),
      this.prisma.vehicle.groupBy({
        by: ['buildingId'],
        where: { buildingId: { in: ids }, status: 'PENDING' },
        _count: { _all: true },
      }),
      this.prisma.guest.groupBy({
        by: ['buildingId'],
        where: { buildingId: { in: ids }, status: 'ACTIVE', validTo: { gt: new Date() } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ buildingId: number; arrears: number; unitsInArrears: number }[]>`
        SELECT s."buildingId",
               COALESCE(SUM(-s.saldo), 0)::float AS arrears,
               COUNT(*)::int                     AS "unitsInArrears"
          FROM (SELECT u."buildingId", pe."unitId", SUM(pe.amount) AS saldo
                  FROM payment_entries pe
                  JOIN units u ON u.id = pe."unitId"
                 WHERE u."buildingId" IN (${Prisma.join(ids)})
                 GROUP BY u."buildingId", pe."unitId") s
         WHERE s.saldo < 0
         GROUP BY s."buildingId"`,
    ])

    const toMap = (rows: { buildingId: number; _count: { _all: number } }[]) =>
      new Map(rows.map((r) => [r.buildingId, r._count._all]))
    const open = toMap(ticketRows.filter((r) => r.status === 'OPEN'))
    const inProg = toMap(ticketRows.filter((r) => r.status === 'IN_PROGRESS'))
    const pv = toMap(pendingVehicles)
    const ag = toMap(activeGuests)
    const ar = new Map(arrears.map((r) => [r.buildingId, r]))

    const properties = buildings.map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address,
      // Ostatni człon adresu do drzewa w rail ("Wilanów" z "…, Wilanów").
      district: b.address.split(',').slice(-1)[0]?.trim() ?? '',
      objectType: b.objectType,
      // Deterministyczny akcent koloru per obiekt (0-360) — stały między
      // renderami i sesjami, bez potrzeby kolumny w DB.
      hue: (b.id * 137) % 360,
      units: b._count.units,
      residents: b._count.residents,
      tickets: open.get(b.id) ?? 0,
      inProgress: inProg.get(b.id) ?? 0,
      overdueAmount: ar.get(b.id)?.arrears ?? 0,
      unitsInArrears: ar.get(b.id)?.unitsInArrears ?? 0,
      activeGuests: ag.get(b.id) ?? 0,
      pendingVehicles: pv.get(b.id) ?? 0,
    }))

    return {
      admin: { firstName },
      properties,
      totals: {
        tickets: properties.reduce((s, p) => s + p.tickets, 0),
        inProgress: properties.reduce((s, p) => s + p.inProgress, 0),
        overdueAmount: properties.reduce((s, p) => s + p.overdueAmount, 0),
      },
    }
  }

  /**
   * „Wyślij przypomnienia" z portalu — push + wpis w notifications dla
   * każdego AKTYWNEGO mieszkańca lokalu z ujemnym saldem, we wszystkich
   * budynkach admina. Idempotentne per dzień (wpisy notifications z
   * senderBaId robią jednocześnie audyt i blokadę ponownej wysyłki).
   */
  private static readonly ARREARS_REMINDER_TITLE = 'Przypomnienie o zaległości w opłatach'

  async sendArrearsReminders(adminId: number, buildingIds: number[]) {
    if (!buildingIds.length) return { sentTo: 0 }

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const already = await this.prisma.notification.findFirst({
      where: {
        senderBaId: adminId,
        title: BuildingAdminService.ARREARS_REMINDER_TITLE,
        sentAt: { gte: startOfDay },
      },
      select: { sentAt: true },
    })
    if (already) return { sentTo: 0, alreadySentAt: already.sentAt }

    const rows = await this.prisma.$queryRaw<
      { buildingId: number; unitId: number; unitNumber: string; saldo: number; residentId: number }[]
    >`
      SELECT s."buildingId", s."unitId", s."unitNumber", s.saldo::float AS saldo, ur."residentId"
        FROM (SELECT u."buildingId", u.id AS "unitId", u.number AS "unitNumber",
                     SUM(pe.amount) AS saldo
                FROM payment_entries pe
                JOIN units u ON u.id = pe."unitId"
               WHERE u."buildingId" IN (${Prisma.join(buildingIds)})
               GROUP BY u."buildingId", u.id, u.number) s
        JOIN unit_residents ur ON ur."unitId" = s."unitId"
             AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
       WHERE s.saldo < 0`

    if (!rows.length) return { sentTo: 0 }

    const plnFmt = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' })
    for (const r of rows) {
      const body = `Saldo opłat lokalu ${r.unitNumber} wynosi ${plnFmt.format(r.saldo)}. Prosimy o uregulowanie zaległości.`
      await this.prisma.notification.create({
        data: {
          buildingId: r.buildingId,
          residentId: r.residentId,
          title: BuildingAdminService.ARREARS_REMINDER_TITLE,
          body,
          senderBaId: adminId,
        },
      })
      void this.push
        .sendToResident(r.residentId, BuildingAdminService.ARREARS_REMINDER_TITLE, body, {
          kind: 'PAYMENT_REMINDER',
        })
        .catch(() => undefined)
    }
    this.logger.log(
      `Arrears reminders: BA ${adminId} sent ${rows.length} notification(s) across buildings [${buildingIds.join(',')}]`,
    )
    return { sentTo: rows.length }
  }

  async getBuildings(buildingIds: number[]) {
    return this.prisma.building.findMany({
      where: { id: { in: buildingIds }, isArchived: false },
      include: {
        stairwells: { orderBy: { createdAt: 'asc' } },
        _count: { select: { units: true, residents: true } },
      },
      orderBy: { createdAt: 'asc' },
    })
  }

  async getBuilding(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const building = await this.prisma.building.findFirst({
      where: { id: buildingId, isArchived: false },
      include: {
        stairwells: {
          orderBy: { createdAt: 'asc' },
          include: { intercom: true },
        },
        lprCameras: { orderBy: { id: 'asc' } },
      },
    })
    if (!building) throw new NotFoundException('Budynek nie istnieje')
    // 2026-06-02 (FAZA b) — zwracamy znormalizowany shape `objectType`+`features`.
    // BA panel v2 layout/sidebar conditional rendering opiera się na tym fieldzie.
    const objectType: ObjectType = isObjectType(building.objectType) ? building.objectType : 'BUILDING'
    const features = normalizeFeatures(
      objectType,
      (building.features as Partial<BuildingFeatures> | null) ?? null,
    )
    // FAZA e — spłaszczone permissions dla roli BA. Web layout v2 użyje tego
    // w `BuildingFeaturesContext` do conditional rendering tabów/sekcji.
    const featurePermissions = flattenForRole(
      await this.loadFeaturePermissions(buildingId),
      'ba',
    )
    return { ...building, objectType, features, featurePermissions }
  }

  async updateBranding(
    buildingId: number,
    buildingIds: number[],
    data: { logoBase64?: string | null; backgroundImageBase64?: string | null },
  ) {
    this.guardBuilding(buildingId, buildingIds)
    await this.requireBaFeature(buildingId, 'building_branding')
    return this.prisma.building.update({
      where: { id: buildingId },
      data,
    })
  }

  // ── Klatki schodowe ──────────────────────────────────────────────────────
  async getStairwellDetail(buildingId: number, stairwellId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const sw = await this.prisma.stairwell.findFirst({
      where: { id: stairwellId, buildingId },
      include: {
        intercom: true,
        units: { include: { unitType: true }, orderBy: { number: 'asc' } },
      },
    })
    if (!sw) throw new NotFoundException('Klatka nie istnieje')
    sortUnits(sw.units)
    return sw
  }

  async addStairwell(buildingId: number, buildingIds: number[], name: string) {
    this.guardBuilding(buildingId, buildingIds)
    return this.prisma.stairwell.create({ data: { buildingId, name } })
  }

  async updateStairwell(buildingId: number, stairwellId: number, buildingIds: number[], name: string) {
    this.guardBuilding(buildingId, buildingIds)
    const sw = await this.prisma.stairwell.findFirst({ where: { id: stairwellId, buildingId } })
    if (!sw) throw new NotFoundException('Klatka nie istnieje')
    return this.prisma.stairwell.update({ where: { id: stairwellId }, data: { name } })
  }

  async removeStairwell(buildingId: number, stairwellId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const sw = await this.prisma.stairwell.findFirst({ where: { id: stairwellId, buildingId } })
    if (!sw) throw new NotFoundException('Klatka nie istnieje')
    return this.prisma.stairwell.delete({ where: { id: stairwellId } })
  }

  // ── Domofon (read-only) ──────────────────────────────────────────────────
  async getStairwellIntercom(buildingId: number, stairwellId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const sw = await this.prisma.stairwell.findFirst({
      where: { id: stairwellId, buildingId },
      include: { intercom: true },
    })
    if (!sw) throw new NotFoundException('Klatka nie istnieje')
    return sw.intercom
  }

  // ── Typy lokali ──────────────────────────────────────────────────────────
  async getUnitTypes(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    return this.prisma.unitType.findMany({
      where: { OR: [{ buildingId }, { isSystem: true, buildingId: null }] },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    })
  }

  async createUnitType(buildingId: number, buildingIds: number[], dto: BaCreateUnitTypeDto) {
    this.guardBuilding(buildingId, buildingIds)
    const code = dto.name.toLowerCase().replace(/\s+/g, '_')
    const { isCommonArea, ...rest } = dto
    return this.prisma.unitType.create({
      data: { ...rest, code, buildingId, isSystem: false, isCommonArea: isCommonArea ?? false },
    })
  }

  // ── Lokale ───────────────────────────────────────────────────────────────
  async getUnits(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    // `orderBy` niżej daje stabilną bazę, ale sortuje TEKSTOWO („10/1" przed
    // „2/1"). Kolejność widoczną dla administratora ustala sortUnits().
    const units = await this.prisma.unit.findMany({
      where: { buildingId },
      include: {
        unitType: true,
        stairwell: true,
        commonAreaSettings: true,
        // 2026-07-21: lekka lista AKTYWNYCH przypisań — kolumna „Mieszkańcy"
        // w panelu BA liczy je bez drugiego requestu per lokal.
        unitResidents: {
          // Aktywne = bez daty końca LUB koniec w przyszłości (semantyka
          // jak wszędzie: untilDate IS NULL OR untilDate > NOW()).
          where: { OR: [{ untilDate: null }, { untilDate: { gt: new Date() } }] },
          select: { id: true, residentId: true },
        },
      },
      orderBy: { number: 'asc' },
    })
    return sortUnits(units)
  }

  async getUnit(unitId: number, buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const unit = await this.prisma.unit.findFirst({
      where: { id: unitId, buildingId },
      include: {
        unitType: true,
        stairwell: true,
        unitResidents: { include: { resident: true }, orderBy: { sinceDate: 'desc' } },
      },
    })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')
    return unit
  }

  async createUnit(buildingId: number, buildingIds: number[], dto: BaCreateUnitDto) {
    this.guardBuilding(buildingId, buildingIds)
    return this.prisma.unit.create({ data: { ...dto, buildingId }, include: { unitType: true } })
  }

  async updateUnit(unitId: number, buildingId: number, buildingIds: number[], dto: Partial<BaCreateUnitDto>) {
    this.guardBuilding(buildingId, buildingIds)
    const unit = await this.prisma.unit.findFirst({ where: { id: unitId, buildingId } })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')
    return this.prisma.unit.update({ where: { id: unitId }, data: dto, include: { unitType: true } })
  }

  async removeUnit(unitId: number, buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const unit = await this.prisma.unit.findFirst({ where: { id: unitId, buildingId } })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')
    return this.prisma.unit.delete({ where: { id: unitId } })
  }

  async assignResidentToUnit(buildingId: number, unitId: number, buildingIds: number[], dto: BaAssignResidentDto) {
    this.guardBuilding(buildingId, buildingIds)
    const unit = await this.prisma.unit.findFirst({
      where: { id: unitId, buildingId },
      include: { unitType: true },
    })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')
    if (unit.unitType.isCommonArea) {
      throw new BadRequestException('Nie można przypisać mieszkańca do części wspólnej')
    }
    return this.prisma.unitResident.create({
      data: { unitId, residentId: dto.residentId, role: dto.role, sinceDate: new Date(dto.sinceDate) },
      include: { resident: true },
    })
  }

  async removeResidentFromUnit(buildingId: number, assignmentId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    return this.prisma.unitResident.update({
      where: { id: assignmentId },
      data: { untilDate: new Date() },
    })
  }

  // ── Mieszkańcy ───────────────────────────────────────────────────────────
  async getResidents(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    return this.prisma.resident.findMany({
      where: { buildingId },
      include: {
        unitResidents: {
          where: { untilDate: null },
          include: { unit: { include: { unitType: true } } },
        },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    })
  }

  async getResident(residentId: number, buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const resident = await this.prisma.resident.findFirst({
      where: { id: residentId, buildingId },
      include: { unitResidents: { include: { unit: { include: { unitType: true } } } } },
    })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    return resident
  }

  async createResident(buildingId: number, buildingIds: number[], dto: BaCreateResidentDto) {
    this.guardBuilding(buildingId, buildingIds)
    const exists = await this.prisma.resident.findUnique({
      where: { buildingId_email: { buildingId, email: dto.email } },
    })
    if (exists) throw new ConflictException('Mieszkaniec z tym adresem email już istnieje')
    return this.prisma.resident.create({ data: { ...dto, buildingId } })
  }

  async updateResident(residentId: number, buildingId: number, buildingIds: number[], dto: Partial<BaCreateResidentDto>) {
    this.guardBuilding(buildingId, buildingIds)
    const resident = await this.prisma.resident.findFirst({ where: { id: residentId, buildingId } })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    return this.prisma.resident.update({ where: { id: residentId }, data: dto })
  }

  async updateResidentAvatar(residentId: number, buildingId: number, buildingIds: number[], avatarBase64: string | null) {
    this.guardBuilding(buildingId, buildingIds)
    const resident = await this.prisma.resident.findFirst({ where: { id: residentId, buildingId } })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    await this.prisma.$executeRaw`
      UPDATE residents SET "avatarBase64" = ${avatarBase64} WHERE id = ${residentId}
    `
    return { id: residentId, avatarBase64 }
  }

  async removeResident(residentId: number, buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const resident = await this.prisma.resident.findFirst({ where: { id: residentId, buildingId } })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    return this.prisma.resident.delete({ where: { id: residentId } })
  }

  async setResidentPassword(residentId: number, buildingId: number, buildingIds: number[], password: string) {
    this.guardBuilding(buildingId, buildingIds)
    const resident = await this.prisma.resident.findFirst({ where: { id: residentId, buildingId } })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    const bcrypt = await import('bcrypt')
    const passwordHash = await bcrypt.hash(password, 10)
    await this.prisma.resident.update({ where: { id: residentId }, data: { passwordHash } })
    return { success: true }
  }

  // ── Powiadomienia ────────────────────────────────────────────────────────
  async sendNotification(
    buildingId: number,
    buildingIds: number[],
    dto: BaSendNotificationDto,
    senderBaId?: number | null,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    // FAZA polish (f) — zapis senderBaId żeby historia broadcastów wiedziała
    // kto wysłał. Raw SQL bo Prisma client może mieć stale typing (drift).
    if (dto.residentId) {
      const resident = await this.prisma.resident.findFirst({ where: { id: dto.residentId, buildingId } })
      if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
      const [row] = await this.prisma.$queryRaw<{ id: number; sentAt: Date }[]>`
        INSERT INTO "notifications" ("buildingId", "residentId", "title", "body", "senderBaId")
        VALUES (${buildingId}, ${dto.residentId}, ${dto.title}, ${dto.body}, ${senderBaId ?? null})
        RETURNING id, "sentAt"
      `
      // Push to single resident. `notificationId` (2026-08-15) — tap w push
      // otwiera w apce ekran TEGO ogłoszenia (deep-link), nie tylko apkę.
      this.push.sendToResident(dto.residentId, dto.title, dto.body, {
        type: 'notification',
        notificationId: row.id,
      }).catch(() => {/* fire-and-forget */})
      return { id: row.id, sentAt: row.sentAt, residentId: dto.residentId, resident }
    }
    const residents = await this.prisma.resident.findMany({ where: { buildingId } })
    // Wspólny `sentAt` dla wszystkich notyfikacji w tym broadcast — dzięki temu
    // historia (`listNotifications`) potrafi je zgrupować jako jeden wpis.
    const sentAt = new Date()
    let inserted = 0
    if (residents.length > 0) {
      // jeden INSERT z VALUES dla wydajności
      await this.prisma.$transaction(
        residents.map((r) => this.prisma.$executeRaw`
          INSERT INTO "notifications" ("buildingId", "residentId", "title", "body", "sentAt", "senderBaId")
          VALUES (${buildingId}, ${r.id}, ${dto.title}, ${dto.body}, ${sentAt}, ${senderBaId ?? null})
        `),
      )
      inserted = residents.length
    }
    // Push to entire building
    this.push.sendToBuilding(buildingId, dto.title, dto.body, { type: 'notification' })
      .catch(() => {/* fire-and-forget */})
    return { sent: inserted, sentAt: sentAt.toISOString() }
  }

  /**
   * FAZA polish (f) — Historia broadcastów dla BA.
   *
   * Notyfikacje są zapisywane per-resident, więc broadcast do całego budynku
   * to N wierszy o tym samym `(title, body, senderBaId, sentAt)` (sentAt
   * ustawiamy explicit przy bulk INSERT). Grupujemy je przez `GROUP BY` i
   * zwracamy unikalne broadcast-y z licznikiem odbiorców.
   */
  async listNotifications(
    buildingId: number,
    buildingIds: number[],
    opts: { limit?: number; offset?: number; q?: string },
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
    const offset = Math.max(opts.offset ?? 0, 0)
    const q = opts.q?.trim() || null

    // Grupowanie: title+body+sentAt+senderBaId. ResidentId nie jest w GROUP BY,
    // bo broadcast trafia do wielu rezydentów.
    const rows = await this.prisma.$queryRaw<Array<{
      title: string
      body: string
      sentAt: Date
      senderBaId: number | null
      senderName: string | null
      recipients: bigint
      // Pojedynczy odbiorca? Wtedy też zwracamy jego nazwisko.
      singleResidentName: string | null
    }>>`
      SELECT
        n."title",
        n."body",
        n."sentAt",
        n."senderBaId",
        ba."name" AS "senderName",
        COUNT(*)::bigint AS recipients,
        CASE WHEN COUNT(*) = 1 THEN
          (SELECT trim(coalesce(r."firstName", '') || ' ' || coalesce(r."lastName", ''))
             FROM "residents" r WHERE r.id = MIN(n."residentId"))
        ELSE NULL END AS "singleResidentName"
      FROM "notifications" n
      LEFT JOIN "building_admins" ba ON ba.id = n."senderBaId"
      WHERE n."buildingId" = ${buildingId}
        ${q ? Prisma.sql`AND (n."title" ILIKE ${'%' + q + '%'} OR n."body" ILIKE ${'%' + q + '%'})` : Prisma.empty}
      GROUP BY n."title", n."body", n."sentAt", n."senderBaId", ba."name"
      ORDER BY n."sentAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `

    // Liczbę unikalnych broadcastów (do paginacji) policzmy oddzielnym query.
    const [totalRow] = await this.prisma.$queryRaw<Array<{ cnt: bigint }>>`
      SELECT COUNT(*)::bigint AS cnt FROM (
        SELECT 1 FROM "notifications" n
         WHERE n."buildingId" = ${buildingId}
           ${q ? Prisma.sql`AND (n."title" ILIKE ${'%' + q + '%'} OR n."body" ILIKE ${'%' + q + '%'})` : Prisma.empty}
         GROUP BY n."title", n."body", n."sentAt", n."senderBaId"
      ) g
    `

    // Suma wysłanych w bieżącym miesiącu — pokazuje stat card w UI.
    const [monthRow] = await this.prisma.$queryRaw<Array<{ cnt: bigint }>>`
      SELECT COUNT(*)::bigint AS cnt FROM (
        SELECT 1 FROM "notifications" n
         WHERE n."buildingId" = ${buildingId}
           AND n."sentAt" >= date_trunc('month', NOW())
         GROUP BY n."title", n."body", n."sentAt", n."senderBaId"
      ) g
    `

    return {
      items: rows.map((r) => ({
        title: r.title,
        body: r.body,
        sentAt: r.sentAt.toISOString(),
        senderBaId: r.senderBaId,
        senderName: r.senderName,
        recipients: Number(r.recipients),
        targetResidentName: r.singleResidentName,
      })),
      total: Number(totalRow?.cnt ?? 0n),
      monthCount: Number(monthRow?.cnt ?? 0n),
      limit,
      offset,
    }
  }

  // ── Kamery LPR (read-only) ───────────────────────────────────────────────
  async getLprCameras(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    return this.prisma.lprCamera.findMany({ where: { buildingId }, orderBy: { id: 'asc' } })
  }

  /**
   * 2026-06-02: Ustawia powiązanie kamery LPR z AccessPoint-em.
   *
   * Po refactorze access-points (2026-06-01) Edge `HikvisionLprService.handleAnprEvent`
   * przy match plate sprawdza w configu kamery `linkedAccessPointId`. Jeśli ustawione →
   * `accessPointExecutor.fire(apId, {trigger: 'LPR_MATCH'})` zamiast legacy hardcoded
   * `linkedIntercomDeviceId + linkedRelayIndex`.
   *
   * Flow:
   *   1. Walidacja: AP istnieje w tym budynku (lub null = unlink).
   *   2. Read full config z `edge_device_mirror`.
   *   3. Merge `{linkedAccessPointId: <id|null>}` w config JSON.
   *   4. Update mirror.config (sync UI od razu).
   *   5. Push `DEVICE_CONFIG_UPDATE` przez tunnel z pełnym configiem → Edge
   *      `store.setDeviceConfig` overwrite.
   *
   * Bez nowych typów tunnelu — używamy istniejącego DEVICE_CONFIG_UPDATE.
   */
  async setLprLinkedAccessPoint(
    buildingId: number,
    deviceUuid: string,
    accessPointId: number | null,
    buildingIds: number[],
  ) {
    this.guardBuilding(buildingId, buildingIds)

    // Walidacja AP (jeśli != null)
    if (accessPointId !== null) {
      const ap = await this.prisma.accessPoint.findFirst({
        where: { id: accessPointId, buildingId },
      })
      if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje w tym budynku')
    }

    // Mirror lookup
    const mirror = await this.prisma.edgeDeviceMirror.findFirst({
      where: { buildingId, deviceUuid, type: 'LPR_CAMERA' },
    })
    if (!mirror) throw new NotFoundException('Kamera LPR nie znaleziona w mirror')

    const currentConfig = (mirror.config as Record<string, unknown>) ?? {}
    const newConfig = {
      ...currentConfig,
      linkedAccessPointId: accessPointId,
    }

    // Update mirror config (UI source of truth po BA edit)
    await this.prisma.edgeDeviceMirror.update({
      where: { id: mirror.id },
      data: { config: newConfig as any, lastSyncedAt: new Date() },
    })

    // Push do Edge przez tunnel — istniejący handler `DEVICE_CONFIG_UPDATE`
    // przyjmuje {deviceId, type, config} → store.setDeviceConfig overwrite.
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

  // ── Ustawienia części wspólnych ───────────────────────────────────────────
  async upsertCommonAreaSettings(
    buildingId: number,
    unitId: number,
    buildingIds: number[],
    dto: BaUpsertCommonAreaSettingsDto,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const unit = await this.prisma.unit.findFirst({
      where: { id: unitId, buildingId },
      include: { unitType: true },
    })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')
    if (!unit.unitType.isCommonArea) {
      throw new BadRequestException('Ten lokal nie jest częścią wspólną')
    }
    return this.prisma.commonAreaSettings.upsert({
      where: { unitId },
      create: {
        unitId,
        maxSlotMinutes: dto.maxSlotMinutes ?? 60,
        openTime: dto.openTime ?? '08:00',
        closeTime: dto.closeTime ?? '22:00',
        isPaid: dto.isPaid ?? false,
        pricePerHour: dto.pricePerHour != null ? dto.pricePerHour : null,
      },
      update: {
        ...(dto.maxSlotMinutes != null && { maxSlotMinutes: dto.maxSlotMinutes }),
        ...(dto.openTime != null && { openTime: dto.openTime }),
        ...(dto.closeTime != null && { closeTime: dto.closeTime }),
        ...(dto.isPaid != null && { isPaid: dto.isPaid }),
        pricePerHour: dto.isPaid === false ? null : dto.pricePerHour != null ? dto.pricePerHour : undefined,
      },
    })
  }

  // ── Rezerwacje ────────────────────────────────────────────────────────────
  async getReservations(
    buildingId: number,
    buildingIds: number[],
    filters: { unitId?: number; date?: string; status?: string },
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const where: any = { buildingId }
    if (filters.unitId) where.unitId = filters.unitId
    if (filters.status === 'CONFIRMED' || filters.status === 'CANCELLED') where.status = filters.status
    if (filters.date) {
      const day = new Date(filters.date)
      const nextDay = new Date(day)
      nextDay.setDate(nextDay.getDate() + 1)
      where.startAt = { gte: day, lt: nextDay }
    }
    return this.prisma.reservation.findMany({
      where,
      include: {
        unit: { include: { unitType: true } },
        resident: true,
      },
      orderBy: { startAt: 'asc' },
    })
  }

  // ── Zgłoszenia mieszkańców (Tickets) ────────────────────────────────────
  async getTickets(buildingId: number, buildingIds: number[], status?: string) {
    this.guardBuilding(buildingId, buildingIds)
    const where: any = { buildingId }
    if (status === 'OPEN' || status === 'IN_PROGRESS' || status === 'DONE') {
      where.status = status
    }
    return this.prisma.ticket.findMany({
      where,
      include: {
        resident: true,
        replies: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    })
  }

  async updateTicketStatus(buildingId: number, ticketId: number, buildingIds: number[], dto: BaUpdateTicketStatusDto) {
    this.guardBuilding(buildingId, buildingIds)
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, buildingId } })
    if (!ticket) throw new NotFoundException('Zgłoszenie nie istnieje')
    return this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: dto.status },
      include: { resident: true, replies: { orderBy: { createdAt: 'asc' } } },
    })
  }

  async addTicketReply(buildingId: number, ticketId: number, buildingIds: number[], baId: number, dto: BaAddTicketReplyDto) {
    this.guardBuilding(buildingId, buildingIds)
    const ticket = await this.prisma.ticket.findFirst({ where: { id: ticketId, buildingId } })
    if (!ticket) throw new NotFoundException('Zgłoszenie nie istnieje')
    // Faza 4 — zapisujemy `authorId` żeby iOS mogło pokazać imię/avatar admina
    // przy bubble-u rozmowy. Raw SQL bo `authorId` to nowa kolumna a Prisma
    // Client jest broken (drift 5.22/7.5).
    const photoNorm = normalizeTicketPhoto(dto.photo)
    const [rep] = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "ticket_replies" ("ticketId", "authorType", "authorId", "body", "photo")
      VALUES (${ticketId}, 'ADMIN', ${baId}, ${dto.body}, ${photoNorm})
      RETURNING id
    `
    // Auto-move to IN_PROGRESS when BA replies to OPEN ticket
    if (ticket.status === 'OPEN') {
      await this.prisma.ticket.update({ where: { id: ticketId }, data: { status: 'IN_PROGRESS' } })
    }
    // Push notification to resident
    this.push.sendToResident(ticket.residentId, 'Odpowiedź na zgłoszenie', dto.body.slice(0, 100), {
      type: 'ticket_reply',
      ticketId: ticket.id,
    }).catch(() => {/* fire-and-forget */})
    return this.prisma.ticketReply.findUnique({ where: { id: rep.id } })
  }

  // ── Punkty dostępu (Faza 5) ───────────────────────────────────────────────
  //
  // Auto-sync z Edge co 5 min nadpisywałby override-y admina, dlatego sync
  // został zmodyfikowany (`edge.service.syncAccessPoints`) żeby przy update
  // NIE nadpisywać `label`/`icon`. Admin ma więc kontrolę nad nazwami w
  // panelu, a Edge dostarcza tylko strukturę (które device-y mają jakie
  // przekaźniki). Tworzenie/usuwanie nadal w gestii Edge.

  async listAccessPoints(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    return this.prisma.accessPoint.findMany({
      where: { buildingId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    })
  }

  async updateAccessPoint(
    buildingId: number,
    apId: number,
    buildingIds: number[],
    dto: BaUpdateAccessPointDto,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    // Refactor 2026-06-01 — accept binding/scope/duration. `outputDeviceId`
    // i `outputIndex` używane przez Edge OutputDriverRegistry; mogą wskazywać
    // dowolne urządzenie (Akuvox/Hikvision/LAN switch) niezależnie od pola
    // legacy `deviceId`/`relayIndex`.
    //
    // `durationMs` ograniczamy 100..30000 — defensive guard (Hikvision relay
    // > 30s = niezamierzone „hold-open"; preferowana ścieżka to dedykowany
    // hold-open endpoint).
    const dur = dto.durationMs !== undefined
      ? Math.max(100, Math.min(dto.durationMs, 30_000))
      : undefined
    const updated = await this.prisma.accessPoint.update({
      where: { id: apId },
      data: {
        label:     dto.label !== undefined     ? dto.label.trim() || ap.label : undefined,
        icon:      dto.icon !== undefined      ? dto.icon                     : undefined,
        sortOrder: dto.sortOrder !== undefined ? dto.sortOrder                : undefined,
        isActive:  dto.isActive !== undefined  ? dto.isActive                 : undefined,
        outputDeviceId: dto.outputDeviceId !== undefined ? dto.outputDeviceId : undefined,
        outputIndex:    dto.outputIndex    !== undefined ? dto.outputIndex    : undefined,
        durationMs:     dur                                                    ,
        scope:          dto.scope          !== undefined ? dto.scope          : undefined,
      },
    })

    // Push AP_UPSERT do Edge — broadcast do wszystkich Edge w budynku (jeden
    // budynek może mieć więcej Edge urządzeń, AP jest per-budynek).
    this.pushApUpsertToEdge(buildingId, updated)
      .catch(err => this.logger.warn(`AP_UPSERT push failed for ap#${apId}: ${err.message}`))

    return updated
  }

  /**
   * Wysyła AP_UPSERT do Edge przez tunel (outbox → WS). Fire-and-forget —
   * caller nie musi czekać. Outbox zapewnia retry po reconnect.
   */
  private async pushApUpsertToEdge(buildingId: number, ap: any): Promise<void> {
    await this.edgeGateway.sendToBuilding(buildingId, 'AP_UPSERT', {
      id: ap.id,
      buildingId: ap.buildingId,
      label: ap.label,
      icon: ap.icon,
      scope: ap.scope ?? 'RESIDENT',
      outputDeviceId: ap.outputDeviceId ?? null,
      outputIndex: ap.outputIndex ?? null,
      durationMs: ap.durationMs ?? 800,
      isActive: ap.isActive,
      sortOrder: ap.sortOrder ?? 0,
      // Legacy snapshot żeby Edge mógł fallback na intercom.execute.
      deviceId: ap.deviceId,
      relayIndex: ap.relayIndex,
    })
  }

  // ── Access Point Schedules (cron auto-open, Refactor 2026-06-01) ────────────

  async listAccessPointSchedules(buildingId: number, apId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId },
      select: { id: true },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')
    return this.prisma.$queryRaw<Array<{
      id: number; accessPointId: number; cronExpr: string;
      label: string | null; enabled: boolean; lastFiredAt: Date | null;
      createdAt: Date; updatedAt: Date;
    }>>`
      SELECT id, "accessPointId", "cronExpr", label, enabled, "lastFiredAt",
             "createdAt", "updatedAt"
        FROM "access_point_schedules"
       WHERE "accessPointId" = ${apId}
       ORDER BY id ASC
    `
  }

  async createAccessPointSchedule(
    buildingId: number,
    apId: number,
    buildingIds: number[],
    dto: BaCreateAccessPointScheduleDto,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    const cronExpr = (dto.cronExpr ?? '').trim()
    this.validateCron(cronExpr)
    const label = dto.label?.trim() || null
    const enabled = dto.enabled !== undefined ? dto.enabled : true

    // Raw SQL — Prisma drift (5.22/7.5, patrz CLAUDE.md). RETURNING * żeby od
    // razu mieć id i createdAt.
    const inserted = await this.prisma.$queryRaw<Array<{
      id: number; accessPointId: number; cronExpr: string;
      label: string | null; enabled: boolean;
    }>>`
      INSERT INTO "access_point_schedules"
        ("accessPointId", "cronExpr", label, enabled, "updatedAt")
      VALUES (${apId}, ${cronExpr}, ${label}, ${enabled}, CURRENT_TIMESTAMP)
      RETURNING id, "accessPointId", "cronExpr", label, enabled
    `
    const row = inserted[0]
    if (!row) throw new Error('Failed to create schedule (empty RETURNING)')

    // Push SCHEDULE_UPSERT do Edge — cron loop podchwyci w następnym ticku (<60s).
    this.edgeGateway
      .sendToBuilding(buildingId, 'SCHEDULE_UPSERT', {
        id: row.id,
        accessPointId: row.accessPointId,
        cronExpr: row.cronExpr,
        label: row.label,
        enabled: row.enabled,
      })
      .catch(err => this.logger.warn(`SCHEDULE_UPSERT push failed for #${row.id}: ${err.message}`))

    return row
  }

  async updateAccessPointSchedule(
    buildingId: number,
    scheduleId: number,
    buildingIds: number[],
    dto: BaUpdateAccessPointScheduleDto,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    // Walidacja cross-tenant: schedule musi należeć do AP w tym budynku.
    const existing = await this.prisma.$queryRaw<Array<{
      id: number; accessPointId: number; cronExpr: string;
      label: string | null; enabled: boolean; buildingId: number;
    }>>`
      SELECT s.id, s."accessPointId", s."cronExpr", s.label, s.enabled,
             ap."buildingId"
        FROM "access_point_schedules" s
        JOIN "access_points" ap ON ap.id = s."accessPointId"
       WHERE s.id = ${scheduleId}
       LIMIT 1
    `
    if (existing.length === 0 || existing[0].buildingId !== buildingId) {
      throw new NotFoundException('Harmonogram nie istnieje')
    }
    const cur = existing[0]
    const newCron = dto.cronExpr !== undefined ? dto.cronExpr.trim() : cur.cronExpr
    if (dto.cronExpr !== undefined) this.validateCron(newCron)
    const newLabel = dto.label !== undefined ? (dto.label.trim() || null) : cur.label
    const newEnabled = dto.enabled !== undefined ? dto.enabled : cur.enabled

    await this.prisma.$executeRaw`
      UPDATE "access_point_schedules"
         SET "cronExpr"  = ${newCron},
             label       = ${newLabel},
             enabled     = ${newEnabled},
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE id = ${scheduleId}
    `

    this.edgeGateway
      .sendToBuilding(buildingId, 'SCHEDULE_UPSERT', {
        id: scheduleId,
        accessPointId: cur.accessPointId,
        cronExpr: newCron,
        label: newLabel,
        enabled: newEnabled,
      })
      .catch(err => this.logger.warn(`SCHEDULE_UPSERT push failed for #${scheduleId}: ${err.message}`))

    return {
      id: scheduleId,
      accessPointId: cur.accessPointId,
      cronExpr: newCron,
      label: newLabel,
      enabled: newEnabled,
    }
  }

  async deleteAccessPointSchedule(
    buildingId: number,
    scheduleId: number,
    buildingIds: number[],
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const existing = await this.prisma.$queryRaw<Array<{ id: number; buildingId: number }>>`
      SELECT s.id, ap."buildingId"
        FROM "access_point_schedules" s
        JOIN "access_points" ap ON ap.id = s."accessPointId"
       WHERE s.id = ${scheduleId}
       LIMIT 1
    `
    if (existing.length === 0 || existing[0].buildingId !== buildingId) {
      throw new NotFoundException('Harmonogram nie istnieje')
    }
    await this.prisma.$executeRaw`
      DELETE FROM "access_point_schedules" WHERE id = ${scheduleId}
    `
    this.edgeGateway
      .sendToBuilding(buildingId, 'SCHEDULE_DELETE', { id: scheduleId })
      .catch(err => this.logger.warn(`SCHEDULE_DELETE push failed for #${scheduleId}: ${err.message}`))
    return { deleted: true }
  }

  /**
   * Test pulse — admin klika „🔧 Test" w panelu BA. Wysyłamy AP_TEST_FIRE
   * przez tunel; Edge wywołuje executor.fire(apId, {trigger:'MANUAL',
   * actor:'ADMIN_TEST'}). Wrapper opcjonalnie czeka kilka sekund na ACK,
   * ale fire-and-forget jest też OK — operator słyszy/widzi czy zaskoczyło.
   */
  async testFireAccessPoint(
    buildingId: number,
    apId: number,
    buildingIds: number[],
    baId: number,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    await this.edgeGateway.sendToBuilding(buildingId, 'AP_TEST_FIRE', {
      apId: ap.id,
      actor: `ADMIN_TEST:${baId}`,
      meta: { source: 'ADMIN_TEST' },
    })

    // Audyt — MANUAL_OPEN z meta `source: 'admin-test'`. Edge audytuje też
    // own ACCESS_POINT_FIRED event, ale gateOpened wymagałoby ACK round-trip.
    // Tutaj zapisujemy „polecenie wydane".
    this.prisma.$executeRaw`
      INSERT INTO "access_events" ("buildingId", type, "accessPointId", "gateOpened",
                                   "openedById", "openedByType", meta, ts, "createdAt")
      VALUES (${buildingId}, 'MANUAL_OPEN'::"AccessEventType", ${ap.id}, true,
              ${baId}, 'ADMIN',
              ${JSON.stringify({ source: 'admin-test' })}::jsonb,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `.catch(() => { /* audit fail-silent */ })

    return { success: true, apId: ap.id, label: ap.label }
  }

  /**
   * Validate cron expression — używamy cron-parser. Throws BadRequest gdy
   * pierwszy `parseExpression` exception.
   */
  private validateCron(cronExpr: string): void {
    if (!cronExpr || cronExpr.length === 0) {
      throw new BadRequestException('cronExpr jest wymagany')
    }
    try {
      // Lazy require — żeby nie wymuszać builda gdy chcemy tylko dotknąć
      // BA endpointów bez funkcjonalności schedules. cron-parser jest mały.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { parseExpression } = require('cron-parser')
      parseExpression(cronExpr)
    } catch (err: any) {
      throw new BadRequestException(`Nieprawidłowy cron: ${err.message}`)
    }
  }

  async reorderAccessPoints(
    buildingId: number,
    buildingIds: number[],
    dto: BaReorderAccessPointsDto,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    // Walidujemy że wszystkie id-y należą do tego budynku — prevent cross-tenant
    // reorder gdyby ktoś wstrzyknął cudze id.
    const owned = await this.prisma.accessPoint.findMany({
      where: { id: { in: dto.ids }, buildingId },
      select: { id: true },
    })
    if (owned.length !== dto.ids.length) {
      throw new BadRequestException('Lista zawiera punkty z innego budynku')
    }
    // Bulk update przez transakcję — `sortOrder = idx`. Nie używamy raw SQL
    // bo Prisma `accessPoint.update` jest dostępne (model był w schemie od dawna).
    await this.prisma.$transaction(
      dto.ids.map((id, idx) =>
        this.prisma.accessPoint.update({
          where: { id },
          data: { sortOrder: idx },
        }),
      ),
    )
    return this.listAccessPoints(buildingId, buildingIds)
  }

  // ── Grupy kontaktowe (2026-07-30) ─────────────────────────────────────────
  //
  // Typed Prisma Client (post-Faza 7.1). Zwracamy grupy z lokalami + osobno
  // lokale bez grupy — UI pokazuje jedno i drugie z jednego GET-a.

  async listContactGroups(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const [groups, unassigned] = await Promise.all([
      this.prisma.contactGroup.findMany({
        where: { buildingId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: {
          units: {
            select: { id: true, number: true, street: true },
            orderBy: { number: 'asc' },
          },
        },
      }),
      this.prisma.unit.findMany({
        where: { buildingId, contactGroupId: null },
        select: { id: true, number: true, street: true },
        orderBy: { number: 'asc' },
      }),
    ])
    // Kolejność z tej listy trafia wprost na wyświetlacz domofonu — musi być
    // taka, jak gość spodziewa się jej szukać (1, 2, 3… a nie 1, 10, 11, 2).
    groups.forEach((g) => sortUnits(g.units))
    return { groups, unassignedUnits: sortUnits(unassigned) }
  }

  async createContactGroup(
    buildingId: number,
    buildingIds: number[],
    dto: BaCreateContactGroupDto,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const name = dto.name?.trim()
    if (!name) throw new BadRequestException('Nazwa grupy nie może być pusta')
    const existing = await this.prisma.contactGroup.findFirst({
      where: { buildingId, name },
      select: { id: true },
    })
    if (existing) throw new ConflictException('Grupa o tej nazwie już istnieje')
    // Default sortOrder = na końcu listy.
    let sortOrder = dto.sortOrder
    if (sortOrder === undefined) {
      const max = await this.prisma.contactGroup.aggregate({
        where: { buildingId },
        _max: { sortOrder: true },
      })
      sortOrder = (max._max.sortOrder ?? -1) + 1
    }
    return this.prisma.contactGroup.create({
      data: { buildingId, name, sortOrder },
    })
  }

  async updateContactGroup(
    buildingId: number,
    buildingIds: number[],
    groupId: number,
    dto: BaUpdateContactGroupDto,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    await this.requireContactGroup(buildingId, groupId)
    const data: { name?: string; sortOrder?: number } = {}
    if (dto.name !== undefined) {
      const name = dto.name.trim()
      if (!name) throw new BadRequestException('Nazwa grupy nie może być pusta')
      const dup = await this.prisma.contactGroup.findFirst({
        where: { buildingId, name, id: { not: groupId } },
        select: { id: true },
      })
      if (dup) throw new ConflictException('Grupa o tej nazwie już istnieje')
      data.name = name
    }
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder
    return this.prisma.contactGroup.update({ where: { id: groupId }, data })
  }

  /** Usunięcie grupy — lokale wracają do „bez grupy" (FK ON DELETE SET NULL). */
  async deleteContactGroup(buildingId: number, buildingIds: number[], groupId: number) {
    this.guardBuilding(buildingId, buildingIds)
    await this.requireContactGroup(buildingId, groupId)
    await this.prisma.contactGroup.delete({ where: { id: groupId } })
    return { ok: true }
  }

  /**
   * Replace-all przypisania lokali do grupy: lokale z `unitIds` dostają
   * contactGroupId=groupId, lokale obecnie w grupie a spoza listy — NULL.
   * Lokal może być w maks. 1 grupie, więc przypisanie „kradnie" lokal z innej
   * grupy (jawnie widoczne w UI — checkbox pokazuje obecną grupę lokalu).
   */
  async setContactGroupUnits(
    buildingId: number,
    buildingIds: number[],
    groupId: number,
    dto: BaSetContactGroupUnitsDto,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    await this.requireContactGroup(buildingId, groupId)
    // Cross-tenant guard: wszystkie unitIds muszą należeć do TEGO budynku
    // (wzorzec BaReorderAccessPointsDto).
    const ids = [...new Set(dto.unitIds)]
    if (ids.length > 0) {
      const owned = await this.prisma.unit.findMany({
        where: { id: { in: ids }, buildingId },
        select: { id: true },
      })
      if (owned.length !== ids.length) {
        throw new BadRequestException('Lista zawiera lokale z innego budynku')
      }
    }
    await this.prisma.$transaction([
      // Odpięcie lokali które wypadły z grupy.
      this.prisma.unit.updateMany({
        where: { buildingId, contactGroupId: groupId, id: { notIn: ids } },
        data: { contactGroupId: null },
      }),
      // Przypięcie listy (idempotentne dla już przypiętych).
      ...(ids.length > 0
        ? [
            this.prisma.unit.updateMany({
              where: { buildingId, id: { in: ids } },
              data: { contactGroupId: groupId },
            }),
          ]
        : []),
    ])
    return this.listContactGroups(buildingId, buildingIds)
  }

  private async requireContactGroup(buildingId: number, groupId: number) {
    const group = await this.prisma.contactGroup.findFirst({
      where: { id: groupId, buildingId },
      select: { id: true },
    })
    if (!group) throw new NotFoundException('Grupa nie istnieje w tym budynku')
    return group
  }

  /**
   * Dane do sekcji „Synchronizacja z domofonem" w panelu BA: token Remote
   * Phonebook (R29) + LAN IP Edge-a (parametr `host` w URL-u). Pełny URL
   * składa frontend ze swojego API base (NEXT_PUBLIC_API_URL).
   */
  async getIntercomPhonebookInfo(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const edge = await this.prisma.edgeDevice.findFirst({
      where: { buildingId, isActivated: true },
      orderBy: { lastSeenAt: 'desc' },
      select: { ipAddress: true },
    })
    return {
      buildingId,
      token: IntercomPhonebookController.tokenFor(buildingId),
      path: '/intercom/phonebook',
      edgeLanIp: edge?.ipAddress ?? null,
    }
  }

  // ── Urządzenia (Faza 5) ───────────────────────────────────────────────────
  //
  // Lista wszystkich urządzeń w budynku (Edge + Intercom + LprCamera) z live
  // status z `EdgeGateway.isOnline()`. Status sprawdzamy O(1) przez WS connection
  // map — nie odpytujemy bazy ani urządzeń. `lastSeenAt` z bazy jako fallback
  // (kiedy Edge ostatnio się odzywał — dla case'u gdy WS chwilowo offline).

  async listDevices(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)

    // Intercom + camera: raw SQL, bo Prisma Client nie zna `edgeDeviceId`
    // przez drift 5.22/7.5 (patrz CLAUDE.md). EdgeDevice działa przez Client
    // bo był od dawna w schema-ie.
    type IntercomRow = {
      id: number; name: string; model: string | null; ipAddress: string | null;
      edgeDeviceId: string | null; createdAt: Date; updatedAt: Date;
    }
    type CameraRow = {
      id: number; name: string; manufacturer: string; model: string | null;
      ipAddress: string | null; edgeDeviceId: string | null;
      whitelistMode: string; updatedAt: Date;
    }
    // Faza B-2 (2026-05-13): dorzucamy `mirrorDevices` z `edge_device_mirror` —
    // to jest source-of-truth widoku urządzeń (Edge sqlite → push przez WS).
    // Stare tabele `building_intercoms`/`lpr_cameras` zostają jako legacy:
    //   • backfill migracji 20260513120000 skopiował je już do mirror,
    //   • UI panelu BA może pokazywać oba widoki w okresie przejściowym.
    type MirrorRow = {
      id: number; deviceUuid: string; edgeDeviceId: string | null;
      type: string; driverId: string | null; config: any;
      displayLabel: string | null; labelUpdatedBy: string | null; labelUpdatedAt: Date | null;
      lastSyncedAt: Date; createdAt: Date;
    }
    const [edges, intercoms, cameras, mirrorDevices] = await Promise.all([
      this.prisma.edgeDevice.findMany({
        where: { buildingId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.$queryRaw<IntercomRow[]>`
        SELECT id, name, model, "ipAddress", "edgeDeviceId", "createdAt", "updatedAt"
          FROM "building_intercoms"
         WHERE "buildingId" = ${buildingId}
         ORDER BY id ASC
      `,
      this.prisma.$queryRaw<CameraRow[]>`
        SELECT id, name, manufacturer, model, "ipAddress", "edgeDeviceId",
               "whitelistMode", "updatedAt"
          FROM "lpr_cameras"
         WHERE "buildingId" = ${buildingId}
         ORDER BY id ASC
      `,
      this.prisma.$queryRaw<MirrorRow[]>`
        SELECT id, "deviceUuid", "edgeDeviceId", "type", "driverId",
               "config", "displayLabel", "labelUpdatedBy", "labelUpdatedAt",
               "lastSyncedAt", "createdAt"
          FROM "edge_device_mirror"
         WHERE "buildingId" = ${buildingId}
         ORDER BY "type", "createdAt" ASC
      `,
    ])

    // Live status — z WS map. Edge online → wszystkie jego intercom-y/kamery
    // też uznajemy za reachable (bo do nich gada przez LAN).
    const onlineEdgeIds = new Set<string>()
    for (const e of edges) {
      if (this.edgeGateway.isOnline(e.id)) onlineEdgeIds.add(e.id)
    }

    // Faza 7.6 — count pending/failed outbox entries per Edge. UI używa tego
    // do badge "X pending" / alertu "X failed" na devices page.
    const outboxStats = await this.edgeOutbox.statsForBuilding(buildingId)

    return {
      edges: edges.map((e) => ({
        ...e,
        online: onlineEdgeIds.has(e.id),
        outbox: outboxStats.get(e.id) ?? { pending: 0, failed: 0 },
      })),
      intercoms: intercoms.map((i) => ({
        ...i,
        // Domofon „online" = jego Edge online (LAN reachable).
        online: i.edgeDeviceId ? onlineEdgeIds.has(i.edgeDeviceId) : false,
      })),
      cameras: cameras.map((c) => {
        // 2026-06-02 — dodajemy deviceUuid + linkedAccessPointId z mirror.
        // `lpr_cameras` (legacy table) ma `ipAddress` ale brak UUID Edge-side;
        // wiązanie po `ipAddress` jest fragile — używamy mirror.config.ipAddress
        // jako matcher. W przyszłości warto dodać kolumnę `deviceUuid` do
        // `lpr_cameras` przy migracji legacy.
        const mirror = mirrorDevices.find((m) => {
          if (m.type !== 'LPR_CAMERA') return false
          const cfg = (m.config as any) ?? {}
          return cfg.ipAddress === c.ipAddress
        })
        const linkedAccessPointId = mirror
          ? ((mirror.config as any)?.linkedAccessPointId ?? null)
          : null
        return {
          ...c,
          online: c.edgeDeviceId ? onlineEdgeIds.has(c.edgeDeviceId) : false,
          deviceUuid: mirror?.deviceUuid ?? null,
          linkedAccessPointId,
        }
      }),
      // Wszystkie urządzenia widziane przez Edge (intercom + camera + lpr +
      // shelly + knx + …) — pełny widok z Edge sqlite. Sekcja „Mirror" w BA
      // panelu konsumuje to (faza B-3). Wzbogacone o `driver` (label, icon,
      // manufacturer, certyfikacja) z `@gatelynk/device-drivers` żeby UI nie
      // musiał osobno fetchować katalogu driverów.
      mirrorDevices: mirrorDevices.map((m) => {
        const driver = m.driverId ? findDriver(m.driverId) : null
        const model = (m.config as any)?.model as string | undefined
        // Cert per model: jeśli config ma `model` i driver ma wpisy w `CERTIFIED`,
        // sprawdzamy konkretne dopasowanie. Inaczej spada do `driver.certification`.
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
          // Faza B-4 — nazwa wyświetlana (BA edytuje inline). Fallback dla
          // legacy wpisów bez displayLabel: config.name.
          displayLabel: m.displayLabel ?? (m.config as any)?.name ?? null,
          labelUpdatedBy: m.labelUpdatedBy,
          labelUpdatedAt: m.labelUpdatedAt,
          lastSyncedAt: m.lastSyncedAt,
          createdAt: m.createdAt,
          online: m.edgeDeviceId ? onlineEdgeIds.has(m.edgeDeviceId) : false,
          // Wzbogacenie z katalogu driverów — żeby UI miało wszystko w jednym responsie.
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

  /**
   * „Ping" Edge — wysłanie krótkiego CMD i sprawdzenie czy WS jest open.
   * Synchroniczna odpowiedź: { online, lastSeenAt }. Frontend pokazuje toast.
   * Bez czekania na pong z Edge — to wymagałoby request/response przez WS,
   * a Edge tego dziś nie obsługuje. Zamiast tego zwracamy live `isOnline`
   * z gateway-a (poll).
   */
  /**
   * Faza B-4 (2026-05-14): zmiana display label dla urządzenia w mirror.
   * Hierarchia: BA może nadpisać label nadany przez Edge (`config.name`) lub
   * Integratora. Zmiana audytowana przez `labelUpdatedBy='building-admin'` +
   * `labelUpdatedAt`. Kolejne `DEVICE_UPSERT` z Edge **nie** wymażą BA-edytowanej
   * wartości (logic w `EdgeService.mirrorUpsertDevice`).
   */
  async updateDeviceDisplayLabel(
    buildingId: number,
    mirrorId: number,
    displayLabel: string,
    buildingIds: number[],
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const result = await this.edge.setMirrorDisplayLabel({
      buildingId,
      mirrorId,
      displayLabel,
      updatedBy: 'building-admin',
    })
    if (!result) throw new NotFoundException('Urządzenie nie istnieje w mirror')
    return result
  }

  /**
   * Faza F-2.3 (2026-05-14): HOLD_OPEN dla konkretnego AccessPoint-u.
   *
   * Wzorzec: tak jak `resident.openAccessPoint` — HTTP bezpośrednio do Edge
   * przez Tailscale, NIE przez tunel WS. Powód:
   *   • HOLD_OPEN to synchroniczna akcja użytkownika (kurier u bramy)
   *   • outbox WS by retry-ował komendę po reconnect, ale wtedy kurier dawno
   *     odjechał — preferujemy natychmiastowy 502 zamiast „przyjdzie później"
   *
   * Edge endpoint: `POST /devices/:deviceId/hold-open` body `{ seconds, doorIndex }`.
   * Edge clampuje seconds do `driver.constants.holdOpenMaxSeconds` (default 600).
   */
  /**
   * Overview deck (2026-07-20) — pojedyncze otwarcie wejścia z panelu BA
   * (odpowiednik kafla „Dostęp" z apki mieszkańca). Audyt: REMOTE_OPEN,
   * openedByType='ADMIN', meta.source='ba-panel'.
   */
  async openAccessPointNow(
    buildingId: number,
    accessPointId: number,
    buildingIds: number[],
    baId: number,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: accessPointId, buildingId, isActive: true },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    let ip: string | undefined = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      const edge = await this.prisma.edgeDevice.findFirst({
        where: { buildingId, isActivated: true },
        orderBy: { lastSeenAt: 'desc' },
      })
      ip = edge?.ipAddress ?? undefined
    }
    if (!ip) throw new BadGatewayException('Brak połączenia z bramką — spróbuj ponownie')

    const isUnitDoor = ap.category === 'UNIT_DOOR'
    try {
      const res = await undiciFetch(
        `http://${ip}:4000/devices/${ap.deviceId}/relay/${ap.relayIndex}`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(isUnitDoor ? 12_000 : 8000),
          dispatcher: edgeDispatcher,
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      this.prisma.$executeRaw`
        INSERT INTO "access_events" ("buildingId", type, "accessPointId", "gateOpened",
                                     "openedById", "openedByType", meta, ts, "createdAt")
        VALUES (${buildingId}, 'REMOTE_OPEN'::"AccessEventType", ${ap.id}, true,
                ${baId}, 'ADMIN', ${JSON.stringify({ source: 'ba-panel' })}::jsonb,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `.catch(() => { /* audit fail-silent */ })

      return { success: true, label: ap.label }
    } catch {
      this.prisma.$executeRaw`
        INSERT INTO "access_events" ("buildingId", type, "accessPointId", "gateOpened",
                                     "openedById", "openedByType", meta, ts, "createdAt")
        VALUES (${buildingId}, 'REMOTE_OPEN'::"AccessEventType", ${ap.id}, false,
                ${baId}, 'ADMIN', ${JSON.stringify({ source: 'ba-panel', error: true })}::jsonb,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `.catch(() => { /* audit fail-silent */ })
      throw new BadGatewayException('Nie udało się otworzyć — spróbuj ponownie')
    }
  }

  /**
   * Overview deck — podgląd z kamery domofonu danego wejścia. Kopia wzorca
   * resident `pipeSnapshot` (JSON wrapper z Edge → binarne JPEG), z guardem
   * po buildingIds admina.
   */
  async pipeApSnapshot(
    buildingId: number,
    accessPointId: number,
    buildingIds: number[],
    res: import('express').Response,
    live = true,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: accessPointId, buildingId, isActive: true },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    let ip: string | undefined = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      const edge = await this.prisma.edgeDevice.findFirst({
        where: { buildingId, isActivated: true },
        orderBy: { lastSeenAt: 'desc' },
      })
      ip = edge?.ipAddress ?? undefined
    }
    if (!ip) throw new BadGatewayException('Edge niedostępny')

    try {
      const edgeUrl = `http://${ip}:4000/devices/${ap.deviceId}/snapshot${live ? '?live=1' : ''}`
      const edgeRes = await undiciFetch(edgeUrl, {
        signal: AbortSignal.timeout(5000),
        dispatcher: edgeDispatcher,
      })
      if (!edgeRes.ok) throw new Error(`Edge snapshot HTTP ${edgeRes.status}`)

      const contentType = edgeRes.headers.get('content-type') ?? ''
      const rawBuf = Buffer.from(await edgeRes.arrayBuffer())
      let buf: Buffer
      const looksLikeJson = contentType.includes('application/json') ||
                            contentType.includes('text/') ||
                            rawBuf[0] === 0x7b
      if (looksLikeJson) {
        try {
          const json = JSON.parse(rawBuf.toString('utf8')) as { snapshot?: string }
          const dataUri = json.snapshot ?? ''
          const commaIdx = dataUri.indexOf(',')
          const b64 = commaIdx >= 0 ? dataUri.slice(commaIdx + 1) : dataUri
          buf = Buffer.from(b64, 'base64')
        } catch {
          buf = rawBuf
        }
      } else {
        buf = rawBuf
      }

      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'no-store, no-cache')
      res.setHeader('Content-Length', buf.length)
      res.end(buf)
    } catch (err: any) {
      throw new BadGatewayException(`Snapshot niedostępny: ${err.message}`)
    }
  }

  async holdOpenAccessPoint(
    buildingId: number,
    accessPointId: number,
    seconds: number,
    buildingIds: number[],
    baId: number,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    if (typeof seconds !== 'number' || seconds < 5 || seconds > 3600) {
      throw new BadRequestException('Czas musi być w zakresie 5-3600 sek')
    }

    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: accessPointId, buildingId, isActive: true },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    // Resolve Edge IP — live WS connection first, DB fallback.
    let ip: string | undefined = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      const edge = await this.prisma.edgeDevice.findFirst({
        where: { buildingId, isActivated: true },
        orderBy: { lastSeenAt: 'desc' },
      })
      ip = edge?.ipAddress ?? undefined
    }
    if (!ip) throw new BadGatewayException('Brak połączenia z bramką — spróbuj ponownie')

    try {
      const res = await undiciFetch(
        `http://${ip}:4000/devices/${ap.deviceId}/hold-open`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seconds, doorIndex: ap.relayIndex }),
          signal: AbortSignal.timeout(8000),
          dispatcher: edgeDispatcher,
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { holding: boolean; seconds: number; deviceId: string }

      // Audit AccessEvent (Faza 3). Hold-open to forma REMOTE_OPEN ale z
      // dodatkiem `meta.hold_seconds` — żeby było widać że to nie pojedyncze
      // otwarcie, tylko trzymanie.
      this.prisma.$executeRaw`
        INSERT INTO "access_events" ("buildingId", type, "accessPointId", "gateOpened",
                                     "openedById", "openedByType", meta, ts, "createdAt")
        VALUES (${buildingId}, 'REMOTE_OPEN'::"AccessEventType", ${ap.id}, true,
                ${baId}, 'ADMIN',
                ${JSON.stringify({ source: 'ba-hold-open', hold_seconds: data.seconds })}::jsonb,
                CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `.catch(() => { /* audit fail-silent */ })

      return { success: true, label: ap.label, holdingForSeconds: data.seconds }
    } catch (err: any) {
      throw new BadGatewayException(`Nie udało się rozpocząć HOLD_OPEN: ${err.message}`)
    }
  }

  async cancelHoldOpenAccessPoint(
    buildingId: number,
    accessPointId: number,
    buildingIds: number[],
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: accessPointId, buildingId, isActive: true },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    let ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      const edge = await this.prisma.edgeDevice.findFirst({
        where: { buildingId, isActivated: true },
        orderBy: { lastSeenAt: 'desc' },
      })
      ip = edge?.ipAddress ?? undefined
    }
    if (!ip) throw new BadGatewayException('Brak Edge IP')

    try {
      const res = await undiciFetch(
        `http://${ip}:4000/devices/${ap.deviceId}/hold-open/cancel`,
        { method: 'POST', signal: AbortSignal.timeout(5000), dispatcher: edgeDispatcher },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { cancelled: boolean }
      return { cancelled: data.cancelled }
    } catch (err: any) {
      throw new BadGatewayException(`Nie udało się anulować: ${err.message}`)
    }
  }

  async pingDevice(buildingId: number, edgeDeviceId: string, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const device = await this.prisma.edgeDevice.findFirst({
      where: { id: edgeDeviceId, buildingId },
    })
    if (!device) throw new NotFoundException('Urządzenie nie istnieje')
    const online = this.edgeGateway.isOnline(edgeDeviceId)
    return {
      online,
      lastSeenAt: device.lastSeenAt,
      ipAddress: device.ipAddress,
    }
  }

  /**
   * „Restart" Edge — wysyła CMD `REBOOT` przez tunel WS. Edge handler w
   * `apps/edge/src/tunnel/tunnel.service.ts:215` woła `process.exit(0)` po
   * 3-sekundowej delay (żeby zdążył wysłać ACK przed ubiciem procesu);
   * service manager (pm2/launchd na Mac Mini) restartuje proces. Cloud
   * zwraca tylko ack że komunikat poszedł do WS.
   *
   * Uwaga: action name to `REBOOT` (nie `RESTART`) — pasuje do enum-u
   * `TunnelAction` w `apps/edge/src/tunnel/tunnel.types.ts:61`. UI label
   * w BA panelu pokazuje „Restart" dla user-friendliness, ale wire format
   * używa REBOOT.
   */
  async restartDevice(buildingId: number, edgeDeviceId: string, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const device = await this.prisma.edgeDevice.findFirst({
      where: { id: edgeDeviceId, buildingId },
    })
    if (!device) throw new NotFoundException('Urządzenie nie istnieje')
    if (!this.edgeGateway.isOnline(edgeDeviceId)) {
      throw new BadRequestException('Urządzenie jest offline — nie można wysłać restart')
    }
    // Faza 7.6 — sendCommand persistuje w outbox PRZED WS.send.
    await this.edgeGateway.sendCommand(edgeDeviceId, buildingId, 'REBOOT')
    return { sent: true }
  }

  // ── Pojazdy ───────────────────────────────────────────────────────────────
  //
  // Wszystkie zapytania poniżej używają raw SQL, ponieważ `prisma generate`
  // nie nadąża za schematem (konflikt 7.5/5.22 w monorepo — patrz CLAUDE.md),
  // a Vehicle dostał trzy nowe kolumny (kind/serviceName/notes) oraz
  // nullable FK do mieszkańca. Kształt odpowiedzi jest ręcznie
  // odwzorowany na to, czego używał Prisma Client (`include resident`), żeby
  // istniejące fronty nie musiały się zmieniać.

  async getVehicles(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    return this.fetchVehicles(buildingId)
  }

  async createVehicle(buildingId: number, buildingIds: number[], dto: BaCreateVehicleDto) {
    this.guardBuilding(buildingId, buildingIds)
    const kind: VehicleKindStr = dto.kind ?? 'RESIDENT'
    const plate = (dto.licensePlate ?? '').trim().toUpperCase()
    if (!plate) throw new BadRequestException('Tablica nie może być pusta')

    // Cars owned by a resident must have a resident. Service/delivery/etc.
    // pojazdy mogą, ale nie muszą mieć przypisanego mieszkańca — dzięki
    // temu admin może wpisać ogólnego dostawcę usług (np. śmieciarkę), a
    // mieszkaniec może też oznaczyć „moja sprzątaczka" zachowując ownership.
    // 2026-09-07: auto mieszkańca może wskazywać mieszkańca, lokal albo oboje
    // (dom na osiedlu bez konta w apce, auto wspólne gospodarstwa).
    if (kind === 'RESIDENT' && !dto.residentId && !dto.unitId) {
      throw new BadRequestException('Samochód mieszkańca wymaga wskazania mieszkańca lub lokalu')
    }
    let resident: { id: number; firstName: string; lastName: string } | null = null
    if (dto.residentId) {
      resident = await this.prisma.resident.findFirst({
        where: { id: dto.residentId, buildingId },
        select: { id: true, firstName: true, lastName: true },
      })
      if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    }
    const unitId = await this.resolveVehicleUnitId(buildingId, dto.unitId)
    if (kind !== 'RESIDENT' && !dto.serviceName?.trim()) {
      throw new BadRequestException('Dla pojazdu usługowego podaj nazwę firmy/serwisu')
    }

    // Duplicate-guard: ta sama tablica nie może istnieć dwa razy w tym samym
    // budynku. Wcześniej dało się wskutek tego dorobić „literówkowy" duplikat
    // przy edycji z modal-a LPR (form-app POST-ował zamiast PATCH-ować) —
    // patrz LprViewer.handleSave. Trzymamy obronę dwustronnie: UI używa PATCH,
    // ale backend i tak waliduje, żeby drugie wejście nie zrobiło bałaganu.
    const dupe = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "vehicles"
       WHERE "buildingId" = ${buildingId} AND "licensePlate" = ${plate}
       LIMIT 1
    `
    if (dupe[0]) {
      throw new BadRequestException(
        `Tablica „${plate}" jest już zarejestrowana w tym budynku — edytuj istniejący wpis.`,
      )
    }

    const tags = sanitizeTags(dto.tags)
    const [row] = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "vehicles"
        ("buildingId", "residentId", "unitId", "kind", "make", "model", "color",
         "licensePlate", "serviceName", "notes", "tags")
      VALUES (
        ${buildingId},
        ${resident?.id ?? null},
        ${unitId},
        ${kind}::"VehicleKind",
        ${dto.make},
        ${dto.model ?? null},
        ${dto.color},
        ${plate},
        ${dto.serviceName?.trim() || null},
        ${dto.notes?.trim() || null},
        ${tags}::text[]
      )
      RETURNING id
    `
    const created = await this.fetchVehicleById(row.id, buildingId)
    if (created) {
      const syncPayload = await this.buildPlateSyncPayload(created)
      this.syncPlateToEdge(buildingId, 'UPSERT', syncPayload)
    }
    return created
  }

  async updateVehicle(buildingId: number, vehicleId: number, buildingIds: number[], dto: BaUpdateVehicleDto) {
    this.guardBuilding(buildingId, buildingIds)
    const vehicle = await this.fetchVehicleById(vehicleId, buildingId)
    if (!vehicle) throw new NotFoundException('Pojazd nie istnieje')

    const nextPlate = dto.licensePlate
      ? dto.licensePlate.trim().toUpperCase()
      : vehicle.licensePlate
    const nextKind: VehicleKindStr = (dto.kind as VehicleKindStr) ?? (vehicle.kind as VehicleKindStr)
    let residentId: number | null = vehicle.residentId
    if (dto.residentId !== undefined) {
      if (dto.residentId === null) {
        residentId = null
      } else {
        const r = await this.prisma.resident.findFirst({
          where: { id: dto.residentId, buildingId },
          select: { id: true },
        })
        if (!r) throw new NotFoundException('Mieszkaniec nie istnieje')
        residentId = dto.residentId
      }
    }
    // 2026-09-07 — lokal: undefined = bez zmian, null = odpięcie, liczba = walidacja.
    let unitId: number | null = vehicle.unitId
    if (dto.unitId !== undefined) {
      unitId = await this.resolveVehicleUnitId(buildingId, dto.unitId)
    }
    if (nextKind === 'RESIDENT' && !residentId && !unitId) {
      throw new BadRequestException('Samochód mieszkańca wymaga wskazania mieszkańca lub lokalu')
    }

    const nextTags = dto.tags !== undefined ? sanitizeTags(dto.tags) : vehicle.tags
    await this.prisma.$executeRaw`
      UPDATE "vehicles" SET
        "residentId"   = ${residentId},
        "unitId"       = ${unitId},
        "kind"         = ${nextKind}::"VehicleKind",
        "make"         = ${dto.make ?? vehicle.make},
        "model"        = ${dto.model ?? vehicle.model},
        "color"        = ${dto.color ?? vehicle.color},
        "licensePlate" = ${nextPlate},
        "serviceName"  = ${dto.serviceName !== undefined ? (dto.serviceName?.trim() || null) : vehicle.serviceName},
        "notes"        = ${dto.notes !== undefined ? (dto.notes?.trim() || null) : vehicle.notes},
        "autoOpen"     = ${dto.autoOpen !== undefined ? dto.autoOpen : vehicle.autoOpen},
        "tags"         = ${nextTags}::text[]
      WHERE id = ${vehicleId}
    `
    // LPR sync — gate na status. Tylko APPROVED ma być w allowlist Edge.
    // Jeśli pojazd jest PENDING/REJECTED/BLOCKED/EXPIRED — nie ruszamy LPR-a;
    // nawet zmiana tablicy nie powoduje DELETE (bo go tam nie było).
    const wasApproved = vehicle.status === 'APPROVED'
    if (wasApproved && nextPlate !== vehicle.licensePlate) {
      this.syncPlateToEdge(buildingId, 'DELETE', { plate: vehicle.licensePlate })
    }
    const updated = await this.fetchVehicleById(vehicleId, buildingId)
    if (wasApproved && updated) {
      const syncPayload = await this.buildPlateSyncPayload(updated)
      this.syncPlateToEdge(buildingId, 'UPSERT', syncPayload)
    }
    // Zmiana automatycznego wjazdu przez administratora — mieszkaniec musi
    // wiedzieć, dlaczego szlaban przestał (albo zaczął) otwierać się sam.
    if (
      updated?.residentId &&
      dto.autoOpen !== undefined &&
      dto.autoOpen !== vehicle.autoOpen
    ) {
      void this.push
        .sendToResident(
          updated.residentId,
          dto.autoOpen ? 'Automatyczny wjazd włączony' : 'Automatyczny wjazd wyłączony',
          dto.autoOpen
            ? `Administrator osiedla włączył automatyczne otwieranie szlabanu dla pojazdu ${updated.licensePlate}.`
            : `Administrator osiedla wyłączył automatyczne otwieranie szlabanu dla pojazdu ${updated.licensePlate}. Tablica jest nadal rozpoznawana.`,
          { type: 'vehicle_status', vehicleId, autoOpen: dto.autoOpen },
        )
        .catch(() => undefined)
    }
    return updated
  }

  /**
   * Zmiana statusu pojazdu przez admina budynku — Faza 1 bety Villa Natura.
   *
   * Mapowanie akcji → status (+ side-effects):
   *   approve  : PENDING            → APPROVED   + LPR UPSERT  + push do mieszkańca
   *   reject   : PENDING            → REJECTED   + push (z `reason` w body)
   *   block    : APPROVED           → BLOCKED    + LPR DELETE  + push
   *   unblock  : BLOCKED            → APPROVED   + LPR UPSERT  + push
   *
   * Walidacja przejść jest defensywna — gdyby admin kliknął „approve" na
   * APPROVED-ie, BadRequest zamiast cichego no-op (lepiej widoczne w UI).
   *
   * Dlaczego sami pilnujemy LPR sync zamiast trigger-a w bazie: Edge może być
   * offline, więc i tak musimy mieć retry/queue na poziomie aplikacji
   * (`EdgeGateway.sendToBuilding` to fire-and-forget, ale przy reconnect
   * `EdgeService.syncAccessPoints()` cron dośle stan z bazy — patrz CLAUDE.md).
   */
  async updateVehicleStatus(
    buildingId: number,
    vehicleId: number,
    buildingIds: number[],
    baId: number,
    dto: BaUpdateVehicleStatusDto,
  ): Promise<VehicleRow> {
    this.guardBuilding(buildingId, buildingIds)
    const vehicle = await this.fetchVehicleById(vehicleId, buildingId)
    if (!vehicle) throw new NotFoundException('Pojazd nie istnieje')

    const reason = dto.reason?.trim() || null
    if (dto.action === 'reject' && !reason) {
      throw new BadRequestException('Odrzucenie wymaga podania powodu')
    }

    let nextStatus: VehicleStatusStr
    let edgeOp: 'UPSERT' | 'DELETE' | null = null
    let pushTitle = ''
    let pushBody  = ''

    switch (dto.action) {
      case 'approve':
        if (vehicle.status !== 'PENDING') {
          throw new BadRequestException(`Nie można zatwierdzić pojazdu w stanie ${vehicle.status}`)
        }
        nextStatus = 'APPROVED'
        edgeOp = 'UPSERT'
        pushTitle = 'Pojazd zatwierdzony'
        pushBody  = `Tablica ${vehicle.licensePlate} (${[vehicle.make, vehicle.model].filter(Boolean).join(' ')}) została zatwierdzona. Automatyczny wjazd jest aktywny.`
        break
      case 'reject':
        if (vehicle.status !== 'PENDING') {
          throw new BadRequestException(`Nie można odrzucić pojazdu w stanie ${vehicle.status}`)
        }
        nextStatus = 'REJECTED'
        pushTitle = 'Pojazd odrzucony'
        pushBody  = `Tablica ${vehicle.licensePlate} została odrzucona. Powód: ${reason}`
        break
      case 'block':
        if (vehicle.status !== 'APPROVED') {
          throw new BadRequestException(`Nie można zablokować pojazdu w stanie ${vehicle.status}`)
        }
        nextStatus = 'BLOCKED'
        edgeOp = 'DELETE'
        pushTitle = 'Pojazd zablokowany'
        pushBody  = `Tablica ${vehicle.licensePlate} została tymczasowo zablokowana${reason ? `. Powód: ${reason}` : '.'}`
        break
      case 'unblock':
        if (vehicle.status !== 'BLOCKED') {
          throw new BadRequestException(`Nie można odblokować pojazdu w stanie ${vehicle.status}`)
        }
        nextStatus = 'APPROVED'
        edgeOp = 'UPSERT'
        pushTitle = 'Pojazd odblokowany'
        pushBody  = `Tablica ${vehicle.licensePlate} została odblokowana. Automatyczny wjazd jest ponownie aktywny.`
        break
    }

    // approvedById/Type/At ustawiamy tylko przy faktycznej akceptacji (approve
    // lub unblock). Reject/block nie mają „kto zatwierdził" semantyki.
    const setApprovedTrace = (dto.action === 'approve' || dto.action === 'unblock')
    const now = new Date()

    if (setApprovedTrace) {
      await this.prisma.$executeRaw`
        UPDATE "vehicles" SET
          "status"          = ${nextStatus}::"VehicleStatus",
          "approvedById"    = ${baId},
          "approvedByType"  = 'BUILDING_ADMIN',
          "approvedAt"      = ${now},
          "rejectionReason" = NULL
        WHERE id = ${vehicleId}
      `
    } else {
      // reject/block — zapisujemy reason (jeśli podany), nie zmieniamy approvedBy*.
      await this.prisma.$executeRaw`
        UPDATE "vehicles" SET
          "status"          = ${nextStatus}::"VehicleStatus",
          "rejectionReason" = ${reason}
        WHERE id = ${vehicleId}
      `
    }

    // LPR sync — UPSERT przy approve/unblock, DELETE przy block. Fire-and-forget.
    if (edgeOp === 'UPSERT') {
      const syncPayload = await this.buildPlateSyncPayload(vehicle)
      this.syncPlateToEdge(buildingId, 'UPSERT', syncPayload)
    } else if (edgeOp === 'DELETE') {
      this.syncPlateToEdge(buildingId, 'DELETE', { plate: vehicle.licensePlate })
    }

    // Push do mieszkańca (jeśli pojazd ma owner-a). Service/delivery pojazdy
    // bez residentId — nikomu nie pushujemy. Fire-and-forget — błąd APNs nie
    // może wywalić zatwierdzenia.
    if (vehicle.residentId) {
      this.push.sendToResident(vehicle.residentId, pushTitle, pushBody, {
        type: 'vehicle_status',
        vehicleId,
        status: nextStatus,
      }).catch(() => {/* fire-and-forget */})
    }

    const updated = await this.fetchVehicleById(vehicleId, buildingId)
    if (!updated) throw new NotFoundException('Pojazd nie istnieje')
    return updated
  }

  async deleteVehicle(buildingId: number, vehicleId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const vehicle = await this.fetchVehicleById(vehicleId, buildingId)
    if (!vehicle) throw new NotFoundException('Pojazd nie istnieje')
    await this.prisma.$executeRaw`DELETE FROM "vehicles" WHERE id = ${vehicleId}`
    this.syncPlateToEdge(buildingId, 'DELETE', { plate: vehicle.licensePlate })
    return { id: vehicleId }
  }

  /**
   * Autocomplete: unikalne, niepuste nazwy serwisów w tym budynku. Front
   * pokazuje je jako sugestie przy polu „Nazwa firmy" w modalu identyfikacji.
   */
  async listServiceNames(buildingId: number, buildingIds: number[]): Promise<string[]> {
    this.guardBuilding(buildingId, buildingIds)
    const rows = await this.prisma.$queryRaw<{ serviceName: string }[]>`
      SELECT DISTINCT "serviceName"
        FROM "vehicles"
       WHERE "buildingId" = ${buildingId}
         AND "serviceName" IS NOT NULL
         AND btrim("serviceName") <> ''
       ORDER BY "serviceName" ASC
       LIMIT 100
    `
    return rows.map(r => r.serviceName)
  }

  /**
   * Autocomplete: lista tagów już używanych w tym budynku. Front-end łączy
   * je z curated dictionary (`lib/vehicle-tags.ts`) — dictionary podpowiada
   * popularne kategorie ("kabrio", "Glovo"…), a ten endpoint zwraca tagi
   * własne wpisane przez adminów ("opiekunka Aniela", "Tesla 3 sąsiad").
   * `unnest` rozpłaszcza TEXT[] do wierszy, DISTINCT robi resztę.
   */
  async listVehicleTags(buildingId: number, buildingIds: number[]): Promise<string[]> {
    this.guardBuilding(buildingId, buildingIds)
    const rows = await this.prisma.$queryRaw<{ tag: string }[]>`
      SELECT DISTINCT t AS tag
        FROM "vehicles", LATERAL unnest(COALESCE(tags, '{}')) AS t
       WHERE "buildingId" = ${buildingId}
         AND btrim(t) <> ''
       ORDER BY t ASC
       LIMIT 200
    `
    return rows.map(r => r.tag)
  }

  // ── Goście (Faza 2 bety Villa Natura) ────────────────────────────────────
  //
  // Read-only widok dla admina. Łączymy z residents JOIN-em żeby pokazać
  // kto kogo zaprosił. Sortujemy: ACTIVE i jeszcze niewygasłe na górze,
  // historia (CANCELLED / EXPIRED / minęło validTo) niżej.

  async createGuest(
    buildingId: number,
    buildingIds: number[],
    dto: {
      residentId: number
      name: string
      phone?: string
      vehiclePlate?: string
      validFrom?: string
      validTo: string
      // Patrz ResidentService — opcjonalny email gościa, Cloud wyśle Resend.
      email?: string
    },
  ) {
    this.guardBuilding(buildingId, buildingIds)
    if (!dto.residentId) {
      throw new BadRequestException('Wskaż mieszkańca, w imieniu którego zapraszasz gościa')
    }
    const resident = await this.prisma.resident.findFirst({
      where: { id: dto.residentId, buildingId },
      select: { id: true, firstName: true, lastName: true },
    })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje w tym budynku')

    const name = (dto.name ?? '').trim()
    if (!name) throw new BadRequestException('Imię gościa nie może być puste')
    if (!dto.validTo) throw new BadRequestException('Brakuje validTo')

    const validFrom = dto.validFrom ? new Date(dto.validFrom) : new Date()
    const validTo = new Date(dto.validTo)
    this.assertGuestWindow(validFrom, validTo)

    const plate = dto.vehiclePlate?.trim().toUpperCase() || null
    const phone = dto.phone?.trim() || null

    const emailRaw = dto.email?.trim() ?? ''
    const email = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)
      ? emailRaw.toLowerCase()
      : null
    if (emailRaw && !email) {
      throw new BadRequestException('Nieprawidłowy format adresu e-mail')
    }

    const pin = await this.generateUniqueGuestPin(buildingId)
    const urlToken = crypto.randomBytes(32).toString('hex')

    const [row] = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "guests"
        ("buildingId", "residentId", "name", "phone", "vehiclePlate",
         "pin", "validFrom", "validTo", "status",
         "urlToken", "email")
      VALUES (
        ${buildingId},
        ${resident.id},
        ${name},
        ${phone},
        ${plate},
        ${pin},
        ${validFrom},
        ${validTo},
        'ACTIVE'::"GuestStatus",
        ${urlToken},
        ${email}
      )
      RETURNING id
    `

    const inviter = `${resident.firstName} ${resident.lastName}`.trim()
    if (plate) {
      // GUEST payload — bez PII inviter-a w tagach (privacy). `name` jest free-form
      // od mieszkańca i może zawierać „Kurier" / „Sąsiad" / „Mama" — wpadnie do
      // tags. Inviter nie wchodzi do Edge w ogóle (Cloud zna z PIN-a kto zaprosił).
      this.syncPlateToEdge(buildingId, 'UPSERT', {
        plate,
        kind: 'GUEST',
        tags: name ? [name] : [],   // np. ["Kurier"] albo ["Sąsiad Marek"]
        unitLabel: await this.computeUnitLabel(resident.id),
        validFrom,
        validTo,
        guestId: row.id,
      })
    }
    // PIN: idzie do Edge zawsze, niezależnie od tablicy.
    this.syncPinToEdge(buildingId, 'UPSERT', {
      pin,
      guestId: row.id,
      guestName: name,
      validFrom,
      validTo,
    })

    if (email) {
      const building = await this.prisma.building.findUnique({
        where: { id: buildingId },
        select: { name: true },
      })
      this.mail
        .sendGuestInvitation(email, {
          guestName: name,
          buildingName: building?.name ?? 'Twoje osiedle',
          inviterName: inviter,
          validFrom,
          validTo,
          pin,
          urlToken,
        })
        .then(async (res) => {
          if (res.sent) {
            await this.prisma
              .$executeRaw`UPDATE "guests" SET "emailSentAt" = NOW() WHERE id = ${row.id}`
              .catch(() => {})
          }
        })
        .catch(() => {/* MailService loguje sam */})
    }

    return this.fetchGuestById(row.id, buildingId)
  }

  /**
   * Wysyła ponownie email z linkiem do portalu zaproszenia. Używane gdy:
   *   • admin dopisał email do gościa stworzonego bez emaila
   *   • email pierwszy raz nie dotarł (spam folder, literówka)
   *   • gość zgubił link i prosi o resend
   *
   * Jeśli body.email puste, używa zapisanego `guests.email`. Jeśli oba puste —
   * 400. Update `emailSentAt` po wysyłce sukces.
   */
  async resendInviteEmail(
    buildingId: number,
    guestId: number,
    buildingIds: number[],
    overrideEmail?: string,
  ): Promise<{ sent: boolean; email: string }> {
    this.guardBuilding(buildingId, buildingIds)
    type Row = {
      id: number; name: string; pin: string;
      validFrom: Date; validTo: Date;
      urlToken: string | null; email: string | null; status: string;
      residentFirstName: string; residentLastName: string;
    }
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT g.id, g.name, g.pin, g."validFrom", g."validTo",
             g."urlToken", g.email, g.status::text AS status,
             r."firstName" AS "residentFirstName",
             r."lastName" AS "residentLastName"
        FROM "guests" g
        JOIN "residents" r ON r.id = g."residentId"
       WHERE g.id = ${guestId} AND g."buildingId" = ${buildingId}
       LIMIT 1
    `
    const g = rows[0]
    if (!g) throw new NotFoundException('Gość nie istnieje')
    if (g.status === 'CANCELLED') throw new BadRequestException('Zaproszenie anulowane')
    if (!g.urlToken) {
      throw new BadRequestException(
        'Ten gość został utworzony przed pivotem portalu — nie ma URL tokenu. Utwórz nowe zaproszenie.',
      )
    }

    const target = (overrideEmail ?? g.email ?? '').trim().toLowerCase()
    if (!target || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      throw new BadRequestException('Brak prawidłowego adresu email')
    }

    // Zapisz email do bazy gdy podany override (gość nie miał wcześniej).
    if (overrideEmail && target !== g.email) {
      await this.prisma.$executeRaw`
        UPDATE "guests" SET "email" = ${target} WHERE id = ${guestId}
      `
    }

    const building = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { name: true },
    })

    const res = await this.mail.sendGuestInvitation(target, {
      guestName: g.name,
      buildingName: building?.name ?? 'Twoje osiedle',
      inviterName: `${g.residentFirstName} ${g.residentLastName}`.trim(),
      validFrom: g.validFrom,
      validTo: g.validTo,
      pin: g.pin,
      urlToken: g.urlToken,
    })

    if (res.sent) {
      await this.prisma
        .$executeRaw`UPDATE "guests" SET "emailSentAt" = NOW() WHERE id = ${guestId}`
        .catch(() => {})
    }

    return { sent: res.sent, email: target }
  }

  async updateGuest(
    buildingId: number,
    guestId: number,
    buildingIds: number[],
    dto: {
      residentId?: number
      name?: string
      phone?: string | null
      vehiclePlate?: string | null
      validFrom?: string
      validTo?: string
    },
  ) {
    this.guardBuilding(buildingId, buildingIds)
    type Row = {
      id: number; buildingId: number; residentId: number;
      name: string; phone: string | null; vehiclePlate: string | null;
      pin: string; validFrom: Date; validTo: Date; status: string;
    }
    const existing = await this.prisma.$queryRaw<Row[]>`
      SELECT id, "buildingId", "residentId", name, phone, "vehiclePlate",
             pin, "validFrom", "validTo", status::text AS status
        FROM "guests"
       WHERE id = ${guestId} AND "buildingId" = ${buildingId}
    `
    const g = existing[0]
    if (!g) throw new NotFoundException('Gość nie istnieje')
    if (g.status === 'CANCELLED') {
      throw new BadRequestException('To zaproszenie zostało anulowane. Zaproś gościa ponownie.')
    }
    if (g.status === 'EXPIRED' || g.validTo <= new Date()) {
      throw new BadRequestException('Zaproszenie wygasło. Zaproś gościa ponownie.')
    }
    if (g.status !== 'ACTIVE') {
      throw new BadRequestException('Można edytować tylko aktywne zaproszenia')
    }

    let nextResidentId = g.residentId
    let nextResident: { firstName: string; lastName: string } | null = null
    if (dto.residentId && dto.residentId !== g.residentId) {
      const r = await this.prisma.resident.findFirst({
        where: { id: dto.residentId, buildingId },
        select: { firstName: true, lastName: true },
      })
      if (!r) throw new NotFoundException('Mieszkaniec nie istnieje w tym budynku')
      nextResidentId = dto.residentId
      nextResident = r
    } else {
      const r = await this.prisma.resident.findUnique({
        where: { id: g.residentId },
        select: { firstName: true, lastName: true },
      })
      nextResident = r
    }

    const nextName = dto.name?.trim() ?? g.name
    if (!nextName) throw new BadRequestException('Imię gościa nie może być puste')
    const nextPhone = dto.phone === undefined
      ? g.phone
      : (dto.phone?.trim() || null)
    let nextPlate: string | null
    if (dto.vehiclePlate === undefined) {
      nextPlate = g.vehiclePlate
    } else {
      nextPlate = dto.vehiclePlate?.trim().toUpperCase() || null
    }
    const nextFrom = dto.validFrom ? new Date(dto.validFrom) : g.validFrom
    const nextTo = dto.validTo ? new Date(dto.validTo) : g.validTo
    this.assertGuestWindow(nextFrom, nextTo)

    await this.prisma.$executeRaw`
      UPDATE "guests" SET
        "residentId"   = ${nextResidentId},
        "name"         = ${nextName},
        "phone"        = ${nextPhone},
        "vehiclePlate" = ${nextPlate},
        "validFrom"    = ${nextFrom},
        "validTo"      = ${nextTo}
      WHERE id = ${guestId} AND "buildingId" = ${buildingId}
    `

    const inviter = nextResident
      ? `${nextResident.firstName} ${nextResident.lastName}`.trim()
      : 'mieszkaniec'

    if (g.vehiclePlate && g.vehiclePlate !== nextPlate) {
      this.syncPlateToEdge(buildingId, 'DELETE', { plate: g.vehiclePlate })
    }
    if (nextPlate) {
      // GUEST payload — patrz docstring w callu wyżej (faza create).
      this.syncPlateToEdge(buildingId, 'UPSERT', {
        plate: nextPlate,
        kind: 'GUEST',
        tags: nextName ? [nextName] : [],
        unitLabel: await this.computeUnitLabel(nextResidentId),
        validFrom: nextFrom,
        validTo: nextTo,
      })
    }
    // PIN: ten sam kod, ale okno czasowe / nazwa mogły się zmienić → re-upsert.
    this.syncPinToEdge(buildingId, 'UPSERT', {
      pin: g.pin,
      guestId,
      guestName: nextName,
      validFrom: nextFrom,
      validTo: nextTo,
    })

    return this.fetchGuestById(guestId, buildingId)
  }

  async cancelGuest(buildingId: number, guestId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    type Row = {
      buildingId: number; vehiclePlate: string | null; pin: string; status: string;
    }
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT "buildingId", "vehiclePlate", pin, status::text AS status
        FROM "guests"
       WHERE id = ${guestId} AND "buildingId" = ${buildingId}
    `
    const g = rows[0]
    if (!g) throw new NotFoundException('Gość nie istnieje')
    if (g.status === 'CANCELLED') {
      return this.fetchGuestById(guestId, buildingId)
    }
    await this.prisma.$executeRaw`
      UPDATE "guests"
         SET status = 'CANCELLED'::"GuestStatus"
       WHERE id = ${guestId} AND "buildingId" = ${buildingId}
    `
    if (g.status === 'ACTIVE' && g.vehiclePlate) {
      this.syncPlateToEdge(g.buildingId, 'DELETE', { plate: g.vehiclePlate })
    }
    if (g.status === 'ACTIVE' && g.pin) {
      this.syncPinToEdge(g.buildingId, 'DELETE', { pin: g.pin, guestId })
    }
    return this.fetchGuestById(guestId, buildingId)
  }

  // PIN unikalny w obrębie ACTIVE gości w danym budynku.
  private async generateUniqueGuestPin(buildingId: number): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const pin = Math.floor(100000 + Math.random() * 900000).toString()
      const collision = await this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "guests"
         WHERE "buildingId" = ${buildingId}
           AND "pin" = ${pin}
           AND "status" = 'ACTIVE'::"GuestStatus"
      `
      if (Number(collision[0]?.count ?? 0) === 0) return pin
    }
    throw new BadRequestException('Nie udało się wygenerować unikalnego PIN — spróbuj ponownie')
  }

  private assertGuestWindow(from: Date, to: Date) {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Nieprawidłowy format daty')
    }
    if (to <= from) {
      throw new BadRequestException('Data końcowa musi być po początkowej')
    }
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
    if (to.getTime() - from.getTime() > THIRTY_DAYS_MS) {
      throw new BadRequestException('Maksymalny okres zaproszenia to 30 dni')
    }
  }

  private async fetchGuestById(guestId: number, buildingId: number) {
    type Row = {
      id: number; buildingId: number; residentId: number;
      name: string; phone: string | null; vehiclePlate: string | null;
      pin: string; validFrom: Date; validTo: Date; status: string;
      usedAt: Date | null; createdAt: Date;
      residentFirstName: string | null; residentLastName: string | null;
    }
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT g.id, g."buildingId", g."residentId", g.name, g.phone,
             g."vehiclePlate", g.pin, g."validFrom", g."validTo",
             g.status::text AS status, g."usedAt", g."createdAt",
             r."firstName" AS "residentFirstName",
             r."lastName"  AS "residentLastName"
        FROM "guests" g
        LEFT JOIN "residents" r ON r.id = g."residentId"
       WHERE g.id = ${guestId} AND g."buildingId" = ${buildingId}
    `
    const r = rows[0]
    if (!r) return null
    return {
      id: r.id,
      buildingId: r.buildingId,
      residentId: r.residentId,
      name: r.name,
      phone: r.phone,
      vehiclePlate: r.vehiclePlate,
      pin: r.pin,
      validFrom: r.validFrom,
      validTo: r.validTo,
      status: r.status,
      usedAt: r.usedAt,
      createdAt: r.createdAt,
      resident: r.residentFirstName
        ? { id: r.residentId, firstName: r.residentFirstName, lastName: r.residentLastName ?? '' }
        : null,
    }
  }

  /**
   * Historia zdarzeń gości — log do widoku „Historia gości" w panelu.
   *
   * Łączymy dwa źródła:
   *   • `guest_events` (PORTAL_OPEN — kliknięcia w portalu mobile)
   *   • `lpr_reads` z `matched=true` JOIN-owane po `vehiclePlate` z `guests`
   *     w oknie validity (LPR rozpoznał tablicę gościa)
   *
   * Wykonujemy oba query równolegle i merge-ujemy w JS — UNION ALL w SQL
   * wymagałby castów dla różnych kolumn (lr.id vs e.id, plate vs label),
   * a tutaj limit po stronie aplikacji jest tani (100 wierszy).
   *
   * Building-admin używa wspólnej logiki (concierge ma swoją kopię w
   * concierge.service.ts — query identyczne). Refactor do shared modułu
   * można zrobić jeśli pojawi się 3. konsument.
   */
  async getGuestsHistory(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    return getGuestsHistoryFor(this.prisma, buildingId)
  }

  async getGuests(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    type Row = {
      id: number
      buildingId: number
      residentId: number
      name: string
      phone: string | null
      vehiclePlate: string | null
      pin: string
      validFrom: Date
      validTo: Date
      status: string
      usedAt: Date | null
      createdAt: Date
      urlToken: string | null
      email: string | null
      emailSentAt: Date | null
      allowedAccessPoints: unknown
      recurringSchedule: unknown
      residentFirstName: string | null
      residentLastName: string | null
    }
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT g.id, g."buildingId", g."residentId", g.name, g.phone,
             g."vehiclePlate", g.pin, g."validFrom", g."validTo",
             g.status::text AS status, g."usedAt", g."createdAt",
             g."urlToken", g.email, g."emailSentAt",
             g."allowedAccessPoints", g."recurringSchedule",
             r."firstName" AS "residentFirstName",
             r."lastName"  AS "residentLastName"
        FROM "guests" g
        LEFT JOIN "residents" r ON r.id = g."residentId"
       WHERE g."buildingId" = ${buildingId}
       ORDER BY
         (CASE WHEN g.status = 'ACTIVE'::"GuestStatus" AND g."validTo" > NOW()
               THEN 0 ELSE 1 END) ASC,
         g."validFrom" DESC, g.id DESC
    `
    return rows.map(r => ({
      id: r.id,
      buildingId: r.buildingId,
      residentId: r.residentId,
      name: r.name,
      phone: r.phone,
      vehiclePlate: r.vehiclePlate,
      pin: r.pin,
      validFrom: r.validFrom,
      validTo: r.validTo,
      status: r.status,
      usedAt: r.usedAt,
      createdAt: r.createdAt,
      urlToken: r.urlToken,
      email: r.email,
      emailSentAt: r.emailSentAt,
      // Ograniczenia dostępu (2026-07-08) — panel BA pokazuje read-only badge.
      allowedAccessPoints: r.allowedAccessPoints ?? null,
      recurringSchedule: r.recurringSchedule ?? null,
      resident: r.residentFirstName
        ? {
            id: r.residentId,
            firstName: r.residentFirstName,
            lastName: r.residentLastName ?? '',
          }
        : null,
    }))
  }

  private async fetchVehicles(buildingId: number): Promise<VehicleRow[]> {
    return this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v."buildingId" = ${buildingId}`, Prisma.sql`v."createdAt" DESC`)}`
  }

  private async fetchVehicleById(id: number, buildingId: number): Promise<VehicleRow | null> {
    const rows = await this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v.id = ${id} AND v."buildingId" = ${buildingId}`, Prisma.sql`v.id ASC`)}`
    return rows[0] ?? null
  }

  /** Fire-and-forget plate sync to every Edge connected for this building. */
  /**
   * Edge whitelist sync. Wire format `PLATE_UPSERT` / `PLATE_DELETE`.
   *
   * Faza E1+C1 (2026-05-15): rozszerzone payload v2 zawiera structured fields
   * (`kind` / `tags` / `unitLabel`) zamiast pojedynczego `owner` PII string.
   * Edge zapisuje to do `lpr_plates.vehicle_kind` / `vehicle_tags` / `unit_label`
   * i AI Assistant używa do identyfikacji kuriera bez parsowania message tekstu.
   *
   * Legacy `owner` field pozostaje dla backwards-compat (Edge w starszej wersji
   * potrzebuje go); od dziś jest opcjonalny i nie zawiera PII dla RESIDENT
   * (tylko serviceName dla SERVICE albo enum name jako fallback).
   */
  private syncPlateToEdge(
    buildingId: number,
    op: 'UPSERT' | 'DELETE',
    payload: {
      plate: string
      owner?: string
      validFrom?: Date | string | null
      validTo?: Date | string | null
      kind?: string
      tags?: string[]
      unitLabel?: string | null
      /** 2026-07-08 — id gościa dla tablic gości (Edge egzekwuje po nim
       *  ograniczenia z guest_pins). Stary Edge ignoruje pole. */
      guestId?: number
      /** 2026-09-25 — false = Edge rozpoznaje, ale NIE otwiera (przełącznik
       *  mieszkańca). Stary Edge ignoruje pole (= otwiera). */
      autoOpen?: boolean
    },
  ) {
    const action = op === 'UPSERT' ? 'PLATE_UPSERT' : 'PLATE_DELETE'
    // Edge oczekuje `validUntil`, nie `validTo` — patrz `PlateEntry`
    // w `apps/edge/src/devices/cameras/hikvision-lpr.service.ts`.
    const out: Record<string, any> = { plate: payload.plate }
    if (op === 'UPSERT') {
      if (payload.owner !== undefined)     out.owner = payload.owner
      if (payload.kind !== undefined)      out.kind = payload.kind
      if (payload.tags !== undefined)      out.tags = payload.tags
      if (payload.unitLabel !== undefined) out.unitLabel = payload.unitLabel
      if (payload.guestId)                 out.guestId = payload.guestId
      if (payload.autoOpen !== undefined)  out.autoOpen = payload.autoOpen
      if (payload.validFrom !== undefined && payload.validFrom !== null) {
        out.validFrom = payload.validFrom instanceof Date
          ? payload.validFrom.toISOString()
          : payload.validFrom
      }
      if (payload.validTo !== undefined && payload.validTo !== null) {
        out.validUntil = payload.validTo instanceof Date
          ? payload.validTo.toISOString()
          : payload.validTo
      }
    }
    this.edgeGateway.sendToBuilding(buildingId, action, out)
  }

  /**
   * Resync wszystkich APPROVED pojazdów budynku do Edge. Używane po C1 deploy
   * (żeby Edge dostał kind/tags/unitLabel dla istniejących wpisów) lub gdy
   * Edge whitelist rozjedzie się z Cloud DB.
   *
   * Implementacja: iteruje po wszystkich APPROVED vehicles, dla każdego buduje
   * pełen payload z `buildPlateSyncPayload` i wysyła `PLATE_UPSERT`. Edge robi
   * `INSERT OR REPLACE` (overwrite). Każdy upsert jest fire-and-forget przez
   * outbox (gdy Edge offline = enqueue, dostarczone przy reconnect).
   *
   * Zwraca `{ count }` żeby BA UI mogło pokazać ile pojazdów zostało wysłanych.
   */
  async resyncAllVehiclesToEdge(buildingId: number, buildingIds: number[]): Promise<{ count: number }> {
    this.guardBuilding(buildingId, buildingIds)
    const vehicles = await this.fetchVehicles(buildingId)
    const approved = vehicles.filter((v) => v.status === 'APPROVED')
    let count = 0
    for (const v of approved) {
      const payload = await this.buildPlateSyncPayload(v)
      this.syncPlateToEdge(buildingId, 'UPSERT', payload)
      count++
    }
    this.logger.log(`Resync to Edge for building ${buildingId}: ${count} APPROVED vehicles sent`)
    return { count }
  }

  /**
   * Compute privacy-safe unit label dla mieszkania mieszkańca.
   * Format: `{stairwell.name}/{unit.number}` (np. „Niewinna 6/1") — standardowy
   * polski format adresu lokalu, bez imienia ani nazwiska. Null gdy:
   *  • residentId = null (pojazd SERVICE/GUEST nie jest powiązany z lokalem)
   *  • brak aktualnego UnitResident (sinceDate ≤ now < untilDate)
   *  • brak Stairwell przypisanego do Unit-u
   *
   * Edge (apps/edge) pokazuje to w panelu LPR-reads zamiast nazwiska — patrz
   * privacy fix z 2026-05-15.
   */
  /** 2026-09-07 — waliduje lokal z DTO; null/undefined = brak przypisania. */
  private async resolveVehicleUnitId(
    buildingId: number,
    unitId: number | null | undefined,
  ): Promise<number | null> {
    if (unitId === null || unitId === undefined) return null
    const u = await this.prisma.unit.findFirst({ where: { id: unitId, buildingId }, select: { id: true } })
    if (!u) throw new NotFoundException('Lokal nie istnieje')
    return u.id
  }

  /** Etykieta lokalu po id — format z common/unit-label.ts. */
  private async unitLabelById(unitId: number | null | undefined): Promise<string | null> {
    if (!unitId) return null
    try {
      const u = await this.prisma.unit.findUnique({
        where: { id: unitId },
        select: { number: true, street: true, stairwell: { select: { name: true } } },
      })
      return u
        ? formatUnitLabel({ number: u.number, street: u.street, stairwellName: u.stairwell?.name ?? null })
        : null
    } catch {
      return null
    }
  }

  /**
   * Lokal pojazdu dla Edge (`unit_label`): jawne `unitId` wygrywa; w drugiej
   * kolejności lokal mieszkańca z unit_residents — ale tylko dla aut
   * mieszkańców, żeby „moja sprzątaczka" bez lokalu nie dostała adresu
   * z przypadku.
   */
  private async vehicleUnitLabel(v: {
    kind: string
    residentId: number | null
    unitId?: number | null
  }): Promise<string | null> {
    const explicit = await this.unitLabelById(v.unitId)
    if (explicit) return explicit
    return v.kind === 'RESIDENT' ? this.computeUnitLabel(v.residentId) : null
  }

  private async computeUnitLabel(residentId: number | null): Promise<string | null> {
    if (!residentId) return null
    try {
      // Bierzemy najnowszy aktywny UnitResident pivot, joinujemy units + stairwells.
      const rows = await this.prisma.$queryRaw<Array<{ unit_number: string; unit_street: string | null; stairwell_name: string | null }>>`
        SELECT u.number AS unit_number, u.street AS unit_street, s.name AS stairwell_name
          FROM "unit_residents" ur
          JOIN "units" u ON u.id = ur."unitId"
          LEFT JOIN "stairwells" s ON s.id = u."stairwellId"
         WHERE ur."residentId" = ${residentId}
           AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
         ORDER BY ur."sinceDate" DESC
         LIMIT 1
      `
      const r = rows[0]
      if (!r) return null
      return formatUnitLabel({ number: r.unit_number, street: r.unit_street, stairwellName: r.stairwell_name })
    } catch (err: any) {
      // Defensive — gdyby join padł, nie blokujemy syncu. Edge dostanie null
      // i pokaże tablicę bez unit-label-a (akceptowalne, gorsza UX ale działa).
      return null
    }
  }

  /**
   * Buduje pełen payload dla `syncPlateToEdge` z dostępnych danych vehicle.
   *
   * Włącza:
   *   • `kind` (RESIDENT/SERVICE/GUEST)
   *   • `tags[]` — z `vehicle.tags` plus prepended `serviceName` dla SERVICE
   *     (żeby AI od razu widział „DPD" bez wymagania że admin doda go jako tag)
   *   • `unitLabel` — z computeUnitLabel (tylko dla RESIDENT)
   *   • `owner` — legacy, dla SERVICE wstawiamy serviceName, dla RESIDENT
   *     pustym ('' → Edge pomija). Privacy preserving.
   *   • valid window
   */
  private async buildPlateSyncPayload(vehicle: {
    licensePlate: string
    kind: string
    residentId: number | null
    unitId?: number | null
    serviceName: string | null
    make?: string | null
    model?: string | null
    color?: string | null
    tags: string[]
    validFrom: Date | null
    validTo: Date | null
    /** 2026-09-25 — przełącznik mieszkańca; brak pola (starsze wywołania) = true. */
    autoOpen?: boolean
  }): Promise<{
    plate: string
    owner: string
    kind: string
    tags: string[]
    unitLabel: string | null
    validFrom: Date | null
    validTo: Date | null
    autoOpen: boolean
  }> {
    // 2026-09-07: jawny lokal pojazdu > lokal mieszkańca (tylko RESIDENT).
    const unitLabel = await this.vehicleUnitLabel(vehicle)

    // tags rozszerzone: prefiksowane przez serviceName (dla SERVICE/DELIVERY),
    // plus marka, model, kolor — żeby asystent AI na Edge mógł odpowiedzieć
    // „Czy wjeżdżał Mercedes?" bez halucynacji. Dedup przez Set.
    const baseTags = Array.isArray(vehicle.tags) ? vehicle.tags : []
    const extraTags: string[] = []
    if ((vehicle.kind === 'SERVICE' || vehicle.kind === 'DELIVERY') && vehicle.serviceName) {
      extraTags.push(vehicle.serviceName)
    }
    if (vehicle.make)  extraTags.push(vehicle.make)
    if (vehicle.model) extraTags.push(vehicle.model)
    if (vehicle.color) extraTags.push(vehicle.color)
    const tags = Array.from(new Set([...extraTags, ...baseTags]))

    // owner legacy: dla SERVICE/DELIVERY → serviceName (nie PII), dla pozostałych pusty.
    const owner = ((vehicle.kind === 'SERVICE' || vehicle.kind === 'DELIVERY') && vehicle.serviceName)
      ? vehicle.serviceName : ''

    return {
      plate: vehicle.licensePlate,
      owner,
      kind: vehicle.kind,
      tags,
      unitLabel,
      validFrom: vehicle.validFrom,
      validTo: vehicle.validTo,
      autoOpen: vehicle.autoOpen ?? true,
    }
  }

  /**
   * Mirror dla PIN-ów gości — Faza 2D Akuvox. Edge trzyma PIN-y w lokalnej
   * tabeli `guest_pins`, walidacja domofonu offline. Jeden Edge = jeden
   * budynek, więc PIN jest wysyłany do wszystkich connected Edge tego
   * budynku (broadcast przez `sendToBuilding`).
   */
  private syncPinToEdge(
    buildingId: number,
    op: 'UPSERT' | 'DELETE',
    payload: {
      pin: string
      guestId: number
      guestName?: string
      validFrom?: Date | string | null
      validTo?: Date | string | null
    },
  ) {
    const action = op === 'UPSERT' ? 'PIN_UPSERT' : 'PIN_DELETE'
    const out: Record<string, any> = { pin: payload.pin, guestId: payload.guestId }
    if (op === 'UPSERT') {
      if (payload.guestName) out.guestName = payload.guestName
      if (payload.validFrom !== undefined && payload.validFrom !== null) {
        out.validFrom = payload.validFrom instanceof Date
          ? payload.validFrom.toISOString()
          : payload.validFrom
      }
      if (payload.validTo !== undefined && payload.validTo !== null) {
        out.validUntil = payload.validTo instanceof Date
          ? payload.validTo.toISOString()
          : payload.validTo
      }
    }
    this.edgeGateway.sendToBuilding(buildingId, action, out)
  }

  async cancelReservation(buildingId: number, reservationId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const reservation = await this.prisma.reservation.findFirst({
      where: { id: reservationId, buildingId },
    })
    if (!reservation) throw new NotFoundException('Rezerwacja nie istnieje')
    if (reservation.status === 'CANCELLED') {
      throw new BadRequestException('Rezerwacja już została anulowana')
    }
    return this.prisma.reservation.update({
      where: { id: reservationId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
      include: { unit: { include: { unitType: true } }, resident: true },
    })
  }

  // ── PAYMENTS ──────────────────────────────────────────────────────────────────

  private async assertUnitInBuilding(buildingId: number, unitId: number, buildingIds: number[]) {
    if (!buildingIds.includes(buildingId)) throw new ForbiddenException()
    const unit = await this.prisma.unit.findFirst({ where: { id: unitId, buildingId } })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')
    return unit
  }

  /** Przegląd płatności — wszystkie lokale budynku z saldem */
  async getPaymentsOverview(buildingId: number, buildingIds: number[]) {
    if (!buildingIds.includes(buildingId)) throw new ForbiddenException()
    await this.requireBaFeature(buildingId, 'payments')

    type UnitRow = { id: number; number: string; floor: number | null }
    const units = (
      await this.prisma.$queryRaw<UnitRow[]>`
        SELECT id, number, floor FROM units WHERE "buildingId" = ${buildingId} ORDER BY number
      `
    ).sort((a, b) => compareNatural(a.number, b.number))

    // Globalna konfiguracja opłat: gdy lokal NIE ma własnego payment_config,
    // efektywny czynsz wynika ze składowych (payment_components — dokładnie
    // tak liczy je generator naliczeń: FIXED + PER_SQM × metraż, aktywne
    // w bieżącym miesiącu), a termin z payment_settings.dueDay. Dzięki temu
    // globalne ustawienie samo „pojawia się" w konfiguracji każdego lokalu.
    const settingsRow = await this.prisma.$queryRaw<{ dueDay: number }[]>`
      SELECT "dueDay" FROM payment_settings WHERE "buildingId" = ${buildingId}
    `
    const buildingDueDay = settingsRow[0]?.dueDay ?? 10
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
    const compTotals = await this.prisma.$queryRaw<{ unitId: number; total: any }[]>`
      SELECT u.id AS "unitId",
             SUM(CASE WHEN pc."calcType" = 'PER_SQM'
                      THEN pc.amount * COALESCE(u."areaSqm", 0)
                      ELSE pc.amount END) AS total
      FROM units u
      JOIN payment_components pc
        ON pc."buildingId" = u."buildingId"
       AND (pc."unitId" IS NULL OR pc."unitId" = u.id)
       AND pc."activeFrom" < ${monthEnd}
       AND (pc."activeTo" IS NULL OR pc."activeTo" >= ${monthStart})
      WHERE u."buildingId" = ${buildingId}
      GROUP BY u.id
    `
    const compTotalByUnit = new Map(compTotals.map(r => [r.unitId, Number(r.total)]))

    // „Po terminie": niedopłacone naliczenia z minioną wymagalnością.
    // paid liczone jak w computeChargeStatus (wpłaty linkowane chargeId
    // + legacy nieprzypisane po dacie w okresie naliczenia), więc kwoty
    // zgadzają się z raportem miesięcznym i widokiem mieszkańca.
    const overdueRows = await this.prisma.$queryRaw<
      { unitId: number; amount: any; oldestDue: Date | null }[]
    >`
      SELECT c."unitId",
             SUM(GREATEST(c."totalAmount" - p.paid, 0)) AS amount,
             MIN(c."dueDate") FILTER (WHERE c."totalAmount" - p.paid > 0.005) AS "oldestDue"
      FROM payment_charges c
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(pe.amount), 0) AS paid
        FROM payment_entries pe
        WHERE pe."unitId" = c."unitId" AND pe.type = 'PAYMENT'
          AND (pe."chargeId" = c.id
               OR (pe."chargeId" IS NULL
                   AND pe.date >= (c.period || '-01')::date
                   AND pe.date < ((c.period || '-01')::date + interval '1 month')))
      ) p ON true
      WHERE c."buildingId" = ${buildingId} AND c."dueDate" < NOW()
      GROUP BY c."unitId"
      HAVING SUM(GREATEST(c."totalAmount" - p.paid, 0)) > 0.005
    `
    const now = Date.now()
    const overdueByUnit = new Map(
      overdueRows.map(r => [
        r.unitId,
        {
          amount: Number(r.amount),
          daysOverdue: r.oldestDue
            ? Math.max(0, Math.floor((now - new Date(r.oldestDue).getTime()) / 86_400_000))
            : 0,
        },
      ]),
    )

    const result: any[] = []
    for (const unit of units) {
      const balance = await this.calcBalance(unit.id)
      const config = await this.prisma.$queryRaw<any[]>`
        SELECT "monthlyRent", "dueDay", "openingBalance", "openingDate"
        FROM payment_configs WHERE "unitId" = ${unit.id}
      `
      // Syntetyczna konfiguracja ze składowych globalnych (patrz wyżej).
      if (!config[0]) {
        const derived = compTotalByUnit.get(unit.id)
        if (derived && derived > 0) {
          config[0] = {
            monthlyRent: derived,
            dueDay: buildingDueDay,
            openingBalance: 0,
            openingDate: null,
            derivedFromComponents: true,
          }
        }
      }
      // find active residents for this unit
      type ResRow = { firstName: string; lastName: string; email: string }
      const residents = await this.prisma.$queryRaw<ResRow[]>`
        SELECT r."firstName", r."lastName", r.email
        FROM unit_residents ur
        JOIN residents r ON r.id = ur."residentId"
        WHERE ur."unitId" = ${unit.id}
          AND ur."sinceDate" <= NOW()
          AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
        LIMIT 3
      `
      // data ostatniej wpłaty — kolumna „Ostatnia wpłata" w nowym UI
      const lastPay = await this.prisma.$queryRaw<{ last: Date | null }[]>`
        SELECT MAX(date) AS last FROM payment_entries
        WHERE "unitId" = ${unit.id} AND type = 'PAYMENT'
      `
      result.push({
        unitId: unit.id,
        number: unit.number,
        floor: unit.floor,
        balance: Number(balance),
        config: config[0] ?? null,
        residents,
        lastPaymentAt: lastPay[0]?.last ?? null,
        overdue: overdueByUnit.get(unit.id) ?? null,
      })
    }
    return result
  }

  /** Historia wpłat jednego lokalu */
  async getUnitPayments(buildingId: number, unitId: number, buildingIds: number[]) {
    await this.assertUnitInBuilding(buildingId, unitId, buildingIds)

    type ConfigRow = { monthlyRent: any; dueDay: number; openingBalance: any; openingDate: Date }
    const config = await this.prisma.$queryRaw<ConfigRow[]>`
      SELECT "monthlyRent", "dueDay", "openingBalance", "openingDate"
      FROM payment_configs WHERE "unitId" = ${unitId}
    `

    type EntryRow = { id: number; amount: any; type: string; date: Date; description: string | null; reference: string | null; source: string | null; createdAt: Date }
    const entries = await this.prisma.$queryRaw<EntryRow[]>`
      SELECT id, amount, type, date, description, reference, source, "createdAt"
      FROM payment_entries WHERE "unitId" = ${unitId}
      ORDER BY date DESC, "createdAt" DESC
    `

    const balance = await this.calcBalance(unitId)

    return {
      config: config[0] ?? null,
      balance: Number(balance),
      entries: entries.map(e => ({ ...e, amount: Number(e.amount) })),
    }
  }

  /** Upsert konfiguracji czynszu dla lokalu */
  async upsertPaymentConfig(
    buildingId: number,
    unitId: number,
    buildingIds: number[],
    dto: {
      monthlyRent: number
      dueDay: number
      openingBalance: number
      openingDate: string
    },
  ) {
    await this.assertUnitInBuilding(buildingId, unitId, buildingIds)

    const existing = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM payment_configs WHERE "unitId" = ${unitId}
    `

    if (existing.length > 0) {
      await this.prisma.$executeRaw`
        UPDATE payment_configs
        SET "monthlyRent"    = ${dto.monthlyRent},
            "dueDay"         = ${dto.dueDay},
            "openingBalance" = ${dto.openingBalance},
            "openingDate"    = ${new Date(dto.openingDate)},
            "updatedAt"      = NOW()
        WHERE "unitId" = ${unitId}
      `
    } else {
      await this.prisma.$executeRaw`
        INSERT INTO payment_configs ("unitId", "monthlyRent", "dueDay", "openingBalance", "openingDate", "updatedAt")
        VALUES (${unitId}, ${dto.monthlyRent}, ${dto.dueDay}, ${dto.openingBalance}, ${new Date(dto.openingDate)}, NOW())
      `
    }

    return { success: true }
  }

  /** Ręczna korekta salda */
  async addPaymentCorrection(
    buildingId: number,
    unitId: number,
    buildingIds: number[],
    dto: { amount: number; description: string; date: string },
  ) {
    await this.assertUnitInBuilding(buildingId, unitId, buildingIds)

    await this.prisma.$executeRaw`
      INSERT INTO payment_entries ("unitId", amount, type, date, description, source)
      VALUES (${unitId}, ${dto.amount}, 'CORRECTION'::"PaymentType", ${new Date(dto.date)}, ${dto.description}, 'admin')
    `
    const balance = await this.calcBalance(unitId)
    return { success: true, balance: Number(balance) }
  }

  /** Import pliku MT940 — parsowanie i dopasowanie wpłat do lokali */
  async importMt940(buildingId: number, buildingIds: number[], content: string) {
    if (!buildingIds.includes(buildingId)) throw new ForbiddenException()

    const transactions = this.parseMt940(content)
    let matched = 0
    let unmatched = 0

    // pobierz numery lokali budynku
    type UnitRow = { id: number; number: string }
    const units = await this.prisma.$queryRaw<UnitRow[]>`
      SELECT id, number FROM units WHERE "buildingId" = ${buildingId}
    `

    for (const tx of transactions) {
      if (tx.type !== 'C') { unmatched++; continue } // tylko credit (wpłaty)

      // spróbuj dopasować lokal po numerze w opisie
      const unit = units.find(u =>
        tx.description.toLowerCase().includes(u.number.toLowerCase()) ||
        tx.reference?.toLowerCase().includes(u.number.toLowerCase()),
      )

      if (!unit) { unmatched++; continue }

      // sprawdź czy już nie zaimportowano (po reference)
      if (tx.reference) {
        const dup = await this.prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM payment_entries WHERE "unitId" = ${unit.id} AND reference = ${tx.reference}
        `
        if (dup.length > 0) continue
      }

      await this.prisma.$executeRaw`
        INSERT INTO payment_entries ("unitId", amount, type, date, description, reference, source)
        VALUES (${unit.id}, ${tx.amount}, 'PAYMENT'::"PaymentType", ${tx.date}, ${tx.description}, ${tx.reference ?? null}, 'mt940')
      `
      matched++
    }

    return { total: transactions.filter(t => t.type === 'C').length, matched, unmatched }
  }

  /** Parser MT940 — zwraca listę transakcji */
  private parseMt940(content: string): Array<{
    date: Date
    type: 'C' | 'D'
    amount: number
    reference: string | null
    description: string
  }> {
    const result: Array<{ date: Date; type: 'C' | 'D'; amount: number; reference: string | null; description: string }> = []

    // split na bloki transakcji (:61:)
    const blocks = content.split(/(?=:61:)/)

    for (const block of blocks) {
      const line61 = block.match(/:61:(\d{6})\d{0,4}([CD]R?)(\d+,\d+)(?:N\w{3})?(.*)/)
      if (!line61) continue

      const [, dateStr, crDr, amountStr, ref] = line61
      const year  = 2000 + parseInt(dateStr.slice(0, 2))
      const month = parseInt(dateStr.slice(2, 4)) - 1
      const day   = parseInt(dateStr.slice(4, 6))
      const date  = new Date(year, month, day)

      const type   = crDr.startsWith('C') ? 'C' : 'D'
      const amount = parseFloat(amountStr.replace(',', '.'))

      // opis z :86:
      const desc86 = block.match(/:86:([\s\S]*?)(?=:\d{2}[A-Z]?:|$)/)
      const description = desc86 ? desc86[1].replace(/\r?\n/g, ' ').trim().slice(0, 500) : ''

      result.push({ date, type, amount, reference: ref?.trim() || null, description })
    }

    return result
  }

  /** Wyślij przypomnienie o płatności do mieszkańców lokalu */
  /**
   * Przypomnienie o płatności dla lokalu. Kanały:
   *   - aplikacja (zawsze): wpis w panelu powiadomień + push na telefon,
   *   - e-mail (opcjonalnie, `viaEmail=true`): branded mail przez Resend do
   *     każdego aktywnego mieszkańca który MA adres e-mail.
   */
  async sendPaymentReminder(
    buildingId: number,
    unitId: number,
    buildingIds: number[],
    opts: { viaEmail?: boolean } = {},
  ) {
    await this.assertUnitInBuilding(buildingId, unitId, buildingIds)

    const balance = await this.calcBalance(unitId)

    // znajdź aktywnych mieszkańców (email potrzebny dla kanału mailowego)
    type ResRow = { id: number; firstName: string; lastName: string; email: string | null }
    const residents = await this.prisma.$queryRaw<ResRow[]>`
      SELECT r.id, r."firstName", r."lastName", r.email
      FROM unit_residents ur
      JOIN residents r ON r.id = ur."residentId"
      WHERE ur."unitId" = ${unitId}
        AND ur."sinceDate" <= NOW()
        AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
    `

    const cfg = await this.prisma.$queryRaw<{ dueDay: number }[]>`
      SELECT "dueDay" FROM payment_configs WHERE "unitId" = ${unitId}
    `
    const settingsRow = await this.prisma.$queryRaw<{ dueDay: number }[]>`
      SELECT "dueDay" FROM payment_settings WHERE "buildingId" = ${buildingId}
    `
    const unitRow = await this.prisma.$queryRaw<{ number: string }[]>`
      SELECT number FROM units WHERE id = ${unitId}
    `
    const unitNumber = unitRow[0]?.number ?? String(unitId)
    const dueDay = cfg[0]?.dueDay ?? settingsRow[0]?.dueDay ?? 10
    const balanceNum = Number(balance)

    let emailsSent = 0
    for (const resident of residents) {
      const title = 'Przypomnienie o płatności'
      const body  = balanceNum < 0
        ? `Masz zaległości w wysokości ${Math.abs(balanceNum).toFixed(2)} PLN. Termin płatności: ${dueDay}. dnia miesiąca.`
        : `Nadchodzi termin płatności czynszu (${dueDay}. dzień miesiąca). Bieżące saldo: ${balanceNum.toFixed(2)} PLN.`

      await this.prisma.notification.create({
        data: { buildingId, residentId: resident.id, title, body },
      })
      await this.push.sendToResident(resident.id, title, body)

      if (opts.viaEmail && resident.email) {
        const res = await this.mail.sendPaymentReminder({
          toEmail: resident.email,
          name: resident.firstName,
          unitNumber,
          balance: balanceNum,
          dueDay,
        })
        if (res.sent) emailsSent += 1
      }
    }

    return { sent: residents.length, emailsSent: opts.viaEmail ? emailsSent : undefined }
  }

  /** Oblicz saldo lokalu (saldo_otwarcia + wpłaty + obciążenia + korekty) */
  private async calcBalance(unitId: number): Promise<number> {
    const cfg = await this.prisma.$queryRaw<{ openingBalance: any }[]>`
      SELECT "openingBalance" FROM payment_configs WHERE "unitId" = ${unitId}
    `
    const opening = Number(cfg[0]?.openingBalance ?? 0)

    const sum = await this.prisma.$queryRaw<{ total: any }[]>`
      SELECT COALESCE(SUM(amount), 0) AS total FROM payment_entries WHERE "unitId" = ${unitId}
    `
    return opening + Number(sum[0]?.total ?? 0)
  }

  // ── Wizja kamer (YOLO detection) ──────────────────────────────────────────
  //
  // Cloud BA proxy do Edge `/vision/*` endpoints. Edge fetchuje snapshoty z
  // kamer co 60s i POST-uje do YOLO service na MacBooku, persistuje wyniki w
  // sqlite `vision_detections` + notable frames w `vision-frames/`. Cloud nie
  // ma własnej kopii — wszystko leci na żywo przez Tailscale.
  //
  // Pattern (jak `pipeSnapshot` w resident.service):
  //   1. guardBuilding → permission check (BA assigned to building)
  //   2. resolveEdgeIp → live WS map, DB fallback
  //   3. undiciFetch z edgeDispatcher (TS_HTTP_PROXY) + AbortSignal.timeout
  //   4. JSON forward lub binary pipe (dla `/frame/:fname`)

  private async resolveEdgeIp(buildingId: number): Promise<string> {
    let ip: string | undefined = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      const edge = await this.prisma.edgeDevice.findFirst({
        where: { buildingId, isActivated: true },
        orderBy: { lastSeenAt: 'desc' },
      })
      ip = edge?.ipAddress ?? undefined
    }
    if (!ip) throw new BadGatewayException('Brak połączenia z bramką')
    return ip
  }

  /**
   * Forward GET /vision/detections do Edge z query-string preservation.
   *
   * Edge zwraca już sparsowane `summary` + listę. Cloud robi tylko proxy
   * (zero biznesowej logiki) żeby latencja siedziała na rzędzie ~30-100ms
   * przez Tailscale, nie ~500ms (parse + reshape).
   */
  async visionListDetections(
    buildingId: number,
    buildingIds: number[],
    query: {
      sinceHours?: string; cameraId?: string; class?: string; limit?: string
      withImage?: string
      /** 2026-08-15 — wyszukiwanie tekstowe po całej historii (Edge `q`). */
      q?: string
      /** 2026-08-21 — własny zakres dat + kursor paginacji (epoch ms). */
      sinceTs?: string; untilTs?: string; beforeTs?: string
    },
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const ip = await this.resolveEdgeIp(buildingId)

    const qs = new URLSearchParams()
    if (query.sinceHours) qs.set('since_hours', query.sinceHours)
    if (query.cameraId) qs.set('camera_id', query.cameraId)
    if (query.class) qs.set('class', query.class)
    if (query.limit) qs.set('limit', query.limit)
    if (query.withImage) qs.set('with_image', query.withImage)
    if (query.q) qs.set('q', query.q)
    if (query.sinceTs) qs.set('since_ts', query.sinceTs)
    if (query.untilTs) qs.set('until_ts', query.untilTs)
    if (query.beforeTs) qs.set('before_ts', query.beforeTs)

    try {
      const res = await undiciFetch(`http://${ip}:4000/vision/detections?${qs.toString()}`, {
        signal: AbortSignal.timeout(10_000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
      return await res.json()
    } catch (err: any) {
      this.logger.warn(`vision/detections proxy failed (${ip}): ${err?.message}`)
      throw new BadGatewayException(`Edge niedostępny: ${err?.message ?? 'błąd'}`)
    }
  }

  /**
   * 2026-08-26 — zdarzenia sytuacyjne z korelatora Edge (tailgating, krążący
   * pojazd, osoba w nocy, wizyta kuriera, upadek). Proxy do Edge `/situations`.
   */
  async situationsList(
    buildingId: number,
    buildingIds: number[],
    query: { sinceHours?: string; types?: string; limit?: string },
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const ip = await this.resolveEdgeIp(buildingId)
    const qs = new URLSearchParams()
    if (query.sinceHours) qs.set('since_hours', query.sinceHours)
    if (query.types) qs.set('types', query.types)
    if (query.limit) qs.set('limit', query.limit)
    try {
      const res = await undiciFetch(`http://${ip}:4000/situations?${qs.toString()}`, {
        signal: AbortSignal.timeout(10_000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
      return await res.json()
    } catch (err: any) {
      this.logger.warn(`situations proxy failed (${ip}): ${err?.message}`)
      throw new BadGatewayException(`Edge niedostępny: ${err?.message ?? 'błąd'}`)
    }
  }

  /** 2026-08-26 — „Kronika dnia" dla panelu BA (Edge `/assistant/chronicle`). */
  async situationsChronicle(buildingId: number, buildingIds: number[], smart: boolean) {
    this.guardBuilding(buildingId, buildingIds)
    const ip = await this.resolveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(
        `http://${ip}:4000/assistant/chronicle?smart=${smart ? '1' : '0'}`,
        { signal: AbortSignal.timeout(50_000), dispatcher: edgeDispatcher },
      )
      if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
      return await res.json()
    } catch (err: any) {
      this.logger.warn(`chronicle proxy failed (${ip}): ${err?.message}`)
      return { date: null, lines: [], narrative: null, push_text: null, events: [] }
    }
  }

  /** 2026-08-15 — sugestie rozpoznań (powtarzające się niezarejestrowane tablice). */
  async visionPlateSuggestions(buildingId: number, buildingIds: number[], sinceDays?: string) {
    this.guardBuilding(buildingId, buildingIds)
    const ip = await this.resolveEdgeIp(buildingId)
    const qs = sinceDays ? `?since_days=${encodeURIComponent(sinceDays)}` : ''
    try {
      const res = await undiciFetch(`http://${ip}:4000/vision/plate-suggestions${qs}`, {
        signal: AbortSignal.timeout(10_000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
      return await res.json()
    } catch (err: any) {
      this.logger.warn(`vision/plate-suggestions proxy failed (${ip}): ${err?.message}`)
      throw new BadGatewayException(`Edge niedostępny: ${err?.message ?? 'błąd'}`)
    }
  }

  async visionStats(buildingId: number, buildingIds: number[], sinceHours?: string) {
    this.guardBuilding(buildingId, buildingIds)
    const ip = await this.resolveEdgeIp(buildingId)
    const qs = new URLSearchParams()
    if (sinceHours) qs.set('since_hours', sinceHours)
    try {
      const res = await undiciFetch(`http://${ip}:4000/vision/stats?${qs.toString()}`, {
        signal: AbortSignal.timeout(10_000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
      return await res.json()
    } catch (err: any) {
      throw new BadGatewayException(`Edge niedostępny: ${err?.message ?? 'błąd'}`)
    }
  }

  async visionCameras(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const ip = await this.resolveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/vision/cameras`, {
        signal: AbortSignal.timeout(10_000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
      return await res.json()
    } catch (err: any) {
      throw new BadGatewayException(`Edge niedostępny: ${err?.message ?? 'błąd'}`)
    }
  }

  /**
   * Pipe binary JPEG z Edge `/vision/frame/:filename` do response.
   *
   * Każdy frame to ~150KB → buffer-and-write zamiast prawdziwego streamu jest
   * prostszy i pomija problem z `node:stream`+`undici` interop. UI używa
   * authorized fetch + blob URL, więc auto-cache jest w przeglądarce (per-tab).
   *
   * BA JWT już sprawdzony przez guard w controller. Filename walidowany na
   * Edge (regex) — Cloud nie powtarza walidacji.
   */
  async visionPipeFrame(
    buildingId: number,
    buildingIds: number[],
    filename: string,
    res: import('express').Response,
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const ip = await this.resolveEdgeIp(buildingId)

    // Sanity check przed proxy — defense-in-depth (Edge i tak waliduje).
    if (!/^[0-9]+_[A-Za-z0-9._-]+\.jpg$/.test(filename)) {
      throw new BadRequestException('Niepoprawna nazwa klatki')
    }

    try {
      const edgeRes = await undiciFetch(
        `http://${ip}:4000/vision/frame/${encodeURIComponent(filename)}`,
        { signal: AbortSignal.timeout(10_000), dispatcher: edgeDispatcher },
      )
      if (edgeRes.status === 404) throw new NotFoundException('Klatka niedostępna')
      if (!edgeRes.ok) throw new Error(`Edge HTTP ${edgeRes.status}`)
      const buf = Buffer.from(await edgeRes.arrayBuffer())
      res.setHeader('Content-Type', 'image/jpeg')
      // Cache w przeglądarce — klatki są immutable (timestamp + UUID w nazwie).
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.setHeader('Content-Length', buf.length)
      res.end(buf)
    } catch (err: any) {
      if (err instanceof NotFoundException) throw err
      throw new BadGatewayException(`Klatka niedostępna: ${err?.message ?? 'błąd'}`)
    }
  }

  // ── FAZA d (2026-06-02) — Courier visits (BA listing) ───────────────────
  //
  // BA z `features.delivery_to_door=true` widzi zakładkę z dzisiejszymi
  // wizytami kurierów + statystykami. Raw SQL bo CourierVisit jest nowy
  // model w schemacie + Prisma drift 5.22/7.5 czasem nie generuje typowanych
  // metod (patrz CLAUDE.md).
  async listCourierVisits(
    buildingId: number,
    buildingIds: number[],
    opts: { limit?: number; status?: string } = {},
  ) {
    this.guardBuilding(buildingId, buildingIds)
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
    if (opts.status) {
      return this.prisma.$queryRaw<Array<{
        id: number; buildingId: number; code: string; courierBrand: string | null;
        targetUnitId: number | null; status: string;
        createdAt: Date; resolvedAt: Date | null; resolvedBy: number | null;
        expiresAt: Date;
      }>>`
        SELECT id, "buildingId", code, "courierBrand", "targetUnitId", status,
               "createdAt", "resolvedAt", "resolvedBy", "expiresAt"
          FROM "courier_visits"
         WHERE "buildingId" = ${buildingId} AND status = ${opts.status}
         ORDER BY "createdAt" DESC
         LIMIT ${limit}
      `
    }
    return this.prisma.$queryRaw<Array<{
      id: number; buildingId: number; code: string; courierBrand: string | null;
      targetUnitId: number | null; status: string;
      createdAt: Date; resolvedAt: Date | null; resolvedBy: number | null;
      expiresAt: Date;
    }>>`
      SELECT id, "buildingId", code, "courierBrand", "targetUnitId", status,
             "createdAt", "resolvedAt", "resolvedBy", "expiresAt"
        FROM "courier_visits"
       WHERE "buildingId" = ${buildingId}
       ORDER BY "createdAt" DESC
       LIMIT ${limit}
    `
  }

  /** Stats dla BA dashboard: ile dziś / accepted / rejected / pending. */
  async courierVisitsStats(buildingId: number, buildingIds: number[]) {
    this.guardBuilding(buildingId, buildingIds)
    const rows = await this.prisma.$queryRaw<Array<{ status: string; cnt: bigint }>>`
      SELECT status, COUNT(*)::bigint AS cnt
        FROM "courier_visits"
       WHERE "buildingId" = ${buildingId}
         AND "createdAt" >= CURRENT_DATE
       GROUP BY status
    `
    const out = { total: 0, pending: 0, accepted: 0, rejected: 0, expired: 0 }
    for (const r of rows) {
      const n = Number(r.cnt)
      out.total += n
      if (r.status === 'PENDING') out.pending = n
      else if (r.status === 'ACCEPTED') out.accepted = n
      else if (r.status === 'REJECTED') out.rejected = n
      else if (r.status === 'EXPIRED') out.expired = n
    }
    return out
  }
}

// ── Vehicle raw-SQL helpers ──────────────────────────────────────────────────
//
// Shape returned from `vehicles` raw SELECT. The nested `resident` object
// mirrors what the Prisma Client used to return via `include: { resident }`
// so that frontends don't have to branch on response shape.

export interface VehicleRow {
  id: number
  buildingId: number
  residentId: number | null
  // 2026-09-07 — lokal przypisany bezpośrednio (niezależnie od mieszkańca).
  unitId: number | null
  kind: string                          // VehicleKind enum as plain text
  make: string
  model: string | null
  color: string
  licensePlate: string
  serviceName: string | null
  notes: string | null
  // Opcjonalne zdjęcie pojazdu (2026-07-16) — base64 data URI z iOS.
  photo: string | null
  // 2026-08-21 — push o przejeździe własnego pojazdu (opt-in mieszkańca).
  notifyOnUse: boolean
  // 2026-09-25 — czy rozpoznanie tablicy ma otwierać bramę (przełącznik
  // mieszkańca w karcie pojazdu). Leci do Edge jako `autoOpen`.
  autoOpen: boolean
  // Tagi opisowe wybierane w UI (chip multi-select). Słownik trzymany w
  // apps/web/src/lib/vehicle-tags.ts; backend nie waliduje wartości — admin
  // może też wpisać własny tag (np. „obsługa basenu", „dziadek mieszkanki").
  tags: string[]
  createdAt: Date
  // Faza 1 bety Villa Natura — vehicle approval flow
  status: string                        // VehicleStatus enum as plain text
  validFrom: Date | null
  validTo: Date | null
  approvedAt: Date | null
  rejectionReason: string | null
  resident: { id: number; firstName: string; lastName: string } | null
  // Lokal z jawnego `unitId` — `label` wg common/unit-label.ts („B/15A",
  // „Kwiatowa 5", „Niewinna 4/2"). Null gdy pojazd nie ma przypisanego lokalu.
  unit: { id: number; number: string; label: string } | null
}

/**
 * Build a single SELECT that materialises the nested resident object via
 * `jsonb_build_object`. This keeps every `fetchVehicle*` query identical
 * modulo the WHERE/ORDER clauses that callers plug in.
 */
export function vehicleSelectSql(where: Prisma.Sql, orderBy: Prisma.Sql) {
  return Prisma.sql`
    SELECT v.id, v."buildingId", v."residentId", v."unitId", v.kind::text AS kind,
           v.make, v.model, v.color, v."licensePlate",
           v."serviceName", v.notes, v.photo, v."notifyOnUse", v."autoOpen",
           COALESCE(v.tags, '{}') AS tags,
           v."createdAt",
           v.status::text AS status,
           v."validFrom", v."validTo",
           v."approvedAt", v."rejectionReason",
           CASE WHEN res.id IS NULL THEN NULL
                ELSE jsonb_build_object(
                  'id', res.id,
                  'firstName', res."firstName",
                  'lastName', res."lastName"
                )
           END AS resident,
           CASE WHEN un.id IS NULL THEN NULL
                ELSE jsonb_build_object(
                  'id', un.id,
                  'number', un.number,
                  'label', ${unitLabelSql('un', 'st')}
                )
           END AS unit
      FROM "vehicles" v
      LEFT JOIN "residents" res ON res.id = v."residentId"
      LEFT JOIN "units" un ON un.id = v."unitId"
      LEFT JOIN "stairwells" st ON st.id = un."stairwellId"
     WHERE ${where}
     ORDER BY ${orderBy}
  `
}

/**
 * Normalizuje listę tagów z DTO przed zapisem:
 *   • null/undefined → pusta tablica,
 *   • obcina białe znaki, odrzuca puste,
 *   • deduplikuje (case-sensitive — „Glovo" i „glovo" mogą znaczyć co innego
 *     w intencji użytkownika; nie chcemy decydować za niego),
 *   • limit 32 tagi/pojazd, 64 znaki/tag — żeby przypadkiem nie wpadł tu
 *     CSV z 5000 wpisów.
 */
export function sanitizeTags(raw: string[] | null | undefined): string[] {
  if (!raw || !Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (typeof r !== 'string') continue
    const t = r.trim().slice(0, 64)
    if (!t) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= 32) break
  }
  return out
}

/**
 * Pick a sensible `owner` label to send with PLATE_UPSERT. The Edge writes
 * this string into its LPR_READ events, so picking a human-readable value
 * keeps concierge logs readable: resident name for RESIDENT, service brand
 * for everything else.
 */
export function ownerForEdge(
  kind: string,
  resident: { firstName: string; lastName: string } | null,
  serviceName: string | null | undefined,
): string {
  if (kind === 'RESIDENT' && resident) {
    return `${resident.firstName} ${resident.lastName}`.trim()
  }
  const svc = (serviceName ?? '').trim()
  if (svc) return svc
  // Fallback — makes sure the Edge never receives an empty owner label.
  return kind.charAt(0) + kind.slice(1).toLowerCase()
}
