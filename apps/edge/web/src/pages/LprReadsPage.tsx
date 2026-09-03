/**
 * LprReadsPage — pełnoekranowa zakładka „Odczyty LPR".
 *
 * Pokazuje cross-camera feed odczytów ANPR z lokalnej bazy `lpr_reads`
 * (sqlite, 30-dniowy TTL). Source of truth = Edge — Cloud dostaje kopie przez
 * tunel WS (`LPR_READ` event) i pokazuje BA/konsjerż w swoich panelach.
 *
 * Funkcje:
 *  • filtry: tablica (substring), matched/no-match, kamera, limit
 *  • dla każdego odczytu: czas, tablica (mono box), brand/color/type, kierunek,
 *    confidence, badge MATCH/NO MATCH, badge BRAMA jeśli `gateOpened`,
 *    klikalny thumbnail (modal fullscreen image)
 *  • polling 10 s
 *
 * Architektonicznie: zostawiamy stary `/ui-legacy/index.html` „Plates modal"
 * jako kopię zapasową; nowy panel ma własny widok bo legacy modal był per-camera
 * i wymagał wybierania kamery najpierw — w realnej instalacji kilka bram
 * (wjazd/wyjazd) i instalator chce widzieć wszystko jednym ekranem.
 */
import { useEffect, useMemo, useState } from 'react'
import { formatEdgeDateTime } from '../lib/edgeTime'
import {
  ScanLine, Search, Car, DoorOpen, X, RefreshCw, Image as ImageIcon, Filter,
} from 'lucide-react'
import { api } from '../lib/api'
import { useDevices } from '../lib/useDevices'
import { useTranslation } from '../i18n'

type MatchedFilter = 'all' | 'matched' | 'unmatched'

interface LprReadRow {
  id: number
  cameraDeviceId: string
  plate: string
  matched: boolean
  /** Privacy-safe label lokalu z whitelist match-u (np. "Niewinna 6/1"). Wcześniej
   *  było tu pole `owner` (imię + nazwisko mieszkańca) — zostało wymienione na
   *  privacy-friendly identyfikator widziany przez instalatora. */
  unitLabel: string | null
  gateOpened: boolean
  reason: string | null
  confidence: number | null
  direction: string | null
  ts: number
  imagePath: string | null
  vehicleColor: string | null
  vehicleBrand: string | null
  vehicleType: string | null
  vehicleSubtype: string | null
}

