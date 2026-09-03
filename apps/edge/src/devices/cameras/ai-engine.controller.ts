import { Body, Controller, Get, Logger, Post, Put } from '@nestjs/common'
import { StoreService } from '../../store/store.service'
import { VisionDetectService } from './vision-detect.service'
import { VisionLlmSummarizerService } from './vision-llm-summarizer.service'

/**
 * AI Engine REST endpoints — used by Edge UI (`/ui/ai-engine.html`).
 *
 * Edge UI scope:
 *   • Integrator on-site (LAN) edits URL/model/enabled bez wchodzenia w Cloud.
 *   • Test connection lokalny (Edge → YOLO) — bez round-trip przez Cloud.
 *
 * Po PUT — Edge emit `AI_ENGINE_REPORT` przez tunnel żeby Cloud był spójny.
 * Cloud upsert ON CONFLICT(buildingId) DO NOTHING — user-set z Cloud Integrator
 * panel zawsze wygrywa, ale gdy Cloud nie ma row (świeży deploy) — Edge wypełni.
 *
 * Brak auth: Edge HTTP server siedzi w LAN-ie tylko (port 4000). Integrator
 * musi mieć Tailscale/SSH żeby dotrzeć — assumption taka sama jak dla wizard.
 */
@Controller('ai-engine')
export class AiEngineController {
  private readonly logger = new Logger('AiEngineController')

  constructor(
    private readonly store: StoreService,
    private readonly vision: VisionDetectService,
    private readonly llm: VisionLlmSummarizerService,
  ) {}

  /**
   * GET /ai-engine
   *
   * Aktualny stan: URL, healthPath, model, enabled, plus źródło (env|cloud|manual)
   * dla UI hint i ostatni test result (jeśli był).
   */
  @Get()
  getConfig() {
    const engine = this.store.aiEngineGet()
    const envYoloUrl = (process.env.YOLO_URL ?? '').replace(/\/+$/, '')
    const envLlmUrl = (process.env.VISION_LLM_OLLAMA_URL ?? '').replace(/\/+$/, '')
    const envLlmModel = process.env.VISION_LLM_MODEL ?? 'qwen2.5:14b'
    if (!engine) {
      return {
        configured: false,
        url: null,
        healthPath: '/health',
        model: 'yolov8n',
        enabled: false,
        envFallbackUrl: envYoloUrl || null,
        source: envYoloUrl ? 'env' : 'none',
        // FAZA 8.h.7 — LLM section (Ollama summarizer)
        llmUrl: null,
        llmModel: envLlmModel,
        llmEnabled: false,
        llmEnvFallbackUrl: envLlmUrl || null,
        llmSource: envLlmUrl ? 'env' : 'none',
      }
    }
    const source = engine.buildingId === 0 ? 'env' : 'cloud'
    return {
      configured: true,
      buildingId: engine.buildingId,
      url: engine.url,
      healthPath: engine.healthPath,
      model: engine.model,
      enabled: engine.enabled,
      envFallbackUrl: envYoloUrl || null,
      source,
      // LLM
      llmUrl: engine.llmUrl,
      llmModel: engine.llmModel,
      llmEnabled: engine.llmEnabled,
      llmEnvFallbackUrl: envLlmUrl || null,
      llmSource: engine.llmUrl ? (engine.buildingId === 0 ? 'env' : 'cloud') : (envLlmUrl ? 'env' : 'none'),
      updatedAt: engine.updatedAt,
    }
  }

