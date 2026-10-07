import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { PrismaService } from '../prisma/prisma.service'
import { PushService } from '../push/push.service'
import { EdgeGateway } from '../edge/edge.gateway'
import { ResidentAssistantService } from './resident-assistant.service'
import { ARREARS_REMINDER_TITLE } from '../building-admin/building-admin.service'

const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

interface CalendarEvent {
  date: string
  title: string
  icon?: string
}

const TZ = 'Europe/Warsaw'

/**
 * Karta „Najnowsze na osiedlu" w iOS (2026-10-08) — fakty dnia zamiast
 * akapitów z LLM: aktualne ogłoszenie administracji, przejazdy MOICH aut,
 * kurierzy / taksówki / śmieciarka z kamer i odbiór odpadów dziś/jutro.
 */
export interface EstateToday {
  announcement: { id: number; title: string; body: string; sentAt: string } | null
  /** null = mieszkaniec nie ma zatwierdzonego pojazdu (wiersz ukryty). */
  myVehicles: { vehicles: number; entries: number; exits: number; lastAt: string | null } | null
  /** null = Edge nieosiągalny (iOS: „brak danych z kamer"). */
  estate: {
    couriers: Array<{ label: string; visits: number; lastAt: string }>
    taxis: number
    wasteTruck: { visits: number; lastAt: string } | null
  } | null
  wastePickup: { today: string | null; tomorrow: string | null }
  generatedAt: string
}

/** Ogłoszenie starsze niż tydzień nie jest już „aktualne". */
const ANNOUNCEMENT_MAX_AGE_DAYS = 7
/** Dane z Edge (kronika + harmonogram) wspólne dla budynku — krótki cache. */
const ESTATE_TTL_MS = 3 * 60_000
/** Kolejne odczyty tego samego kierunku w tym oknie = jeden przejazd. */
const PASS_DEDUP_MS = 3 * 60_000

/** YYYY-MM-DD w strefie osiedla (serwer Fly działa w UTC). */
function warsawDayKey(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(
    new Date(Date.now() + offsetDays * 24 * 3600 * 1000),
  )
}

function warsawWeekday(): number {
  // 1=pon … 7=niedz (jak ISO)
  const short = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(
    new Date(),
  )
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[short] ?? 1
}

/**
 * Day Summary v2 — pushe nawykowe (2026-08-17):
 *
 *  1. 19:00 — „🗑️ Jutro odbiór: bio — wystaw kubły dziś wieczorem"
 *     (broadcast per budynek, gdy harmonogram Edge ma jutrzejszy odbiór).
 *  2. 7:30 — poranny brief per mieszkaniec (morningBriefEnabled, default ON):
 *     dzisiejszy odbiór + sekcja osobista (goście / nowe ogłoszenie;
 *     zaległość TYLKO pn i czw — codzienne to samo push = irytacja).
 *     Bez treści = bez pusha (cisza > spam).
 *
 * Harmonogram czytany z Edge `/assistant/calendar` (deterministyczny parser
 * KB — waste_calendar.py). Edge offline / brak harmonogramu = po prostu brak
 * pusha, nigdy błąd. Crony w strefie osiedla (Europe/Warsaw) — serwer UTC.
 */
@Injectable()
export class DailyBriefService {
  private readonly logger = new Logger(DailyBriefService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly edgeGateway: EdgeGateway,
    private readonly assistant: ResidentAssistantService,
  ) {}

