'use client'
/**
 * EdgesPage (handoff §5 `<EdgesPage>`).
 *
 * Globalna tabela wszystkich Edge ze wszystkich obiektów integratora.
 * Pozwala monitorować portfolio bez wchodzenia w każdy property osobno.
 *
 * Kolumny:
 *   - nazwa
 *   - obiekt (link do PropertyPage)
 *   - IP (mono font)
 *   - firmware
 *   - last seen (czas relatywny: „2 min temu")
 *   - status pill (online/offline)
 *   - deeplink „Otwórz UI →" (proxy do panelu Edge klienta)
 *
 * Filtry (top-of-page):
 *   - po nazwie obiektu
 *   - po statusie (online/offline)
 *   - po firmware version
 *
 * Sesja 4 wprowadzi deeplink SSO zamiast bezpośredniego linku http://IP:4000/ui.
 */
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Server, ExternalLink, AlertTriangle, Building2 } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { openEdgeUI } from '@/lib/integrator-deeplink'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

interface EdgeRow {
  id: string  // CUID z Prisma
  type: string
  name?: string | null
  isOnline: boolean
  lastSeenAt?: string | null
  ipAddress?: string | null
  version?: string | null
  building: {
    id: number
    name: string
    address: string
    objectType?: string
  }
}

