'use client'
/**
 * IntegratorDashboardFilters (FAZA f, 2026-06-02).
 *
 * Pasek filtrów dla listy budynków w dashboardzie. Wzorzec wzięty z
 * `EdgesPage` (pille all/online/offline + select). Tutaj rozszerzony o
 * "alerty" filter (warning|critical) + sort (status > name > anomalies).
 */
type StatusFilter = 'all' | 'online' | 'offline' | 'alerts'
type SortKey = 'status' | 'name' | 'anomalies'

interface Props {
  statusFilter: StatusFilter
  onStatusChange: (f: StatusFilter) => void
  sortBy: SortKey
  onSortChange: (s: SortKey) => void
  search: string
  onSearchChange: (q: string) => void
}

export function IntegratorDashboardFilters({
  statusFilter,
  onStatusChange,
  sortBy,
  onSortChange,
  search,
  onSearchChange,
}: Props) {
  return (
    <div className="bg-surface border border-border rounded-r3 p-3 flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-muted-2 uppercase font-semibold tracking-wider mr-2">
          Filtr:
        </span>
        {(
          [
            { v: 'all', label: 'Wszystkie' },
            { v: 'online', label: 'Online' },
            { v: 'offline', label: 'Offline' },
            { v: 'alerts', label: 'Z alertami' },
          ] as { v: StatusFilter; label: string }[]
        ).map((f) => (
          <button
            key={f.v}
            onClick={() => onStatusChange(f.v)}
            className={`px-2.5 py-1 text-[12px] font-medium rounded-r1 transition-colors ${
              statusFilter === f.v
                ? 'bg-brand text-white'
                : 'text-muted hover:text-ink hover:bg-surface-2'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-2 uppercase font-semibold tracking-wider">
          Sort:
        </span>
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          className="text-[12px] bg-surface border border-border rounded-r1 px-2 py-1 text-ink"
        >
          <option value="status">Wg statusu (problemy ↑)</option>
          <option value="name">Wg nazwy A-Z</option>
          <option value="anomalies">Wg anomalii 24h</option>
        </select>
      </div>

      <input
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Szukaj po nazwie lub adresie…"
        className="flex-1 min-w-[200px] text-[12px] bg-surface border border-border rounded-r1 px-3 py-1.5 text-ink placeholder:text-muted-2 focus:outline-none focus:border-brand"
      />
    </div>
  )
}

export type { StatusFilter, SortKey }
