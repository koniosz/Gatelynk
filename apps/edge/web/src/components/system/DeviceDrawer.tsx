/**
 * DeviceDrawer — side-sheet 540px do edycji urządzenia.
 *
 * Z handoff doc sek. 5:
 *   • Sekcje: Tożsamość · Konfiguracja · Przekaźniki · Diagnostyka
 *   • Footer: Usuń (danger) | Anuluj | Zapisz
 *
 * MVP: cztery zakładki (zamiast accordion — gęściej, mniej scrollowania).
 *   1. Tożsamość  — read-only KV (deviceId/type/manufacturer/model/IP/MAC/FW)
 *   2. Konfiguracja — edycja podstawowych pól (name/IP/login/password/channel)
 *   3. Przekaźniki — lista relays + trigger button + add/remove
 *   4. Diagnostyka — test-matrix per capability (✅/❌/🟡 z details)
 *
 * Zaawansowany dynamic form z driver-katalogu (wszystkie pola per driver)
 * — TODO. Tu wystarczy podstawowy crud.
 */
import { useState, useEffect } from 'react'
import { formatEdgeTime } from '../../lib/edgeTime'
import {
  X, Save, Trash2, RotateCw, Plus,
  CheckCircle2, AlertCircle, Circle, MinusCircle,
  Stethoscope, DoorOpen,
} from 'lucide-react'
import type { DeviceEntry, DeviceTreeNode, TestMatrix } from '../../lib/types'
import { deviceMeta, shortMac } from '../../lib/deviceMeta'
import { api } from '../../lib/api'
import { DynamicConfigForm } from './DynamicConfigForm'
import { PortsTab } from './PortsTab'
import { useTranslation } from '../../i18n'

type TabId = 'identity' | 'config' | 'relays' | 'ports' | 'diagnostics'

interface DeviceDrawerProps {
  device: DeviceEntry
  status?: DeviceTreeNode
  onClose: () => void
  onSaved?: () => void  // wywołane po PATCH — parent może refresh list
  onDeleted?: () => void
}

