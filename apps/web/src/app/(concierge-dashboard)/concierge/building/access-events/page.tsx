'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { conciergeApi } from '@/lib/concierge-api'
import {
  AccessEvent,
  AccessEventType,
  TYPE_LABEL,
  TYPE_ICON,
  typeBadgeClass,
  formatEventTs,
  eventPrimary,
  eventSecondary,
  gateStatus,
  gateStatusClass,
} from '@/lib/access-events'
import { Pagination, usePagination, useDebouncedValue } from '@/components/Pagination'

/**
 * Concierge — feed `access_events` (Faza 3 Villa Natura). Single source of
 * truth dla „kto i jak wszedł do budynku" — sklejony LPR + PIN + remote-open.
 *
 * Filtry (wszystkie po stronie servera, więc obejmują pełne 30 dni audytu):
 *   • typ eventu (chip-row) → query `?type=`
 *   • free-text (search z 300ms debounce) → query `?q=`
 *   • paginacja (offset/limit) — przyciski w stopce tabeli
 *
 * `q` szuka po wszystkich kolumnach: plate, residentName, guestName,
 * openedByName, accessPointLabel, unitNumber, reason, brand, model.
 * Patrz `AccessEventsService.listForBuilding()` — full server-side scan
 * po dynamicznie sklejonym WHERE.
 */

type FilterType = 'ALL' | AccessEventType

const TYPE_FILTERS: { key: FilterType; label: string; icon: string }[] = [
  { key: 'ALL',           label: 'Wszystkie',           icon: '🗂' },
  { key: 'LPR_MATCH',     label: TYPE_LABEL.LPR_MATCH,     icon: TYPE_ICON.LPR_MATCH },
  { key: 'LPR_NO_MATCH',  label: TYPE_LABEL.LPR_NO_MATCH,  icon: TYPE_ICON.LPR_NO_MATCH },
  { key: 'PIN_USED',      label: TYPE_LABEL.PIN_USED,      icon: TYPE_ICON.PIN_USED },
  { key: 'REMOTE_OPEN',   label: TYPE_LABEL.REMOTE_OPEN,   icon: TYPE_ICON.REMOTE_OPEN },
  { key: 'MANUAL_OPEN',   label: TYPE_LABEL.MANUAL_OPEN,   icon: TYPE_ICON.MANUAL_OPEN },
  { key: 'INTERCOM_CALL', label: TYPE_LABEL.INTERCOM_CALL, icon: TYPE_ICON.INTERCOM_CALL },
]

