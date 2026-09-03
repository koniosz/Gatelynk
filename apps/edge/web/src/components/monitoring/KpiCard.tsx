/**
 * KpiCard — pojedyncza karta z dużą wartością + sparkline + label.
 *
 * Z handoff doc: „4 metryki KPI z sparkline (CPU, RAM, Dysk, Temp) — okno 60 min".
 * Wartość bieżąca duża u góry, sparkline tła pod spodem, label u dołu.
 */
import { Sparkline } from './Sparkline'
import type { LucideIcon } from 'lucide-react'

interface KpiCardProps {
  label: string
  value: string | number
  unit?: string
  history: (number | null)[]
  icon?: LucideIcon
  color?: string
  /** Pełny zakres dla sparkline (np. 0..100 dla %). */
  min?: number
  max?: number
  /** Treść poniżej wartości (np. „8 z 16 GB" pod RAM). */
  subtitle?: string
}

export function KpiCard({
  label, value, unit, history, icon: Icon, color = 'var(--blue)', min, max, subtitle,
}: KpiCardProps) {
  return (
    <div
      className="card card-hoverable"
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 120,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
        }}>
          {label}
        </span>
        {Icon && (
          <Icon size={14} strokeWidth={1.8} style={{ color: 'var(--muted-2)' }} />
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{
          fontSize: 28,
          fontWeight: 700,
          color: 'var(--ink)',
          lineHeight: 1,
          fontFamily: '"IBM Plex Sans", sans-serif',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {value}
        </span>
        {unit && (
          <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>
            {unit}
          </span>
        )}
      </div>

      {subtitle && (
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{subtitle}</span>
      )}

      <div style={{ marginTop: 'auto', display: 'flex' }}>
        <div style={{ flex: 1 }}>
          <Sparkline
            data={history}
            width={200}
            height={32}
            min={min}
            max={max}
            color={color}
          />
        </div>
      </div>
    </div>
  )
}
