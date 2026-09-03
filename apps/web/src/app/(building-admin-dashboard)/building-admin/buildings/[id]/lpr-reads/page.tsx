'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { buildingAdminApi } from '@/lib/building-admin-api'
import {
  LprRead,
  brandLabel, colorLabel, colorSwatch, formatReadTs,
  ownerDisplay, vehicleTypePl,
} from '@/lib/lpr'
import { LprViewer } from '@/components/LprViewer'
import { LazyLprThumbnail } from '@/components/LazyLprThumbnail'
import { TagChips } from '@/components/TagPicker'
import { Pagination, usePagination, useDebouncedValue } from '@/components/Pagination'

/**
 * Building-admin LPR reads — scoped to a single building via the URL:
 *   /building-admin/buildings/:id/lpr-reads
 *
 * W tej wersji wyszukiwanie + paginacja są server-side: query trafia do
 * `?q=...&offset=...&limit=...&identified=...`, Postgres robi ILIKE/COUNT na
 * całym 30-dniowym oknie i zwraca stronę + total. Dzięki temu „live search"
 * widzi wszystkie wpisy w bazie (a nie tylko top-200 załadowane na klienta).
 *
 * Klik w miniaturę / „Identyfikuj…" otwiera pełnoekranową przeglądarkę
 * (`<LprViewer/>`) — duży podgląd zdjęcia + boczny panel z klasyfikacją,
 * nawigacja strzałkami ← / → po aktualnie załadowanej stronie.
 */
type FilterKey = 'all' | 'unidentified' | 'residents' | 'services'

const FILTER_PARAM: Record<FilterKey, Record<string, string>> = {
  all:          {},
  unidentified: { identified: 'false' },
  residents:    { identified: 'true' },
  services:     { identified: 'true' },
  // RESIDENT vs SERVICE rozdzielamy lokalnie po `vehicleKind` w obrębie
  // aktualnej strony — patrz `visible` poniżej.
}

