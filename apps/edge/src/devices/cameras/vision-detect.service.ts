import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import axios from 'axios'
import * as fs from 'fs'
import { lanHttpsAgent } from '../lan-https-agent'
import * as path from 'path'
import { requestWithDigest } from '../http-digest'
import { promises as fsp } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as nativeOcr from './native-ocr'
import { matchPlates, voteAcrossFrames } from './plate-matcher'
import { matchBrand } from './brand-matcher'
import { StoreService } from '../../store/store.service'

/**
 * VisionDetectService — EVENT-DRIVEN pipeline analizy wizyjnej (2026-07-03).
 *
 * Dwa tory:
 *   1. SAMPLING LOOP (co ~4s per kamera, konfigurowalne) — pobiera snapshot,
 *      liczy tani frame-diff w Node (sharp: downscale 64×48 grayscale,
 *      % zmienionych pikseli + minimalna spójna POWIERZCHNIA zmiany —
 *      liść/ptak/szum sensora nie triggeruje). Dopiero istotna zmiana
 *      sceny → pełna klatka do YOLO /detect.
 *   2. KEEPALIVE TICK (60s, stare zachowanie jako podłoga) — kamery bez
 *      analizy w ostatniej minucie i tak dostają pełny cykl, więc diff-gate
 *      nigdy nie może „zgubić" sceny na dłużej niż minutę.
 *
 * Ochrona M1 (YOLO + Ollama współdzielą budżet obliczeniowy MacBooka):
 *   • globalny minimalny odstęp między wywołaniami YOLO (default 2s),
 *   • limit N wywołań/min per kamera (default 6),
 *   • exponential backoff gdy YOLO timeout-uje / zwraca błąd,
 *   • guard skip-if-inflight (nigdy nie stackujemy analiz).
 *
 * Wysyła do zewnętrznego YOLO service na MacBook Pro (default:
 * http://192.168.1.109:11500). Summary {class: count} z YOLO wpada do
 * `vision_detections`. Assistant (apps/ai-prototype) używa tej tabeli dla
 * pytań typu „ile osób dziś", „były psy w ostatniej godzinie".
 *
 * Architektura — dlaczego Edge fetchuje snapshot, nie YOLO service:
 *   • MacBook tylko *odbiera* base64 od Edge przez outbound HTTP. Nie
 *     łączy się z LAN cameras sam → omija macOS Tahoe TCC local-network
 *     prompt (który blokuje launchd services).
 *   • Edge ma już digest-auth do Hikvision (LPR service), więc dodanie
 *     drugiego fetchera w innym języku to duplikacja.
 *   • Credentials NIGDY nie idą na MacBook — fetch lokalnie.
 *
 * Performance: 3 kamery × 1 frame/min × ~50ms inference ~= 150ms/min
 * total wall time. Każdy fetch+detect to ~1-2s (network + base64
 * encode/decode). Działa sekwencyjnie żeby nie zarzucać kamer ani YOLO
 * jednocześnie 3× — opóźnienie 6s/min dla 3 kamer jest akceptowalne.
 */

const httpsAgent = lanHttpsAgent

interface VisionCameraConfig {
  ipAddress: string
  login?: string
  password: string
  manufacturer: string
  channel?: number
  httpPort?: number
}

/**
 * One YOLO detection box. Mirror of the Python service's response shape.
 * `bbox` is `[x, y, w, h]` in pixels (top-left + size).
 */
export interface YoloDetection {
  class: string
  conf: number
  bbox: [number, number, number, number]
}

interface YoloResponse {
  detections: YoloDetection[]
  summary: Record<string, number>
  inference_ms: number
  image_size: [number, number]
  // Brand detection (2026-05-19, optional — present only when YOLO service
  // was called with `with_brand=true` and ran EasyOCR on notable crops).
  // brand_detected: canonical UPPERCASE (DHL/DPD/INPOST/FEDEX/…). null when
  //                 no brand pattern matched any OCR string.
  // brand_conf:     0..1 EasyOCR confidence for the matched token.
  // text_raw:       array of all OCR strings found across all crops (debug).
  // ocr_ms:         wall-clock time spent in EasyOCR (sub-timing).
  brand_detected?: string | null
  brand_conf?: number | null
  // Waste-truck detection (2026-05-19, optional — present when YOLO
  // klasyfikował crop jako 'truck' i EasyOCR rozpoznał napis kategorii
  // odpadów (SZKŁO/ZMIESZANE/PAPIER/PLASTIK/BIO). waste_operator jest
  // niezależny — śmieciarka może mieć tylko napis firmy bez kategorii.
  waste_category?: string | null
  waste_conf?: number | null
  waste_operator?: string | null
  text_raw?: string[]
  ocr_ms?: number
  // 2026-08-14: atrybuty NAJWIĘKSZEGO pojazdu w klatce z VLM (qwen2.5vl na
  // Mac Studio). kind rozstrzyga tam, gdzie klasy COCO kłamią (van→bus,
  // SUV/koparka→truck). Obecne tylko przy with_brand i pojeździe w kadrze.
  vehicle_attrs?: {
    kind: 'osobowy' | 'dostawczy' | 'ciezarowka' | 'bus' | 'maszyna' | 'inny'
    make: string | null
    color: string | null
    yolo_class: string
    vlm_ms: number
  }
  // Kandydaci tablic z OCR (post-process anpr) — [{plate, conf}]. Używane do
  // korelacji z rejestrem osiedla (2026-08-15).
  plate_candidates?: { plate: string; conf: number }[]
  // 2026-05-23: pose estimation + fall detection. Obecny tylko gdy
  // `with_pose=true` AND summary.person > 0. Heurystyka geometryczna na
  // 17 keypoints YOLOv8-pose (głowa, biodra, ramiona, kolana).
  // 2026-07-05: fall_detected = POTWIERDZONY upadek (persystencja >= N
  // kandydatów w oknie po stronie yolo-vision). fall_candidate = klatka
  // wygląda na upadek ale czeka na potwierdzenie → Edge robi szybki
  // re-check kamery. annotated_image_b64 = JPEG z czerwoną ramką „UPADEK"
  // (obecny tylko przy fall_detected).
  pose?: {
    persons: number
    max_likelihood: number      // 0.0-1.0 (max across all persons)
    fall_detected: boolean      // POTWIERDZONY (persystencja)
    fall_candidate?: boolean    // kandydat (pojedyncza klatka)
    fall_streak?: number        // ile kandydatów w bieżącym oknie
    annotated_image_b64?: string
    details: Array<{
      bbox: [number, number, number, number]
      conf: number
      fall_likelihood: number
      indicators: string[]
      details: Record<string, number>
    }>
    inference_ms: number
  }
}

/** Klasy COCO które warto zachować jako image_path (frame na dysku). */
// Klasy YOLO uznane za „notable" — uruchamiają persist klatki (JPEG)
// i row insert do `vision_detections`. Reszta klatek (np. samo
// `{"car":1}`) jest **pomijana** (no row, no JPEG) żeby nie zaśmiecać
// bazy i nie zalewać BA Vision page entries-ami które nic nie wnoszą.
// Brand_detected / waste_category dodatkowo wymuszają persist nawet
// gdy `summary` nie ma żadnej z tych klas (kurier/śmieciarka).
const NOTABLE_CLASSES = new Set([
  'person', 'dog', 'cat',
  // Truck/bus = potencjalne kuriery + śmieciarki (van DPD często
  // klasyfikowany przez YOLO jako `truck` z bliska).
  'truck', 'bus',
  // Bicycle = rower z plecakiem (np. Glovo/Wolt courier)
  'bicycle', 'motorcycle',
])

/**
 * Klasy IGNOROWANE po YOLO (2026-07-03) — domykają filtr „liść/ptak".
 * Detekcje tych klas są wycinane z detections+summary PRZED decyzją
 * notable/persist. `bird` to jedyny częsty false-trigger; liść nie ma
 * własnej klasy COCO ale odpada na min-bbox/min-conf filtrze.
 */
const IGNORED_CLASSES = new Set(['bird'])

/**
 * Klasy na których OCR-owy tekst („napis na burcie / ubraniu / teczce")
 * wymusza zapis nawet gdy brand_matcher nic nie dopasował. Wymaganie
 * właściciela (2026-07-03): samochód z napisem + osoba z napisem MUSZĄ
 * trafić do vision_detections z text_raw + JPEG. `car` celowo — samo
 * `{"car":1}` dalej jest non-notable, ale car+tekst już TAK.
 */
const TEXT_SUBJECT_CLASSES = new Set(['car', 'truck', 'bus', 'person'])

/**
 * OSD overlay noise — te same wzorce co `parseTextRaw` w
 * vision-detect.controller.ts (data/czas/„Canera 01"). Filtrują tokeny OCR
 * przy decyzji „czy klatka ma znaczący napis" — bez tego KAŻDA klatka
 * z widocznym OSD liczyłaby się jako „z napisem".
 */
const OSD_TEXT_PATTERNS = [
  /^\d{2}-\d{2}-\d{4}/,             // 06-05-2026
  /^\d{4}-\d{2}-\d{2}/,             // 2026-06-05
  /^\d{2}:\d{2}(:\d{2})?/,          // 20:24:28
  /^\s*(can?era|camera|cam)\s*\d/i, // Camera 01 / Canera 01
  /^(mon|tue|wed|thu|fri|sat|sun)$/i,
]

/** Tokeny OCR które realnie coś znaczą (≥3 znaki, litera lub ≥3 cyfry, bez OSD). */
function meaningfulOcrTokens(textRaw: unknown): string[] {
  if (!Array.isArray(textRaw)) return []
  return (textRaw as unknown[])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .filter((t) => /[A-Za-zÀ-ſ]/.test(t) || /\d{3,}/.test(t))
    .filter((t) => !OSD_TEXT_PATTERNS.some((p) => p.test(t)))
}

/** Env helpers — liczba z clampem, default gdy brak/nieparsowalne. */
function envInt(name: string, def: number, min: number, max: number): number {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw)) return def
  return Math.min(max, Math.max(min, Math.round(raw)))
}
function envFloat(name: string, def: number, min: number, max: number): number {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw)) return def
  return Math.min(max, Math.max(min, raw))
}