export function LprReadsPage() {
  const [plate, setPlate] = useState('')
  const [matched, setMatched] = useState<MatchedFilter>('all')
  const [cameraFilter, setCameraFilter] = useState<string>('all')
  const [limit, setLimit] = useState(200)
  const [reads, setReads] = useState<LprReadRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [zoomId, setZoomId] = useState<number | null>(null)
  const { t } = useTranslation()

  // Cameras dropdown — z device list, filter po typie LPR_CAMERA (+ CAMERA bo
  // niektóre instalacje robią ANPR z normalnej kamery z modułem AI).
  const { devices } = useDevices()
  const lprCameras = useMemo(
    () => devices?.filter(
      (d) => d.type === 'LPR_CAMERA' || d.type === 'CAMERA',
    ) ?? [],
    [devices],
  )

  // Mapa cameraId → nazwa, do wyświetlania w wierszu
  const cameraNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of devices ?? []) {
      m.set(d.deviceId, d.config?.name ?? d.deviceId)
    }
    return m
  }, [devices])

  // Trzymamy plate w debounced query
  const [debouncedPlate, setDebouncedPlate] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedPlate(plate), 250)
    return () => clearTimeout(t)
  }, [plate])

  // Fetch + polling
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await api.listLprReads({
          plate: debouncedPlate || undefined,
          matched: matched === 'matched' ? 'true' : matched === 'unmatched' ? 'false' : undefined,
          cameraId: cameraFilter !== 'all' ? cameraFilter : undefined,
          limit,
        })
        if (!cancelled) {
          setReads(res.reads)
          setError(null)
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, 10_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [debouncedPlate, matched, cameraFilter, limit])

  const zoomRead = useMemo(() => reads.find((r) => r.id === zoomId) ?? null, [reads, zoomId])

  return (
    <div>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        marginBottom: 16,
        gap: 16,
        flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ink)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <ScanLine size={20} strokeWidth={1.8} />
            {t('lpr.title')}
          </h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            {t('lpr.subtitle')}
          </p>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {loading
            ? <RefreshCw size={12} strokeWidth={1.8} style={{ display: 'inline', verticalAlign: '-2px' }} className="spin" />
            : `${reads.length} ${reads.length === 1 ? t('lpr.entry') : t('lpr.entries')}`}
          {' · '}{t('lpr.poll')}
        </div>
      </div>

      {/* Filtry */}
      <div className="card" style={{
        padding: 12, marginBottom: 12,
        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <Filter size={14} strokeWidth={1.8} style={{ color: 'var(--muted-2)' }} />

        {/* Search plate */}
        <div style={{ position: 'relative', minWidth: 220 }}>
          <Search size={12} style={{
            position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--muted-2)',
          }} />
          <input
            type="text"
            value={plate}
            onChange={(e) => setPlate(e.target.value)}
            placeholder={t('lpr.search.placeholder')}
            style={{
              width: '100%',
              padding: '6px 8px 6px 26px',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--ink)',
              borderRadius: 'var(--r-2)',
              fontSize: 12,
              fontFamily: '"IBM Plex Mono", monospace',
            }}
          />
        </div>

        {/* Matched filter */}
        <select
          value={matched}
          onChange={(e) => setMatched(e.target.value as MatchedFilter)}
          style={{
            padding: '6px 8px',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 'var(--r-2)',
            fontSize: 12,
          }}
        >
          <option value="all">{t('lpr.filter.all')}</option>
          <option value="matched">{t('lpr.filter.matched')}</option>
          <option value="unmatched">{t('lpr.filter.unmatched')}</option>
        </select>

        {/* Camera filter */}
        <select
          value={cameraFilter}
          onChange={(e) => setCameraFilter(e.target.value)}
          style={{
            padding: '6px 8px',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 'var(--r-2)',
            fontSize: 12,
            minWidth: 180,
          }}
        >
          <option value="all">{t('lpr.filter.allCameras')}</option>
          {lprCameras.map((cam) => (
            <option key={cam.deviceId} value={cam.deviceId}>
              {/* MVP 2026-07: zwykła kamera (typ CAMERA) nie czyta tablic —
                  komunikujemy to wprost zamiast udawać LPR. */}
              {(cam.config?.name ?? cam.deviceId.slice(0, 8)) +
                (cam.type === 'CAMERA' ? ' — bez LPR (tylko podgląd)' : '')}
            </option>
          ))}
        </select>

        {/* Limit */}
        <select
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10))}
          style={{
            padding: '6px 8px',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 'var(--r-2)',
            fontSize: 12,
          }}
        >
          <option value={50}>{t('lpr.limit.50')}</option>
          <option value={200}>{t('lpr.limit.200')}</option>
          <option value={500}>{t('lpr.limit.500')}</option>
          <option value={1000}>{t('lpr.limit.1000')}</option>
        </select>

        <div style={{ flex: 1 }} />

        {(plate || matched !== 'all' || cameraFilter !== 'all') && (
          <button
            onClick={() => { setPlate(''); setMatched('all'); setCameraFilter('all') }}
            className="btn"
            style={{ fontSize: 11 }}
          >
            <X size={12} />
            {t('lpr.filter.clear')}
          </button>
        )}
      </div>

      {error && (
        <div className="card" style={{
          padding: 12, marginBottom: 12,
          background: 'var(--red-50)', borderColor: 'var(--red)', color: 'var(--red)',
          fontSize: 13,
        }}>
          {t('common.error')}: {error}
        </div>
      )}

      {/* Tabela odczytów */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {reads.length === 0 && !loading ? (
          <div style={{
            padding: 48, textAlign: 'center',
            color: 'var(--muted)', fontSize: 13,
          }}>
            <ScanLine size={32} strokeWidth={1.5} style={{ opacity: 0.5, margin: '0 auto 12px' }} />
            <div style={{ fontWeight: 500, marginBottom: 4 }}>{t('lpr.empty.title')}</div>
            <div style={{ fontSize: 12 }}>
              {plate || matched !== 'all' || cameraFilter !== 'all'
                ? t('lpr.empty.filtered')
                : t('lpr.empty.initial')}
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12,
            }}>
              <thead>
                <tr style={{
                  background: 'var(--surface-2)',
                  borderBottom: '1px solid var(--border)',
                  textAlign: 'left',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}>
                  <th style={{ padding: '8px 12px' }}>{t('lpr.col.image')}</th>
                  <th style={{ padding: '8px 12px' }}>{t('lpr.col.time')}</th>
                  <th style={{ padding: '8px 12px' }}>{t('lpr.col.plate')}</th>
                  <th style={{ padding: '8px 12px' }}>{t('lpr.col.vehicle')}</th>
                  <th style={{ padding: '8px 12px' }}>{t('lpr.col.camera')}</th>
                  <th style={{ padding: '8px 12px' }}>{t('lpr.col.direction')}</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>{t('lpr.col.confidence')}</th>
                  <th style={{ padding: '8px 12px' }}>{t('lpr.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {reads.map((r) => (
                  <ReadRow
                    key={r.id}
                    read={r}
                    cameraName={cameraNameById.get(r.cameraDeviceId) ?? r.cameraDeviceId.slice(0, 8)}
                    onZoom={() => setZoomId(r.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal podglądu zdjęcia */}
      {zoomRead && (
        <ImageZoomModal read={zoomRead} onClose={() => setZoomId(null)} />
      )}
    </div>
  )
}

// ── Row ────────────────────────────────────────────────────────────────────

function ReadRow({ read, cameraName, onZoom }: {
  read: LprReadRow
  cameraName: string
  onZoom: () => void
}) {
  const { t, lang } = useTranslation()
  // Czas OBIEKTU, nie przeglądarki — patrz `lib/edgeTime.ts`.
  const time = formatEdgeDateTime(read.ts, lang)

  const dirLabel = read.direction === 'forward' ? '→ IN'
                : read.direction === 'reverse' ? '← OUT'
                : read.direction ?? '—'

  const confPct = read.confidence != null
    ? Math.round(read.confidence > 1 ? read.confidence : read.confidence * 100)
    : null

  // Brand line — łączymy brand / color / type w jeden ładny string
  const vehicleParts = [
    read.vehicleBrand,
    read.vehicleColor,
    read.vehicleType,
    read.vehicleSubtype,
  ].filter(Boolean)

  return (
    <tr style={{
      borderBottom: '1px solid var(--border)',
      transition: 'background 80ms',
    }}>
      <td style={{ padding: '8px 12px', verticalAlign: 'middle' }}>
        {read.imagePath ? (
          <button
            onClick={onZoom}
            style={{
              width: 72, height: 48,
              padding: 0, border: '1px solid var(--border)',
              borderRadius: 'var(--r-1)',
              overflow: 'hidden', cursor: 'pointer',
              background: 'var(--surface-2)',
            }}
            title={t('lpr.zoom')}
          >
            <img
              src={`/lpr/reads/${read.id}/image`}
              alt={read.plate}
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          </button>
        ) : (
          <div style={{
            width: 72, height: 48,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px dashed var(--border-strong)',
            borderRadius: 'var(--r-1)',
            color: 'var(--muted-2)',
          }}>
            <ImageIcon size={16} />
          </div>
        )}
      </td>
      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--muted)', fontFamily: '"IBM Plex Mono", monospace', fontSize: 11 }}>
        {time}
      </td>
      <td style={{ padding: '8px 12px' }}>
        <span style={{
          fontFamily: '"IBM Plex Mono", monospace',
          fontSize: 13, fontWeight: 700, color: 'var(--ink)',
          padding: '3px 10px',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--r-1)',
          letterSpacing: 0.5,
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          <Car size={11} style={{ color: 'var(--muted-2)' }} />
          {read.plate}
        </span>
        {read.unitLabel && (
          <div style={{
            fontSize: 11, color: 'var(--muted)', marginTop: 4,
            fontFamily: '"IBM Plex Mono", monospace',
          }} title={t('lpr.unitLabel.tooltip')}>
            🏠 {read.unitLabel}
          </div>
        )}
      </td>
      <td style={{ padding: '8px 12px', color: 'var(--ink-2)', fontSize: 11 }}>
        {vehicleParts.length > 0 ? vehicleParts.join(' · ') : <span style={{ color: 'var(--muted-2)' }}>—</span>}
      </td>
      <td style={{ padding: '8px 12px', color: 'var(--ink-2)', fontSize: 11, whiteSpace: 'nowrap' }}>
        {cameraName}
      </td>
      <td style={{ padding: '8px 12px', fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: 'var(--muted-2)' }}>
        {dirLabel}
      </td>
      <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: '"IBM Plex Mono", monospace', fontSize: 11, color: 'var(--muted)' }}>
        {confPct != null ? `${confPct}%` : '—'}
      </td>
      <td style={{ padding: '8px 12px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
          <span style={{
            fontSize: 10, fontWeight: 600,
            padding: '2px 8px', borderRadius: 999,
            background: read.matched ? 'var(--green-50)' : 'var(--surface-2)',
            color: read.matched ? 'var(--green)' : 'var(--muted)',
            border: `1px solid ${read.matched ? 'var(--green)' : 'var(--border-strong)'}`,
          }}>
            {read.matched ? t('lpr.badge.match') : t('lpr.badge.noMatch')}
          </span>
          {read.gateOpened && (
            <span style={{
              fontSize: 10, fontWeight: 600,
              padding: '2px 8px', borderRadius: 999,
              background: 'var(--blue-50)', color: 'var(--blue)',
              border: '1px solid var(--blue)',
              display: 'inline-flex', alignItems: 'center', gap: 3,
            }}>
              <DoorOpen size={10} /> {t('lpr.badge.gateOpened')}
            </span>
          )}
          {read.reason && !read.matched && (
            <span style={{ fontSize: 10, color: 'var(--muted-2)', fontStyle: 'italic' }}>
              {read.reason}
            </span>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Modal podglądu zdjęcia ─────────────────────────────────────────────────

function ImageZoomModal({ read, onClose }: { read: LprReadRow; onClose: () => void }) {
  const { t, lang } = useTranslation()
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(4px)',
        zIndex: 300,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: 40,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '90vw', maxHeight: '85vh',
          display: 'flex', flexDirection: 'column',
          gap: 12, alignItems: 'center',
        }}
      >
        <img
          src={`/lpr/reads/${read.id}/image`}
          alt={read.plate}
          style={{
            maxWidth: '100%', maxHeight: '70vh',
            objectFit: 'contain',
            borderRadius: 'var(--r-2)',
            border: '1px solid var(--border-strong)',
            background: '#000',
          }}
        />
        <div style={{
          display: 'flex', gap: 16, alignItems: 'center',
          padding: '10px 16px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-2)',
          fontSize: 12,
        }}>
          <span style={{
            fontFamily: '"IBM Plex Mono", monospace',
            fontSize: 14, fontWeight: 700,
            padding: '4px 12px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--r-1)',
          }}>
            {read.plate}
          </span>
          <span style={{ color: 'var(--muted)' }}>
            {formatEdgeDateTime(read.ts, lang, { dateStyle: 'medium', timeStyle: 'medium' })}
          </span>
          {read.confidence != null && (
            <span style={{ color: 'var(--muted)' }}>
              {Math.round(read.confidence > 1 ? read.confidence : read.confidence * 100)}% {t('lpr.confidence')}
            </span>
          )}
        </div>
      </div>

      <button
        onClick={onClose}
        style={{
          position: 'absolute', top: 24, right: 24,
          width: 40, height: 40, borderRadius: '50%',
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.2)',
          color: 'white', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        title={`${t('common.close')} (Esc)`}
      >
        <X size={20} />
      </button>
    </div>
  )
}
