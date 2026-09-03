import {
  Injectable,
  ForbiddenException,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Prisma } from '@prisma/client'
import * as crypto from 'crypto'
import { PrismaService } from '../prisma/prisma.service'
import { MailService } from '../mail/mail.service'
import { PushService } from '../push/push.service'
import { EdgeGateway } from '../edge/edge.gateway'
import { getGuestsHistoryFor } from '../guest-events/guest-history.helper'
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
import {
  VEHICLE_KINDS,
  vehicleSelectSql,
  ownerForEdge,
  sanitizeTags,
} from '../building-admin/building-admin.service'
import type { VehicleKindStr, VehicleRow } from '../building-admin/building-admin.service'
import { IsDateString, IsIn, IsInt, IsOptional, IsString } from 'class-validator'
import { assertGuestPlateAllowed } from '../guests/guest-plate-guard'
import { normalizeTicketPhoto } from '../common/ticket-photo'
import { sortUnits } from '../common/natural-sort'

export class ConciergeNotificationDto {
  @IsString() title: string
  @IsString() body: string
  @IsOptional() @IsInt() residentId?: number
}

export class ReceiveParcelDto {
  @IsString() trackingNumber: string
  @IsString() courier: string   // DHL | INPOST | ALLEGRO | OTHER
  @IsInt() unitId: number
}

export class IssueParcelDto {
  @IsOptional() @IsString() photoUrl?: string
}

export class ConciergeCreateVehicleDto {
  // residentId is optional: building-wide services (kind != RESIDENT) don't
  // need a resident. For resident cars the service layer still enforces it.
  @IsOptional() @IsInt() residentId?: number
  @IsOptional() @IsIn(VEHICLE_KINDS) kind?: VehicleKindStr
  @IsString() make: string
  @IsOptional() @IsString() model?: string
  @IsString() color: string
  @IsString() licensePlate: string
  @IsOptional() @IsString() serviceName?: string
  @IsOptional() @IsString() notes?: string
  // Tagi opisowe — multi-select w UI (lib/vehicle-tags.ts).
  @IsOptional() @IsString({ each: true }) tags?: string[]
}

export class ConciergeUpdateVehicleDto {
  // Wszystkie pola opcjonalne — partial update. Symetryczne do
  // BaUpdateVehicleDto, używane głównie przy „Identyfikuj…" w panelu LPR
  // (poprawienie literówki, zmiana właściciela, dorzucenie tagu).
  @IsOptional() @IsInt() residentId?: number
  @IsOptional() @IsIn(VEHICLE_KINDS) kind?: VehicleKindStr
  @IsOptional() @IsString() make?: string
  @IsOptional() @IsString() model?: string
  @IsOptional() @IsString() color?: string
  @IsOptional() @IsString() licensePlate?: string
  @IsOptional() @IsString() serviceName?: string
  @IsOptional() @IsString() notes?: string
  @IsOptional() @IsString({ each: true }) tags?: string[]
}

export class CreateReservationDto {
  @IsInt() unitId: number
  @IsInt() residentId: number
  @IsDateString() startAt: string
  @IsDateString() endAt: string
  @IsOptional() @IsString() note?: string
}

export class ConciergeAddTicketReplyDto {
  // Treść odpowiedzi konsjerża. Min validacja po stronie front-endu, ale
  // długość trzymamy luźną (do 4k chars). HTML escape robi React.
  @IsString() body: string
  // Zdjęcie w odpowiedzi (2026-08-13) — data-URI, walidacja w serwisie.
  @IsOptional() @IsString() photo?: string
}

export class ConciergeUpdateTicketStatusDto {
  // OPEN / IN_PROGRESS / DONE — patrz `TicketStatus` enum w schema.prisma.
  @IsIn(['OPEN', 'IN_PROGRESS', 'DONE']) status: 'OPEN' | 'IN_PROGRESS' | 'DONE'
}

