import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common'
import type { Response } from 'express'
import * as fs from 'fs'
import * as path from 'path'
import { StoreService } from '../../store/store.service'

/**
 * Vision detections REST API (read-only).
 *
 * Konsumowane przez Cloud Building Admin proxy (`/api/building-admin/.../vision/*`)
 * a docelowo też przez panel webowy Edge (`/ui` SPA). Zwraca rekordy z
 * `vision_detections` (zapisywane przez `VisionDetectService` co 60s) +
 * serwuje persisted klatki JPEG z `data/vision-frames/`.
 *
 * Wszystkie endpointy: read-only. Brak side effects (poza static file read).
 * Dane przeterminowane (>7 dni) sweep'uje retencja w `VisionDetectService`.
 */
/**
 * 2026-07-05 — kamera oddaje snapshoty main-stream ~600-950KB. Panel BA
 * ładuje do 50 miniatur RÓWNOLEGLE przez Cloud proxy (Fly → Tailscale →
 * Edge) z 10s timeoutem per request — przy pełnych klatkach agregat
 * ~45MB nie mieści się w timeoucie i KAŻDA miniatura kończy jako 502.
 * Fix: /vision/frame serwuje obraz przeskalowany (sharp) do max szerokości
 * VISION_FRAME_MAX_WIDTH (default 1280 → ~100-200KB). Pełny oryginał:
 * `?full=1`. Miniatury mogą prosić mniejszy wariant: `?w=320`.
 */
const FRAME_MAX_WIDTH = (() => {
  const raw = Number(process.env.VISION_FRAME_MAX_WIDTH)
  if (!Number.isFinite(raw)) return 1280
  return Math.min(4096, Math.max(0, Math.round(raw))) // 0 = bez skalowania
})()
const FRAME_JPEG_QUALITY = (() => {
  const raw = Number(process.env.VISION_FRAME_JPEG_QUALITY)
  if (!Number.isFinite(raw)) return 78
  return Math.min(95, Math.max(40, Math.round(raw)))
})()

@Controller('vision')
export class VisionDetectController {
  constructor(private store: StoreService) {}

  /** sharp lazy-load (wzorzec z vision-detect.service.ts) — gdy niedostępny,
   *  serwujemy oryginał (stare zachowanie). */
  private sharpMod: any | null = null
  private sharpUnavailable = false
  private async getSharp(): Promise<any | null> {
    if (this.sharpUnavailable) return null
    if (this.sharpMod) return this.sharpMod
    try {
      const modName = 'sharp'
      const mod: any = await import(modName)
      this.sharpMod = mod?.default ?? mod
      return this.sharpMod
    } catch {
      this.sharpUnavailable = true
      return null
    }
  }

