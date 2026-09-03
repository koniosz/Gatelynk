/**
 * ResidentAssistantController — proxy dla iOS app → Edge AI assistant.
 *
 * Flow:
 *   iOS (HTTPS + JWT)
 *     → Cloud /api/resident/assistant/ask        ← TEN controller
 *     → undici fetch via Tailscale proxy (TS_HTTP_PROXY)
 *     → Edge http://<edge-ip>:4000/assistant/ask
 *     → Python prototype localhost:8000
 *     → response
 *
 * Dlaczego nie WS tunnel (EdgeOutbox): assistant query musi mieć synchronous
 * round-trip z response (user czeka na odpowiedź). Outbox jest fire-and-forget
 * dla syncu (PIN_UPSERT, PLATE_UPSERT). HTTP przez TS jest natural fit.
 *
 * Auth: jwt-resident — JWT ma `buildingId` w payloadzie, dzięki temu wiemy
 * z którego Edge zapytać. Multi-building user wybiera building w login
 * (resident-auth.select-building).
 *
 * Timeout: 60s (smart mode bywa wolny przy cold LLM).
 */
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import type { Request } from 'express'
import { DailyBriefService } from './daily-brief.service'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { EdgeGateway } from '../edge/edge.gateway'
import { PrismaService } from '../prisma/prisma.service'
import { ResidentAssistantService } from './resident-assistant.service'

// Ten sam pattern co IntegratorService/ResidentService — Cloud na Fly.io
// chodzi przez tailscaled userspace HTTP proxy na localhost:1055.
const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

interface AuthReq extends Request {
  user: { id: number; email: string; buildingId: number; residentId: number }
}

interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

interface AssistantBody {
  question?: string
  /** true = LLM smart mode (~7s), false = template fast (~10ms). Default true. */
  smart?: boolean
  /**
   * Last N user/assistant turns z iOS (Multi-turn 2026-05-20). Pozwala
   * prototype-owi rozwiązać zaimki/elipsy w follow-up pytaniach
   * ("A jego mail?" → "Adres email Janusza Aszklara").
   */
  history?: ConversationTurn[]
}

interface EdgeAssistantResponse {
  answer: string
  trace?: unknown[]
  modelUsed?: string
  totalMs?: number
  intent?: string
  parameters?: Record<string, unknown>
  data?: unknown
  followUps?: string[]
  rewrittenQuestion?: string
}

/**
 * In-memory cache dla `/today-summary` — generujemy raz na 30 min per budynek.
 * Kasuje się przy każdym deploy-u (no big deal — pierwszy hit po deployu
 * tylko regeneruje). Klucz: buildingId. Wartość: { text, generatedAt }.
 *
 * Dlaczego 30 min a nie 60: ruch w bramie/kamerach zmienia się dynamicznie
 * przez dzień; 30 min daje świeży snapshot przy ~6 hitach dziennie z iOS
 * (poranek + każde uruchomienie app). Nie jest "live" — to świadoma decyzja
 * żeby nie palić Edge AI inferencji co minutę (każda call ~3-7s).
 */
const TODAY_SUMMARY_TTL_MS = 30 * 60 * 1000
const todaySummaryCache = new Map<number, { text: string; generatedAt: number; intent?: string }>()

/**
 * Cache dla `/day-summary` — dwa pytania równolegle (predictions + recap)
 * z osobnymi tekstami. TTL ten sam co today-summary (30 min). Klucz: buildingId.
 *
 * Predictions ("co dziś się wydarzy") zmienia się raczej rzadko w ciągu dnia
 * (planowane przerwy/odbiory wpisane w KB), ale recap rośnie z każdym przejazdem
 * po osiedlu. TTL 30 min to kompromis dla obu — predictions akceptowalnie
 * fresh, recap nie pali Edge inferencji co minutę.
 */
const DAY_SUMMARY_TTL_MS = 30 * 60 * 1000
interface DaySummarySection {
  text: string
  intent?: string
  source?: string
}
const daySummaryCache = new Map<
  number,
  { predictions: DaySummarySection; recap: DaySummarySection; generatedAt: number }
