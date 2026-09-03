import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { PrismaService } from '../prisma/prisma.service'
import { PushService } from '../push/push.service'
import { EdgeGateway } from '../edge/edge.gateway'
import { ResidentAssistantService } from './resident-assistant.service'

const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

interface CalendarEvent {
  date: string
  title: string
  icon?: string
}

const TZ = 'Europe/Warsaw'

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
    const ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) return []
    try {
      const res = await undiciFetch(`http://${ip}:4000/assistant/calendar?days=3`, {
        dispatcher: edgeDispatcher,
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) return []
      const data = (await res.json()) as { events?: CalendarEvent[] }
      return (data.events ?? []).filter((e) => e.date === dayKey)
    } catch (err: any) {
      this.logger.warn(`calendar fetch b${buildingId} failed: ${err?.message}`)
      return []
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
          '🗑️ Jutro odbiór odpadów',
          `Jutro: ${label}. Wystaw kubły dziś wieczorem.`,
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
          'Dzień dobry 👋 Twój dzień na osiedlu',
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
          '📖 Kronika dnia na osiedlu',
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
  async fetchChronicle(buildingId: number, smart = true): Promise<{
    date: string | null
    lines: string[]
    narrative: string | null
    push_text: string | null
    events: Array<{ type: string; title: string; startedTs: number }>
    traffic?: { ins: number; outs: number; unmatched: number; total: number }
  } | null> {
    const ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) return null
    try {
      const res = await undiciFetch(
        `http://${ip}:4000/assistant/chronicle?smart=${smart ? '1' : '0'}`,
        { dispatcher: edgeDispatcher, signal: AbortSignal.timeout(50_000) },
      )
      if (!res.ok) return null
      return (await res.json()) as any
    } catch (err: any) {
      this.logger.warn(`chronicle fetch b${buildingId} failed: ${err?.message}`)
      return null
    }
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
      lines.push(`🗑️ Dziś odbiór: ${this.wasteLabel(todayWaste)} — wystaw kubły.`)
    const personal = await this.assistant
      .buildPersonalDayLines(buildingId, residentId, { includeArrears: opts.includeArrears })
      .catch(() => [] as string[])
    lines.push(...personal)
    return lines
  }
}
