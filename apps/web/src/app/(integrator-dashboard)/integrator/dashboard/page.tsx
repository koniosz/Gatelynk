'use client'
/**
 * IntegratorDashboardPage — `/integrator/dashboard` (FAZA f, 2026-06-02).
 *
 * Pierwsza strona po login integratora. Agreguje stan portfolio:
 *   - Header z relative "ostatnia aktualizacja"
 *   - 4 totals stats cards
 *   - Filtry (online/offline/alerts) + sort + search
 *   - Lista kart budynków z Edge status + statystyki + computed health
 *
 * Polling co 30s (`setInterval`). Refresh-button w Topbar (`integrator:refresh`
 * event) wymusza natychmiastowy fetch.
 *
 * Active property w sidebarze jest CZYSZCZONY na mount (dashboard to nie
 * konkretny budynek — globalny widok).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { LayoutDashboard, AlertTriangle, Building2 } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { useActiveProperty } from '@/components/integrator/active-property-context'
import { Spinner } from '@/components/integrator/property/shared/Spinner'
import { IntegratorDashboardStats } from './IntegratorDashboardStats'
import {
  IntegratorDashboardFilters,
  type StatusFilter,
  type SortKey,
} from './IntegratorDashboardFilters'
import { IntegratorBuildingCard, type BuildingCardData } from './IntegratorBuildingCard'

interface DashboardResponse {
  generatedAt: string
  totals: {
    buildings: number
    online: number
    offline: number
    withAnomalies24h: number
    withFailedOutbox: number
  }
  buildings: BuildingCardData[]
}

const POLL_INTERVAL_MS = 30_000

export default function IntegratorDashboardPage() {
  const router = useRouter()
  const { clear: clearActive } = useActiveProperty()

  const [data, setData] = useState<DashboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortBy, setSortBy] = useState<SortKey>('status')
  const [search, setSearch] = useState('')

  // Czyść aktywny obiekt przy wejściu na dashboard (globalny widok).
  useEffect(() => { clearActive() }, [clearActive])

  const fetchDashboard = useCallback(
    async (background = false) => {
      if (!background) setLoading(true)
      try {
        const res = await integratorApi.get<DashboardResponse>('/integrator/dashboard')
        setData(res.data)
        setError(null)
      } catch (err: any) {
        if (err?.response?.status === 401) {
          router.push('/integrator/login')
          return
        }
        setError(err?.response?.data?.message ?? err?.message ?? 'Błąd ładowania danych')
      } finally {
        if (!background) setLoading(false)
      }
    },
    [router],
  )

  // Initial fetch + polling co 30s + refresh button event listener.
  useEffect(() => {
    fetchDashboard(false)
    const onRefresh = () => fetchDashboard(false)
    window.addEventListener('integrator:refresh', onRefresh)
    const interval = setInterval(() => fetchDashboard(true), POLL_INTERVAL_MS)
    return () => {
      window.removeEventListener('integrator:refresh', onRefresh)
      clearInterval(interval)
    }
  }, [fetchDashboard])

  const criticalCount = useMemo(
    () => data?.buildings.filter((b) => b.health.status === 'critical').length ?? 0,
    [data],
  )

  const filteredBuildings = useMemo(() => {
    if (!data) return []
    let list = [...data.buildings]
    // Filter
    if (statusFilter === 'online') list = list.filter((b) => b.edge.online)
    else if (statusFilter === 'offline') list = list.filter((b) => !b.edge.online)
    else if (statusFilter === 'alerts') list = list.filter((b) => b.health.status !== 'ok')
    // Search
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.address.toLowerCase().includes(q),
      )
    }
    // Sort
    const rank = (s: 'ok' | 'warning' | 'critical') => (s === 'critical' ? 0 : s === 'warning' ? 1 : 2)
    if (sortBy === 'status') {
      list.sort((a, b) => {
        const r = rank(a.health.status) - rank(b.health.status)
        if (r !== 0) return r
        return a.name.localeCompare(b.name, 'pl')
      })
    } else if (sortBy === 'name') {
      list.sort((a, b) => a.name.localeCompare(b.name, 'pl'))
    } else {
      list.sort((a, b) => b.stats.anomaliesLast24h - a.stats.anomaliesLast24h)
    }
    return list
  }, [data, statusFilter, sortBy, search])

  const lastUpdated = data?.generatedAt
    ? new Date(data.generatedAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink flex items-center gap-2">
            <LayoutDashboard size={20} strokeWidth={1.8} className="text-brand" />
            Dashboard
          </h1>
          <p className="text-[13px] text-muted mt-1">
            Zbiorczy widok portfolio · polling co 30s
          </p>
        </div>
        {lastUpdated && (
          <div className="text-[12px] text-muted">
            Ostatnia aktualizacja: <strong className="text-ink">{lastUpdated}</strong>
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-danger-50 border border-danger/30 text-danger text-[13px] rounded-r3 p-3 flex items-center gap-2">
          <AlertTriangle size={14} strokeWidth={2} /> {error}
        </div>
      )}

      {/* Loading initial */}
      {loading && !data ? (
        <div className="flex items-center gap-2 py-12 text-muted text-[13px]">
          <Spinner size={14} /> Ładowanie dashboardu…
        </div>
      ) : !data || data.buildings.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <IntegratorDashboardStats totals={data.totals} criticalCount={criticalCount} />
          <IntegratorDashboardFilters
            statusFilter={statusFilter}
            onStatusChange={setStatusFilter}
            sortBy={sortBy}
            onSortChange={setSortBy}
            search={search}
            onSearchChange={setSearch}
          />

          {filteredBuildings.length === 0 ? (
            <div className="bg-surface border border-border rounded-r3 p-8 text-center">
              <AlertTriangle size={28} strokeWidth={1.5} className="text-muted-2 mx-auto mb-2" />
              <h3 className="text-[14px] font-semibold text-ink mb-1">Brak wyników</h3>
              <p className="text-[12px] text-muted">
                Zmień filtr lub wyczyść wyszukiwanie.
              </p>
            </div>
          ) : (
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))' }}
            >
              {filteredBuildings.map((b) => (
                <IntegratorBuildingCard key={b.id} building={b} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="bg-surface border border-border rounded-r3 p-12 text-center">
      <Building2 size={40} strokeWidth={1.5} className="text-muted-2 mx-auto mb-4" />
      <h3 className="text-base font-semibold text-ink mb-1">Brak obiektów w portfolio</h3>
      <p className="text-[13px] text-muted mb-4 max-w-md mx-auto">
        Nie masz jeszcze żadnych budynków. Skontaktuj się z administratorem
        GateLynk, aby dodać pierwszy obiekt — lub przejdź do listy obiektów żeby
        sprawdzić ustawienia konta.
      </p>
      <a
        href="https://docs.gatelynk.com/integrator/getting-started"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center text-[12px] font-medium text-brand hover:text-brand-600 underline"
      >
        Jak dodać pierwszy budynek? (dokumentacja)
      </a>
    </div>
  )
}