export default function ConciergeAccessEventsPage() {
  const [events, setEvents] = useState<AccessEvent[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterType>('ALL')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 300)
  const { page, pageSize, offset, setPage, setPageSize, resetToFirstPage } = usePagination(50)

  // Reset do strony 1 przy każdej zmianie filtrów / wyszukiwarki — inaczej
  // user mógłby trafić na pustą stronę 5 mimo że wyników jest tylko 12.
  useEffect(() => { resetToFirstPage() }, [debouncedSearch, filter, resetToFirstPage])

  const load = useCallback(() => {
    setLoading(true)
    const params = new URLSearchParams()
    params.set('limit', String(pageSize))
    params.set('offset', String(offset))
    if (filter !== 'ALL') params.set('type', filter)
    const q = debouncedSearch.trim()
    if (q) params.set('q', q)
    conciergeApi
      .get(`/concierge/access-events?${params.toString()}`)
      .then((res) => {
        setEvents(res.data.events as AccessEvent[])
        setTotal(typeof res.data.total === 'number' ? res.data.total : 0)
      })
      .catch((err) => {
        if (err?.response?.status !== 401) console.error(err)
      })
      .finally(() => setLoading(false))
  }, [pageSize, offset, filter, debouncedSearch])

  useEffect(() => { load() }, [load])

  // Stats — tylko z aktualnej strony, bo nie chcemy biło COUNT(*) z trzech
  // dodatkowych zapytań tylko dla 3 cyfr na nagłówku. Dla pełnej dokładności
  // można dorobić osobny `/access-events/stats?since=today` w F4/F5.
  const stats = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const todayMs = today.getTime()
    let lprToday = 0, pinToday = 0, rejectedToday = 0
    for (const ev of events) {
      if (new Date(ev.ts).getTime() < todayMs) continue
      if (ev.type === 'LPR_MATCH' && ev.gateOpened) lprToday++
      if (ev.type === 'PIN_USED' && ev.gateOpened)  pinToday++
      if (!ev.gateOpened)                            rejectedToday++
    }
    return { lprToday, pinToday, rejectedToday }
  }, [events])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🚪 Wejścia do budynku</h1>
          <p className="text-sm text-gray-500 mt-1">
            Pełen audit: tablice z LPR, PIN-y gości, otwarcia zdalne.
            Wyszukiwarka działa na całych 30 dniach historii.
          </p>
        </div>
        <button
          onClick={load}
          className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50"
        >
          ↻ Odśwież
        </button>
      </div>

      {/* Stats (z bieżącej strony) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <StatCard icon="🚗" label="Wjazdy LPR dziś (str.)" value={stats.lprToday} accent="emerald" />
        <StatCard icon="🔢" label="PIN-y gości dziś (str.)" value={stats.pinToday} accent="blue" />
        <StatCard icon="⛔" label="Odrzucone dziś (str.)"   value={stats.rejectedToday} accent="rose" />
      </div>

      {/* Filtry */}
      <div className="bg-white rounded-xl border border-gray-200 p-3 mb-4 flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Szukaj (tablica, mieszkaniec, gość, brama)…"
          className="flex-1 min-w-[200px] border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <div className="flex flex-wrap rounded-lg border border-gray-200 overflow-hidden text-sm">
          {TYPE_FILTERS.map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 border-l border-gray-200 first:border-l-0 ${
                filter === key
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              <span className="mr-1">{icon}</span>{label}
            </button>
          ))}
        </div>
      </div>

      {/* Tabela */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Ładowanie…</div>
        ) : events.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">
            Brak wpisów dla wybranych filtrów.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2 w-32">Typ</th>
                <th className="px-3 py-2">Kto / Co</th>
                <th className="px-3 py-2">Brama (urządz.)</th>
                <th className="px-3 py-2 w-40">Status</th>
                <th className="px-3 py-2">Otwierał</th>
                <th className="px-3 py-2 w-32 text-right">Czas</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => {
                const gs = gateStatus(ev)
                return (
                <tr key={ev.id} className="border-b border-gray-50 hover:bg-blue-50/40">
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${typeBadgeClass(ev.type, ev.gateOpened)}`}>
                      <span>{TYPE_ICON[ev.type]}</span>
                      {TYPE_LABEL[ev.type]}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-gray-900">{eventPrimary(ev)}</span>
                      {eventSecondary(ev) && (
                        <span className="text-xs text-gray-500">{eventSecondary(ev)}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {ev.accessPointLabel ?? <span className="text-gray-400 italic">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${gateStatusClass(gs.tone)}`}
                      title={gs.hint}
                    >
                      {gs.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {ev.openedByName ?? <span className="text-gray-400 italic">—</span>}
                    {ev.openedByType && (
                      <span className="ml-1 text-xs text-gray-400">({roleLabel(ev.openedByType)})</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">
                    {formatEventTs(ev.ts)}
                  </td>
                </tr>
              )
              })}
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
    </div>
  )
}

function StatCard({
  icon, label, value, accent,
}: { icon: string; label: string; value: number; accent: 'emerald' | 'blue' | 'rose' }) {
  const palette = {
    emerald: 'bg-emerald-50 border-emerald-100 text-emerald-800',
    blue:    'bg-blue-50 border-blue-100 text-blue-800',
    rose:    'bg-rose-50 border-rose-100 text-rose-800',
  }[accent]
  return (
    <div className={`rounded-xl border px-4 py-3 flex items-center gap-3 ${palette}`}>
      <div className="text-2xl">{icon}</div>
      <div className="flex-1">
        <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
        <div className="text-2xl font-bold">{value}</div>
      </div>
    </div>
  )
}

function roleLabel(t: string): string {
  switch (t) {
    case 'RESIDENT':  return 'mieszkaniec'
    case 'ADMIN':     return 'admin'
    case 'CONCIERGE': return 'portier'
    case 'EDGE':      return 'edge'
    case 'SYSTEM':    return 'system'
    default:          return t.toLowerCase()
  }
}
