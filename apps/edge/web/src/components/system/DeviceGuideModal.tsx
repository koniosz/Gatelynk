/**
 * DeviceGuideModal — panel „Przewodnik konfiguracji" dla jednego urządzenia.
 *
 * Otwierany ikoną 📘 na karcie urządzenia (DeviceCard). Pokazuje DWIE części:
 *   A. Bieżące ustawienia — realny config z GET /devices (hasła ZAMASKOWANE).
 *   B. Checklist kroków do wykonania W SAMYM urządzeniu Akuvox (per model, z docs).
 *
 * Styl dopasowany do DeviceDrawer (side-sheet 540px, te same tokeny/zakładki).
 * Treść kroków = `deviceGuides.ts` (dane), tu tylko render + placeholder substitution
 * + best-effort statusy wyliczone z tego co Edge wie.
 */
import { useState, useEffect } from 'react'
import {
  X, BookOpen, CheckCircle2, AlertTriangle, HelpCircle,
} from 'lucide-react'
import type { DeviceEntry, DeviceTreeNode } from '../../lib/types'
import { deviceMeta, shortMac } from '../../lib/deviceMeta'
import { resolveGuide, fillPlaceholders, type StepStatus } from '../../lib/deviceGuides'
import { api } from '../../lib/api'

interface DeviceGuideModalProps {
  device: DeviceEntry
  status?: DeviceTreeNode
  onClose: () => void
}

/** Czy hostname z którego serwowany jest panel wygląda na prywatny adres LAN. */
function detectEdgeIp(): string | null {
  if (typeof window === 'undefined') return null
  const host = window.location.hostname
  if (/^192\.168\.\d+\.\d+$/.test(host)) return host
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return host
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return host
  return null // localhost / 127.0.0.1 / Tailscale — nie traktujemy jako LAN IP kasety
}

