// 2026-06-02 (FAZA d) — Courier visit service.
//
// Kurier wpisuje 4-cyfrowy kod na klawiaturze Akuvox przy bramie. Edge
// (HikvisionLprService / IntercomEventController) sprawdza kolejno guest_pins,
// resident_pins; brak match-u → emit `COURIER_VISIT_NEW` przez WS tunnel.
// Cloud przyjmuje przez EdgeGateway.handleMessage('EVT'), woła
// `CourierVisitService.recordNewVisit()` → tworzy row PENDING + push do
// mieszkancow.
//
// Mieszkaniec klika 'Wpusc' w iOS → POST accept → status=ACCEPTED + fire AP
// → szlaban sie otwiera. 'Nie znam' → status=REJECTED.
//
// Cron `expireOldVisits` co 5 min ustawia PENDING > expiresAt na EXPIRED.

import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { EdgeGateway } from '../edge/edge.gateway'
import { PushService } from '../push/push.service'
import { AccessEventsService } from '../access-events/access-events.service'
import {
  hasPermission,
  normalizePermissions,
  featKey,
  FEATURE_DISABLED_CODE,
  FEATURE_DISABLED_MESSAGE,
} from '../buildings/feature-permissions.constants'

const VISIT_TTL_MS = 30 * 60 * 1000 // 30 min

interface CourierVisitRow {
  id: number
  buildingId: number
  code: string
  courierBrand: string | null
  targetUnitId: number | null
  status: string
  createdAt: Date
  resolvedAt: Date | null
  resolvedBy: number | null
  expiresAt: Date
}

@Injectable()
export class CourierVisitService {
  private readonly logger = new Logger(CourierVisitService.name)

  constructor(
    private prisma: PrismaService,
    private edgeGateway: EdgeGateway,
    private push: PushService,
    private accessEvents: AccessEventsService,
  ) {}

  /**
   * Edge zgloszone nowa wizyta (kurier wpisal kod ktorego nie ma w
   * guest_pins/resident_pins). Tworzymy CourierVisit PENDING + broadcast push.
   *
   * Brak ratelimitu — w tym MVP zakladamy ze Edge sam dba o spam (cooldown
   * po blednym kodzie). Pozniej dodamy unique constraint per (buildingId, code, status='PENDING').
   */
  async recordNewVisit(
    buildingId: number,
    code: string,
    opts: { courierBrand?: string | null; mac?: string } = {},
  ): Promise<CourierVisitRow> {
    if (!/^\d{4}$/.test(code)) {
      throw new BadRequestException('Kod kuriera musi miec 4 cyfry')
    }

    const expiresAt = new Date(Date.now() + VISIT_TTL_MS)

    // Raw INSERT — Prisma client w monorepo bywa rozjechany (5.22/7.5 drift),
    // a CourierVisit to nowy model. Raw zostaje na bezpieczne strony.
    const rows = await this.prisma.$queryRaw<CourierVisitRow[]>`
      INSERT INTO "courier_visits" ("buildingId", code, "courierBrand", status, "expiresAt", "createdAt")
      VALUES (${buildingId}, ${code}, ${opts.courierBrand ?? null}, 'PENDING', ${expiresAt}, CURRENT_TIMESTAMP)
      RETURNING id, "buildingId", code, "courierBrand", "targetUnitId", status,
                "createdAt", "resolvedAt", "resolvedBy", "expiresAt"
    `
    const visit = rows[0]

    // Broadcast push do wszystkich mieszkancow w budynku z push tokenami.
    // Stylowo dla MVP: bez selekcji domu (kurier nie wie do kogo idzie).
    this.broadcastNewVisit(visit, opts.mac).catch((err) =>
      this.logger.warn(`broadcast push failed for visit#${visit.id}: ${err.message}`),
    )

    return visit
  }

  /**
   * Mieszkaniec klika 'Wpusc' w iOS. Sprawdzamy ze visit jest PENDING
   * (nie wygasl, nie zostal juz rozstrzygniety) i ze rezydent jest w tym
   * budynku. Status -> ACCEPTED + fire AP_TEST_FIRE do Edge.
   *
   * Wybor AP do otwarcia: pierwszy AP w budynku z category='MAIN_ENTRY'
   * (domyslna brama). Jesli takiego nie ma — pierwszy aktywny.
   */
  async accept(visitId: number, residentId: number, buildingId: number): Promise<{ ok: true; apId: number | null }> {
    await this.requireCourierFeature(buildingId)
    const visit = await this.findActive(visitId, buildingId)

    // Wybierz AP do fire — najpierw MAIN_ENTRY, potem dowolny aktywny.
    const ap = await this.prisma.accessPoint.findFirst({
      where: { buildingId, isActive: true, category: 'MAIN_ENTRY' },
      orderBy: { sortOrder: 'asc' },
    }) ?? await this.prisma.accessPoint.findFirst({
      where: { buildingId, isActive: true },
      orderBy: { sortOrder: 'asc' },
    })

    await this.prisma.$executeRaw`
      UPDATE "courier_visits"
         SET status = 'ACCEPTED', "resolvedAt" = CURRENT_TIMESTAMP, "resolvedBy" = ${residentId}
       WHERE id = ${visitId}
    `

    if (ap) {
      this.edgeGateway.sendToBuilding(buildingId, 'AP_TEST_FIRE', {
        apId: ap.id,
        actor: `RESIDENT:${residentId}`,
        meta: { source: 'courier-visit-accept', visitId, courierCode: visit.code },
      }).catch((err) =>
        this.logger.warn(`AP_TEST_FIRE (courier accept) failed: ${err.message}`),
      )
      // Audit
      this.accessEvents.record({
        buildingId,
        type: 'REMOTE_OPEN',
        accessPointId: ap.id,
        gateOpened: true,
        residentId,
        openedById: residentId,
        openedByType: 'RESIDENT',
        meta: { source: 'courier-visit-accept', visitId, code: visit.code },
      }).catch(() => { /* fail-silent */ })
    }

    return { ok: true, apId: ap?.id ?? null }
  }