export default function EdgesPage() {
  const router = useRouter()
  const [edges, setEdges] = useState<EdgeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all')
  const [propertyQuery, setPropertyQuery] = useState('')

  useEffect(() => {
    const fetch = () => {
      setLoading(true)
      integratorApi.get('/integrator/edges')
        .then((r) => setEdges(r.data))
        .catch((err) => {
          if (err?.response?.status === 401) router.push('/integrator/login')
        })
        .finally(() => setLoading(false))
    }
    fetch()
    const onRefresh = () => fetch()
    window.addEventListener('integrator:refresh', onRefresh)
    return () => window.removeEventListener('integrator:refresh', onRefresh)
  }, [router])

  // Unique firmware versions for filter chip
  const firmwareOptions = useMemo(
    () => Array.from(new Set(edges.map((e) => e.version).filter(Boolean))).sort(),
    [edges],
  )
  const [firmwareFilter, setFirmwareFilter] = useState<string>('all')

  const filtered = useMemo(() => {
    return edges
      .filter((e) => statusFilter === 'all' || (statusFilter === 'online' ? e.isOnline : !e.isOnline))
      .filter((e) => firmwareFilter === 'all' || e.version === firmwareFilter)
      .filter((e) => !propertyQuery || e.building.name.toLowerCase().includes(propertyQuery.toLowerCase()))
  }, [edges, statusFilter, propertyQuery, firmwareFilter])

  const onlineCount = edges.filter((e) => e.isOnline).length

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink">Urządzenia Edge</h1>
        <p className="text-[13px] text-muted mt-1">
          {loading
            ? 'Ładowanie…'
            : `${edges.length} ${pluralizeEdges(edges.length)} w ${edges.length === 1 ? 'obiekcie' : 'portfolio'} · `}
          {!loading && (
            <span className="text-success font-medium">{onlineCount} online</span>
          )}
        </p>
      </div>

      {/* Filtry */}
      <div className="bg-surface border border-border rounded-r3 p-4 mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-2 uppercase font-semibold tracking-wider mr-2">Status:</span>
          {(['all', 'online', 'offline'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2.5 py-1 text-[12px] font-medium rounded-r1 transition-colors ${
                statusFilter === s
                  ? 'bg-brand text-white'
                  : 'text-muted hover:text-ink hover:bg-surface-2'
              }`}
            >
              {s === 'all' ? 'Wszystkie' : s === 'online' ? 'Online' : 'Offline'}
            </button>
          ))}
        </div>

        {firmwareOptions.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-2 uppercase font-semibold tracking-wider">FW:</span>
            <select
              value={firmwareFilter}
              onChange={(e) => setFirmwareFilter(e.target.value)}
              className="text-[12px] bg-surface border border-border rounded-r1 px-2 py-1 text-ink"
            >
              <option value="all">Wszystkie</option>
              {firmwareOptions.map((fw) => (
                <option key={fw ?? ''} value={fw ?? ''}>{fw ?? '—'}</option>
              ))}
            </select>
          </div>
        )}

        <input
          value={propertyQuery}
          onChange={(e) => setPropertyQuery(e.target.value)}
          placeholder="Szukaj po nazwie obiektu…"
          className="flex-1 min-w-[200px] text-[12px] bg-surface border border-border rounded-r1 px-3 py-1.5 text-ink placeholder:text-muted-2 focus:outline-none focus:border-brand"
        />
      </div>

      {/* Tabela */}
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-muted text-[13px]">
          <Spinner size={14} /> Ładowanie urządzeń Edge…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState hasFilters={statusFilter !== 'all' || firmwareFilter !== 'all' || !!propertyQuery} />
      ) : (
        <div className="bg-surface border border-border rounded-r3 overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2 border-b border-border">
              <tr className="text-left">
                <Th>Nazwa</Th>
                <Th>Obiekt</Th>
                <Th>IP</Th>
                <Th>Firmware</Th>
                <Th>Last seen</Th>
                <Th>Status</Th>
                <Th className="text-right">Akcja</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((edge) => <EdgeRow key={edge.id} edge={edge} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function EdgeRow({ edge }: { edge: EdgeRow }) {
  const lastSeen = edge.lastSeenAt ? formatAgo(new Date(edge.lastSeenAt).getTime()) : '—'
  return (
    <tr className="hover:bg-surface-2 transition-colors">
      <Td>
        <div className="flex items-center gap-2">
          <Server size={14} strokeWidth={1.8} className="text-ink-2 flex-shrink-0" />
          <span className="font-medium text-ink">{edge.name ?? 'GateLynk Edge'}</span>
        </div>
      </Td>
      <Td>
        <Link
          href={`/integrator/buildings/${edge.building.id}`}
          className="inline-flex items-center gap-1 text-brand hover:text-brand-600 hover:underline"
        >
          <Building2 size={12} strokeWidth={1.8} />
          {edge.building.name}
        </Link>
      </Td>
      <Td>
        <span
          className="text-muted"
          style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}
        >
          {edge.ipAddress ?? '—'}
        </span>
      </Td>
      <Td>
        <span
          className="text-muted"
          style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}
        >
          {edge.version ?? '—'}
        </span>
      </Td>
      <Td>
        <span className="text-muted">{lastSeen}</span>
      </Td>
      <Td>
        <StatusPill online={edge.isOnline} />
      </Td>
      <Td className="text-right">
        {edge.ipAddress ? (
          <button
            onClick={() => openEdgeUI(edge.building.id, edge.id)}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:text-brand-600 bg-brand-50 px-2.5 py-1 rounded-r1 border border-brand/30 transition-colors"
            title="1-click przejście do Edge UI (przez Cloud SSO)"
          >
            UI <ExternalLink size={10} strokeWidth={2} />
          </button>
        ) : (
          <span className="text-[11px] text-muted-2">brak IP</span>
        )}
      </Td>
    </tr>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-4 py-2.5 text-[10px] font-bold text-muted-2 uppercase tracking-wider ${className ?? ''}`}
    >
      {children}
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className ?? ''}`}>{children}</td>
}

function StatusPill({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-r1 border ${
        online
          ? 'bg-success-50 text-success border-success/30'
          : 'bg-danger-50 text-danger border-danger/30'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-success' : 'bg-danger'}`} />
      {online ? 'Online' : 'Offline'}
    </span>
  )
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="bg-surface border border-border rounded-r3 p-12 text-center">
      {hasFilters ? (
        <>
          <AlertTriangle size={36} strokeWidth={1.5} className="text-muted-2 mx-auto mb-3" />
          <h3 className="text-[14px] font-semibold text-ink mb-1">Brak wyników</h3>
          <p className="text-[12px] text-muted">Zmień filtr żeby zobaczyć więcej urządzeń.</p>
        </>
      ) : (
        <>
          <Server size={36} strokeWidth={1.5} className="text-muted-2 mx-auto mb-3" />
          <h3 className="text-[14px] font-semibold text-ink mb-1">Brak urządzeń Edge</h3>
          <p className="text-[12px] text-muted">Dodaj obiekt z aktywnym Edge w panelu administratora.</p>
        </>
      )}
    </div>
  )
}

function formatAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec} s temu`
  if (sec < 3600) return `${Math.round(sec / 60)} min temu`
  if (sec < 86400) return `${Math.round(sec / 3600)} h temu`
  return `${Math.round(sec / 86400)} dni temu`
}

function pluralizeEdges(n: number): string {
  if (n === 1) return 'urządzenie'
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'urządzenia'
  return 'urządzeń'
}
