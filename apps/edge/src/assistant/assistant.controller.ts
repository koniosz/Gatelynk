/**
 * AssistantController — STRICT MODE (2026-05-19).
 *
 * Zmiana architektoniczna: panel UI woła stare endpointy `/assistant/ask*`
 * ale Edge teraz **forwarduje** wszystko do Python AI Prototype na
 * `http://localhost:8000`. To strict intent → SQL template flow:
 *
 *   1. POST /assistant/ask        → forward → :8000/ask → JSON
 *   2. POST /assistant/ask-stream → forward → :8000/ask → adapt to SSE
 *   3. GET  /assistant/status     → status prototypu (proxy do :8000/health)
 *
 * Stary tool-calling LLM (qwen2.5:32b z RAG, knowledge search, fast-path)
 * jest BYPASS-owany. AssistantService.ask() i .askStream() nie są wołane.
 * Jeśli chcesz wrócić do tamtego flow — `git revert` ten plik.
 *
 * Wire-format SSE (zgodne ze starym UI useAssistant.ts):
 *   event: tool-start    data: {"name":"<intent>","args":{...params}}
 *   event: tool-done     data: {"name":"<intent>","durationMs":N,"resultPreview":"..."}
 *   event: token         data: <answer string>
 *   event: done          data: {"answer":"...","trace":[...],"totalMs":N}
 *   event: error         data: {"message":"..."}
 */