  /**
   * Lista detekcji w oknie czasowym + opcjonalne filtry.
   *
   *   GET /vision/detections?since_hours=24&camera_id=...&class=person&limit=100
   *
   * Default `since_hours=24`, default `limit=100`, cap 500.
   * `class` może być powtórzony (`?class=person&class=dog`) lub przyjść jako
   * lista po przecinku (`?class=person,dog`) — oba akceptowane.
   */
  @Get('detections')
  listDetections(
    @Query('since_hours') sinceHoursRaw?: string,
    @Query('camera_id') cameraId?: string,
    @Query('class') classRaw?: string | string[],
    @Query('limit') limitRaw?: string,
    @Query('with_image') withImage?: string,
    @Query('q') textQueryRaw?: string,
    @Query('since_ts') sinceTsRaw?: string,
    @Query('until_ts') untilTsRaw?: string,
    @Query('before_ts') beforeTsRaw?: string,
  ) {
    const sinceHours = clampNum(Number(sinceHoursRaw ?? 24), 1, 24 * 30, 24)
    const limit = clampNum(Number(limitRaw ?? 100), 1, 500, 100)
    // 2026-08-15 — wyszukiwanie tekstowe (`q`) bez jawnego okna przeszukuje
    // CAŁĄ historię. 2026-08-21 — jawne since_ts/until_ts (epoch ms, własny
    // zakres dat z panelu) wygrywają z since_hours; before_ts = kursor
    // keyset-paginacji przy nieskończonym przewijaniu (ts < before_ts).
    const textQuery = (textQueryRaw ?? '').trim().slice(0, 80) || undefined
    const sinceTs = Number(sinceTsRaw)
    const untilTs = Number(untilTsRaw)
    const beforeTs = Number(beforeTsRaw)
    let sinceMs: number | undefined
    if (Number.isFinite(sinceTs) && sinceTs > 0) {
      sinceMs = sinceTs
    } else if (textQuery && sinceHoursRaw == null) {
      sinceMs = undefined
    } else {
      sinceMs = Date.now() - sinceHours * 60 * 60 * 1000
    }
    const untilCandidates = [untilTs, beforeTs].filter((n) => Number.isFinite(n) && n > 0)
    const untilMs = untilCandidates.length > 0 ? Math.min(...untilCandidates) : undefined

    // `class` flatten + sanitize. Class names are COCO (alphanumeric + '_').
    const classes = flattenClasses(classRaw)
      .filter((c) => /^[a-z][a-z0-9_]*$/i.test(c))
      .map((c) => c.toLowerCase())

    const rows = this.store.visionListRecent({
      sinceMs,
      untilMs,
      cameraDeviceId: cameraId || undefined,
      classes: classes.length > 0 ? classes : undefined,
      limit,
      textQuery,
    })

    // Filtr „tylko z klatkami" — robimy lokalnie żeby nie komplikować helpera w store.
    const filtered = withImage === '1' || withImage === 'true'
      ? rows.filter((r) => r.imagePath != null)
      : rows

    // Wzbogać o sparsowany `summary` (UI nie musi JSON.parse-ować).
    const detections = filtered.map((r) => ({
      id: r.id,
      cameraDeviceId: r.cameraDeviceId,
      ts: r.ts,
      inferenceMs: r.inferenceMs,
      summary: safeParseSummary(r.summary),
      imagePath: r.imagePath,
      // 2026-05-22: LLM-generated narrative + badges dla brand/waste.
      // llmSummary jest NULL gdy frame nie notable albo summarizer jeszcze
      // nie wygenerował (cron co 30s) — UI pokaże skeleton/placeholder.
      llmSummary: r.llmSummary,
      brandDetected: r.brandDetected,
      wasteCategory: r.wasteCategory,
      // 2026-05-23: fall detection — BA Vision page pokazuje red badge
      // gdy `anomalyType=FALL`. UI może też wyrenderować likelihood %.
      anomalyType: r.anomalyType,
      fallLikelihood: r.fallLikelihood,
      // FAZA 8.h.4 (2026-06-05) — wszystkie OCR tokeny z EasyOCR. Persist
      // istnieje od początku, ale dotąd nie był zwracany w API. UI BA Vision
      // page pokazuje chips per detection + obsługuje search filter.
      // Parsujemy JSON tu (a nie w UI) żeby front nie musiał JSON.parse-ować
      // raz dla każdej detekcji.
      textRaw: parseTextRaw(r.textRaw),
      // 2026-08-14 — atrybuty pojazdu z VLM: typ semantyczny + marka + kolor.
      vehicleKind: r.vehicleKind,
      vehicleMake: r.vehicleMake,
      vehicleColor: r.vehicleColor,
      // 2026-08-15 — korelacja z rejestrem tablic osiedla.
      plateMatched: r.plateMatched,
      plateMatchLabel: r.plateMatchLabel,
    }))

    return { detections, total: detections.length, sinceMs, sinceHours }
  }

