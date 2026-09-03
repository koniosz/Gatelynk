/**
 * Monitoring tab — KPI sparklines + big chart sieci.
 *
 * Z handoff doc sek. 5:
 *  • 4 metryki KPI z sparkline (CPU, RAM, Disk, Temp) — okno 60 min
 *  • Big chart: ruch sieciowy in/out
 *  • 2 mini charts: urządzenia online (filled), triggery przekaźników (bars)
 *  • „Wszystkie dane z /api/metrics endpoint" — w mockupie hardcoded
 */
import { Cpu, MemoryStick, HardDrive, Thermometer, Network, RefreshCw, DoorOpen, Car, ScanLine } from 'lucide-react'
import { formatEdgeTime } from '../lib/edgeTime'
import {
  useSystemInfo, useMetrics, useRecentRelayTriggers, useRecentLprReads,
  type RecentRelayTrigger, type RecentLprRead,
} from '../lib/useMetrics'
import { useTranslation } from '../i18n'
import { KpiCard } from '../components/monitoring/KpiCard'
import { NetworkChart } from '../components/monitoring/NetworkChart'
import { Sparkline } from '../components/monitoring/Sparkline'

export function MonitoringPage() {
  const { data: sys, error: sysError } = useSystemInfo()
  const { data: metrics, error: metricsError } = useMetrics('1h')
  const { data: recentTriggers } = useRecentRelayTriggers()
  const { data: recentLprReads } = useRecentLprReads()
  const { t } = useTranslation()

  const error = sysError ?? metricsError

  return (
    <div>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        marginBottom: 24,
        gap: 16,
        flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>
            {t('monitoring.title')}
          </h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            {t('monitoring.subtitle')}
          </p>
        </div>
        {sys && (
          <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: '"IBM Plex Mono", monospace' }}>
            {sys.hostname} · {sys.cpu.model}
          </div>
        )}
      </div>

      {error && (
        <div className="card" style={{
          padding: 12, marginBottom: 16,
          background: 'var(--red-50)', borderColor: 'var(--red)', color: 'var(--red)',
          fontSize: 13,
        }}>
          Błąd: {error}
        </div>
      )}

      {/* 4 KPI cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 16,
        marginBottom: 16,
      }}>
        <KpiCard
          label={t('monitoring.kpi.cpu')}
          value={sys ? sys.cpu.usage.toFixed(1) : '—'}
          unit="%"
          icon={Cpu}
          history={metrics?.cpu ?? []}
          min={0}
          max={100}
          color="var(--blue)"
        />
        <KpiCard
          label={t('monitoring.kpi.ram')}
          value={sys ? ((sys.ram.used / sys.ram.total) * 100).toFixed(0) : '—'}
          unit="%"
          icon={MemoryStick}
          history={metrics?.ram ?? []}
          min={0}
          max={100}
          color="var(--amber)"
          subtitle={sys ? `${(sys.ram.used / 1024).toFixed(1)} z ${(sys.ram.total / 1024).toFixed(1)} GB` : undefined}
        />
        <KpiCard
          label={t('monitoring.kpi.disk')}
          value={sys ? ((sys.disk.used / sys.disk.total) * 100).toFixed(0) : '—'}
          unit="%"
          icon={HardDrive}
          history={metrics?.disk ?? []}
          min={0}
          max={100}
          color="var(--green)"
          subtitle={sys ? `${sys.disk.used.toFixed(1)} z ${sys.disk.total.toFixed(0)} GB` : undefined}
        />
        <KpiCard
          label={t('monitoring.kpi.temp')}
          value={sys?.temp != null ? sys.temp : 'n/a'}
          unit={sys?.temp != null ? '°C' : ''}
          icon={Thermometer}
          history={metrics?.temp ?? []}
          color="var(--red)"
          subtitle={sys?.temp == null ? t('monitoring.kpi.temp.macos') : undefined}
        />
      </div>

      {/* Big chart sieć */}
      <div style={{ marginBottom: 16 }}>
        <NetworkChart
          netIn={metrics?.netIn ?? []}
          netOut={metrics?.netOut ?? []}
          timestamps={metrics?.timestamps ?? []}
        />
      </div>

      {/* Row 1: urządzenia online + relay triggers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(260px, 1fr) minmax(360px, 2fr)',
        gap: 16,
        marginBottom: 16,
      }}>
        <MiniCard
          icon={Network}
          label={t('monitoring.devicesOnline')}
          value={metrics?.devicesOnline?.[metrics.devicesOnline.length - 1] ?? 0}
          history={metrics?.devicesOnline ?? []}
          color="var(--blue)"
        />
        <RelayTriggersCard
          history={metrics?.relayTriggers ?? []}
          recent={recentTriggers}
        />
      </div>

      {/* Row 2: LPR — pełna szerokość bo listy tablic są szersze (plate + brand) */}
      <LprReadsCard
        history={metrics?.lprReads ?? []}
        recent={recentLprReads}
      />

      {/* Liczba próbek dla diagnostyki */}
      <div style={{
        marginTop: 12,
        fontSize: 11,
        color: 'var(--muted)',
        textAlign: 'right',
      }}>
        {t('monitoring.buffer', { n: metrics?.timestamps?.length ?? 0 })}
      </div>
    </div>
  )
}

