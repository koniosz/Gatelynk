/**
 * NetworkChart — big SVG chart dla ruchu sieciowego (in + out).
 *
 * Z handoff doc: „Big chart: ruch sieciowy in/out".
 * Dwie linie (download/upload) + filled area, oś Y w Mbps, oś X timestamps.
 * Bez gridów (industrial minimalism).
 */
import { useTranslation } from '../../i18n'

interface NetworkChartProps {
  netIn: number[]      // Mbps
  netOut: number[]     // Mbps
  timestamps: string[] // ISO dates
  height?: number
}

export function NetworkChart({ netIn, netOut, timestamps, height = 180 }: NetworkChartProps) {
  const { t } = useTranslation()
  const validIn = netIn.filter((v) => Number.isFinite(v))
  const validOut = netOut.filter((v) => Number.isFinite(v))
  const max = Math.max(0.1, ...validIn, ...validOut) // min 0.1 żeby niezerowy zakres

  if (netIn.length === 0) {
    return (
      <div
        className="card"
        style={{
          height,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--muted)', fontSize: 13,
        }}
      >
        {t('monitoring.network.waiting')}
      </div>
    )
  }

  const W = 800  // viewBox; SVG skaluje się do kontenera (preserveAspectRatio)
  const H = height
  const stepX = netIn.length > 1 ? W / (netIn.length - 1) : W

  const buildPath = (data: number[]) => data
    .map((v, i) => `${i === 0 ? 'M' : 'L'} ${(i * stepX).toFixed(1)} ${(H - (v / max) * H).toFixed(1)}`)
    .join(' ')

  const buildArea = (data: number[]) => {
    if (data.length === 0) return ''
    const points = data
      .map((v, i) => `${(i * stepX).toFixed(1)} ${(H - (v / max) * H).toFixed(1)}`)
    return `M 0 ${H} L ${points.join(' L ')} L ${((data.length - 1) * stepX).toFixed(1)} ${H} Z`
  }

  // Format axis label — first / mid / last timestamp do HH:MM.
  const formatTime = (iso: string) => {
    const d = new Date(iso)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }
  const firstT = timestamps[0]
  const lastT = timestamps[timestamps.length - 1]
  const midT = timestamps[Math.floor(timestamps.length / 2)]

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>
          {t('monitoring.network.title')}
        </h3>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, fontFamily: '"IBM Plex Mono", monospace' }}>
          <LegendItem color="var(--blue)" label={`↓ ${(validIn[validIn.length - 1] ?? 0).toFixed(2)} Mbps`} />
          <LegendItem color="var(--green)" label={`↑ ${(validOut[validOut.length - 1] ?? 0).toFixed(2)} Mbps`} />
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block' }}
      >
        {/* netIn area */}
        <path d={buildArea(netIn)} fill="var(--blue)" fillOpacity={0.12} />
        <path d={buildPath(netIn)} fill="none" stroke="var(--blue)" strokeWidth={1.5} strokeLinejoin="round" />
        {/* netOut area */}
        <path d={buildArea(netOut)} fill="var(--green)" fillOpacity={0.12} />
        <path d={buildPath(netOut)} fill="none" stroke="var(--green)" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 10,
        color: 'var(--muted-2)',
        fontFamily: '"IBM Plex Mono", monospace',
        marginTop: 6,
      }}>
        <span>{firstT ? formatTime(firstT) : ''}</span>
        <span>{midT ? formatTime(midT) : ''}</span>
        <span>{lastT ? formatTime(lastT) : ''}</span>
      </div>
    </div>
  )
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 8, height: 8, background: color, borderRadius: 2 }} />
      <span style={{ color: 'var(--ink-2)' }}>{label}</span>
    </span>
  )
}