  /**
   * Agregaty per kamera i per klasa w oknie czasowym.
   *   GET /vision/stats?since_hours=24
   * Wynik: { byCamera: {<cam>: {person:N,car:M,...}}, byClass: {...}, totalFrames }
   */
  @Get('stats')
  stats(@Query('since_hours') sinceHoursRaw?: string) {
    const sinceHours = clampNum(Number(sinceHoursRaw ?? 24), 1, 24 * 30, 24)
    const sinceMs = Date.now() - sinceHours * 60 * 60 * 1000

    // Pobieramy wszystkie row-y w oknie (max 500) i pivot-ujemy w pamięci —
    // wolumeny są małe (3 kamery × 60 framów/h × 24h = 4320 row), a
    // visionCountByClass nie rozbija per-camera, więc musimy zrobić to sami.
    const rows = this.store.visionListRecent({ sinceMs, limit: 500 })
    const byCamera: Record<string, Record<string, number>> = {}
    const byClass: Record<string, number> = {}
    for (const r of rows) {
      const cam = r.cameraDeviceId
      if (!byCamera[cam]) byCamera[cam] = {}
      const obj = safeParseSummary(r.summary)
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'number') continue
        byCamera[cam][k] = (byCamera[cam][k] ?? 0) + v
        byClass[k] = (byClass[k] ?? 0) + v
      }
    }

    return {
      sinceMs,
      sinceHours,
      totalFrames: rows.length,
      byCamera,
      byClass,
    }
  }

  /**
   * Sugestie rozpoznań (2026-08-15): NIEZAREJESTROWANE tablice, które
   * powtarzają się w wielu dniach. Wzorzec „wjazd i wyjazd niemal codziennie
   * przez ≥ tydzień" = prawdopodobnie mieszkaniec, którego pojazd nie trafił
   * jeszcze do rejestru — administrator dostaje gotową listę do uzupełnienia.
   *
   *   GET /vision/plate-suggestions?since_days=30
   *
   * Werdykt liczony deterministycznie (bez LLM):
   *   RESIDENT_LIKE — ≥5 aktywnych dni, ≥3 wjazdy i ≥3 wyjazdy, rozpiętość ≥6 dni
   *   FREQUENT      — ≥3 aktywne dni (częsty gość / serwis / dostawca)
   */
  @Get('plate-suggestions')
  plateSuggestions(@Query('since_days') sinceDaysRaw?: string) {
    const sinceDays = clampNum(Number(sinceDaysRaw ?? 30), 3, 90, 30)
    const rows = this.store.lprPlateSuggestionStats({ sinceDays, minActiveDays: 3 })
    const fmtH = (h: number | null) =>
      h == null ? null : `~${String(Math.round(h)).padStart(2, '0')}:00`
    const suggestions = rows.map((r) => {
      const spanDays = Math.max(1, Math.round((r.lastSeen - r.firstSeen) / 86_400_000) + 1)
      const residentLike = r.activeDays >= 5 && r.ins >= 3 && r.outs >= 3 && spanDays >= 6
      return {
        plate: r.plate,
        reads: r.reads,
        activeDays: r.activeDays,
        spanDays,
        ins: r.ins,
        outs: r.outs,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
        typicalInHour: fmtH(r.avgInHour),
        typicalOutHour: fmtH(r.avgOutHour),
        verdict: residentLike ? 'RESIDENT_LIKE' : 'FREQUENT',
        suggestion: residentLike
          ? `Wjeżdża i wyjeżdża w ${r.activeDays} z ostatnich ${sinceDays} dni — ` +
            `prawdopodobnie mieszkaniec. Warto dodać pojazd do rejestru osiedla.`
          : `Pojawia się regularnie (${r.activeDays} dni z ostatnich ${sinceDays}) — ` +
            `częsty gość, serwis lub dostawca.`,
      }
    })
    return { sinceDays, suggestions }
  }

  /**
   * Lista kamer dostępnych dla vision UI — wyciągnięte z `device_config`.
   * Zwraca tylko CAMERA + LPR_CAMERA. UI używa tego do dropdown filtra.
   */
  @Get('cameras')
  listCameras() {
    const configs = this.store.getDeviceConfigs()
    const cameras = configs
      .filter((c) => c.type === 'CAMERA' || c.type === 'LPR_CAMERA')
      .map((c) => {
        const cfg = c.config as Record<string, any>
        return {
          deviceId: c.deviceId,
          type: c.type,
          name: typeof cfg?.name === 'string' ? cfg.name : null,
          ipAddress: typeof cfg?.ipAddress === 'string' ? cfg.ipAddress : null,
          manufacturer: typeof cfg?.manufacturer === 'string' ? cfg.manufacturer : null,
        }
      })
    return { cameras }
  }

  /**
   * Serwuje persisted klatkę JPEG z `data/vision-frames/`.
   * Nazwa walidowana regex-em — żadnego path traversal.
   *
   * Cache-Control: max-age=3600 — klatki są immutable (timestamp + UUID w nazwie).
   */
  @Get('frame/:filename')
  @Header('Cache-Control', 'public, max-age=3600')
  async serveFrame(
    @Param('filename') filename: string,
    @Res() res: Response,
    @Query('w') widthRaw?: string,
    @Query('full') full?: string,
  ) {
    // Walidacja: `<timestamp>_<device-id>.jpg`. device-id z device_config jest
    // tworzony przez Edge UI (UUID v4) lub z safeId-a `[A-Za-z0-9._-]+`
    // (patrz vision-detect.service.ts:284 — replace przy persist). Dlatego
    // akceptujemy oba kształty: alphanumerics + dot/underscore/hyphen.
    if (!/^[0-9]+_[A-Za-z0-9._-]+\.jpg$/.test(filename)) {
      throw new BadRequestException('Niepoprawna nazwa klatki')
    }
    // Defense-in-depth — odrzuć dowolny path-separator nawet jeśli regex
    // przepuścił (paranoja, ale tanie).
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      throw new BadRequestException('Niepoprawna nazwa klatki')
    }

    const dir = this.store.visionFramesDir()
    const fullPath = path.join(dir, filename)
    // Verify resolved path stays inside the frames dir.
    if (!fullPath.startsWith(dir + path.sep) && fullPath !== path.join(dir, filename)) {
      throw new BadRequestException('Niepoprawna ścieżka')
    }
    if (!fs.existsSync(fullPath)) {
      throw new NotFoundException('Klatka niedostępna')
    }

    // ── Downscale (2026-07-05) ────────────────────────────────────────────
    // Default: max szerokość FRAME_MAX_WIDTH (1280). `?w=320` = mniejsza
    // miniatura, `?full=1` = oryginał bez transformacji. Gdy sharp brak /
    // błąd dekodowania → oryginał (fail-open, jak dotąd).
    const wantFull = full === '1' || full === 'true' || FRAME_MAX_WIDTH === 0
    let targetWidth = FRAME_MAX_WIDTH
    const wParsed = Number(widthRaw)
    if (Number.isFinite(wParsed) && wParsed > 0) {
      targetWidth = Math.min(4096, Math.max(64, Math.round(wParsed)))
    }
    if (!wantFull) {
      const sharp = await this.getSharp()
      if (sharp) {
        try {
          const buf = await sharp(fullPath)
            .resize({ width: targetWidth, withoutEnlargement: true })
            .jpeg({ quality: FRAME_JPEG_QUALITY })
            .toBuffer()
          res.setHeader('Content-Type', 'image/jpeg')
          res.setHeader('Content-Length', buf.length)
          res.end(buf)
          return
        } catch {
          /* zły JPEG na dysku? — fail-open do oryginału poniżej */
        }
      }
    }

    res.setHeader('Content-Type', 'image/jpeg')
    // Manualnie stream-ujemy żeby uniknąć trzymania całego pliku w pamięci.
    fs.createReadStream(fullPath).pipe(res)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clampNum(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return Math.floor(n)
}

