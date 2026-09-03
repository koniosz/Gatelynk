/**
 * GateLynk Edge — Topbar (52px).
 *
 * Z handoff doc (sek. 5):
 *   • Logo + hostname + IP (zawsze widoczne)
 *   • Pille statusu: System (online), LAN/Speed, Cloud, uptime (chowane <1280px)
 *   • Theme toggle (sun/moon) po prawej
 */
import { useEffect, useState } from 'react'
import { ThemeToggle } from './ThemeToggle'
import { LanguageToggle } from './LanguageToggle'
import { useTranslation } from '../../i18n'

interface SystemPreview {
  hostname: string
  ip: string
  uptimeSec: number
  cloud: 'connected' | 'degraded' | 'disconnected'
  lan: { state: 'up' | 'down'; linkMbps: number }
}

interface TopbarProps {
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

export function Topbar({ theme, onToggleTheme }: TopbarProps) {
  const [sys, setSys] = useState<SystemPreview | null>(null)
  const { t } = useTranslation()

  // E-4 dorzuci pełen `/api/system`. Na razie fetchujemy istniejący `/status`
  // (legacy z NestJS StatusModule) — minimal viable info dla topbara.
  // Backwards-compat: gdy `/api/system` nie istnieje, /status zwróci basic data.
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/system')
        if (res.ok) {
          setSys(await res.json())
          return
        }
        // Fallback /status (legacy NestJS endpoint)
        const fallback = await fetch('/status')
        if (fallback.ok) {
          const data = await fallback.json()
          setSys({
            hostname: data.system?.hostname ?? 'edge',
            ip: data.ip ?? '—',
            uptimeSec: data.uptime ?? 0,
            cloud: data.cloud?.connected ? 'connected' : 'disconnected',
            lan: { state: 'up', linkMbps: 1000 },
          })
        }
      } catch {
        // No-op — Topbar renderuje placeholder
      }
    }
    load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <header
      style={{
        height: 52,
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 24px',
        gap: 24,
        flexShrink: 0,
      }}
    >
      {/* Logo + hostname + IP */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>
          GateLynk Edge
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          <span className="mono">{sys?.hostname ?? '—'}</span>
          <span style={{ margin: '0 6px', color: 'var(--muted-2)' }}>·</span>
          <span className="mono">{sys?.ip ?? '—'}</span>
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* Pille statusu */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} className="status-pills">
        <StatusPill
          label={t('topbar.system')}
          state={sys ? 'green' : 'gray'}
        />
        <StatusPill
          label={`LAN${sys?.lan ? ` ${sys.lan.linkMbps} Mbps` : ''}`}
          state={sys?.lan?.state === 'up' ? 'green' : sys?.lan?.state === 'down' ? 'red' : 'gray'}
        />
        <StatusPill
          label={t('topbar.cloud')}
          state={
            sys?.cloud === 'connected' ? 'green' :
            sys?.cloud === 'degraded'  ? 'amber' :
            sys?.cloud === 'disconnected' ? 'red' : 'gray'
          }
        />
        {sys && (
          <span className="pill" title={t('topbar.uptime')}>
            {formatUptime(sys.uptimeSec)}
          </span>
        )}
      </div>

      <LanguageToggle />
      <ThemeToggle theme={theme} onToggle={onToggleTheme} />
    </header>
  )
}

function StatusPill({ label, state }: { label: string; state: 'green' | 'amber' | 'red' | 'gray' }) {
  const cls = state === 'gray' ? 'pill' : `pill pill-${state}`
  return (
    <span className={cls}>
      <span className={`dot dot-${state}`} />
      {label}
    </span>
  )
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`
  return `${Math.floor(seconds / 86400)} d`
}