export function DeviceDrawer({ device, status, onClose, onSaved, onDeleted }: DeviceDrawerProps) {
  const [tab, setTab] = useState<TabId>('identity')
  const { icon: Icon, labelKey } = deviceMeta(device.type)
  const online = status?.online ?? false
  const { t } = useTranslation()
  const typeLabel = t(labelKey)

  // Lokalna kopia configu — edytujemy tu, save → PATCH.
  const [editedConfig, setEditedConfig] = useState({ ...device.config })
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const hasChanges = JSON.stringify(editedConfig) !== JSON.stringify(device.config)

  // ESC zamyka
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Edge PATCH przyjmuje `{ type, config }` — patrz `devices.controller.ts`.
      await fetch(`/devices/${device.deviceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: device.type, config: editedConfig }),
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      showToast('✓ Zapisano')
      onSaved?.()
    } catch (err: any) {
      showToast(`✗ ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(t('drawer.delete.confirm', { name: device.config.name ?? device.deviceId }))) return
    try {
      await api.deleteDevice(device.deviceId)
      onDeleted?.()
      onClose()
    } catch (err: any) {
      showToast(`✗ ${err.message}`)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(2px)',
        zIndex: 200,
        display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 540,
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
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
        }}>
          <div style={{
            width: 36, height: 36,
            borderRadius: 'var(--r-2)',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--muted)',
            flexShrink: 0,
          }}>
            <Icon size={18} strokeWidth={1.8} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {device.config.name ?? device.deviceId}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              <span className={online ? 'dot dot-green' : 'dot dot-gray'} />
              {typeLabel} · {online ? t('common.online') : t('common.offline')}
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} title={`${t('common.close')} (Esc)`}>
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex',
          gap: 0,
          padding: '0 20px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          {([
            { id: 'identity'    as TabId, key: 'drawer.tab.identity', show: true },
            { id: 'config'      as TabId, key: 'drawer.tab.config',   show: true },
            { id: 'relays'      as TabId, key: 'drawer.tab.relays',   show: device.type !== 'LAN_SWITCH' },
            { id: 'ports'       as TabId, key: 'drawer.tab.ports',    show: device.type === 'LAN_SWITCH' },
            { id: 'diagnostics' as TabId, key: 'drawer.tab.diagnostics', show: true },
          ]).filter((tabDef) => tabDef.show).map((tabDef) => (
            <button
              key={tabDef.id}
              onClick={() => setTab(tabDef.id)}
              style={{
                padding: '10px 14px',
                background: 'transparent',
                border: 'none',
                borderBottom: '2px solid',
                borderColor: tab === tabDef.id ? 'var(--blue)' : 'transparent',
                color: tab === tabDef.id ? 'var(--blue)' : 'var(--muted)',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                marginBottom: -1,
                transition: 'color 80ms, border-color 80ms',
              }}
            >
              {t(tabDef.key)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 20,
        }}>
          {tab === 'identity' && (
            <IdentityTab device={device} status={status} />
          )}
          {tab === 'config' && (
            <DynamicConfigForm config={editedConfig} onChange={setEditedConfig} type={device.type} />
          )}
          {tab === 'relays' && (
            <RelaysTab
              deviceId={device.deviceId}
              config={editedConfig}
              onChange={setEditedConfig}
            />
          )}
          {tab === 'ports' && (
            <PortsTab deviceId={device.deviceId} />
          )}
          {tab === 'diagnostics' && (
            <DiagnosticsTab deviceId={device.deviceId} />
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 20px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'var(--surface-2)',
          flexShrink: 0,
        }}>
          <button className="btn btn-danger" onClick={handleDelete}>
            <Trash2 size={14} />
            {t('common.delete')}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!hasChanges || saving}
          >
            {saving ? <RotateCw size={14} className="spin" /> : <Save size={14} />}
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>

        {toast && (
          <div style={{
            position: 'absolute',
            bottom: 80,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--ink)',
            color: 'var(--surface)',
            padding: '8px 14px',
            borderRadius: 'var(--r-3)',
            fontSize: 12,
            boxShadow: 'var(--shadow-2)',
          }}>
            {toast}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Tabs ───────────────────────────────────────────────────────────────────

function IdentityTab({ device, status }: { device: DeviceEntry; status?: DeviceTreeNode }) {
  const { config } = device
  const { t, lang } = useTranslation()
  return (
    <div>
      <SectionTitle>{t('drawer.identity.section.identification')}</SectionTitle>
      <KV label={t('drawer.identity.id')} value={device.deviceId} mono />
      <KV label={t('drawer.identity.type')} value={device.type} mono />
      <KV label={t('drawer.identity.manufacturer')} value={config.manufacturer ?? '—'} />
      <KV label={t('drawer.identity.model')} value={config.model ?? '—'} />
      <KV label={t('drawer.identity.driver')} value={config.driverId ?? '—'} mono />

      <div style={{ height: 16 }} />
      <SectionTitle>{t('drawer.identity.section.network')}</SectionTitle>
      <KV label={t('drawer.identity.ip')} value={config.ipAddress ?? '—'} mono />
      <KV label={t('drawer.identity.port')} value={config.httpPort ?? '—'} mono />
      <KV label={t('drawer.identity.mac')} value={shortMac(config.mac)} mono />

      <div style={{ height: 16 }} />
      <SectionTitle>{t('drawer.identity.section.status')}</SectionTitle>
      <KV label={t('drawer.identity.liveStatus')} value={status?.online ? t('common.online') : t('common.offline')} />
      <KV label={t('drawer.identity.lastPing')} value={status?.checkedAt ? formatEdgeTime(status.checkedAt, lang) : '—'} mono />
      <KV label={t('drawer.identity.enabled')} value={device.enabled ? t('common.yes') : t('common.no')} />
    </div>
  )
}

function RelaysTab({
  deviceId, config, onChange,
}: {
  deviceId: string
  config: Record<string, any>
  onChange: (cfg: Record<string, any>) => void
}) {
  const relays: { index: number; name: string }[] = config.relays ?? []
  const [busyIdx, setBusyIdx] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  const updateRelay = (idx: number, key: 'index' | 'name', value: any) => {
    const next = relays.map((r, i) => i === idx ? { ...r, [key]: value } : r)
    onChange({ ...config, relays: next })
  }

  const addRelay = () => {
    const nextIdx = relays.length > 0 ? Math.max(...relays.map((r) => r.index)) + 1 : 1
    onChange({ ...config, relays: [...relays, { index: nextIdx, name: `Przekaźnik ${nextIdx}` }] })
  }

  const removeRelay = (idx: number) => {
    onChange({ ...config, relays: relays.filter((_, i) => i !== idx) })
  }

  const trigger = async (idx: number, name: string) => {
    setBusyIdx(idx)
    try {
      await api.triggerRelay(deviceId, idx)
      showToast(`✓ ${name}`)
    } catch (err: any) {
      showToast(`✗ ${err.message}`)
    } finally {
      setBusyIdx(null)
    }
  }

  return (
    <div>
      <SectionTitle>Przekaźniki / wyjścia</SectionTitle>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0, marginBottom: 16 }}>
        Każdy przekaźnik = jedne drzwi/brama. Numer = port w urządzeniu (zwykle 1, 2, 3).
        „Wyzwól" wysyła impuls — sprawdź czy fizycznie się otwiera.
      </p>

      {relays.length === 0 ? (
        <div style={{
          padding: 24,
          textAlign: 'center',
          color: 'var(--muted)',
          background: 'var(--surface-2)',
          borderRadius: 'var(--r-2)',
          border: '1px dashed var(--border-strong)',
          fontSize: 12,
        }}>
          Brak skonfigurowanych przekaźników
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {relays.map((relay, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '60px 1fr auto auto',
                gap: 8,
                alignItems: 'center',
                padding: 8,
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-2)',
              }}
            >
              <input
                type="number"
                min={1} max={16}
                value={relay.index}
                onChange={(e) => updateRelay(i, 'index', Number(e.target.value))}
                style={{
                  padding: '6px 8px', fontSize: 12,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                  borderRadius: 'var(--r-1)',
                  fontFamily: '"IBM Plex Mono", monospace',
                  width: '100%',
                }}
              />
              <input
                type="text"
                value={relay.name}
                onChange={(e) => updateRelay(i, 'name', e.target.value)}
                placeholder="np. Brama wjazdowa"
                style={{
                  padding: '6px 8px', fontSize: 13,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                  borderRadius: 'var(--r-1)',
                  width: '100%',
                }}
              />
              <button
                onClick={() => trigger(relay.index, relay.name || `Relay ${relay.index}`)}
                disabled={busyIdx === relay.index}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '6px 10px',
                  background: 'var(--green)',
                  color: 'white',
                  border: 'none',
                  borderRadius: 'var(--r-1)',
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: 'pointer',
                  opacity: busyIdx === relay.index ? 0.5 : 1,
                }}
                title="Wyzwól impuls (NIE zapisuje configu, tylko test)"
              >
                <DoorOpen size={12} />
                Wyzwól
              </button>
              <button
                className="btn-icon"
                onClick={() => removeRelay(i)}
                title="Usuń"
                style={{ color: 'var(--red)' }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button className="btn" onClick={addRelay} style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}>
        <Plus size={14} />
        Dodaj przekaźnik
      </button>

      {toast && (
        <div style={{
          marginTop: 12,
          padding: 8,
          background: toast.startsWith('✓') ? 'var(--green-50)' : 'var(--red-50)',
          color: toast.startsWith('✓') ? 'var(--green)' : 'var(--red)',
          border: `1px solid ${toast.startsWith('✓') ? 'var(--green)' : 'var(--red)'}`,
          borderRadius: 'var(--r-2)',
          fontSize: 12,
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

function DiagnosticsTab({ deviceId }: { deviceId: string }) {
  const [result, setResult] = useState<TestMatrix | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runTest = async () => {
    setRunning(true)
    setError(null)
    try {
      const matrix = await api.testMatrix(deviceId)
      setResult(matrix)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <SectionTitle>Diagnostyka per capability</SectionTitle>
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 0, marginBottom: 16 }}>
        Test-matrix: sprawdza network/auth/snapshot/RTSP osobno. Akcje destrukcyjne
        (restart, openDoor) są oznaczone jako 🟡 (wymagają ręcznego testu w zakładce „Przekaźniki").
      </p>

      <button
        className="btn btn-primary"
        onClick={runTest}
        disabled={running}
        style={{ width: '100%', justifyContent: 'center' }}
      >
        {running ? <RotateCw size={14} className="spin" /> : <Stethoscope size={14} />}
        {running ? 'Testuję…' : 'Uruchom diagnostykę'}
      </button>

      {error && (
        <div style={{
          marginTop: 12, padding: 10,
          background: 'var(--red-50)',
          border: '1px solid var(--red)',
          color: 'var(--red)',
          borderRadius: 'var(--r-2)',
          fontSize: 12,
        }}>
          ✗ {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 16 }}>
          <div style={{
            padding: 10,
            marginBottom: 12,
            background: result.online ? 'var(--green-50)' : 'var(--amber-50)',
            border: `1px solid ${result.online ? 'var(--green)' : 'var(--amber)'}`,
            color: result.online ? 'var(--green)' : 'var(--amber)',
            borderRadius: 'var(--r-2)',
            fontSize: 12,
            fontWeight: 500,
          }}>
            {result.online
              ? `✓ Urządzenie online (${result.finishedAt - result.startedAt} ms test)`
              : `⚠ Niepełna diagnostyka — patrz szczegóły poniżej`}
          </div>

          <div style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-2)',
            padding: 10,
            fontFamily: '"IBM Plex Mono", monospace',
            fontSize: 11,
          }}>
            {Object.entries(result.capabilities).map(([key, entry]) => {
              if (!entry) return null
              return <CapabilityRow key={key} name={key} entry={entry} />
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function CapabilityRow({ name, entry }: { name: string; entry: any }) {
  const labels: Record<string, string> = {
    network: 'Sieć (TCP)',
    auth: 'Uwierzytelnienie',
    ping: 'HTTP ping',
    snapshot: 'Snapshot',
    restart: 'Restart',
    openDoor: 'Otwórz drzwi',
    toggle: 'Przełącz',
    lock: 'Zamknij',
    unlock: 'Otwórz',
    rtsp: 'RTSP',
    mjpeg: 'MJPEG',
    lprPushList: 'LPR — sync list',
    lprEvents: 'LPR — eventy',
  }
  const label = labels[name] ?? name

  let Icon, color, status
  if (entry.tested && entry.ok) {
    Icon = CheckCircle2; color = 'var(--green)'; status = 'OK'
  } else if (entry.tested && entry.ok === false) {
    Icon = AlertCircle; color = 'var(--red)'; status = 'FAIL'
  } else if (entry.supported) {
    Icon = Circle; color = 'var(--amber)'; status = 'PEND'
  } else {
    Icon = MinusCircle; color = 'var(--muted-2)'; status = 'n/a'
  }

  const detail = entry.detail ?? entry.error ?? entry.hint ?? ''

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '20px 130px 50px 1fr',
      gap: 8,
      padding: '6px 0',
      alignItems: 'center',
      borderBottom: '1px solid var(--border)',
    }}>
      <Icon size={14} strokeWidth={2} style={{ color }} />
      <span style={{ color: 'var(--ink-2)' }}>{label}</span>
      <span style={{ color, fontWeight: 600, fontSize: 10 }}>{status}</span>
      <span style={{ color: 'var(--muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {detail}
        {entry.latencyMs != null && ` · ${entry.latencyMs}ms`}
      </span>
    </div>
  )
}

// ── Shared ─────────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      fontSize: 11,
      fontWeight: 600,
      color: 'var(--muted)',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      margin: '0 0 10px 0',
    }}>
      {children}
    </h3>
  )
}

function KV({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '150px 1fr',
      gap: 12,
      padding: '6px 0',
      fontSize: 12,
      alignItems: 'baseline',
    }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span
        className={mono ? 'mono' : undefined}
        style={{
          color: 'var(--ink)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: mono ? 11 : 12,
        }}
      >
        {value ?? '—'}
      </span>
    </div>
  )
}

