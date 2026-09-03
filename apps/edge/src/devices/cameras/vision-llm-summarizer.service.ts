/**
 * VisionLlmSummarizerService — cron co 30s generuje krótkie PL summary
 * dla notable frames bez `llm_summary`.
 *
 * Trigger:
 *   `@Interval(30_000)` — co 30s pobiera batch (default 5 rows) z
 *   `StoreService.visionListNotablePendingSummary`.
 *
 * Definicja "notable" (filtr w store):
 *   • summary zawiera person/dog/cat
 *   • LUB brand_detected != NULL (kurier)
 *   • LUB waste_category != NULL (śmieciarka)
 *
 * LLM:
 *   • Ollama HTTP (default `http://192.168.1.109:11434` — MacBook Pro)
 *   • Model qwen2.5:14b (ten sam co AI prototype dla spójności PL output)
 *   • temperature=0, num_predict=80 (1 zdanie max)
 *   • timeout 30s (cold start może być ~10s)
 *
 * Strict prompt + walidacja:
 *   • TYLKO polski, max 200 znaków, single line
 *   • Fail → log + skip — następny cron tick spróbuje ponownie
 *   • Brak danych w bazie wiedzy → NIE inwencjonuje (system prompt explicit)
 *
 * Failure mode:
 *   Gdy Ollama nieosiągalny → wszystkie 5 frames fail w batch, log WARN,
 *   row zostaje z llm_summary=NULL — następny tick ponawia. Brak ryzyka
 *   deadletter ani lockup — sqlite zostaje spójne.
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { StoreService } from '../../store/store.service'

// FAZA 8.h.7 (2026-06-08) — Ollama URL i model są teraz w `ai_engines` table.
// Env vary `VISION_LLM_OLLAMA_URL` / `VISION_LLM_MODEL` zostają jako:
//   1. Bootstrap fallback gdy DB pusty (auto-migration analogiczna do YOLO)
//   2. Defaultowe wartości przy pierwszym aktywowaniu z Edge UI
// Timeout/batch/max_age dalej z env — to operacyjne parametry, rzadko zmieniane.
const ENV_OLLAMA_URL = (process.env.VISION_LLM_OLLAMA_URL ?? 'http://192.168.1.109:11434').replace(/\/+$/, '')
const ENV_MODEL = process.env.VISION_LLM_MODEL ?? 'qwen2.5:14b'
const TIMEOUT_MS = Number(process.env.VISION_LLM_TIMEOUT_MS ?? 30_000)
const BATCH_SIZE = Number(process.env.VISION_LLM_BATCH ?? 5)
const MAX_AGE_HOURS = Number(process.env.VISION_LLM_MAX_AGE_HOURS ?? 24)

const SYSTEM_PROMPT = `Jesteś GateLynk AI. Generujesz BARDZO KRÓTKĄ polską narrację (jedno zdanie, max 15 słów) opisującą co kamera wykryła na klatce monitoringu osiedla.

ZASADY:
- WYŁĄCZNIE polski. Tylko polskie litery: a-z, A-Z, ąćęłńóśżź.
- ZAKAZ używania chińskich, japońskich, cyrylicy, arabskich, greckich znaków.
- TYLKO fakty z DANE. Nie wymyślaj koloru, marki, kierunku, godziny.
- Nie zaczynaj od "Kamera widzi", "Na klatce", "Zdjęcie pokazuje", "Według danych".
- Format: konkrety — kto/co + (kontekst opcjonalny).
- DOKŁADNIE 1 zdanie (jedno!). Max 150 znaków. Bez procentów ani „pewności".
- Bez markdown, JSON, code-fences.

PRZYKŁADY:
WYKRYTE: {"car":1,"truck":1}, BRAND: DPD, OCR: ["dpd","GEOPOST"]
WYNIK: Furgon DPD przejeżdża obok kamery.

WYKRYTE: {"person":2,"dog":1}
WYNIK: Dwie osoby z psem w polu widzenia.

WYKRYTE: {"truck":1}, KATEGORIA: GLASS, OPERATOR: REMONDIS
WYNIK: Śmieciarka REMONDIS odbiera szkło.

WYKRYTE: {"person":1,"bicycle":1}
WYNIK: Osoba na rowerze.

WYKRYTE: {"car":1}, BRAND: INPOST
WYNIK: Kurier InPost przy bramie.
`

interface OllamaChatResponse {
  message?: { content?: string }
}

@Injectable()
export class VisionLlmSummarizerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VisionLlmSummarizerService.name)
  private running = false
  private ollamaHealthy = true

  constructor(private readonly store: StoreService) {}

  onModuleInit() {
    const active = this.resolveActiveLlm()
    if (active.enabled) {
      this.logger.log(
        `Vision summarizer ready (model=${active.model} url=${active.url} ` +
        `batch=${BATCH_SIZE} max_age=${MAX_AGE_HOURS}h, source=${active.source})`,
      )
    } else {
      this.logger.log(
        `Vision summarizer disabled (llm_enabled=false in ai_engines)`,
      )
    }
  }

  /**
   * Resolver runtime config: DB priority, env fallback. Pozwala dynamiczne
   * reload-y po `AI_ENGINE_CONFIG_UPDATE` z Cloud bez restartu Edge.
   *
   * Zwraca:
   *   • url — pełen URL Ollama (bez trailing slash)
   *   • model — np. qwen2.5:14b
   *   • enabled — flag z DB (env fallback = true gdy DB pusty)
   *   • source — 'db' | 'env' (do logów i UI)
   */
  private resolveActiveLlm(): { url: string; model: string; enabled: boolean; source: 'db' | 'env' } {
    const engine = this.store.aiEngineGet()
    if (engine && engine.llmUrl) {
      return {
        url: engine.llmUrl,
        model: engine.llmModel,
        enabled: engine.llmEnabled,
        source: 'db',
      }
    }
    return {
      url: ENV_OLLAMA_URL,
      model: ENV_MODEL,
      enabled: true,
      source: 'env',
    }
  }

  /**
   * Public test-connection — wykorzystywane przez AiEngineController
   * (Edge UI "Testuj LLM") oraz tunnel `LLM_TEST` (Cloud Integrator).
   * Wywołuje `GET /api/tags` na Ollama — lekkie, zwraca dostępne modele.
   * Override URL/model pozwala testować NOWY config przed zapisem.
   */
  async testLlmConnection(opts?: { urlOverride?: string }): Promise<{
    ok: boolean
    ms: number | null
    statusCode: number | null
    error: string | null
    url: string
    availableModels?: string[]
  }> {
    const active = this.resolveActiveLlm()
    const url = (opts?.urlOverride ?? active.url).replace(/\/+$/, '')
    if (!url) {
      return { ok: false, ms: null, statusCode: null, error: 'no URL configured', url: '' }
    }
    const fullUrl = `${url}/api/tags`
    const start = Date.now()
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10_000)
      const res = await fetch(fullUrl, { signal: ctrl.signal })
      clearTimeout(timer)
      const ms = Date.now() - start
      const ok = res.ok
      let availableModels: string[] | undefined
      if (ok) {
        try {
          const data = (await res.json()) as { models?: Array<{ name?: string }> }
          availableModels = (data.models ?? [])
            .map((m) => m.name)
            .filter((m): m is string => typeof m === 'string' && m.length > 0)
        } catch {
          /* not all Ollama versions return JSON list — ignore */
        }
      }
      return {
        ok,
        ms,
        statusCode: res.status,
        error: ok ? null : `HTTP ${res.status}`,
        url: fullUrl,
        availableModels,
      }
    } catch (err: any) {
      return {
        ok: false,
        ms: Date.now() - start,
        statusCode: null,
        error: err?.name === 'AbortError' ? 'timeout (10s)' : String(err?.message ?? err),
        url: fullUrl,
      }
    }
  }

  onModuleDestroy() {
    // Nic do cleanupu — Interval wyłączany automatycznie przez Nest scheduler.
  }

  /**
   * Cron tick — co 30s. Re-entrant guard `running` zapobiega
   * pokrywaniu się długich tików (gdy Ollama jest wolny / cold).
   */
  @Interval(30_000)
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Previous tick still running — skip')
      return
    }
    this.running = true
    try {
      await this.processBatch()
    } catch (e: any) {
      this.logger.error(`Tick failed: ${e?.message ?? e}`)
    } finally {
      this.running = false
    }
  }

  private async processBatch(): Promise<void> {
    // FAZA 8.h.7 (2026-06-08) — early-exit gdy LLM wyłączony w DB.
    // Pozwala integrator on/off bez restartu Edge (dynamic re-check przy
    // każdym ticku, koszt = 1 sqlite SELECT, znikomy).
    const active = this.resolveActiveLlm()
    if (!active.enabled) return

    const pending = this.store.visionListNotablePendingSummary({
      maxAgeMs: MAX_AGE_HOURS * 3600 * 1000,
      limit: BATCH_SIZE,
    })
    if (pending.length === 0) {
      // Czyste — nic nowego do podsumowania. To większość czasu (między ruchem).
      return
    }
    this.logger.log(`Processing ${pending.length} notable frames (model=${active.model})`)

    let ok = 0
    let failed = 0
    for (const row of pending) {
      try {
        const summary = await this.generateSummary(row)
        if (summary) {
          this.store.visionUpdateLlmSummary(row.id, summary)
          ok++
        } else {
          failed++
        }
      } catch (e: any) {
        this.logger.warn(`Frame ${row.id} summary failed: ${e?.message ?? e}`)
        failed++
        // Jeśli Ollama nieosiągalny — przerwij batch, nie spamuj 5x.
        if (this.isUnreachable(e)) {
          if (this.ollamaHealthy) {
            this.logger.warn('Ollama unreachable — pausing batch')
            this.ollamaHealthy = false
          }
          return
        }
      }
    }
    if (failed === 0 && !this.ollamaHealthy) {
      this.logger.log('Ollama back online')
      this.ollamaHealthy = true
    }
    this.logger.log(`Batch done: ok=${ok} failed=${failed}`)
  }

  /**
   * Build prompt z features i wywołaj Ollama. Zwraca summary (PL) lub
   * null gdy LLM zwrócił nieprzydatny output (pusty / nie-PL / za długi).
   */
  private async generateSummary(row: {
    id: number
    ts: number
    cameraDeviceId: string
    summary: string
    brandDetected: string | null
    brandConf: number | null
    textRaw: string | null
    wasteCategory: string | null
    wasteOperator: string | null
  }): Promise<string | null> {
    const timeStr = new Date(row.ts).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })
    const lines: string[] = []
    lines.push(`KAMERA: ${row.cameraDeviceId.slice(0, 8)}…`)
    lines.push(`CZAS: ${timeStr}`)
    lines.push(`WYKRYTE OBIEKTY (YOLO): ${row.summary}`)
    if (row.brandDetected) {
      const conf = row.brandConf != null ? row.brandConf.toFixed(2) : '?'
      lines.push(`ROZPOZNANA MARKA: ${row.brandDetected} (confidence ${conf})`)
    }
    if (row.textRaw) {
      // text_raw to JSON array — wytnij garbage tokens, weź top 8.
      try {
        const arr = JSON.parse(row.textRaw) as unknown
        if (Array.isArray(arr)) {
          const cleaned = arr
            .filter((s): s is string => typeof s === 'string' && s.length > 1)
            .slice(0, 8)
          if (cleaned.length > 0) {
            lines.push(`OCR (tekst z obrazu): ${JSON.stringify(cleaned)}`)
          }
        }
      } catch {
        // ignore — text_raw should be valid JSON but defensive
      }
    }
    if (row.wasteCategory) {
      const op = row.wasteOperator ?? '?'
      lines.push(`KATEGORIA ŚMIECI: ${row.wasteCategory} (operator: ${op})`)
    }
    const userMsg = lines.join('\n') + '\n\nOpis (1 zdanie po polsku):'

    // FAZA 8.h.7 — dynamic LLM config per-call (DB priority, env fallback).
    const active = this.resolveActiveLlm()
    const payload = {
      model: active.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      stream: false,
      options: {
        temperature: 0.0,
        num_predict: 80,
      },
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${active.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}`)
    }
    const data = (await res.json()) as OllamaChatResponse
    const content = (data.message?.content ?? '').trim()
    return this.sanitize(content)
  }

  /**
   * Walidacja LLM output: nie pusty, max 200 znaków, single-line, czysto PL.
   * Strip popularnych intro ("Według danych", "Opis:", itp.).
   */
  private sanitize(raw: string): string | null {
    if (!raw) return null
    let s = raw.trim()
    // Strip code-fences / markdown bullets.
    s = s.replace(/^```[a-z]*\n?|```$/g, '').trim()
    s = s.replace(/^[•\-\*]\s+/, '').trim()
    // Strip common LLM intro phrases.
    s = s.replace(
      /^(opis(\s+\(1\s+zdanie[^)]*\))?:|wynik:|według danych[,:]?\s*|na klatce widać:?\s*|kamera widzi:?\s*|na zdjęciu:?\s*)/i,
      '',
    ).trim()
    // Single-line.
    s = s.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
    if (s.length === 0 || s.length > 200) {
      this.logger.warn(`Sanitize rejected (len=${s.length}): ${raw.slice(0, 80)}`)
      return null
    }
    // Reject non-Polish chars (cyrylica/CJK/arabski).
    if (/[Ѐ-ӿ一-鿿぀-ゟ゠-ヿ؀-ۿͰ-Ͽ]/.test(s)) {
      this.logger.warn(`Non-Polish output rejected: ${s.slice(0, 80)}`)
      return null
    }
    return s
  }

  /**
   * Heurystyka: czy error z fetch-a oznacza że Ollama leży (vs np. timeout
   * pojedynczego frame). Wykorzystywane do "pause batch" gdy serwer down.
   */
  private isUnreachable(err: any): boolean {
    const msg = (err?.message ?? String(err)).toLowerCase()
    return (
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('fetch failed') ||
      msg.includes('socket hang up') ||
      msg.includes('aborted')
    )
  }
}
