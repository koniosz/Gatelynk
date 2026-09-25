import { Injectable, Logger, UnauthorizedException, NotFoundException, BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { assertGuestPlateAllowed } from '../guests/guest-plate-guard'
import { normalizeTicketPhoto } from '../common/ticket-photo'
import { JwtService } from '@nestjs/jwt'
import { Prisma } from '@prisma/client'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import * as crypto from 'crypto'
import { PrismaService } from '../prisma/prisma.service'
import { PushService } from '../push/push.service'
import { EdgeGateway } from '../edge/edge.gateway'
import { EdgeService } from '../edge/edge.service'
import { MailService } from '../mail/mail.service'
import { AccessEventsService } from '../access-events/access-events.service'
import { computeChargeStatus } from '../payments/payments-admin.service'
import {
  VEHICLE_KINDS,
  vehicleSelectSql,
  ownerForEdge,
} from '../building-admin/building-admin.service'
import type { VehicleKindStr, VehicleRow } from '../building-admin/building-admin.service'
import { vehiclePlateSyncPayload } from '../common/plate-sync'
import { ForbiddenException } from '@nestjs/common'
import {
  hasPermission,
  normalizePermissions,
  flattenForRole,
  featKey,
  apKey,
  FEATURE_DISABLED_CODE,
  FEATURE_DISABLED_MESSAGE,
  type BuildingFeaturePermissions,
  type SystemFeature,
} from '../buildings/feature-permissions.constants'
import {
  parseAllowedAccessPoints,
  parseRecurringSchedule,
  type AllowedAccessPointEntry,
  type RecurringSchedule,
} from '../guests/guest-restrictions.util'

// Tailscale userspace HTTP proxy — singleton, ten sam pattern co w EdgeService /
// LprReadsController. Cloud na Fly.io nie ma /dev/net/tun, więc tailscaled
// chodzi w userspace mode i wystawia proxy na localhost:1055. Bez routingu
// przez ten proxy natywny `fetch()` z Cloud → Edge (100.x.x.x:4000) timeout-uje
// — czego skutkiem był znikający podgląd kamer/domofonów (snapshot + relay).
const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

// Wiersz `guests` zwracany przez raw SELECT-y. Trzymany w pliku obok serwisu,
// bo Prisma 7.5/5.22 konflikt sprawia że typ `Guest` z @prisma/client bywa
// nieobecny w monorepo — stąd cały dostęp do tabeli przez raw SQL (CLAUDE.md).
export type GuestStatusStr = 'ACTIVE' | 'EXPIRED' | 'CANCELLED'

export interface GuestRow {
  id: number
  buildingId: number
  residentId: number
  name: string
  phone: string | null
  vehiclePlate: string | null
  pin: string
  validFrom: Date
  validTo: Date
  status: GuestStatusStr
  usedAt: Date | null
  // Powiadomienia o aktywności gościa (2026-08-14) — toggle w aplikacji.
  notifyOnUse: boolean
  createdAt: Date
  // Guest Portal (pivot bezkontaktowy) — nullable bo legacy goście (sprzed
  // migracji 20260430140000) ich nie mają. iOS używa do generowania URL-a
  // do iMessage composer (gatelynk.com/g/<urlToken>).
  urlToken: string | null
  email: string | null
  emailSentAt: Date | null
  // Ograniczenia dostępu gościa (2026-07-08) — NULL = bez ograniczeń
  // (backward-compat: istniejący goście działają jak dotąd). JSONB z raw
  // SELECT-a przychodzi już sparsowany.
  allowedAccessPoints?: AllowedAccessPointEntry[] | null
  recurringSchedule?: RecurringSchedule | null
  // Zużyte otwarcia per AP (agregat z guest_access_uses) — dokładane w
  // odpowiedziach getGuests/createGuest/updateGuest, nie kolumna tabeli.
  accessUses?: { accessPointId: number | null; count: number }[]
}

@Injectable()
export class ResidentService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private push: PushService,
    private edgeGateway: EdgeGateway,
    private edgeService: EdgeService,
    // MailService z @Global MailModule — bez zmian w resident.module.ts.
    private mail: MailService,
    private accessEvents: AccessEventsService,
  ) {}

  // ── Auth ──────────────────────────────────────────────────────────────────

  async login(email: string, password: string) {
    // Find ALL residents with this email that have a password set
    const residents = await this.prisma.resident.findMany({
      where: { email, passwordHash: { not: null } },
      include: {
        building: { select: { id: true, name: true, address: true } },
        unitResidents: {
          where: { untilDate: null },
          include: { unit: { select: { number: true } } },
          orderBy: { sinceDate: 'desc' },
          take: 1,
        },
      },
      orderBy: { id: 'desc' },
    })

    if (!residents.length) {
      const exists = await this.prisma.resident.findFirst({ where: { email } })
      if (exists) throw new UnauthorizedException('Konto nie ma ustawionego hasła — skontaktuj się z administratorem')
      throw new UnauthorizedException('Nieprawidłowy email lub hasło')
    }

    // Verify password (all records share the same person, so any passwordHash works)
    const bcrypt = await import('bcrypt')
    const valid = await bcrypt.compare(password, residents[0].passwordHash!)
    if (!valid) throw new UnauthorizedException('Nieprawidłowy email lub hasło')

    // Multiple buildings → ask the client to pick one
    if (residents.length > 1) {
      return {
        requiresBuildingSelection: true,
        buildings: residents.map((r) => ({
          residentId: r.id,
          buildingId: r.buildingId,
          buildingName: r.building.name,
          buildingAddress: r.building.address,
          unit: r.unitResidents[0]?.unit?.number ?? null,
        })),
      }
    }

    return this.issueTokenWithAvatar(residents[0].id, residents[0])
  }

  /** Called after building selection — re-validates password for security */
  async selectBuilding(email: string, password: string, residentId: number) {
    const resident = await this.prisma.resident.findFirst({
      where: { id: residentId, email, passwordHash: { not: null } },
    })
    if (!resident) throw new UnauthorizedException('Nieprawidłowy email lub hasło')
    const bcrypt = await import('bcrypt')
    const valid = await bcrypt.compare(password, resident.passwordHash!)
    if (!valid) throw new UnauthorizedException('Nieprawidłowy email lub hasło')
    return this.issueTokenWithAvatar(resident.id, resident)
  }

  /** Switch building without re-entering password (requires valid JWT) */
  async switchBuilding(email: string, residentId: number) {
    const resident = await this.prisma.resident.findFirst({
      where: { id: residentId, email },
    })
    if (!resident) throw new UnauthorizedException()
    return this.issueTokenWithAvatar(resident.id, resident)
  }

  /** Return all buildings this user belongs to (for in-app switcher) */
  async getMyBuildings(email: string) {
    const residents = await this.prisma.resident.findMany({
      where: { email },
      include: {
        building: { select: { id: true, name: true, address: true } },
        unitResidents: {
          where: { untilDate: null },
          include: { unit: { select: { number: true } } },
          orderBy: { sinceDate: 'desc' },
          take: 1,
        },
      },
      orderBy: { id: 'desc' },
    })
    return residents.map((r) => ({
      residentId: r.id,
      buildingId: r.buildingId,
      buildingName: r.building.name,
      buildingAddress: r.building.address,
      unit: r.unitResidents[0]?.unit?.number ?? null,
    }))
  }

  private issueToken(resident: { id: number; email: string; buildingId: number; firstName: string; lastName: string; phone: string | null }) {
    const payload = {
      sub: resident.id,
      email: resident.email,
      type: 'resident',
      buildingId: resident.buildingId,
      residentId: resident.id,
    }
    return {
      access_token: this.jwt.sign(payload),
      resident: {
        id: resident.id,
        firstName: resident.firstName,
        lastName: resident.lastName,
        email: resident.email,
        phone: resident.phone,
        buildingId: resident.buildingId,
        avatarBase64: null as string | null,
      },
    }
  }

  // issueToken z raw SQL dla avatarBase64 (Prisma client nie ma wygenerowanego pola)
  private async issueTokenWithAvatar(residentId: number, resident: { id: number; email: string; buildingId: number; firstName: string; lastName: string; phone: string | null }) {
    const rows = await this.prisma.$queryRaw<{ avatarBase64: string | null }[]>`
      SELECT "avatarBase64" FROM residents WHERE id = ${residentId} LIMIT 1
    `
    const avatarBase64 = rows[0]?.avatarBase64 ?? null
    const payload = {
      sub: resident.id,
      email: resident.email,
      type: 'resident',
      buildingId: resident.buildingId,
      residentId: resident.id,
    }
    return {
      access_token: this.jwt.sign(payload),
      resident: {
        id: resident.id,
        firstName: resident.firstName,
        lastName: resident.lastName,
        email: resident.email,
        phone: resident.phone,
        buildingId: resident.buildingId,
        avatarBase64,
      },
    }
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  async getMe(residentId: number) {
    const r = await this.prisma.resident.findUnique({
      where: { id: residentId },
      include: {
        unitResidents: { where: { untilDate: null }, include: { unit: { include: { unitType: true, stairwell: true } } } },
        vehicles: true,
      },
    })
    if (!r) throw new NotFoundException()
    const { passwordHash: _, ...rest } = r
    // avatarBase64 + notifyAnomalies — defensywnie raw SQL, na wypadek gdyby
    // Prisma Client w produkcji był odpalany przed `prisma generate` z nową
    // kolumną. Faza 7.1 to powinno działać przez typed client, ale per-field
    // raw SQL nie boli i unika regresji.
    const rows = await this.prisma.$queryRaw<
      { avatarBase64: string | null; notifyAnomalies: boolean | null; intercomPin: string | null }[]
    >`
      SELECT "avatarBase64", "notifyAnomalies", "intercomPin"
        FROM residents WHERE id = ${residentId} LIMIT 1
    `
    // FAZA e — feature permissions dla iOS. Wysyłamy spłaszczony dict
    // tylko dla roli 'resident' żeby klient nie musiał rozumieć struktury
    // 3-poziomowej. Klucze: `feat_*` + `ap_*`.
    const featurePermissions = flattenForRole(
      await this.loadFeaturePermissions(r.buildingId),
      'resident',
    )
    return {
      ...rest,
      avatarBase64: rows[0]?.avatarBase64 ?? null,
      notifyAnomalies: rows[0]?.notifyAnomalies ?? false,
      intercomPin: rows[0]?.intercomPin ?? null,
      featurePermissions,
    }
  }

  // ── FAZA e (2026-06-02) — Feature permissions guard ─────────────────────
  //
  // `loadFeaturePermissions` ciągnie raw JSON z DB (raw SQL — kolumna jest
  // nowa, Prisma Client może nie znać typu do `prisma generate`).
  // `requireResidentFeature` rzuca 403 z spójnym kodem `FEATURE_DISABLED`
  // gdy integrator wyłączył feature.

  private async loadFeaturePermissions(buildingId: number): Promise<BuildingFeaturePermissions> {
    const rows = await this.prisma.$queryRaw<{ featurePermissions: unknown }[]>`
      SELECT "featurePermissions"
        FROM "buildings" WHERE id = ${buildingId} LIMIT 1
    `
    return normalizePermissions(rows[0]?.featurePermissions)
  }

  private async requireResidentFeature(buildingId: number, feature: SystemFeature) {
    const perms = await this.loadFeaturePermissions(buildingId)
    if (!hasPermission(perms, 'resident', featKey(feature))) {
      throw new ForbiddenException({
        message: FEATURE_DISABLED_MESSAGE,
        code: FEATURE_DISABLED_CODE,
        feature,
      })
    }
  }

  /** Variant gdy mamy tylko residentId — fetch buildingId potem guard. */
  private async requireResidentFeatureByResidentId(residentId: number, feature: SystemFeature) {
    const r = await this.prisma.resident.findUnique({
      where: { id: residentId },
      select: { buildingId: true },
    })
    if (!r) throw new NotFoundException('Mieszkaniec nie istnieje')
    await this.requireResidentFeature(r.buildingId, feature)
  }

  // ── Building ──────────────────────────────────────────────────────────────

  async getBuilding(buildingId: number) {
    return this.prisma.building.findUnique({
      where: { id: buildingId },
      select: {
        id: true, name: true, address: true, objectType: true,
        backgroundImageBase64: true,
        logoBase64: true,
        _count: { select: { residents: true, units: true } },
      },
    })
  }

  async updateAvatar(residentId: number, avatarBase64: string | null) {
    // Use raw SQL — Prisma client may not have avatarBase64 in generated types yet
    await this.prisma.$executeRaw`
      UPDATE residents SET "avatarBase64" = ${avatarBase64} WHERE id = ${residentId}
    `
    return { id: residentId, avatarBase64 }
  }

  // ── Usunięcie konta (2026-07-07, wymóg Apple 5.1.1(v)) ────────────────────
  //
  // Soft-delete/anonimizacja zamiast hard DELETE — spójne z polityką
  // prywatności (docs/legal): dane audytu wejść (access_events) pozostają
  // u administratora danych (wspólnota/zarządca — obowiązek prawny), ale
  // dane osobowe mieszkańca są anonimizowane a dostęp wyłączany:
  //   1. push tokeny (APNs + VoIP) — hard delete,
  //   2. aktywni goście — CANCELLED + sync DELETE tablic/PIN-ów do Edge,
  //   3. PIN domofonowy — NULL + RESIDENT_PIN_DELETE do Edge,
  //   4. pojazdy APPROVED — usunięte z whitelisty LPR na Edge (rows zostają
  //      w Cloud jako audyt, status BLOCKED),
  //   5. przypisania do lokali — zamknięte (untilDate = NOW),
  //   6. wiersz residents — anonimizacja (imię/nazwisko/email/telefon/avatar)
  //      + passwordHash = NULL (istniejące JWT przestają być groźne: konto
  //      nie ma już danych, a ponowny login jest niemożliwy).
  // Konto per-budynek: usuwamy konto, na które user jest zalogowany (inne
  // budynki tego samego e-maila wymagają osobnego usunięcia po zalogowaniu).
  async deleteMyAccount(residentId: number) {
    const resident = await this.prisma.resident.findUnique({ where: { id: residentId } })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    const buildingId = resident.buildingId

    // 1. Push tokeny (APNs 'apns' + 'voip' — wszystkie typy w push_tokens).
    await this.prisma.$executeRaw`
      DELETE FROM "push_tokens" WHERE "residentId" = ${residentId}
    `

    // 2. Aktywni goście: CANCELLED + sprzątanie tablic/PIN-ów na Edge.
    const activeGuests = await this.prisma.$queryRaw<
      { id: number; pin: string | null; vehiclePlate: string | null }[]
    >`
      SELECT id, pin, "vehiclePlate" FROM "guests"
       WHERE "residentId" = ${residentId} AND status = 'ACTIVE'::"GuestStatus"
    `
    if (activeGuests.length > 0) {
      await this.prisma.$executeRaw`
        UPDATE "guests" SET status = 'CANCELLED'::"GuestStatus"
         WHERE "residentId" = ${residentId} AND status = 'ACTIVE'::"GuestStatus"
      `
      for (const g of activeGuests) {
        if (g.vehiclePlate) this.syncPlateToEdge(buildingId, 'DELETE', { plate: g.vehiclePlate })
        if (g.pin) this.syncPinToEdge(buildingId, 'DELETE', { pin: g.pin, guestId: g.id })
      }
    }

    // 3. PIN domofonowy mieszkańca.
    if (resident.intercomPin) {
      this.edgeGateway
        .sendToBuilding(buildingId, 'RESIDENT_PIN_DELETE', { residentId })
        .catch(() => { /* tunel down — sync przy reconnect (SYNC_ALL) */ })
    }

    // 4. Pojazdy: zdejmij z whitelisty LPR (Edge) + BLOCKED w Cloud (audyt).
    const vehicles = await this.prisma.$queryRaw<{ id: number; licensePlate: string; status: string }[]>`
      SELECT id, "licensePlate", status::text AS status FROM "vehicles"
       WHERE "residentId" = ${residentId}
    `
    for (const v of vehicles) {
      if (v.status === 'APPROVED') {
        this.syncPlateToEdge(buildingId, 'DELETE', { plate: v.licensePlate })
      }
    }
    await this.prisma.$executeRaw`
      UPDATE "vehicles" SET status = 'BLOCKED'::"VehicleStatus"
       WHERE "residentId" = ${residentId} AND status = 'APPROVED'::"VehicleStatus"
    `

    // 5. Zamknij aktywne przypisania do lokali.
    await this.prisma.$executeRaw`
      UPDATE "unit_residents" SET "untilDate" = NOW()
       WHERE "residentId" = ${residentId} AND "untilDate" IS NULL
    `

    // 6. Anonimizacja + blokada logowania. Email musi zostać unikalny per
    //    (buildingId, email) — sufiks z id gwarantuje brak kolizji.
    await this.prisma.$executeRaw`
      UPDATE "residents"
         SET "firstName" = 'Konto',
             "lastName" = 'usunięte',
             email = ${'deleted+' + residentId + '@removed.gatelynk.invalid'},
             phone = NULL,
             "passwordHash" = NULL,
             "avatarBase64" = NULL,
             "intercomPin" = NULL,
             "notifyAnomalies" = false
       WHERE id = ${residentId}
    `

    return { ok: true }
  }

  // ── Intercom PIN (2026-06-02) ─────────────────────────────────────────────
  //
  // Mieszkaniec ustawia stały 4-6 cyfrowy PIN do klawiatury Akuvox przy
  // bramie/domofonie. Walidacja:
  //   1. Format 4-6 cyfr
  //   2. Strength: blacklist trivial (1234, 0000, sekwencje rosnące/malejące)
  //   3. Unique per building (partial DB index + app check vs Guest.pin ACTIVE)
  //
  // Po zapisie → push tunnel `RESIDENT_PIN_UPSERT` żeby Edge cache zaktualizować.
  // null = remove PIN → `RESIDENT_PIN_DELETE`.
  //
  // Działa offline-first: Edge sam waliduje przy keypad event (lokalny cache).

  private static readonly TRIVIAL_PINS = new Set([
    '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
    '1234', '4321', '0123', '3210', '12345', '54321', '123456', '654321',
    '000000', '111111', '222222', '333333', '444444', '555555',
    '666666', '777777', '888888', '999999',
  ])

  async setIntercomPin(residentId: number, pin: string | null) {
    const resident = await this.prisma.resident.findUnique({ where: { id: residentId } })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    await this.requireResidentFeature(resident.buildingId, 'resident_pin')

    if (pin === null || pin === '') {
      // DELETE — usuń PIN i powiadom Edge.
      await this.prisma.$executeRaw`
        UPDATE residents SET "intercomPin" = NULL WHERE id = ${residentId}
      `
      this.edgeGateway
        .sendToBuilding(resident.buildingId, 'RESIDENT_PIN_DELETE', { residentId })
        .catch(() => { /* tunel down — sync przy reconnect */ })
      return { ok: true, pin: null }
    }

    // Format
    if (!/^[0-9]{4,6}$/.test(pin)) {
      throw new BadRequestException('PIN musi mieć 4-6 cyfr')
    }
    // Strength
    if (ResidentService.TRIVIAL_PINS.has(pin)) {
      throw new BadRequestException('PIN zbyt prosty (sekwencja lub te same cyfry)')
    }

    // Collision vs inny resident (DB unique index też złapie, ale lepszy
    // komunikat z aplikacji).
    const otherResident = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM residents
       WHERE "buildingId" = ${resident.buildingId}
         AND "intercomPin" = ${pin}
         AND id != ${residentId}
       LIMIT 1
    `
    if (otherResident.length > 0) {
      throw new ConflictException('PIN już używany przez innego mieszkańca w tym budynku')
    }

    // Collision vs active guest
    const activeGuest = await this.prisma.guest.findFirst({
      where: { buildingId: resident.buildingId, pin, status: 'ACTIVE' },
    })
    if (activeGuest) {
      throw new ConflictException('PIN koliduje z aktywnym zaproszeniem gościa — wybierz inny')
    }

    await this.prisma.$executeRaw`
      UPDATE residents SET "intercomPin" = ${pin} WHERE id = ${residentId}
    `

    // Push do Edge tunnel
    this.edgeGateway
      .sendToBuilding(resident.buildingId, 'RESIDENT_PIN_UPSERT', {
        residentId,
        pin,
        residentName: `${resident.firstName} ${resident.lastName}`.trim(),
      })
      .catch(() => { /* offline — Cloud → Edge sync przy reconnect */ })

    return { ok: true, pin }
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  async getNotifications(residentId: number, buildingId: number) {
    await this.requireResidentFeature(buildingId, 'notifications')
    return this.prisma.notification.findMany({
      where: { buildingId, OR: [{ residentId: null }, { residentId }] },
      orderBy: { sentAt: 'desc' },
      take: 50,
    })
  }

  // ── Parcels ───────────────────────────────────────────────────────────────

  async getParcels(residentId: number, buildingId: number) {
    await this.requireResidentFeature(buildingId, 'parcels')
    const unitIds = (await this.prisma.unitResident.findMany({
      where: { residentId, untilDate: null },
      select: { unitId: true },
    })).map((ur) => ur.unitId)

    return this.prisma.parcel.findMany({
      where: { buildingId, unitId: { in: unitIds } },
      include: { unit: { include: { unitType: true } } },
      orderBy: { receivedAt: 'desc' },
    })
  }

  // ── Reservations ──────────────────────────────────────────────────────────

  async getReservations(residentId: number) {
    await this.requireResidentFeatureByResidentId(residentId, 'reservations')
    return this.prisma.reservation.findMany({
      where: { residentId },
      include: { unit: { include: { unitType: true } } },
      orderBy: { startAt: 'desc' },
    })
  }

  async getReservableUnits(buildingId: number) {
    await this.requireResidentFeature(buildingId, 'reservations')
    return this.prisma.unit.findMany({
      where: { buildingId, unitType: { isCommonArea: true } },
      include: { unitType: true },
    })
  }

  async createReservation(residentId: number, buildingId: number, dto: { unitId: number; startAt: string; endAt: string; note?: string }) {
    await this.requireResidentFeature(buildingId, 'reservations')
    return this.prisma.reservation.create({
      data: {
        buildingId,
        residentId,
        unitId: dto.unitId,
        startAt: new Date(dto.startAt),
        endAt: new Date(dto.endAt),
        note: dto.note ?? null,
        status: 'CONFIRMED',
        isPaid: false,
      },
      include: { unit: { include: { unitType: true } } },
    })
  }

  async updateReservation(reservationId: number, residentId: number, dto: { unitId?: number; startAt?: string; endAt?: string; note?: string }) {
    const r = await this.prisma.reservation.findFirst({ where: { id: reservationId, residentId, status: 'CONFIRMED' } })
    if (!r) throw new NotFoundException()
    return this.prisma.reservation.update({
      where: { id: reservationId },
      data: {
        ...(dto.unitId && { unitId: dto.unitId }),
        ...(dto.startAt && { startAt: new Date(dto.startAt) }),
        ...(dto.endAt && { endAt: new Date(dto.endAt) }),
        note: dto.note !== undefined ? dto.note : r.note,
      },
      include: { unit: { include: { unitType: true } } },
    })
  }

  async cancelReservation(reservationId: number, residentId: number) {
    const r = await this.prisma.reservation.findFirst({ where: { id: reservationId, residentId } })
    if (!r) throw new NotFoundException()
    return this.prisma.reservation.update({
      where: { id: reservationId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    })
  }

  // ── Tickets ───────────────────────────────────────────────────────────────

  async getTickets(residentId: number) {
    await this.requireResidentFeatureByResidentId(residentId, 'tickets')
    return this.prisma.ticket.findMany({
      where: { residentId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async getTicket(ticketId: number, residentId: number) {
    const t = await this.prisma.ticket.findFirst({
      where: { id: ticketId, residentId },
      include: { replies: { orderBy: { createdAt: 'asc' } } },
    })
    if (!t) throw new NotFoundException()
    return t
  }

  async addReply(ticketId: number, residentId: number, body: string, photo?: unknown) {
    const t = await this.prisma.ticket.findFirst({ where: { id: ticketId, residentId } })
    if (!t) throw new NotFoundException()
    const photoNorm = normalizeTicketPhoto(photo)
    // authorId NULL dla resident-replies — wynika z `ticket.residentId`,
    // nie ma sensu duplikować. Nowa kolumna `authorId` (Faza 4) trzymana raw,
    // żeby nie zależeć od `prisma generate` (broken w monorepo, patrz CLAUDE.md).
    const [row] = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "ticket_replies" ("ticketId", "authorType", "authorId", "body", "photo")
      VALUES (${ticketId}, 'RESIDENT', NULL, ${body}, ${photoNorm})
      RETURNING id
    `
    return this.prisma.ticketReply.findUnique({ where: { id: row.id } })
  }

  // Usunięcie własnego zgłoszenia (2026-07-13) — swipe-to-delete w iOS.
  // Twarde usunięcie: najpierw odpowiedzi (FK ticket_replies.ticketId bez
  // ON DELETE CASCADE), potem sam ticket. Mieszkaniec może usunąć wyłącznie
  // swoje zgłoszenie — cudze/nieistniejące → 404.
  async deleteTicket(ticketId: number, residentId: number) {
    const t = await this.prisma.ticket.findFirst({
      where: { id: ticketId, residentId },
      select: { id: true },
    })
    if (!t) throw new NotFoundException()
    await this.prisma.$executeRaw`
      DELETE FROM "ticket_replies" WHERE "ticketId" = ${ticketId}
    `
    await this.prisma.$executeRaw`
      DELETE FROM "tickets" WHERE id = ${ticketId} AND "residentId" = ${residentId}
    `
    return { deleted: true }
  }

  async createTicket(
    residentId: number,
    buildingId: number,
    dto: { category: string; title: string; body: string; photo?: string; type?: string },
  ) {
    await this.requireResidentFeature(buildingId, 'tickets')
    // type — adresat zgłoszenia: ADMIN (domyślny) lub CONCIERGE (Faza 4).
    // Mieszkaniec wybiera w iOS przy create. Walidujemy whitelistą żeby
    // nie wstawiać literówek / przyszłych typów bez updatów backendu.
    const allowedTypes = new Set(['ADMIN', 'CONCIERGE'])
    const type = dto.type && allowedTypes.has(dto.type) ? dto.type : 'ADMIN'
    // Raw INSERT — Prisma Client po nowym polu `type` zna model dopiero po
    // udanym `prisma generate`. W produkcji entrypoint robi `migrate deploy`,
    // ale generate jest broken (drift 5.22/7.5), więc czytamy/piszemy raw.
    const [row] = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "tickets"
        ("buildingId", "residentId", "category", "type", "title", "body", "photo", "updatedAt")
      VALUES (
        ${buildingId},
        ${residentId},
        ${dto.category}::"TicketCategory",
        ${type},
        ${dto.title},
        ${dto.body},
        ${dto.photo ?? null},
        NOW()
      )
      RETURNING id
    `
    return this.prisma.ticket.findUnique({ where: { id: row.id } })
  }

  // ── Vehicles ──────────────────────────────────────────────────────────────
  //
  // Mieszkaniec widzi tylko SWOJE pojazdy. Może dodać auto rodzinne (kind =
  // RESIDENT) lub oznaczyć cudzy pojazd, który odwiedza jego mieszkanie
  // regularnie — np. sprzątaczkę (kind = SERVICE + serviceName = "Anna").
  // Backend nie zezwala mieszkańcowi na tworzenie ogólnych usług budynku
  // bez ownershipu: residentId ZAWSZE jest jego własnym ID.

  async getVehicles(residentId: number): Promise<VehicleRow[]> {
    await this.requireResidentFeatureByResidentId(residentId, 'vehicles')
    return this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v."residentId" = ${residentId}`, Prisma.sql`v."createdAt" DESC`)}`
  }

  async createVehicle(
    residentId: number,
    buildingId: number,
    dto: {
      make: string
      model?: string
      color: string
      licensePlate: string
      kind?: VehicleKindStr
      serviceName?: string
      notes?: string
      photo?: string
    },
  ): Promise<VehicleRow> {
    await this.requireResidentFeature(buildingId, 'vehicles')
    const plate = (dto.licensePlate ?? '').trim().toUpperCase()
    if (!plate) throw new BadRequestException('Tablica nie może być pusta')
    const kind: VehicleKindStr = dto.kind ?? 'RESIDENT'
    if (!VEHICLE_KINDS.includes(kind)) {
      throw new BadRequestException('Nieznany typ pojazdu')
    }
    if (kind !== 'RESIDENT' && !dto.serviceName?.trim()) {
      throw new BadRequestException('Dla pojazdu usługowego podaj nazwę firmy/serwisu')
    }
    const resident = await this.prisma.resident.findUnique({
      where: { id: residentId },
      select: { firstName: true, lastName: true },
    })

    // Faza 1 bety Villa Natura — pojazdy dodawane przez mieszkańca trafiają
    // do statusu PENDING. Admin musi je zatwierdzić zanim wpadną do allowlisty
    // LPR. Stąd brak `syncPlateToEdge` w tej ścieżce — robi to dopiero
    // `BuildingAdminService.updateVehicleStatus` przy approve.
    const [row] = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "vehicles"
        ("buildingId", "residentId", "kind", "make", "model", "color",
         "licensePlate", "serviceName", "notes", "photo", "status")
      VALUES (
        ${buildingId},
        ${residentId},
        ${kind}::"VehicleKind",
        ${dto.make},
        ${dto.model ?? null},
        ${dto.color},
        ${plate},
        ${dto.serviceName?.trim() || null},
        ${dto.notes?.trim() || null},
        ${dto.photo ?? null},
        'PENDING'::"VehicleStatus"
      )
      RETURNING id
    `
    // Push do adminów dopiero gdy będą mieli tokeny (Faza 5: Admin UI).
    // Na razie admin widzi PENDING w panelu webowym (filtr „Do zatwierdzenia").
    const rows = await this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v.id = ${row.id}`, Prisma.sql`v.id ASC`)}`
    return rows[0]
  }

  async updateVehicle(
    vehicleId: number,
    residentId: number,
    dto: {
      make?: string
      model?: string
      color?: string
      licensePlate?: string
      kind?: VehicleKindStr
      serviceName?: string
      notes?: string
      // undefined = bez zmian, null = usuń zdjęcie, string = nowe zdjęcie.
      photo?: string | null
      /** Push o przejeździe pojazdu (2026-08-21) — opt-in z karty pojazdu. */
      notifyOnUse?: boolean
      /** 2026-09-25 — przełącznik „otwieraj bramę po rozpoznaniu tablicy".
       *  false = tablica zostaje na białej liście Edge, ale brama nie rusza. */
      autoOpen?: boolean
    },
  ): Promise<VehicleRow> {
    const existing = await this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v.id = ${vehicleId} AND v."residentId" = ${residentId}`, Prisma.sql`v.id ASC`)}`
    const v = existing[0]
    if (!v) throw new NotFoundException()
    if (dto.autoOpen !== undefined && typeof dto.autoOpen !== 'boolean') {
      throw new BadRequestException('autoOpen musi być true/false')
    }

    const nextPlate = dto.licensePlate ? dto.licensePlate.trim().toUpperCase() : v.licensePlate
    const nextKind: VehicleKindStr = (dto.kind as VehicleKindStr) ?? (v.kind as VehicleKindStr)
    if (dto.kind && !VEHICLE_KINDS.includes(dto.kind)) {
      throw new BadRequestException('Nieznany typ pojazdu')
    }
    const resident = await this.prisma.resident.findUnique({
      where: { id: residentId },
      select: { firstName: true, lastName: true },
    })

    // Faza 1 bety: zmiana tablicy przez mieszkańca cofa pojazd do PENDING,
    // bo admin zatwierdził konkretną tablicę — nie wolno cicho podmienić
    // jej w allowlist LPR. Edycja kosmetyczna (kolor / notatka) zostawia
    // status bez zmian.
    const plateChanged = nextPlate !== v.licensePlate
    const wasApproved = v.status === 'APPROVED'
    const resetToPending = plateChanged && wasApproved

    if (resetToPending) {
      await this.prisma.$executeRaw`
        UPDATE "vehicles" SET
          "kind"            = ${nextKind}::"VehicleKind",
          "make"            = ${dto.make ?? v.make},
          "model"           = ${dto.model !== undefined ? dto.model : v.model},
          "color"           = ${dto.color ?? v.color},
          "licensePlate"    = ${nextPlate},
          "serviceName"     = ${dto.serviceName !== undefined ? (dto.serviceName?.trim() || null) : v.serviceName},
          "notes"           = ${dto.notes !== undefined ? (dto.notes?.trim() || null) : v.notes},
          "photo"           = ${dto.photo !== undefined ? dto.photo : v.photo},
          "notifyOnUse"     = ${dto.notifyOnUse !== undefined ? dto.notifyOnUse : v.notifyOnUse},
          "autoOpen"        = ${dto.autoOpen !== undefined ? dto.autoOpen : v.autoOpen},
          "status"          = 'PENDING'::"VehicleStatus",
          "approvedById"    = NULL,
          "approvedByType"  = NULL,
          "approvedAt"      = NULL,
          "rejectionReason" = NULL
        WHERE id = ${vehicleId} AND "residentId" = ${residentId}
      `
    } else {
      await this.prisma.$executeRaw`
        UPDATE "vehicles" SET
          "kind"         = ${nextKind}::"VehicleKind",
          "make"         = ${dto.make ?? v.make},
          "model"        = ${dto.model !== undefined ? dto.model : v.model},
          "color"        = ${dto.color ?? v.color},
          "licensePlate" = ${nextPlate},
          "serviceName"  = ${dto.serviceName !== undefined ? (dto.serviceName?.trim() || null) : v.serviceName},
          "notes"        = ${dto.notes !== undefined ? (dto.notes?.trim() || null) : v.notes},
          "notifyOnUse"  = ${dto.notifyOnUse !== undefined ? dto.notifyOnUse : v.notifyOnUse},
          "autoOpen"     = ${dto.autoOpen !== undefined ? dto.autoOpen : v.autoOpen},
          "photo"        = ${dto.photo !== undefined ? dto.photo : v.photo}
        WHERE id = ${vehicleId} AND "residentId" = ${residentId}
      `
    }

    // LPR sync — tylko jeśli pojazd był APPROVED. PENDING/REJECTED/BLOCKED
    // nigdy nie był w allowlist więc nie ma czego usuwać/aktualizować.
    if (wasApproved) {
      if (plateChanged) {
        // stara tablica wypada z allowlist; nowa wraca do PENDING (admin re-approve).
        this.syncPlateToEdge(v.buildingId, 'DELETE', { plate: v.licensePlate })
      } else {
        // Kosmetyka / powiadomienia / przełącznik autoOpen — PEŁNY wpis, bo
        // Edge robi INSERT OR REPLACE: wcześniejszy payload `{plate, owner}`
        // kasował na Edge etykietę lokalu, typ, tagi i okno ważności
        // (błąd wykryty 2026-09-25). Jedna definicja z konsjerżem.
        const refreshed = await this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v.id = ${vehicleId}`, Prisma.sql`v.id ASC`)}`
        const current = refreshed[0] ?? v
        this.edgeGateway.sendToBuilding(
          v.buildingId,
          'PLATE_UPSERT',
          await vehiclePlateSyncPayload(this.prisma, current),
        )
      }
    }
    const rows = await this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v.id = ${vehicleId}`, Prisma.sql`v.id ASC`)}`
    return rows[0]
  }

  async deleteVehicle(vehicleId: number, residentId: number) {
    const existing = await this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v.id = ${vehicleId} AND v."residentId" = ${residentId}`, Prisma.sql`v.id ASC`)}`
    const v = existing[0]
    if (!v) throw new NotFoundException()
    await this.prisma.$executeRaw`DELETE FROM "vehicles" WHERE id = ${vehicleId} AND "residentId" = ${residentId}`
    // LPR DELETE tylko gdy pojazd faktycznie był w allowlist (APPROVED).
    // Inaczej nie ma czego kasować — Edge nigdy nie dostał PLATE_UPSERT-a.
    if (v.status === 'APPROVED') {
      this.syncPlateToEdge(v.buildingId, 'DELETE', { plate: v.licensePlate })
    }
    return { id: vehicleId }
  }

  /**
   * Push a plate change to every Edge tunnel connected for this building.
   * Fire-and-forget — any LPR camera registered on the Edge will be updated.
   * If no Edge is connected the change is silently queued (picked up on reconnect
   * via PLATE_SYNC_ALL — TODO).
   *
   * UWAGA na nazewnictwo: Edge używa `validUntil` (nie `validTo`), zgodnie
   * z `PlateEntry` z `hikvision-lpr.service.ts`. Cloud DB trzyma `validTo` —
   * tłumaczymy tu, żeby reszta kodu nie musiała znać Edge-owej konwencji.
   */
  private syncPlateToEdge(
    buildingId: number,
    op: 'UPSERT' | 'DELETE',
    payload: {
      plate: string
      owner?: string
      validFrom?: Date | string | null
      validTo?: Date | string | null
      /** 2026-07-08 — id gościa dla tablic gości. Edge zapisuje w
       *  lpr_plates.guest_id i sprawdza po nim ograniczenia (harmonogram/
       *  limit/allowlista AP). Stary Edge ignoruje pole. */
      guestId?: number
    },
  ) {
    const action = op === 'UPSERT' ? 'PLATE_UPSERT' : 'PLATE_DELETE'
    const out: Record<string, any> = { plate: payload.plate }
    if (payload.owner !== undefined) out.owner = payload.owner
    if (op === 'UPSERT' && payload.guestId) out.guestId = payload.guestId
    if (op === 'UPSERT') {
      // ISO string-i — Edge akceptuje string|Date|null i sam parsuje przez `toMillis()`.
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
   * Mirror dla `syncPlateToEdge`, ale dla PIN-ów gości (Faza 2D — Akuvox).
   * Edge trzyma PIN-y w lokalnej tabeli `guest_pins`, walidacja domofonu
   * dzieje się offline. Cloud wystawia tylko źródło prawdy.
   *
   * Konwencja payloadu — taka sama jak `PLATE_UPSERT` (validFrom/validUntil
   * jako ISO string-i; Edge `IntercomPinService` parsuje przez `toMillis`).
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
      // Ograniczenia dostępu gościa (2026-07-08). Stary Edge ignoruje pola.
      allowedAccessPoints?: AllowedAccessPointEntry[] | null
      recurringSchedule?: RecurringSchedule | null
      /** Snapshot użyć PORTALOWYCH per AP ({"<apId>": n}) — Edge sumuje
       *  z lokalnymi użyciami PIN/LPR do egzekwowania limitu offline. */
      portalUses?: Record<string, number> | null
    },
  ) {
    const action = op === 'UPSERT' ? 'PIN_UPSERT' : 'PIN_DELETE'
    const out: Record<string, any> = {
      pin: payload.pin,
      guestId: payload.guestId,
    }
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
      // Klucze zawsze obecne (null = jawny brak ograniczeń) — Edge nadpisuje
      // pole tylko gdy klucz JEST w payloadzie; brak klucza (stary Cloud /
      // senderzy BA-concierge bez ograniczeń) = zachowaj obecny stan.
      out.allowedAccessPoints = payload.allowedAccessPoints ?? null
      out.recurringSchedule = payload.recurringSchedule ?? null
      out.portalUses = payload.portalUses ?? null
    }
    this.edgeGateway.sendToBuilding(buildingId, action, out)
  }

  /**
   * Snapshot użyć PORTALOWYCH gościa per AP — {"<apId>": n}. Tylko
   * source='PORTAL': użycia PIN/LPR Edge liczy sam lokalnie (jest ich
   * źródłem) — wysyłanie ich z powrotem zdublowałoby licznik.
   */
  private async portalUsesFor(guestId: number): Promise<Record<string, number>> {
    const rows = await this.prisma.$queryRaw<{ accessPointId: number | null; count: bigint }[]>`
      SELECT "accessPointId", COUNT(*)::bigint AS count
        FROM "guest_access_uses"
       WHERE "guestId" = ${guestId} AND source = 'PORTAL'
       GROUP BY "accessPointId"
    `
    const out: Record<string, number> = {}
    for (const r of rows) {
      if (r.accessPointId !== null) out[String(r.accessPointId)] = Number(r.count)
    }
    return out
  }

  /** Agregat zużycia (wszystkie source'y) dla listy gości — do odpowiedzi API. */
  private async accessUsesFor(
    guestIds: number[],
  ): Promise<Map<number, { accessPointId: number | null; count: number }[]>> {
    const map = new Map<number, { accessPointId: number | null; count: number }[]>()
    if (guestIds.length === 0) return map
    const rows = await this.prisma.$queryRaw<
      { guestId: number; accessPointId: number | null; count: bigint }[]
    >`
      SELECT "guestId", "accessPointId", COUNT(*)::bigint AS count
        FROM "guest_access_uses"
       WHERE "guestId" IN (${Prisma.join(guestIds)})
       GROUP BY "guestId", "accessPointId"
    `
    for (const r of rows) {
      const list = map.get(r.guestId) ?? []
      list.push({ accessPointId: r.accessPointId, count: Number(r.count) })
      map.set(r.guestId, list)
    }
    return map
  }

  /**
   * Walidacja DTO ograniczeń gościa (2026-07-08). Zwraca sparsowane wartości
   * gotowe do JSONB. AP z allowlisty muszą istnieć w budynku, być aktywne
   * i nie-ADMIN_ONLY (gość nigdy nie dostaje więcej niż mieszkaniec widzi).
   */
  private async parseGuestRestrictionsDto(
    buildingId: number,
    dto: { allowedAccessPoints?: unknown; recurringSchedule?: unknown },
  ): Promise<{
    allowedAccessPoints: AllowedAccessPointEntry[] | null
    recurringSchedule: RecurringSchedule | null
  }> {
    let allowed: AllowedAccessPointEntry[] | null = null
    let schedule: RecurringSchedule | null = null
    try {
      allowed = parseAllowedAccessPoints(dto.allowedAccessPoints)
      schedule = parseRecurringSchedule(dto.recurringSchedule)
    } catch (err: any) {
      throw new BadRequestException(err.message)
    }
    if (allowed && allowed.length > 0) {
      const ids = allowed.map((a) => a.apId)
      const rows = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT id FROM "access_points"
         WHERE "buildingId" = ${buildingId}
           AND id IN (${Prisma.join(ids)})
           AND "isActive" = true
           AND scope != 'ADMIN_ONLY'
      `
      const found = new Set(rows.map((r) => r.id))
      const missing = ids.filter((id) => !found.has(id))
      if (missing.length > 0) {
        throw new BadRequestException(
          `Wejście #${missing.join(', #')} nie istnieje w tym budynku lub jest niedostępne dla gości`,
        )
      }
    }
    return { allowedAccessPoints: allowed, recurringSchedule: schedule }
  }

  // ── Goście (Faza 2 bety Villa Natura) ────────────────────────────────────
  //
  // Mieszkaniec zaprasza gościa na okno czasowe (`validFrom..validTo`).
  // Gość dostaje 6-cyfrowy PIN do domofonu (Akuvox — Faza 2D), opcjonalnie
  // podaje tablicę → idzie do allowlist LPR na czas pobytu.
  //
  // Status:
  //   ACTIVE     — walidny w oknie
  //   EXPIRED    — po validTo (cron — Faza 2B/3)
  //   CANCELLED  — odwołany ręcznie przez mieszkańca
  //
  // PIN: 6-cyfrowy random, unikalny w obrębie aktywnych gości w budynku
  // (różne budynki mogą mieć ten sam PIN — `(buildingId, pin)` index).

  async getGuests(residentId: number): Promise<GuestRow[]> {
    await this.requireResidentFeatureByResidentId(residentId, 'guests')
    const rows = await this.prisma.$queryRaw<GuestRow[]>`
      SELECT id, "buildingId", "residentId", name, phone, "vehiclePlate",
             pin, "validFrom", "validTo", status::text AS status,
             "usedAt", "notifyOnUse", "createdAt", "urlToken", email, "emailSentAt",
             "allowedAccessPoints", "recurringSchedule"
        FROM "guests"
       WHERE "residentId" = ${residentId}
       ORDER BY "validFrom" DESC, id DESC
    `
    // Zużycie limitowanych otwarć — iOS pokazuje „zostały 2 otwarcia".
    const uses = await this.accessUsesFor(rows.map((r) => r.id)).catch(
      () => new Map<number, { accessPointId: number | null; count: number }[]>(),
    )
    for (const r of rows) r.accessUses = uses.get(r.id) ?? []
    return rows
  }

  async createGuest(
    residentId: number,
    buildingId: number,
    dto: {
      name: string
      phone?: string
      vehiclePlate?: string
      validFrom?: string
      validTo: string
      // Pivot bezkontaktowy: jeśli mieszkaniec poda email, gość dostanie
      // mailem link do portalu (`gatelynk.com/g/<token>`). Bez emaila —
      // urlToken nadal generujemy, iOS i tak wyśle SMS lokalnie z linkiem.
      email?: string
      // false = bez pushy o aktywności tego gościa (2026-08-14, domyślnie true).
      notifyOnUse?: boolean
      // Ograniczenia dostępu (2026-07-08) — addytywne, opcjonalne:
      //   allowedAccessPoints: [{apId, maxUses?}] — tylko te wejścia,
      //   recurringSchedule: {days, startTime, endTime, tz} — okno cykliczne.
      allowedAccessPoints?: unknown
      recurringSchedule?: unknown
    },
  ): Promise<GuestRow> {
    await this.requireResidentFeature(buildingId, 'guests')
    const restrictions = await this.parseGuestRestrictionsDto(buildingId, dto)
    const name = (dto.name ?? '').trim()
    if (!name) throw new BadRequestException('Imię gościa nie może być puste')
    if (!dto.validTo) throw new BadRequestException('Brakuje validTo')

    const validFrom = dto.validFrom ? new Date(dto.validFrom) : new Date()
    const validTo = new Date(dto.validTo)
    if (Number.isNaN(validFrom.getTime()) || Number.isNaN(validTo.getTime())) {
      throw new BadRequestException('Nieprawidłowy format daty')
    }
    if (validTo <= validFrom) {
      throw new BadRequestException('Data końcowa musi być po początkowej')
    }
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
    if (validTo.getTime() - validFrom.getTime() > THIRTY_DAYS_MS) {
      throw new BadRequestException('Maksymalny okres zaproszenia to 30 dni')
    }

    const plate = dto.vehiclePlate?.trim().toUpperCase() || null
    // Anty-stalking (2026-08-12): tablica zarejestrowanego pojazdu osiedla
    // nie może być tablicą gościa — szczegóły w guest-plate-guard.ts.
    await assertGuestPlateAllowed(this.prisma, buildingId, plate)
    const phone = dto.phone?.trim() || null

    // Email walidujemy luźno (najprostszy regex — Resend i tak odrzuci
    // nieprawidłowe). Pusty string traktujemy jako brak.
    const emailRaw = dto.email?.trim() ?? ''
    const email = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)
      ? emailRaw.toLowerCase()
      : null
    if (emailRaw && !email) {
      throw new BadRequestException('Nieprawidłowy format adresu e-mail')
    }

    const pin = await this.generateUniqueGuestPin(buildingId)
    // 32 random bytes → 64 hex char-y → 256-bit entropia. Nieodgadywalne,
    // safe-do-URL bez encodowania. Unikalność per-tabela wymuszona przez
    // partial unique index (`urlToken_key WHERE urlToken IS NOT NULL`).
    const urlToken = crypto.randomBytes(32).toString('hex')

    const resident = await this.prisma.resident.findUnique({
      where: { id: residentId },
      select: { firstName: true, lastName: true },
    })

    const [row] = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "guests"
        ("buildingId", "residentId", "name", "phone", "vehiclePlate",
         "pin", "validFrom", "validTo", "status",
         "urlToken", "email", "notifyOnUse", "allowedAccessPoints", "recurringSchedule")
      VALUES (
        ${buildingId},
        ${residentId},
        ${name},
        ${phone},
        ${plate},
        ${pin},
        ${validFrom},
        ${validTo},
        'ACTIVE'::"GuestStatus",
        ${urlToken},
        ${email},
        ${dto.notifyOnUse !== false},
        ${restrictions.allowedAccessPoints !== null
          ? JSON.stringify(restrictions.allowedAccessPoints)
          : null}::jsonb,
        ${restrictions.recurringSchedule !== null
          ? JSON.stringify(restrictions.recurringSchedule)
          : null}::jsonb
      )
      RETURNING id
    `

    const inviter = resident
      ? `${resident.firstName} ${resident.lastName}`.trim()
      : 'mieszkaniec'
    // PIN idzie do Edge PRZED tablicą — flow LPR na Edge czyta ograniczenia
    // gościa z guest_pins (po guest_id), więc wpis PIN-u musi istnieć zanim
    // tablica zacznie matchować. PIN zawsze jedzie — domofon pełni rolę
    // nawet gdy gość nie ma samochodu (pieszy przy bramie pieszej).
    this.syncPinToEdge(buildingId, 'UPSERT', {
      pin,
      guestId: row.id,
      guestName: name,
      validFrom,
      validTo,
      allowedAccessPoints: restrictions.allowedAccessPoints,
      recurringSchedule: restrictions.recurringSchedule,
      portalUses: null, // świeży gość — zero użyć
    })
    // Opcjonalna tablica → allowlist LPR na czas pobytu. Owner-em jest sam
    // gość, prefiksowany "Gość:" + nazwiskiem zapraszającego — daje to
    // czytelny ślad w logach koncierża (LPR_READ). guestId → Edge sprawdza
    // po nim ograniczenia (harmonogram/limit/allowlista AP) przy matchu.
    if (plate) {
      this.syncPlateToEdge(buildingId, 'UPSERT', {
        plate,
        owner: `Gość ${name} (${inviter})`,
        validFrom,
        validTo,
        guestId: row.id,
      })
    }

    // Wyślij mail do gościa (jeśli podany email). Fire-and-forget — porażka
    // wysyłki NIE blokuje stworzenia gościa (mieszkaniec może i tak wysłać
    // SMS-em z telefonu jako fallback). Po sukcesie ustawiamy `emailSentAt`
    // żeby UI mogło pokazać „wysłano email" badge.
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

    const rows = await this.prisma.$queryRaw<GuestRow[]>`
      SELECT id, "buildingId", "residentId", name, phone, "vehiclePlate",
             pin, "validFrom", "validTo", status::text AS status,
             "usedAt", "notifyOnUse", "createdAt", "urlToken", email, "emailSentAt",
             "allowedAccessPoints", "recurringSchedule"
        FROM "guests"
       WHERE id = ${row.id}
    `
    rows[0].accessUses = []
    return rows[0]
  }

  async updateGuest(
    guestId: number,
    residentId: number,
    dto: {
      name?: string
      phone?: string | null
      vehiclePlate?: string | null
      validFrom?: string
      validTo?: string
      // undefined = bez zmian; true/false = przełącz pushe o aktywności.
      notifyOnUse?: boolean
      // Ograniczenia (2026-07-08): undefined = nie ruszamy, null = czyścimy
      // (jak phone/vehiclePlate), wartość = walidacja + zapis.
      allowedAccessPoints?: unknown
      recurringSchedule?: unknown
    },
  ): Promise<GuestRow> {
    const existing = await this.prisma.$queryRaw<GuestRow[]>`
      SELECT id, "buildingId", "residentId", name, phone, "vehiclePlate",
             pin, "validFrom", "validTo", status::text AS status,
             "usedAt", "notifyOnUse", "createdAt", "urlToken", email, "emailSentAt",
             "allowedAccessPoints", "recurringSchedule"
        FROM "guests"
       WHERE id = ${guestId} AND "residentId" = ${residentId}
    `
    const g = existing[0]
    if (!g) throw new NotFoundException()
    // Komunikat zależny od stanu — daje iOS / web pewność co się stało
    // (stale lista vs guest faktycznie wygasł), bez zgadywania po stronie UI.
    if (g.status === 'CANCELLED') {
      throw new BadRequestException('To zaproszenie zostało anulowane. Zaproś gościa ponownie.')
    }
    if (g.status === 'EXPIRED' || g.validTo <= new Date()) {
      throw new BadRequestException('Zaproszenie wygasło. Zaproś gościa ponownie.')
    }
    if (g.status !== 'ACTIVE') {
      throw new BadRequestException('Można edytować tylko aktywne zaproszenia')
    }

    const nextName = dto.name?.trim() ?? g.name
    if (!nextName) throw new BadRequestException('Imię gościa nie może być puste')

    // `phone` — null = jawne wyczyszczenie; undefined = nie ruszamy.
    const nextPhone = dto.phone === undefined
      ? g.phone
      : (dto.phone?.trim() || null)

    // Tablica: pusty string lub null = pieszy (usuwamy tablicę).
    let nextPlate: string | null
    if (dto.vehiclePlate === undefined) {
      nextPlate = g.vehiclePlate
    } else {
      const trimmed = dto.vehiclePlate?.trim().toUpperCase() || null
      nextPlate = trimmed
    }
    // Anty-stalking: także przy edycji — inaczej dodanie gościa „pieszego"
    // i dopisanie tablicy PATCH-em omijałoby blokadę z createGuest.
    if (nextPlate && nextPlate !== g.vehiclePlate) {
      await assertGuestPlateAllowed(this.prisma, g.buildingId, nextPlate)
    }

    const nextFrom = dto.validFrom ? new Date(dto.validFrom) : g.validFrom
    const nextTo = dto.validTo ? new Date(dto.validTo) : g.validTo
    if (Number.isNaN(nextFrom.getTime()) || Number.isNaN(nextTo.getTime())) {
      throw new BadRequestException('Nieprawidłowy format daty')
    }
    if (nextTo <= nextFrom) {
      throw new BadRequestException('Data końcowa musi być po początkowej')
    }
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
    if (nextTo.getTime() - nextFrom.getTime() > THIRTY_DAYS_MS) {
      throw new BadRequestException('Maksymalny okres zaproszenia to 30 dni')
    }

    // Ograniczenia: undefined = zachowaj obecne; null/wartość = nadpisz.
    let nextAllowed = g.allowedAccessPoints ?? null
    let nextSchedule = g.recurringSchedule ?? null
    if (dto.allowedAccessPoints !== undefined || dto.recurringSchedule !== undefined) {
      const parsed = await this.parseGuestRestrictionsDto(g.buildingId, {
        allowedAccessPoints:
          dto.allowedAccessPoints === undefined ? g.allowedAccessPoints : dto.allowedAccessPoints,
        recurringSchedule:
          dto.recurringSchedule === undefined ? g.recurringSchedule : dto.recurringSchedule,
      })
      nextAllowed = parsed.allowedAccessPoints
      nextSchedule = parsed.recurringSchedule
    }

    const nextNotify = dto.notifyOnUse === undefined ? g.notifyOnUse : dto.notifyOnUse
    await this.prisma.$executeRaw`
      UPDATE "guests" SET
        "name"         = ${nextName},
        "phone"        = ${nextPhone},
        "vehiclePlate" = ${nextPlate},
        "validFrom"    = ${nextFrom},
        "validTo"      = ${nextTo},
        "notifyOnUse"  = ${nextNotify},
        "allowedAccessPoints" = ${nextAllowed !== null ? JSON.stringify(nextAllowed) : null}::jsonb,
        "recurringSchedule"   = ${nextSchedule !== null ? JSON.stringify(nextSchedule) : null}::jsonb
      WHERE id = ${guestId} AND "residentId" = ${residentId}
    `

    // LPR sync — uwzględnia 4 scenariusze:
    //   stara=null, nowa=null → nic
    //   stara=null, nowa=X    → UPSERT
    //   stara=X,    nowa=null → DELETE
    //   stara=X,    nowa=Y    → DELETE starej + UPSERT nowej
    //   stara=X,    nowa=X    → UPSERT (re-sync; np. zmiana okna czasowego)
    const resident = await this.prisma.resident.findUnique({
      where: { id: residentId },
      select: { firstName: true, lastName: true },
    })
    const inviter = resident
      ? `${resident.firstName} ${resident.lastName}`.trim()
      : 'mieszkaniec'

    // PIN najpierw (Edge czyta ograniczenia z guest_pins przy matchu tablicy),
    // potem tablica. PIN zostaje ten sam (nie regenerujemy przy update), ale
    // okno / nazwa / ograniczenia mogły się zmienić → re-sync upsert z pełnym
    // stanem (w tym snapshot użyć portalowych — Edge liczy limit offline).
    const portalUses = await this.portalUsesFor(g.id).catch(() => ({}))
    this.syncPinToEdge(g.buildingId, 'UPSERT', {
      pin: g.pin,
      guestId: g.id,
      guestName: nextName,
      validFrom: nextFrom,
      validTo: nextTo,
      allowedAccessPoints: nextAllowed,
      recurringSchedule: nextSchedule,
      portalUses,
    })
    if (g.vehiclePlate && g.vehiclePlate !== nextPlate) {
      this.syncPlateToEdge(g.buildingId, 'DELETE', { plate: g.vehiclePlate })
    }
    if (nextPlate) {
      this.syncPlateToEdge(g.buildingId, 'UPSERT', {
        plate: nextPlate,
        owner: `Gość ${nextName} (${inviter})`,
        validFrom: nextFrom,
        validTo: nextTo,
        guestId: g.id,
      })
    }

    const rows = await this.prisma.$queryRaw<GuestRow[]>`
      SELECT id, "buildingId", "residentId", name, phone, "vehiclePlate",
             pin, "validFrom", "validTo", status::text AS status,
             "usedAt", "notifyOnUse", "createdAt", "urlToken", email, "emailSentAt",
             "allowedAccessPoints", "recurringSchedule"
        FROM "guests"
       WHERE id = ${guestId}
    `
    const uses = await this.accessUsesFor([guestId]).catch(
      () => new Map<number, { accessPointId: number | null; count: number }[]>(),
    )
    rows[0].accessUses = uses.get(guestId) ?? []
    return rows[0]
  }

  async cancelGuest(guestId: number, residentId: number) {
    const existing = await this.prisma.$queryRaw<GuestRow[]>`
      SELECT id, "buildingId", "residentId", name, phone, "vehiclePlate",
             pin, "validFrom", "validTo", status::text AS status,
             "usedAt", "notifyOnUse", "createdAt", "urlToken", email, "emailSentAt"
        FROM "guests"
       WHERE id = ${guestId} AND "residentId" = ${residentId}
    `
    const g = existing[0]
    if (!g) throw new NotFoundException()

    // ── HARD DELETE dla zakończonych gości (2026-05-22) ──────────────
    // Gdy gość: (a) jest CANCELLED, (b) status=EXPIRED, (c) validTo minął,
    // ten sam endpoint robi hard delete — iOS używa go żeby usunąć wpis
    // z historii po swipe-to-delete. GuestEvent/AccessEvent mają
    // onDelete: SetNull → FK przetrzymują nawet po usunięciu Guest row.
    // Bezpieczne. Sync LPR/PIN nie potrzebny — cron już posprzątał
    // EXPIRED, CANCELLED dostał sync przy poprzednim cancel.
    const now = Date.now()
    const isExpired = new Date(g.validTo).getTime() <= now
    const isFinished = g.status === 'CANCELLED' || g.status === 'EXPIRED' || isExpired
    if (isFinished) {
      await this.prisma.$executeRaw`
        DELETE FROM "guests"
         WHERE id = ${guestId} AND "residentId" = ${residentId}
      `
      return { ...g, deleted: true }
    }

    await this.prisma.$executeRaw`
      UPDATE "guests"
         SET status = 'CANCELLED'::"GuestStatus"
       WHERE id = ${guestId} AND "residentId" = ${residentId}
    `

    // Tylko ACTIVE gość był w allowlist LPR — EXPIRED już został usunięty
    // przez crona (Faza 2B), a CANCELLED odbijamy wcześniej.
    if (g.status === 'ACTIVE' && g.vehiclePlate) {
      this.syncPlateToEdge(g.buildingId, 'DELETE', { plate: g.vehiclePlate })
    }
    // PIN — analogicznie, ACTIVE → kasujemy z `guest_pins` na Edge
    // (EXPIRED już posprzątał cron, CANCELLED nigdy nie trafia tu drugi raz).
    if (g.status === 'ACTIVE' && g.pin) {
      this.syncPinToEdge(g.buildingId, 'DELETE', { pin: g.pin, guestId: g.id })
    }

    // 2026-09-21 (audyt UX, P0 3.3) — prawda o propagacji cofnięcia.
    // Cloud odrzuca PIN/link/tablicę OD RAZU (status CANCELLED). Edge waliduje
    // PIN i tablicę OFFLINE-first z lokalnej kopii — usunięcie jedzie przez
    // trwały outbox: przy połączonym Edge natychmiast, przy rozłączonym po
    // reconnect. Klient dostaje `edgeOnline`, żeby NIE ogłaszać pełnego
    // cofnięcia, gdy sterownik osiedla jest offline (PIN na klawiaturze może
    // wtedy działać do czasu ponownego połączenia).
    const edgeOnline = !!this.edgeGateway.getEdgeIpForBuilding(g.buildingId)

    return { ...g, status: 'CANCELLED' as const, revocation: { edgeOnline } }
  }

  /**
   * 6-cyfrowy PIN unikalny w obrębie ACTIVE gości w danym budynku.
   * Po max 8 próbach poddaje się — w praktyce 10⁶ przestrzeni vs garstka
   * aktywnych gości daje kolizję praktycznie zerową.
   */
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

  // ── Push Tokens ───────────────────────────────────────────────────────────

  async registerPushToken(
    residentId: number,
    token: string,
    environment: 'production' | 'development' = 'production',
    bundleId?: string,
  ) {
    return this.push.registerToken(residentId, token, environment, bundleId)
  }

  async unregisterPushToken(token: string) {
    return this.push.unregisterToken(token)
  }

  // ── Access Points (intercoms / gates) ─────────────────────────────────────

  async getAccessPoints(buildingId: number, residentId?: number) {
    // Sync relay names / discover new devices from live Edge every time this is called.
    // Prefer live WS-connected IP; fall back to last-known IP from DB so sync works
    // even if the Edge reconnected after the API restarted.
    let ip: string | undefined = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    const edge = await this.prisma.edgeDevice.findFirst({
      where: { buildingId, isActivated: true },
      orderBy: { lastSeenAt: 'desc' },
    })
    if (!ip && edge?.ipAddress) ip = edge.ipAddress
    if (ip && edge) {
      // Debounce (2026-08-18): przy stampede otwarc ekranu glownego kazdy
      // request robil pelny sync Cloud<->Edge i BLOKOWAL odpowiedz (await).
      // Teraz: fire-and-forget, najwyzej raz na 30 s per budynek — interval
      // co 5 min w EdgeService i tak domyka spojnosc.
      const last = this.lastApSyncAt.get(buildingId) ?? 0
      if (Date.now() - last > 30_000) {
        this.lastApSyncAt.set(buildingId, Date.now())
        void this.edgeService.syncAccessPoints(edge.id, buildingId, ip).catch(() => {})
      }
    }

    const aps = await this.prisma.accessPoint.findMany({
      where: { buildingId, isActive: true },
      select: {
        id: true, label: true, icon: true, deviceId: true, relayIndex: true,
        sortOrder: true, category: true, unitId: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    })

    // 2026-07-08 (Nuki UNIT_DOOR): AP z `unitId` widzi WYŁĄCZNIE mieszkaniec
    // tego lokalu (aktywny pivot unit_residents). AP bez unitId = budynkowe,
    // jak dotąd. Brak residentId (defensywnie) → ukryj wszystkie unit-scoped.
    const myUnitIds = residentId ? await this.activeUnitIds(residentId, buildingId) : new Set<number>()
    const unitFiltered = aps.filter(
      (ap) => ap.unitId === null || myUnitIds.has(ap.unitId),
    )

    // FAZA e — filtruj AP po permissions dla resident role. Klucz `ap_<id>`.
    // Niezdefiniowany klucz = widoczny (defense: nie ukrywaj AP których
    // integrator nie skonfigurował).
    const perms = await this.loadFeaturePermissions(buildingId)
    return unitFiltered.filter((ap) => hasPermission(perms, 'resident', apKey(ap.id)))
  }

  /** Aktywne lokale mieszkańca (unit_residents, sinceDate<=NOW<untilDate). */
  private async activeUnitIds(residentId: number, buildingId: number): Promise<Set<number>> {
    const rows = await this.prisma.$queryRaw<{ unitId: number }[]>`
      SELECT ur."unitId"
        FROM unit_residents ur
        JOIN units u ON u.id = ur."unitId"
       WHERE ur."residentId" = ${residentId}
         AND u."buildingId" = ${buildingId}
         AND ur."sinceDate" <= NOW()
         AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
    `
    return new Set(rows.map((r) => r.unitId))
  }

  // ── Camera snapshot proxy ────────────────────────────────────────────────

  // ── Warm snapshoty (2026-08-18) ────────────────────────────────────────────
  // Kafle „Dostęp" w Glass pollują snapshoty per użytkownik. Przy stampede
  // (30% mieszkańców otwiera ekran naraz) każdy request szedł osobno przez
  // uplink osiedla do kasety R29 (handshake legacy-TLS 1–2 s na słabym CPU)
  // — kamera by się zatkała, a domofon dzieli z nią procesor. Trzy warstwy:
  //   1. RAM cache per AP (TTL: live 2 s, preview 25 s) — N userów = 1 fetch,
  //   2. koalescencja in-flight — równoległe requesty czekają na TEN SAM fetch,
  //   3. warmer co 25 s — klatka jest w RAM ZANIM ktokolwiek otworzy apkę
  //      (zero czekania na pierwszym renderze kafla).
  // SWR: żądanie nie-live ze stale cache dostaje stary obraz NATYCHMIAST,
  // a odświeżenie leci w tle. Błąd Edge → serwujemy ostatni dobry obraz.
  private readonly lastApSyncAt = new Map<number, number>()
  // Klucz: `${apId}:${w||0}` — osobne warianty rozmiaru (kafel w=720 vs pełna
  // klatka dla sheetu podglądu).
  private readonly snapCache = new Map<string, { buf: Buffer; ts: number }>()
  private readonly snapInflight = new Map<string, Promise<Buffer | null>>()
  private readonly snapFailTs = new Map<string, number>()
  /** Wariant kaflowy — grzany przez warmer, żądany przez deck w apce. */
  private static readonly TILE_W = 720
  private static readonly TILE_Q = 60
  private readonly logger2 = new Logger('SnapshotWarmer')

  private async fetchSnapshotBuffer(
    ap: { id: number; deviceId: string },
    buildingId: number,
    live: boolean,
    w?: number,
    q?: number,
  ): Promise<Buffer | null> {
    const key = `${ap.id}:${w ?? 0}`
    const existing = this.snapInflight.get(key)
    if (existing) return existing

    const p = (async (): Promise<Buffer | null> => {
      try {
        let ip: string | undefined = this.edgeGateway.getEdgeIpForBuilding(buildingId)
        if (!ip) {
          const edge = await this.prisma.edgeDevice.findFirst({
            where: { buildingId, isActivated: true },
            orderBy: { lastSeenAt: 'desc' },
          })
          ip = edge?.ipAddress ?? undefined
        }
        if (!ip) throw new Error('Edge niedostępny')

        // ?live=1 omija 60-sekundowy cache Edge; ?w/?q — downscale NA Edge
        // (sharp) zanim klatka pojedzie przez uplink osiedla.
        const params = new URLSearchParams()
        if (live) params.set('live', '1')
        if (w) { params.set('w', String(w)); params.set('q', String(q ?? 70)) }
        const qs = params.toString()
        const edgeUrl = `http://${ip}:4000/devices/${ap.deviceId}/snapshot${qs ? `?${qs}` : ''}`
        const edgeRes = await undiciFetch(edgeUrl, {
          signal: AbortSignal.timeout(8000),
          dispatcher: edgeDispatcher,
        })
        if (!edgeRes.ok) throw new Error(`Edge snapshot HTTP ${edgeRes.status}`)

        const contentType = edgeRes.headers.get('content-type') ?? ''
        const rawBuf = Buffer.from(await edgeRes.arrayBuffer())

        let buf: Buffer
        // Edge zwraca { snapshot: "data:image/jpeg;base64,..." } (JSON wrapper).
        const looksLikeJson = contentType.includes('application/json') ||
                              contentType.includes('text/') ||
                              rawBuf[0] === 0x7B // '{'
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

        // Pusta/śladowa odpowiedź (np. kaseta bez RTSP — Edge zwraca
        // { snapshot: "" }) = FAIL, nie klatka. Bez tego guardu 0-bajtowy
        // "obraz" trafiał do cache i był serwowany jako 200 (E2E 2026-08-18).
        if (buf.length < 128) throw new Error('empty snapshot')
        this.snapCache.set(key, { buf, ts: Date.now() })
        this.snapFailTs.delete(key)
        return buf
      } catch {
        this.snapFailTs.set(key, Date.now())
        return null
      } finally {
        this.snapInflight.delete(key)
      }
    })()

    this.snapInflight.set(key, p)
    return p
  }

  /**
   * Warmer: co 25 s odświeża klatkę każdego aktywnego AP w budynkach z Edge
   * ONLINE. Dzięki temu pierwszy render kafla w apce serwuje obraz z RAM
   * (~5 ms) zamiast czekać na kasetę. AP bez kamery (Nuki, przyciski) po
   * pierwszym failu odpuszczamy na 5 min (negative cache).
   */
  @Interval(25_000)
  async warmSnapshots() {
    const aps = await this.prisma.accessPoint.findMany({
      where: { isActive: true },
      select: { id: true, deviceId: true, buildingId: true },
    }).catch(() => [] as Array<{ id: number; deviceId: string | null; buildingId: number }>)

    for (const ap of aps) {
      if (!ap.deviceId) continue
      if (!this.edgeGateway.getEdgeIpForBuilding(ap.buildingId)) continue
      const key = `${ap.id}:${ResidentService.TILE_W}`
      const cached = this.snapCache.get(key)
      if (cached && Date.now() - cached.ts < 20_000) continue
      const failedAt = this.snapFailTs.get(key)
      if (failedAt && Date.now() - failedAt < 5 * 60_000) continue
      await this.fetchSnapshotBuffer(
        { id: ap.id, deviceId: ap.deviceId }, ap.buildingId, false,
        ResidentService.TILE_W, ResidentService.TILE_Q,
      )
    }
  }

  /**
   * 2026-08-19 — PEŁNA historia przejazdów pojazdu mieszkańca (kafelki
   * „Pojazdy" w Glass → szczegóły). access_events żyją dłużej niż lpr_reads
   * (30-dniowy TTL), więc to właściwe źródło. Prywatność: wyłącznie WŁASNY
   * pojazd (vehicle.residentId = JWT), inaczej 404.
   */
  async vehicleHistory(
    vehicleId: number,
    buildingId: number,
    residentId: number,
    limit = 200,
  ) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, buildingId, residentId },
      select: { id: true, licensePlate: true },
    })
    if (!vehicle) throw new NotFoundException('Pojazd nie istnieje')
    const { events, total } = await this.accessEvents.listForBuilding(buildingId, {
      plate: vehicle.licensePlate,
      limit: Math.max(1, Math.min(limit, 200)),
    })
    return { events, total }
  }

  async pipeSnapshot(
    accessPointId: number,
    buildingId: number,
    res: import('express').Response,
    live = true,
    w?: number,
    q?: number,
  ) {
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: accessPointId, buildingId, isActive: true },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    const send = (buf: Buffer) => {
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'no-store, no-cache')
      res.setHeader('Content-Length', buf.length)
      res.end(buf)
    }

    const cached = this.snapCache.get(`${ap.id}:${w ?? 0}`)
    const ttl = live ? 2_000 : 25_000

    // Świeży cache → z RAM, bez dotykania Edge/kamery.
    if (cached && Date.now() - cached.ts < ttl) return send(cached.buf)

    // SWR dla nie-live: stary obraz natychmiast, refresh w tle.
    if (!live && cached) {
      void this.fetchSnapshotBuffer(ap as { id: number; deviceId: string }, buildingId, false, w, q)
      return send(cached.buf)
    }

    const buf = await this.fetchSnapshotBuffer(
      ap as { id: number; deviceId: string }, buildingId, live, w, q,
    )
    if (buf) return send(buf)
    // Błąd pobrania — lepszy ostatni dobry obraz niż 502 (kafel nie mruga).
    if (cached) return send(cached.buf)
    throw new BadGatewayException('Snapshot niedostępny')
  }

  /**
   * Live MJPEG z kamery domofonu (2026-08-12). Pipe 1:1 z Edge —
   * `multipart/x-mixed-replace` płynie do apki tak długo, jak sheet
   * podglądu jest otwarty. Zasoby pilnowane z obu stron: zamknięcie
   * klienta ubija fetch do Edge (AbortController na res 'close'),
   * a twardy limit 5 min chroni przed strumieniem-zombie, gdyby apka
   * zniknęła bez FIN (np. utrata zasięgu) — po limicie apka i tak
   * wraca do pollingu snapshotów i może otworzyć strumień ponownie.
   */
  async pipeVideoStream(
    accessPointId: number,
    buildingId: number,
    res: import('express').Response,
  ) {
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

    const ac = new AbortController()
    const killer = setTimeout(() => ac.abort(), 5 * 60_000)
    res.on('close', () => ac.abort())

    try {
      const edgeRes = await undiciFetch(`http://${ip}:4000/devices/${ap.deviceId}/stream`, {
        signal: ac.signal,
        dispatcher: edgeDispatcher,
        // Bez AbortSignal.timeout — strumień ma żyć; limit daje `killer`.
      })
      if (!edgeRes.ok || !edgeRes.body) {
        throw new Error(`Edge stream HTTP ${edgeRes.status}`)
      }

      res.setHeader(
        'Content-Type',
        edgeRes.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=mjpegframe',
      )
      res.setHeader('Cache-Control', 'no-store, no-cache')
      res.flushHeaders()

      for await (const chunk of edgeRes.body) {
        // Backpressure: nie zalewamy wolnego klienta (LTE) buforem serwera.
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r))
      }
      res.end()
    } catch (err: any) {
      // Abort (klient zamknął sheet / limit 5 min) to normalne zakończenie.
      if (!res.headersSent) {
        throw new BadGatewayException(`Stream niedostępny: ${err.message}`)
      }
      res.end()
    } finally {
      clearTimeout(killer)
    }
  }

  async openAccessPoint(accessPointId: number, buildingId: number, residentId: number) {
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: accessPointId, buildingId, isActive: true },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')

    // 2026-07-08 (Nuki UNIT_DOOR): AP przypisany do lokalu może otworzyć
    // WYŁĄCZNIE mieszkaniec tego lokalu. 404 (nie 403) — nie zdradzamy
    // istnienia cudzych zamków (spójnie z filtrem w getAccessPoints).
    if (ap.unitId !== null) {
      const myUnits = await this.activeUnitIds(residentId, buildingId)
      if (!myUnits.has(ap.unitId)) {
        throw new NotFoundException('Punkt dostępu nie istnieje')
      }
    }

    // FAZA e — per-AP permission. Jeśli integrator wyłączył AP dla resident
    // role → 403 (mimo że AP jest aktywne fizycznie). Backend defense-in-depth
    // bo `getAccessPoints` już filtruje, ale ktoś może zachować stary cache.
    const perms = await this.loadFeaturePermissions(buildingId)
    if (!hasPermission(perms, 'resident', apKey(ap.id))) {
      throw new ForbiddenException({
        message: FEATURE_DISABLED_MESSAGE,
        code: FEATURE_DISABLED_CODE,
        accessPointId: ap.id,
      })
    }

    // Resolve Edge IP — live connection first, DB fallback
    let ip: string | undefined = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      const edge = await this.prisma.edgeDevice.findFirst({
        where: { buildingId, isActivated: true },
        orderBy: { lastSeenAt: 'desc' },
      })
      ip = edge?.ipAddress ?? undefined
    }
    if (!ip) throw new BadGatewayException('Brak połączenia z bramką — spróbuj ponownie')

    // UNIT_DOOR (Nuki Web API na Edge) potrzebuje dłuższego timeoutu —
    // Edge→Nuki cloud ma własny 10 s.
    const isUnitDoor = ap.category === 'UNIT_DOOR'
    const auditMeta = { source: 'resident-app', ...(isUnitDoor ? { provider: 'nuki' } : {}) }

    try {
      const res = await undiciFetch(`http://${ip}:4000/devices/${ap.deviceId}/relay/${ap.relayIndex}`, {
        method: 'POST',
        signal: AbortSignal.timeout(isUnitDoor ? 12_000 : 8000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      // Faza 3: AccessEvent audit (REMOTE_OPEN). Fire-and-forget.
      this.accessEvents.record({
        buildingId,
        type: 'REMOTE_OPEN',
        accessPointId: ap.id,
        gateOpened: true,
        residentId,
        openedById: residentId,
        openedByType: 'RESIDENT',
        meta: auditMeta,
      }).catch(() => { /* logged inside */ })

      return { success: true, label: ap.label }
    } catch (err: any) {
      // Audit także przy błędzie (gateOpened=false) — żeby admin widział że
      // mieszkaniec próbował, ale Edge zwrócił error.
      this.accessEvents.record({
        buildingId,
        type: 'REMOTE_OPEN',
        accessPointId: ap.id,
        gateOpened: false,
        reason: err?.message ?? 'unknown',
        residentId,
        openedById: residentId,
        openedByType: 'RESIDENT',
        meta: auditMeta,
      }).catch(() => { /* logged inside */ })
      throw new BadGatewayException(`Błąd otwarcia: ${err.message}`)
    }
  }

  // ── PAYMENTS ──────────────────────────────────────────────────────────────────

  async getMyPayments(residentId: number, buildingId: number) {
    await this.requireResidentFeature(buildingId, 'payments')
    type UrRow = { unitId: number; unitNumber: string }
    const unitRows = await this.prisma.$queryRaw<UrRow[]>`
      SELECT ur."unitId", u.number AS "unitNumber"
      FROM unit_residents ur
      JOIN units u ON u.id = ur."unitId"
      WHERE ur."residentId" = ${residentId}
        AND u."buildingId" = ${buildingId}
        AND ur."sinceDate" <= NOW()
        AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
      LIMIT 1
    `
    if (unitRows.length === 0) return { unitNumber: null, balance: 0, config: null, entries: [] }

    const { unitId, unitNumber } = unitRows[0]

    type ConfigRow = { monthlyRent: any; dueDay: number; openingBalance: any; openingDate: Date }
    const cfg = await this.prisma.$queryRaw<ConfigRow[]>`
      SELECT "monthlyRent", "dueDay", "openingBalance", "openingDate"
      FROM payment_configs WHERE "unitId" = ${unitId}
    `

    type EntryRow = { id: number; amount: any; type: string; date: Date; description: string | null; source: string | null }
    const entries = await this.prisma.$queryRaw<EntryRow[]>`
      SELECT id, amount, type, date, description, source
      FROM payment_entries WHERE "unitId" = ${unitId}
      ORDER BY date DESC, id DESC
      LIMIT 200
    `

    const opening = Number(cfg[0]?.openingBalance ?? 0)
    const sumResult = await this.prisma.$queryRaw<{ total: any }[]>`
      SELECT COALESCE(SUM(amount), 0) AS total FROM payment_entries WHERE "unitId" = ${unitId}
    `
    const balance = opening + Number(sumResult[0]?.total ?? 0)

    // 2026-07-03 — naliczenie bieżącego miesiąca (składowe + termin + status)
    // dla rozszerzonego widoku w iOS. Fail-silent: starsza baza bez tabeli
    // payment_charges nie może wywalić całego endpointu.
    let currentCharge: {
      period: string
      totalAmount: number
      dueDate: Date
      components: unknown
      paidAmount: number
      status: 'PAID' | 'PARTIAL' | 'UNPAID' | 'OVERDUE'
      daysOverdue: number
    } | null = null
    try {
      const now = new Date()
      const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
      const charge = await this.prisma.paymentCharge.findUnique({
        where: { unitId_period: { unitId, period } },
      })
      if (charge) {
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
        const payments = await this.prisma.paymentEntry.findMany({
          where: {
            unitId,
            type: 'PAYMENT',
            OR: [{ chargeId: charge.id }, { chargeId: null, date: { gte: monthStart, lt: monthEnd } }],
          },
          select: { amount: true },
        })
        const paidAmount = Math.round(payments.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100
        const total = Number(charge.totalAmount)
        // Status wyliczany wspólnym helperem (payments-admin.service) — jedna
        // logika dla raportu BA i widoku mieszkańca.
        const { status, daysOverdue } = computeChargeStatus(total, paidAmount, charge.dueDate, now)
        currentCharge = {
          period,
          totalAmount: total,
          dueDate: charge.dueDate,
          components: charge.components,
          paidAmount,
          status,
          daysOverdue,
        }
      }
    } catch {
      currentCharge = null
    }

    // Gdy lokal nie ma własnego payment_config, syntetyzujemy go z globalnej
    // konfiguracji budynku: czynsz = bieżące naliczenie (składowe), termin
    // z payment_settings.dueDay. Dzięki temu iOS pokazuje „termin do X. dnia"
    // bez ręcznego ustawiania konfiguracji per lokal.
    let effectiveConfig: {
      monthlyRent: number
      dueDay: number
      openingBalance: number
      openingDate: Date | null
    } | null = cfg[0]
      ? { ...cfg[0], monthlyRent: Number(cfg[0].monthlyRent), openingBalance: Number(cfg[0].openingBalance) }
      : null
    if (!effectiveConfig && currentCharge) {
      const settingsRow = await this.prisma.$queryRaw<{ dueDay: number }[]>`
        SELECT "dueDay" FROM payment_settings WHERE "buildingId" = ${buildingId}
      `
      effectiveConfig = {
        monthlyRent: currentCharge.totalAmount,
        dueDay: settingsRow[0]?.dueDay ?? 10,
        openingBalance: 0,
        openingDate: null,
      }
    }

    return {
      unitNumber,
      balance,
      config: effectiveConfig,
      entries: entries.map(e => ({ ...e, amount: Number(e.amount) })),
      currentCharge,
    }
  }

  /**
   * 2026-07-04 — archiwum naliczeń mieszkańca (GET /resident/payments/charges).
   *
   * Zwraca naliczenia lokalu mieszkańca za ostatnie N miesięcy (clamp 1–24,
   * default 12), DESC po period. Per naliczenie: składowe ze snapshotu, status
   * (wspólny helper computeChargeStatus z payments-admin.service), suma wpłat
   * (linkowane chargeId + legacy nieprzypisane po dacie w okresie — spójnie
   * z raportem miesięcznym BA) i lista wpłat.
   *
   * Fail-soft: mieszkaniec bez lokalu / budynek bez konfiguracji → pusta lista
   * + flaga `configured` (czy budynek ma jakiekolwiek aktywne składowe albo
   * naliczenia) — iOS używa jej do empty-state „zarządca nie skonfigurował".
   *
   * Wydajność: stałe 3–4 zapytania (unit → charges → payments [→ configured
   * tylko gdy brak naliczeń]), bez N+1 per miesiąc.
   */
  async getMyPaymentCharges(residentId: number, buildingId: number, monthsRaw?: number) {
    await this.requireResidentFeature(buildingId, 'payments')
    const months = Math.min(24, Math.max(1, Math.trunc(Number(monthsRaw)) || 12))

    const empty = { configured: false, unitNumber: null as string | null, charges: [] as never[] }

    try {
      // 1. Aktywny lokal mieszkańca (jak getMyPayments — pivot unit_residents)
      type UrRow = { unitId: number; unitNumber: string }
      const unitRows = await this.prisma.$queryRaw<UrRow[]>`
        SELECT ur."unitId", u.number AS "unitNumber"
        FROM unit_residents ur
        JOIN units u ON u.id = ur."unitId"
        WHERE ur."residentId" = ${residentId}
          AND u."buildingId" = ${buildingId}
          AND ur."sinceDate" <= NOW()
          AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
        LIMIT 1
      `
      if (unitRows.length === 0) {
        return { ...empty, configured: await this.buildingHasPaymentsConfigured(buildingId) }
      }
      const { unitId, unitNumber } = unitRows[0]

      // 2. Naliczenia za ostatnie N miesięcy (period "YYYY-MM" sortuje się
      //    leksykograficznie == chronologicznie)
      const now = new Date()
      const fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1))
      const fromPeriod = `${fromDate.getUTCFullYear()}-${String(fromDate.getUTCMonth() + 1).padStart(2, '0')}`
      const charges = await this.prisma.paymentCharge.findMany({
        where: { unitId, period: { gte: fromPeriod } },
        orderBy: { period: 'desc' },
      })

      if (charges.length === 0) {
        return {
          configured: await this.buildingHasPaymentsConfigured(buildingId),
          unitNumber,
          charges: [],
        }
      }

      // 3. Wpłaty JEDNYM zapytaniem: linkowane chargeId LUB legacy (chargeId
      //    NULL) z datą w całym oknie — przypisanie do miesiąca po dacie.
      const chargeIds = charges.map(c => c.id)
      const windowStart = fromDate
      const payments = await this.prisma.paymentEntry.findMany({
        where: {
          unitId,
          type: 'PAYMENT',
          OR: [{ chargeId: { in: chargeIds } }, { chargeId: null, date: { gte: windowStart } }],
        },
        select: { id: true, amount: true, date: true, source: true, description: true, chargeId: true },
        orderBy: { date: 'asc' },
      })

      const byChargeId = new Map<number, typeof payments>()
      const byPeriod = new Map<string, typeof payments>()
      for (const p of payments) {
        if (p.chargeId != null) {
          const list = byChargeId.get(p.chargeId) ?? []
          list.push(p)
          byChargeId.set(p.chargeId, list)
        } else {
          const period = `${p.date.getUTCFullYear()}-${String(p.date.getUTCMonth() + 1).padStart(2, '0')}`
          const list = byPeriod.get(period) ?? []
          list.push(p)
          byPeriod.set(period, list)
        }
      }

      const round2 = (n: number) => Math.round(n * 100) / 100
      const mapSource = (source: string | null) => (source === 'mt940' ? 'MT940' : 'MANUAL')

      const result = charges.map(charge => {
        const linked = byChargeId.get(charge.id) ?? []
        const legacy = byPeriod.get(charge.period) ?? []
        const chargePayments = [...linked, ...legacy].sort(
          (a, b) => a.date.getTime() - b.date.getTime(),
        )
        const paidAmount = round2(chargePayments.reduce((s, p) => s + Number(p.amount), 0))
        const total = Number(charge.totalAmount)
        const { status, daysOverdue } = computeChargeStatus(total, paidAmount, charge.dueDate, now)
        return {
          period: charge.period,
          totalAmount: total,
          dueDate: charge.dueDate,
          status,
          daysOverdue,
          components: charge.components,
          paidAmount,
          remainingAmount: round2(Math.max(total - paidAmount, 0)),
          payments: chargePayments.map(p => ({
            id: p.id,
            amount: Number(p.amount),
            date: p.date,
            source: mapSource(p.source),
            description: p.description,
          })),
        }
      })

      return { configured: true, unitNumber, charges: result }
    } catch {
      // Fail-soft: starsza baza bez tabel payment_* / nieoczekiwany błąd nie
      // może wywalić widoku płatności w iOS — pusta lista, iOS pokaże ledger.
      return empty
    }
  }

  /** Czy budynek ma jakąkolwiek konfigurację opłat (aktywne składowe LUB naliczenia). */
  private async buildingHasPaymentsConfigured(buildingId: number): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<{ configured: boolean }[]>`
        SELECT (
          EXISTS (
            SELECT 1 FROM payment_components
            WHERE "buildingId" = ${buildingId}
              AND ("activeTo" IS NULL OR "activeTo" >= NOW())
          )
          OR EXISTS (SELECT 1 FROM payment_charges WHERE "buildingId" = ${buildingId})
        ) AS configured
      `
      return rows[0]?.configured === true
    } catch {
      return false
    }
  }
}