  /** Budynki, w których ktokolwiek ma token push (innych nie ma sensu budzić). */
  private async buildingsWithPushTokens(): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<Array<{ buildingId: number }>>`
      SELECT DISTINCT r."buildingId"
        FROM residents r
        JOIN push_tokens pt ON pt."residentId" = r.id
       WHERE pt.kind = 'apns'
    `
    return rows.map((r) => r.buildingId)
  }

  /** Eventy harmonogramu z Edge dla danego dnia (YYYY-MM-DD). [] przy błędzie. */
  private async wasteEventsForDay(buildingId: number, dayKey: string): Promise<CalendarEvent[]> {
    return ((await this.wasteEventsAhead(buildingId)) ?? []).filter((e) => e.date === dayKey)
  }

  /** Harmonogram na 3 dni z Edge. null przy błędzie (≠ pusty harmonogram). */
  private async wasteEventsAhead(buildingId: number): Promise<CalendarEvent[] | null> {
    const ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) return null
    try {
      const res = await undiciFetch(`http://${ip}:4000/assistant/calendar?days=3`, {
        dispatcher: edgeDispatcher,
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { events?: CalendarEvent[] }
      return data.events ?? []
    } catch (err: any) {
      this.logger.warn(`calendar fetch b${buildingId} failed: ${err?.message}`)
      return null
    }
  }

  private wasteLabel(events: CalendarEvent[]): string {
    // "Odbiór bio" → "bio"; złączone przecinkami.
    return events
      .map((e) => (e.title || '').replace(/^odbi[oó]r\s+/i, '').trim() || 'odpady')
      .join(', ')
  }

  // ── 1. Wieczorne „wystaw kubły" — 19:00 czasu osiedla ────────────────────
  @Cron('0 19 * * *', { timeZone: TZ })
  async eveningWasteReminder(): Promise<void> {
    const tomorrow = warsawDayKey(1)
    const buildings = await this.buildingsWithPushTokens().catch(() => [] as number[])
    for (const buildingId of buildings) {
      try {
        const events = await this.wasteEventsForDay(buildingId, tomorrow)
        if (events.length === 0) continue
        const label = this.wasteLabel(events)
        await this.push.sendToBuilding(
          buildingId,
          'Odbiór odpadów jutro',
          `Jutro: ${label}. Prosimy wystawić pojemniki dziś wieczorem.`,
          { type: 'waste-reminder', date: tomorrow },
        )
        this.logger.log(`evening waste reminder → b${buildingId}: ${label}`)
      } catch (err: any) {
        this.logger.warn(`evening reminder b${buildingId} failed: ${err?.message}`)
      }
    }
  }

  // ── 2. Poranny brief — 7:30 czasu osiedla ────────────────────────────────
  @Cron('30 7 * * *', { timeZone: TZ })
  async morningBrief(): Promise<void> {
    const today = warsawDayKey(0)
    const dow = warsawWeekday()
    const includeArrears = dow === 1 || dow === 4 // pn / czw

    const residents = await this.prisma.$queryRaw<
      Array<{ id: number; buildingId: number }>
    >`
      SELECT DISTINCT r.id, r."buildingId"
        FROM residents r
        JOIN push_tokens pt ON pt."residentId" = r.id AND pt.kind = 'apns'
       WHERE r."morningBriefEnabled" = true
    `
    if (residents.length === 0) return

    // Harmonogram per budynek — raz, nie per mieszkaniec.
    const wasteByBuilding = new Map<number, CalendarEvent[]>()
    for (const b of new Set(residents.map((r) => r.buildingId))) {
      wasteByBuilding.set(b, await this.wasteEventsForDay(b, today))
    }

    let sent = 0
    for (const r of residents) {
      try {
        const lines = await this.buildMorningLines(r.buildingId, r.id, {
          includeArrears,
          todayWaste: wasteByBuilding.get(r.buildingId) ?? [],
        })
        if (lines.length === 0) continue // cisza > pusty push
        await this.push.sendToResident(
          r.id,
          'Poranne podsumowanie',
          lines.slice(0, 3).join('\n'),
          { type: 'morning-brief', date: today },
        )
        sent += 1
      } catch (err: any) {
        this.logger.warn(`morning brief resident ${r.id} failed: ${err?.message}`)
      }
    }
    this.logger.log(`morning brief: sent ${sent}/${residents.length}`)
  }

  // ── 3. „Kronika dnia" — 21:00 czasu osiedla (2026-08-26) ─────────────────
  // Digest zdarzeń sytuacyjnych (korelator Edge: tailgating / krążący pojazd /
  // osoba w nocy / wizyta kuriera / upadek) + statystyka ruchu, składany
  // w ai-prototype (`/chronicle` przez Edge proxy). Push TYLKO gdy Edge
  // zwrócił push_text (≥1 zdarzenie sytuacyjne — sama statystyka = spam).
  @Cron('0 21 * * *', { timeZone: TZ })
  async eveningChronicle(): Promise<void> {
    const buildings = await this.buildingsWithPushTokens().catch(() => [] as number[])
    for (const buildingId of buildings) {
      try {
        const chronicle = await this.fetchChronicle(buildingId)
        if (!chronicle?.push_text) continue
        await this.push.sendToBuilding(
          buildingId,
          'Kronika dnia',
          chronicle.push_text,
          { type: 'evening-chronicle', date: chronicle.date ?? warsawDayKey(0) },
        )
        this.logger.log(
          `evening chronicle → b${buildingId}: ${chronicle.events?.length ?? 0} event(s)`,
        )
      } catch (err: any) {
        this.logger.warn(`evening chronicle b${buildingId} failed: ${err?.message}`)
      }
    }
  }

  /** Kronika z Edge (`/assistant/chronicle` → prototyp). null przy błędzie. */
  async fetchChronicle(buildingId: number, smart = true, timeoutMs = 50_000): Promise<{
    date: string | null
    lines: string[]
    narrative: string | null
    push_text: string | null
    events: Array<{ type: string; title: string; startedTs: number }>
    traffic?: { ins: number; outs: number; unmatched: number; total: number }
    /** 2026-10-08 — zestawienie dnia (starszy prototyp: brak pola). */
    today?: {
      couriers: Array<{ brand: string; label: string; visits: number; lastTs: number }>
      taxis: number
      wasteTruck: { visits: number; lastTs: number } | null
    }
  } | null> {
    const ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) return null
    try {
      const res = await undiciFetch(
        `http://${ip}:4000/assistant/chronicle?smart=${smart ? '1' : '0'}`,
        { dispatcher: edgeDispatcher, signal: AbortSignal.timeout(timeoutMs) },
      )
      if (!res.ok) return null
      return (await res.json()) as any
    } catch (err: any) {
      this.logger.warn(`chronicle fetch b${buildingId} failed: ${err?.message}`)
      return null
    }
  }

  // ── 4. Karta „Najnowsze na osiedlu" (2026-10-08) ───────────────────────

  private readonly estateCache = new Map<
    number,
    { at: number; estate: EstateToday['estate']; pickup: EstateToday['wastePickup'] }
  >()

  async estateToday(buildingId: number, residentId: number, refresh = false): Promise<EstateToday> {
    const [announcement, myVehicles, edge] = await Promise.all([
      this.currentAnnouncement(buildingId, residentId),
      this.myVehiclesToday(buildingId, residentId),
      this.estateFromEdge(buildingId, refresh),
    ])
    return {
      announcement,
      myVehicles,
      estate: edge.estate,
      wastePickup: edge.pickup,
      generatedAt: new Date().toISOString(),
    }
  }

  /** Najnowsze ogłoszenie ADMINISTRACJI (wysłane przez BA, nie przypomnienie
   *  o zaległości) z ostatniego tygodnia — broadcast albo imienne. */
  private async currentAnnouncement(
    buildingId: number,
    residentId: number,
  ): Promise<EstateToday['announcement']> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: number; title: string; body: string; sentAt: Date }>
    >`
      SELECT id, title, body, "sentAt"
        FROM notifications
       WHERE "buildingId" = ${buildingId}
         AND ("residentId" IS NULL OR "residentId" = ${residentId})
         AND "senderBaId" IS NOT NULL
         AND title <> ${ARREARS_REMINDER_TITLE}
         AND "sentAt" >= NOW() - (${ANNOUNCEMENT_MAX_AGE_DAYS}::int * INTERVAL '1 day')
       ORDER BY "sentAt" DESC
       LIMIT 1
    `
    const a = rows[0]
    if (!a) return null
    return { id: a.id, title: a.title, body: a.body, sentAt: a.sentAt.toISOString() }
  }

  /** Dzisiejsze (czas osiedla) wjazdy i wyjazdy zatwierdzonych pojazdów
   *  mieszkańca z access_events. Kilka odczytów jednego przejazdu (odczyt
   *  + cooldown) liczy się raz. */
  private async myVehiclesToday(
    buildingId: number,
    residentId: number,
  ): Promise<EstateToday['myVehicles']> {
    const [{ n }] = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM vehicles
       WHERE "residentId" = ${residentId} AND "buildingId" = ${buildingId}
         AND status = 'APPROVED'
    `
    if (!n) return null
    const rows = await this.prisma.$queryRaw<Array<{ ts: Date; direction: string | null }>>`
      SELECT e.ts, e.direction
        FROM access_events e
       WHERE e."buildingId" = ${buildingId}
         AND e."vehicleId" IN (
               SELECT id FROM vehicles
                WHERE "residentId" = ${residentId} AND "buildingId" = ${buildingId})
         AND e.type IN ('LPR_MATCH', 'LPR_NO_MATCH')
         AND e.ts >= (date_trunc('day', NOW() AT TIME ZONE ${TZ})
                        AT TIME ZONE ${TZ} AT TIME ZONE 'UTC')
       ORDER BY e.ts ASC
    `
    const passes = countPasses(rows)
    return { vehicles: n, ...passes }
  }

  private async estateFromEdge(
    buildingId: number,
    refresh: boolean,
  ): Promise<{ estate: EstateToday['estate']; pickup: EstateToday['wastePickup'] }> {
    const cached = this.estateCache.get(buildingId)
    if (cached && !refresh && Date.now() - cached.at < ESTATE_TTL_MS) return cached
    const [chronicle, calendar] = await Promise.all([
      this.fetchChronicle(buildingId, false, 8_000),
      this.wasteEventsAhead(buildingId),
    ])
    const t = chronicle?.today
    const estate: EstateToday['estate'] = t
      ? {
          couriers: t.couriers.map((c) => ({
            label: c.label,
            visits: c.visits,
            lastAt: new Date(c.lastTs).toISOString(),
          })),
          taxis: t.taxis,
          wasteTruck: t.wasteTruck
            ? { visits: t.wasteTruck.visits, lastAt: new Date(t.wasteTruck.lastTs).toISOString() }
            : null,
        }
      : null
    const day = (key: string) => {
      const events = (calendar ?? []).filter((e) => e.date === key)
      return events.length ? this.wasteLabel(events) : null
    }
    const pickup = { today: day(warsawDayKey(0)), tomorrow: day(warsawDayKey(1)) }
    // Nie cache-ujemy porażki Edge — następne otwarcie karty spróbuje znowu.
    const entry = { at: Date.now(), estate, pickup }
    if (estate) this.estateCache.set(buildingId, entry)
    return entry
  }

  /**
   * Treść porannego briefu — także dla endpointu preview (E2E / przyszły
   * podgląd w iOS). Kolejność: odbiór dziś → sekcja osobista.
   */
  async buildMorningLines(
    buildingId: number,
    residentId: number,
    opts: { includeArrears: boolean; todayWaste?: CalendarEvent[] },
  ): Promise<string[]> {
    const lines: string[] = []
    const todayWaste =
      opts.todayWaste ?? (await this.wasteEventsForDay(buildingId, warsawDayKey(0)))
    if (todayWaste.length > 0)
      lines.push(`Dziś odbiór odpadów: ${this.wasteLabel(todayWaste)}. Prosimy wystawić pojemniki.`)
    const personal = await this.assistant
      .buildPersonalDayLines(buildingId, residentId, { includeArrears: opts.includeArrears })
      .catch(() => [] as string[])
    lines.push(...personal)
    return lines
  }
}

/** Kolejne odczyty tego samego kierunku w PASS_DEDUP_MS = jeden przejazd. */
export function countPasses(
  rows: Array<{ ts: Date; direction: string | null }>,
): { entries: number; exits: number; lastAt: string | null } {
  let entries = 0
  let exits = 0
  let last: { dir: string; ts: number } | null = null
  for (const r of rows) {
    const raw = String(r.direction ?? '').toUpperCase()
    const dir = raw === 'IN' || raw === 'FORWARD' ? 'in' : raw === 'OUT' || raw === 'REVERSE' ? 'out' : null
    if (!dir) continue
    const ts = r.ts.getTime()
    if (last && last.dir === dir && ts - last.ts <= PASS_DEDUP_MS) {
      last.ts = ts
      continue
    }
    if (dir === 'in') entries++
    else exits++
    last = { dir, ts }
  }
  const lastAt = rows.length ? rows[rows.length - 1].ts.toISOString() : null
  return { entries, exits, lastAt }
}
