'use client'
/**
 * IntegratorDashboardStats — 4 statystyki agregowane na górze dashboardu
 * (FAZA f, 2026-06-02).
 *
 * Zawiera totals z `/integrator/dashboard`:
 *   - buildings   — liczba budynków w portfolio
 *   - online      — ile Edge online (pulsuje zielono)
 *   - critical    — ile budynków z health=critical (czerwony — wymagają uwagi)
 *   - anomalies24h — ile budynków z anomalią z ostatnich 24h
 *
 * Każda karta ma `count`, `label`, `description` + ikona.
 */
import { Building2, Wifi, AlertTriangle, Eye } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface Totals {
  buildings: number
  online: number
  offline: number
  withAnomalies24h: number
  withFailedOutbox: number
}

interface Props {
  totals: Totals
  criticalCount: number
}

export function IntegratorDashboardStats({ totals, criticalCount }: Props) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
      <StatCard
        icon={Building2}
        value={totals.buildings}
        label="Obiekty"
        description={pluralizeObjects(totals.buildings) + ' w portfolio'}
        tone="brand"
      />
      <StatCard
        icon={Wifi}
        value={totals.online}
        label="Edge online"
        description={totals.offline > 0
          ? `${totals.offline} ${pluralizeOfflineEdges(totals.offline)} offline`
          : 'wszystkie online'}
        tone={totals.offline === 0 ? 'success' : 'neutral'}
      />
      <StatCard
        icon={AlertTriangle}
        value={criticalCount}
        label="Krytyczne alerty"
        description={criticalCount === 0 ? 'brak problemów' : 'wymagają reakcji'}
        tone={criticalCount > 0 ? 'danger' : 'success'}
      />
      <StatCard
        icon={Eye}
        value={totals.withAnomalies24h}
        label="Anomalie 24h"
        description={totals.withAnomalies24h === 0
          ? 'spokojnie'
          : `${totals.withAnomalies24h} ${pluralizeBuildings(totals.withAnomalies24h)} z detekcją`}
        tone={totals.withAnomalies24h > 0 ? 'warning' : 'success'}
      />
    </div>
  )
}

type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral'

function StatCard({
  icon: Icon,
  value,
  label,
  description,
  tone,
}: {
  icon: LucideIcon
  value: number
  label: string
  description: string
  tone: Tone
}) {
  const palette: Record<Tone, { icon: string; bg: string }> = {
    brand:   { icon: 'text-brand',   bg: 'bg-brand-50'   },
    success: { icon: 'text-success', bg: 'bg-success-50' },
    warning: { icon: 'text-warn',    bg: 'bg-warn-50'    },
    danger:  { icon: 'text-danger',  bg: 'bg-danger-50'  },
    neutral: { icon: 'text-ink-2',   bg: 'bg-surface-2'  },
  }
  const colors = palette[tone]

  return (
    <div className="bg-surface border border-border rounded-r3 p-4">
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-r2 flex items-center justify-center flex-shrink-0 ${colors.bg}`}>
          <Icon size={18} strokeWidth={1.8} className={colors.icon} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold text-muted-2 uppercase tracking-wider">{label}</div>
          <div className="text-2xl font-bold text-ink leading-tight mt-0.5">{value}</div>
          <div className="text-[11px] text-muted mt-0.5 truncate" title={description}>{description}</div>
        </div>
      </div>
    </div>
  )
}

function pluralizeObjects(n: number): string {
  if (n === 1) return 'obiekt'
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'obiekty'
  return 'obiektów'
}

function pluralizeOfflineEdges(n: number): string {
  if (n === 1) return 'Edge'
  return 'Edge'
}

function pluralizeBuildings(n: number): string {
  if (n === 1) return 'obiekt'
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) return 'obiekty'
  return 'obiektów'
}
