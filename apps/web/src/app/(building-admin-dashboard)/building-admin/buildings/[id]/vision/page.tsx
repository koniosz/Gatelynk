'use client'
/**
 * Wizja kamer — co widzą kamery na osiedlu (2026-05-19).
 *
 * UI dla `vision_detections` w Edge sqlite. Edge VisionDetectService co 60s
 * snapshot-uje każdą kamerę, leci do YOLO service na MacBooku, persistuje
 * wynik {class: count} + JSON detekcji + opcjonalnie klatkę JPEG (gdy
 * detected person/dog).
 *
 * Strona pollu-je `/vision/detections` co 10s (pauzuje gdy tab nieaktywny).
 * Statsy z `/vision/stats`, lista kamer z `/vision/cameras`. Klatki przez
 * authorized fetch → blob URL (nie public, JWT BA wymagany).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { buildingAdminApi } from '@/lib/building-admin-api'
import { formatBuildingTime } from '@/lib/time'

interface Detection {
  id: number
  cameraDeviceId: string
  ts: number
  inferenceMs: number | null
  summary: Record<string, number>
  imagePath: string | null
  // 2026-05-22 — LLM-generated PL narrative dla notable frames + badges.
  // llmSummary=null = albo frame nie notable, albo summarizer jeszcze nie
  // przetworzył (cron co 30s). UI pokazuje placeholder/skeleton.
  llmSummary?: string | null
  brandDetected?: string | null
  wasteCategory?: string | null
  // 2026-05-23: anomaly detection (YOLOv8-pose + heurystyka geometryczna).
  // anomalyType='FALL' gdy fall_likelihood ≥ 0.5 (≥2/4 indikatorów geom).
  // UI pokazuje sticky red banner na górze listy + per-row red badge.
  anomalyType?: string | null
  fallLikelihood?: number | null
  // FAZA 8.h.4 (2026-06-05) — wszystkie OCR tokeny rozpoznane przez EasyOCR
  // (po filtrze noise w Edge). Pokazujemy jako chips per detection card +
  // search-filter w sidebarze. Pusta tablica = nic ciekawego nie wykryto
  // albo backend stary (graceful fallback).
  textRaw?: string[] | null
}

interface DetectionsResp {
  detections: Detection[]
  total: number
  sinceMs: number
  sinceHours: number
}

interface StatsResp {
  sinceMs: number
  sinceHours: number
  totalFrames: number
  byCamera: Record<string, Record<string, number>>
  byClass: Record<string, number>
}

interface CameraInfo {
  deviceId: string
  type: string
  name: string | null
  ipAddress: string | null
  manufacturer: string | null
}

interface CamerasResp {
  cameras: CameraInfo[]
}

// COCO classes — top 12 dla osiedla. Klucz: angielski (z YOLO), wartość: PL
// label + emoji. Reszta klas pokazuje się jako fallback bez emoji.
const CLASS_LABELS: Record<string, { pl: string; emoji: string }> = {
  person:     { pl: 'osoby',          emoji: '👤' },
  car:        { pl: 'samochody',      emoji: '🚗' },
  truck:      { pl: 'ciężarówki',     emoji: '🚚' },
  bus:        { pl: 'autobusy',       emoji: '🚌' },
  motorcycle: { pl: 'motocykle',      emoji: '🏍️' },
  bicycle:    { pl: 'rowery',         emoji: '🚲' },
  dog:        { pl: 'psy',            emoji: '🐕' },
  cat:        { pl: 'koty',           emoji: '🐈' },
  backpack:   { pl: 'plecaki',        emoji: '🎒' },
  handbag:    { pl: 'torebki',        emoji: '👜' },
  suitcase:   { pl: 'walizki',        emoji: '🧳' },
  umbrella:   { pl: 'parasolki',      emoji: '☂️' },
}

// Polish plural — 1 osoba / 2 osoby / 5 osób. Logika z PL nominal/genitive.
function plPlural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n)
  if (abs === 1) return forms[0]
  const mod10 = abs % 10
  const mod100 = abs % 100
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1]
  return forms[2]
}

const PL_FORMS: Record<string, [string, string, string]> = {
  person: ['osoba', 'osoby', 'osób'],
  car:    ['auto', 'auta', 'aut'],
  truck:  ['ciężarówka', 'ciężarówki', 'ciężarówek'],
  bus:    ['autobus', 'autobusy', 'autobusów'],
  motorcycle: ['motocykl', 'motocykle', 'motocykli'],
  bicycle: ['rower', 'rowery', 'rowerów'],
  dog:    ['pies', 'psy', 'psów'],
  cat:    ['kot', 'koty', 'kotów'],
  backpack: ['plecak', 'plecaki', 'plecaków'],
  handbag: ['torebka', 'torebki', 'torebek'],
  suitcase: ['walizka', 'walizki', 'walizek'],
  umbrella: ['parasolka', 'parasolki', 'parasolek'],
}

const TOP_CLASSES = Object.keys(CLASS_LABELS)

const TIME_RANGES = [
  { value: '1',   label: 'Ostatnia 1 h' },
  { value: '6',   label: 'Ostatnie 6 h' },
  { value: '24',  label: 'Ostatnie 24 h' },
  { value: '72',  label: 'Ostatnie 3 dni' },
  { value: '168', label: 'Ostatni tydzień' },
]

const POLL_INTERVAL_MS = 10_000

export default function BaVisionPage() {
  const params = useParams<{ id: string }>()
  const buildingId = Number(params.id)

  const [stats, setStats] = useState<StatsResp | null>(null)
  const [detections, setDetections] = useState<Detection[]>([])
  const [cameras, setCameras] = useState<CameraInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  // Filtry
  const [filterCamera, setFilterCamera] = useState<string>('')
  const [filterClass, setFilterClass] = useState<string>('')
  // FAZA 8.h.1 (2026-06-04) — brand filter (client-side, bo backend nie ma
  // `brand` param; brandDetected pochodzi z EasyOCR overlay przy detekcji).
  const [filterBrand, setFilterBrand] = useState<string>('')
  // FAZA 8.h.4 (2026-06-05) — text search po surowych OCR tokenach.
  // Wpisz "media" → znajdź każdą detekcję gdzie EasyOCR widział "Media".
  // Działa nawet jeśli brand_matcher nie zna pattern (np. nowa marka).
  const [filterText, setFilterText] = useState<string>('')
  // FAZA 8.h.5 (2026-06-05) — dedykowany toggle "tylko śmieciarki".
  // Filtruje detekcje gdzie waste_category != null LUB textRaw zawiera
  // typowe słowa kluczowe (szkło/papier/zmieszane/bio/plastik/remondis/mpo).
  // 1 klik zamiast wpisywania w search.
  const [filterWaste, setFilterWaste] = useState<boolean>(false)
  const [sinceHours, setSinceHours] = useState<string>('24')
  const [onlyWithFrames, setOnlyWithFrames] = useState(false)
  const [limit, setLimit] = useState<number>(50)

  // Modal — fullscreen frame preview
  const [modalDetection, setModalDetection] = useState<Detection | null>(null)

  // Polling timer ref żeby clearInterval w cleanup.
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const visibleRef = useRef<boolean>(true)

  /** Mapa cameraDeviceId → friendly name dla wyświetlania w tabeli. */
  const cameraNameMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of cameras) {
      m.set(c.deviceId, c.name ?? c.deviceId.slice(0, 8))
    }
    return m
  }, [cameras])

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      qs.set('since_hours', sinceHours)
      qs.set('limit', String(limit))
      if (filterCamera) qs.set('camera_id', filterCamera)
      if (filterClass) qs.set('class', filterClass)
      if (onlyWithFrames) qs.set('with_image', '1')

      const [detRes, statsRes, camRes] = await Promise.all([
        buildingAdminApi.get(`/building-admin/buildings/${buildingId}/vision/detections?${qs.toString()}`),
        buildingAdminApi.get(`/building-admin/buildings/${buildingId}/vision/stats?since_hours=${sinceHours}`),
        // Cameras zmieniają się rzadko — pobieramy raz na load, ale nie chcemy
        // robić osobnego flagu (kosztuje 1 mały request, dane małe).
        buildingAdminApi.get(`/building-admin/buildings/${buildingId}/vision/cameras`),
      ])
      setDetections((detRes.data as DetectionsResp).detections)
      setStats(statsRes.data as StatsResp)
      setCameras((camRes.data as CamerasResp).cameras)
      setLastUpdate(new Date())
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Błąd komunikacji z Edge'
      setError(msg)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [buildingId, sinceHours, limit, filterCamera, filterClass, onlyWithFrames])

  // Initial load + reload przy zmianie filtrów.
  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  // Polling co 10s — pauzuje gdy tab nieaktywny (Page Visibility API).
  useEffect(() => {
    const startTimer = () => {
      if (timerRef.current) return
      timerRef.current = setInterval(() => {
        if (visibleRef.current) fetchAll(true)
      }, POLL_INTERVAL_MS)
    }
    const stopTimer = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }

    const onVisibility = () => {
      visibleRef.current = document.visibilityState === 'visible'
      // Po wybudzeniu tabu odśwież natychmiast (nie czekaj 10s).
      if (visibleRef.current) fetchAll(true)
    }

    visibleRef.current = document.visibilityState === 'visible'
    document.addEventListener('visibilitychange', onVisibility)
    startTimer()
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stopTimer()
    }
  }, [fetchAll])

  const handleResetFilters = () => {
    setFilterCamera('')
    setFilterClass('')
    setFilterBrand('')
    setFilterText('')
    setFilterWaste(false)
    setSinceHours('24')
    setOnlyWithFrames(false)
    setLimit(50)
  }

  // FAZA 8.h.5+ (2026-06-05) — keywords + fuzzy substrings sygnalizujące
  // śmieciarkę. EasyOCR robi DUŻE zniekształcenia napisów na ruchomych
  // pojazdach (kompresja JPEG + motion blur). Wzorce z 4-letery prefixu są
  // bardziej tolerantne niż pełne słowo:
  //   "odpdy" (Villa Natura 08:11) — brak "a" w "odpady" → szukamy "od" + d/t w środku
  //   "sgreg" — segregujemy bez 'e' początku
  //   "worszowapl" — warszawa→worszow + apl
  //   "NFo"/"MEE" — MPO zniekształcony
  // RegExp lista zamiast plain substringów żeby obsłużyć fuzzy patterns.
  const WASTE_REGEX = [
    // Frakcje (krótkie prefixy żeby tolerować literówki)
    /szk[lł]/i, /papie?/i, /pap[ij]/i, /plastik/i, /tworzyw/i, /metal/i,
    /zmiesz/i, /zmies/i, /\bbio\b/i, /zielone/i, /komunal/i,
    // Odpady — fuzzy: zaczyna od "od" lub "ot", 5-7 chars, końcówka y/u
    /\bo[dt][a-z]{2,5}[yu]\b/i, /odpad/i, /odp[a-z]{2}y/i,
    /śmieci/i, /smieci/i, /wyw[oó]z/i,
    // Operatorzy
    /remond/i, /stena/i, /amest/i, /fbserwis/i, /\bmpgk\b/i, /\bmpo\b/i,
    /suez/i, /\bsita\b/i, /veolia/i, /tonsmeier/i, /eneris/i, /\bby[śs]\b/i,
    /\bfcc\b/i, /lemar/i, /ekosystem/i, /eko\s*system/i, /\bzgk\b/i,
    /\bpuk\b/i, /\bzuk\b/i,
    // MPO Warszawa — fuzzy patterns: "NFo"/"MEE"/"MFO" + segregujemy + URL
    /\b[mn][pf][od0]\b/i, /\b[mn][ef][eo]\b/i,
    /s\w*greg/i, /segreg/i, /[wm][ao]rsz[ao]w[ao]/i,
  ]

  // FAZA polish (i) — brand counts grouping (z detections w bieżącym okienku).
  // Counts liczone PRZED brand filterem żeby user widział pełną dystrybucję
  // (i mógł kliknąć inne brandy żeby przełączyć filtr).
  const brandCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of detections) {
      if (d.brandDetected) m.set(d.brandDetected, (m.get(d.brandDetected) ?? 0) + 1)
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }, [detections])

  // FAZA 8.h.1+ (2026-06-04/05) — client-side filter po brandDetected + textRaw + waste.
  // Backend nie ma `brand`/`text` query param (brand+text pochodzą z EasyOCR);
  // robimy filter po fetch.
  const visibleDetections = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    return detections.filter((d) => {
      if (filterBrand && d.brandDetected !== filterBrand) return false
      if (q && !(d.textRaw ?? []).some((t) => t.toLowerCase().includes(q))) return false
      if (filterWaste) {
        // Trzy źródła sygnału: canonical waste_category, canonical waste_operator,
        // lub regex match w textRaw (gdy waste_matcher nie zmatchował).
        if (d.wasteCategory) return true
        const hasWasteSignal = (d.textRaw ?? []).some((t) =>
          WASTE_REGEX.some((re) => re.test(t)),
        )
        if (!hasWasteSignal) return false
      }
      return true
    })
  }, [detections, filterBrand, filterText, filterWaste])

  return (
    <div className="max-w-[1400px]">
      <div className="mb-4">
        <Link
          href={`/building-admin/buildings/${buildingId}`}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          ← Wróć do budynku
        </Link>
      </div>

      <div className="flex items-start justify-between mb-4 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            📹 Wizja kamer — co widzą kamery na osiedlu
          </h1>
          <p className="text-sm text-gray-500 mt-1 flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Aktualizacja co 10 s automatycznie
            </span>
            {lastUpdate && (
              <span className="text-gray-400">
                · ostatnia: {formatBuildingTime(lastUpdate, 'time-sec')}
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => fetchAll()}
          disabled={loading}
          className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 shrink-0"
        >
          ↻ Odśwież
        </button>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm px-4 py-3 rounded-lg mb-4">
          <div className="font-semibold">⚠️ Edge niedostępny</div>
          <div className="text-xs mt-1">{error}</div>
          <div className="text-xs mt-1 text-rose-600/80">
            Sprawdź czy Tailscale działa i czy Mac Mini Edge jest online.
          </div>
        </div>
      )}

      {/* ANOMALY BANNER (red sticky) — 2026-05-23 */}
      <AnomalyBanner detections={detections} />

      {/* FAZA polish (i) — sticky stats bar (24h) */}
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200 -mx-2 px-2 py-2 mb-4">
        <StatsBar stats={stats} />
      </div>

      {/* 2-column layout: filters sidebar (left) + timeline (right) */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'minmax(0, 240px) 1fr' }}>
        <aside className="space-y-3 self-start sticky top-[80px]">
          <div className="bg-white rounded-xl border border-gray-200 p-3 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Filtry</div>
            <FilterField label="Kamera">
              <select
                value={filterCamera}
                onChange={(e) => setFilterCamera(e.target.value)}
                className="text-sm px-2 py-1.5 rounded border border-gray-200 bg-white w-full"
              >
                <option value="">Wszystkie ({cameras.length})</option>
                {cameras.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.name ?? c.deviceId.slice(0, 8)}
                    {c.ipAddress ? ` (${c.ipAddress})` : ''}
                  </option>
                ))}
              </select>
            </FilterField>

            <FilterField label="Klasa">
              <select
                value={filterClass}
                onChange={(e) => setFilterClass(e.target.value)}
                className="text-sm px-2 py-1.5 rounded border border-gray-200 bg-white w-full"
              >
                <option value="">Wszystkie</option>
                {TOP_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {CLASS_LABELS[c].emoji} {CLASS_LABELS[c].pl}
                  </option>
                ))}
              </select>
            </FilterField>

            <FilterField label="Zakres czasu">
              <select
                value={sinceHours}
                onChange={(e) => setSinceHours(e.target.value)}
                className="text-sm px-2 py-1.5 rounded border border-gray-200 bg-white w-full"
              >
                {TIME_RANGES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </FilterField>

            <label className="text-sm flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyWithFrames}
                onChange={(e) => setOnlyWithFrames(e.target.checked)}
                className="rounded border-gray-300"
              />
              <span className="text-gray-700">Tylko z klatkami</span>
            </label>

            <button
              onClick={handleResetFilters}
              className="w-full text-xs px-2.5 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
            >
              Reset filtrów
            </button>
          </div>

          {/* FAZA 8.h.5 (2026-06-05) — quick filter "tylko śmieciarki".
              Łączy waste_category (canonical match z waste_matcher.py) +
              keyword search po textRaw. Dla budynków gdzie waste jest częste. */}
          <div className="bg-white rounded-xl border border-gray-200 p-3">
            <button
              onClick={() => setFilterWaste((v) => !v)}
              className={
                'w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-semibold transition ' +
                (filterWaste
                  ? 'bg-amber-100 text-amber-900 border border-amber-300'
                  : 'bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200')
              }
              title={
                filterWaste
                  ? 'Kliknij ponownie żeby wyłączyć filtr śmieciarek'
                  : 'Pokaż tylko detekcje z napisami sygnalizującymi śmieciarkę (SZKŁO/PAPIER/REMONDIS/MPO itd.)'
              }
            >
              <span>🗑️ Tylko śmieciarki</span>
              <span className={filterWaste ? 'text-amber-700' : 'text-gray-400'}>
                {filterWaste ? '✓ aktywny' : '○'}
              </span>
            </button>
          </div>

          {/* FAZA 8.h.4 (2026-06-05) — search po surowych OCR tokenach.
              Działa też dla brandów których brand_matcher.py jeszcze nie zna —
              wpisz "media" i znajdziesz każdą detekcję gdzie EasyOCR widział
              "Media Expert" / "Media Markt" niezależnie od pattern listy. */}
          <div className="bg-white rounded-xl border border-gray-200 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              🔎 Szukaj napisu
            </div>
            <input
              type="text"
              placeholder="np. Media, DPD, 5/50..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:border-blue-500"
            />
            {filterText && (
              <button
                onClick={() => setFilterText('')}
                className="mt-1.5 text-[10px] text-gray-500 hover:text-gray-700 underline"
              >
                wyczyść
              </button>
            )}
          </div>

          {/* Brand cards — clickable, filtruje detekcje client-side po brandDetected.
              Toggle: drugie kliknięcie tego samego brandu = zresetuj filtr. */}
          {brandCounts.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Marki / firmy
                </div>
                {filterBrand && (
                  <button
                    onClick={() => setFilterBrand('')}
                    className="text-[10px] text-gray-500 hover:text-gray-700 underline"
                    title="Wyczyść filtr brand"
                  >
                    wyczyść
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                {brandCounts.map(([brand, n]) => {
                  const active = filterBrand === brand
                  return (
                    <button
                      key={brand}
                      onClick={() => setFilterBrand(active ? '' : brand)}
                      className={
                        'flex items-center justify-between gap-2 px-2 py-1.5 rounded border text-xs transition ' +
                        (active
                          ? 'bg-purple-600 border-purple-700 text-white shadow-sm'
                          : 'bg-purple-50 border-purple-200 hover:bg-purple-100 text-purple-900')
                      }
                      title={
                        active
                          ? `Aktywny filtr: ${brand} — kliknij żeby wyłączyć`
                          : `${n} detekcji z brandem ${brand} — kliknij żeby filtrować`
                      }
                    >
                      <span>📦 {brand}</span>
                      <span className="font-semibold">{n}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </aside>

        {/* Timeline detection cards (zamiast tabeli) */}
        <div>
          {loading && detections.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 px-4 py-12 text-center text-sm text-gray-400">
              Ładowanie detekcji…
            </div>
          ) : visibleDetections.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 px-4 py-12 text-center text-sm text-gray-400">
              {filterBrand
                ? `Brak detekcji z brandem „${filterBrand}" w wybranym okresie.`
                : 'Brak detekcji w wybranym okresie.'}
              {filterCamera || filterClass || filterBrand || onlyWithFrames ? (
                <div className="mt-2 text-xs">
                  Spróbuj poszerzyć zakres czasu lub zresetować filtry.
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              {filterBrand && (
                <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-xs text-purple-800 flex items-center justify-between">
                  <span>
                    📦 Filtr brand: <strong>{filterBrand}</strong> ({visibleDetections.length} z {detections.length} detekcji)
                  </span>
                  <button
                    onClick={() => setFilterBrand('')}
                    className="text-purple-700 hover:text-purple-900 underline"
                  >
                    wyczyść
                  </button>
                </div>
              )}
              {visibleDetections.map((d) => (
                <DetectionCard
                  key={d.id}
                  d={d}
                  buildingId={buildingId}
                  cameraName={cameraNameMap.get(d.cameraDeviceId) ?? d.cameraDeviceId.slice(0, 8)}
                  onThumbnailClick={() => setModalDetection(d)}
                />
              ))}
            </div>
          )}

          {detections.length > 0 && detections.length >= limit && (
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 mt-3 text-center">
              <button
                onClick={() => setLimit((l) => Math.min(l + 50, 500))}
                className="text-sm text-blue-600 hover:text-blue-700"
              >
                Pokaż więcej →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modal fullscreen */}
      {modalDetection && (
        <FrameModal
          detection={modalDetection}
          buildingId={buildingId}
          cameraName={cameraNameMap.get(modalDetection.cameraDeviceId) ?? modalDetection.cameraDeviceId.slice(0, 8)}
          onClose={() => setModalDetection(null)}
        />
      )}
    </div>
  )
}

// FAZA polish (i) — Card layout dla pojedynczej detekcji (zamiast row tabelarycznego).
// Renderuje thumbnail po lewej, summary + LLM po prawej, metadata w stopce.
function DetectionCard({
  d, buildingId, cameraName, onThumbnailClick,
}: {
  d: Detection
  buildingId: number
  cameraName: string
  onThumbnailClick: () => void
}) {
  const ageMs = Date.now() - d.ts
  const isLive = ageMs < 30_000

  const summaryChips = Object.entries(d.summary)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])

  const isAnomaly = d.anomalyType === 'FALL'

  return (
    <div
      className={
        isAnomaly
          ? 'bg-red-50/60 border border-red-300 ring-1 ring-red-200 rounded-xl p-3 flex gap-3 hover:bg-red-100/60'
          : 'bg-white border border-gray-200 rounded-xl p-3 flex gap-3 hover:shadow-sm transition'
      }
    >
      {/* Thumbnail inline */}
      <div className="shrink-0">
        {d.imagePath ? (
          <ThumbButton
            buildingId={buildingId}
            filename={d.imagePath}
            onClick={onThumbnailClick}
          />
        ) : (
          <div className="w-20 h-14 rounded bg-gray-50 border border-gray-200 flex items-center justify-center text-gray-300 text-[10px] italic">
            brak klatki
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        {/* Top row — time + camera + LIVE */}
        <div className="flex items-center gap-2 flex-wrap text-xs text-gray-600">
          {isLive && (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">
              <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
              LIVE
            </span>
          )}
          {isAnomaly && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-600 text-white font-semibold">
              🚨 FALL {d.fallLikelihood != null ? `${Math.round(d.fallLikelihood * 100)}%` : ''}
            </span>
          )}
          <span className="text-gray-800 font-medium">{formatTime(d.ts)}</span>
          <span className="text-gray-400">·</span>
          <span>{cameraName}</span>
          <span className="text-gray-300 font-mono text-[10px]">
            {d.cameraDeviceId.slice(0, 8)}…
          </span>
          <div className="ml-auto text-gray-400 text-[10px]">
            {formatAge(ageMs)}
            {d.inferenceMs != null ? ` · ${d.inferenceMs} ms` : ''}
          </div>
        </div>

        {/* Summary chips */}
        {summaryChips.length === 0 ? (
          <div className="text-gray-400 italic text-xs">(nic nie wykryto)</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {summaryChips.map(([cls, n]) => (
              <SummaryChip key={cls} cls={cls} count={n} />
            ))}
          </div>
        )}

        {/* LLM summary (jeśli jest) */}
        <LlmSummaryCell d={d} />
      </div>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-500 font-medium">{label}</label>
      {children}
    </div>
  )
}

function StatsBar({ stats }: { stats: StatsResp | null }) {
  if (!stats) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 flex flex-wrap gap-3 text-sm text-gray-400">
        Ładowanie statystyk…
      </div>
    )
  }

  // Sort klas po liczbie. Pokazujemy top 8 + reszta jako „pozostałe".
  const sorted = Object.entries(stats.byClass)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, 8)
  const restSum = sorted.slice(8).reduce((acc, [, n]) => acc + n, 0)

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4">
      <div className="text-xs text-gray-500 mb-2">
        Statystyki za ostatnie {stats.sinceHours} h · {stats.totalFrames} {plPlural(stats.totalFrames, ['klatka', 'klatki', 'klatek'])}
      </div>
      {top.length === 0 ? (
        <div className="text-sm text-gray-400 italic">Brak detekcji w tym okresie.</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {top.map(([cls, n]) => (
            <StatPill key={cls} cls={cls} count={n} />
          ))}
          {restSum > 0 && (
            <span className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-gray-600">
              + {restSum} innych
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function StatPill({ cls, count }: { cls: string; count: number }) {
  const meta = CLASS_LABELS[cls]
  const forms = PL_FORMS[cls]
  const label = forms ? plPlural(count, forms) : cls
  const emoji = meta?.emoji ?? '•'
  return (
    <span className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100 text-blue-900">
      <span>{emoji}</span>
      <span className="font-semibold">{count}</span>
      <span className="text-blue-700">{label}</span>
    </span>
  )
}

function DetectionRow({
  d, buildingId, cameraName, onThumbnailClick,
}: {
  d: Detection
  buildingId: number
  cameraName: string
  onThumbnailClick: () => void
}) {
  // „Live" badge dla detekcji młodszych niż 30s.
  const ageMs = Date.now() - d.ts
  const isLive = ageMs < 30_000

  // Summary → human-readable chips. Filter zero counts (YOLO sometimes returns 0).
  const summaryChips = Object.entries(d.summary)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])

  return (
    <tr
      className={
        d.anomalyType === 'FALL'
          ? 'border-b border-red-200 bg-red-50/60 hover:bg-red-100/60 ring-1 ring-inset ring-red-300'
          : 'border-b border-gray-50 hover:bg-gray-50'
      }
    >
      <td className="px-4 py-2">
        {d.imagePath ? (
          <ThumbButton
            buildingId={buildingId}
            filename={d.imagePath}
            onClick={onThumbnailClick}
          />
        ) : (
          <span className="text-gray-300 text-xs italic">brak klatki</span>
        )}
      </td>
      <td className="px-4 py-2 text-gray-700 whitespace-nowrap">
        <div className="flex items-center gap-1.5">
          {isLive && (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-semibold">
              <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
              LIVE
            </span>
          )}
          <span>{formatTime(d.ts)}</span>
        </div>
        <div className="text-[10px] text-gray-400">{formatAge(ageMs)}</div>
      </td>
      <td className="px-4 py-2">
        {summaryChips.length === 0 ? (
          <span className="text-gray-400 italic text-xs">(nic nie wykryto)</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {summaryChips.map(([cls, n]) => (
              <SummaryChip key={cls} cls={cls} count={n} />
            ))}
          </div>
        )}
      </td>
      <td className="px-4 py-2 align-top">
        <LlmSummaryCell d={d} />
      </td>
      <td className="px-4 py-2 text-gray-700 text-xs">
        <div>{cameraName}</div>
        <div className="text-gray-400 font-mono text-[10px]">
          {d.cameraDeviceId.slice(0, 8)}…
        </div>
      </td>
      <td className="px-4 py-2 text-right text-xs text-gray-500 font-mono">
        {d.inferenceMs != null ? `${d.inferenceMs}` : '—'}
      </td>
    </tr>
  )
}

function SummaryChip({ cls, count }: { cls: string; count: number }) {
  const meta = CLASS_LABELS[cls]
  const emoji = meta?.emoji ?? '•'
  return (
    <span
      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700 border border-gray-200"
      title={meta ? meta.pl : cls}
    >
      <span>{emoji}</span>
      <span className="font-semibold">{count}×</span>
      <span>{cls}</span>
    </span>
  )
}

/**
 * Authorized image — BA JWT siedzi w cookie, ale `<img>` nie wysyła
 * Authorization headera, tylko cookie (a my używamy Bearer). Workaround:
 * fetch z axios → blob → URL.createObjectURL.
 *
 * Każdy thumb robi osobny fetch. Cache w przeglądarce nie zadziała bo to
 * blob URL — ale Cloud i Edge ustawiają `max-age=3600`, więc HTTP cache na
 * poziomie samego XHR będzie działał dla powtarzających się klatek.
 *
 * Cleanup: revokeObjectURL przy unmount żeby nie wyciekały blob URLs.
 */
function ThumbButton({
  buildingId, filename, onClick,
}: { buildingId: number; filename: string; onClick: () => void }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    buildingAdminApi
      .get(`/building-admin/buildings/${buildingId}/vision/frame/${encodeURIComponent(filename)}`, {
        responseType: 'blob',
      })
      .then((res) => {
        if (cancelled) return
        const url = URL.createObjectURL(res.data)
        objectUrlRef.current = url
        setSrc(url)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [buildingId, filename])

  if (failed) {
    return (
      <div className="w-20 h-14 rounded bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-500 text-[10px]">
        ✕ błąd
      </div>
    )
  }

  return (
    <button
      onClick={onClick}
      className="w-20 h-14 rounded overflow-hidden border border-gray-200 hover:border-blue-400 hover:shadow-md transition-all bg-gray-50 group relative"
      title="Kliknij aby powiększyć"
    >
      {src ? (
        <img
          src={src}
          alt="klatka"
          loading="lazy"
          className="w-full h-full object-cover group-hover:opacity-90 transition-opacity"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">
          …
        </div>
      )}
    </button>
  )
}

function FrameModal({
  detection, buildingId, cameraName, onClose,
}: {
  detection: Detection
  buildingId: number
  cameraName: string
  onClose: () => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!detection.imagePath) {
      setFailed(true)
      return
    }
    let cancelled = false
    buildingAdminApi
      .get(`/building-admin/buildings/${buildingId}/vision/frame/${encodeURIComponent(detection.imagePath)}`, {
        responseType: 'blob',
      })
      .then((res) => {
        if (cancelled) return
        const url = URL.createObjectURL(res.data)
        objectUrlRef.current = url
        setSrc(url)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => {
      cancelled = true
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [buildingId, detection.imagePath])

  // ESC zamyka modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const summaryChips = Object.entries(detection.summary).filter(([, n]) => n > 0)

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-4">
          <div>
            <div className="font-semibold text-gray-900">{cameraName}</div>
            <div className="text-xs text-gray-500">
              {formatBuildingTime(detection.ts, 'datetime')} ·
              {' '}{detection.inferenceMs ?? '—'} ms inference
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-2xl text-gray-400 hover:text-gray-700 leading-none"
            title="Zamknij (Esc)"
          >
            ×
          </button>
        </div>

        {/* Anomaly red banner — widoczny TYLKO gdy fall_detected. (2026-05-23) */}
        {detection.anomalyType === 'FALL' && (
          <div className="px-4 py-3 bg-gradient-to-r from-red-600 to-rose-600 text-white">
            <div className="flex items-start gap-3">
              <span className="text-2xl animate-pulse">🚨</span>
              <div>
                <div className="font-bold text-base">
                  Możliwy upadek — likelihood{' '}
                  {detection.fallLikelihood != null
                    ? `${Math.round(detection.fallLikelihood * 100)}%`
                    : '?'}
                </div>
                <p className="text-xs text-red-100 mt-0.5">
                  Heurystyka YOLOv8-pose wykryła pozycję leżącą. Zweryfikuj
                  klatkę obok. Jeśli rzeczywisty upadek — niezwłocznie
                  skontaktuj się z pomocą.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="bg-gray-900 flex items-center justify-center min-h-[300px] max-h-[70vh]">
          {failed ? (
            <div className="text-gray-400 text-sm">Nie udało się załadować klatki</div>
          ) : src ? (
            <img src={src} alt="klatka" className="max-w-full max-h-[70vh] object-contain" />
          ) : (
            <div className="text-gray-400 text-sm">Ładowanie…</div>
          )}
        </div>

        {(summaryChips.length > 0 || detection.llmSummary || detection.brandDetected || detection.wasteCategory || (detection.textRaw && detection.textRaw.length > 0)) && (
          <div className="px-4 py-3 border-t border-gray-100 space-y-2">
            {summaryChips.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {summaryChips.map(([cls, n]) => (
                  <SummaryChip key={cls} cls={cls} count={n} />
                ))}
              </div>
            )}
            {(detection.llmSummary || detection.brandDetected || detection.wasteCategory) && (
              <div className="rounded-lg bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-100 p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-purple-600">✨</span>
                  <span className="text-xs font-semibold uppercase tracking-wide text-purple-700">
                    Summary AI
                  </span>
                  {detection.brandDetected && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-200 text-purple-800 font-semibold">
                      📦 {detection.brandDetected}
                    </span>
                  )}
                  {detection.wasteCategory && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-200 text-amber-800 font-semibold">
                      ♻️ {detection.wasteCategory}
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-800 leading-snug">
                  {detection.llmSummary ?? (
                    <span className="text-gray-400 italic">
                      Trwa analiza — opis pojawi się wkrótce…
                    </span>
                  )}
                </p>
              </div>
            )}
            {/* FAZA 8.h.4 (2026-06-05) — wszystkie napisy rozpoznane przez OCR.
                Filtr noise jest po stronie Edge (parseTextRaw). UI pokazuje
                co zostało — nawet jeśli brand_matcher nie zna pattern, użytkownik
                widzi że van miał napis "FRESH FOOD" / "EXPRESS DELIVERY" itd. */}
            {detection.textRaw && detection.textRaw.length > 0 && (
              <div className="flex items-start gap-2 flex-wrap pt-1">
                <span className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold mt-0.5">
                  🔡 Napisy
                </span>
                {detection.textRaw.slice(0, 12).map((t, i) => (
                  <span
                    key={`${i}-${t}`}
                    className="text-[11px] px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-900 font-mono"
                    title={t}
                  >
                    {t.length > 24 ? t.slice(0, 22) + '…' : t}
                  </span>
                ))}
                {detection.textRaw.length > 12 && (
                  <span className="text-[10px] text-gray-400 italic">
                    +{detection.textRaw.length - 12} więcej
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Sticky red banner — pokazuje się gdy w aktualnym zakresie czasowym
 * wystąpiły anomalie (fall_detected). Ukryty gdy brak. (2026-05-23)
 *
 * Liczy z `detections` (już load-owane z Edge — bez dodatkowego API call).
 * Filter prop „Tylko z klatkami" / „Klasa" wpływa na licznik — ale banner
 * pokazuje WSZYSTKIE anomalie w okienku, nawet jeśli user filtruje.
 */
function AnomalyBanner({ detections }: { detections: Detection[] }) {
  const params = useParams<{ id: string }>()
  const buildingId = params?.id
  const anomalies = detections.filter((d) => d.anomalyType === 'FALL')
  if (anomalies.length === 0) return null

  const lastAnomaly = anomalies[0]  // detections sortowane DESC, więc [0] = ostatnia
  const lastTime = new Date(lastAnomaly.ts)
  const maxLikelihood = Math.max(
    ...anomalies.map((a) => a.fallLikelihood ?? 0),
  )
  const maxPct = Math.round(maxLikelihood * 100)

  return (
    <div
      role="alert"
      className="mb-4 rounded-xl border-2 border-red-500 bg-gradient-to-r from-red-50 to-rose-50 shadow-lg"
    >
      <div className="px-4 py-3 flex items-start gap-3">
        <div className="shrink-0 w-10 h-10 rounded-full bg-red-600 flex items-center justify-center text-2xl animate-pulse">
          🚨
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-bold text-red-700 text-lg">
              Wykryto możliwy upadek!
            </h2>
            <span className="inline-flex items-center text-[10px] px-2 py-0.5 rounded bg-red-600 text-white font-bold">
              {anomalies.length === 1
                ? '1 incydent'
                : `${anomalies.length} incydentów`}
            </span>
          </div>
          <p className="text-sm text-red-800 mt-0.5">
            Ostatni: <strong>{formatBuildingTime(lastTime, 'datetime-sec')}</strong>
            {' · '}likelihood <strong>{maxPct}%</strong>
            {' · '}kamera{' '}
            <span className="font-mono text-xs">
              {lastAnomaly.cameraDeviceId.slice(0, 8)}…
            </span>
          </p>
          <p className="text-xs text-red-700/80 mt-1.5">
            ⚠️ Heurystyka YOLOv8-pose — może być false-positive (np. dziecko
            bawi się na ziemi). Zweryfikuj klatkę poniżej. Jeśli to faktyczny
            upadek, niezwłocznie skontaktuj się z pomocą lub konsjerżem.
          </p>
          {buildingId && (
            <Link
              href={`/building-admin/buildings/${buildingId}/anomaly-events`}
              className="inline-flex items-center gap-1 mt-2 text-sm font-semibold text-red-700 hover:text-red-900 underline"
            >
              🛡 Pełna lista alertów + akcje (obsłużone / fałszywy alarm) →
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  // Czas w strefie Edge (Europe/Warsaw), patrz `lib/time.ts`.
  return formatBuildingTime(ts, 'time-sec')
}

function formatAge(ageMs: number): string {
  const sec = Math.floor(ageMs / 1000)
  if (sec < 60) return `${sec} s temu`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min temu`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h temu`
  const days = Math.floor(h / 24)
  return `${days} ${plPlural(days, ['dzień', 'dni', 'dni'])} temu`
}

/**
 * Komórka „Summary (LLM)" — 3 stany:
 *   1. llmSummary != null         → tekst (z badge brand/waste gdy są)
 *   2. notable (brand/waste/animal w summary) + null → „⏳ Trwa analiza..."
 *      (cron Edge co 30s generuje — pojawi się przy następnym poll)
 *   3. nie notable (puste/tylko aut)  → szary myślnik
 */
function LlmSummaryCell({ d }: { d: Detection }) {
  const hasSummary = !!d.llmSummary
  const hasBrand = !!d.brandDetected
  const hasWaste = !!d.wasteCategory
  const hasNotableClass =
    !!d.summary?.person || !!d.summary?.dog || !!d.summary?.cat
  const isNotable = hasBrand || hasWaste || hasNotableClass
  // 2026-05-23: anomaly highlight — czerwony badge gdy YOLOv8-pose
  // heurystyka geometryczna wykryła upadek (likelihood ≥0.5).
  const hasAnomaly = d.anomalyType === 'FALL'
  const fallPct = d.fallLikelihood != null
    ? Math.round(d.fallLikelihood * 100)
    : null

  const anomalyBadge = hasAnomaly ? (
    <span
      title={`Heurystyka YOLOv8-pose — likelihood ${fallPct}% (≥50% = alarm)`}
      className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-red-600 text-white font-bold whitespace-nowrap animate-pulse shadow-sm"
    >
      🚨 MOŻLIWY UPADEK {fallPct != null ? `(${fallPct}%)` : ''}
    </span>
  ) : null

  if (hasSummary) {
    return (
      <div className="text-sm text-gray-800">
        <div className="flex flex-wrap items-start gap-1.5">
          {anomalyBadge}
          {hasBrand && (
            <span
              title={`Brand detection: ${d.brandDetected}`}
              className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 font-semibold whitespace-nowrap"
            >
              📦 {d.brandDetected}
            </span>
          )}
          {hasWaste && (
            <span
              title={`Waste category: ${d.wasteCategory}`}
              className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold whitespace-nowrap"
            >
              ♻️ {d.wasteCategory}
            </span>
          )}
        </div>
        <p className={`mt-1 leading-snug ${hasAnomaly ? 'text-red-700 font-semibold' : 'text-gray-700'}`}>
          {d.llmSummary}
        </p>
      </div>
    )
  }

  if (hasAnomaly) {
    // Anomaly bez LLM summary (cron jeszcze nie zdążył).
    return (
      <div className="text-sm">
        {anomalyBadge}
        <p className="mt-1 text-red-700 italic text-xs">
          Wykryto pozycję leżącą — sprawdź klatkę.
        </p>
      </div>
    )
  }

  if (isNotable) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-400 italic">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-300 animate-pulse" />
        Trwa analiza…
      </span>
    )
  }

  return <span className="text-gray-300 text-xs">—</span>
}
