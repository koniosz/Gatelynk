import { PrismaService } from '../prisma/prisma.service'

/**
 * Wspólna logika pobierania historii zdarzeń gości — używana przez
 * `BuildingAdminService.getGuestsHistory` i `ConciergeService.getGuestsHistory`.
 *
 * Łączy dwa źródła:
 *   • `guest_events` z `via='PORTAL_OPEN'` (kliknięcia w portalu /g/<token>)
 *   • `lpr_reads` z `matched=true` JOIN-owane po `vehiclePlate` z `guests`
 *     w oknie ważności (LPR rozpoznał tablicę aktualnego gościa)
 *
 * Każde query bierze max 100 najnowszych wierszy, merge w JS, slice 100.
 * UNION ALL w SQL byłby krótszy, ale wymagałby castów (różne typy kolumn) —
 * tutaj prościej tak.
 *
 * Output: posortowane DESC po `ts`, bez paginacji (admin/konsjerż widzą
 * krótką, ostatnią listę zdarzeń; głębsza historia → osobny endpoint
 * z kursorem, jeśli zajdzie potrzeba).
 */

export type GuestHistoryItem =
  | {
      kind: 'PORTAL_OPEN'
      id: string                     // unique key dla React (`portal-${eventId}`)
      ts: Date
      guestId: number | null
      guestName: string | null
      vehiclePlate: string | null
      residentId: number | null
      residentName: string | null    // "Jan Kowalski" — sklejone w SQL
      accessPointId: number | null
      accessPointLabel: string | null
      actorIp: string | null
    }
  | {
      kind: 'PLATE_MATCH'
      id: string                     // `lpr-${lprReadId}`
      ts: Date
      guestId: number | null
      guestName: string | null
      vehiclePlate: string | null    // tablica z `lpr_reads.plate`
      residentId: number | null
      residentName: string | null
      gateOpened: boolean
      reason: string | null          // 'cooldown'/'gate_error' itp. (dla niektórych może być null)
    }

interface PortalRow {
  event_id: number
  ts: Date
  guest_id: number | null
  guest_name: string | null
  vehicle_plate: string | null
  resident_id: number | null
  resident_first_name: string | null
  resident_last_name: string | null
  access_point_id: number | null
  access_point_label: string | null
  actor_ip: string | null
}

interface LprRow {
  lpr_read_id: number
  ts: Date
  guest_id: number | null
  guest_name: string | null
  plate: string
  resident_id: number | null
  resident_first_name: string | null
  resident_last_name: string | null
  gate_opened: boolean
  reason: string | null
}

const HISTORY_LIMIT = 100

export async function getGuestsHistoryFor(
  prisma: PrismaService,
  buildingId: number,
): Promise<GuestHistoryItem[]> {
  const [portalRows, lprRows] = await Promise.all([
    prisma.$queryRaw<PortalRow[]>`
      SELECT
        e.id              AS event_id,
        e.ts              AS ts,
        g.id              AS guest_id,
        g.name            AS guest_name,
        g."vehiclePlate"  AS vehicle_plate,
        g."residentId"    AS resident_id,
        r."firstName"     AS resident_first_name,
        r."lastName"      AS resident_last_name,
        ap.id             AS access_point_id,
        ap.label          AS access_point_label,
        e."actorIp"       AS actor_ip
      FROM "guest_events" e
      LEFT JOIN "guests" g         ON g.id  = e."guestId"
      LEFT JOIN "residents" r      ON r.id  = e."residentId"
      LEFT JOIN "access_points" ap ON ap.id = e."accessPointId"
      WHERE e."buildingId" = ${buildingId}
        AND e.via = 'PORTAL_OPEN'
      ORDER BY e.ts DESC
      LIMIT ${HISTORY_LIMIT}
    `,
    // LPR matche gości — JOIN po vehiclePlate w oknie validity. `matched=true`
    // w lpr_reads to liberalna flaga (każde dopasowanie do allowlisty), ale
    // dodatkowo musi być w oknie czasowym konkretnego ACTIVE-gościa, żeby
    // nie pokazywać zdarzeń z wygasłych zaproszeń jako „aktualne".
    prisma.$queryRaw<LprRow[]>`
      SELECT
        lr.id          AS lpr_read_id,
        lr.ts          AS ts,
        g.id           AS guest_id,
        g.name         AS guest_name,
        lr.plate       AS plate,
        g."residentId" AS resident_id,
        r."firstName"  AS resident_first_name,
        r."lastName"   AS resident_last_name,
        lr."gateOpened" AS gate_opened,
        lr.reason      AS reason
      FROM "lpr_reads" lr
      JOIN "guests" g
        ON g."buildingId"   = lr."buildingId"
       AND g."vehiclePlate" IS NOT NULL
       AND g."vehiclePlate" = lr.plate
       AND lr.ts BETWEEN g."validFrom" AND g."validTo"
      LEFT JOIN "residents" r ON r.id = g."residentId"
      WHERE lr."buildingId" = ${buildingId}
        AND lr.matched = true
      ORDER BY lr.ts DESC
      LIMIT ${HISTORY_LIMIT}
    `,
  ])

  const portal: GuestHistoryItem[] = portalRows.map((r) => ({
    kind: 'PORTAL_OPEN' as const,
    id: `portal-${r.event_id}`,
    ts: r.ts,
    guestId: r.guest_id,
    guestName: r.guest_name,
    vehiclePlate: r.vehicle_plate,
    residentId: r.resident_id,
    residentName: joinName(r.resident_first_name, r.resident_last_name),
    accessPointId: r.access_point_id,
    accessPointLabel: r.access_point_label,
    actorIp: r.actor_ip,
  }))

  const lpr: GuestHistoryItem[] = lprRows.map((r) => ({
    kind: 'PLATE_MATCH' as const,
    id: `lpr-${r.lpr_read_id}`,
    ts: r.ts,
    guestId: r.guest_id,
    guestName: r.guest_name,
    vehiclePlate: r.plate,
    residentId: r.resident_id,
    residentName: joinName(r.resident_first_name, r.resident_last_name),
    gateOpened: r.gate_opened,
    reason: r.reason,
  }))

  return [...portal, ...lpr]
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, HISTORY_LIMIT)
}

function joinName(first: string | null, last: string | null): string | null {
  const f = (first ?? '').trim()
  const l = (last ?? '').trim()
  const joined = `${f} ${l}`.trim()
  return joined.length > 0 ? joined : null
}
