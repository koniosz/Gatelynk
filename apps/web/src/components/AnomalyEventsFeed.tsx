'use client'
import { useCallback, useEffect, useState } from 'react'
import { AxiosInstance } from 'axios'
import {
  AnomalyEvent,
  AnomalyEventsResponse,
  TYPE_LABEL,
  TYPE_ICON,
  STATUS_BADGE,
  formatTs,
  relativeTime,
  statusOf,
  indicatorLabel,
} from '@/lib/anomaly-events'

/**
 * Wspólny widok feed-u anomalii. Używany przez BA i Concierge — różni się
 * tylko axiosInstance + endpointami (BA scopuje per buildingId w URL, Concierge
 * używa scopu z JWT).
 *
 * Props:
 *  - `apiClient` — buildingAdminApi LUB conciergeApi z axios (z bearerem z cookies)
 *  - `listPath` — np. '/building-admin/buildings/9/anomaly-events' lub '/concierge/anomaly-events'
 *  - `itemPath(id)` — builder dla per-event akcji: image/resolve/false-positive
 *  - `canResolve` — czy pokazać akcje resolve/false-positive (true dla BA + Concierge)
 *
 * Refresh co 30s gdy widok otwarty (polling). Pull-to-refresh + ręczny button.
 */
export interface AnomalyEventsFeedProps {
  apiClient: AxiosInstance
  listPath: string
  itemPath: (id: string) => string
  canResolve?: boolean
}

type Filter = 'open' | 'all' | 'falsePositive'
type SortMode = 'time' | 'likelihood' | 'status'

const FILTER_OPTIONS: { key: Filter; label: string }[] = [
  { key: 'open',          label: 'Nieobsłużone' },
  { key: 'all',           label: 'Wszystkie' },
  { key: 'falsePositive', label: 'Fałszywe alarmy' },
]

const RANGE_OPTIONS: { hours: number; label: string }[] = [
  { hours: 24,  label: '24 h' },
  { hours: 168, label: '7 dni' },
  { hours: 720, label: '30 dni' },
]

const SORT_OPTIONS: { key: SortMode; label: string }[] = [
  { key: 'time',       label: 'Najnowsze' },
  { key: 'likelihood', label: 'Prawdopodobieństwo ↓' },
  { key: 'status',     label: 'Status (nieobsłużone)' },
]

// Status priority dla sortowania: OPEN > RESOLVED > FALSE_POSITIVE
const STATUS_PRIORITY: Record<string, number> = { OPEN: 0, RESOLVED: 1, FALSE_POSITIVE: 2 }

