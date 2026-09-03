'use client'
/**
 * IntercomsModule — Konfiguracja domofonów (tryb zaawansowany: edycja IP +
 * login + hasło) + Sterowanie (relay panel + snapshot/live z każdej linked
 * kamery domofonu).
 *
 * Refactor monolitu (linie 285-506). Logika niezmieniona, tylko style + Lucide.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, Link2, AlertTriangle, AlertCircle, Settings as Cog, Save, PhoneCall, Pencil } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { ModuleCard, type ModuleStatus } from '../ModuleCard'
import { Spinner } from '../shared/Spinner'
import { RestartButton } from '../shared/RestartButton'
import { RelayPanel } from '../shared/RelayPanel'
import { SnapshotViewer } from '../shared/SnapshotViewer'
import type { Intercom, EdgeDevice } from '../types'

const INPUT_CLS = 'w-full border border-border rounded-r2 px-3 py-1.5 text-[13px] bg-surface text-ink focus:outline-none focus:border-brand placeholder:text-muted-2'
const BTN_PRIMARY = 'inline-flex items-center gap-1.5 bg-brand text-white text-[13px] py-2 px-4 rounded-r2 hover:bg-brand-600 disabled:opacity-50 transition-colors font-medium'
const BTN_SECONDARY = 'inline-flex items-center gap-1.5 border border-border text-muted text-[13px] py-2 px-4 rounded-r2 hover:bg-surface-2 transition-colors font-medium'

interface Props {
  buildingId: string
  intercoms: Intercom[]
  onUpdated: () => void
}

export function IntercomsModule({ buildingId, intercoms, onUpdated }: Props) {
  const [tab, setTab] = useState<'Konfiguracja' | 'Sterowanie'>('Konfiguracja')
  const [edgeDevices, setEdgeDevices] = useState<EdgeDevice[]>([])
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [edgeError, setEdgeError] = useState<string | null>(null)
  const loadedRef = useRef(false)

  const loadEdgeDevices = useCallback(async () => {
    setLoadingDevices(true)
    setEdgeError(null)
    try {
      const r = await integratorApi.get(`/integrator/buildings/${buildingId}/edge/devices`)
      setEdgeDevices((r.data as EdgeDevice[]).filter((d) => d.type === 'INTERCOM'))
      loadedRef.current = true
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Nie można pobrać urządzeń z Edge'
      setEdgeError(msg)
    } finally {
      setLoadingDevices(false)
    }
  }, [buildingId])

  useEffect(() => { loadEdgeDevices() }, [loadEdgeDevices])

  const allConfigured = intercoms.length > 0 && intercoms.every((ic) => ic.edgeDeviceId || ic.ipAddress)
  const status: ModuleStatus = allConfigured ? 'configured' : 'needs'

  return (
    <ModuleCard
      icon={Bell}
      title="Domofon"
      status={status}
      stat={`${intercoms.length} ${intercoms.length === 1 ? 'urządzenie' : 'urządzeń'}`}
      activeTab={tab}
      onTabChange={setTab}
    >
      {tab === 'Konfiguracja' && (
        <IntercomsConfigList
          buildingId={buildingId}
          intercoms={intercoms}
          edgeDevices={edgeDevices}
          onUpdated={onUpdated}
        />
      )}
      {tab === 'Sterowanie' && (
        <IntercomsControl
          buildingId={buildingId}
          loading={loadingDevices}
          error={edgeError}
          devices={edgeDevices}
          onRetry={() => { loadedRef.current = false; loadEdgeDevices() }}
        />
      )}
    </ModuleCard>
  )
}

// ── Konfiguracja list ───────────────────────────────────────────────────────

function IntercomsConfigList({ buildingId, intercoms, edgeDevices, onUpdated }: {
  buildingId: string; intercoms: Intercom[]; edgeDevices: EdgeDevice[]; onUpdated: () => void
}) {
  const [editId, setEditId] = useState<number | null>(null)
  const [editIp, setEditIp] = useState('')
  const [editLogin, setEditLogin] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [saving, setSaving] = useState(false)
  // Multi-station (2026-07-05): zmiana nazwy stacji inline (nazwa jest tym, co
  // mieszkaniec widzi na ekranie połączenia — „Wejście główne", „Brama wschodnia").
  const [renameId, setRenameId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [bridgeBusyId, setBridgeBusyId] = useState<number | null>(null)

  const findEdgeDevice = (edgeDeviceId: string | null | undefined) =>
    edgeDeviceId ? edgeDevices.find((d) => d.deviceId === edgeDeviceId) : null

  const openEdit = (ic: Intercom) => {
    setEditId(ic.id)
    setEditIp(ic.ipAddress ?? '')
    setEditLogin(ic.sipAccount ?? '')
    setEditPassword(ic.sipPassword ?? '')
  }
  const cancelEdit = () => setEditId(null)

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await integratorApi.patch(`/integrator/buildings/${buildingId}/intercoms/${editId}`, {
        edgeDeviceId: null,
        ipAddress: editIp || null,
        login: editLogin || null,
        password: editPassword || null,
      })
      cancelEdit()
      onUpdated()
    } finally { setSaving(false) }
  }

  const unlinkFromEdge = async (ic: Intercom) => {
    if (!confirm(`Odpiąć „${ic.name}" od urządzenia Edge? Rekord pozostanie pusty.`)) return
    await integratorApi.patch(`/integrator/buildings/${buildingId}/intercoms/${ic.id}`, {
      edgeDeviceId: null,
    })
    onUpdated()
  }

  /** Multi-station: włącz/wyłącz most rozmów (bridgeEnabled) per stacja. */
  const toggleBridge = async (ic: Intercom) => {
    setBridgeBusyId(ic.id)
    try {
      await integratorApi.patch(`/integrator/buildings/${buildingId}/intercoms/${ic.id}`, {
        bridgeEnabled: !ic.bridgeEnabled,
      })
      onUpdated()
    } finally { setBridgeBusyId(null) }
  }

  const startRename = (ic: Intercom) => {
    setRenameId(ic.id)
    setRenameValue(ic.name)
  }

  const saveRename = async (ic: Intercom) => {
    const name = renameValue.trim()
    if (!name || name === ic.name) { setRenameId(null); return }
    await integratorApi.patch(`/integrator/buildings/${buildingId}/intercoms/${ic.id}`, { name })
    setRenameId(null)
    onUpdated()
  }

  return (
    <div className="space-y-3">
      {intercoms.map((ic) => {
        const linked = findEdgeDevice(ic.edgeDeviceId)
        return (
          <div key={ic.id} className="border border-border rounded-r2 p-4">
            {editId === ic.id ? (
              <form onSubmit={handleSave} className="space-y-3">
                <p className="text-[13px] font-medium text-ink">
                  {ic.name}{ic.model ? ` — ${ic.model}` : ''}
                </p>
                <p className="text-[11px] text-muted">
                  Tryb zaawansowany — wpisz dane ręcznie (gdy urządzenie nie jest rejestrowane przez Edge).
                </p>
                <div className="grid grid-cols-2 gap-2 bg-surface-2 rounded-r2 p-3 border border-border">
                  <div className="col-span-2">
                    <label className="block text-[11px] text-muted mb-1">Adres IP</label>
                    <input value={editIp} onChange={(e) => setEditIp(e.target.value)} placeholder="192.168.1.x" className={INPUT_CLS} />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted mb-1">Login (SIP)</label>
                    <input value={editLogin} onChange={(e) => setEditLogin(e.target.value)} className={INPUT_CLS} autoComplete="off" />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted mb-1">Hasło (SIP)</label>
                    <input value={editPassword} onChange={(e) => setEditPassword(e.target.value)} className={INPUT_CLS} autoComplete="off" type="password" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="submit" disabled={saving} className={BTN_PRIMARY}>
                    <Save size={13} />
                    {saving ? 'Zapisywanie…' : 'Zapisz'}
                  </button>
                  <button type="button" onClick={cancelEdit} className={BTN_SECONDARY}>Anuluj</button>
                </div>
              </form>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  {renameId === ic.id ? (
                    <form
                      onSubmit={(e) => { e.preventDefault(); saveRename(ic) }}
                      className="flex items-center gap-2 mb-1"
                    >
                      <input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        className={INPUT_CLS}
                        autoFocus
                        placeholder="np. Wejście główne"
                      />
                      <button type="submit" className="text-[12px] text-brand font-medium">Zapisz</button>
                      <button type="button" onClick={() => setRenameId(null)} className="text-[12px] text-muted">Anuluj</button>
                    </form>
                  ) : (
                    <p className="text-[13px] font-medium text-ink flex items-center gap-1.5">
                      {ic.name}
                      <button
                        onClick={() => startRename(ic)}
                        title="Zmień nazwę stacji (widoczna w apce mieszkańca na ekranie połączenia)"
                        className="text-muted-2 hover:text-brand transition-colors"
                      >
                        <Pencil size={11} />
                      </button>
                      {ic.bridgeEnabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-r1 bg-success-50 text-success font-medium inline-flex items-center gap-1">
                          <PhoneCall size={9} /> rozmowy
                        </span>
                      )}
                    </p>
                  )}
                  {ic.model && <p className="text-[11px] text-muted">{ic.model}</p>}
                  {linked ? (
                    <p className="text-[11px] text-success mt-0.5 flex items-center gap-1">
                      <Link2 size={10} strokeWidth={2} />
                      Edge: {linked.config?.manufacturer ?? ''} {linked.config?.model ?? ''}
                      {linked.config?.ipAddress ? ` · ${linked.config.ipAddress}` : ''}
                      <span className={linked.status === 'online' ? 'text-success' : 'text-muted'}>
                        {linked.status === 'online' ? ' · online' : ' · offline'}
                      </span>
                    </p>
                  ) : ic.edgeDeviceId ? (
                    <p className="text-[11px] text-warn mt-0.5 flex items-center gap-1">
                      <Link2 size={10} strokeWidth={2} />
                      Przypisano do {ic.edgeDeviceId} (nieznalezione w Edge)
                    </p>
                  ) : ic.ipAddress ? (
                    <p className="text-[11px] text-brand mt-0.5 flex items-center gap-1">
                      <Cog size={10} strokeWidth={2} />
                      Zaawansowane: {ic.ipAddress}{ic.sipAccount ? ` · ${ic.sipAccount}` : ''}
                    </p>
                  ) : (
                    <p className="text-[11px] text-warn mt-0.5 flex items-center gap-1">
                      <AlertTriangle size={10} strokeWidth={2} />
                      Brak konfiguracji — użyj drzewa urządzeń lub trybu zaawansowanego
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Multi-station: most rozmów per stacja. Wymaga przypięcia do
                      urządzenia Edge (edgeDeviceId) — bez tego Cloud nie umie
                      wskazać stacji Janusowi. */}
                  <button
                    onClick={() => toggleBridge(ic)}
                    disabled={bridgeBusyId === ic.id || !ic.edgeDeviceId}
                    title={!ic.edgeDeviceId
                      ? 'Najpierw przypisz stację do urządzenia Edge (drzewo urządzeń)'
                      : ic.bridgeEnabled
                        ? 'Wyłącz rozmowy domofon↔apka dla tej stacji'
                        : 'Włącz rozmowy domofon↔apka dla tej stacji'}
                    className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-r1 border transition-colors disabled:opacity-40 ${
                      ic.bridgeEnabled
                        ? 'text-success border-success/40 bg-success-50 hover:bg-success-50/60'
                        : 'text-muted border-border hover:bg-surface-2'
                    }`}
                  >
                    <PhoneCall size={11} />
                    {bridgeBusyId === ic.id ? '…' : ic.bridgeEnabled ? 'Rozmowy: ON' : 'Rozmowy: OFF'}
                  </button>
                  {ic.edgeDeviceId && (
                    <button
                      onClick={() => unlinkFromEdge(ic)}
                      className="text-[11px] text-warn hover:text-warn border border-warn/40 px-2 py-1 rounded-r1 hover:bg-warn-50 transition-colors"
                    >
                      Odepnij
                    </button>
                  )}
                  {!ic.edgeDeviceId && (
                    <button
                      onClick={() => openEdit(ic)}
                      className="inline-flex items-center gap-1 text-[12px] text-brand hover:text-brand-600 font-medium"
                    >
                      <Cog size={12} />
                      Zaawansowane
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Sterowanie ──────────────────────────────────────────────────────────────

function IntercomsControl({ buildingId, loading, error, devices, onRetry }: {
  buildingId: string; loading: boolean; error: string | null; devices: EdgeDevice[]; onRetry: () => void
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted text-[13px]">
        <Spinner size={14} /> Pobieranie urządzeń z Edge…
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-danger-50 border border-danger/30 rounded-r2 px-4 py-3 text-[13px] text-danger flex items-center gap-2">
        <AlertCircle size={14} />
        {error}
        <button onClick={onRetry} className="ml-auto underline hover:opacity-80">Spróbuj ponownie</button>
      </div>
    )
  }
  if (devices.length === 0) {
    return (
      <div className="text-center py-8 text-muted">
        <Bell size={32} strokeWidth={1.5} className="mx-auto mb-3 text-muted-2" />
        <p className="text-[13px] font-medium">Brak domofonów skonfigurowanych w Edge</p>
        <p className="text-[11px] text-muted-2 mt-1">Dodaj domofon w panelu GateLynk Edge UI</p>
      </div>
    )
  }
  return (
    <div className="space-y-5">
      {devices.map((d, i) => {
        const cfg = d.config ?? {}
        const relays: { index: number; name: string }[] = Array.isArray(cfg.relays)
          ? cfg.relays.map((r) => ({ index: r.index ?? 0, name: r.name ?? `Przekaźnik ${r.index ?? 0}` }))
          : cfg.doorRelayIndex != null ? [{ index: 0, name: 'Wejście główne' }] : []
        return (
          <div key={d.deviceId}>
            <div className="flex items-center justify-between mb-3">
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-ink truncate">
                  {cfg.manufacturer ?? ''} {cfg.model ?? ''} {cfg.name ? `— ${cfg.name}` : ''}
                </p>
                <p className="text-[11px] text-muted" style={{ fontFamily: 'var(--font-plex-mono, monospace)' }}>
                  {cfg.ipAddress ?? 'Brak IP'}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`text-[11px] px-2 py-0.5 rounded-r1 font-medium ${
                  d.status === 'online' ? 'bg-success-50 text-success' : 'bg-surface-2 text-muted'
                }`}>
                  {d.status === 'online' ? '● Online' : '○ Offline'}
                </span>
                <RestartButton buildingId={buildingId} deviceId={d.deviceId} size="sm" />
              </div>
            </div>

            <div className="mb-4">
              <p className="text-[10px] text-muted-2 font-semibold uppercase tracking-wider mb-2">
                Elektrozaczepy
              </p>
              <RelayPanel buildingId={buildingId} deviceId={d.deviceId} relays={relays} />
            </div>

            <div>
              <p className="text-[10px] text-muted-2 font-semibold uppercase tracking-wider mb-2">
                Podgląd video
              </p>
              <SnapshotViewer
                buildingId={buildingId}
                deviceId={d.deviceId}
                label={`${cfg.manufacturer ?? 'Domofon'} · ${cfg.ipAddress ?? ''}`}
              />
            </div>

            {i < devices.length - 1 && <div className="border-t border-border mt-5" />}
          </div>
        )
      })}
    </div>
  )
}