function flattenClasses(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function safeParseSummary(raw: string): Record<string, number> {
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object') return obj as Record<string, number>
  } catch {
    /* malformed — ignore */
  }
  return {}
}

/**
 * FAZA 8.h.4 (2026-06-05) — parse + filtr OCR tokenów dla UI.
 *
 * EasyOCR produkuje dużo szumu na rzeczywistych snapshotach — fragmenty
 * tablic, OSD overlay kamery ("Canera 01", "20:24:28"), znaki niespecjalne
 * z teł. Filtrujemy żeby UI nie pokazywała chips długie na 2000+ znaków.
 *
 * Heurystyka — token zostaje gdy:
 *   • długość >= 3 (1-2 znaki = pewny noise jak "M", "MM")
 *   • zawiera co najmniej 1 literę (czysto-numeryczne dopuszczamy gdy >= 3 cyfr,
 *     bo mogą być wartości typu "5/50" widoczne na vanie Media Expert)
 *   • nie wygląda jak typowy OSD overlay (data ISO `YYYY-MM-DD`, czas `HH:MM`,
 *     "Camera 0X" / "Canera 0X" — Hikvision często rozpoznawany przez EasyOCR
 *     jako "Canera").
 *
 * Brand_matcher i tak działa na pełnym text_raw (przed filtrem) — więc filtr
 * tu jest tylko display-side.
 */
const OSD_PATTERNS = [
  /^\d{2}-\d{2}-\d{4}/,           // 06-05-2026
  /^\d{4}-\d{2}-\d{2}/,           // 2026-06-05
  /^\d{2}:\d{2}(:\d{2})?/,        // 20:24:28
  /^\s*(can?era|camera|cam)\s*\d/i, // Camera 01 / Canera 01
  /^(mon|tue|wed|thu|fri|sat|sun)$/i,
]

function parseTextRaw(raw: string | null | undefined): string[] {
  if (!raw) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return (arr as unknown[])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .filter((t) => /[A-Za-zÀ-ſ]/.test(t) || /\d{3,}/.test(t))
    .filter((t) => !OSD_PATTERNS.some((p) => p.test(t)))
}