/** Per-camera liczniki diagnostyczne (reset co 5 min przy logu). */
interface CamGateStats {
  samples: number
  fetchFail: number
  gateRejected: number
  gatePassed: number
  yoloCalls: number
  budgetSkipped: number
  saved: number
}

@Injectable()
export class VisionDetectService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VisionDetectService.name)
  /**
   * Default YOLO URL fallback gdy konfiguracja w `ai_engines` nie istnieje
   * (np. pre-FAZA 8.g Edge boot albo nigdy nie skonfigurowane). Czytany
   * raz w constructor — runtime URL pochodzi z `getActiveEngine()`.
   */
  private readonly envYoloUrl: string
  /**
   * Master enable z env. AI Engine config (DB) ma swój `enabled` per-row;
   * ten flag jest globalnym wyłącznikiem przed Faza 8.g — jeśli `YOLO_ENABLED=false`,
   * to nawet jak DB ma row z enabled=1, VisionDetect cycle skipuje.
   * To zostawiamy dla operatora który chce ad-hoc wyłączyć całość bez UI.
   */
  private readonly enabledFromEnv: boolean
  private readonly requestTimeoutMs: number
  /** Brand detection toggle. Off by default (saves OCR latency until operator
   *  enables in production). When on, every /detect call sets with_brand=true
   *  and EasyOCR runs on notable crops (~300-500ms extra per frame on M1). */
  private readonly brandEnabled: boolean
  /** Guard against overlap — if a previous run is still going at the next
   *  tick (e.g. YOLO MacBook is slow / down), we skip rather than stack
   *  parallel runs. */
  private inProgress = false

  // ── Event-driven sampling config (2026-07-03, env z defaultami) ──────────
  /** Master toggle pętli próbkującej. `false` = zachowanie sprzed zmiany
   *  (tylko 60s tick). */
  private readonly samplingEnabled: boolean
  /** Odstęp próbkowania per pętla (wszystkie kamery sekwencyjnie w ticku). */
  private readonly sampleIntervalMs: number
  /** Próg różnicy jasności piksela (0-255) żeby uznać go za „zmieniony". */
  private readonly diffPixelDelta: number
  /** Min % zmienionych pikseli (na siatce 64×48) → kandydat na zmianę sceny. */
  private readonly diffMinChangedPct: number
  /** Min POWIERZCHNIA spójnego (4-connected) obszaru zmiany w px siatki —
   *  liść/ptak/szum daje rozproszone pojedyncze piksele, auto/człowiek
   *  zwarty blob. 12 px na 64×48 ≈ 0.4% kadru w jednym kawałku. */
  private readonly diffMinBlobArea: number
  /** Globalny minimalny odstęp między wywołaniami YOLO (ochrona M1 —
   *  YOLO dzieli MacBooka z Ollama/Bielik). */
  private readonly yoloMinGapMs: number
  /** Max wywołań YOLO na minutę per kamera (rolling window). */
  private readonly maxYoloPerCamPerMin: number
  /** Min confidence detekcji po stronie Edge (YOLO service ma własny 0.25;
   *  tu podnosimy podłogę żeby szum nie robił notable). */
  private readonly minDetectionConf: number
  /** Min powierzchnia bboxa jako % powierzchni kadru — skalowane do
   *  rozdzielczości. Detekcje mniejsze (odległy ptak, liść uznany za cokolwiek)
   *  są wycinane. */
  private readonly minBboxAreaPct: number
  /** Opóźnienie szybkiego re-checku po fall_candidate (0 = wyłączony). */
  private readonly fallRecheckMs: number

  // ── Event-driven sampling state ──────────────────────────────────────────
  private samplingTimer: ReturnType<typeof setInterval> | null = null
  /** Guard pętli próbkującej — analogicznie do inProgress dla runCycle. */
  private samplingBusy = false
  /** sharp ładowany dynamicznie (wzorzec z intercom-snapshot.controller) —
   *  gdy niedostępny (CI/dev bez binarki arm64) diff-gate wyłączony,
   *  zostaje 60s keepalive. */
  private sharpMod: any | null = null
  private sharpUnavailable = false
  /** Ostatnia zminiaturyzowana klatka (64×48 gray raw) per kamera. */
  private readonly prevDiffFrame = new Map<string, Buffer>()
  /** Ts ostatniej PEŁNEJ analizy YOLO per kamera — keepalive tick pomija
   *  kamery świeżo przeanalizowane przez diff-gate/LPR-trigger. */
  private readonly lastYoloPerCam = new Map<string, number>()
  /** Rolling log wywołań YOLO per kamera (do limitu N/min). */
  private readonly yoloCallLog = new Map<string, number[]>()
  private lastYoloGlobalTs = 0
  /** Backoff po awariach YOLO — rośnie wykładniczo 15s→300s. */
  private yoloConsecFailures = 0
  private yoloBackoffUntil = 0
  /** Liczniki diagnostyczne per kamera, log + reset co 5 min. */
  private readonly camStats = new Map<string, CamGateStats>()

  /**
   * Per-camera state — pamięta ostatnio ZAPISANY notable composition + ts.
   * Używany do dedup "ta sama osoba siedzi w polu kamery przez 30 min" —
   * vision polluje co 60s, ale do bazy idzie TYLKO gdy:
   *   • zmienił się set notable klas (np. było person, teraz +dog)
   *   • lub minęło >10min od ostatniego save (keepalive)
   *   • lub brand_detected / waste_category (zawsze interesujące)
   *
   * In-memory Map — reset przy restarcie Edge (OK, pierwsza klatka po
   * restart → "first detection" → save).
   */
  private readonly lastSavedState = new Map<
    string,
    { notable: string; savedTs: number }
  >()

  /** Keepalive interval — co 10min mimo braku zmian zapisz row żeby BA Vision
   *  page miał wciąż "tętno" kamery. Dłuższe niż 10min mogłoby sugerować że
   *  kamera padła. */
  private static readonly NOTABLE_KEEPALIVE_MS = 10 * 60 * 1000

  // 2026-05-24 — tunnel-sender wstrzykiwany przez TunnelService.onModuleInit
  // (lazy żeby uniknąć cyklu DevicesModule ↔ TunnelModule). Używany do
  // emit `ANOMALY_DETECTED` do Cloud (fall detection). Gdy WS down → fn
  // zwraca false, my zapisujemy do `event_queue` przez SyncService flush.
  private tunnelSend: ((event: string, data: Record<string, any>, deviceId?: string) => boolean) | null = null
  setTunnelSend(fn: (event: string, data: Record<string, any>, deviceId?: string) => boolean) {
    this.tunnelSend = fn
    // FAZA 8.h.6 (2026-06-05) — gdy TunnelService podłącza handler (po
    // każdym reconnect), Edge automatycznie raportuje swój AI Engine config
    // do Cloud. Cloud upsert ON CONFLICT DO NOTHING — user-set z Cloud
    // Integrator panel ZAWSZE wygrywa. Bez tego Edge auto-migration z env
    // var ginie w kosmosie (Cloud DB pusty mimo że Edge działa).
    const engine = this.store.aiEngineGet()
    if (engine) {
      try {
        fn('AI_ENGINE_REPORT', {
          url: engine.url,
          healthPath: engine.healthPath,
          model: engine.model,
          enabled: engine.enabled,
          // FAZA 8.h.7 — LLM fields w raporcie
          llmUrl: engine.llmUrl,
          llmModel: engine.llmModel,
          llmEnabled: engine.llmEnabled,
          sourceBuildingId: engine.buildingId,  // 0 = placeholder (env auto-migration)
        })
      } catch (err: any) {
        this.logger.warn(`[ai-engine] auto-report failed: ${err?.message ?? err}`)
      }
    }
  }

  /**
   * Public helper — emit AI_ENGINE_REPORT do Cloud używany przez
   * `AiEngineController` po PUT z Edge UI. Tunnel-send dostarcza
   * `TunnelService.onModuleInit` przez setTunnelSend (lazy żeby uniknąć
   * cykli między TunnelModule i DevicesModule).
   *
   * Returns: true gdy WS up i wiadomość poszła, false gdy tunel offline
   * (Cloud auto-re-sync zrobi się przy reconnect przez `setTunnelSend`).
   */
  emitAiEngineReport(report: {
    url: string
    healthPath: string
    model: string
    enabled: boolean
    llmUrl?: string | null
    llmModel?: string
    llmEnabled?: boolean
    sourceBuildingId: number
  }): boolean {
    if (!this.tunnelSend) return false
    return this.tunnelSend('AI_ENGINE_REPORT', report)
  }

  /**
   * VLM-detektyw (2026-09-01): celowane pytanie o pełny kadr — proxy do
   * yolo-vision `POST /scene-question` (qwen2.5vl na serwerze AI).
   * Tryby: night_person | vehicle_waiting | fall_confirm | describe.
   * null przy braku silnika / błędzie — caller traktuje fail-silent.
   */
  async sceneQuestion(
    image: Buffer,
    mode: string,
    question?: string,
  ): Promise<{ answer: string; confirmed: boolean | null } | null> {
    const engine = this.resolveActiveEngine()
    if (!engine?.enabled) return null
    try {
      const res = await axios.post(
        `${engine.url}/scene-question`,
        { image_base64: image.toString('base64'), mode, question },
        { timeout: 35_000 },
      )
      const answer = String(res.data?.answer ?? '').trim()
      if (!answer) return null
      const confirmed =
        typeof res.data?.confirmed === 'boolean' ? res.data.confirmed : null
      return { answer, confirmed }
    } catch (err: any) {
      this.logger.debug(`scene-question(${mode}) failed: ${err?.message ?? err}`)
      return null
    }
  }

  /**
   * Alert sytuacyjny do Cloud (2026-09-01) — dziś jedyny nadawca to
   * potwierdzony przez VLM upadek (push krytyczny do mieszkańców).
   * Ten sam kanał co ANOMALY_DETECTED; false gdy tunel offline.
   */
  /** 2026-10-02 — przyjazd śmieciarki (potwierdzony) → Cloud wysyła push do chętnych. */
  emitWasteTruck(data: { ts: number; confirmedTs: number; frames: number; cameras: number }): boolean {
    if (!this.tunnelSend) return false
    return this.tunnelSend('WASTE_TRUCK_ARRIVED', data)
  }

  emitSituationAlert(data: {
    kind: string
    title: string
    body: string
    ts: number
  }): boolean {
    if (!this.tunnelSend) return false
    return this.tunnelSend('SITUATION_ALERT', data)
  }

  constructor(private store: StoreService) {
    this.envYoloUrl = (process.env.YOLO_URL ?? 'http://192.168.1.109:11500').replace(/\/+$/, '')
    // Default to disabled when YOLO_URL isn't set explicitly — keeps Edge
    // builds in environments without MacBook (CI, dev laptops) silent.
    // Set YOLO_ENABLED=true in production.
    this.enabledFromEnv = (process.env.YOLO_ENABLED ?? 'false').toLowerCase() === 'true'
    this.requestTimeoutMs = Number(process.env.YOLO_TIMEOUT_MS ?? 20_000)
    // Default ON when YOLO is enabled — brand detection is the whole point
    // of the 2026-05-19 work. Allow operators to opt out with YOLO_BRAND=false
    // (e.g. when MacBook is upgrading and EasyOCR weights are still downloading).
    this.brandEnabled = (process.env.YOLO_BRAND ?? 'true').toLowerCase() === 'true'
    // ── Event-driven sampling (2026-07-03) — env z defaultami ────────────
    // Same env reads (bez store!) — bezpieczne w konstruktorze.
    this.samplingEnabled = (process.env.VISION_SAMPLING_ENABLED ?? 'true').toLowerCase() === 'true'
    this.sampleIntervalMs = envInt('VISION_SAMPLE_INTERVAL_MS', 4_000, 1_000, 60_000)
    this.diffPixelDelta = envInt('VISION_DIFF_PIXEL_DELTA', 28, 5, 128)
    this.diffMinChangedPct = envFloat('VISION_DIFF_MIN_CHANGED_PCT', 1.5, 0.1, 100)
    this.diffMinBlobArea = envInt('VISION_DIFF_MIN_BLOB_AREA', 12, 1, 3_072)
    this.yoloMinGapMs = envInt('VISION_YOLO_MIN_GAP_MS', 2_000, 0, 60_000)
    this.maxYoloPerCamPerMin = envInt('VISION_MAX_YOLO_PER_CAMERA_PER_MIN', 6, 1, 60)
    this.minDetectionConf = envFloat('VISION_MIN_CONF', 0.35, 0, 1)
    this.minBboxAreaPct = envFloat('VISION_MIN_BBOX_PCT', 0.3, 0, 100)
    // 2026-07-05 — fall_candidate → szybki re-check kamery (persystencja).
    this.fallRecheckMs = envInt('VISION_FALL_RECHECK_MS', 6_000, 0, 60_000)
    // FAZA 8.g (2026-06-03) — UWAGA: NIE wołaj `store.aiEngineGet()` w
    // konstruktorze. StoreService.db jest inicjalizowany dopiero w
    // `StoreService.onModuleInit()` — odpalenie sqlite prepared statement
    // tutaj rzuca `Cannot read properties of undefined (reading 'prepare')`,
    // co przy retry-launchd robi infinite crash-loop. Bootstrap + log w
    // `onModuleInit` poniżej.
  }

  /**
   * Lifecycle hook — bezpiecznie wołane PO `StoreService.onModuleInit`,
   * więc `this.store.aiEngineGet()` ma już zainicjalizowane `db`.
   */
  onModuleInit() {
    this.bootstrapAiEngineConfig()
    const engine = this.store.aiEngineGet()
    if (engine && engine.enabled) {
      this.logger.log(
        `VisionDetect ready → ${engine.url} model=${engine.model} brand=${this.brandEnabled ? 'on' : 'off'} ` +
          `(timeout=${this.requestTimeoutMs}ms, source=ai_engines)`,
      )
    } else if (this.enabledFromEnv) {
      this.logger.log(
        `VisionDetect ready (env fallback) → ${this.envYoloUrl} brand=${this.brandEnabled ? 'on' : 'off'} ` +
          `(timeout=${this.requestTimeoutMs}ms)`,
      )
    } else {
      this.logger.log('VisionDetect disabled (no ai_engines row + YOLO_ENABLED!=true)')
    }
    // ── Event-driven sampling loop (2026-07-03) ─────────────────────────
    // Timer startuje zawsze gdy samplingEnabled — per-tick i tak sprawdzamy
    // resolveActiveEngine().enabled, więc włączenie AI Engine z Cloud UI
    // aktywuje pętlę bez restartu Edge.
    if (this.samplingEnabled) {
      this.samplingTimer = setInterval(() => {
        void this.samplingTick()
      }, this.sampleIntervalMs)
      this.logger.log(
        `Vision sampling ON: every ${this.sampleIntervalMs}ms/camera, ` +
          `diff(delta=${this.diffPixelDelta}, minChanged=${this.diffMinChangedPct}%, minBlob=${this.diffMinBlobArea}px), ` +
          `yolo(minGap=${this.yoloMinGapMs}ms, maxPerCamPerMin=${this.maxYoloPerCamPerMin}), ` +
          `filter(minConf=${this.minDetectionConf}, minBboxPct=${this.minBboxAreaPct}%)`,
      )
    } else {
      this.logger.log('Vision sampling OFF (VISION_SAMPLING_ENABLED=false) — 60s keepalive only')
    }
  }

  onModuleDestroy() {
    if (this.samplingTimer) {
      clearInterval(this.samplingTimer)
      this.samplingTimer = null
    }
  }

  // ── AI Engine config bootstrap (FAZA 8.g, 2026-06-03) ──────────────────────
  /**
   * Auto-migration: jeśli env `YOLO_URL` jest ustawione (jak dotąd) ALE w
   * sqlite nie ma row-a `ai_engines.id=1`, to inserujemy z env-config. Cloud
   * dostanie informację przy następnym AI_ENGINE_CONFIG_UPDATE / pełnym sync,
   * ale do tego czasu Edge ma działający fallback bez konieczności zmiany
   * pliku konfiguracyjnego.
   *
   * BuildingId = 0 placeholder gdy nie znamy — w praktyce Cloud zaraz przyśle
   * UPDATE z prawdziwym buildingId. Edge sam nie wie buildingId bo jest w
   * sqlite tylko jako ActivationService snapshot (omijamy zależność cyklową).
   */
  private bootstrapAiEngineConfig() {
    try {
      const existing = this.store.aiEngineGet()
      if (existing) return
      const envUrl = process.env.YOLO_URL
      if (!envUrl) return
      this.store.aiEngineUpsert({
        buildingId: 0,
        url: envUrl,
        healthPath: '/health',
        model: 'yolov8n',
        enabled: this.enabledFromEnv,
      })
      this.logger.log(
        `[ai-engine] auto-migrated from YOLO_URL env (${envUrl}) — Cloud will overwrite on next AI_ENGINE_CONFIG_UPDATE`,
      )
    } catch (err: any) {
      this.logger.warn(`[ai-engine] bootstrap failed: ${err?.message ?? err}`)
    }
  }

  /**
   * Aktualny URL silnika + flagi (DB priority, env fallback). Pozwala
   * dynamiczne reload-y po AI_ENGINE_CONFIG_UPDATE bez restartu serwisu.
   */
  private resolveActiveEngine(): { url: string; enabled: boolean; model: string } | null {
    const engine = this.store.aiEngineGet()
    if (engine && engine.url) {
      return { url: engine.url, enabled: engine.enabled, model: engine.model }
    }
    if (this.enabledFromEnv && this.envYoloUrl) {
      return { url: this.envYoloUrl, enabled: true, model: 'yolov8n' }
    }
    return null
  }

  /** Public wrapper — Cloud test connection or diagnostic UI mogą zapytać o URL. */
  getActiveEngineUrl(): string | null {
    return this.resolveActiveEngine()?.url ?? null
  }

  /**
   * Test connection do AI Engine — wywoływany przez TunnelService po
   * `AI_ENGINE_TEST` command. Robi GET na <url><healthPath> z 10s timeout-em
   * i zwraca wynik (ms, statusCode, error). Jeśli config nie istnieje —
   * zwraca `{ok:false, error:'no config'}`.
   *
   * Wynik jest odsyłany do Cloud przez tunnel event `AI_ENGINE_TEST_RESULT`,
   * a Cloud zapisuje do `ai_engines.lastTest*` kolumn.
   */
  async testEngineConnection(opts?: { urlOverride?: string; healthPathOverride?: string }): Promise<{
    ok: boolean
    ms: number | null
    statusCode: number | null
    error: string | null
    model: string | null
    url: string
  }> {
    const engine = this.store.aiEngineGet()
    // Override pozwala BA testować nowy URL PRZED zapisem (UI: "Testuj" w formularzu).
    const url = (opts?.urlOverride ?? engine?.url ?? this.envYoloUrl).replace(/\/+$/, '')
    const healthPath = opts?.healthPathOverride ?? engine?.healthPath ?? '/health'
    const fullUrl = `${url}${healthPath.startsWith('/') ? '' : '/'}${healthPath}`
    if (!url) {
      return { ok: false, ms: null, statusCode: null, error: 'no URL configured', model: engine?.model ?? null, url: '' }
    }
    const start = Date.now()
    try {
      const res = await axios.get(fullUrl, {
        timeout: 10_000,
        validateStatus: () => true,  // każdy status — sami decydujemy
      })
      const ms = Date.now() - start
      const ok = res.status >= 200 && res.status < 400
      return {
        ok,
        ms,
        statusCode: res.status,
        error: ok ? null : `HTTP ${res.status}`,
        model: engine?.model ?? null,
        url: fullUrl,
      }
    } catch (err: any) {
      const ms = Date.now() - start
      return {
        ok: false,
        ms,
        statusCode: null,
        error: err?.code ?? err?.message ?? 'unknown error',
        model: engine?.model ?? null,
        url: fullUrl,
      }
    }
  }

  // ── Fall re-check (2026-07-05) ──────────────────────────────────────────
  // yolo-vision zgłasza fall_candidate (jedna klatka wygląda na upadek, ale
  // persystencja jeszcze nie potwierdziła). Zamiast czekać do 60s keepalive,
  // robimy szybki ponowny snapshot+analizę tej kamery — potwierdzenie albo
  // odrzucenie przychodzi w ~kilkanaście sekund. Deduplikowane per kamera.
  private readonly fallRecheckPending = new Set<string>()

  private scheduleFallRecheck(deviceId: string): void {
    if (this.fallRecheckMs <= 0) return
    if (this.fallRecheckPending.has(deviceId)) return
    this.fallRecheckPending.add(deviceId)
    setTimeout(() => {
      void (async () => {
        this.fallRecheckPending.delete(deviceId)
        try {
          if (Date.now() < this.yoloBackoffUntil) return // YOLO w backoffie
          if (this.inProgress) {
            // Analiza w toku — keepalive/diff-gate i tak zaraz przeanalizuje.
            this.logger.debug(`Fall re-check for ${deviceId.slice(0, 8)}… skipped (busy)`)
            return
          }
          const cam = this.listCameras().find((c) => c.deviceId === deviceId)
          if (!cam) return
          this.inProgress = true
          try {
            this.logger.log(`Fall re-check → camera ${deviceId.slice(0, 8)}…`)
            await this.runOne(cam.deviceId, cam.config)
          } finally {
            this.inProgress = false
          }
        } catch (err: any) {
          this.logger.warn(`Fall re-check failed for ${deviceId}: ${err?.message ?? err}`)
        }
      })()
    }, this.fallRecheckMs)
  }

  // ── Event-driven trigger (2026-05-22) ──────────────────────────────────
  // Throttle map per camera — chroni przed burst LPR events (np. 3 plates
  // w 2s = nie chcemy 3 snapshot calls do Ollama). Min interval 8s wystarczy
  // żeby pojedyncze auto przejechało i mieć szansę na drugi snapshot
  // pod inny brand/text.
  private readonly lastLprTrigger = new Map<string, number>()
  private static readonly LPR_TRIGGER_THROTTLE_MS = 8_000

  /**
   * Off-cycle snapshot trigger — wywoływany przez `HikvisionLprService` zaraz
   * po wykryciu plate. Cel: spotkać van/ciężarówkę w kadrze podczas gdy
   * fizycznie jest tuż przy bramie (LPR detection = van w momencie t),
   * zamiast czekać do 60s tick (van zniknął z kadru).
   *
   * Fire-and-forget — caller nie czeka. Throttled per-camera (8s) żeby burst
   * LPR events nie zalał Ollama.
   */
  async triggerForLpr(cameraDeviceId: string): Promise<void> {
    if (!this.resolveActiveEngine()?.enabled) return
    const now = Date.now()
    const last = this.lastLprTrigger.get(cameraDeviceId) ?? 0
    if (now - last < VisionDetectService.LPR_TRIGGER_THROTTLE_MS) {
      this.logger.debug(`LPR-trigger throttled for ${cameraDeviceId}`)
      return
    }
    this.lastLprTrigger.set(cameraDeviceId, now)

    // Znajdź config kamery — może być LPR_CAMERA (ta sama która zwrobiła ANPR)
    // albo dowolna inna CAMERA z device_config (wymierzona w to samo miejsce).
    const cameras = this.listCameras()
    if (cameras.length === 0) return

    this.logger.log(`LPR-triggered vision snapshot (camera=${cameraDeviceId.slice(0, 8)}…)`)
    // Snapshot równolegle z każdej kamery — LPR_CAMERA może mieć dane plate
    // ale CAMERA HikV ColorVu często ma lepszy crop dla OCR (wider FOV).
    await Promise.all(
      cameras.map(async (cam) => {
        try {
          await this.runOne(cam.deviceId, cam.config)
        } catch (err: any) {
          this.logger.warn(
            `LPR-trigger snapshot failed for ${cam.deviceId}: ${err?.message ?? err}`,
          )
        }
      }),
    )
  }

  // ── Event-driven sampling loop (2026-07-03) ─────────────────────────────

  /** Rozmiar siatki diff — 64×48 gray (~3KB per klatka, diff w <1ms). */
  private static readonly DIFF_W = 64
  private static readonly DIFF_H = 48
  /** Keepalive pomija kamery analizowane w ostatnich 55s (tick jest co 60s —
   *  margines 5s na jitter timera). */
  private static readonly KEEPALIVE_SKIP_MS = 55_000

  private statFor(deviceId: string): CamGateStats {
    let s = this.camStats.get(deviceId)
    if (!s) {
      s = { samples: 0, fetchFail: 0, gateRejected: 0, gatePassed: 0, yoloCalls: 0, budgetSkipped: 0, saved: 0 }
      this.camStats.set(deviceId, s)
    }
    return s
  }


  // ── Lokalne rozpoznawanie tekstu i tablic ─────────────────────────────────

  /** Ostatni ZAPISANY odczyt per urządzenie — chroni historię przed powtórkami. */
  private readonly lastOcrPlate = new Map<string, { plate: string; at: number }>()

  /**
   * Bufor niedawnych kandydatów per urządzenie — do głosowania W CZASIE.
   *
   * Ścieżka kamer LPR głosuje między klatkami jednej serii (5 zrzutów w 2,5 s).
   * Tu klatki przychodzą co kilka sekund z pętli próbkowania, więc serię
   * zastępuje okno czasowe: trzymamy kandydatów z ostatnich ~90 s i liczymy
   * zgodność między nimi.
   *
   * Po co (pomiar VN, 2026-08-07): tablica WU8450R pojawiła się na TRZECH
   * kolejnych klatkach (pewność 0.48/0.58/0.39) i za każdym razem przepadła,
   * bo każda klatka była oceniana OSOBNO przeciw progowi 0.65. Trzykrotne
   * powtórzenie tego samego odczytu to niemal pewna tablica — losowy błąd
   * OCR tak się nie powtarza. Głosowanie w oknie odzyskuje te odczyty.
   */
  private readonly ocrRecent = new Map<
    string,
    Array<{ at: number; plates: Array<{ plate: string; confidence: number }> }>
  >()
  private static readonly OCR_VOTE_WINDOW_MS = 90_000
  /** Wynik PO głosowaniu (z premią za zgodność) wymagany do pełnego zapisu. */
  private static readonly OCR_ACCEPT_CONF = 0.65
  /** Poniżej tego nawet jako „niepewny" nie zapisujemy — czysty szum OCR. */
  private static readonly OCR_FLOOR_CONF = 0.4

  /**
   * Czyta tablicę i napisy z klatki — lokalnie, natywnym silnikiem Vision.
   *
   * Po co osobno od `analyzeSnapshot`: tamta ścieżka wysyła obraz na Mac Studio
   * i służy do rozpoznawania OBIEKTÓW (ile osób, aut). Ta czyta TEKST i działa
   * na samym Edge, więc nie wymaga ani Mac Studio, ani tunelu — może więc
   * pracować na obiekcie, który nie ma serwera AI (zasada offline-first).
   *
   * Wynik trafia DOKŁADNIE tam, gdzie odczyty z kamer LPR: do `lpr_reads`
   * ze zdjęciem na dysku + zdarzeniem LPR_READ do chmury. W panelu wpis
   * niczym się nie różni poza źródłem (`reason: edge-ocr`). Odczyty poniżej
   * progu zapisujemy jako `edge-ocr-uncertain` zamiast wyrzucać — to jedyny
   * materiał do strojenia progu, a wyrzucony przepada bezpowrotnie.
   */
  private async runLocalOcr(deviceId: string, snapshot: Buffer): Promise<void> {
    if (!nativeOcr.isAvailable()) return

    const dir = await fsp.mkdtemp(join(tmpdir(), 'gatelynk-ocr-'))
    const file = join(dir, 'frame.jpg')
    try {
      await fsp.writeFile(file, snapshot)
      // Jedna klatka na analizę → kafelkowanie od razu (logo kuriera na burcie
      // jest małe względem kadru i bez tego przepada).
      const ocr = await nativeOcr.readText([file], 20_000, { tiles: true })
      const pairs = ocr.perFile[0] ?? []
      if (!pairs.length) return

      const brand = matchBrand(pairs)
      if (brand) {
        this.logger.log(
          `OCR ${deviceId.slice(0, 8)}…: 📦 rozpoznano markę ${brand.brand} ` +
          `(z napisu „${brand.matchedText.slice(0, 40)}")`,
        )
      }

      const plates = matchPlates(pairs)
      if (!plates.length && !brand) return

      // ── Głosowanie w oknie czasowym ────────────────────────────────────
      const now = Date.now()
      const buf = (this.ocrRecent.get(deviceId) ?? []).filter(
        (e) => now - e.at < VisionDetectService.OCR_VOTE_WINDOW_MS,
      )
      if (plates.length) buf.push({ at: now, plates })
      this.ocrRecent.set(deviceId, buf)
      if (!buf.length) return

      const { best, agreedFrames } = voteAcrossFrames(buf.map((e) => e.plates))
      if (!best || best.confidence < VisionDetectService.OCR_FLOOR_CONF) return

      // Dedup: ta sama tablica raz na minutę — auto stojące w kadrze potrafi
      // wyzwalać analizę wielokrotnie i zaśmieciłoby historię.
      const last = this.lastOcrPlate.get(deviceId)
      if (last && last.plate === best.plate && now - last.at < 60_000) return

      const confident = best.confidence >= VisionDetectService.OCR_ACCEPT_CONF
      this.lastOcrPlate.set(deviceId, { plate: best.plate, at: now })

      // ── Zdjęcie na dysk — ta sama konwencja co ścieżka LPR, więc miniatury
      //    w panelu działają identycznie (`<ts>_<plate>.jpg` + retention). ──
      let imagePath: string | null = null
      try {
        imagePath = `${now}_${best.plate}.jpg`
        await fsp.writeFile(join(this.store.lprSnapshotsDir(), imagePath), snapshot)
      } catch (e: any) {
        this.logger.warn(`OCR ${deviceId.slice(0, 8)}…: zapis zdjęcia nieudany: ${e?.message ?? e}`)
        imagePath = null
      }

      const match = this.store.lprMatchPlate(deviceId, best.plate)
      const reason = confident ? 'edge-ocr' : 'edge-ocr-uncertain'
      // IN/OUT z nazwy kamery — zapisywane też lokalnie, bo asystent AI liczy
      // wjazdy/wyjazdy z lokalnego `lpr_reads` (nie z Cloud).
      const direction = this.store.lprSemanticDirection(deviceId, null)
      const edgeReadId = this.store.lprInsertRead({
        cameraDeviceId: deviceId,
        plate: best.plate,
        matched: !!match,
        gateOpened: false,          // ta ścieżka NIGDY nie otwiera — tylko obserwuje
        confidence: best.confidence,
        vehicleBrand: brand?.brand ?? null,
        direction,
        imagePath,
        reason,
        ts: now,
      })

      this.logger.log(
        `OCR ${deviceId.slice(0, 8)}…: 🚗 tablica ${best.plate} ` +
        `(pewność ${best.confidence.toFixed(2)}, zgodnych klatek ${agreedFrames}` +
        `${confident ? '' : ', NIEPEWNY'}${brand ? `, marka ${brand.brand}` : ''})`,
      )

      // ── Do chmury tym samym zdarzeniem co odczyty LPR — panel widzi wpis
      //    natychmiast. Payload zgodny z `handleAnprEvent` (hikvision-lpr). ──
      const payload = {
        cameraDeviceId: deviceId,
        plate: best.plate,
        matched: !!match,
        owner: null,
        gateOpened: false,
        reason,
        confidence: best.confidence,
        // IN/OUT z nazwy kamery („Kamera wyjazd"/„Kamera Wjazd") — na
        // kamerach Edge-OCR nie ma natywnego kierunku.
        direction,
        vehicleColor: null,
        vehicleBrand: brand?.brand ?? null,
        vehicleType: null,
        vehicleSubtype: null,
        hasImage: !!imagePath,
        edgeReadId,
        ts: now,
      }
      try {
        let delivered = false
        if (this.tunnelSend) {
          delivered = this.tunnelSend('LPR_READ', payload, deviceId)
        } else {
          this.store.enqueue('LPR_READ', { ...payload, deviceId })
        }
        if (delivered && edgeReadId != null) this.store.lprMarkReadSynced(edgeReadId)
      } catch (e: any) {
        this.logger.warn(`OCR ${deviceId.slice(0, 8)}…: wysyłka do chmury nieudana: ${e?.message ?? e}`)
      }
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Jedna pętla próbkująca — wszystkie kamery sekwencyjnie (nie zalewamy
   *  ani kamer ani YOLO równoległymi fetchami). */
  private async samplingTick(): Promise<void> {
    if (this.samplingBusy) return // poprzedni tick jeszcze trwa — nie stackuj
    // Silnik YOLO (Mac Studio) NIE jest wymagany: rozpoznawanie tekstu i tablic
    // działa lokalnie na Edge. Pętla rusza, gdy potrzebuje jej którakolwiek
    // z dwóch funkcji — inaczej obiekt bez Mac Studio nie miałby OCR w ogóle.
    const anyOcr = this.listCameras().some((c) => (c.config as any)?.ocrEnabled === true)
    if (!this.resolveActiveEngine()?.enabled && !anyOcr) return
    this.samplingBusy = true
    try {
      const cameras = this.listCameras()
      for (const cam of cameras) {
        try {
          await this.sampleOne(cam.deviceId, cam.config)
        } catch (err: any) {
          this.logger.debug(`Vision sample failed for ${cam.deviceId}: ${err?.message ?? err}`)
        }
      }
    } finally {
      this.samplingBusy = false
    }
  }

  /** Snapshot → tani diff-gate → (gdy istotna zmiana + budżet) → YOLO. */
  private async sampleOne(deviceId: string, config: VisionCameraConfig): Promise<void> {
    const st = this.statFor(deviceId)
    st.samples++
    const snapshot = await this.fetchSnapshot(deviceId, config)
    if (!snapshot) {
      st.fetchFail++
      return
    }
    const frame = await this.toDiffFrame(snapshot)
    if (!frame) return // sharp niedostępny / zły JPEG — keepalive przejmie
    const prev = this.prevDiffFrame.get(deviceId)
    this.prevDiffFrame.set(deviceId, frame)
    if (!prev) return // pierwsza próbka = baseline, bez triggera

    const change = this.evaluateSceneChange(prev, frame)
    if (!change.significant) {
      st.gateRejected++
      return
    }
    st.gatePassed++

    // Lokalne OCR — niezależne od Mac Studio i od budżetu YOLO, więc MUSI
    // stać PRZED bramką budżetu. INCYDENT 2026-08-31 (VN): stało za nią,
    // a przy leżącym Mac Studio backoff YOLO odrzucał ~wszystkie klatki —
    // `budgetSkipped` ucinał też odczyt tablic (edge-ocr: 30/dzień → 0).
    if ((config as any)?.ocrEnabled === true) {
      await this.runLocalOcr(deviceId, snapshot).catch((e) =>
        this.logger.debug(`OCR ${deviceId.slice(0, 8)}…: ${e?.message ?? e}`),
      )
    }

    // Ochrona M1: backoff + globalny odstęp + limit per kamera. Odrzucona
    // tu zmiana NIE ginie — 60s keepalive i tak przeanalizuje kamerę.
    if (this.inProgress || !this.canCallYolo(deviceId)) {
      st.budgetSkipped++
      return
    }

    if (!this.resolveActiveEngine()?.enabled) return

    this.inProgress = true
    try {
      this.logger.debug(
        `Vision ${deviceId.slice(0, 8)}…: scene change ` +
          `(${change.changedPct.toFixed(1)}% px, blob=${change.maxBlob}) → YOLO`,
      )
      await this.analyzeSnapshot(deviceId, snapshot)
    } finally {
      this.inProgress = false
    }
  }

  /** Lazy-load sharp (może nie być zainstalowany w CI/dev). */
  private async getSharp(): Promise<any | null> {
    if (this.sharpUnavailable) return null
    if (this.sharpMod) return this.sharpMod
    try {
      // Dynamic import przez zmienną — unika twardej zależności typów
      // (sharp bywa hoistowany tylko w root monorepo, wzorzec z
      // intercom-snapshot.controller.ts).
      const modName = 'sharp'
      const mod: any = await import(modName)
      this.sharpMod = mod?.default ?? mod
      return this.sharpMod
    } catch (err: any) {
      this.sharpUnavailable = true
      this.logger.warn(
        `sharp unavailable — diff-gate disabled, 60s keepalive only (${err?.message ?? err})`,
      )
      return null
    }
  }

  /** JPEG → 64×48 grayscale raw buffer (3072B). Null gdy sharp brak / zły obraz. */
  private async toDiffFrame(image: Buffer): Promise<Buffer | null> {
    const sharp = await this.getSharp()
    if (!sharp) return null
    try {
      return await sharp(image)
        .resize(VisionDetectService.DIFF_W, VisionDetectService.DIFF_H, { fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer()
    } catch (err: any) {
      this.logger.debug(`diff-frame decode failed: ${err?.message ?? err}`)
      return null
    }
  }

  /**
   * Porównanie dwóch miniatur: % pikseli z |Δ| > diffPixelDelta ORAZ
   * największy spójny (4-connected) obszar zmiany. Oba progi muszą przejść —
   * rozproszony szum (deszcz, kompresja) ma % ale nie blob; ptak/liść ma
   * blob 1-4 px; człowiek/auto na 64×48 to kilkanaście+ px w jednym kawałku.
   */
  private evaluateSceneChange(
    prev: Buffer,
    cur: Buffer,
  ): { changedPct: number; maxBlob: number; significant: boolean } {
    const W = VisionDetectService.DIFF_W
    const H = VisionDetectService.DIFF_H
    const total = W * H
    const n = Math.min(prev.length, cur.length, total)
    const mask = new Uint8Array(total)
    let changed = 0
    for (let i = 0; i < n; i++) {
      if (Math.abs(prev[i] - cur[i]) > this.diffPixelDelta) {
        mask[i] = 1
        changed++
      }
    }
    const changedPct = (changed / total) * 100
    if (changedPct < this.diffMinChangedPct) {
      return { changedPct, maxBlob: 0, significant: false }
    }
    // Largest connected component — iteracyjny flood fill (bez rekursji,
    // max 3072 px więc O(1) w praktyce). Early-exit gdy próg osiągnięty.
    const visited = new Uint8Array(total)
    const stack: number[] = []
    let maxBlob = 0
    for (let i = 0; i < total && maxBlob < this.diffMinBlobArea; i++) {
      if (!mask[i] || visited[i]) continue
      let size = 0
      visited[i] = 1
      stack.push(i)
      while (stack.length > 0) {
        const p = stack.pop()!
        size++
        const x = p % W
        if (x > 0 && mask[p - 1] && !visited[p - 1]) { visited[p - 1] = 1; stack.push(p - 1) }
        if (x < W - 1 && mask[p + 1] && !visited[p + 1]) { visited[p + 1] = 1; stack.push(p + 1) }
        if (p >= W && mask[p - W] && !visited[p - W]) { visited[p - W] = 1; stack.push(p - W) }
        if (p < total - W && mask[p + W] && !visited[p + W]) { visited[p + W] = 1; stack.push(p + W) }
      }
      if (size > maxBlob) maxBlob = size
    }
    return {
      changedPct,
      maxBlob,
      significant: changedPct >= this.diffMinChangedPct && maxBlob >= this.diffMinBlobArea,
    }
  }

  /** Budżet YOLO: backoff po awariach, globalny odstęp, limit N/min per kamera. */
  private canCallYolo(deviceId: string): boolean {
    const now = Date.now()
    if (now < this.yoloBackoffUntil) return false
    if (now - this.lastYoloGlobalTs < this.yoloMinGapMs) return false
    const calls = (this.yoloCallLog.get(deviceId) ?? []).filter((t) => now - t < 60_000)
    this.yoloCallLog.set(deviceId, calls)
    return calls.length < this.maxYoloPerCamPerMin
  }

  private noteYoloCall(deviceId: string): void {
    const now = Date.now()
    this.lastYoloGlobalTs = now
    this.lastYoloPerCam.set(deviceId, now)
    const calls = this.yoloCallLog.get(deviceId) ?? []
    calls.push(now)
    this.yoloCallLog.set(deviceId, calls)
  }

  /** Exponential backoff po awarii YOLO: 15s → 30s → … → 300s cap. */
  private registerYoloFailure(): void {
    this.yoloConsecFailures++
    const backoffMs = Math.min(15_000 * 2 ** (this.yoloConsecFailures - 1), 300_000)
    this.yoloBackoffUntil = Date.now() + backoffMs
    this.logger.warn(
      `YOLO failure #${this.yoloConsecFailures} — backoff ${Math.round(backoffMs / 1000)}s`,
    )
  }

  private registerYoloSuccess(): void {
    this.yoloConsecFailures = 0
    this.yoloBackoffUntil = 0
  }

  /**
   * Diagnostyka skuteczności progów (wymaganie F) — jedna zwięzła linia
   * per kamera co 5 min, potem reset liczników.
   */
  @Interval(5 * 60_000)
  logSamplingStats(): void {
    if (!this.samplingEnabled || this.camStats.size === 0) return
    for (const [deviceId, s] of this.camStats) {
      this.logger.log(
        `Vision gate ${deviceId.slice(0, 8)}…: samples=${s.samples} fetch_fail=${s.fetchFail} ` +
          `gate_rejected=${s.gateRejected} gate_passed=${s.gatePassed} yolo=${s.yoloCalls} ` +
          `budget_skip=${s.budgetSkipped} saved=${s.saved} (5min)`,
      )
    }
    this.camStats.clear()
  }

  /**
   * Keepalive/fallback tick (60s) — PODŁOGA zachowania sprzed 2026-07-03.
   * Kamery bez pełnej analizy w ostatniej minucie (diff-gate nie triggerował
   * albo budżet je pominął) dostają pełny cykl jak dotąd. Gdy sampling
   * wyłączony (VISION_SAMPLING_ENABLED=false) — zachowanie identyczne
   * jak przed zmianą.
   */
  @Interval(60_000)
  async runCycle(): Promise<void> {
    if (!this.resolveActiveEngine()?.enabled) return
    if (this.inProgress) {
      this.logger.debug('Previous run still in progress — skipping tick')
      return
    }
    this.inProgress = true
    try {
      const cameras = this.listCameras()
      if (cameras.length === 0) {
        this.logger.debug('No cameras registered — nothing to detect')
        return
      }

      const cycleStart = Date.now()
      const now = Date.now()
      let detected = 0
      let failed = 0
      let skippedFresh = 0

      for (const cam of cameras) {
        // Diff-gate/LPR-trigger już analizował tę kamerę w tej minucie —
        // nie dublujemy obciążenia M1.
        const lastAnalysis = this.lastYoloPerCam.get(cam.deviceId) ?? 0
        if (this.samplingEnabled && now - lastAnalysis < VisionDetectService.KEEPALIVE_SKIP_MS) {
          skippedFresh++
          continue
        }
        // Backoff po awariach YOLO obowiązuje też keepalive.
        if (Date.now() < this.yoloBackoffUntil) {
          skippedFresh++
          continue
        }
        // Globalny minimalny odstęp między wywołaniami YOLO (ochrona M1).
        const gapLeft = this.yoloMinGapMs - (Date.now() - this.lastYoloGlobalTs)
        if (gapLeft > 0) await new Promise((r) => setTimeout(r, gapLeft))
        try {
          const ok = await this.runOne(cam.deviceId, cam.config)
          if (ok) detected++
          else failed++
        } catch (err: any) {
          failed++
          this.logger.warn(`Vision run failed for ${cam.deviceId}: ${err?.message ?? err}`)
        }
      }

      const wallMs = Date.now() - cycleStart
      this.logger.log(
        `Vision cycle done: ${detected}/${cameras.length} ok, ${failed} failed, ` +
          `${skippedFresh} fresh-skipped, wall=${wallMs}ms`,
      )
    } finally {
      this.inProgress = false
    }
  }

  /**
   * All registered camera-type devices from sqlite (CAMERA + LPR_CAMERA),
   * z których VisionDetectService ma robić AI snapshot+detect.
   *
   * FAZA 8.h (2026-06-03) filter: `aiAnalysisEnabled` per-camera flag z
   * `device_config.ai_analysis_enabled`. Default ON (kolumna DEFAULT 1),
   * więc istniejące Edge bez CAMERA_CONFIG_UPDATE-u zachowują się jak
   * przed 8.h. UI Integratora pozwala wyłączyć per-kamerę bez kasowania
   * wpisu — np. zwykła CCTV w piwnicy która nie potrzebuje YOLO.
   */
  private listCameras(): { deviceId: string; type: string; config: VisionCameraConfig }[] {
    return this.store
      .getDeviceConfigs()
      // Domofon też ma kamerę. Gdy ma włączone rozpoznawanie tekstu/tablic,
      // wchodzi do pętli próbkowania na równi z kamerami (zgłoszenie Konrada
      // 2026-08-07: kaseta Akuvox 192.168.1.89 ma czytać tablice i napisy).
      .filter((c) =>
        c.type === 'CAMERA' || c.type === 'LPR_CAMERA' ||
        ((c.config as any)?.ocrEnabled === true),
      )
      // AI OFF wyłącza tylko analizę obrazu przez YOLO — lokalne OCR jest
      // niezależne i ma własny przełącznik.
      .filter((c) => c.aiAnalysisEnabled !== false || (c.config as any)?.ocrEnabled === true)
      .map((c) => ({
        deviceId: c.deviceId,
        type: c.type,
        config: c.config as unknown as VisionCameraConfig,
      }))
      .filter((c) => c.config && typeof c.config.ipAddress === 'string')
  }

  /**
   * Fetch snapshot → POST to YOLO → persist row. Returns true on success
   * (even when zero detections — empty summary is a valid datapoint).
   */
  private async runOne(deviceId: string, config: VisionCameraConfig): Promise<boolean> {
    const snapshot = await this.fetchSnapshot(deviceId, config)
    if (!snapshot) return false
    return this.analyzeSnapshot(deviceId, snapshot)
  }

  /**
   * Filtr detekcji po YOLO (2026-07-03) — domyka „liść/ptak":
   *   • klasa `bird` wycinana zawsze,
   *   • detekcje z conf < VISION_MIN_CONF wycinane,
   *   • bbox mniejszy niż VISION_MIN_BBOX_PCT % powierzchni kadru wycinany
   *     (skalowane do rozdzielczości — odległy ptak/liść to <0.3% kadru).
   * Summary jest przeliczane z przefiltrowanych detekcji, więc cała dalsza
   * logika notable/dedup działa na czystych danych. Brand/waste/pose/text_raw
   * z YOLO service zostają nietknięte (spread).
   */
  private filterYoloOutput(yolo: YoloResponse): YoloResponse {
    const imgW = Array.isArray(yolo.image_size) ? Number(yolo.image_size[0]) : 0
    const imgH = Array.isArray(yolo.image_size) ? Number(yolo.image_size[1]) : 0
    const minArea = imgW > 0 && imgH > 0 ? (imgW * imgH * this.minBboxAreaPct) / 100 : 0
    const detections = yolo.detections.filter((d) => {
      if (IGNORED_CLASSES.has(d.class)) return false
      if (d.conf < this.minDetectionConf) return false
      if (minArea > 0 && Array.isArray(d.bbox) && d.bbox.length === 4) {
        const area = d.bbox[2] * d.bbox[3]
        if (area < minArea) return false
      }
      return true
    })
    const summary: Record<string, number> = {}
    for (const d of detections) summary[d.class] = (summary[d.class] ?? 0) + 1
    return { ...yolo, detections, summary }
  }

  /**
   * Core analiza: YOLO → filtr klas → decyzja notable → persist row + JPEG.
   * Wywoływana z trzech torów: sampling diff-gate (snapshot już pobrany),
   * keepalive runCycle i LPR-trigger (oba przez runOne). Rejestruje budżet
   * YOLO (noteYoloCall) i backoff po awariach.
   */
  private async analyzeSnapshot(deviceId: string, snapshot: Buffer): Promise<boolean> {
    const ts = Date.now()
    this.noteYoloCall(deviceId)
    this.statFor(deviceId).yoloCalls++

    const yoloRaw = await this.callYolo(snapshot, deviceId)
    if (!yoloRaw) {
      this.registerYoloFailure()
      return false
    }
    this.registerYoloSuccess()
    const yolo = this.filterYoloOutput(yoloRaw)

    // Brand detection (optional — present when YOLO service ran EasyOCR).
    // Normalize null/undefined → null for sqlite; store text_raw as JSON-string
    // so we can decode it later from the AI prototype for debug.
    const brandDetected = yolo.brand_detected ?? null
    const brandConf = typeof yolo.brand_conf === 'number' ? yolo.brand_conf : null
    const textRaw = Array.isArray(yolo.text_raw) && yolo.text_raw.length > 0
      ? JSON.stringify(yolo.text_raw)
      : null

    // Waste-truck detection (2026-05-19). Same OCR pass jako brand.
    const wasteCategory = yolo.waste_category ?? null
    const wasteConf = typeof yolo.waste_conf === 'number' ? yolo.waste_conf : null
    const wasteOperator = yolo.waste_operator ?? null

    // ── Atrybuty pojazdu z VLM (2026-08-14) ─────────────────────────────
    // kind/make/color głównego pojazdu. Gdy VLM mówi co innego niż klasa
    // COCO (np. osobowy, a YOLO dał truck), KORYGUJEMY summary o 1 sztukę —
    // to leczy „każde auto jako ciężarówka" w kafelkach i statystykach.
    // Korekta dotyczy tylko głównego (największego) pojazdu; reszta klatki
    // zostaje po staremu.
    const vehicleAttrs = yolo.vehicle_attrs ?? null
    const vehicleKind = vehicleAttrs?.kind ?? null
    const vehicleMake = vehicleAttrs?.make ?? null
    const vehicleColor = vehicleAttrs?.color ?? null
    if (vehicleAttrs) {
      const kindToCoco: Record<string, string> = {
        osobowy: 'car', dostawczy: 'truck', ciezarowka: 'truck',
        maszyna: 'truck', bus: 'bus',
      }
      const corrected = kindToCoco[vehicleAttrs.kind]
      const from = vehicleAttrs.yolo_class
      if (corrected && corrected !== from && (yolo.summary[from] ?? 0) > 0) {
        yolo.summary[from] -= 1
        if (yolo.summary[from] <= 0) delete yolo.summary[from]
        yolo.summary[corrected] = (yolo.summary[corrected] ?? 0) + 1
        this.logger.log(
          `Vision ${deviceId.slice(0, 8)}…: VLM korekta klasy ${from}→${corrected} ` +
            `(kind=${vehicleAttrs.kind}${vehicleMake ? `, ${vehicleMake}` : ''}` +
            `${vehicleColor ? `, ${vehicleColor}` : ''})`,
        )
      }
    }

    // ── Fall detection (2026-05-23, hardening 2026-07-05) ────────────────
    // yolo-vision potwierdza upadek dopiero po PERSYSTENCJI (>= N klatek-
    // kandydatów w oknie). Gdy klatka jest kandydatem ale jeszcze nie
    // potwierdzona — planujemy szybki re-check tej kamery (default 6s),
    // żeby potwierdzenie/odrzucenie przyszło w kilkanaście sekund zamiast
    // czekać na 60s keepalive.
    const fallLikelihood = yolo.pose?.max_likelihood ?? null
    const fallDetected = !!yolo.pose?.fall_detected
    const fallCandidate = !!yolo.pose?.fall_candidate
    if (fallCandidate && !fallDetected) {
      this.logger.warn(
        `Fall CANDIDATE on camera ${deviceId.slice(0, 8)}… ` +
          `likelihood=${fallLikelihood?.toFixed(2)} streak=${yolo.pose?.fall_streak ?? '?'} — scheduling re-check`,
      )
      this.scheduleFallRecheck(deviceId)
    }
    const anomalyType = fallDetected ? 'FALL' : null
    // Collect indicators z wszystkich persons — JSON array unique values
    const anomalyIndicators: string | null = fallDetected
      ? JSON.stringify(
          Array.from(
            new Set((yolo.pose?.details ?? []).flatMap((d) => d.indicators)),
          ),
        )
      : null
    if (fallDetected) {
      this.logger.warn(
        `🚨 FALL DETECTED on camera ${deviceId.slice(0, 8)}… ` +
          `likelihood=${fallLikelihood?.toFixed(2)} ` +
          `persons=${yolo.pose?.persons} indicators=${anomalyIndicators}`,
      )
    }

    // ── Decyzja czy zapisać do bazy (2026-05-23-v2) ─────────────────────
    //
    // Polityka „znacząca zmiana, nie ciągłe spam":
    //
    // 1. Vision NADAL pollue co 60s — żeby łapać piesze/zwierzęta bez plate.
    // 2. ALE row w bazie + JPEG zapisywany TYLKO gdy STANIE SIĘ COŚ NOWEGO:
    //    a) brand_detected lub waste_category (kurier/śmieciarka — zawsze
    //       interesujące, nawet gdyby ten sam minutę temu)
    //    b) zmiana set-u notable klas vs ostatnio zapisanego (np. było
    //       {person}, teraz {person,dog} — pies doszedł!)
    //    c) keepalive: >10min minęło od ostatniego save mimo tej samej
    //       kompozycji (operator widzi że kamera żyje)
    //
    // Krytyczne: decyzja PRZED persistFrame, bo inaczej zapisujemy plik
    // na dysk za każdym tickiem (mimo skip-insertu) → odpadek miejsca.
    // 2026-07-03 — „samochód z napisem" / „osoba z napisem": znaczący tekst
    // OCR (po odfiltrowaniu OSD overlay) na klatce z car/truck/bus/person
    // wymusza notable nawet gdy brand_matcher nic nie dopasował. Wymóg
    // właściciela: tekst ląduje w text_raw + klatka w JPEG. Marker `+text`
    // w composition key → pojawienie się napisu = nowa kompozycja = zapis,
    // ale ten sam napis stojący w kadrze podlega normalnemu dedup/keepalive.
    const ocrTokens = meaningfulOcrTokens(yolo.text_raw)
    const hasSubjectText =
      ocrTokens.length > 0 &&
      Object.keys(yolo.summary).some((c) => TEXT_SUBJECT_CLASSES.has(c))

    const isNotable =
      Object.keys(yolo.summary).some((c) => NOTABLE_CLASSES.has(c)) || hasSubjectText
    // ── Korelacja z rejestrem tablic (2026-08-15) ───────────────────────
    // Gdy OCR wizji złapie tablicę ZNANĄ osiedlu (pojazd z rejestru albo
    // aktywny gość z whitelisty), oznaczamy detekcję i wymuszamy zapis
    // klatki — „coś zapisanego w osiedlu pojawiło się w kadrze" jest zawsze
    // warte uwagi, nawet na kamerze nie-LPR (portiernia, brama pożarowa).
    let plateMatched: string | null = null
    let plateMatchLabel: string | null = null
    for (const cand of (yolo.plate_candidates ?? []).slice(0, 3)) {
      const norm = String(cand?.plate ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      if (norm.length < 5) continue
      const info = this.store.plateInfoAnyCamera(norm)
      if (!info) continue
      plateMatched = norm
      plateMatchLabel = this.plateRegistryLabel(info)
      this.logger.log(
        `Vision ${deviceId.slice(0, 8)}…: 📋 tablica z rejestru w kadrze: ` +
          `${norm} (${plateMatchLabel})`,
      )
      break
    }

    const hasBrandOrWaste = !!brandDetected || !!wasteCategory || !!plateMatched
    const currentNotable =
      Object
        .keys(yolo.summary)
        .filter((c) => NOTABLE_CLASSES.has(c))
        .sort()
        .join(',') + (hasSubjectText ? '+text' : '')

    // 2026-05-23: anomaly (fall) ZAWSZE bypassuje dedup — upadek to priorytet.
    // Każda klatka z `fallDetected` zapisana niezależnie od composition match.
    if (!hasBrandOrWaste && !isNotable && !fallDetected) {
      // Klatka bez niczego ciekawego — skip całkowicie (no JPEG, no row).
      this.logger.debug(
        `Vision ${deviceId.slice(0, 8)}…: skip non-notable (${Object.keys(yolo.summary).join(',') || 'empty'})`,
      )
      return true
    }

    if (!hasBrandOrWaste && !fallDetected) {
      // Mamy notable composition (no brand/waste, no fall) — sprawdź dedup
      // vs last save. Gdy fall_detected, ten branch jest skipnięty.
      const last = this.lastSavedState.get(deviceId)
      const now = Date.now()
      const sameComposition = last && last.notable === currentNotable
      const timeSinceLastSave = last ? now - last.savedTs : Infinity

      if (sameComposition && timeSinceLastSave < VisionDetectService.NOTABLE_KEEPALIVE_MS) {
        this.logger.debug(
          `Vision ${deviceId.slice(0, 8)}…: skip duplicate (${currentNotable}, ${Math.round(timeSinceLastSave / 1000)}s since last save)`,
        )
        return true
      }
      // Else: nowa kompozycja LUB keepalive → fall through do insertu.
    }

    // Decyzja POZYTYWNA — zapisuj. JPEG dla notable / brand-waste / anomaly.
    // 2026-07-05: dla POTWIERDZONEGO upadku yolo-vision zwraca wariant
    // z narysowaną czerwoną ramką „UPADEK" — zapisujemy TEN obraz (panel
    // i push widzą ramkę). Fallback do surowego snapshotu gdy pole puste
    // (starszy yolo-vision / błąd adnotacji).
    let imagePath: string | null = null
    if (isNotable || hasBrandOrWaste || fallDetected) {
      let frameToSave = snapshot
      if (fallDetected && yolo.pose?.annotated_image_b64) {
        try {
          const annotated = Buffer.from(yolo.pose.annotated_image_b64, 'base64')
          // JPEG magic sanity — nie zapisujemy śmieci gdy base64 uszkodzony.
          if (annotated.length > 1000 && annotated[0] === 0xff && annotated[1] === 0xd8) {
            frameToSave = annotated
          }
        } catch {
          /* fallback: surowy snapshot */
        }
      }
      imagePath = this.persistFrame(frameToSave, ts, deviceId)
    }

    try {
      this.store.visionInsertDetection({
        cameraDeviceId: deviceId,
        ts,
        inferenceMs: Math.round(yolo.inference_ms),
        summary: JSON.stringify(yolo.summary),
        detectionsJson: JSON.stringify(yolo.detections),
        imagePath,
        brandDetected,
        brandConf,
        textRaw,
        wasteCategory,
        wasteConf,
        wasteOperator,
        vehicleKind,
        vehicleMake,
        vehicleColor,
        plateMatched,
        plateMatchLabel,
        anomalyType,
        fallLikelihood,
        anomalyIndicators,
      })
      this.statFor(deviceId).saved++
      // Update lastSavedState — pamiętamy notable composition + ts ostatniego
      // ZAPISU, żeby kolejne identyczne kompozycje (ta sama osoba siedzi
      // w polu kamery) skipnęły aż do keepalive.
      if (currentNotable !== '') {
        this.lastSavedState.set(deviceId, { notable: currentNotable, savedTs: ts })
      }

      // 2026-05-24 — Fall detection Etap 3. Po success persist, emit do Cloud
      // przez tunnel. Cloud `EdgeGateway` → `AnomalyEventsService.recordFromEdge`
      // → persyst + push do BA/Konsjerża + opt-in mieszkańców.
      // Gdy WS down — tunnelSend zwraca false; wpisujemy do `event_queue`
      // żeby `SyncService.flush()` doślał po reconnect (LPR robi tak samo).
      if (fallDetected && anomalyType) {
        const payload = {
          cameraDeviceId: deviceId,
          ts,
          anomalyType,
          likelihood: fallLikelihood,
          indicators: anomalyIndicators ? JSON.parse(anomalyIndicators) : [],
          imageFilename: imagePath ? imagePath.split('/').pop() : null,
        }
        const delivered = this.tunnelSend?.('ANOMALY_DETECTED', payload, deviceId) ?? false
        if (!delivered) {
          // event_queue jest LPR-centric ale przyjmuje dowolny payload — Cloud
          // EdgeGateway routuje po `event` field z `EVT { event }` envelope.
          try {
            this.store.enqueue('ANOMALY_DETECTED', { ...payload, deviceId })
            this.logger.log(
              `ANOMALY_DETECTED queued (WS down) for cam ${deviceId.slice(0, 8)}…`,
            )
          } catch (qerr: any) {
            this.logger.warn(`Failed to enqueue ANOMALY_DETECTED: ${qerr?.message}`)
          }
        } else {
          this.logger.log(
            `ANOMALY_DETECTED sent to Cloud — cam ${deviceId.slice(0, 8)}… ` +
            `likelihood=${fallLikelihood?.toFixed(2)}`,
          )
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to persist vision detection for ${deviceId}: ${err?.message}`)
      return false
    }

    // Telemetry log — keep it compact, only mention non-zero summary + brand
    // + waste. The waste line is rare (1-2x/dzień per camera) so always
    // worth logging fully.
    const summaryStr = Object.entries(yolo.summary)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    const brandStr = brandDetected
      ? ` brand=${brandDetected}(${brandConf?.toFixed(2)})`
      : ''
    const wasteStr = wasteCategory
      ? ` waste=${wasteCategory}(${wasteConf?.toFixed(2)})${wasteOperator ? `/${wasteOperator}` : ''}`
      : wasteOperator
      ? ` waste_op=${wasteOperator}`
      : ''
    const ocrStr = typeof yolo.ocr_ms === 'number' && yolo.ocr_ms > 0
      ? ` ocr=${Math.round(yolo.ocr_ms)}ms`
      : ''
    // 2026-07-03: napis bez brand-matchu też jest logowany (max 3 tokeny).
    const textStr = hasSubjectText && !brandDetected
      ? ` text=[${ocrTokens.slice(0, 3).join('|')}]`
      : ''
    this.logger.log(
      `Vision ${deviceId}: ${summaryStr || '(empty)'}${brandStr}${wasteStr}${textStr} ` +
        `inf=${yolo.inference_ms}ms${ocrStr}` +
        (imagePath ? ` saved=${imagePath}` : ''),
    )
    return true
  }

  /**
   * Pull a JPEG from the camera using digest auth. Tries the same Hikvision
   * paths as `cameras.service.ts:buildSnapshotUrls`. Returns raw bytes or
   * null on failure (logged warn, not thrown — one bad camera shouldn't
   * abort the whole cycle).
   */
  private async fetchSnapshot(
    deviceId: string,
    config: VisionCameraConfig,
  ): Promise<Buffer | null> {
    const urls = this.buildSnapshotUrls(config)
    const user = config.login && config.login.trim().length > 0 ? config.login : 'admin'
    const errors: string[] = []

    for (const url of urls) {
      try {
        const res = await requestWithDigest('GET', url, user, config.password, {
          responseType: 'arraybuffer',
          timeout: 6000,
          httpsAgent,
          validateStatus: (s: number) => s === 200,
        })
        const buf = Buffer.from(res.data as ArrayBuffer)
        // JPEG magic + min size check (matches LPR service heuristic).
        if (buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) {
          errors.push(`${url} → ${buf.length}B, magic=${buf[0]?.toString(16)},${buf[1]?.toString(16)}`)
          continue
        }
        return buf
      } catch (err: any) {
        errors.push(`${url} → ${err?.response?.status ?? err?.code ?? err?.message ?? 'ERR'}`)
      }
    }
    this.logger.debug(`Snapshot fetch failed for ${deviceId}: ${errors.join(' | ')}`)
    return null
  }

  private buildSnapshotUrls(config: VisionCameraConfig): string[] {
    const ip = config.ipAddress
    const port = config.httpPort ? `:${config.httpPort}` : ''
    const m = (config.manufacturer ?? '').toLowerCase()

    if (m.includes('hikvision')) {
      // Same scheme as cameras.service.ts: 1 → 101 (channel, main stream).
      const raw = config.channel ?? 101
      const streamId = raw < 100 ? raw * 100 + 1 : raw
      const subId = raw < 100 ? raw * 100 + 2 : streamId % 100 === 1 ? streamId + 1 : streamId
      return [
        `http://${ip}${port}/ISAPI/Streaming/channels/${streamId}/picture`,
        `http://${ip}${port}/ISAPI/Streaming/channels/${subId}/picture`,
      ]
    }
    if (m.includes('dahua')) {
      const ch = config.channel ?? 1
      return [`http://${ip}${port}/cgi-bin/snapshot.cgi?channel=${ch}`]
    }
    if (m.includes('akuvox')) {
      // Kaseta Akuvox oddaje obraz na WŁASNYM porcie 8080 i po HTTP —
      // nie pod `httpPort` (443) i nie po HTTPS. Zweryfikowane na VN
      // 2026-08-07: `http://<ip>:8080/picture.jpg` → 430 KB, HTTPS na tym
      // porcie w ogóle nie odpowiada. Bez tego przypadku domofon z włączonym
      // rozpoznawaniem tekstu nigdy nie dostałby klatki do analizy.
      const mjpegPort = (config as any).mjpegPort ?? 8080
      return [
        `http://${ip}:${mjpegPort}/picture.jpg`,
        `https://${ip}:${mjpegPort}/picture.jpg`,
      ]
    }
    // Generic fallback path — works for some IP cams, harmless if 404.
    return [`http://${ip}${port}/snapshot.jpg`]
  }

  /**
   * POST base64 image to YOLO /detect. Returns parsed body or null on
   * any error (network, non-200, parse). MacBook can be off / restarting
   * during a maintenance window — we accept that gracefully.
   */
  private async callYolo(image: Buffer, cameraDeviceId?: string): Promise<YoloResponse | null> {
    const engine = this.resolveActiveEngine()
    if (!engine) {
      this.logger.debug('callYolo: no active engine configured — skip')
      return null
    }
    const yoloUrl = engine.url
    try {
      const res = await axios.post<YoloResponse>(
        `${yoloUrl}/detect`,
        {
          image_base64: image.toString('base64'),
          // Run EasyOCR after YOLO on truck/bus/car/person crops to extract
          // courier wordmarks. Service-side skips OCR for crops <100×100px
          // (POC: those return 0 hits anyway). Latency budget ~500ms extra.
          with_brand: this.brandEnabled,
          // 2026-05-23: pose estimation (YOLOv8-pose) + fall heuristic na
          // każdej klatce z person. Yolo-vision service sam skipuje gdy
          // `summary.person == 0` — koszt 0 latency dla klatek bez osoby.
          // Gdy person obecny: ~50-150ms extra na M1 Max (warm).
          with_pose: this.brandEnabled,
          // 2026-07-05: per-camera persystencja fall-detection po stronie
          // yolo-vision (>= N kandydatów w oknie). Starszy yolo-vision
          // ignoruje nieznane pole — backwards-compatible.
          camera_id: cameraDeviceId,
        },
        {
          timeout: this.requestTimeoutMs,
          // YOLO service is HTTP, LAN — no special agent.
          validateStatus: (s) => s === 200,
          // Cap response size defensively; a full detections list is small.
          maxContentLength: 5 * 1024 * 1024,
          maxBodyLength: 8 * 1024 * 1024,
        },
      )
      if (!res.data || typeof res.data !== 'object') return null
      // Light shape check — guard against accidental schema drift.
      const r = res.data
      if (!Array.isArray(r.detections) || typeof r.summary !== 'object') return null
      return r
    } catch (err: any) {
      this.logger.warn(
        `YOLO call failed (${yoloUrl}): ${err?.response?.status ?? err?.code ?? err?.message}`,
      )
      return null
    }
  }

  /**
   * Save the JPEG to `<data>/vision-frames/<ts>_<deviceId>.jpg`. Same naming
   * convention as LPR snapshots — `<ts>_…` lets the retention sweep find
   * old files by parsing the prefix instead of relying on mtime.
   */
  /**
   * Czytelna etykieta wpisu z rejestru tablic (2026-08-15) — bez PII
   * mieszkańca: `owner` w lpr_plates jest już oczyszczony przy syncu
   * (serviceName albo pusty; goście mają jawnie „Gość X (zapraszający)").
   */
  private plateRegistryLabel(info: {
    owner: string | null
    unitLabel: string | null
    kind: string | null
    guestId: number | null
  }): string {
    const kindLabels: Record<string, string> = {
      RESIDENT: 'pojazd osiedla',
      SERVICE: 'pojazd serwisowy',
      DELIVERY: 'dostawca',
      EMERGENCY: 'służby',
    }
    const isGuest = info.guestId != null || info.kind === 'GUEST'
    const head = isGuest
      ? (info.owner || 'gość')
      : (info.owner || kindLabels[info.kind ?? ''] || 'w rejestrze osiedla')
    return [head, info.unitLabel].filter(Boolean).join(' · ')
  }

  private persistFrame(image: Buffer, ts: number, deviceId: string): string | null {
    try {
      const safeId = deviceId.replace(/[^A-Za-z0-9._-]/g, '_')
      const filename = `${ts}_${safeId}.jpg`
      const full = path.join(this.store.visionFramesDir(), filename)
      fs.writeFileSync(full, image)
      return filename
    } catch (err: any) {
      this.logger.warn(`Frame save failed for ${deviceId}: ${err?.message}`)
      return null
    }
  }

  // ── Retention (24h cadence) ────────────────────────────────────────────
  /**
   * Drop rows + frames older than 7 days. Aligned with the spec — short
   * window because vision history isn't audit-grade (LPR reads are 30d).
   * Runs every 24h; alignment-free, fires immediately after the first
   * 24h after boot (good enough — first sweep just doesn't have anything
   * to remove).
   */
  @Interval(24 * 60 * 60 * 1000)
  retentionSweep(): void {
    // Retention sweep biegnie nawet gdy AI Engine wyłączony — bo historia z
    // okresów aktywności (np. tymczasowo) musi się czyścić niezależnie od
    // aktualnego stanu konfiguracji.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    try {
      const rows = this.store.visionSweepOld(cutoff)
      if (rows > 0) {
        this.logger.log(`Vision retention: removed ${rows} row(s) older than 7 days`)
      }
    } catch (err: any) {
      this.logger.warn(`Vision retention DB sweep failed: ${err?.message}`)
    }
    // File cleanup — by-prefix, same as LPR (`<ts>_<deviceId>.jpg`).
    try {
      const dir = this.store.visionFramesDir()
      let deleted = 0
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(\d+)_/)
        if (!m) continue
        if (Number(m[1]) < cutoff) {
          try {
            fs.unlinkSync(path.join(dir, f))
            deleted++
          } catch {
            /* ignore per-file errors */
          }
        }
      }
      if (deleted > 0) this.logger.log(`Vision frames retention: removed ${deleted} file(s)`)
    } catch (err: any) {
      this.logger.warn(`Vision frames sweep failed: ${err?.message}`)
    }
  }
}