export function AnomalyEventsFeed({
  apiClient,
  listPath,
  itemPath,
  canResolve = true,
}: AnomalyEventsFeedProps) {
  const [events, setEvents] = useState<AnomalyEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('open')
  const [range, setRange] = useState(24)
  const [selected, setSelected] = useState<AnomalyEvent | null>(null)
  const [imageBlobs, setImageBlobs] = useState<Record<string, string>>({})
  const [actioning, setActioning] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null)
  // FAZA polish (b) — bulk actions, likelihood filter, sort
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [minLikelihood, setMinLikelihood] = useState(50) // 0..100
  const [sortMode, setSortMode] = useState<SortMode>('time')
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)

  const showToast = (msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 3000)
  }

  const load = useCallback(() => {
    setLoading(true)
    const qs = new URLSearchParams({ since_hours: String(range), limit: '200' })
    if (filter === 'open') qs.set('unresolved', '1')
    apiClient
      .get<AnomalyEventsResponse>(`${listPath}?${qs.toString()}`)
      .then((res) => {
        let evs = res.data.events
        if (filter === 'falsePositive') evs = evs.filter((e) => e.falsePositive)
        setEvents(evs)
      })
      .catch((err) => {
        if (err?.response?.status !== 401) console.error(err)
      })
      .finally(() => setLoading(false))
  }, [apiClient, listPath, range, filter])

  useEffect(() => { load() }, [load])
  // Polling co 30s gdy zakładka otwarta. Inaczej user nie widzi nowych alertów
  // bez ręcznego F5 — ważne bo to widok bezpieczeństwa.
  useEffect(() => {
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  // Lazy load JPEG-ów dla każdego eventu z imageFilename. Pobranie z `/.../image`
  // proxy (Cloud → Edge LAN). Cache w-memory w `imageBlobs` Map (URL.createObjectURL).
  useEffect(() => {
    const toFetch = events
      .filter((e) => e.imageFilename && !imageBlobs[e.id])
      .slice(0, 20) // throttle — max 20 thumbnaili na raz
    if (toFetch.length === 0) return
    let cancelled = false
    Promise.all(
      toFetch.map((e) =>
        apiClient
          .get(`${itemPath(e.id)}/image`, { responseType: 'blob' })
          .then((res) => ({ id: e.id, url: URL.createObjectURL(res.data) }))
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const r of results) {
        if (r) next[r.id] = r.url
      }
      if (Object.keys(next).length > 0) {
        setImageBlobs((prev) => ({ ...prev, ...next }))
      }
    })
    return () => { cancelled = true }
  }, [events, apiClient, itemPath, imageBlobs])

  // Cleanup blob URLs przy unmount — przeglądarka inaczej trzyma je w pamięci.
  useEffect(() => () => {
    Object.values(imageBlobs).forEach((u) => URL.revokeObjectURL(u))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const doResolve = async (ev: AnomalyEvent) => {
    setActioning(ev.id)
    try {
      await apiClient.patch(`${itemPath(ev.id)}/resolve`)
      showToast('Oznaczono jako obsłużone')
      load()
      setSelected(null)
    } catch (err) {
      console.error(err)
      showToast('Nie udało się oznaczyć', 'err')
    } finally {
      setActioning(null)
    }
  }

  const doFalsePositive = async (ev: AnomalyEvent) => {
    setActioning(ev.id)
    try {
      await apiClient.patch(`${itemPath(ev.id)}/false-positive`)
      showToast('Oznaczono jako fałszywy alarm')
      load()
      setSelected(null)
    } catch (err) {
      console.error(err)
      showToast('Nie udało się oznaczyć', 'err')
    } finally {
      setActioning(null)
    }
  }

  // ── Bulk akcje (b) ────────────────────────────────────────────────────────
  // Backend nie ma bulk endpointu, więc fire'ujemy per-event sekwencyjnie żeby
  // serwer się nie zatkał. Progress widoczny w UI.
  const bulkAction = async (
    targets: AnomalyEvent[],
    action: 'resolve' | 'false-positive',
    successLabel: string,
  ) => {
    if (targets.length === 0) return
    setBulkProgress({ done: 0, total: targets.length })
    let ok = 0
    let fail = 0
    for (let i = 0; i < targets.length; i++) {
      const ev = targets[i]
      try {
        await apiClient.patch(`${itemPath(ev.id)}/${action}`)
        ok += 1
      } catch (err) {
        console.error('bulk action error', err)
        fail += 1
      }
      setBulkProgress({ done: i + 1, total: targets.length })
    }
    setBulkProgress(null)
    setChecked(new Set())
    showToast(
      fail === 0
        ? `${successLabel}: ${ok}`
        : `${successLabel}: ${ok}, błędy: ${fail}`,
      fail === 0 ? 'ok' : 'err',
    )
    load()
  }

  const visibleEvents = events
    .filter((e) => Math.round(e.likelihood * 100) >= minLikelihood)
  const sortedEvents = [...visibleEvents].sort((a, b) => {
    if (sortMode === 'likelihood') return b.likelihood - a.likelihood
    if (sortMode === 'status') {
      const pa = STATUS_PRIORITY[statusOf(a)] ?? 99
      const pb = STATUS_PRIORITY[statusOf(b)] ?? 99
      if (pa !== pb) return pa - pb
      // tie-break: time desc
      return new Date(b.ts).getTime() - new Date(a.ts).getTime()
    }
    // default: time desc
    return new Date(b.ts).getTime() - new Date(a.ts).getTime()
  })

  const openEvents = sortedEvents.filter((e) => statusOf(e) === 'OPEN')
  const checkedOpen = sortedEvents.filter((e) => checked.has(e.id) && statusOf(e) === 'OPEN')

  const toggleAll = () => {
    if (checked.size > 0) setChecked(new Set())
    else setChecked(new Set(sortedEvents.map((e) => e.id)))
  }
  const toggleOne = (id: string) => {
    setChecked((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const stats = {
    total: events.length,
    open: events.filter((e) => !e.resolvedAt && !e.falsePositive).length,
    resolved: events.filter((e) => e.resolvedAt && !e.falsePositive).length,
    fp: events.filter((e) => e.falsePositive).length,
  }

  return (
    <div className="space-y-4">
      {/* Header — filtry + range + odśwież */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden">
            {FILTER_OPTIONS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-3 py-1.5 text-sm font-medium transition ${
                  filter === f.key
                    ? 'bg-red-50 text-red-700'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <select
            value={range}
            onChange={(e) => setRange(Number(e.target.value))}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm"
          >
            {RANGE_OPTIONS.map((r) => (
              <option key={r.hours} value={r.hours}>{r.label}</option>
            ))}
          </select>
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm"
            title="Sortowanie"
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>Sortuj: {s.label}</option>
            ))}
          </select>
          <label className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm">
            <span className="text-gray-600">Min. {minLikelihood}%</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={minLikelihood}
              onChange={(e) => setMinLikelihood(Number(e.target.value))}
              className="w-32 accent-red-600"
              title="Minimalne prawdopodobieństwo"
            />
          </label>
        </div>
        <button
          onClick={load}
          className="text-sm text-gray-500 hover:text-gray-900"
          disabled={loading}
        >
          {loading ? 'Ładowanie…' : '🔄 Odśwież'}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <StatCard label="W tym oknie" value={stats.total} />
        <StatCard label="Nieobsłużone" value={stats.open} tone="red" />
        <StatCard label="Obsłużone" value={stats.resolved} tone="blue" />
        <StatCard label="Fałszywe alarmy" value={stats.fp} tone="gray" />
      </div>

      {/* Mass actions bar — sticky gdy są zaznaczone albo gdy są OPEN do bulk-a */}
      {canResolve && (openEvents.length > 0 || checked.size > 0) && (
        <div className="sticky top-2 z-30 rounded-xl border border-blue-200 bg-blue-50/95 backdrop-blur px-3 py-2 flex flex-wrap items-center gap-2 text-sm">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={checked.size > 0 && checked.size === sortedEvents.length}
              ref={(el) => {
                if (el) el.indeterminate = checked.size > 0 && checked.size < sortedEvents.length
              }}
              onChange={toggleAll}
            />
            <span className="text-gray-700">
              {checked.size > 0 ? `Wybrane: ${checked.size}` : `Wybierz wszystkie (${sortedEvents.length})`}
            </span>
          </label>
          <div className="grow" />
          {bulkProgress ? (
            <span className="text-xs text-blue-700">
              Przetwarzanie {bulkProgress.done}/{bulkProgress.total}…
            </span>
          ) : (
            <>
              <button
                onClick={() => {
                  const targets = checked.size > 0
                    ? checkedOpen
                    : openEvents
                  bulkAction(targets, 'resolve', 'Obsłużono')
                }}
                disabled={openEvents.length === 0 && checkedOpen.length === 0}
                className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-40"
              >
                {checked.size > 0
                  ? `Oznacz wybrane jako obsłużone (${checkedOpen.length})`
                  : `Obsłużone wszystkie nieobsłużone (${openEvents.length})`}
              </button>
              <button
                onClick={() => {
                  const targets = checked.size > 0
                    ? checkedOpen
                    : openEvents
                  bulkAction(targets, 'false-positive', 'Fałszywe alarmy')
                }}
                disabled={openEvents.length === 0 && checkedOpen.length === 0}
                className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 text-xs font-semibold hover:bg-gray-50 disabled:opacity-40"
              >
                Fałszywe alarmy{checked.size > 0 ? ` (${checkedOpen.length})` : ''}
              </button>
              {checked.size > 0 && (
                <button
                  onClick={() => setChecked(new Set())}
                  className="text-xs text-gray-500 hover:text-gray-900 ml-1"
                >
                  Wyczyść
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Lista kart */}
      {sortedEvents.length === 0 && !loading ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          Brak zdarzeń w wybranym oknie czasowym.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {sortedEvents.map((ev) => (
            <EventCard
              key={ev.id}
              ev={ev}
              imageUrl={imageBlobs[ev.id]}
              selected={checked.has(ev.id)}
              onToggle={canResolve ? () => toggleOne(ev.id) : undefined}
              onClick={() => setSelected(ev)}
            />
          ))}
        </div>
      )}

      {/* Modal szczegółów */}
      {selected && (
        <DetailModal
          ev={selected}
          imageUrl={imageBlobs[selected.id]}
          canResolve={canResolve}
          actioning={actioning === selected.id}
          onResolve={() => doResolve(selected)}
          onFalsePositive={() => doFalsePositive(selected)}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 px-4 py-2 rounded-lg shadow-lg z-50 text-sm ${
            toast.kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  )
}

// ── Subcomponents ───────────────────────────────────────────────────────────

function StatCard({
  label, value, tone = 'default',
}: {
  label: string
  value: number
  tone?: 'default' | 'red' | 'blue' | 'gray'
}) {
  const toneCls = {
    default: 'border-gray-200 bg-white text-gray-700',
    red:     'border-red-200 bg-red-50 text-red-700',
    blue:    'border-blue-200 bg-blue-50 text-blue-700',
    gray:    'border-gray-200 bg-gray-50 text-gray-600',
  }[tone]
  return (
    <div className={`rounded-lg border ${toneCls} px-3 py-2`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  )
}

function EventCard({
  ev, imageUrl, onClick, selected = false, onToggle,
}: {
  ev: AnomalyEvent
  imageUrl?: string
  onClick: () => void
  selected?: boolean
  onToggle?: () => void
}) {
  const status = statusOf(ev)
  const badge = STATUS_BADGE[status]
  const isOpen = status === 'OPEN'
  return (
    <div
      onClick={onClick}
      className={`text-left rounded-xl border bg-white overflow-hidden hover:shadow-md transition group cursor-pointer ${
        selected
          ? 'border-blue-400 ring-2 ring-blue-300'
          : isOpen
            ? 'border-red-300 ring-1 ring-red-200'
            : 'border-gray-200'
      }`}
    >
      {/* Thumbnail */}
      <div className="aspect-video bg-gray-100 relative overflow-hidden">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="frame" className="w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400">
            {ev.imageFilename ? '⏳ Ładowanie…' : '—'}
          </div>
        )}
        {onToggle && (
          <label
            className="absolute top-2 left-2 z-10 inline-flex items-center justify-center w-6 h-6 rounded-md bg-white/90 backdrop-blur shadow border border-gray-300 cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              className="w-4 h-4 accent-blue-600"
              aria-label="Zaznacz do bulk akcji"
            />
          </label>
        )}
        <div className={`absolute ${onToggle ? 'top-2 left-10' : 'top-2 left-2'} px-2 py-0.5 rounded-md text-xs font-semibold bg-black/60 text-white backdrop-blur`}>
          {TYPE_ICON[ev.type] ?? '⚠'} {TYPE_LABEL[ev.type] ?? ev.type}
        </div>
        <div className="absolute top-2 right-2 px-2 py-0.5 rounded-md text-xs font-bold bg-red-600 text-white">
          {Math.round(ev.likelihood * 100)}%
        </div>
      </div>
      {/* Footer */}
      <div className="p-3 space-y-1">
        <div className="flex items-center justify-between">
          <span className={`px-2 py-0.5 rounded text-xs border ${badge.cls}`}>
            {badge.label}
          </span>
          <span className="text-xs text-gray-500">{relativeTime(ev.ts)}</span>
        </div>
        <div className="text-sm text-gray-900 font-medium">
          {formatTs(ev.ts)}
        </div>
        <div className="text-xs text-gray-500 truncate">
          Kamera: {ev.cameraDeviceId.slice(0, 8)}…
        </div>
        {ev.indicators.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {ev.indicators.slice(0, 3).map((ind) => (
              <span key={ind} className="text-[10px] px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 border border-orange-200">
                {indicatorLabel(ind)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DetailModal({
  ev, imageUrl, canResolve, actioning, onResolve, onFalsePositive, onClose,
}: {
  ev: AnomalyEvent
  imageUrl?: string
  canResolve: boolean
  actioning: boolean
  onResolve: () => void
  onFalsePositive: () => void
  onClose: () => void
}) {
  const status = statusOf(ev)
  const badge = STATUS_BADGE[status]
  return (
    <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Czerwony header gdy nieobsłużone */}
        <div className={`px-5 py-4 border-b flex items-center justify-between ${
          status === 'OPEN' ? 'bg-gradient-to-r from-red-600 to-orange-500 text-white' : 'bg-gray-50'
        }`}>
          <div>
            <div className="text-xs uppercase tracking-wider opacity-80">{TYPE_ICON[ev.type] ?? '⚠'} {TYPE_LABEL[ev.type] ?? ev.type}</div>
            <div className="text-xl font-bold">
              {Math.round(ev.likelihood * 100)}% prawdopodobieństwo
            </div>
          </div>
          <button onClick={onClose} className={`text-2xl ${
            status === 'OPEN' ? 'text-white/80 hover:text-white' : 'text-gray-400 hover:text-gray-900'
          }`}>×</button>
        </div>

        {/* JPEG */}
        <div className="bg-black">
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imageUrl} alt="frame" className="w-full max-h-[60vh] object-contain mx-auto" />
          ) : (
            <div className="aspect-video flex items-center justify-center text-gray-400 text-sm">
              {ev.imageFilename ? 'Ładowanie klatki…' : 'Brak obrazu'}
            </div>
          )}
        </div>

        {/* Meta */}
        <div className="p-5 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className={`px-2 py-1 rounded text-xs border ${badge.cls}`}>{badge.label}</span>
            <span className="text-xs text-gray-500">ID: {ev.id}</span>
          </div>
          <Row label="Czas" value={formatTs(ev.ts)} />
          <Row label="Kamera" value={ev.cameraDeviceId} mono />
          {ev.resolvedAt && (
            <>
              <Row label="Obsłużono" value={formatTs(ev.resolvedAt)} />
              {ev.resolvedBy && <Row label="Przez" value={ev.resolvedBy} mono />}
            </>
          )}
          {ev.indicators.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-600 mb-1">Wskaźniki algorytmu</div>
              <div className="flex flex-wrap gap-1">
                {ev.indicators.map((ind) => (
                  <span key={ind} className="text-xs px-2 py-1 rounded bg-orange-50 text-orange-700 border border-orange-200">
                    ✓ {indicatorLabel(ind)}
                  </span>
                ))}
              </div>
              <div className="text-[11px] text-gray-500 mt-2">
                Algorytm sprawdza 4 oznaki upadku. Im więcej zaznaczonych jednocześnie, tym wyższa pewność. ≥2/4 = alarm (likelihood ≥50%).
              </div>
            </div>
          )}
        </div>

        {/* Akcje */}
        {canResolve && status === 'OPEN' && (
          <div className="px-5 py-4 border-t flex gap-2 justify-end bg-gray-50">
            <button
              onClick={onFalsePositive}
              disabled={actioning}
              className="px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50 text-sm"
            >
              Fałszywy alarm
            </button>
            <button
              onClick={onResolve}
              disabled={actioning}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 text-sm font-semibold"
            >
              {actioning ? 'Zapisuję…' : 'Obsłużone'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex">
      <div className="w-32 text-xs text-gray-500">{label}</div>
      <div className={`text-sm text-gray-900 ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  )
}
