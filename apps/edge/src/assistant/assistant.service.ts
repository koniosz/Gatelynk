/**
 * AssistantService — orkiestracja Ollama + tool dispatch dla Edge AI Assistant.
 *
 * Flow:
 *   1) User pyta „Czy był dziś kurier?"
 *   2) `ask()` buduje system prompt + przekazuje narzędzia z `assistant.tools.ts`
 *   3) POST /api/chat do Ollama z `tools: [...]`
 *   4) LLM odpowiada z `message.tool_calls` (function calling)
 *   5) Wykonujemy każdy tool (SQL → JSON) i wrzucamy wynik z powrotem
 *   6) Druga runda LLM-a: generuje finalną odpowiedź NL
 *   7) Zwracamy odpowiedź + trace (lista wywołanych narzędzi z argumentami)
 *      do UI dla transparentności („⚙ Uruchomiono: list_lpr_reads(range=24h)").
 *
 * Bezpieczeństwo:
 *   • Max 4 rundy tool-calling (defense against loop)
 *   • Timeout pojedynczego HTTP do Ollama: 30s
 *   • Graceful fallback gdy Ollama down → 503 z czytelnym error message
 *
 * Health check:
 *   `isAvailable()` woła GET /api/tags. Jest cache-owane na 60s żeby UI mógł
 *   dynamicznie ukrywać przycisk Assistant gdy Ollama padło, bez DDoS-owania
 *   localhost.
 */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { StoreService } from '../store/store.service'
import { KnowledgeService } from '../knowledge/knowledge.service'
import { tryFastPath, type FastPathResult } from './fast-path'
import { findTool, toolsAsOllamaSpec, type ToolContext } from './assistant.tools'

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'
const MODEL      = process.env.GLE_LLM_MODEL ?? 'qwen2.5:3b'
const MAX_ROUNDS = 4
// Qwen 3 8B cold-start na 8GB M2 może trwać 30-50s zanim wystartuje generation.
// Zwiększone z 30s żeby zmieścić cold-load + tool dispatch + synthesis.
const HTTP_TIMEOUT_MS = 180_000  // 3 min — qwen2.5:32b dense @ M1 Max ~12 tok/s,
                                  // duże 7d queries z multi-round mogą bić w 100-150s.
                                  // Cold-start dodatkowo +15s na model load.
// Qwen 3 ma domyślnie włączony reasoning/thinking mode (CoT pre-roll).
// Dla naszych prostych tool-driven queries to overkill — 30s+ vs 3s bez.
// Ollama 0.6+ obsługuje `think: false` jako top-level body parameter.
// Dla Qwen 2.x (bez thinking) flag jest ignorowany, więc safe na backward-compat.
const DISABLE_THINKING = MODEL.startsWith('qwen3') || MODEL.startsWith('deepseek-r1')

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, any> | string }
  }>
}

interface OllamaChatResponse {
  message?: OllamaChatMessage
  done: boolean
  done_reason?: string
}

export interface AssistantToolTrace {
  name: string
  args: Record<string, any>
  resultPreview: string  // first ~200 chars of JSON, for UI display
  durationMs: number
}

export interface AssistantResult {
  answer: string
  trace: AssistantToolTrace[]
  modelUsed: string
  totalMs: number
}

/**
 * Callback dla streaming-u. SSE controller wpina te eventy w wire format.
 * Wywoływane synchronicznie z dispatcher loop-em.
 */
export interface AssistantStreamEvents {
  onToolStart?: (call: { name: string; args: Record<string, any> }) => void
  onToolDone?: (trace: AssistantToolTrace) => void
  onToken?: (chunk: string) => void
  onDone?: (result: AssistantResult) => void
  onError?: (error: Error) => void
}

