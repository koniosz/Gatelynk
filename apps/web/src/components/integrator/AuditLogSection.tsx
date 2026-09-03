'use client'
/**
 * AuditLogSection (Sesja 5) — historia operacji integratora.
 *
 * Renderowany w SettingsPage poniżej Notifications. Pokazuje ostatnie 100
 * akcji write z możliwością filtrowania per-obiekt (dropdown).
 *
 * Backend: GET /integrator/me/audit?limit=100&buildingId=optional
 *
 * Akcja codes (z service.logAudit):
 *   EDGE_DEEPLINK_GENERATE, DIAGNOSTICS_RUN, CONFIG_EXPORT,
 *   PROFILE_UPDATE, NOTIFICATION_PREFS_UPDATE
 *   (więcej dodamy iteracyjnie gdy okaże się potrzebne)
 */
import { useEffect, useMemo, useState } from 'react'
import {
  ExternalLink, Stethoscope, Download, User, Bell, History,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from '@/components/integrator/property/shared/Spinner'

interface AuditEntry {
  id: string
  action: string
  targetType?: string | null
  targetId?: string | null
  buildingId?: number | null
  meta?: Record<string, unknown> | null
  createdAt: string
}

const ACTION_META: Record<string, { label: string; icon: LucideIcon; color: string }> = {
  EDGE_DEEPLINK_GENERATE:    { label: 'Otwarcie Edge UI',         icon: ExternalLink, color: 'text-brand' },
  DIAGNOSTICS_RUN:           { label: 'Diagnostyka urządzenia',   icon: Stethoscope,  color: 'text-warn' },
  CONFIG_EXPORT:             { label: 'Eksport konfiguracji',     icon: Download,     color: 'text-success' },
  PROFILE_UPDATE:            { label: 'Zmiana profilu',           icon: User,         color: 'text-muted-2' },
  NOTIFICATION_PREFS_UPDATE: { label: 'Zmiana powiadomień',       icon: Bell,         color: 'text-muted-2' },
}

export function AuditLogSection() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [buildingFilter, setBuildingFilter] = useState<number | 'all'>('all')

  // Buildings dla filter dropdown
  const [buildings, setBuildings] = useState<Array<{ id: number; name: string }>>([])

  useEffect(() => {
    integratorApi.get('/integrator/buildings')
      .then((r) => setBuildings(r.data.map((b: { id: number; name: string }) => ({ id: b.id, name: b.name }))))
      .catch(() => { /* no-op */ })
  }, [])

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '100' })
    if (buildingFilter !== 'all') params.set('buildingId', String(buildingFilter))
    integratorApi.get<AuditEntry[]>(`/integrator/me/audit?${params}`)
      .then((r) => setEntries(r.data))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [buildingFilter])

  const grouped = useMemo(() => groupByDay(entries), [entries])

  return (
    <div className="bg-surface border border-border rounded-r3 overflow-hidden">
      <header className="flex items-center justify-between px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <History size={16} strokeWidth={1.8} className="text-ink-2" />
          <h2 className="text-[14px] font-semibold text-ink">Historia operacji</h2>
        </div>
        {buildings.length > 0 && (
          <select
            value={buildingFilter === 'all' ? 'all' : String(buildingFilter)}
            onChange={(e) => setBuildingFilter(e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10))}
            className="text-[12px] bg-surface border border-border rounded-r1 px-2 py-1 text-ink"
          >
            <option value="all">Wszystkie obiekty</option>
            {buildings.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        )}
      </header>

      <div className="p-5">
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-muted text-[13px]">
            <Spinner size={14} /> Ładowanie historii…
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-8 text-muted">
            <History size={28} strokeWidth={1.5} className="mx-auto mb-2 text-muted-2" />
            <p className="text-[13px]">Brak wpisów w historii</p>
            <p className="text-[11px] text-muted-2 mt-1">
              Wpisy pojawią się po wykonaniu pierwszych operacji (otwarcie Edge UI, diagnostyka, eksport, …)
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {grouped.map(([day, dayEntries]) => (
              <div key={day}>
                <h3 className="text-[10px] font-bold uppercase tracking-wider text-muted-2 mb-2">{day}</h3>
                <div className="space-y-1">
                  {dayEntries.map((e) => <AuditRow key={e.id} entry={e} buildings={buildings} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function AuditRow({ entry, buildings }: { entry: AuditEntry; buildings: Array<{ id: number; name: string }> }) {
  const meta = ACTION_META[entry.action] ?? {
    label: entry.action.replace(/_/g, ' ').toLowerCase(),
    icon: History,
    color: 'text-muted',
  }
  const Icon = meta.icon
  const building = entry.buildingId ? buildings.find((b) => b.id === entry.buildingId) : null
  const time = new Date(entry.createdAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="flex items-start gap-3 py-2 px-3 hover:bg-surface-2 rounded-r1 transition-colors">
      <Icon size={14} strokeWidth={1.8} className={`${meta.color} flex-shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-ink">
          <span className="font-medium">{meta.label}</span>
          {building && (
            <>
              <span className="text-muted-2 mx-1">·</span>
              <span className="text-muted">{building.name}</span>
            </>
          )}
        </div>
        {entry.meta && Object.keys(entry.meta).length > 0 && (
          <div className="text-[10px] text-muted-2 mt-0.5" style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}>
            {formatMeta(entry.meta)}
          </div>
        )}
      </div>
      <span className="text-[11px] text-muted-2 flex-shrink-0">{time}</span>
    </div>
  )
}

function groupByDay(entries: AuditEntry[]): Array<[string, AuditEntry[]]> {
  const groups = new Map<string, AuditEntry[]>()
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)

  for (const e of entries) {
    const d = new Date(e.createdAt); d.setHours(0, 0, 0, 0)
    let label: string
    if (d.getTime() === today.getTime()) label = 'Dzisiaj'
    else if (d.getTime() === yesterday.getTime()) label = 'Wczoraj'
    else label = d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' })

    const arr = groups.get(label) ?? []
    arr.push(e)
    groups.set(label, arr)
  }
  return [...groups.entries()]
}

function formatMeta(meta: Record<string, unknown>): string {
  // Format do single-line — pomijaj złożone obiekty.
  const pairs: string[] = []
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue
    if (typeof v === 'object') {
      pairs.push(`${k}=${JSON.stringify(v).slice(0, 40)}`)
    } else {
      pairs.push(`${k}=${String(v)}`)
    }
  }
  return pairs.join(' · ')
}
