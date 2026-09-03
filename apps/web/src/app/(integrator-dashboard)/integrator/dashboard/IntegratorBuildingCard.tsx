'use client'
/**
 * IntegratorBuildingCard (FAZA f, 2026-06-02).
 *
 * Pojedyncza karta budynku w dashboardzie. Sekcje:
 *   1. Header (ikona typu + nazwa + adres + status pill)
 *   2. Edge row (uptime, IP, queue, version)
 *   3. Stats row (urządzenia, mieszkańcy, AP, anomalie 24h, LPR 24h, kurierzy 24h)
 *   4. Issues (lista human-readable PL alertów)
 *   5. CTA "Otwórz panel →"
 *
 * Klik na header lub CTA → router.push do `/integrator/buildings/:id`.
 */
import Link from 'next/link'
import {
  AlertTriangle, ChevronRight, Server, Users, Home, DoorOpen,
  Eye, Car, Package,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

type HealthStatus = 'ok' | 'warning' | 'critical'

interface BuildingCardData {
  id: number
  name: string
  address: string
  objectType: string
  features: {
    has_concierge: boolean
    has_central_mailbox: boolean
    delivery_to_door: boolean
    has_security_guard: boolean
    has_common_parking: boolean
  }
  edge: {
    hasActivated: boolean
    online: boolean
    uptime: number | null
    queueSize: number | null
    lastSeenAt: string | null
    ipAddress: string | null
    outbox: { pending: number; failed: number }
    version: string | null
  }
  stats: {
    devices: number
    residents: number
    units: number
    accessPoints: number
    anomaliesLast24h: number
    lprReadsLast24h: number
    couriersLast24h: number
  }
  health: {
    status: HealthStatus
    issues: string[]
  }
  // PR-3 (2026-07-03) — zbiorczy status gotowości obiektu z readiness
  // health-checka (batch w GET /integrator/dashboard). Optional/null dla
  // wstecznej kompatybilności ze starszym API.
  readiness?: {
    overall: 'ready' | 'almost' | 'not_ready'
    score: { ok: number; warn: number; fail: number }
  } | null
}

interface Props {
  building: BuildingCardData
}

// Emoji per object type — konwencja Integrator panelu (dopuszczalne emoji w
// hederach kart kontra cała aplikacja BA v2 gdzie tylko lucide).
const OBJECT_TYPE_EMOJI: Record<string, string> = {
  BUILDING: '🏢',
  HOUSING_ESTATE: '🏠',
  MIXED_USE: '🏬',
  CAMPUS: '🏛️',
  PARKING: '🅿️',
}
const OBJECT_TYPE_LABEL: Record<string, string> = {
  BUILDING: 'Budynek',
  HOUSING_ESTATE: 'Osiedle domów',
  MIXED_USE: 'Wielofunkcyjny',
  CAMPUS: 'Kampus',
  PARKING: 'Parking',
}

export function IntegratorBuildingCard({ building: b }: Props) {
  const emoji = OBJECT_TYPE_EMOJI[b.objectType] ?? '🏢'
  const typeLabel = OBJECT_TYPE_LABEL[b.objectType] ?? 'Obiekt'

  // Border-color highlight ramki gdy critical — wzrok integratora ma od razu
  // łapać że budynek wymaga uwagi.
  const cardBorder =
    b.health.status === 'critical' ? 'border-danger/40' :
    b.health.status === 'warning'  ? 'border-warn/40'   :
    'border-border'

  return (
    <div
      className={`bg-surface border ${cardBorder} rounded-r3 p-5 transition-all hover:shadow-sm`}
    >
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-r2 bg-surface-2 flex items-center justify-center flex-shrink-0 text-xl">
          {emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <Link
              href={`/integrator/buildings/${b.id}`}
              className="font-semibold text-ink truncate hover:underline"
            >
              {b.name}
            </Link>
          </div>
          <p className="text-[12px] text-muted truncate">{b.address}</p>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-[10px] text-muted-2 uppercase tracking-wider">
              {typeLabel}
            </p>
            {b.readiness && <ReadinessBadge readiness={b.readiness} />}
          </div>
        </div>
        <StatusPill status={b.health.status} edgeOnline={b.edge.online} hasActivated={b.edge.hasActivated} />
      </div>

      {/* Edge row */}
      <div className="border-t border-border pt-3 mb-3">
        <div className="flex items-center gap-2 text-[11px] text-muted-2 uppercase font-semibold tracking-wider mb-1.5">
          <Server size={12} strokeWidth={2} /> Edge
        </div>
        <div className="text-[12px] text-ink-2 space-y-0.5">
          {b.edge.online ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {b.edge.uptime !== null && (
                <span><strong className="text-ink">Uptime:</strong> {formatUptime(b.edge.uptime)}</span>
              )}
              {b.edge.ipAddress && (
                <span style={{ fontFamily: 'var(--font-plex-mono, monospace)' }} className="text-muted">
                  {b.edge.ipAddress}
                </span>
              )}
              {b.edge.queueSize !== null && (
                <span><strong className="text-ink">queue:</strong> {b.edge.queueSize}</span>
              )}
              {b.edge.version && (
                <span className="text-muted">v{b.edge.version}</span>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted">
              {b.edge.lastSeenAt ? (
                <span>Ostatnio: {formatAgo(new Date(b.edge.lastSeenAt).getTime())}</span>
              ) : (
                <span>Nigdy nie był połączony</span>
              )}
              {b.edge.ipAddress && (
                <span style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}>
                  {b.edge.ipAddress}
                </span>
              )}
            </div>
          )}
          {(b.edge.outbox.pending > 0 || b.edge.outbox.failed > 0) && (
            <div className="flex gap-2 mt-1">
              {b.edge.outbox.pending > 0 && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-surface-2 border border-border rounded-r1 text-[10px] text-muted">
                  ⏳ {b.edge.outbox.pending} oczekujące
                </span>
              )}
              {b.edge.outbox.failed > 0 && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-danger-50 border border-danger/30 rounded-r1 text-[10px] text-danger font-semibold">
                  ⚠ {b.edge.outbox.failed} nie dostarczone
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Stats row */}
      <div className="border-t border-border pt-3 mb-3">
        <div className="text-[11px] text-muted-2 uppercase font-semibold tracking-wider mb-1.5">
          Statystyki
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5 text-[12px]">
          <StatRow icon={Server} value={b.stats.devices} label="urządzeń" />
          <StatRow icon={Users} value={b.stats.residents} label="mieszk." />
          <StatRow icon={Home} value={b.stats.units} label="lokali" />
          <StatRow icon={DoorOpen} value={b.stats.accessPoints} label="AP" />
          <StatRow icon={Car} value={b.stats.lprReadsLast24h} label="LPR 24h" />
          {b.features.delivery_to_door && (
            <StatRow icon={Package} value={b.stats.couriersLast24h} label="kurierzy 24h" />
          )}
          {b.stats.anomaliesLast24h > 0 && (
            <StatRow
              icon={Eye}
              value={b.stats.anomaliesLast24h}
              label="anomalie 24h"
              tone="danger"
            />
          )}
        </div>
      </div>

      {/* Issues */}
      {b.health.issues.length > 0 && (
        <div className="border-t border-border pt-3 mb-3">
          <div className="space-y-1">
            {b.health.issues.map((issue, i) => (
              <div
                key={i}
                className={`text-[12px] flex items-start gap-1.5 ${
                  b.health.status === 'critical' ? 'text-danger' : 'text-warn'
                }`}
              >
                <AlertTriangle size={12} strokeWidth={2} className="mt-0.5 flex-shrink-0" />
                <span>{issue}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* CTA */}
      <Link
        href={`/integrator/buildings/${b.id}`}
        className="inline-flex items-center gap-1 text-[12px] font-medium text-brand hover:text-brand-600 bg-brand-50 px-2.5 py-1.5 rounded-r1 border border-brand/30 transition-colors"
      >
        Otwórz panel <ChevronRight size={12} strokeWidth={2} />
      </Link>
    </div>
  )
}

function StatRow({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: LucideIcon
  value: number
  label: string
  tone?: 'danger'
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon size={12} strokeWidth={1.8} className={tone === 'danger' ? 'text-danger' : 'text-muted-2'} />
      <span className={`font-semibold ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{value}</span>
      <span className="text-muted">{label}</span>
    </div>
  )
}

/**
 * PR-3 — badge gotowości obiektu (checklista readiness). Klik prowadzi do
 * strony budynku, gdzie jest pełna karta „Gotowość obiektu" z detalami.
 */
function ReadinessBadge({
  readiness,
}: {
  readiness: NonNullable<BuildingCardData['readiness']>
}) {
  const scored = readiness.score.ok + readiness.score.warn + readiness.score.fail
  const meta =
    readiness.overall === 'ready'
      ? { label: 'Gotowy', cls: 'bg-success-50 text-success border-success/30', dot: 'bg-success' }
      : readiness.overall === 'almost'
      ? { label: 'Prawie gotowy', cls: 'bg-warn-50 text-warn border-warn/30', dot: 'bg-warn' }
      : { label: 'Niegotowy', cls: 'bg-danger-50 text-danger border-danger/30', dot: 'bg-danger' }
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-r1 border ${meta.cls}`}
      title={`Gotowość obiektu: ${readiness.score.ok}/${scored} checków OK`}
    >
      <span className={`w-1 h-1 rounded-full ${meta.dot}`} />
      {meta.label} · {readiness.score.ok}/{scored}
    </span>
  )
}

function StatusPill({
  status,
  edgeOnline,
  hasActivated,
}: {
  status: HealthStatus
  edgeOnline: boolean
  hasActivated: boolean
}) {
  // Wizualnie wyróżniamy "Edge offline" jako szary z czerwoną kropką
  // (per zlecenie). "Critical" bez Edge → czerwony solid.
  if (!hasActivated) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-r1 border bg-surface-2 border-border text-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-2" />
        Nieaktywowany
      </span>
    )
  }
  if (!edgeOnline) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-r1 border bg-surface-2 border-border text-muted">
        <span className="w-1.5 h-1.5 rounded-full bg-danger" />
        OFFLINE
      </span>
    )
  }
  if (status === 'critical') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-r1 border bg-danger-50 text-danger border-danger/30">
        <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />
        CRITICAL
      </span>
    )
  }
  if (status === 'warning') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-r1 border bg-warn-50 text-warn border-warn/30">
        <span className="w-1.5 h-1.5 rounded-full bg-warn" />
        WARNING
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-r1 border bg-success-50 text-success border-success/30">
      <span className="w-1.5 h-1.5 rounded-full bg-success" />
      ONLINE
    </span>
  )
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec} s`
  if (sec < 3600) return `${Math.floor(sec / 60)} min`
  if (sec < 86400) {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    return m > 0 ? `${h}h ${m}min` : `${h}h`
  }
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  return h > 0 ? `${d}d ${h}h` : `${d}d`
}

function formatAgo(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec} s temu`
  if (sec < 3600) return `${Math.round(sec / 60)} min temu`
  if (sec < 86400) return `${Math.round(sec / 3600)} h temu`
  return `${Math.round(sec / 86400)} dni temu`
}

export type { BuildingCardData }
