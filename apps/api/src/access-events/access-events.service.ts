import { Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

/**
 * AccessEventsService — single source of truth for "kto i jak wszedł do budynku"
 * (Faza 3 Villa Natura). Append-only audit; hooki w serwisach LPR/PIN/remote-open
 * wstawiają tu nowe wpisy obok źródeł domenowych (lpr_reads, guest_events).
 *
 * Świadomie NIE używamy Prisma Client — z powodu konfliktu wersji 7.5/5.22
 * w monorepo `prisma generate` często failuje. Wszystko leci raw SQL.
 *
 * Dedup: dla LPR `(buildingId, type, lprReadId)` — jeśli ten sam LprRead został
 * już zauditowany, INSERT no-op'uje przez WHERE NOT EXISTS. Brak unique constraint,
 * bo czysto append-only — fanout LPR-MATCH/LPR_NO_MATCH/PIN_USED jednoznacznie
 * z różnych ścieżek.
 */

export type AccessEventType =
  | 'LPR_MATCH'
  | 'LPR_NO_MATCH'
  | 'PIN_USED'
  | 'REMOTE_OPEN'
  | 'MANUAL_OPEN'
  | 'INTERCOM_CALL'

export type OpenedByType = 'RESIDENT' | 'ADMIN' | 'CONCIERGE' | 'EDGE' | 'SYSTEM'

export interface RecordEventInput {
  buildingId: number
  type: AccessEventType
  ts?: Date
  accessPointId?: number | null
  direction?: string | null
  gateOpened?: boolean
  reason?: string | null
  residentId?: number | null
  vehicleId?: number | null
  guestId?: number | null
  lprReadId?: number | null
  plate?: string | null
  openedById?: number | null
  openedByType?: OpenedByType | null
  meta?: Record<string, unknown> | null
}

export interface ListEventsOpts {
  limit?: number
  /** Pagination offset (0-based). */
  offset?: number
  type?: AccessEventType | null
  /** Filtruj po polu plate (snapshot — działa po wygaśnięciu LprReada). */
  plate?: string | null
  /** Tylko eventy konkretnego rezydenta. */
  residentId?: number | null
  /** Tylko eventy konkretnego gościa. */
  guestId?: number | null
  /** Tylko eventy z ustawionym guestId (feed „aktywność gości"). */
  guestsOnly?: boolean
  /**
   * Free-text search po polach widocznych w wierszu listy: plate +
   * resident name/unit + guest name + openedBy name + accessPoint label +
   * reason. Server-side ILIKE — wyszukiwarka „live" widzi wszystkie wpisy
   * w bazie, nie tylko stronę.
   */
  q?: string | null
}

/** Wiersz zwracany przez listEvents — joined z access_points/residents/guests. */
export interface AccessEventRow {
  id: string                     // BigInt → string (JSON-safe)
  ts: Date
  type: AccessEventType
  direction: string | null
  gateOpened: boolean
  reason: string | null
  plate: string | null
  // Access point
  accessPointId: number | null
  accessPointLabel: string | null
  // Resident
  residentId: number | null
  residentName: string | null    // "Jan Kowalski" — sklejone w SQL
  residentUnitNumber: string | null
  // Vehicle
  vehicleId: number | null
  vehicleBrand: string | null
  vehicleModel: string | null
  // Guest
  guestId: number | null
  guestName: string | null
  // Opened-by (polymorphic)
  openedById: number | null
  openedByType: OpenedByType | null
  openedByName: string | null    // resolved server-side z residents/admins/concierges
  meta: Record<string, unknown> | null
}

@Injectable()
export class AccessEventsService {
  private readonly logger = new Logger(AccessEventsService.name)

  constructor(private prisma: PrismaService) {}

  /**
   * Zapisz event. Fail-safe: błędy są logowane i wyciszane — audit nigdy
   * nie powinien wywalić user-facing flow (otwierania bramki, walidacji PIN-u).
   *
   * Dla LPR-ów (lprReadId nie-null) używamy WHERE NOT EXISTS żeby zapobiec
   * duplikatom przy backfillu z Edge.
   */
  async record(input: RecordEventInput): Promise<void> {
    const ts = input.ts ?? new Date()
    const meta = input.meta ? JSON.stringify(input.meta) : null
    try {
      if (input.lprReadId != null) {
        await this.prisma.$executeRaw`
          INSERT INTO "access_events"
            ("buildingId", "accessPointId", "ts", "type", "direction",
             "gateOpened", "reason",
             "residentId", "vehicleId", "guestId", "lprReadId", "plate",
             "openedById", "openedByType", "meta")
          SELECT
            ${input.buildingId}, ${input.accessPointId ?? null}, ${ts}, ${input.type}::"AccessEventType", ${input.direction ?? null},
            ${input.gateOpened ?? false}, ${input.reason ?? null},
            ${input.residentId ?? null}, ${input.vehicleId ?? null}, ${input.guestId ?? null},
            ${input.lprReadId}, ${input.plate ?? null},
            ${input.openedById ?? null}, ${input.openedByType ?? null}, ${meta}::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM "access_events"
            WHERE "lprReadId" = ${input.lprReadId} AND "type" = ${input.type}::"AccessEventType"
          )
        `
      } else {
        await this.prisma.$executeRaw`
          INSERT INTO "access_events"
            ("buildingId", "accessPointId", "ts", "type", "direction",
             "gateOpened", "reason",
             "residentId", "vehicleId", "guestId", "lprReadId", "plate",
             "openedById", "openedByType", "meta")
          VALUES
            (${input.buildingId}, ${input.accessPointId ?? null}, ${ts}, ${input.type}::"AccessEventType", ${input.direction ?? null},
             ${input.gateOpened ?? false}, ${input.reason ?? null},
             ${input.residentId ?? null}, ${input.vehicleId ?? null}, ${input.guestId ?? null},
             ${null}, ${input.plate ?? null},
             ${input.openedById ?? null}, ${input.openedByType ?? null}, ${meta}::jsonb)
        `
      }
    } catch (err: any) {
      this.logger.warn(
        `AccessEvent insert failed (building ${input.buildingId}, type ${input.type}): ${err.message}`,
      )
    }
  }

  /**
   * Zwróć stronę eventów dla budynku + total count, wzbogacone joinami.
   * Domyślny limit 50. Wszystkie filtry opcjonalne.
   *
   * Filtry łączymy `Prisma.sql` fragmentami żeby uniknąć dublowania zapytań
   * dla każdej kombinacji. `q` (free-text) dotyka kolumn widocznych w
   * wierszu — plate, residentName, guestName, openedByName, accessPointLabel,
   * residentUnitNumber, reason. Wszystko ILIKE (case-insensitive) — wyjątek
   * `e.plate` które idzie LIKE z normalised query bo jest zawsze upper-case.
   *
   * Total leci osobnym COUNT(*) z tym samym WHERE+JOIN — na 30-dniowym oknie
   * to ~ms, a daje paginacji „strona X z Y".
   */
  async listForBuilding(
    buildingId: number,
    opts: ListEventsOpts = {},
  ): Promise<{ events: AccessEventRow[]; total: number }> {
    const limit = clampInt(opts.limit ?? 50, 1, 200)
    const offset = clampInt(opts.offset ?? 0, 0, 1_000_000)
    const type = opts.type ?? null
    const plate = opts.plate ? opts.plate.toUpperCase() : null
    const q = (opts.q ?? '').trim()

    // WHERE clauses — jednolicie przez Prisma.sql.
    const parts: Prisma.Sql[] = [Prisma.sql`e."buildingId" = ${buildingId}`]
    if (type) parts.push(Prisma.sql`e.type = ${type}::"AccessEventType"`)
    if (plate) parts.push(Prisma.sql`e.plate = ${plate}`)
    if (opts.residentId != null) parts.push(Prisma.sql`e."residentId" = ${opts.residentId}`)
    if (opts.guestId != null) parts.push(Prisma.sql`e."guestId" = ${opts.guestId}`)
    if (opts.guestsOnly) parts.push(Prisma.sql`e."guestId" IS NOT NULL`)
    if (q.length > 0) {
      const qLike = `%${q}%`
      const plateLike = `%${q.toUpperCase().replace(/[^A-Z0-9]/g, '')}%`
      // `v.serviceName`, `v.notes` i `v.tags` (TEXT[] via unnest) — symetrycznie
      // do wyszukiwania w `lpr-reads`. User chce wpisać „kurier" i znaleźć
      // wpisy zarówno przez serviceName="Kurier GLS" jak i tag="kurier".
      parts.push(Prisma.sql`(
        e.plate LIKE ${plateLike}
        OR e.reason ILIKE ${qLike}
        OR ap.label ILIKE ${qLike}
        OR r."firstName" ILIKE ${qLike}
        OR r."lastName" ILIKE ${qLike}
        OR u.number ILIKE ${qLike}
        OR g.name ILIKE ${qLike}
        OR v.make ILIKE ${qLike}
        OR v.model ILIKE ${qLike}
        OR v."serviceName" ILIKE ${qLike}
        OR v.notes ILIKE ${qLike}
        OR EXISTS (SELECT 1 FROM unnest(COALESCE(v.tags, '{}'::text[])) AS t WHERE t ILIKE ${qLike})
        OR ob_r."firstName" ILIKE ${qLike}
        OR ob_r."lastName" ILIKE ${qLike}
        OR ob_a.name ILIKE ${qLike}
        OR ob_c.name ILIKE ${qLike}
      )`)
    }
    const where = Prisma.join(parts, ' AND ')

    // Wspólny FROM+JOIN łańcuch — używany i w COUNT, i w SELECT (dzięki temu
    // q po `r."firstName"` itd. zachowuje się tak samo w obu zapytaniach).
    const joins = Prisma.sql`
      "access_events" e
      LEFT JOIN "access_points" ap ON ap.id = e."accessPointId"
      LEFT JOIN "residents" r      ON r.id  = e."residentId"
      LEFT JOIN LATERAL (
        SELECT u.number
        FROM "unit_residents" ur
        JOIN "units" u ON u.id = ur."unitId"
        WHERE ur."residentId" = e."residentId"
          AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
        ORDER BY ur."sinceDate" DESC
        LIMIT 1
      ) u ON true
      LEFT JOIN "vehicles" v       ON v.id  = e."vehicleId"
      LEFT JOIN "guests" g         ON g.id  = e."guestId"
      LEFT JOIN "residents" ob_r   ON ob_r.id  = e."openedById" AND e."openedByType" = 'RESIDENT'
      LEFT JOIN "building_admins" ob_a ON ob_a.id = e."openedById" AND e."openedByType" = 'ADMIN'
      LEFT JOIN "concierges" ob_c  ON ob_c.id  = e."openedById" AND e."openedByType" = 'CONCIERGE'
    `

    interface Row {
      id: string
      ts: Date
      type: AccessEventType
      direction: string | null
      gateOpened: boolean
      reason: string | null
      plate: string | null
      access_point_id: number | null
      access_point_label: string | null
      resident_id: number | null
      resident_first_name: string | null
      resident_last_name: string | null
      resident_unit_number: string | null
      vehicle_id: number | null
      vehicle_brand: string | null
      vehicle_model: string | null
      guest_id: number | null
      guest_name: string | null
      opened_by_id: number | null
      opened_by_type: OpenedByType | null
      opened_by_resident_first: string | null
      opened_by_resident_last: string | null
      opened_by_admin_name: string | null
      opened_by_concierge_name: string | null
      meta: Record<string, unknown> | null
    }

    const totalRows = await this.prisma.$queryRaw<{ c: number }[]>`
      SELECT COUNT(*)::int AS c
        FROM ${joins}
       WHERE ${where}
    `
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        e.id::text                 AS id,
        e.ts                       AS ts,
        e.type                     AS type,
        e.direction                AS direction,
        e."gateOpened"             AS "gateOpened",
        e.reason                   AS reason,
        e.plate                    AS plate,
        e."accessPointId"          AS access_point_id,
        ap.label                   AS access_point_label,
        e."residentId"             AS resident_id,
        r."firstName"              AS resident_first_name,
        r."lastName"               AS resident_last_name,
        u.number                   AS resident_unit_number,
        e."vehicleId"              AS vehicle_id,
        v."make"                   AS vehicle_brand,
        v."model"                  AS vehicle_model,
        e."guestId"                AS guest_id,
        g.name                     AS guest_name,
        e."openedById"             AS opened_by_id,
        e."openedByType"           AS opened_by_type,
        ob_r."firstName"           AS opened_by_resident_first,
        ob_r."lastName"            AS opened_by_resident_last,
        ob_a.name                  AS opened_by_admin_name,
        ob_c.name                  AS opened_by_concierge_name,
        e.meta                     AS meta
      FROM ${joins}
      WHERE ${where}
      ORDER BY e.ts DESC
      LIMIT ${limit} OFFSET ${offset}
    `

    const events = rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      direction: r.direction,
      gateOpened: r.gateOpened,
      reason: r.reason,
      plate: r.plate,
      accessPointId: r.access_point_id,
      accessPointLabel: r.access_point_label,
      residentId: r.resident_id,
      residentName: joinName(r.resident_first_name, r.resident_last_name),
      residentUnitNumber: r.resident_unit_number,
      vehicleId: r.vehicle_id,
      vehicleBrand: r.vehicle_brand,
      vehicleModel: r.vehicle_model,
      guestId: r.guest_id,
      guestName: r.guest_name,
      openedById: r.opened_by_id,
      openedByType: r.opened_by_type,
      openedByName: resolveOpenedByName(r),
      meta: r.meta,
    }))
    return { events, total: totalRows[0]?.c ?? 0 }
  }

  /**
   * Lista dla rezydenta — pokazuje tylko jego własne wejścia: REMOTE_OPEN
   * (gdy on otwierał) + LPR_MATCH dla jego pojazdów + WSZYSTKIE eventy jego
   * gości (PIN_USED / LPR z guestId / REMOTE_OPEN z portalu).
   * To jest „moja historia", nie cały feed budynku.
   *
   * Filtry `guestId` / `guestsOnly` (2026-07-04) — per-gość historia w iOS
   * GuestsView. Prywatność: filtr guestId jest AND-owany ze scope-OR-em
   * poniżej, więc gość innego mieszkańca (residentId≠, brak pojazdu, brak
   * openedBy) nigdy nie przejdzie — resident dostaje pustą listę zamiast
   * cudzych zdarzeń.
   */
  async listForResident(
    residentId: number,
    buildingId: number,
    opts: { limit?: number; guestId?: number | null; guestsOnly?: boolean } = {},
  ): Promise<AccessEventRow[]> {
    const limit = clampInt(opts.limit ?? 20, 1, 200)

    // Scope prywatności (twardy — zawsze obecny): moje otwarcia + eventy
    // przypisane do mnie + moje pojazdy + moi goście (guests.residentId = ja).
    const scope = Prisma.sql`(
      (e."openedByType" = 'RESIDENT' AND e."openedById" = ${residentId})
      OR (e."residentId" = ${residentId})
      OR (e."vehicleId" IN (SELECT id FROM "vehicles" WHERE "residentId" = ${residentId}))
      OR (e."guestId"   IN (SELECT id FROM "guests"   WHERE "residentId" = ${residentId}))
    )`
    const parts: Prisma.Sql[] = [Prisma.sql`e."buildingId" = ${buildingId}`, scope]
    if (opts.guestId != null) parts.push(Prisma.sql`e."guestId" = ${opts.guestId}`)
    if (opts.guestsOnly) parts.push(Prisma.sql`e."guestId" IS NOT NULL`)
    const where = Prisma.join(parts, ' AND ')

    // Najpierw zbieramy id-ki interesujących nas eventów (resident-scoped),
    // potem wyciągamy je z głównego query żeby reuse-ować joiny. Prościej:
    // jeden raw query z OR-em.
    interface Row {
      id: string
      ts: Date
      type: AccessEventType
      direction: string | null
      gateOpened: boolean
      reason: string | null
      plate: string | null
      access_point_id: number | null
      access_point_label: string | null
      resident_id: number | null
      resident_first_name: string | null
      resident_last_name: string | null
      resident_unit_number: string | null
      vehicle_id: number | null
      vehicle_brand: string | null
      vehicle_model: string | null
      guest_id: number | null
      guest_name: string | null
      opened_by_id: number | null
      opened_by_type: OpenedByType | null
      opened_by_resident_first: string | null
      opened_by_resident_last: string | null
      opened_by_admin_name: string | null
      opened_by_concierge_name: string | null
      meta: Record<string, unknown> | null
    }

    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        e.id::text                 AS id,
        e.ts                       AS ts,
        e.type                     AS type,
        e.direction                AS direction,
        e."gateOpened"             AS "gateOpened",
        e.reason                   AS reason,
        e.plate                    AS plate,
        e."accessPointId"          AS access_point_id,
        ap.label                   AS access_point_label,
        e."residentId"             AS resident_id,
        r."firstName"              AS resident_first_name,
        r."lastName"               AS resident_last_name,
        u.number                   AS resident_unit_number,
        e."vehicleId"              AS vehicle_id,
        v."make"                   AS vehicle_brand,
        v."model"                  AS vehicle_model,
        e."guestId"                AS guest_id,
        g.name                     AS guest_name,
        e."openedById"             AS opened_by_id,
        e."openedByType"           AS opened_by_type,
        ob_r."firstName"           AS opened_by_resident_first,
        ob_r."lastName"            AS opened_by_resident_last,
        ob_a.name                  AS opened_by_admin_name,
        ob_c.name                  AS opened_by_concierge_name,
        e.meta                     AS meta
      FROM "access_events" e
      LEFT JOIN "access_points" ap ON ap.id = e."accessPointId"
      LEFT JOIN "residents" r      ON r.id  = e."residentId"
      LEFT JOIN LATERAL (
        SELECT u.number
        FROM "unit_residents" ur
        JOIN "units" u ON u.id = ur."unitId"
        WHERE ur."residentId" = e."residentId"
          AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
        ORDER BY ur."sinceDate" DESC
        LIMIT 1
      ) u ON true
      LEFT JOIN "vehicles" v       ON v.id  = e."vehicleId"
      LEFT JOIN "guests" g         ON g.id  = e."guestId"
      LEFT JOIN "residents" ob_r   ON ob_r.id  = e."openedById" AND e."openedByType" = 'RESIDENT'
      LEFT JOIN "building_admins" ob_a ON ob_a.id = e."openedById" AND e."openedByType" = 'ADMIN'
      LEFT JOIN "concierges" ob_c  ON ob_c.id  = e."openedById" AND e."openedByType" = 'CONCIERGE'
      WHERE ${where}
      ORDER BY e.ts DESC
      LIMIT ${limit}
    `

    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      direction: r.direction,
      gateOpened: r.gateOpened,
      reason: r.reason,
      plate: r.plate,
      accessPointId: r.access_point_id,
      accessPointLabel: r.access_point_label,
      residentId: r.resident_id,
      residentName: joinName(r.resident_first_name, r.resident_last_name),
      residentUnitNumber: r.resident_unit_number,
      vehicleId: r.vehicle_id,
      vehicleBrand: r.vehicle_brand,
      vehicleModel: r.vehicle_model,
      guestId: r.guest_id,
      guestName: r.guest_name,
      openedById: r.opened_by_id,
      openedByType: r.opened_by_type,
      openedByName: resolveOpenedByName(r),
      meta: r.meta,
    }))
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function joinName(first: string | null, last: string | null): string | null {
  const f = (first ?? '').trim()
  const l = (last ?? '').trim()
  const j = `${f} ${l}`.trim()
  return j.length > 0 ? j : null
}

function resolveOpenedByName(r: {
  opened_by_type: OpenedByType | null
  opened_by_resident_first: string | null
  opened_by_resident_last: string | null
  opened_by_admin_name: string | null
  opened_by_concierge_name: string | null
}): string | null {
  switch (r.opened_by_type) {
    case 'RESIDENT':
      return joinName(r.opened_by_resident_first, r.opened_by_resident_last)
    case 'ADMIN':
      return r.opened_by_admin_name
    case 'CONCIERGE':
      return r.opened_by_concierge_name
    case 'EDGE':
      return 'Edge'
    case 'SYSTEM':
      return 'System'
    default:
      return null
  }
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  return Math.max(min, Math.min(max, Math.floor(v)))
}