function MiniCard({ icon: Icon, label, value, history, color }: {
  icon: any
  label: string
  value: number
  history: number[]
  color: string
}) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Icon size={14} strokeWidth={1.8} style={{ color: 'var(--muted-2)' }} />
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
        }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--ink)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ marginTop: 8 }}>
        <Sparkline data={history} width={260} height={32} color={color} />
      </div>
    </div>
  )
}

/**
 * RelayTriggersCard — header z sumą 60-min + sparkline (jak MiniCard), pod
 * tym przewijalna lista ostatnich trigerów (ts/device/relay/source). Bez
 * trigerów = empty state „Brak ostatnich otwarć" — bo dziś chart pokazywał
 * tylko „0" bez kontekstu czy to bug czy autentycznie nic się nie dzieje.
 */
function RelayTriggersCard({ history, recent }: {
  history: number[]
  recent: RecentRelayTrigger[]
}) {
  const total = history.reduce((s, n) => s + n, 0)
  // Najnowsze pierwsze
  const sorted = [...recent].sort((a, b) => b.ts - a.ts)
  const { t } = useTranslation()

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', minHeight: 200 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <RefreshCw size={14} strokeWidth={1.8} style={{ color: 'var(--muted-2)' }} />
        <span style={{
          fontSize: 11, fontWeight: 600, color: 'var(--muted)',
          textTransform: 'uppercase', letterSpacing: 0.6,
        }}>
          {t('monitoring.relayTriggers')}
        </span>
      </div>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 16,
        marginBottom: 4,
      }}>
        <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--ink)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {total}
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {t('monitoring.relayTriggers.recent', { n: sorted.length })}
        </span>
      </div>
      <Sparkline data={history} width={340} height={28} color="var(--green)" />

      {/* Lista ostatnich trigerów */}
      <div style={{
        marginTop: 12, paddingTop: 12,
        borderTop: '1px solid var(--border)',
        flex: 1,
        maxHeight: 220,
        overflowY: 'auto',
        fontSize: 12,
      }}>
        {sorted.length === 0 ? (
          <div style={{
            padding: 16, textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 12,
            fontStyle: 'italic',
          }}>
            {t('monitoring.relayTriggers.empty')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {sorted.map((t, i) => (
              <TriggerRow key={i} trigger={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TriggerRow({ trigger }: { trigger: RecentRelayTrigger }) {
  const { t, lang } = useTranslation()
  const time = formatEdgeTime(trigger.ts, lang)
  const ago = Date.now() - trigger.ts
  const agoLabel = ago < 60_000 ? t('common.ago_sec', { n: Math.round(ago / 1000) })
                : ago < 3_600_000 ? t('common.ago_min', { n: Math.round(ago / 60_000) })
                : t('common.ago_hr', { n: Math.round(ago / 3_600_000) })
  const srcMeta = sourceMeta(trigger.source, t)
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '70px 1fr auto auto',
      gap: 8,
      alignItems: 'center',
      padding: '4px 6px',
      borderRadius: 'var(--r-1)',
    }}>
      <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: 'var(--muted)' }}>
        {time}
      </span>
      <span style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontSize: 11, color: 'var(--ink-2)',
      }} title={trigger.deviceId /* pełen UUID na hover dla diagnostyki */}>
        <DoorOpen size={11} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 4, color: 'var(--muted-2)' }} />
        {trigger.deviceName ?? `${trigger.deviceId.slice(0, 8)}…`} · relay {trigger.relayIndex}
      </span>
      <span style={{
        fontSize: 10, fontWeight: 600,
        padding: '2px 6px', borderRadius: 999,
        background: srcMeta.bg, color: srcMeta.fg, border: `1px solid ${srcMeta.fg}`,
      }}>
        {srcMeta.label}
      </span>
      <span style={{ fontSize: 10, color: 'var(--muted)', minWidth: 60, textAlign: 'right' }}>
        {agoLabel}
      </span>
    </div>
  )
}

function sourceMeta(
  source: RecentRelayTrigger['source'],
  t: (key: string, vars?: Record<string, string | number>) => string,
): { label: string; bg: string; fg: string } {
  switch (source) {
    case 'HTTP':      return { label: t('monitoring.source.panel'),    bg: 'var(--blue-50)',   fg: 'var(--blue)'  }
    case 'PIN':       return { label: t('monitoring.source.pin'),      bg: 'var(--green-50)',  fg: 'var(--green)' }
    case 'HOLD_OPEN': return { label: t('monitoring.source.holdOpen'), bg: 'var(--amber-50)',  fg: 'var(--amber)' }
    case 'LPR':       return { label: t('monitoring.source.lpr'),      bg: 'var(--blue-50)',   fg: 'var(--blue)'  }
    default:          return { label: '—',                              bg: 'var(--surface-2)', fg: 'var(--muted)' }
  }
}