>()

/**
 * Cache dla `/calendar` (FAZA 8.h.28) — strukturalny harmonogram śmieci jako
 * per-dzień eventy. Edge czyta KB deterministycznie (regex dat, bez LLM) więc
 * tani, ale TTL i tak cache-ujemy żeby nie bić Edge przy każdym otwarciu
 * Kalendarza w iOS. Harmonogram zmienia się rzadko (admin upload). Klucz:
 * `${buildingId}:${days}`.
 */
const CALENDAR_TTL_MS = 15 * 60 * 1000
interface CalendarEvent {
  date: string
  type: string
  category?: string
  title: string
  icon?: string
}
interface CalendarPayload {
  days: number
  from: string | null
  to: string | null
  events: CalendarEvent[]
  source?: string
  scheduledTickets?: unknown[]
}
const calendarCache = new Map<string, { payload: CalendarPayload; generatedAt: number }>()

@Controller('resident/assistant')
export class ResidentAssistantController {
  private readonly logger = new Logger(ResidentAssistantController.name)

  constructor(
    private readonly edgeGateway: EdgeGateway,
    private readonly localAssistant: ResidentAssistantService,
    private readonly prisma: PrismaService,
    private readonly dailyBrief: DailyBriefService,
  ) {}

  /**
   * FAZA 8.h.25 — fire-and-forget log Q/A do `assistant_query_logs`.
   * Integrator ocenia odpowiedzi w tymczasowym panelu (dataset do
   * dostrojenia LLM). Błąd zapisu NIE może zablokować odpowiedzi userowi.
   */
  private logQuery(entry: {
    buildingId: number
    role: 'RESIDENT' | 'BUILDING_ADMIN'
    userId?: number
    question: string
    answer: string
    intent?: string
    totalMs?: number
    model?: string
    smart: boolean
  }) {
    void this.prisma.assistantQueryLog
      .create({
        data: {
          buildingId: entry.buildingId,
          role: entry.role,
          userId: entry.userId ?? null,
          question: entry.question.slice(0, 2000),
          answer: entry.answer.slice(0, 8000),
          intent: entry.intent ?? null,
          totalMs: entry.totalMs ?? null,
          model: entry.model ?? null,
          smart: entry.smart,
        },
      })
      .catch((err: Error) => this.logger.warn(`assistant query log failed: ${err.message}`))
  }

  /**
   * GET /api/resident/today-summary
   * Returns LLM-generated answer for "Co ciekawego działo się dzisiaj?"
   * (intent `recent_activity_summary` z range_hours=24 w AI prototype).
   *
   * Cache 30 min per budynek żeby nie palić Edge AI przy każdym ⌘R Home view.
   * `?refresh=1` pomija cache (pull-to-refresh w iOS).
   */
  @Get('today-summary')
  @UseGuards(AuthGuard('jwt-resident'))
  async todaySummary(@Req() req: AuthReq, @Query('refresh') refresh?: string) {
    const buildingId = req.user.buildingId
    const wantsRefresh = refresh === '1' || refresh === 'true'
    const now = Date.now()

    const cached = todaySummaryCache.get(buildingId)
    if (!wantsRefresh && cached && now - cached.generatedAt < TODAY_SUMMARY_TTL_MS) {
      return {
        text: cached.text,
        intent: cached.intent,
        generatedAt: new Date(cached.generatedAt).toISOString(),
        fromCache: true,
      }
    }

    // Pobieramy z Edge (AI prototype). Question pasuje do `_looks_like_activity_summary`
    // w intent_classifier.py i zwróci structured answer z `build_activity_summary`.
    const ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      this.logger.warn(`No Edge IP for building ${buildingId} — today-summary unavailable`)
      throw new ServiceUnavailableException('Asystent niedostępny — Edge tego budynku nie jest aktywny')
    }

