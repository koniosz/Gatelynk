/**
 * PortsTab — zarządzanie portami managed switcha (UniFi / Cisco / HP).
 *
 * Funkcje:
 *   • Live status portu (link up/down, prędkość, PoE on/off, pobór mocy W)
 *   • Toggle PoE per port (przekierowuje do controllera UniFi)
 *   • Przypisanie GateLynk deviceId do portu (dropdown z listy intercom/camera/lpr)
 *   • Edycja własnego label-a portu (pushowane do `port_overrides[].name` w UniFi)
 *
 * Polling: co 10s odpytujemy GET /devices/:id/switch/ports (cache backendu jest
 * świeży co `pollSeconds` z configu — typowo 15s; double-buffer wygładza UX).
 */
import { useEffect, useState } from 'react'
import { RefreshCw, Zap, ZapOff, Cable, AlertTriangle, Save, X } from 'lucide-react'
import { api } from '../../lib/api'
import { useDevices } from '../../lib/useDevices'
import { useTranslation } from '../../i18n'
import type { PortStateView, LanSwitchStatus } from '../../lib/types'

interface Props {
  deviceId: string
}

export function PortsTab({ deviceId }: Props) {
  const { t } = useTranslation()
  const { devices } = useDevices()
  const [ports, setPorts] = useState<PortStateView[]>([])
  const [status, setStatus] = useState<LanSwitchStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftAssigned, setDraftAssigned] = useState<string>('')

  async function refresh() {
    try {
      const res = await api.listSwitchPorts(deviceId)
      setPorts(res.ports)
      setStatus(res.status)
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 10_000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId])

  async function handleForceRefresh() {
    setLoading(true)
    try {
      await api.refreshSwitch(deviceId)
      await refresh()
    } catch (err: any) {
      setError(err?.message ?? String(err))
      setLoading(false)
    }
  }

  async function togglePoe(port: PortStateView) {
    if (busy !== null) return
    setBusy(port.portIdx)
    setError(null)
    try {
      await api.setPortPoe(deviceId, port.portIdx, !port.poeEnabled)
      // Optimistic
      setPorts((prev) => prev.map((p) =>
        p.portIdx === port.portIdx ? { ...p, poeEnabled: !p.poeEnabled, poeMode: !p.poeEnabled ? 'auto' : 'off' } : p,
      ))
      setTimeout(refresh, 1500)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }

  function startEdit(port: PortStateView) {
    setEditing(port.portIdx)
    setDraftLabel(port.customLabel ?? '')
    setDraftAssigned(port.assignedDeviceId ?? '')
  }

  async function saveAssignment() {
    if (editing === null) return
    setBusy(editing)
    setError(null)
    try {
      await api.setPortAssignment(deviceId, editing, {
        label: draftLabel,
        assignedDeviceId: draftAssigned ? draftAssigned : null,
      })
      setEditing(null)
      await refresh()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }

  // Devices that can be assigned to a switch port (skip self + other switches)
  const assignableDevices = devices.filter(
    (d) => d.deviceId !== deviceId && d.type !== 'LAN_SWITCH',
  )

  return (
    <div>
      {/* Status header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14, gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: status?.online ? 'var(--success, #22c55e)' : 'var(--red)',
          }} />
          <span style={{ fontSize: 13, color: 'var(--ink)' }}>
            {status?.online ? t('ports.controller.online') : t('ports.controller.offline')}
          </span>
          {status?.lastFetchedAt && (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              · {t('ports.lastFetched')} {formatAgo(status.lastFetchedAt, t)}
            </span>
          )}
        </div>
        <button className="btn" onClick={handleForceRefresh} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
          {t('common.refresh')}
        </button>
      </div>

      {/* Error / fetch problem */}
      {(error || status?.lastError) && (
        <div style={{
          marginBottom: 14, padding: 10,
          background: 'var(--red-50, rgba(239,68,68,0.1))',
          border: '1px solid var(--red)',
          borderRadius: 'var(--r-2)',
          fontSize: 12, color: 'var(--red)',
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>{error || status?.lastError}</div>
        </div>
      )}

      {/* Port grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {ports.map((port) => {
          const assignedDev = port.assignedDeviceId
            ? devices.find((d) => d.deviceId === port.assignedDeviceId) ?? null
            : null
          const isEditing = editing === port.portIdx
          return (
            <div
              key={port.portIdx}
              style={{
                padding: '10px 12px',
                background: 'var(--surface-2)',
                border: `1px solid ${port.linkUp ? 'var(--border)' : 'var(--border-soft, var(--border))'}`,
                borderLeft: `3px solid ${port.linkUp ? 'var(--success, #22c55e)' : 'var(--muted)'}`,
                borderRadius: 'var(--r-2)',
              }}
            >
              {/* Row 1 — port summary */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '48px 1fr auto auto auto',
                gap: 10, alignItems: 'center',
              }}>
                <div style={{
                  fontSize: 16, fontWeight: 700, color: 'var(--ink)',
                  textAlign: 'center',
                  fontFamily: '"IBM Plex Mono", monospace',
                }}>
                  {port.portIdx}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                    {port.customLabel || port.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {port.linkUp
                      ? `${port.speedMbps >= 1000 ? `${port.speedMbps / 1000} Gbps` : `${port.speedMbps} Mbps`}`
                      : t('ports.link.down')}
                    {assignedDev && ` · ${assignedDev.config.name ?? assignedDev.deviceId.slice(0, 8)}`}
                  </div>
                </div>
                {/* Link indicator */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 11,
                  color: port.linkUp ? 'var(--success, #22c55e)' : 'var(--muted)',
                }}>
                  <Cable size={14} />
                  {port.linkUp ? t('ports.link.up') : '—'}
                </div>
                {/* PoE indicator + toggle */}
                <button
                  onClick={() => togglePoe(port)}
                  disabled={busy === port.portIdx}
                  className="btn"
                  style={{
                    padding: '4px 8px', fontSize: 11,
                    background: port.poeEnabled ? 'var(--accent-soft, rgba(37,99,235,0.12))' : 'var(--surface)',
                    borderColor: port.poeEnabled ? 'var(--accent, #2563eb)' : 'var(--border)',
                    color: port.poeEnabled ? 'var(--accent, #2563eb)' : 'var(--muted)',
                  }}
                  title={port.poeEnabled
                    ? `${t('ports.poe.on')} (${port.poePower.toFixed(1)} W)`
                    : t('ports.poe.off')}
                >
                  {port.poeEnabled ? <Zap size={12} /> : <ZapOff size={12} />}
                  {port.poeEnabled
                    ? port.poePower > 0 ? `${port.poePower.toFixed(1)} W` : t('ports.poe.on')
                    : t('ports.poe.off')}
                </button>
                {/* Edit assignment */}
                <button
                  onClick={() => isEditing ? setEditing(null) : startEdit(port)}
                  className="btn"
                  style={{ padding: '4px 8px', fontSize: 11 }}
                >
                  {isEditing ? <X size={12} /> : t('ports.assign.edit')}
                </button>
              </div>

              {/* Row 2 — edit form (collapsed by default) */}
              {isEditing && (
                <div style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: '1px dashed var(--border)',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr auto',
                  gap: 8, alignItems: 'center',
                }}>
                  <input
                    type="text"
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    placeholder={t('ports.assign.labelPlaceholder')}
                    style={inputStyle}
                  />
                  <select
                    value={draftAssigned}
                    onChange={(e) => setDraftAssigned(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">— {t('ports.assign.none')} —</option>
                    {assignableDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {(d.config.name ?? d.deviceId.slice(0, 8))} · {d.type}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={saveAssignment}
                    className="btn btn-primary"
                    disabled={busy === port.portIdx}
                    style={{ padding: '6px 10px' }}
                  >
                    <Save size={13} />
                    {t('common.save')}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {ports.length === 0 && !loading && (
        <div style={{
          padding: 24, textAlign: 'center',
          color: 'var(--muted)', fontSize: 13,
        }}>
          {t('ports.empty')}
        </div>
      )}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  padding: '6px 9px',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--ink)',
  borderRadius: 'var(--r-2)',
  fontSize: 12,
}

function formatAgo(ts: number, t: (k: string, v?: Record<string, string>) => string): string {
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 60) return t('common.ago_sec', { n: String(sec) })
  if (sec < 3600) return t('common.ago_min', { n: String(Math.round(sec / 60)) })
  return t('common.ago_hr', { n: String(Math.round(sec / 3600)) })
}