export default function BaBuildingLprReadsPage() {
  const params = useParams<{ id: string }>()
  const buildingId = Number(params.id)

  const [building, setBuilding] = useState<any | null>(null)
  const [reads, setReads] = useState<LprRead[]>([])
  const [total, setTotal] = useState(0)
  const [loadingReads, setLoadingReads] = useState(true)

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 300)
  const [filter, setFilter] = useState<FilterKey>('all')
  // Filtr po konkretnym dniu (YYYY-MM-DD, czas lokalny). '' = całe 30-dniowe okno.
  const [day, setDay] = useState('')
  const { page, pageSize, offset, setPage, setPageSize, resetToFirstPage } = usePagination(50)

  const [viewerIndex, setViewerIndex] = useState<number | null>(null)

  // Granice kalendarza = okno retencji (dziś − 30 dni … dziś).
  const isoDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const todayIso = isoDay(new Date())
  const minIso = isoDay(new Date(Date.now() - 30 * 86_400_000))

  // Reset do strony 1 przy zmianie filtrów / wyszukiwarki / dnia — żeby user nie
  // utknął na pustej stronie 5 z 0 wynikami.
  useEffect(() => { resetToFirstPage() }, [debouncedSearch, filter, day, resetToFirstPage])

  // Lekki fetch nagłówka budynku — potrzebujemy tylko nazwy w tytule strony.
  useEffect(() => {
    if (!buildingId) return
    buildingAdminApi
      .get(`/building-admin/buildings/${buildingId}`)
      .then((res) => setBuilding(res.data))
      .catch(() => { /* 401/404 obsłużone globalnie */ })
  }, [buildingId])

  const loadReads = useCallback(() => {
    if (!buildingId) return
    setLoadingReads(true)
    const qs = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
    })
    if (debouncedSearch.trim()) qs.set('q', debouncedSearch.trim())
    if (day) qs.set('day', day)
    Object.entries(FILTER_PARAM[filter]).forEach(([k, v]) => qs.set(k, v))

    buildingAdminApi
      .get(`/building-admin/buildings/${buildingId}/lpr-reads?${qs.toString()}`)
      .then((res) => {
        setReads(res.data.reads as LprRead[])
        setTotal(res.data.total ?? 0)
      })
      .catch((err) => {
        if (err?.response?.status !== 401) console.error(err)
      })
      .finally(() => setLoadingReads(false))
  }, [buildingId, pageSize, offset, debouncedSearch, filter, day])

  useEffect(() => { loadReads() }, [loadReads])

  // Lokalny refine dla mieszkańcy/usługi — patrz komentarz przy FILTER_PARAM.
  const visible = reads.filter((r) => {
    if (filter === 'residents' && r.vehicleKind && r.vehicleKind !== 'RESIDENT') return false
    if (filter === 'services' && (!r.vehicleKind || r.vehicleKind === 'RESIDENT')) return false
    return true
  })

  const openViewer = (read: LprRead) => {
    const idx = visible.findIndex(r => r.id === read.id)
    if (idx >= 0) setViewerIndex(idx)
  }

  return (
    <div className="max-w-5xl">
      {/* Header — breadcrumb wraca do konkretnego budynku, a nie do listy. */}
      <div className="mb-6">
        <Link
          href={`/building-admin/buildings/${buildingId}`}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          ← {building?.name ?? 'Obiekt'}
        </Link>
        <div className="flex items-center justify-between mt-1">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">📸 Odczyty tablic</h1>
            <p className="text-sm text-gray-500 mt-1">
              Przejazdy z kamer LPR z ostatnich 30 dni. Wyszukiwarka działa
              na pełnym zakresie. Możesz przypisać nieznane auto do mieszkańca
              albo zarejestrować usługę (np. dostawę, śmieciarkę).
            </p>
          </div>
          <button
            onClick={loadReads}
            className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 whitespace-nowrap"
          >
            ↻ Odśwież
          </button>
        </div>
      </div>

      {/* Filtry */}
      <div className="bg-white rounded-xl border border-gray-200 p-3 mb-4 flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Szukaj (tablica, mieszkaniec, marka, mieszkanie)…"
          className="flex-1 min-w-[240px] border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        {/* Wybór dnia z kalendarza — odczyty tylko z tej daty (czas lokalny).
            Pusty = całe 30-dniowe okno. Granice = okno retencji. */}
        <div className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm ${day ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
          <span className="text-gray-400">📅</span>
          <input
            type="date"
            value={day}
            min={minIso}
            max={todayIso}
            onChange={(e) => setDay(e.target.value)}
            aria-label="Dzień odczytów"
            className="bg-transparent outline-none text-gray-700"
          />
          {day ? (
            <button
              type="button"
              onClick={() => setDay('')}
              aria-label="Wyczyść dzień"
              className="text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setDay(todayIso)}
              title="Pokaż tylko dzisiejsze"
              className="text-xs text-gray-400 hover:text-gray-600 whitespace-nowrap"
            >
              Dziś
            </button>
          )}
        </div>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
          {([
            ['all',          'Wszystkie'],
            ['unidentified', 'Nieprzypisane'],
            ['residents',    '👤 Mieszkańcy'],
            ['services',     '🚛 Usługi'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 border-l border-gray-200 first:border-l-0 ${
                filter === key
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loadingReads ? (
          <div className="p-8 text-center text-gray-400 text-sm">Ładowanie odczytów…</div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            {debouncedSearch.trim()
              ? <>Brak wpisów dla zapytania „{debouncedSearch}".</>
              : 'Brak odczytów dla wybranych filtrów.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2 w-20">Zdjęcie</th>
                <th className="px-3 py-2">Tablica</th>
                <th className="px-3 py-2">Pojazd</th>
                <th className="px-3 py-2">Właściciel / Kategoria</th>
                <th className="px-3 py-2">Czas</th>
                <th className="px-3 py-2">Brama</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <ReadRow
                  key={r.id}
                  read={r}
                  buildingId={buildingId}
                  onOpenViewer={() => openViewer(r)}
                />
              ))}
            </tbody>
          </table>
        )}
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      {viewerIndex !== null && visible[viewerIndex] && (
        <LprViewer
          reads={visible}
          initialIndex={viewerIndex}
          apiClient={buildingAdminApi}
          buildImageUrl={(id) => `/building-admin/buildings/${buildingId}/lpr-reads/${id}/image`}
          buildVehiclesUrl={() => `/building-admin/buildings/${buildingId}/vehicles`}
          buildVehicleUrl={(id) => `/building-admin/buildings/${buildingId}/vehicles/${id}`}
          buildResidentsUrl={() => `/building-admin/buildings/${buildingId}/residents`}
          buildServiceNamesUrl={() => `/building-admin/buildings/${buildingId}/vehicle-service-names`}
          buildVehicleTagsUrl={() => `/building-admin/buildings/${buildingId}/vehicle-tags`}
          onClose={() => setViewerIndex(null)}
          onSaved={loadReads}
        />
      )}
    </div>
  )
}

// ── Row ──────────────────────────────────────────────────────────────────────
function ReadRow({
  read: r,
  buildingId,
  onOpenViewer,
}: {
  read: LprRead
  buildingId: number
  onOpenViewer: () => void
}) {
  const brand = brandLabel(r) || '—'
  const color = colorLabel(r)
  const swatch = colorSwatch(r.vehicleColorStored ?? r.vehicleColor)
  const type = vehicleTypePl(r.vehicleType)
  const owner = ownerDisplay(r)

  return (
    <tr className="border-b border-gray-50 hover:bg-blue-50/40">
      <td className="px-3 py-2">
        {r.hasImage ? (
          <LazyLprThumbnail
            apiClient={buildingAdminApi}
            url={`/building-admin/buildings/${buildingId}/lpr-reads/${r.id}/image`}
            onClick={onOpenViewer}
            className="w-16 h-12 rounded hover:ring-2 hover:ring-blue-400 transition"
          />
        ) : (
          <div className="w-16 h-12 rounded bg-gray-100 flex items-center justify-center text-gray-300 text-xs">
            —
          </div>
        )}
      </td>
      <td className="px-3 py-2 font-mono font-semibold uppercase text-gray-900">
        {r.plate}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            {swatch && (
              <span
                className="inline-block w-2.5 h-2.5 rounded-full border border-gray-300"
                style={{ backgroundColor: swatch }}
              />
            )}
            <span className={brand === '—' ? 'text-gray-400' : 'font-medium text-gray-900'}>
              {brand}
            </span>
          </div>
          {(type || color) && (
            <span className="text-xs text-gray-500">
              {[type, color].filter(Boolean).join(' · ')}
            </span>
          )}
          {r.vehicleTags && r.vehicleTags.length > 0 && (
            <TagChips tags={r.vehicleTags} max={3} className="mt-0.5" />
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        {owner ? (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              {owner.icon && owner.badgeClass && (
                <span className={`text-xs px-1.5 py-0.5 rounded ${owner.badgeClass}`}>
                  {owner.icon}
                </span>
              )}
              <span className="text-gray-800">{owner.primary}</span>
            </div>
            {owner.secondary && (
              <span className="text-xs text-gray-400">{owner.secondary}</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-gray-400 italic">nieznany</span>
        )}
      </td>
      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatReadTs(r.ts)}</td>
      <td className="px-3 py-2">
        {r.gateOpened ? (
          <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 rounded px-1.5 py-0.5">
            ✓ otwarta
          </span>
        ) : r.matched ? (
          <span className="text-xs text-amber-600">przypisana, nie otwarto</span>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <button
          onClick={onOpenViewer}
          className={`text-xs px-2.5 py-1 rounded-lg ${
            r.vehicleId
              ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          {r.vehicleId ? 'Podgląd' : 'Identyfikuj…'}
        </button>
      </td>
    </tr>
  )
}

// Lokalny eager `Thumbnail` zastąpiony współdzielonym `LazyLprThumbnail`
// (2026-06-12) — lazy IntersectionObserver + semafor max 4 fetche + retry.
// Patrz `apps/web/src/components/LazyLprThumbnail.tsx`.