    const edgeUrl = `http://${ip}:4000/assistant/ask`
    const question = 'Co ciekawego działo się dzisiaj?'
    const start = Date.now()
    try {
      const edgeRes = await undiciFetch(edgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, smart: true }),
        dispatcher: edgeDispatcher,
        signal: AbortSignal.timeout(60_000),
      })
      if (!edgeRes.ok) {
        const t = await edgeRes.text().catch(() => '')
        this.logger.warn(`today-summary edge HTTP ${edgeRes.status}: ${t.slice(0, 200)}`)
        throw new BadGatewayException(`Edge HTTP ${edgeRes.status}`)
      }
      const data = (await edgeRes.json()) as EdgeAssistantResponse
      const text = data.answer?.trim() ?? ''
      if (!text) throw new BadGatewayException('Pusta odpowiedź z Edge')

      todaySummaryCache.set(buildingId, {
        text,
        generatedAt: now,
        intent: data.intent,
      })
      this.logger.log(
        `[building ${buildingId}] today-summary regen intent=${data.intent} ${Date.now() - start}ms`,
      )
      return {
        text,
        intent: data.intent,
        generatedAt: new Date(now).toISOString(),
        fromCache: false,
      }
    } catch (err: any) {
      this.logger.error(`today-summary failed for building ${buildingId}: ${err.message}`)
      // Gdy mamy ważny lub przeterminowany cache — oddaj go zamiast 502.
      // Lepsze pokazać starsze podsumowanie niż żadne.
      if (cached) {
        return {
          text: cached.text,
          intent: cached.intent,
          generatedAt: new Date(cached.generatedAt).toISOString(),
          fromCache: true,
          stale: true,
        }
      }
      throw err instanceof BadGatewayException
        ? err
        : new BadGatewayException(`Edge nie odpowiada: ${err.message}`)
    }
  }

  /**
   * GET /api/resident/assistant/day-summary
   *
   * Zwraca DWIE sekcje generowane przez Bielika na Edge AI prototype:
   *   • predictions — „Co dziś się wydarzy" (przyszłe odbiory śmieci,
   *     planowane przerwy w wodzie/prądzie, planowane wizyty z KB).
   *   • recap — „Co dziś się działo" (LPR + vision z ostatnich 24h).
   *
   * Wykonujemy oba pytania równolegle (Promise.allSettled) — jeśli jeden
   * Edge fail-uje, drugi może i tak zwrócić. Cache per budynek 30 min,
   * `?refresh=1` pomija. Jeśli oba zawiodą i nie ma cache → 502.
   *
   * Frontend (iOS HomeView) pokazuje card z dwoma sekcjami; sekcja z błędem
   * renderuje fallback text "Brak danych".
   */
  @Get('day-summary')
  @UseGuards(AuthGuard('jwt-resident'))
  async daySummary(@Req() req: AuthReq, @Query('refresh') refresh?: string) {
    const buildingId = req.user.buildingId
    const wantsRefresh = refresh === '1' || refresh === 'true'
    // Day Summary v2 (2026-08-17): sekcja OSOBISTA (goście/zaległości/
    // ogłoszenia) liczona świeżo per request — cache per-BUDYNEK nie może
    // trzymać danych jednego mieszkańca. Doklejana na początek predictions,
    // więc stary build iOS pokazuje ją bez żadnych zmian w apce.
    const [payload, personal] = await Promise.all([
      this.daySummaryCore(buildingId, wantsRefresh),
      this.localAssistant
        .buildPersonalDayLines(buildingId, req.user.residentId)
        .catch((err: any) => {
          this.logger.warn(`personal day lines failed: ${err?.message}`)
          return [] as string[]
        }),
    ])
    if (personal.length === 0) return payload
    const p = (payload as { predictions?: { text?: string; source?: string } }).predictions
    return {
      ...payload,
      predictions: {
        ...(p ?? {}),
        text: personal.join('\n') + (p?.text ? '\n\n' + p.text : ''),
        source: `personal+${p?.source ?? 'edge'}`,
      },
      personalized: true,
    }
  }

  /**
   * GET /api/resident/assistant/daily-brief/preview
   * Podgląd treści porannego briefu (7:30) BEZ wysyłania pusha — E2E +
   * przyszły podgląd w ustawieniach iOS.
   */
  @Get('daily-brief/preview')
  @UseGuards(AuthGuard('jwt-resident'))
  async dailyBriefPreview(@Req() req: AuthReq) {
    const lines = await this.dailyBrief.buildMorningLines(
      req.user.buildingId,
      req.user.residentId,
      { includeArrears: true },
    )
    return { lines, wouldSend: lines.length > 0 }
  }

  /**
   * GET /api/resident/assistant/chronicle
   * „Kronika dnia" (2026-08-26): digest zdarzeń sytuacyjnych + statystyki
   * z Edge — treść pusha 21:00 + pełna wersja (lines/narrative/events) dla
   * przyszłego widoku w iOS. `?smart=0` pomija narrację Bielika (szybkie E2E).
   */
  @Get('chronicle')
  @UseGuards(AuthGuard('jwt-resident'))
  async chronicle(@Req() req: AuthReq, @Query('smart') smartRaw?: string) {
    const chronicle = await this.dailyBrief.fetchChronicle(
      req.user.buildingId,
      smartRaw !== '0',
    )
    return chronicle ?? { date: null, lines: [], narrative: null, push_text: null, events: [] }
  }

  /**
   * PATCH /api/resident/assistant/morning-brief  Body: { enabled: boolean }
   * Opt-out z porannego briefu (default ON). Raw SQL — generated Prisma
   * Client może nie znać świeżej kolumny przed generate (konwencja repo).
   */
  @Patch('morning-brief')
  @UseGuards(AuthGuard('jwt-resident'))
  async setMorningBrief(@Req() req: AuthReq, @Body() body: { enabled?: boolean }) {
    const enabled = body?.enabled !== false
    await this.prisma.$executeRaw`
      UPDATE residents SET "morningBriefEnabled" = ${enabled} WHERE id = ${req.user.residentId}
    `
    return { enabled }
  }

  private async daySummaryCore(buildingId: number, wantsRefresh: boolean) {
    const now = Date.now()

    const cached = daySummaryCache.get(buildingId)
    if (!wantsRefresh && cached && now - cached.generatedAt < DAY_SUMMARY_TTL_MS) {
      return {
        predictions: cached.predictions,
        recap: cached.recap,
        generatedAt: new Date(cached.generatedAt).toISOString(),
        fromCache: true,
      }
    }

    const ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      this.logger.warn(`No Edge IP for building ${buildingId} — day-summary unavailable`)
      // Gdy mamy stary cache, oddaj go (stale=true) zamiast 503.
      if (cached) {
        return {
          predictions: cached.predictions,
          recap: cached.recap,
          generatedAt: new Date(cached.generatedAt).toISOString(),
          fromCache: true,
          stale: true,
        }
      }
      throw new ServiceUnavailableException('Asystent niedostępny — Edge tego budynku nie jest aktywny')
    }

    // ── FAZA 8.h.20 (2026-06-11) — najpierw CACHE z Edge background loop ──
    // ai-prototype generuje podsumowanie co 20 min w tle; Edge Node proxy
    // `GET /assistant/day-summary` zwraca je w ~5ms. User NIGDY nie czeka
    // na Bielika. Fallback do starej on-demand ścieżki gdy Edge ma starszy
    // build (404) albo cache jeszcze pusty (pierwsze ~60s po boot).
    try {
      const cachedRes = await undiciFetch(`http://${ip}:4000/assistant/day-summary`, {
        dispatcher: edgeDispatcher,
        signal: AbortSignal.timeout(8_000),
      })
      if (cachedRes.ok) {
        const edge = (await cachedRes.json()) as {
          predictions: { text: string; intent?: string; generatedAt?: string } | null
          recap: { text: string; intent?: string; generatedAt?: string } | null
          generatedAt: string | null
        }
        if (edge.predictions?.text || edge.recap?.text) {
          const result = {
            predictions: edge.predictions?.text
              ? { text: edge.predictions.text, source: edge.predictions.intent ?? 'edge-cache' }
              : { text: 'Na dziś brak zaplanowanych wydarzeń.', source: 'fallback' },
            recap: edge.recap?.text
              ? { text: edge.recap.text, source: edge.recap.intent ?? 'edge-cache' }
              : { text: 'Brak podsumowania aktywności.', source: 'fallback' },
          }
          daySummaryCache.set(buildingId, {
            predictions: result.predictions,
            recap: result.recap,
            generatedAt: now,
          })
          return {
            ...result,
            generatedAt: edge.generatedAt ?? new Date(now).toISOString(),
            fromCache: true,
            edgePregenerated: true,
          }
        }
        // Cache pusty (świeży boot prototypu) → fall-through do on-demand.
        this.logger.log(`[building ${buildingId}] edge day-summary cache empty — on-demand fallback`)
      }
    } catch (err: any) {
      this.logger.warn(`edge day-summary cache fetch failed (${err?.message}) — on-demand fallback`)
    }

    const edgeUrl = `http://${ip}:4000/assistant/ask`

    // Dwa pytania równolegle. Predictions celuje w KB (harmonogram + ogłoszenia
    // planowane). Recap to istniejący „co ciekawego działo się dzisiaj".
    // Mamy świadomość że Bielik czasem zwraca dłuższy intro — system_prompt
    // w smart_responder.py rozwiązuje to po stronie Edge.
    // 90s — Bielik 14B na M1 z długim KB context (harmonogram + ogłoszenia)
    // potrafi pociągnąć 30-60s gdy LLM cold. 60s było za blisko granicy →
    // Edge timeout-ował, fallback do template_answer pokazywał raw chunks
    // ze score (i przez to duplikaty per dokument w iOS DaySummaryCard).
    // 90s zostawia margines bez męczenia user-a długim spinnerem (cache 30min
    // sprawia że tylko 1× per 30min user czeka — kolejne load są instant).
    const askEdge = async (question: string): Promise<{ text: string; intent?: string }> => {
      const res = await undiciFetch(edgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, smart: true }),
        dispatcher: edgeDispatcher,
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        throw new Error(`Edge HTTP ${res.status}: ${t.slice(0, 120)}`)
      }
      const data = (await res.json()) as EdgeAssistantResponse
      const text = data.answer?.trim() ?? ''
      if (!text) throw new Error('Pusta odpowiedź z Edge')

      // Defense-in-depth: jeśli Edge fallback-ował do template_answer (smart
      // LLM zawiódł, raw KB chunks zwrócone) — wykryj po prefixie "Znalazłem N
      // fragmentów w bazie wiedzy:" i zastąp prostym natural-language summary.
      // User dostanie czytelne "Sprawdź szczegóły w Ogłoszeniach" zamiast
      // ściany emoji-cytatów ze score'em (które wyglądają jak duplikaty gdy
      // ten sam tytuł dokumentu pokaże się 2×).
      const looksLikeRawTemplate = /^Znalazłem\s+\d+\s+fragment/.test(text)
      if (looksLikeRawTemplate) {
        return {
          text: 'W bazie wiedzy znaleziono harmonogram i ogłoszenia osiedla — sprawdź szczegóły w sekcji Ogłoszenia.',
          intent: data.intent,
        }
      }
      return { text, intent: data.intent }
    }

    const start = Date.now()
    const [predRes, recapRes] = await Promise.allSettled([
      // Pytanie celowo phrasowane tak, żeby zatrigerować
      // KNOWLEDGE_TRIGGER_KEYWORDS (harmonogram/planowany odbiór) ALBO
      // przyszłe ogłoszenia (KB type=INNE). Wynik = Bielik łączy je w 1-3 zdania.
      askEdge('Co dziś jest zaplanowane na osiedlu? Wymień planowane odbiory śmieci, planowane przerwy w wodzie lub prądzie i inne wydarzenia z harmonogramu. Jeśli na dziś nie ma nic zaplanowanego, podaj NAJBLIŻSZE nadchodzące wydarzenia z konkretnymi datami (np. najbliższy odbiór śmieci) — zacznij wtedy od \'Na dziś brak wydarzeń. Najbliżej:\'.'),
      askEdge('Co ciekawego działo się dzisiaj?'),
    ])

    const predictions: DaySummarySection =
      predRes.status === 'fulfilled'
        ? { text: predRes.value.text, intent: predRes.value.intent, source: 'edge' }
        : {
            text: 'Na dziś nic nie jest zaplanowane w bazie wiedzy.',
            source: 'fallback',
          }

    const recap: DaySummarySection =
      recapRes.status === 'fulfilled'
        ? { text: recapRes.value.text, intent: recapRes.value.intent, source: 'edge' }
        : {
            text: 'Brak danych z dzisiejszej aktywności.',
            source: 'fallback',
          }

    // Jeśli oba zawiodły, ale mamy cache — oddaj go zamiast pustego payloadu.
    if (predRes.status === 'rejected' && recapRes.status === 'rejected') {
      this.logger.error(
        `day-summary both failed for building ${buildingId}: pred=${predRes.reason} recap=${recapRes.reason}`,
      )
      if (cached) {
        return {
          predictions: cached.predictions,
          recap: cached.recap,
          generatedAt: new Date(cached.generatedAt).toISOString(),
          fromCache: true,
          stale: true,
        }
      }
      throw new BadGatewayException(`Edge nie odpowiada: ${(predRes.reason as Error).message}`)
    }

    daySummaryCache.set(buildingId, { predictions, recap, generatedAt: now })
    this.logger.log(
      `[building ${buildingId}] day-summary regen pred=${predRes.status} recap=${recapRes.status} ${Date.now() - start}ms`,
    )
    return {
      predictions,
      recap,
      generatedAt: new Date(now).toISOString(),
      fromCache: false,
    }
  }

  /**
   * GET /api/resident/assistant/calendar?days=7
   *
   * FAZA 8.h.28 — strukturalny kalendarz wydarzeń na najbliższe N dni.
   * Obecnie: harmonogram odbioru śmieci wyciągnięty DETERMINISTYCZNIE z bazy
   * wiedzy (Edge regex-parsuje daty per frakcja, BEZ LLM). Zwraca
   * `events: [{date, type, category, title, icon}]` — iOS CalendarView grupuje
   * po dacie i renderuje na kartach dni (zastępuje placeholder „Brak danych
   * z harmonogramu").
   *
   * Dlaczego osobny endpoint, nie parsing day-summary tekstu: day-summary to
   * wolny tekst Bielika (fragile do parsowania). Ten endpoint daje strukturę
   * per-dzień (intencja z komentarzy CalendarView.swift).
   *
   * Proxy: Cloud → Edge `GET /assistant/calendar` → prototype `GET /calendar`.
   * Cache 15 min per (building, days). `?refresh=1` pomija cache.
   */
  @Get('calendar')
  @UseGuards(AuthGuard('jwt-resident'))
  async calendar(
    @Req() req: AuthReq,
    @Query('days') daysRaw?: string,
    @Query('refresh') refresh?: string,
  ) {
    const buildingId = req.user.buildingId
    const days = Math.min(Math.max(parseInt(daysRaw ?? '7', 10) || 7, 1), 31)
    const wantsRefresh = refresh === '1' || refresh === 'true'
    const now = Date.now()
    const cacheKey = `${buildingId}:${days}`

    const cached = calendarCache.get(cacheKey)
    if (!wantsRefresh && cached && now - cached.generatedAt < CALENDAR_TTL_MS) {
      return { ...cached.payload, fromCache: true }
    }

    const ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      this.logger.warn(`No Edge IP for building ${buildingId} — calendar unavailable`)
      if (cached) return { ...cached.payload, fromCache: true, stale: true }
      // Bez Edge nie mamy harmonogramu — pusty kalendarz zamiast 503, żeby
      // iOS pokazał karty dni („brak wydarzeń") zamiast błędu ładowania.
      return { days, from: null, to: null, events: [], source: 'unavailable', scheduledTickets: [] }
    }

    try {
      const edgeRes = await undiciFetch(`http://${ip}:4000/assistant/calendar?days=${days}`, {
        dispatcher: edgeDispatcher,
        signal: AbortSignal.timeout(10_000),
      })
      if (!edgeRes.ok) throw new Error(`Edge HTTP ${edgeRes.status}`)
      const payload = (await edgeRes.json()) as CalendarPayload
      calendarCache.set(cacheKey, { payload, generatedAt: now })
      this.logger.log(
        `[building ${buildingId}] calendar days=${days} events=${payload.events?.length ?? 0}`,
      )
      return { ...payload, fromCache: false }
    } catch (err: any) {
      this.logger.warn(`calendar failed for building ${buildingId}: ${err.message}`)
      if (cached) return { ...cached.payload, fromCache: true, stale: true }
      return { days, from: null, to: null, events: [], source: 'unavailable', scheduledTickets: [] }
    }
  }

  /**
   * POST /api/resident/assistant/ask
   * Body: { question: string, smart?: boolean }
   *
   * Returns EdgeAssistantResponse — identyczny shape jak Edge /assistant/ask.
   */
  @Post('ask')
  @UseGuards(AuthGuard('jwt-resident'))
  async ask(@Body() body: AssistantBody, @Req() req: AuthReq) {
    const question = body?.question?.trim()
    if (!question) {
      throw new BadRequestException('Missing "question" field')
    }
    if (question.length > 500) {
      throw new BadRequestException('Question too long (max 500 chars)')
    }
    const smart = body?.smart !== false
    const history = sanitizeHistory(body?.history)

    const buildingId = req.user.buildingId
    const residentId = req.user.residentId

    // 1. Cloud-first routing — pytania o budynek/admina/lokal odpowiadamy
    //    bezpośrednio z Postgres (~30ms, deterministic, brak Edge dependency).
    //    Edge nie zna danych Cloud — bez tego "kto jest administratorem" zawsze
    //    zwracał unknown.
    //
    //    Multi-turn (2026-05-20): gdy mamy historię I pytanie wygląda na
    //    follow-up („A jego mail?", „A telefon?"), Cloud-side regex łapie
    //    fałszywie (np. „adres mail" → building_address → street). Lepiej
    //    skip-nąć lokalny routing i pozwolić prototype rewrite-ować pytanie
    //    używając kontekstu. Prototype zwróci coś sensownego, a jeśli nie —
    //    user dostanie informację że nie wie zamiast błędnej odpowiedzi.
    const skipLocal = history.length > 0 && looksLikeFollowup(question)
    const localAnswer = skipLocal
      ? null
      : await this.localAssistant.tryAnswerLocally(question, buildingId, residentId)
    if (localAnswer) {
      this.logger.log(
        `[building ${buildingId}/resident ${residentId}] LOCAL intent=${localAnswer.intent} ${localAnswer.totalMs}ms`,
      )
      this.logQuery({
        buildingId,
        role: 'RESIDENT',
        userId: residentId,
        question,
        answer: localAnswer.answer,
        intent: localAnswer.intent,
        totalMs: localAnswer.totalMs,
        model: 'cloud-local',
        smart,
      })
      return localAnswer
    }
    if (skipLocal) {
      this.logger.log(
        `[building ${buildingId}] follow-up detected (history=${history.length}) — skipping local routing`,
      )
    }

    // 2. Brak match w Cloud → forward do Edge (LPR, devices, events).
    const ip = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      this.logger.warn(`No Edge IP for building ${buildingId} — building has no activated Edge`)
      throw new ServiceUnavailableException(
        'Asystent niedostępny — Edge tego budynku nie jest aktywny',
      )
    }

    const edgeUrl = `http://${ip}:4000/assistant/ask`
    this.logger.log(
      `[building ${buildingId}/resident ${req.user.residentId}] → ${edgeUrl} [${smart ? 'smart' : 'fast'}, history=${history.length}] Q=${question.slice(0, 80)}`,
    )

    const edgePayload: Record<string, unknown> = { question, smart }
    if (history.length > 0) edgePayload.history = history

    const start = Date.now()
    let edgeRes: Awaited<ReturnType<typeof undiciFetch>>
    try {
      edgeRes = await undiciFetch(edgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edgePayload),
        dispatcher: edgeDispatcher,
        // 60s — smart mode (LLM cold) bywa wolny
        signal: AbortSignal.timeout(60_000),
      })
    } catch (err: any) {
      this.logger.error(`Edge fetch failed: ${err.message}`)
      throw new BadGatewayException(`Edge nie odpowiada: ${err.message}`)
    }

    if (!edgeRes.ok) {
      const text = await edgeRes.text().catch(() => '')
      this.logger.warn(`Edge HTTP ${edgeRes.status}: ${text.slice(0, 200)}`)
      throw new BadGatewayException(`Edge HTTP ${edgeRes.status}`)
    }

    const data = (await edgeRes.json()) as EdgeAssistantResponse
    const wallMs = Date.now() - start
    this.logger.log(
      `[building ${buildingId}] ← intent=${data.intent} ${wallMs}ms (edge=${data.totalMs ?? '?'}ms)${data.rewrittenQuestion ? ` rewrite="${data.rewrittenQuestion.slice(0, 60)}"` : ''}`,
    )
    this.logQuery({
      buildingId,
      role: 'RESIDENT',
      userId: residentId,
      question,
      answer: data.answer ?? '',
      intent: data.intent,
      totalMs: data.totalMs ?? wallMs,
      model: data.modelUsed,
      smart,
    })
    return data
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Defensive guard dla `history` z untrusted klienta. Te same reguły co
 * Edge sanitizeHistory (single source of truth — defensive both ends).
 * Drop non-arrays, broken items, zbyt długie content. Max 12 ostatnich tur.
 */