  /** Mieszkaniec klika 'Nie znam'. Status REJECTED, brak fire AP. */
  async reject(visitId: number, residentId: number, buildingId: number): Promise<{ ok: true }> {
    await this.requireCourierFeature(buildingId)
    await this.findActive(visitId, buildingId)
    await this.prisma.$executeRaw`
      UPDATE "courier_visits"
         SET status = 'REJECTED', "resolvedAt" = CURRENT_TIMESTAMP, "resolvedBy" = ${residentId}
       WHERE id = ${visitId}
    `
    return { ok: true }
  }

  /** Lista aktywnych/dzisiejszych wizyt dla BA panelu. */
  async listForBuilding(
    buildingId: number,
    opts: { limit?: number; status?: string } = {},
  ): Promise<CourierVisitRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
    if (opts.status) {
      return this.prisma.$queryRaw<CourierVisitRow[]>`
        SELECT id, "buildingId", code, "courierBrand", "targetUnitId", status,
               "createdAt", "resolvedAt", "resolvedBy", "expiresAt"
          FROM "courier_visits"
         WHERE "buildingId" = ${buildingId} AND status = ${opts.status}
         ORDER BY "createdAt" DESC
         LIMIT ${limit}
      `
    }
    return this.prisma.$queryRaw<CourierVisitRow[]>`
      SELECT id, "buildingId", code, "courierBrand", "targetUnitId", status,
             "createdAt", "resolvedAt", "resolvedBy", "expiresAt"
        FROM "courier_visits"
       WHERE "buildingId" = ${buildingId}
       ORDER BY "createdAt" DESC
       LIMIT ${limit}
    `
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** FAZA e — guard `feat_courier_visits` per budynek. */
  private async requireCourierFeature(buildingId: number) {
    const rows = await this.prisma.$queryRaw<{ featurePermissions: unknown }[]>`
      SELECT "featurePermissions" FROM "buildings" WHERE id = ${buildingId} LIMIT 1
    `
    const perms = normalizePermissions(rows[0]?.featurePermissions)
    if (!hasPermission(perms, 'resident', featKey('courier_visits'))) {
      throw new ForbiddenException({
        message: FEATURE_DISABLED_MESSAGE,
        code: FEATURE_DISABLED_CODE,
        feature: 'courier_visits',
      })
    }
  }

  private async findActive(visitId: number, buildingId: number): Promise<CourierVisitRow> {
    const rows = await this.prisma.$queryRaw<CourierVisitRow[]>`
      SELECT id, "buildingId", code, "courierBrand", "targetUnitId", status,
             "createdAt", "resolvedAt", "resolvedBy", "expiresAt"
        FROM "courier_visits"
       WHERE id = ${visitId}
    `
    if (rows.length === 0) throw new NotFoundException('Wizyta nie istnieje')
    const visit = rows[0]
    if (visit.buildingId !== buildingId) throw new ForbiddenException()
    if (visit.status !== 'PENDING') {
      throw new BadRequestException(`Wizyta juz w stanie ${visit.status}`)
    }
    if (visit.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Wizyta wygasla')
    }
    return visit
  }

  private async broadcastNewVisit(visit: CourierVisitRow, mac?: string) {
    const title = 'Kurier przy bramie'
    const body = `Kurier${visit.courierBrand ? ` ${visit.courierBrand}` : ''} podał kod ${visit.code}. Czy wpuścić?`
    // PushService.sendToBuilding wysyla do wszystkich rezydentow w budynku.
    // iOS Notification category 'COURIER_VISIT' przekazany w data.category
    // (klient iOS odczyta i pokaze przyciski 'Wpusc'/'Nie znam' — Faza d iOS).
    await this.push.sendToBuilding(visit.buildingId, title, body, {
      type: 'COURIER_VISIT',
      category: 'COURIER_VISIT',
      visitId: String(visit.id),
      code: visit.code,
      buildingId: String(visit.buildingId),
      mac: mac ?? '',
    })
  }

  // ── Cron expire ──────────────────────────────────────────────────────────

  /**
   * Co 5 min: PENDING > expiresAt → EXPIRED. Brak push do mieszkancow —
   * kurier juz dawno odszedl jak wizyta wygasla.
   */
  @Interval(5 * 60 * 1000)
  async expireOldVisits() {
    const res = await this.prisma.$executeRaw`
      UPDATE "courier_visits"
         SET status = 'EXPIRED'
       WHERE status = 'PENDING' AND "expiresAt" < CURRENT_TIMESTAMP
    `
    if (Number(res) > 0) {
      this.logger.log(`expireOldVisits: marked ${res} visits as EXPIRED`)
    }
  }
}