import { BadRequestException, Body, Controller, Get, Logger, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'

const PROTOTYPE_URL = process.env.AI_PROTOTYPE_URL ?? 'http://localhost:8000'

interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

interface PrototypeResponse {
  intent: string
  parameters: Record<string, unknown>
  answer: string
  data: unknown
  follow_ups?: string[]
  rewritten_question?: string
}

@Controller('assistant')
export class AssistantController {
  private readonly logger = new Logger(AssistantController.name)

  /**
   * FAZA 8.h.20 (2026-06-11) — cached day summary z background loop prototypu.
   * Prototype generuje co 20 min; ten proxy zwraca cache w ~5ms. Cloud
   * `/resident/assistant/day-summary` woła ten route zamiast odpalać 2
   * LLM-questions on-demand (user nie czeka na Bielika).
   */
  @Get('day-summary')
  async daySummary() {
    try {
      const res = await fetch(`${PROTOTYPE_URL}/day-summary`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) throw new Error(`prototype HTTP ${res.status}`)
      return await res.json()
    } catch (err: any) {
      this.logger.warn(`day-summary cache unreachable: ${err.message}`)
      return { predictions: null, recap: null, generatedAt: null, generating: false }
    }
  }

  /**
   * FAZA 8.h.28 — strukturalny kalendarz (harmonogram śmieci jako per-dzień
   * eventy). Proxy do prototypu `GET /calendar?days=N`. Prototype czyta KB
   * harmonogram deterministycznie (regex dat per frakcja, bez LLM), więc ten
   * route jest szybki (~kilkadziesiąt ms — 1 odczyt sqlite + parsing).
   *
   * Cloud `/resident/assistant/calendar` woła ten endpoint. Fallback do pustej
   * listy gdy prototype niedostępny — iOS pokaże „brak wydarzeń" zamiast błędu.
   */
  @Get('calendar')
  async calendar(@Query('days') daysRaw?: string) {
    const days = Math.min(Math.max(parseInt(daysRaw ?? '7', 10) || 7, 1), 31)
    try {
      const res = await fetch(`${PROTOTYPE_URL}/calendar?days=${days}`, {
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) throw new Error(`prototype HTTP ${res.status}`)
      return await res.json()
    } catch (err: any) {
      this.logger.warn(`calendar unreachable: ${err.message}`)
      return { days, from: null, to: null, events: [], source: 'unavailable', scheduledTickets: [] }
    }
  }

  /**
   * 2026-08-26 — „Kronika dnia": digest zdarzeń sytuacyjnych + statystyk
   * dnia składany w prototypie (deterministyczne fakty, opcjonalna narracja
   * Bielika z guardem liczb). Cloud woła to o 21:00 (push) i w preview.
   * Timeout 45 s — Bielik na M1 potrafi mielić kilkanaście sekund.
   */
  @Get('chronicle')
  async chronicle(@Query('smart') smartRaw?: string) {
    const smart = smartRaw !== '0'
    try {
      const res = await fetch(`${PROTOTYPE_URL}/chronicle?smart=${smart ? '1' : '0'}`, {
        signal: AbortSignal.timeout(45_000),
      })
      if (!res.ok) throw new Error(`prototype HTTP ${res.status}`)
      return await res.json()
    } catch (err: any) {
      this.logger.warn(`chronicle unreachable: ${err.message}`)
      return { date: null, lines: [], narrative: null, push_text: null, events: [] }
    }
  }

  @Get('status')
  async status() {
    try {
      const res = await fetch(`${PROTOTYPE_URL}/health`, {
        signal: AbortSignal.timeout(3_000),
      })
      if (!res.ok) throw new Error(`prototype HTTP ${res.status}`)
      const data = await res.json() as {
        status: string
        model: string
        ollama_url: string
        sqlite_path: string
      }
      return {
        available: data.status === 'ok',
        model: data.model,
        ollamaUrl: data.ollama_url,
        mode: 'strict-intent-router',
      }
    } catch (err: any) {
      this.logger.warn(`AI prototype unreachable: ${err.message}`)
      return {
        available: false,
        model: 'ai-prototype',
        ollamaUrl: PROTOTYPE_URL,
        mode: 'strict-intent-router',
        error: err.message,
      }
    }
  }

  @Post('ask')
  async ask(@Body() body: { question?: string; smart?: boolean; history?: ConversationTurn[] }) {
    const question = body?.question?.trim()
    if (!question) {
      throw new BadRequestException('Missing "question" field')
    }
    if (question.length > 500) {
      throw new BadRequestException('Question too long (max 500 chars)')
    }
    // smart=true default (LLM-enhanced), false = strict template (~10ms)
    const smart = body?.smart !== false
    const history = sanitizeHistory(body?.history)
    this.logger.log(
      `Q [${smart ? 'smart' : 'fast'}, history=${history.length}]: ${question.slice(0, 100)}${question.length > 100 ? '…' : ''}`,
    )

    const start = Date.now()
    const result = await this.callPrototype(question, smart, history)
    const totalMs = Date.now() - start

    if (result.rewritten_question) {
      this.logger.log(
        `Rewrite: ${question.slice(0, 60)} → ${result.rewritten_question.slice(0, 80)}`,
      )
    }
    this.logger.log(
      `A (${totalMs}ms, intent=${result.intent}): ${result.answer.slice(0, 100)}…`,
    )

    return {
      answer: result.answer,
      trace: [
        {
          name: result.intent,
          args: result.parameters,
          resultPreview: this.previewData(result.data),
          durationMs: totalMs,
        },
      ],
      modelUsed: 'ai-prototype-smart',
      totalMs,
      // Pełen JSON z prototypu — UI może wyświetlić raw dla debug.
      intent: result.intent,
      parameters: result.parameters,
      data: result.data,
      followUps: result.follow_ups ?? [],
      rewrittenQuestion: result.rewritten_question,
    }
  }

  @Post('ask-stream')
  async askStreamPost(
    @Body() body: { question?: string; smart?: boolean; history?: ConversationTurn[] },
    @Res() res: Response,
  ) {
    const smart = body?.smart !== false
    const history = sanitizeHistory(body?.history)
    await this.runStream(body?.question?.trim() ?? '', smart, history, res)
  }

  /** @deprecated GET wariant — stary UI mógł używać EventSource. */
  @Get('ask-stream')
  async askStreamGet(
    @Query('q') q: string | undefined,
    @Query('smart') smartQ: string | undefined,
    @Res() res: Response,
  ) {
    const smart = smartQ !== '0' && smartQ !== 'false'
    // GET variant nie ma body → no history (UI używa POST gdy chce kontekst).
    await this.runStream(q?.trim() ?? '', smart, [], res)
  }

  // ──────────────────────────────────────────────────────────────────────
  // SSE adapter — emituje wire events zgodne z istniejącym useAssistant.ts
  // Strict mode = jednokrotny strzał, brak streamingu per-token (prototype
  // zwraca całą odpowiedź naraz). Wysyłamy: tool-start → tool-done → token
  // (jeden chunk) → done.
  // ──────────────────────────────────────────────────────────────────────
  private async runStream(
    question: string,
    smart: boolean,
    history: ConversationTurn[],
    res: Response,
  ): Promise<void> {
    if (!question || question.length > 500) {
      res.status(400).json({
        error: 'Missing or too-long question (max 500 chars)',
      })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const send = (event: string, data: unknown) => {
      const serialized = event === 'token' && typeof data === 'string'
        ? data
        : JSON.stringify(data)
      const lines = String(serialized).split('\n').map((l) => `data: ${l}`).join('\n')
      res.write(`event: ${event}\n${lines}\n\n`)
    }

    this.logger.log(
      `Q (stream) [${smart ? 'smart' : 'fast'}, history=${history.length}]: ${question.slice(0, 100)}${question.length > 100 ? '…' : ''}`,
    )

    const start = Date.now()
    try {
      const result = await this.callPrototype(question, smart, history)
      const totalMs = Date.now() - start

      const traceEntry = {
        name: result.intent,
        args: result.parameters,
        resultPreview: this.previewData(result.data),
        durationMs: totalMs,
      }

      // 1. tool-start — UI pokazuje "wywołuję intent: <name>"
      send('tool-start', { name: result.intent, args: result.parameters })
      // 2. tool-done — UI pokazuje wynik z preview
      send('tool-done', traceEntry)
      // 3. token — cała odpowiedź jednym chunkiem (strict mode nie streamuje tokeny)
      send('token', result.answer)
      // 4. done — kanoniczny wire event z totalMs + trace + follow-ups
      send('done', {
        answer: result.answer,
        trace: [traceEntry],
        totalMs,
        intent: result.intent,
        parameters: result.parameters,
        data: result.data,
        followUps: result.follow_ups ?? [],
        rewrittenQuestion: result.rewritten_question,
      })

      res.end()
      this.logger.log(
        `A (FAST stream ${totalMs}ms, intent=${result.intent})`,
      )
    } catch (err: any) {
      this.logger.error(`Prototype call failed: ${err.message}`)
      send('error', { message: err.message ?? 'Internal error' })
      res.end()
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // HTTP client do Python prototype na :8000
  // ──────────────────────────────────────────────────────────────────────
  private async callPrototype(
    question: string,
    smart: boolean,
    history: ConversationTurn[],
  ): Promise<PrototypeResponse> {
    // history pomijamy w body gdy pusta (mniejszy payload + pre-2026-05-20 compat).
    const payload: Record<string, unknown> = { question, smart }
    if (history.length > 0) payload.history = history
    const res = await fetch(`${PROTOTYPE_URL}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // 60s timeout — smart mode bywa wolniejszy (LLM cold = 5-10s)
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`AI prototype HTTP ${res.status}: ${errText.slice(0, 200)}`)
    }
    return (await res.json()) as PrototypeResponse
  }

  private previewData(data: unknown): string {
    if (data == null) return ''
    try {
      return JSON.stringify(data).slice(0, 300)
    } catch {
      return ''
    }
  }
}

/**
 * Defensive guard dla history z untrusted body (Cloud forward).
 * Drop:
 *   • Non-arrays (klient wysłał śmieci)
 *   • Itemy bez role/content (broken klient)
 *   • role inne niż user/assistant
 *   • zbyt długie content (truncate do 1000)
 * Limit: max 12 ostatnich tur (~6 par user/assistant). LLM rewrite dostaje
 * potem dodatkowy tail-trim do 4 wpisów — to twardy upper bound żeby
 * payload nie urósł patologicznie.
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