function sanitizeHistory(raw: unknown): ConversationTurn[] {
  if (!Array.isArray(raw)) return []
  const out: ConversationTurn[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = (item as { role?: unknown }).role
    const c = (item as { content?: unknown }).content
    if ((r !== 'user' && r !== 'assistant') || typeof c !== 'string') continue
    const content = c.trim().slice(0, 1000)
    if (!content) continue
    out.push({ role: r, content })
  }
  return out.slice(-12)
}

/**
 * Lekka heurystyka follow-up dla decyzji "czy skip cloud-local routing".
 * Mirror logiki z prototype/conversation.py — keep in sync gdy modyfikujesz.
 *
 * True gdy:
 *   • bardzo krótkie pytanie (≤30 chars I ≤4 wyrazy)
 *   • zawiera pronoun (jego/jej/ich/tego/tych/itp.)
 *   • zaczyna się od prefixu kontynuacji (A / Albo / Czy też / A co z)
 */
const FOLLOWUP_PRONOUN_RE =
  /\b(jego|jej|ich|im|tym|tych|tego|tej|tamten|tamta|tamto|tamtego|tamtej)\b/i
const FOLLOWUP_PREFIX_RE =
  /^(a\s+(?!by)|albo\s+|czy\s+te[zż]\s+|a\s+co\s+z\s+|daj\s+jeszcze|i\s+co\s+(z|jeszcze))/i
const QUESTION_STARTER_RE =
  /^(czy|ile|jak|jakie|jakim|jakich|kto|kiedy|gdzie|czemu|czego|który|która|które|co\s|poka[zż]|wymie[nń]|wy[sś]wietl)\b/i

function looksLikeFollowup(question: string): boolean {
  const q = question.trim()
  if (!q) return false
  const hasPronoun = FOLLOWUP_PRONOUN_RE.test(q)
  // Question-word start = samowystarczalne, chyba że ma zaimek.
  if (QUESTION_STARTER_RE.test(q)) return hasPronoun
  const words = q.split(/\s+/).length
  if (q.length <= 30 && words <= 4) return true
  if (q.length > 100) return false
  return hasPronoun || FOLLOWUP_PREFIX_RE.test(q)
}