@Injectable()
export class ConciergeService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private mailService: MailService,
    private push: PushService,
    private edgeGateway: EdgeGateway,
  ) {}

  // ── Auth ─────────────────────────────────────────────────────────────────
  async login(email: string, password: string) {
    const concierge = await this.prisma.concierge.findUnique({ where: { email } })
    if (!concierge) throw new UnauthorizedException('Nieprawidłowy email lub hasło')
    const bcrypt = await import('bcrypt')
    const valid = await bcrypt.compare(password, concierge.passwordHash)
    if (!valid) throw new UnauthorizedException('Nieprawidłowy email lub hasło')

    // 2026-06-02 (FAZA b) — blokuj login gdy obiekt nie ma konsjerża.
    // Konfiguracja per building: `features.has_concierge=false` oznacza że
    // panel konsjerża jest wyłączony (np. osiedle domów Villa Natura).
    const features = await this.loadFeatures(concierge.buildingId)
    if (!features.has_concierge) {
      throw new ForbiddenException(
        'Konsjerż nie jest dostępny w tym obiekcie. Funkcja została wyłączona przez integratora.',
      )
    }

    const payload = {
      sub: concierge.id,
      email: concierge.email,
      type: 'concierge',
      buildingId: concierge.buildingId,
    }
    return {
      access_token: this.jwtService.sign(payload),
      concierge: {
        id: concierge.id,
        name: concierge.name,
        email: concierge.email,
        buildingId: concierge.buildingId,
      },
    }
  }

  /**
   * Helper — ładuje znormalizowane `features` budynku (FAZA b).
   * Defaulty per `objectType` z constants. Używane też w `getMe` żeby front
   * mógł pokazać blokadę przy ponownej wizycie z istniejącym tokenem.
   */
  private async loadFeatures(buildingId: number): Promise<BuildingFeatures> {
    const b = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { objectType: true, features: true },
    })
    if (!b) throw new NotFoundException('Budynek nie istnieje')
    const objectType: ObjectType = isObjectType(b.objectType) ? b.objectType : 'BUILDING'
    return normalizeFeatures(
      objectType,
      (b.features as Partial<BuildingFeatures> | null) ?? null,
    )
  }

  // ── Me ────────────────────────────────────────────────────────────────────
  async getMe(conciergeId: number) {
    const c = await this.prisma.concierge.findUnique({ where: { id: conciergeId } })
    if (!c) throw new NotFoundException()
    // 2026-06-02 (FAZA b) — fail-fast gdy admin wyłączył konsjerża w międzyczasie.
    // Concierge UI dostaje 403 + komunikat → wymusi re-login (gdzie też dostanie blok).
    const features = await this.loadFeatures(c.buildingId)
    if (!features.has_concierge) {
      throw new ForbiddenException(
        'Konsjerż nie jest dostępny w tym obiekcie. Funkcja została wyłączona przez integratora.',
      )
    }
    // FAZA e — spłaszczone permissions dla web concierge nav. Klucze: feat_* + ap_*.
    const featurePermissions = flattenForRole(
      await this.loadFeaturePermissions(c.buildingId),
      'concierge',
    )
    return {
      id: c.id, name: c.name, email: c.email, buildingId: c.buildingId,
      featurePermissions,
    }
  }

  // ── FAZA e (2026-06-02) — Feature permissions ─────────────────────────
  private async loadFeaturePermissions(buildingId: number): Promise<BuildingFeaturePermissions> {
    const rows = await this.prisma.$queryRaw<{ featurePermissions: unknown }[]>`
      SELECT "featurePermissions"
        FROM "buildings" WHERE id = ${buildingId} LIMIT 1
    `
    return normalizePermissions(rows[0]?.featurePermissions)
  }

  private async requireConciergeFeature(buildingId: number, feature: SystemFeature) {
    const perms = await this.loadFeaturePermissions(buildingId)
    if (!hasPermission(perms, 'concierge', featKey(feature))) {
      throw new ForbiddenException({
        message: FEATURE_DISABLED_MESSAGE,
        code: FEATURE_DISABLED_CODE,
        feature,
      })
    }
  }

  // ── Budynek ───────────────────────────────────────────────────────────────
  async getBuilding(buildingId: number) {
    const building = await this.prisma.building.findFirst({
      where: { id: buildingId, isArchived: false },
      include: {
        stairwells: {
          orderBy: { createdAt: 'asc' },
          include: { intercom: true },
        },
        _count: { select: { units: true, residents: true } },
      },
    })
    if (!building) throw new NotFoundException('Budynek nie istnieje')
    // 2026-06-02 (FAZA b) — zwracamy znormalizowany shape.
    const objectType: ObjectType = isObjectType(building.objectType) ? building.objectType : 'BUILDING'
    const features = normalizeFeatures(
      objectType,
      (building.features as Partial<BuildingFeatures> | null) ?? null,
    )
    return { ...building, objectType, features }
  }

  // ── Lokale (read-only) ────────────────────────────────────────────────────
  async getUnits(buildingId: number) {
    return sortUnits(
      await this.prisma.unit.findMany({
        where: { buildingId },
        include: { unitType: true, stairwell: true },
        orderBy: { number: 'asc' },
      }),
    )
  }

  async getUnit(unitId: number, buildingId: number) {
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

  // ── Mieszkańcy (read-only) ────────────────────────────────────────────────
  async getResidents(buildingId: number) {
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

  async getResident(residentId: number, buildingId: number) {
    const resident = await this.prisma.resident.findFirst({
      where: { id: residentId, buildingId },
      include: { unitResidents: { include: { unit: { include: { unitType: true } } } } },
    })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    return resident
  }

  // ── Powiadomienia ─────────────────────────────────────────────────────────
  async sendNotification(buildingId: number, dto: ConciergeNotificationDto) {
    await this.requireConciergeFeature(buildingId, 'notifications')
    if (dto.residentId) {
      const resident = await this.prisma.resident.findFirst({
        where: { id: dto.residentId, buildingId },
      })
      if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
      const notification = await this.prisma.notification.create({
        data: { buildingId, residentId: dto.residentId, title: dto.title, body: dto.body },
        include: { resident: true },
      })
      this.push.sendToResident(dto.residentId, `🔔 ${dto.title}`, dto.body, { type: 'notification' })
        .catch(() => {/* fire-and-forget */})
      return notification
    }
    const residents = await this.prisma.resident.findMany({ where: { buildingId } })
    const notifications = await this.prisma.$transaction(
      residents.map((r) =>
        this.prisma.notification.create({
          data: { buildingId, residentId: r.id, title: dto.title, body: dto.body },
        }),
      ),
    )
    this.push.sendToBuilding(buildingId, `🔔 ${dto.title}`, dto.body, { type: 'notification' })
      .catch(() => {/* fire-and-forget */})
    return { sent: notifications.length, notifications }
  }

  // ── Przesyłki ─────────────────────────────────────────────────────────────
  async getParcels(buildingId: number, status?: string) {
    await this.requireConciergeFeature(buildingId, 'parcels')
    const where: any = { buildingId }
    if (status === 'RECEIVED' || status === 'ISSUED') where.status = status
    return this.prisma.parcel.findMany({
      where,
      include: {
        unit: { include: { unitType: true } },
        concierge: { select: { name: true } },
      },
      orderBy: { receivedAt: 'desc' },
    })
  }

  async receiveParcel(buildingId: number, conciergeId: number, dto: ReceiveParcelDto) {
    await this.requireConciergeFeature(buildingId, 'parcels')
    // Verify unit belongs to building
    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId, buildingId },
      include: { unitType: true },
    })
    if (!unit) throw new NotFoundException('Lokal nie istnieje lub nie należy do tego budynku')

    // Validate courier value
    const validCouriers = ['DHL', 'INPOST', 'ALLEGRO', 'OTHER']
    if (!validCouriers.includes(dto.courier.toUpperCase())) {
      throw new BadRequestException('Nieprawidłowy kurier')
    }

    const building = await this.prisma.building.findUnique({ where: { id: buildingId } })

    // Create parcel
    const parcel = await this.prisma.parcel.create({
      data: {
        trackingNumber: dto.trackingNumber,
        courier: dto.courier.toUpperCase() as any,
        unitId: dto.unitId,
        buildingId,
        conciergeId,
      },
      include: { unit: { include: { unitType: true } } },
    })

    // Notify residents of the unit
    const unitResidents = await this.prisma.unitResident.findMany({
      where: { unitId: dto.unitId, untilDate: null },
      include: { resident: true },
    })

    const courierLabel = { DHL: 'DHL', INPOST: 'InPost', ALLEGRO: 'Allegro', OTHER: 'Inne' }[dto.courier.toUpperCase()] ?? dto.courier
    const notifTitle = '📦 Nowa przesyłka w depozycie'
    const notifBody = `Przesyłka od kuriera ${courierLabel} (${dto.trackingNumber}) dla lokalu ${unit.number} oczekuje na odbiór w lobby.`

    await Promise.all(
      unitResidents.map(async (ur) => {
        await this.prisma.notification.create({
          data: { buildingId, residentId: ur.residentId, title: notifTitle, body: notifBody },
        })
        this.push.sendToResident(ur.residentId, notifTitle, notifBody, { type: 'parcel', parcelId: parcel.id })
          .catch(() => {/* fire-and-forget */})
        await this.mailService.sendParcelReceived(ur.resident.email, {
          trackingNumber: dto.trackingNumber,
          courier: dto.courier.toUpperCase(),
          unitNumber: unit.number,
          buildingName: building?.name ?? '',
          receivedAt: parcel.receivedAt,
        })
      }),
    )

    return parcel
  }

  async issueParcel(buildingId: number, parcelId: number, dto: IssueParcelDto) {
    await this.requireConciergeFeature(buildingId, 'parcels')
    const parcel = await this.prisma.parcel.findFirst({
      where: { id: parcelId, buildingId },
      include: { unit: { include: { unitType: true } } },
    })
    if (!parcel) throw new NotFoundException('Przesyłka nie istnieje')
    if (parcel.status === 'ISSUED') throw new BadRequestException('Przesyłka już została wydana')

    const issuedAt = new Date()
    const updated = await this.prisma.parcel.update({
      where: { id: parcelId },
      data: { status: 'ISSUED', issuedAt, issuedPhotoUrl: dto.photoUrl ?? null },
      include: { unit: { include: { unitType: true } } },
    })

    // Notify residents of the unit
    const unitResidents = await this.prisma.unitResident.findMany({
      where: { unitId: parcel.unitId, untilDate: null },
      include: { resident: true },
    })

    const courierLabel = { DHL: 'DHL', INPOST: 'InPost', ALLEGRO: 'Allegro', OTHER: 'Inne' }[parcel.courier] ?? parcel.courier
    const notifTitle = '✅ Przesyłka wydana'
    const notifBody = `Przesyłka od kuriera ${courierLabel} (${parcel.trackingNumber}) dla lokalu ${parcel.unit.number} została wydana.`

    await Promise.all(
      unitResidents.map(async (ur) => {
        await this.prisma.notification.create({
          data: { buildingId, residentId: ur.residentId, title: notifTitle, body: notifBody },
        })
        this.push.sendToResident(ur.residentId, notifTitle, notifBody, { type: 'parcel', parcelId })
          .catch(() => {/* fire-and-forget */})
        await this.mailService.sendParcelIssued(ur.resident.email, {
          trackingNumber: parcel.trackingNumber,
          courier: parcel.courier,
          unitNumber: parcel.unit.number,
          issuedAt,
        })
      }),
    )

    return updated
  }

  async remindParcel(buildingId: number, parcelId: number) {
    await this.requireConciergeFeature(buildingId, 'parcels')
    const parcel = await this.prisma.parcel.findFirst({
      where: { id: parcelId, buildingId, status: 'RECEIVED' },
      include: { unit: { include: { unitType: true } } },
    })
    if (!parcel) throw new NotFoundException('Przesyłka nie istnieje lub już została wydana')

    const daysWaiting = Math.floor(
      (Date.now() - parcel.receivedAt.getTime()) / (1000 * 60 * 60 * 24),
    )

    const unitResidents = await this.prisma.unitResident.findMany({
      where: { unitId: parcel.unitId, untilDate: null },
      include: { resident: true },
    })

    const courierLabel =
      { DHL: 'DHL', INPOST: 'InPost', ALLEGRO: 'Allegro', OTHER: 'Inne' }[parcel.courier] ??
      parcel.courier
    const daysText =
      daysWaiting === 0 ? 'dzisiaj' : daysWaiting === 1 ? '1 dzień' : `${daysWaiting} dni`

    const notifTitle = '📦 Przypomnienie o przesyłce'
    const notifBody = `Przesyłka od kuriera ${courierLabel} (${parcel.trackingNumber}) czeka na odbiór od ${daysText} w lobby.`

    await Promise.all(
      unitResidents.map(async (ur) => {
        await this.prisma.notification.create({
          data: { buildingId, residentId: ur.residentId, title: notifTitle, body: notifBody },
        })
        this.push.sendToResident(ur.residentId, notifTitle, notifBody, { type: 'parcel', parcelId })
          .catch(() => {/* fire-and-forget */})
        await this.mailService.sendParcelReminder(ur.resident.email, {
          trackingNumber: parcel.trackingNumber,
          courier: parcel.courier,
          unitNumber: parcel.unit.number,
          daysWaiting,
          receivedAt: parcel.receivedAt,
        })
      }),
    )

    return { sent: unitResidents.length, daysWaiting }
  }

  async getUnitParcels(buildingId: number, unitId: number) {
    await this.requireConciergeFeature(buildingId, 'parcels')
    const unit = await this.prisma.unit.findFirst({ where: { id: unitId, buildingId } })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')
    return this.prisma.parcel.findMany({
      where: { unitId, buildingId },
      include: { concierge: { select: { name: true } } },
      orderBy: { receivedAt: 'desc' },
    })
  }

  // ── Części wspólne ────────────────────────────────────────────────────────
  async getCommonAreas(buildingId: number) {
    await this.requireConciergeFeature(buildingId, 'reservations')
    return sortUnits(
      await this.prisma.unit.findMany({
        where: { buildingId, unitType: { isCommonArea: true } },
        include: {
          unitType: true,
          commonAreaSettings: true,
        },
        orderBy: { number: 'asc' },
      }),
    )
  }

  async getDayReservations(buildingId: number, unitId: number, date: string) {
    await this.requireConciergeFeature(buildingId, 'reservations')
    const unit = await this.prisma.unit.findFirst({
      where: { id: unitId, buildingId, unitType: { isCommonArea: true } },
      include: { commonAreaSettings: true },
    })
    if (!unit) throw new NotFoundException('Część wspólna nie istnieje')

    const day = new Date(date)
    const nextDay = new Date(day)
    nextDay.setDate(nextDay.getDate() + 1)

    return this.prisma.reservation.findMany({
      where: {
        unitId,
        buildingId,
        status: 'CONFIRMED',
        startAt: { gte: day, lt: nextDay },
      },
      include: { resident: true },
      orderBy: { startAt: 'asc' },
    })
  }

  // ── Rezerwacje ────────────────────────────────────────────────────────────
  async createReservation(buildingId: number, dto: CreateReservationDto) {
    await this.requireConciergeFeature(buildingId, 'reservations')
    const startAt = new Date(dto.startAt)
    const endAt = new Date(dto.endAt)

    if (endAt <= startAt) {
      throw new BadRequestException('Czas zakończenia musi być późniejszy niż czas rozpoczęcia')
    }

    const unit = await this.prisma.unit.findFirst({
      where: { id: dto.unitId, buildingId, unitType: { isCommonArea: true } },
      include: { unitType: true, commonAreaSettings: true },
    })
    if (!unit) throw new NotFoundException('Część wspólna nie istnieje')

    const settings = unit.commonAreaSettings
    if (settings) {
      // Check max slot duration
      const slotMinutes = (endAt.getTime() - startAt.getTime()) / 60000
      if (slotMinutes > settings.maxSlotMinutes) {
        throw new BadRequestException(
          `Maksymalny czas rezerwacji wynosi ${settings.maxSlotMinutes} minut`,
        )
      }

      // Check opening hours (compare HH:MM strings)
      // Wyciągamy czas bezpośrednio z przesłanego stringa (format "YYYY-MM-DDTHH:MM:SS")
      // aby uniknąć problemów ze strefą czasową przy parsowaniu przez new Date().
      const toMinutes = (t: string) => {
        const [h, m] = t.split(':').map(Number)
        return h * 60 + m
      }
      const openMinutes = toMinutes(settings.openTime)
      const closeMinutes = toMinutes(settings.closeTime)
      // dto.startAt / dto.endAt mają format "YYYY-MM-DDTHH:MM:SS[...]"
      // Wytnij pozycje 11-16 aby dostać "HH:MM" niezależnie od timezony serwera
      const startLocalMinutes = toMinutes(dto.startAt.slice(11, 16))
      const endLocalMinutes   = toMinutes(dto.endAt.slice(11, 16))

      if (startLocalMinutes < openMinutes || endLocalMinutes > closeMinutes) {
        throw new BadRequestException(
          `Rezerwacje dozwolone w godzinach ${settings.openTime}–${settings.closeTime}`,
        )
      }
    }

    // Check resident belongs to building
    const resident = await this.prisma.resident.findFirst({
      where: { id: dto.residentId, buildingId },
    })
    if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')

    // Conflict check
    const conflict = await this.prisma.reservation.findFirst({
      where: {
        unitId: dto.unitId,
        status: 'CONFIRMED',
        NOT: { OR: [{ endAt: { lte: startAt } }, { startAt: { gte: endAt } }] },
      },
    })
    if (conflict) throw new BadRequestException('Ten slot jest już zajęty')

    // Calculate price
    const isPaid = settings?.isPaid ?? false
    const pricePerHour = settings?.pricePerHour ? Number(settings.pricePerHour) : null
    const durationHours = (endAt.getTime() - startAt.getTime()) / 3600000
    const pricePaid =
      isPaid && pricePerHour ? Math.ceil(durationHours) * pricePerHour : null

    const reservation = await this.prisma.reservation.create({
      data: {
        buildingId,
        unitId: dto.unitId,
        residentId: dto.residentId,
        startAt,
        endAt,
        status: 'CONFIRMED',
        isPaid,
        pricePaid,
        note: dto.note ?? null,
      },
      include: { unit: { include: { unitType: true } }, resident: true },
    })

    // Notification + email
    const unitName = `${unit.unitType.name} ${unit.number}`
    const notifTitle = '📅 Rezerwacja potwierdzona'
    const notifBody = `Rezerwacja ${unitName} na ${startAt.toLocaleDateString('pl-PL')} ${startAt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}–${endAt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} została potwierdzona.`

    await this.prisma.notification.create({
      data: { buildingId, residentId: dto.residentId, title: notifTitle, body: notifBody },
    })
    await this.mailService.sendReservationConfirmed(resident.email, {
      unitName,
      startAt,
      endAt,
      isPaid,
      pricePaid,
    })

    return reservation
  }

  async cancelReservation(buildingId: number, reservationId: number) {
    await this.requireConciergeFeature(buildingId, 'reservations')
    const reservation = await this.prisma.reservation.findFirst({
      where: { id: reservationId, buildingId },
      include: { unit: { include: { unitType: true } }, resident: true },
    })
    if (!reservation) throw new NotFoundException('Rezerwacja nie istnieje')
    if (reservation.status === 'CANCELLED') {
      throw new BadRequestException('Rezerwacja już została anulowana')
    }

    const updated = await this.prisma.reservation.update({
      where: { id: reservationId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
      include: { unit: { include: { unitType: true } }, resident: true },
    })

    const unitName = `${reservation.unit.unitType.name} ${reservation.unit.number}`
    const notifTitle = '❌ Rezerwacja anulowana'
    const notifBody = `Rezerwacja ${unitName} na ${reservation.startAt.toLocaleDateString('pl-PL')} została anulowana.`

    await this.prisma.notification.create({
      data: { buildingId, residentId: reservation.residentId, title: notifTitle, body: notifBody },
    })
    await this.mailService.sendReservationCancelled(reservation.resident.email, {
      unitName,
      startAt: reservation.startAt,
      endAt: reservation.endAt,
    })

    return updated
  }

  // ── Pojazdy ───────────────────────────────────────────────────────────────
  //
  // Raw SQL — patrz komentarz w `building-admin.service.ts`. Kolumna `kind`
  // to Postgres enum, więc wstawiamy ją z castem `::\"VehicleKind\"`.

  async getVehicles(buildingId: number): Promise<VehicleRow[]> {
    await this.requireConciergeFeature(buildingId, 'vehicles')
    return this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v."buildingId" = ${buildingId}`, Prisma.sql`v."createdAt" DESC`)}`
  }

  /**
   * Rejestruje pojazd — dla mieszkańca lub jako ogólna usługa/dostawa bez
   * przypisanego właściciela. Używane z modalu „Identyfikuj" w liście
   * odczytów LPR. Po zapisie wysyłamy PLATE_UPSERT do Edge, żeby kolejny
   * przejazd od razu dopasował się do whitelist'y.
   */
  async createVehicle(buildingId: number, dto: ConciergeCreateVehicleDto): Promise<VehicleRow> {
    await this.requireConciergeFeature(buildingId, 'vehicles')
    const plate = (dto.licensePlate ?? '').trim().toUpperCase()
    if (!plate) throw new BadRequestException('Tablica nie może być pusta')
    const kind: VehicleKindStr = dto.kind ?? 'RESIDENT'
    if (kind === 'RESIDENT' && !dto.residentId) {
      throw new BadRequestException('Samochód mieszkańca wymaga wskazania mieszkańca')
    }
    if (kind !== 'RESIDENT' && !dto.serviceName?.trim()) {
      throw new BadRequestException('Dla pojazdu usługowego podaj nazwę firmy/serwisu')
    }

    let resident: { id: number; firstName: string; lastName: string } | null = null
    if (dto.residentId) {
      resident = await this.prisma.resident.findFirst({
        where: { id: dto.residentId, buildingId },
        select: { id: true, firstName: true, lastName: true },
      })
      if (!resident) throw new NotFoundException('Mieszkaniec nie istnieje')
    }

    // Duplicate-guard: ta sama tablica nie może istnieć dwa razy w obrębie
    // budynku (poprzednio blokowało tylko różny residentId — co pozwalało
    // na zduplikowanie wpisu z literówką w nazwie marki). UI używa PATCH przy
    // edycji, ale defensive check trzymamy też tutaj.
    const existing = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM "vehicles"
       WHERE "buildingId" = ${buildingId} AND "licensePlate" = ${plate}
       LIMIT 1
    `
    if (existing[0]) {
      throw new BadRequestException(
        `Tablica „${plate}" jest już zarejestrowana w tym budynku — edytuj istniejący wpis.`,
      )
    }

    const tags = sanitizeTags(dto.tags)
    const [row] = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "vehicles"
        ("buildingId", "residentId", "kind", "make", "model", "color",
         "licensePlate", "serviceName", "notes", "tags")
      VALUES (
        ${buildingId},
        ${resident?.id ?? null},
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

    this.edgeGateway.sendToBuilding(buildingId, 'PLATE_UPSERT', {
      plate,
      owner: ownerForEdge(kind, resident, dto.serviceName),
    })

    const rows = await this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v.id = ${row.id}`, Prisma.sql`v.id ASC`)}`
    return rows[0]
  }

  /**
   * Edycja istniejącego pojazdu — symetryczne do `BuildingAdminService.updateVehicle`.
   *
   * Dlaczego concierge ma swoją wersję: panel LPR (modal „Identyfikuj") jest
   * dostępny zarówno dla admina osiedla jak i konsjerża. Po wprowadzeniu PATCH
   * w `LprViewer` (zamiast „zawsze POST"), konsjerż musiał też mieć endpoint
   * PATCH — inaczej edycja literówki kasowała się błędem 404.
   *
   * Concierge nie potrzebuje `guardBuilding` — JWT już go ogranicza do jednego
   * budynku (`req.user.buildingId`). Sync do Edge przez `edgeGateway` bezpośrednio,
   * bez prywatnego helpera (BA ma `syncPlateToEdge`, my robimy to inline).
   */
  async updateVehicle(
    buildingId: number,
    vehicleId: number,
    dto: ConciergeUpdateVehicleDto,
  ): Promise<VehicleRow> {
    await this.requireConciergeFeature(buildingId, 'vehicles')
    const existing = await this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v.id = ${vehicleId} AND v."buildingId" = ${buildingId}`, Prisma.sql`v.id ASC`)}`
    const vehicle = existing[0]
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
    if (nextKind === 'RESIDENT' && !residentId) {
      throw new BadRequestException('Samochód mieszkańca wymaga wskazania mieszkańca')
    }

    // Duplicate-guard przy zmianie tablicy: nie pozwalamy „przepisać" tablicy
    // która istnieje już na innym wpisie tego budynku — to powodowałoby
    // konflikt w whitelist Edge i wyglądało jak duplikat w UI.
    if (nextPlate !== vehicle.licensePlate) {
      const dupe = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT id FROM "vehicles"
         WHERE "buildingId" = ${buildingId}
           AND "licensePlate" = ${nextPlate}
           AND id <> ${vehicleId}
         LIMIT 1
      `
      if (dupe[0]) {
        throw new BadRequestException(
          `Tablica „${nextPlate}" jest już zarejestrowana w tym budynku.`,
        )
      }
    }

    const nextTags = dto.tags !== undefined ? sanitizeTags(dto.tags) : vehicle.tags
    await this.prisma.$executeRaw`
      UPDATE "vehicles" SET
        "residentId"   = ${residentId},
        "kind"         = ${nextKind}::"VehicleKind",
        "make"         = ${dto.make ?? vehicle.make},
        "model"        = ${dto.model ?? vehicle.model},
        "color"        = ${dto.color ?? vehicle.color},
        "licensePlate" = ${nextPlate},
        "serviceName"  = ${dto.serviceName !== undefined ? (dto.serviceName?.trim() || null) : vehicle.serviceName},
        "notes"        = ${dto.notes !== undefined ? (dto.notes?.trim() || null) : vehicle.notes},
        "tags"         = ${nextTags}::text[]
      WHERE id = ${vehicleId}
    `

    // LPR sync — tylko APPROVED ma być w allowlist Edge. Symetrycznie do BA.
    const wasApproved = vehicle.status === 'APPROVED'
    if (wasApproved && nextPlate !== vehicle.licensePlate) {
      this.edgeGateway.sendToBuilding(buildingId, 'PLATE_DELETE', { plate: vehicle.licensePlate })
    }

    const updatedRows = await this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v.id = ${vehicleId} AND v."buildingId" = ${buildingId}`, Prisma.sql`v.id ASC`)}`
    const updated = updatedRows[0]
    if (!updated) throw new NotFoundException('Pojazd nie istnieje')

    if (wasApproved) {
      this.edgeGateway.sendToBuilding(buildingId, 'PLATE_UPSERT', {
        plate: nextPlate,
        owner: ownerForEdge(nextKind, updated.resident, updated.serviceName ?? undefined),
      })
    }
    return updated
  }

  /**
   * Usunięcie pojazdu — używane głównie do sprzątania duplikatów (literówka
   * w nazwie marki, podwójny wpis tej samej tablicy). Wysyła PLATE_DELETE
   * tylko jeśli pojazd był w stanie APPROVED — inaczej i tak go w Edge nie ma.
   */
  async deleteVehicle(buildingId: number, vehicleId: number): Promise<{ id: number }> {
    await this.requireConciergeFeature(buildingId, 'vehicles')
    const rows = await this.prisma.$queryRaw<VehicleRow[]>`${vehicleSelectSql(Prisma.sql`v.id = ${vehicleId} AND v."buildingId" = ${buildingId}`, Prisma.sql`v.id ASC`)}`
    const vehicle = rows[0]
    if (!vehicle) throw new NotFoundException('Pojazd nie istnieje')
    await this.prisma.$executeRaw`DELETE FROM "vehicles" WHERE id = ${vehicleId} AND "buildingId" = ${buildingId}`
    if (vehicle.status === 'APPROVED') {
      this.edgeGateway.sendToBuilding(buildingId, 'PLATE_DELETE', { plate: vehicle.licensePlate })
    }
    return { id: vehicleId }
  }

  // ── Tickety (Faza 4) ──────────────────────────────────────────────────────
  //
  // Konsjerż widzi tylko ticket-y zaadresowane do niego (`type='CONCIERGE'`)
  // w swoim budynku. Może odpowiadać + zmieniać status (OPEN/IN_PROGRESS/DONE).
  // Po dodaniu reply — jeśli ticket był OPEN, automatycznie idzie w
  // IN_PROGRESS (parytet z BA flow). Push do mieszkańca fire-and-forget.
  //
  // Wszystko raw SQL, bo nowe kolumny `tickets.type` + `ticket_replies.authorId`
  // dodane są w migracji 20260506120000, ale `prisma generate` jest broken
  // (drift 5.22/7.5 w monorepo — patrz CLAUDE.md). Kształt odpowiedzi
  // mirroruje to, co zwraca `BuildingAdminService.getTickets` (Prisma Client
  // include resident + replies), żeby front-end mógł reuse-ować ten sam
  // komponent listy.

  async getConciergeTickets(buildingId: number, status?: string) {
    await this.requireConciergeFeature(buildingId, 'tickets')
    type Row = {
      id: number; buildingId: number; residentId: number;
      category: string; type: string; title: string; body: string;
      photo: string | null; status: string;
      createdAt: Date; updatedAt: Date;
      residentFirstName: string; residentLastName: string;
      residentEmail: string | null; residentAvatar: string | null;
    }
    const statusFilter =
      status === 'OPEN' || status === 'IN_PROGRESS' || status === 'DONE'
        ? Prisma.sql`AND t.status = ${status}::"TicketStatus"`
        : Prisma.empty
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT t.id, t."buildingId", t."residentId",
             t.category::text AS category,
             t."type",
             t.title, t.body, t.photo,
             t.status::text AS status,
             t."createdAt", t."updatedAt",
             r."firstName" AS "residentFirstName",
             r."lastName"  AS "residentLastName",
             r.email       AS "residentEmail",
             r.avatar      AS "residentAvatar"
        FROM "tickets" t
        JOIN "residents" r ON r.id = t."residentId"
       WHERE t."buildingId" = ${buildingId}
         AND t."type" = 'CONCIERGE'
         ${statusFilter}
       ORDER BY
         (CASE t.status::text WHEN 'OPEN' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END) ASC,
         t."createdAt" DESC
    `
    // Wczytujemy replies osobnym queryą żeby nie multiplikować rzędów przez JOIN.
    const ids = rows.map(r => r.id)
    const replies = ids.length === 0 ? [] : await this.fetchTicketReplies(ids)
    const repliesByTicket = new Map<number, any[]>()
    for (const rep of replies) {
      const arr = repliesByTicket.get(rep.ticketId) ?? []
      arr.push(rep)
      repliesByTicket.set(rep.ticketId, arr)
    }
    return rows.map(r => ({
      id: r.id, buildingId: r.buildingId, residentId: r.residentId,
      category: r.category, type: r.type,
      title: r.title, body: r.body, photo: r.photo,
      status: r.status,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
      resident: {
        id: r.residentId,
        firstName: r.residentFirstName,
        lastName: r.residentLastName,
        email: r.residentEmail,
        avatar: r.residentAvatar,
      },
      replies: repliesByTicket.get(r.id) ?? [],
    }))
  }

  async getConciergeTicket(buildingId: number, ticketId: number) {
    await this.requireConciergeFeature(buildingId, 'tickets')
    const all = await this.getConciergeTickets(buildingId)
    const t = all.find(x => x.id === ticketId)
    if (!t) throw new NotFoundException('Zgłoszenie nie istnieje')
    return t
  }

  async addConciergeTicketReply(
    buildingId: number,
    conciergeId: number,
    ticketId: number,
    dto: ConciergeAddTicketReplyDto,
  ) {
    await this.requireConciergeFeature(buildingId, 'tickets')
    // Sprawdzamy: ticket istnieje, jest w tym budynku, jest typu CONCIERGE.
    // BadRequest gdy admin-ticket — concierge nie może odpowiadać na cudze.
    const t = await this.prisma.$queryRaw<{ id: number; type: string; status: string; residentId: number }[]>`
      SELECT id, "type", status::text AS status, "residentId"
        FROM "tickets"
       WHERE id = ${ticketId} AND "buildingId" = ${buildingId}
       LIMIT 1
    `
    const ticket = t[0]
    if (!ticket) throw new NotFoundException('Zgłoszenie nie istnieje')
    if (ticket.type !== 'CONCIERGE') {
      throw new BadRequestException('To zgłoszenie nie jest adresowane do konsjerża')
    }

    const photoNorm = normalizeTicketPhoto(dto.photo)
    const [rep] = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "ticket_replies" ("ticketId", "authorType", "authorId", "body", "photo")
      VALUES (${ticketId}, 'CONCIERGE', ${conciergeId}, ${dto.body}, ${photoNorm})
      RETURNING id
    `
    if (ticket.status === 'OPEN') {
      await this.prisma.$executeRaw`
        UPDATE "tickets" SET status = 'IN_PROGRESS'::"TicketStatus", "updatedAt" = NOW()
         WHERE id = ${ticketId}
      `
    }
    // Push do mieszkańca — analogicznie do BA flow.
    this.push.sendToResident(ticket.residentId, '🛎 Odpowiedź konsjerża', dto.body.slice(0, 100), {
      type: 'ticket_reply',
      ticketId: ticket.id,
    }).catch(() => {/* fire-and-forget */})
    return { id: rep.id }
  }

  async updateConciergeTicketStatus(
    buildingId: number,
    ticketId: number,
    dto: ConciergeUpdateTicketStatusDto,
  ) {
    await this.requireConciergeFeature(buildingId, 'tickets')
    const t = await this.prisma.$queryRaw<{ id: number; type: string }[]>`
      SELECT id, "type" FROM "tickets"
       WHERE id = ${ticketId} AND "buildingId" = ${buildingId}
       LIMIT 1
    `
    const ticket = t[0]
    if (!ticket) throw new NotFoundException('Zgłoszenie nie istnieje')
    if (ticket.type !== 'CONCIERGE') {
      throw new BadRequestException('To zgłoszenie nie jest adresowane do konsjerża')
    }
    await this.prisma.$executeRaw`
      UPDATE "tickets"
         SET status = ${dto.status}::"TicketStatus", "updatedAt" = NOW()
       WHERE id = ${ticketId}
    `
    return this.getConciergeTicket(buildingId, ticketId)
  }

  /**
   * Helper — fetch replies dla listy ticket-ów. Joinuje po authorId żeby
   * dorzucić `authorName` (admin: BuildingAdmin.name, concierge: Concierge.name,
   * resident: NULL — front rozpoznaje po authorType). Bez tego iOS musiałby
   * robić N+1 fetch dla każdego avatara.
   */
  private async fetchTicketReplies(ticketIds: number[]) {
    type Row = {
      id: number; ticketId: number; authorType: string; authorId: number | null;
      body: string; createdAt: Date;
      adminName: string | null; conciergeName: string | null;
    }
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT tr.id, tr."ticketId", tr."authorType", tr."authorId",
             tr.body, tr.photo, tr."createdAt",
             ba.name AS "adminName",
             c.name  AS "conciergeName"
        FROM "ticket_replies" tr
        LEFT JOIN "building_admins" ba
               ON tr."authorType" = 'ADMIN' AND ba.id = tr."authorId"
        LEFT JOIN "concierges" c
               ON tr."authorType" = 'CONCIERGE' AND c.id = tr."authorId"
       WHERE tr."ticketId" IN (${Prisma.join(ticketIds)})
       ORDER BY tr."createdAt" ASC
    `
    return rows.map(r => ({
      id: r.id,
      ticketId: r.ticketId,
      authorType: r.authorType,
      authorId: r.authorId,
      body: r.body,
      createdAt: r.createdAt,
      // Wirtualne pole — iOS bubble pokazuje przy ADMIN/CONCIERGE.
      // RESIDENT-replies dostają NULL (i tak resident widzi „swoje").
      authorName:
        r.authorType === 'ADMIN'     ? r.adminName     :
        r.authorType === 'CONCIERGE' ? r.conciergeName :
        null,
    }))
  }

  // ── Goście (Faza 2 bety Villa Natura) ────────────────────────────────────
  //
  // Konsjerż widzi/zarządza wszystkimi gośćmi w SWOIM budynku (z JWT). Nie
  // potrzebuje guard-a po buildingId bo strategia JWT już go ogranicza do
  // jednego budynku.
  //
  // Edge: tablica + okno czasowe synchronizowane do allowlist LPR — taki sam
  // payload jak `BuildingAdminService.syncPlateToEdge` (Edge oczekuje
  // `validUntil`, nie `validTo`).

  /** Historia zdarzeń gości w budynku konsjerża — wrap nad helperem
   *  (UNION `guest_events` PORTAL_OPEN + `lpr_reads` matched). Identyczny
   *  shape jak `BuildingAdminService.getGuestsHistory`. */
  async getGuestsHistory(buildingId: number) {
    await this.requireConciergeFeature(buildingId, 'guests')
    return getGuestsHistoryFor(this.prisma, buildingId)
  }

  async getGuests(buildingId: number) {
    await this.requireConciergeFeature(buildingId, 'guests')
    type Row = {
      id: number; buildingId: number; residentId: number;
      name: string; phone: string | null; vehiclePlate: string | null;
      pin: string; validFrom: Date; validTo: Date; status: string;
      usedAt: Date | null; createdAt: Date;
      urlToken: string | null; email: string | null; emailSentAt: Date | null;
      allowedAccessPoints: unknown; recurringSchedule: unknown;
      residentFirstName: string | null; residentLastName: string | null;
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
      id: r.id, buildingId: r.buildingId, residentId: r.residentId,
      name: r.name, phone: r.phone, vehiclePlate: r.vehiclePlate,
      pin: r.pin, validFrom: r.validFrom, validTo: r.validTo,
      status: r.status, usedAt: r.usedAt, createdAt: r.createdAt,
      urlToken: r.urlToken, email: r.email, emailSentAt: r.emailSentAt,
      // Ograniczenia dostępu (2026-07-08) — panel pokazuje read-only badge.
      allowedAccessPoints: r.allowedAccessPoints ?? null,
      recurringSchedule: r.recurringSchedule ?? null,
      resident: r.residentFirstName
        ? { id: r.residentId, firstName: r.residentFirstName, lastName: r.residentLastName ?? '' }
        : null,
    }))
  }

  async createGuest(
    buildingId: number,
    dto: {
      residentId: number
      name: string
      phone?: string
      vehiclePlate?: string
      validFrom?: string
      validTo: string
      // Pivot bezkontaktowy — patrz ResidentService.createGuest. Concierge
      // dostaje ten sam handle żeby mógł zaprosić gościa „na recepcji" z
      // emailem i wysłać link do portalu (np. dla VIP-a bez aplikacji).
      email?: string
    },
  ) {
    await this.requireConciergeFeature(buildingId, 'guests')
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
    // Anty-stalking (2026-08-12): jak w ResidentService.createGuest —
    // tablica zarejestrowanego pojazdu osiedla nie może być gościem,
    // także gdy zaprasza konsjerż „w imieniu" mieszkańca.
    await assertGuestPlateAllowed(this.prisma, buildingId, plate)
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
      this.syncGuestPlate(buildingId, 'UPSERT', {
        plate,
        owner: `Gość ${name} (${inviter})`,
        validFrom,
        validTo,
      })
    }
    // PIN trafia do Edge zawsze — niezależnie od tablicy (gość pieszy).
    this.syncGuestPin(buildingId, 'UPSERT', {
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
      this.mailService
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
   * Ponowne wysłanie emaila z linkiem do portalu — analogicznie do
   * `BuildingAdminService.resendInviteEmail`. Konsjerż nie ma guard-a
   * `buildingIds` bo JWT zawęża do jednego budynku.
   */
  async resendInviteEmail(
    buildingId: number,
    guestId: number,
    overrideEmail?: string,
  ): Promise<{ sent: boolean; email: string }> {
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
        'Ten gość został utworzony przed pivotem portalu — nie ma URL tokenu.',
      )
    }

    const target = (overrideEmail ?? g.email ?? '').trim().toLowerCase()
    if (!target || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      throw new BadRequestException('Brak prawidłowego adresu email')
    }

    if (overrideEmail && target !== g.email) {
      await this.prisma.$executeRaw`
        UPDATE "guests" SET "email" = ${target} WHERE id = ${guestId}
      `
    }

    const building = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { name: true },
    })

    const res = await this.mailService.sendGuestInvitation(target, {
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
    dto: {
      residentId?: number
      name?: string
      phone?: string | null
      vehiclePlate?: string | null
      validFrom?: string
      validTo?: string
    },
  ) {
    await this.requireConciergeFeature(buildingId, 'guests')
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
      nextResident = await this.prisma.resident.findUnique({
        where: { id: g.residentId },
        select: { firstName: true, lastName: true },
      })
    }

    const nextName = dto.name?.trim() ?? g.name
    if (!nextName) throw new BadRequestException('Imię gościa nie może być puste')
    const nextPhone = dto.phone === undefined
      ? g.phone
      : (dto.phone?.trim() || null)
    let nextPlate: string | null
    if (dto.vehiclePlate === undefined) nextPlate = g.vehiclePlate
    else nextPlate = dto.vehiclePlate?.trim().toUpperCase() || null
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
      this.syncGuestPlate(buildingId, 'DELETE', { plate: g.vehiclePlate })
    }
    if (nextPlate) {
      this.syncGuestPlate(buildingId, 'UPSERT', {
        plate: nextPlate,
        owner: `Gość ${nextName} (${inviter})`,
        validFrom: nextFrom,
        validTo: nextTo,
      })
    }
    // PIN: ten sam kod, ale okno czasowe / nazwa mogły się zmienić → re-upsert.
    this.syncGuestPin(buildingId, 'UPSERT', {
      pin: g.pin,
      guestId,
      guestName: nextName,
      validFrom: nextFrom,
      validTo: nextTo,
    })

    return this.fetchGuestById(guestId, buildingId)
  }

  async cancelGuest(buildingId: number, guestId: number) {
    await this.requireConciergeFeature(buildingId, 'guests')
    type Row = { vehiclePlate: string | null; pin: string; status: string }
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT "vehiclePlate", pin, status::text AS status
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
      this.syncGuestPlate(buildingId, 'DELETE', { plate: g.vehiclePlate })
    }
    if (g.status === 'ACTIVE' && g.pin) {
      this.syncGuestPin(buildingId, 'DELETE', { pin: g.pin, guestId })
    }
    return this.fetchGuestById(guestId, buildingId)
  }

  private async fetchGuestById(guestId: number, buildingId: number) {
    const all = await this.getGuests(buildingId)
    return all.find(x => x.id === guestId) ?? null
  }

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

  /**
   * Wysyła PLATE_UPSERT/DELETE z tłumaczeniem `validTo` → `validUntil`
   * (konwencja Edge — patrz `PlateEntry` w hikvision-lpr.service.ts).
   */
  private syncGuestPlate(
    buildingId: number,
    op: 'UPSERT' | 'DELETE',
    payload: {
      plate: string
      owner?: string
      validFrom?: Date | string | null
      validTo?: Date | string | null
    },
  ) {
    const action = op === 'UPSERT' ? 'PLATE_UPSERT' : 'PLATE_DELETE'
    const out: Record<string, any> = { plate: payload.plate }
    if (payload.owner !== undefined) out.owner = payload.owner
    if (op === 'UPSERT') {
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
   * Mirror dla PIN-ów gości — Faza 2D Akuvox. Edge trzyma PIN-y w
   * lokalnej tabeli `guest_pins`, walidacja domofonu offline.
   */
  private syncGuestPin(
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

  /** Distinct, niepuste nazwy serwisów w tym budynku — do autocomplete. */
  async listServiceNames(buildingId: number): Promise<string[]> {
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

  /** Distinct tagi pojazdów już użyte w tym budynku — autocomplete dla TagPicker. */
  async listVehicleTags(buildingId: number): Promise<string[]> {
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
}