export function DeviceGuideModal({ device, status, onClose }: DeviceGuideModalProps) {
  const { icon: Icon } = deviceMeta(device.type)
  const guide = resolveGuide(device.config, device.type)
  const online = status?.online ?? false

  const [buildingId, setBuildingId] = useState<number | null>(null)
  const edgeIp = detectEdgeIp()

  // ESC zamyka
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // buildingId z aktywacji Edge (do placeholdera Remote Phonebook)
  useEffect(() => {
    let cancelled = false
    api.getActivationConfig()
      .then((c) => { if (!cancelled) setBuildingId(c.buildingId) })
      .catch(() => { /* placeholder zostaje */ })
    return () => { cancelled = true }
  }, [])

  const vars = { edgeIp, buildingId, ip: device.config.ipAddress ?? null }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(2px)',
        zIndex: 220,
        display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 620,
          maxWidth: '100vw',
          height: '100vh',
          background: 'var(--surface)',
          borderLeft: '1px solid var(--border)',
          boxShadow: 'var(--shadow-2)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <div style={{
            width: 36, height: 36,
            borderRadius: 'var(--r-2)',
            background: 'var(--blue-50)',
            border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--blue)', flexShrink: 0,
          }}>
            <BookOpen size={18} strokeWidth={1.8} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Przewodnik konfiguracji
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              <Icon size={12} strokeWidth={1.8} />
              {device.config.name ?? device.deviceId} · {guide.title}
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} title="Zamknij (Esc)">
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
          {guide.summary && (
            <p style={{
              fontSize: 12, lineHeight: 1.5, color: 'var(--ink-2)',
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-2)', padding: 12, margin: '0 0 20px 0',
            }}>
              {guide.summary}
            </p>
          )}

          {/* ── CZĘŚĆ A: bieżące ustawienia ─────────────────────────────── */}
          <SectionTitle>A · Bieżące ustawienia (co Edge wie o tym urządzeniu)</SectionTitle>
          <div style={{
            background: 'var(--bg-2)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-2)', padding: '4px 12px', marginBottom: 24,
          }}>
            <KV label="Nazwa" value={device.config.name} />
            <KV label="Typ" value={device.type} mono />
            <KV label="Producent" value={device.config.manufacturer} />
            <KV label="Model" value={device.config.model} />
            <KV label="Driver" value={device.config.driverId} mono />
            <KV label="IP" value={device.config.ipAddress} mono />
            <KV label="Port HTTP" value={device.config.httpPort} mono />
            <KV label="Port RTSP" value={device.config.rtspPort} mono />
            <KV label="Port MJPEG" value={device.config.mjpegPort} mono />
            <KV label="RTSP path" value={device.config.rtspPath} mono />
            <KV label="MAC" value={shortMac(device.config.mac)} mono />
            <KV label="Login" value={device.config.login} mono />
            <KV label="Hasło web" value={maskSecret(device.config.password)} mono />
            <KV label="Hasło API (rtspPassword)" value={maskSecret(device.config.rtspPassword)} mono />
            <KV
              label="Przekaźniki"
              value={
                device.config.relays && device.config.relays.length > 0
                  ? device.config.relays.map((r) => `#${r.index} ${r.name}`).join(' · ')
                  : undefined
              }
            />
            <KV label="requiresUnauthenticatedFallback" value={boolLabel(device.config.requiresUnauthenticatedFallback)} mono />
            <KV label="Status live" value={online ? 'Online' : 'Offline'} />
          </div>

          {/* ── CZĘŚĆ B: checklist kroków ────────────────────────────────── */}
          <SectionTitle>B · Kroki do wykonania w urządzeniu ({guide.title})</SectionTitle>

          {guide.steps.length === 0 ? (
            <div style={{
              padding: 20, textAlign: 'center', color: 'var(--muted)',
              background: 'var(--surface-2)', border: '1px dashed var(--border-strong)',
              borderRadius: 'var(--r-2)', fontSize: 12,
            }}>
              Brak przewodnika krok po kroku dla tego modelu (do uzupełnienia).
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {guide.steps.map((step, i) => {
                const st = step.status?.(device)
                return (
                  <div
                    key={i}
                    style={{
                      border: `1px solid ${step.critical ? 'var(--amber)' : 'var(--border)'}`,
                      background: step.critical ? 'var(--amber-50)' : 'var(--surface-2)',
                      borderRadius: 'var(--r-2)',
                      padding: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <span style={{
                        flexShrink: 0,
                        width: 22, height: 22,
                        borderRadius: '50%',
                        background: step.critical ? 'var(--amber)' : 'var(--blue)',
                        color: 'white',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 700,
                        marginTop: 1,
                      }}>
                        {i + 1}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                            {step.title}
                          </span>
                          {step.critical && (
                            <span style={{
                              fontSize: 9, fontWeight: 700, letterSpacing: 0.5,
                              color: 'var(--amber)', border: '1px solid var(--amber)',
                              borderRadius: 'var(--r-1)', padding: '1px 5px', textTransform: 'uppercase',
                            }}>
                              Krytyczny
                            </span>
                          )}
                          {st && <StatusBadge status={st} />}
                        </div>

                        {step.path && (
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                            <span style={{ color: 'var(--muted-2)' }}>Ścieżka: </span>
                            <span className="mono">{fillPlaceholders(step.path, vars)}</span>
                          </div>
                        )}
                        {step.value && (
                          <div style={{
                            fontSize: 12, marginTop: 6,
                            background: 'var(--surface)', border: '1px solid var(--border)',
                            borderRadius: 'var(--r-1)', padding: '6px 8px',
                            color: 'var(--ink-2)', lineHeight: 1.45,
                            wordBreak: 'break-word',
                          }} className="mono">
                            {fillPlaceholders(step.value, vars)}
                          </div>
                        )}
                        {step.why && (
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>
                            <span style={{ fontWeight: 600, color: 'var(--muted-2)' }}>Dlaczego: </span>
                            {step.why}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Legenda placeholderów */}
          {guide.usesPlaceholders && (
            <div style={{
              marginTop: 16, fontSize: 11, color: 'var(--muted)',
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-2)', padding: 10, lineHeight: 1.6,
            }}>
              <strong style={{ color: 'var(--ink-2)' }}>Legenda placeholderów:</strong>
              <div>
                <code>&lt;edge-ip&gt;</code> ={' '}
                {edgeIp
                  ? <span className="mono">{edgeIp}</span>
                  : <span>nierozpoznane (otwórz panel przez LAN IP Edge, np. 192.168.1.127) — <em>uzupełnij ręcznie</em></span>}
              </div>
              <div>
                <code>&lt;buildingId&gt;</code> ={' '}
                {buildingId != null
                  ? <span className="mono">{buildingId}</span>
                  : <span>z aktywacji Edge (jeszcze nieaktywowany / brak) — <em>uzupełnij ręcznie</em></span>}
              </div>
              <div>
                <code>&lt;token&gt;</code> = token Remote Phonebook — <em>pobierz gotowy URL z panelu Integratora</em> (liczony z JWT_SECRET na Cloud, NIE na Edge).
              </div>
            </div>
          )}

          {/* Uwagi */}
          {guide.notes && guide.notes.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <SectionTitle>Uwagi</SectionTitle>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>
                {guide.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}

          {guide.docRef && (
            <div style={{ marginTop: 16, fontSize: 10, color: 'var(--muted-2)' }}>
              Źródło: <span className="mono">{guide.docRef}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Helpery ──────────────────────────────────────────────────────────────────

function maskSecret(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  return '•••••• (ustawione)'
}

function boolLabel(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  return v ? 'true' : 'false'
}

function StatusBadge({ status }: { status: StepStatus }) {
  const map = {
    ok:      { Icon: CheckCircle2, color: 'var(--green)', label: 'Edge gotowy' },
    warn:    { Icon: AlertTriangle, color: 'var(--amber)', label: 'Do ustawienia' },
    unknown: { Icon: HelpCircle,   color: 'var(--muted)', label: 'Nieznany' },
  } as const
  const { Icon, color, label } = map[status]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 10, fontWeight: 600, color,
    }}>
      <Icon size={12} strokeWidth={2.2} />
      {label}
    </span>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      fontSize: 11, fontWeight: 600, color: 'var(--muted)',
      textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 10px 0',
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      {children}
    </h3>
  )
}

function KV({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '210px 1fr', gap: 12,
      padding: '5px 0', fontSize: 12, alignItems: 'baseline',
      borderBottom: '1px solid var(--border)',
    }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span
        className={mono ? 'mono' : undefined}
        style={{ color: value == null ? 'var(--muted-2)' : 'var(--ink)', fontSize: mono ? 11 : 12, wordBreak: 'break-word' }}
      >
        {value ?? '—'}
      </span>
    </div>
  )
}