/**
 * LprReadsCard — agregat + lista ostatnich odczytów ze wszystkich kamer LPR.
 *
 * Header pokazuje:
 *  • TOTAL = sum(history) — odczyty z ostatnich 60 min
 *  • MATCHED count = z `recent` (ile spośród ostatnich N to whitelist matches)
 *  • sparkline 60-min zielony
 *
 * Lista pod tym (przewijalna): czas, tablica, kierunek (IN/OUT/?), confidence%,
 * badge MATCH/NO_MATCH (zielony/szary), badge BRAMA jeśli `gateOpened`.
 *
 * Empty state — analogicznie do RelayTriggersCard.
 */
function LprReadsCard({ history, recent }: {
  history: number[]
  recent: RecentLprRead[]
}) {
  const total = history.reduce((s, n) => s + n, 0)
  const sorted = [...recent].sort((a, b) => b.ts - a.ts)
  const matchedCount = sorted.filter((r) => r.matched).length
  const { t } = useTranslation()

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', minHeight: 240 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <ScanLine size={14} strokeWidth={1.8} style={{ color: 'var(--muted-2)' }} />
        <span style={{
          fontSize: 11, fontWeight: 600, color: 'var(--muted)',
          textTransform: 'uppercase', letterSpacing: 0.6,
        }}>
          {t('monitoring.lprReads')}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 4 }}>
        <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--ink)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {total}
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {t('monitoring.lprReads.recent', { n: sorted.length, m: matchedCount })}
        </span>
      </div>
      <Sparkline data={history} width={720} height={32} color="var(--green)" />

      {/* Lista ostatnich odczytów */}
      <div style={{
        marginTop: 12, paddingTop: 12,
        borderTop: '1px solid var(--border)',
        flex: 1,
        maxHeight: 320,
        overflowY: 'auto',
        fontSize: 12,
      }}>
        {sorted.length === 0 ? (
          <div style={{
            padding: 24, textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 12,
            fontStyle: 'italic',
          }}>
            {t('monitoring.lprReads.empty')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {sorted.map((r) => (
              <LprReadRow key={r.id} read={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function LprReadRow({ read }: { read: RecentLprRead }) {
  const { t, lang } = useTranslation()
  const time = formatEdgeTime(read.ts, lang)
  const ago = Date.now() - read.ts
  const agoLabel = ago < 60_000 ? t('common.ago_sec', { n: Math.round(ago / 1000) })
                : ago < 3_600_000 ? t('common.ago_min', { n: Math.round(ago / 60_000) })
                : ago < 86_400_000 ? t('common.ago_hr', { n: Math.round(ago / 3_600_000) })
                : t('common.ago_day', { n: Math.round(ago / 86_400_000) })

  // Direction badge — Hikvision LPR daje "forward"/"reverse", chcemy IN/OUT.
  // Sprzętowo: integrator mapuje kierunek w wizardzie kamery, my tu pokazujemy raw.
  const dirLabel = read.direction === 'forward' ? '→ IN'
                : read.direction === 'reverse' ? '← OUT'
                : read.direction ?? '—'

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '70px 110px 60px 50px 90px 1fr auto',
      gap: 8,
      alignItems: 'center',
      padding: '4px 6px',
      borderRadius: 'var(--r-1)',
    }}>
      <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: 'var(--muted)' }}>
        {time}
      </span>
      {/* Plate w boxie podobnym do tablicy rejestracyjnej */}
      <span style={{
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: 12, fontWeight: 700, color: 'var(--ink)',
        padding: '2px 8px',
        background: 'var(--surface-2)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--r-1)',
        letterSpacing: 0.5,
        textAlign: 'center',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        <Car size={11} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 4, color: 'var(--muted-2)' }} />
        {read.plate}
      </span>
      <span style={{ fontSize: 11, color: 'var(--muted-2)', fontFamily: '"IBM Plex Mono", monospace' }}>
        {dirLabel}
      </span>
      <span style={{ fontSize: 10, color: 'var(--muted)', textAlign: 'right' }}>
        {read.confidence != null
          ? `${Math.round(read.confidence > 1 ? read.confidence : read.confidence * 100)}%`
          : ''}
      </span>
      <span style={{
        fontSize: 10, fontWeight: 600,
        padding: '2px 6px', borderRadius: 999,
        textAlign: 'center',
        background: read.matched ? 'var(--green-50)' : 'var(--surface-2)',
        color: read.matched ? 'var(--green)' : 'var(--muted)',
        border: `1px solid ${read.matched ? 'var(--green)' : 'var(--border-strong)'}`,
      }}>
        {read.matched ? t('lpr.badge.match') : t('lpr.badge.noMatch')}
      </span>
      <span style={{ fontSize: 10, color: 'var(--muted-2)' }}>
        {read.gateOpened && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 6px', borderRadius: 999,
            background: 'var(--blue-50)', color: 'var(--blue)',
            border: '1px solid var(--blue)',
            fontWeight: 600,
          }}>
            <DoorOpen size={10} /> {t('lpr.badge.gateOpened')}
          </span>
        )}
      </span>
      <span style={{ fontSize: 10, color: 'var(--muted)', minWidth: 60, textAlign: 'right' }}>
        {agoLabel}
      </span>
    </div>
  )
}