/**
 * System prompt — kompaktowy, z few-shot examples.
 *
 * Każdy token tutaj jest procesowany za każdą rundą LLM-a. Wcześniejsza wersja
 * miała ~600 tokenów; ta ~280. Saving: ~0.15s na rundę = ~0.3s na pytanie.
 *
 * Few-shot examples MUSZĄ pokrywać:
 *  • PL i EN żeby model nie zapomniał mirror-ować języka
 *  • Mapping „kurier"→PIN żeby nie dryfował do LPR
 *  • Użycie count_* zamiast list_* dla pytań typu „ile"
 */
const SYSTEM_PROMPT = `You are GateLynk Edge Assistant — local AI inspecting one property's access-control logs via tools.

## RULES
1. EVERY message → ONE tool call first. No reusing prior answers.
2. Mirror language (PL→PL, EN→EN). Polish only Polish words.
3. No invention — plates/colors/times only from tool output.
4. Privacy: use unitLabel ("Niewinna 6/1"), never resident names.
5. Brief: 1-2 sentences for counts, 3-5 lines for lists.

## TOOL PICKING
- "kurier/who/kto/ile bram/był X" → list_gate_openings (whitelist matches that opened gate)
- "nieznane/unmatched/nie na liście" → list_lpr_reads({matched:false})
- "pokaż/wszystkie odczyty/N ostatnich" → list_lpr_reads (no matched filter)
- "konkretna tablica X" → list_lpr_reads({plate:"X"})
- "ile" pure count → count_lpr_reads / count_relay_triggers
- "errors/warnings" → list_event_log
- "co podłączone" → list_devices
- **"co mówi/co pisze uchwała/regulamin", "czy wolno", "jakie są zasady",
  "kto pisał o", "co sąsiedzi mówią", "numer telefonu do hydraulika",
  "kontakt do administracji"** → **search_knowledge(query, type?)**.
  Baza wiedzy: uchwały, regulaminy, chat Messenger mieszkańców, kontakty
  serwisowe, notatki. ZAWSZE cytuj fragment z field text hit-a + podaj źródło
  (title + type). Jeśli hitCount=0, powiedz wprost: "Nie znalazłem [X] w bazie wiedzy".

## TIME RANGES (parse user words; default 24h ONLY if no hint)
- "dziś/today" → 24h
- "wczoraj/yesterday" → 48h
- "tydzień/w tygodniu/week" → 7d
- "ostatnio/recently/kiedyś" → 30d  (undefined past → search wide!)
- "miesiąc/month" → 30d
- "godzina/now" → 1h
- "wcześniej/poprzednie dni/earlier" → 7d (rozszerz vs prior turn)

Follow-up: respect new time hint, don't reuse prior "24h" if user wants wider.

## CARRIER FILTER (MUST USE)
User wymienia DHL/InPost/DPD/Glovo/Poczta/FedEx/UPS/Allegro/GLS/Frisco/Pyszne →
list_gate_openings({carrier:"X"}). Po wywołaniu czytaj filtersApplied.carrier.
courierVisits=0 → "Brak wizyt X w tym okresie."

## TOOL RESULT FIELDS
list_gate_openings: courierVisits, courierList ["YYYY-MM-DD HH:MM PLATE [tags]"], plates[] (sorted by count).
list_lpr_reads.reads[]: { ts, plate, matched, gateOpened, color, vehicleType, brand, unitLabel }.
- matched=true → whitelist hit. matched=false → unknown plate.
- color/brand/vehicleType to ANPR kamery, dla KAŻDEJ tablicy (matched lub nie). null → "kamera nie zarejestrowała".
- Filtry color/vehicleType bilingual: czarny↔black, biały↔white, srebrny↔silver.
- direction: "forward"=wjazd, "reverse"=wyjazd. Brak reverse → powiedz wprost.
- Tool result lacks info → "W [zakresie] nie znalazłem [X]." NEVER fabricate.`

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name)
  private lastAvailCheck = 0
  private lastAvailResult = false

  constructor(
    private readonly store: StoreService,
    private readonly knowledge: KnowledgeService,
  ) {}

  /**
   * Fast-path bypass — sprawdza czy zapytanie pasuje do prostego patternu
   * keyword (kiedy ostatnio X / ile dzisiaj X / pokaż N ostatnich X) i jeśli
   * tak, wykonuje tool bezpośrednio bez LLM. Performance: 5-50ms vs 30-120s.
   *
   * Wymaga history pustego (no follow-up context). Dla follow-up zawsze idziemy
   * do LLM bo wymaga rozumienia kontekstu.
   *
   * Returns null gdy fallback do LLM jest potrzebny.
   */
  async tryFastPath(
    question: string,
    _history: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<FastPathResult | null> {
    // Brak history guard — patterns same decydują czy mają dość informacji.
    // Self-contained queries (carrier name, time range, count keyword) działają
    // niezależnie od history. Pure context-dependent ("a one?", "ten ostatni?")
    // → patterns nie matchują → fallback do LLM.
    return tryFastPath(question, this.store)
  }

  /**
   * Quick healthcheck — czy Ollama HTTP API odpowiada. Cache 60s żeby panel
   * mógł odpytywać często bez obciążania localhost-a.
   */
  async isAvailable(force = false): Promise<boolean> {
    const now = Date.now()
    if (!force && now - this.lastAvailCheck < 60_000) {
      return this.lastAvailResult
    }
    try {
      const res = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, { method: 'GET' }, 3_000)
      this.lastAvailResult = res.ok
    } catch {
      this.lastAvailResult = false
    }
    this.lastAvailCheck = now
    return this.lastAvailResult
  }

  /**
   * Główny entry-point: NL question (+ opcjonalnie historia chat) → NL answer + tool trace.
   *
   * `priorMessages` to wcześniejsze tury rozmowy z UI (max ~6 wpisów = 3 tury,
   * żeby kontekst nie urósł poza num_ctx). Bez tego asystent traci kontekst
   * w follow-up pytaniach typu „A o której?" i ask LLM-a o uściślenie.
   */
  async ask(question: string, priorMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []): Promise<AssistantResult> {
    const startedAt = Date.now()
    if (!(await this.isAvailable(true))) {
      throw new ServiceUnavailableException(
        `LLM not available at ${OLLAMA_URL}. Install Ollama on the Edge host (apps/edge/install/setup-ollama.sh) ` +
        `and ensure the launchd service is running.`,
      )
    }

    const messages: OllamaChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      // Prior turns — limit do ostatnich 6 (3 par user/assistant). Każda
      // wiadomość obcięta do 800 znaków żeby nie przelać context window.
      ...truncateHistory(priorMessages, 6, 800),
      { role: 'user', content: question },
    ]

    const trace: AssistantToolTrace[] = []
    const tools = toolsAsOllamaSpec()
    const ctx: ToolContext = { store: this.store, knowledge: this.knowledge }

    let round = 0
    while (round < MAX_ROUNDS) {
      round++
      const body: any = {
        model: MODEL,
        messages,
        stream: false,
        tools,
        // Qwen 3 reasoning mode wyłączony — bez tego każda runda dodaje
        // ~25s CoT na M2 (patrz `DISABLE_THINKING` w nagłówku).
        ...(DISABLE_THINKING ? { think: false } : {}),
        // Hint dla LLM-a żeby odpowiedział strukturalnie. Qwen 2.5 to honoruje
        // bez forsowania `format: json` (które łamie tool calling).
        options: { temperature: 0.2, num_ctx: 4096 },
      }

      const res = await fetchWithTimeout(
        `${OLLAMA_URL}/api/chat`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        HTTP_TIMEOUT_MS,
      )
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new ServiceUnavailableException(`Ollama /api/chat HTTP ${res.status}: ${errText.slice(0, 200)}`)
      }

      const payload = (await res.json()) as OllamaChatResponse
      const reply = payload.message
      if (!reply) {
        this.logger.warn('Ollama returned no message — abort')
        return { answer: 'Internal error — empty LLM response.', trace, modelUsed: MODEL, totalMs: Date.now() - startedAt }
      }

      // Dorzucamy assistant message do historii ZAWSZE — żeby LLM widział co
      // sam już zwrócił (tool_calls + plain content)
      messages.push(reply)

      // Jeśli LLM woła narzędzia — wykonujemy wszystkie, dorzucamy `role:'tool'`
      // wiadomości i robimy kolejną rundę.
      const toolCalls = reply.tool_calls ?? []
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          const name = call.function?.name
          const rawArgs = call.function?.arguments
          const args: Record<string, any> = typeof rawArgs === 'string' ? safeJsonParse(rawArgs) : (rawArgs ?? {})
          const toolDef = findTool(name)

          let result: unknown
          let toolStart = Date.now()
          if (!toolDef) {
            result = { error: `Unknown tool "${name}". Available: ${tools.map((t) => t.function.name).join(', ')}` }
          } else {
            try {
              result = await toolDef.run(args, ctx)
            } catch (err: any) {
              result = { error: err?.message ?? String(err) }
            }
          }
          const durationMs = Date.now() - toolStart
          const resultJson = JSON.stringify(result)
          trace.push({
            name: name ?? '(missing)',
            args,
            resultPreview: resultJson.slice(0, 200),
            durationMs,
          })

          messages.push({
            role: 'tool',
            content: resultJson,
          })
        }
        continue  // następna runda
      }

      // No tool calls — final answer.
      return {
        answer: reply.content?.trim() ?? '',
        trace,
        modelUsed: MODEL,
        totalMs: Date.now() - startedAt,
      }
    }

    // Przekroczyliśmy MAX_ROUNDS — LLM zapętlił się.
    return {
      answer: 'I tried multiple times but could not produce a final answer. Try rephrasing the question.',
      trace,
      modelUsed: MODEL,
      totalMs: Date.now() - startedAt,
    }
  }

  /**
   * Streaming variant — tool dispatch + streamingowa synteza końcowa.
   *
   * Flow:
   *   1) Non-stream rounds dopóki LLM woła tools (te calls są szybkie ~0.3-0.8s).
   *      Każdy tool emit przez `onToolStart` / `onToolDone` żeby UI mógł
   *      pokazać „⚙ Querying relay triggers…".
   *   2) Gdy LLM przestaje wołać tools (ma już wszystkie dane), robimy JEDNĄ
   *      finalną rundę z `stream: true` BEZ tools — czysta synteza NL.
   *      Każdy chunk → `onToken` → UI dopisuje słowo po słowie.
   *
   * Percypowana latencja: pierwsze słowo w ~0.3-0.5s zamiast 2-5s.
   */
  async askStream(
    question: string,
    events: AssistantStreamEvents,
    priorMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ): Promise<void> {
    const startedAt = Date.now()

    try {
      if (!(await this.isAvailable(true))) {
        throw new ServiceUnavailableException(
          `LLM not available at ${OLLAMA_URL}. Install Ollama and start the launchd service.`,
        )
      }

      const messages: OllamaChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...truncateHistory(priorMessages, 6, 800),
        { role: 'user', content: question },
      ]
      const trace: AssistantToolTrace[] = []
      const tools = toolsAsOllamaSpec()
      const ctx: ToolContext = { store: this.store, knowledge: this.knowledge }
      // Loop detection: gdy LLM wywołuje ten sam (name, args) drugi raz pod rząd,
      // to znak że nie umie się zatrzymać. Wymuszamy synthesis. Qwen 2.5 3B robi
      // to czasem na Ollama 0.5.13 (znaane).
      const seenSignatures = new Set<string>()

      // ── Round 1+ — tool dispatch (non-streaming, szybkie) ─────────────────
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const res = await fetchWithTimeout(
          `${OLLAMA_URL}/api/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: MODEL,
              messages,
              stream: false,
              tools,
              ...(DISABLE_THINKING ? { think: false } : {}),
              // num_ctx=4096 zamiast default 8192 — oszczędza ~1 GB Metal KV cache
              // na 7B. Wystarcza na: system prompt (~600t) + history (~1000t) +
              // tool results (~1000t) + response (~500t) = ~3000t. Z zapasem.
              options: { temperature: 0.2, num_ctx: 4096 },
            }),
          },
          HTTP_TIMEOUT_MS,
        )
        if (!res.ok) throw new ServiceUnavailableException(`Ollama HTTP ${res.status}`)
        const payload = (await res.json()) as OllamaChatResponse
        const reply = payload.message
        if (!reply) throw new Error('Empty LLM response')
        messages.push(reply)

        const toolCalls = reply.tool_calls ?? []
        if (toolCalls.length === 0) {
          // Echo-prevention: gdy model w PIERWSZEJ rundzie zignorował tools,
          // a mamy >1 turę rozmowy (jest historia), wymuszamy `list_gate_openings`
          // ręcznie. Qwen 2.5 7B na turn 3-4 czasem skipuje tools i echo-uje
          // poprzednią odpowiedź — to safety net który zawsze daje świeże dane.
          if (round === 1 && priorMessages.length > 0) {
            this.logger.warn('Round 1: no tool calls + prior history → force list_gate_openings')
            const forcedArgs = { range: '24h' }
            events.onToolStart?.({ name: 'list_gate_openings', args: forcedArgs })
            const toolDef = findTool('list_gate_openings')!
            const toolStart = Date.now()
            let result: unknown
            try {
              result = await toolDef.run(forcedArgs, ctx)
            } catch (err: any) {
              result = { error: err?.message ?? String(err) }
            }
            const durationMs = Date.now() - toolStart
            const resultJson = JSON.stringify(result)
            const traceEntry: AssistantToolTrace = {
              name: 'list_gate_openings',
              args: forcedArgs,
              resultPreview: resultJson.slice(0, 200),
              durationMs,
            }
            trace.push(traceEntry)
            events.onToolDone?.(traceEntry)
            // Wstaw fake tool_call do historii żeby pasowało do tool message.
            messages[messages.length - 1] = {
              ...reply,
              tool_calls: [{ function: { name: 'list_gate_openings', arguments: forcedArgs } }],
            }
            messages.push({ role: 'tool', content: resultJson })
            continue
          }
          // LLM nie chce już narzędzi — leciemy do synthesis streaming
          // używając historii (która zawiera wszystkie tool results) +
          // jego ostatni reply.content jako wskazówkę.
          break
        }

        // Loop guard — jeśli WSZYSTKIE tool_calls w tej rundzie są duplikatami,
        // model zapętlił się. Wymuszamy break do final synthesis.
        const callSignatures = toolCalls.map((c) => `${c.function?.name}:${JSON.stringify(c.function?.arguments ?? {})}`)
        const allDuplicates = callSignatures.every((sig) => seenSignatures.has(sig))
        if (allDuplicates && round > 1) {
          this.logger.warn(`Loop detected (round ${round}): all calls are repeats. Forcing synthesis.`)
          break
        }
        callSignatures.forEach((sig) => seenSignatures.add(sig))

        await Promise.all(toolCalls.map(async (call) => {
          const name = call.function?.name
          const rawArgs = call.function?.arguments
          const args: Record<string, any> = typeof rawArgs === 'string' ? safeJsonParse(rawArgs) : (rawArgs ?? {})
          events.onToolStart?.({ name, args })

          const toolDef = findTool(name)
          let result: unknown
          const toolStart = Date.now()
          if (!toolDef) {
            result = { error: `Unknown tool "${name}"` }
          } else {
            try {
              result = await toolDef.run(args, ctx)
            } catch (err: any) {
              result = { error: err?.message ?? String(err) }
            }
          }
          const durationMs = Date.now() - toolStart
          const resultJson = JSON.stringify(result)
          const traceEntry: AssistantToolTrace = {
            name: name ?? '(missing)',
            args,
            resultPreview: resultJson.slice(0, 200),
            durationMs,
          }
          trace.push(traceEntry)
          events.onToolDone?.(traceEntry)
          messages.push({ role: 'tool', content: resultJson })
        }))
      }

      // ── Final round — streaming synthesis ────────────────────────────────
      // Trick: dorzucamy explicit user nudge żeby model przeszedł z trybu
      // „decyduję jakie narzędzie" na „piszę odpowiedź". Bez tego Ollama 0.5.13
      // czasem zwraca pustą wiadomość po tool dispatchu.
      //
      // BEZ `tools` w body — chcemy zmusić plain-text response, nie kolejną
      // rundę tool calling. `stream: true` daje NDJSON token-po-tokenie.
      messages.push({
        role: 'user',
        content: 'Now answer the LATEST user question (the most recent one above) concisely using only the tool results from this turn. ' +
          'Do NOT repeat your prior answer. Do NOT restate the total gate-openings count unless the new question asked for it. ' +
          'If the tool result lacks what was asked (e.g. no black cars found), reply plainly: "W odczytach z [zakres] nie znalazłem [X]." ' +
          'Reply in the same language as the user question.',
      })
      const streamRes = await fetchWithTimeout(
        `${OLLAMA_URL}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODEL,
            messages,
            stream: true,
            ...(DISABLE_THINKING ? { think: false } : {}),
            // Synthesis round — niższa temperatura żeby model nie dryfował na
            // egzotyczne tokeny (np. „diseñadoram" zamiast „nie znalazłem").
            // Tool-rounds zostają na 0.2 bo tam decyzja o tool/argumentach
            // korzysta z minimalnej entropy.
            options: { temperature: 0.1, num_ctx: 4096 },
          }),
        },
        HTTP_TIMEOUT_MS,
      )
      if (!streamRes.ok || !streamRes.body) {
        throw new ServiceUnavailableException(`Ollama stream HTTP ${streamRes.status}`)
      }

      // NDJSON parsing — każda linia to OllamaChatResponse z `message.content`
      // jako delta (Ollama streamuje per-token).
      const reader = streamRes.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // niepełna linia na końcu

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const obj = JSON.parse(trimmed) as OllamaChatResponse
            const chunk = obj.message?.content ?? ''
            if (chunk) {
              accumulated += chunk
              events.onToken?.(chunk)
            }
          } catch {
            // ignore malformed line (rare — Ollama is well-behaved)
          }
        }
      }

      events.onDone?.({
        answer: accumulated.trim(),
        trace,
        modelUsed: MODEL,
        totalMs: Date.now() - startedAt,
      })
    } catch (err: any) {
      this.logger.error(`askStream error: ${err.message}`)
      events.onError?.(err)
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

function safeJsonParse(s: string): Record<string, any> {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

/**
 * Obcina chat history do ostatnich N wpisów i każdą wiadomość do `maxChars`.
 * Powód: 7B na M2 z num_ctx=4096 zaczyna mieć problemy z attention przy
 * długich historiach + duże tool results.
 *
 * Strategia: zachowuje ostatnie N (najnowsze pierwsze są na końcu listy).
 */
function truncateHistory(
  msgs: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxMessages: number,
  maxCharsPerMsg: number,
): OllamaChatMessage[] {
  return msgs
    .slice(-maxMessages)
    .map((m) => ({
      role: m.role,
      content: m.content.length > maxCharsPerMsg
        ? m.content.slice(0, maxCharsPerMsg) + '…'
        : m.content,
    }))
}