  /**
   * PUT /ai-engine
   * Body: { url, healthPath?, model?, enabled? }
   *
   * Walidacja URL (musi zaczynać się od http://). Po zapisie emit
   * `AI_ENGINE_REPORT` żeby Cloud upsert (idempotent, Cloud user-set wins).
   */
  @Put()
  saveConfig(@Body() body: {
    url?: string
    healthPath?: string
    model?: string
    enabled?: boolean
    llmUrl?: string | null
    llmModel?: string
    llmEnabled?: boolean
  }) {
    const url = String(body?.url ?? '').trim()
    if (!url) {
      return { ok: false, error: 'URL is required' }
    }
    if (!/^https?:\/\//.test(url)) {
      return { ok: false, error: 'URL (YOLO) must start with http:// or https://' }
    }
    // LLM URL validation — opcjonalne, gdy null nie zmieniamy, gdy podany musi być valid.
    if (typeof body.llmUrl === 'string' && body.llmUrl.trim() !== '' &&
        !/^https?:\/\//.test(body.llmUrl.trim())) {
      return { ok: false, error: 'LLM URL must start with http:// or https://' }
    }

    const existing = this.store.aiEngineGet()
    // FAZA 8.h.6 (2026-06-05) — Edge UI edycja zachowuje obecny buildingId,
    // a gdy go nie mamy (brak row LUB row z placeholder=0) — zostaje 0
    // i Cloud nadpisze przy AI_ENGINE_REPORT (Cloud zna swój buildingId per Edge).
    const buildingId = existing?.buildingId ?? 0

    this.store.aiEngineUpsert({
      buildingId,
      url,
      healthPath: body.healthPath?.trim() || '/health',
      model: body.model?.trim() || 'yolov8n',
      enabled: body.enabled !== false,
      // LLM — partial update (undefined = zostaw obecne)
      llmUrl: body.llmUrl !== undefined
        ? (body.llmUrl && body.llmUrl.trim() ? body.llmUrl.trim() : null)
        : undefined,
      llmModel: body.llmModel !== undefined ? (body.llmModel?.trim() || 'qwen2.5:14b') : undefined,
      llmEnabled: body.llmEnabled,
    })

    // Wyślij raport do Cloud — fire-and-forget. Cloud zrobi UPSERT-IF-EMPTY,
    // więc gdy Cloud Integrator już wpisał config to nasz raport zostanie
    // zignorowany (defense-in-depth dla user intent).
    this.emitReportToCloud()

    this.logger.log(`[ai-engine] saved via Edge UI: url=${url} model=${body.model ?? 'yolov8n'}`)
    return { ok: true, source: 'manual' }
  }

  /**
   * POST /ai-engine/test
   * Body: { url?, healthPath? }
   *
   * Test connection LOKALNY — bez przejścia przez Cloud→Edge tunel.
   * Wynik wraca synchroniczne, Edge UI pokazuje natychmiast (~50-500ms).
   * Override URL pozwala testować nowy URL przed zapisem.
   */
  @Post('test')
  async testConnection(@Body() body: { url?: string; healthPath?: string }) {
    const result = await this.vision.testEngineConnection({
      urlOverride: body?.url?.trim() || undefined,
      healthPathOverride: body?.healthPath?.trim() || undefined,
    })
    return result
  }

  /**
   * POST /ai-engine/test-llm
   * Body: { url? }
   *
   * Test connection do Ollama LLM (GET /api/tags). Zwraca też listę
   * dostępnych modeli żeby UI mogło pokazać dropdown faktycznie
   * zainstalowanych (zamiast hard-codowanych w HTML).
   */
  @Post('test-llm')
  async testLlmConnection(@Body() body: { url?: string }) {
    const result = await this.llm.testLlmConnection({
      urlOverride: body?.url?.trim() || undefined,
    })
    return result
  }

  /**
   * Helper — emit pełen config jako EVT do Cloud przez VisionDetectService
   * (który już ma lazy-injected tunnelSend od TunnelService.onModuleInit).
   * Cloud reaguje upsert ON CONFLICT DO NOTHING (user-set wins).
   *
   * Nie injectujemy TunnelService bezpośrednio bo to robi cycle
   * `TunnelModule → DevicesModule → TunnelModule`.
   */
  private emitReportToCloud() {
    const engine = this.store.aiEngineGet()
    if (!engine) return
    const ok = this.vision.emitAiEngineReport({
      url: engine.url,
      healthPath: engine.healthPath,
      model: engine.model,
      enabled: engine.enabled,
      llmUrl: engine.llmUrl,
      llmModel: engine.llmModel,
      llmEnabled: engine.llmEnabled,
      sourceBuildingId: engine.buildingId,
    })
    if (!ok) {
      this.logger.warn('[ai-engine] tunnel not connected — Cloud will re-sync on reconnect')
    }
  }
}
