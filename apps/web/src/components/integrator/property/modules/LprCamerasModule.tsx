'use client'
/**
 * LprCamerasModule — Konfiguracja kamer LPR (tryb zaawansowany: IP+login+
 * hasło + link do domofonu/przekaźnika) + Sterowanie (snapshot/live per kamera).
 *
 * Refactor monolitu (linie 510-728).
 */
import { useCallback, useEffect, useState } from 'react'
import { Camera, Link2, AlertTriangle, AlertCircle, Settings as Cog, Save, Car } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { ModuleCard, type ModuleStatus } from '../ModuleCard'
import { Spinner } from '../shared/Spinner'
import { RestartButton } from '../shared/RestartButton'
import { SnapshotViewer } from '../shared/SnapshotViewer'
import type { LprCamera, EdgeDevice } from '../types'

const INPUT_CLS = 'w-full border border-border rounded-r2 px-3 py-1.5 text-[13px] bg-surface text-ink focus:outline-none focus:border-brand placeholder:text-muted-2'
const BTN_PRIMARY = 'inline-flex items-center gap-1.5 bg-brand text-white text-[13px] py-2 px-4 rounded-r2 hover:bg-brand-600 disabled:opacity-50 transition-colors font-medium'
const BTN_SECONDARY = 'inline-flex items-center gap-1.5 border border-border text-muted text-[13px] py-2 px-4 rounded-r2 hover:bg-surface-2 transition-colors font-medium'

interface Props {
  buildingId: string
  cameras: LprCamera[]
  onUpdated: () => void
}

export function LprCamerasModule({ buildingId, cameras, onUpdated }: Props) {
  const [tab, setTab] = useState<'Konfiguracja' | 'Sterowanie'>('Konfiguracja')
  const [edgeDevices, setEdgeDevices] = useState<EdgeDevice[]>([])
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [edgeError, setEdgeError] = useState<string | null>(null)

  const loadEdgeDevices = useCallback(async () => {
    setLoadingDevices(true)
    setEdgeError(null)
    try {
      const r = await integratorApi.get(`/integrator/buildings/${buildingId}/edge/devices`)
      setEdgeDevices((r.data as EdgeDevice[]).filter((d) => d.type === 'LPR_CAMERA' || d.type === 'CAMERA'))
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Nie można pobrać urządzeń z Edge'
      setEdgeError(msg)
    } finally {
      setLoadingDevices(false)
    }
  }, [buildingId])

  useEffect(() => { loadEdgeDevices() }, [loadEdgeDevices])

  const allConfigured = cameras.length > 0 && cameras.every((c) => c.edgeDeviceId || c.ipAddress)
  const status: ModuleStatus = allConfigured ? 'configured' : 'needs'

  return (
    <ModuleCard
      icon={Camera}
      title="Kamery LPR"
      status={status}
      stat={`${cameras.length} ${cameras.length === 1 ? 'kamera' : 'kamer'}`}
      activeTab={tab}
      onTabChange={setTab}
    >
      {tab === 'Konfiguracja' && (
        <LprConfigList
          buildingId={buildingId}
          cameras={cameras}
          edgeDevices={edgeDevices}
          onUpdated={onUpdated}
        />
      )}
      {tab === 'Sterowanie' && (
        <LprControl
          buildingId={buildingId}
          loading={loadingDevices}
          error={edgeError}
          devices={edgeDevices}
        />
      )}
    </ModuleCard>
  )
}

function LprConfigList({ buildingId, cameras, edgeDevices, onUpdated }: {
  buildingId: string; cameras: LprCamera[]; edgeDevices: EdgeDevice[]; onUpdated: () => void
}) {
  const [editId, setEditId] = useState<number | null>(null)
  const [editIp, setEditIp] = useState('')
  const [editLogin, setEditLogin] = useState('')
  const [editPassword, setEditPassword] = useState('')
  const [editLinkedIntercomEdgeId, setEditLinkedIntercomEdgeId] = useState('')
  const [editLinkedRelayIndex, setEditLinkedRelayIndex] = useState('')
  const [saving, setSaving] = useState(false)

  const findEdgeDevice = (edgeDeviceId: string | null | undefined) =>
    edgeDeviceId ? edgeDevices.find((d) => d.deviceId === edgeDeviceId) : null

  const openEdit = (cam: LprCamera) => {
    setEditId(cam.id)
    setEditIp(cam.ipAddress ?? '')
    setEditLogin(cam.login ?? '')
    setEditPassword(cam.password ?? '')
    setEditLinkedIntercomEdgeId(cam.linkedIntercomEdgeId ?? '')
    setEditLinkedRelayIndex(cam.linkedRelayIndex != null ? String(cam.linkedRelayIndex) : '')
  }
  const cancelEdit = () => setEditId(null)

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true)
    try {
      await integratorApi.patch(`/integrator/buildings/${buildingId}/lpr-cameras/${editId}`, {
        edgeDeviceId: null,
        ipAddress: editIp || null,
        login: editLogin || null,
        password: editPassword || null,
        linkedIntercomEdgeId: editLinkedIntercomEdgeId || null,
        linkedRelayIndex: editLinkedRelayIndex ? parseInt(editLinkedRelayIndex, 10) : null,
      })
      cancelEdit()
      onUpdated()
    } finally { setSaving(false) }
  }

  const unlinkFromEdge = async (cam: LprCamera) => {
    if (!confirm(`Odpiąć „${cam.name}" od urządzenia Edge? Rekord pozostanie pusty.`)) return
    await integratorApi.patch(`/integrator/buildings/${buildingId}/lpr-cameras/${cam.id}`, {
      edgeDeviceId: null,
    })
    onUpdated()
  }

  return (
    <div className="space-y-3">
      {cameras.map((cam) => {
        const linked = findEdgeDevice(cam.edgeDeviceId)
        return (
          <div key={cam.id} className="border border-border rounded-r2 p-4">
            {editId === cam.id ? (
              <form onSubmit={handleSave} className="space-y-3">
                <p className="text-[13px] font-medium text-ink">
                  {cam.name} — {cam.manufacturer}{cam.model ? ` ${cam.model}` : ''}
                </p>
                <p className="text-[11px] text-muted">Tryb zaawansowany — wpisz dane ręcznie.</p>

                <div className="grid grid-cols-2 gap-2 bg-surface-2 rounded-r2 p-3 border border-border">
                  <div className="col-span-2">
                    <label className="block text-[11px] text-muted mb-1">Adres IP</label>
                    <input value={editIp} onChange={(e) => setEditIp(e.target.value)} placeholder="192.168.1.x" className={INPUT_CLS} />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted mb-1">Login</label>
                    <input value={editLogin} onChange={(e) => setEditLogin(e.target.value)} className={INPUT_CLS} autoComplete="off" />
                  </div>
                  <div>
                    <label className="block text-[11px] text-muted mb-1">Hasło</label>
                    <input value={editPassword} onChange={(e) => setEditPassword(e.target.value)} className={INPUT_CLS} autoComplete="off" type="password" />
                  </div>
                </div>

                <div className="bg-brand-50 rounded-r2 p-3 border border-brand/20 space-y-3">
                  <p className="text-[11px] text-muted">
                    Edge przechowuje białą listę tablic i po dopasowaniu wyzwala przekaźnik wskazanego domofonu.
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className="block text-[11px] text-muted mb-1">Domofon (Edge UUID)</label>
                      <input
                        value={editLinkedIntercomEdgeId}
                        onChange={(e) => setEditLinkedIntercomEdgeId(e.target.value)}
                        placeholder="UUID z Edge · pusty = pierwszy domofon"
                        className={INPUT_CLS}
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-muted mb-1">Przekaźnik</label>
                      <input
                        type="number"
                        min={1}
                        value={editLinkedRelayIndex}
                        onChange={(e) => setEditLinkedRelayIndex(e.target.value)}
                        placeholder="1"
                        className={INPUT_CLS}
                      />
                    </div>
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
                  <p className="text-[13px] font-medium text-ink">{cam.name}</p>
                  <p className="text-[11px] text-muted">
                    {cam.manufacturer}{cam.model ? ` · ${cam.model}` : ''}
                  </p>
                  {linked ? (
                    <p className="text-[11px] text-success mt-0.5 flex items-center gap-1">
                      <Link2 size={10} strokeWidth={2} />
                      Edge: {linked.config?.manufacturer ?? ''} {linked.config?.model ?? ''}
                      {linked.config?.ipAddress ? ` · ${linked.config.ipAddress}` : ''}
                      <span className={linked.status === 'online' ? 'text-success' : 'text-muted'}>
                        {linked.status === 'online' ? ' · online' : ' · offline'}
                      </span>
                    </p>
                  ) : cam.edgeDeviceId ? (
                    <p className="text-[11px] text-warn mt-0.5 flex items-center gap-1">
                      <Link2 size={10} strokeWidth={2} />
                      Przypisano do {cam.edgeDeviceId} (nieznalezione w Edge)
                    </p>
                  ) : cam.ipAddress ? (
                    <p className="text-[11px] text-brand mt-0.5 flex items-center gap-1">
                      <Cog size={10} strokeWidth={2} />
                      Zaawansowane: {cam.ipAddress}
                    </p>
                  ) : (
                    <p className="text-[11px] text-warn mt-0.5 flex items-center gap-1">
                      <AlertTriangle size={10} strokeWidth={2} />
                      Brak konfiguracji — użyj drzewa urządzeń lub trybu zaawansowanego
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {cam.edgeDeviceId && (
                    <button
                      onClick={() => unlinkFromEdge(cam)}
                      className="text-[11px] text-warn hover:text-warn border border-warn/40 px-2 py-1 rounded-r1 hover:bg-warn-50 transition-colors"
                    >
                      Odepnij
                    </button>
                  )}
                  {!cam.edgeDeviceId && (
                    <button
                      onClick={() => openEdit(cam)}
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

function LprControl({ buildingId, loading, error, devices }: {
  buildingId: string; loading: boolean; error: string | null; devices: EdgeDevice[]
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted text-[13px]">
        <Spinner size={14} /> Pobieranie kamer z Edge…
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-danger-50 border border-danger/30 rounded-r2 px-4 py-3 text-[13px] text-danger flex items-center gap-2">
        <AlertCircle size={14} />
        {error}
      </div>
    )
  }
  if (devices.length === 0) {
    return (
      <div className="text-center py-8 text-muted">
        <Camera size={32} strokeWidth={1.5} className="mx-auto mb-3 text-muted-2" />
        <p className="text-[13px] font-medium">Brak kamer skonfigurowanych w Edge</p>
        <p className="text-[11px] text-muted-2 mt-1">Dodaj kamerę w panelu GateLynk Edge UI</p>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-4">
      {devices.map((d) => {
        const cfg = d.config ?? {}
        const isLpr = d.type === 'LPR_CAMERA'
        return (
          <div key={d.deviceId}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] text-muted font-medium flex items-center gap-1.5">
                {isLpr ? <Car size={12} /> : <Camera size={12} />}
                <span className="font-[var(--font-plex-mono)]">
                  {cfg.manufacturer ?? d.type} · {cfg.ipAddress ?? ''}
                </span>
                · {isLpr ? 'LPR' : 'Kamera'}
              </p>
              <RestartButton buildingId={buildingId} deviceId={d.deviceId} size="sm" />
            </div>
            <SnapshotViewer
              buildingId={buildingId}
              deviceId={d.deviceId}
              label={`${cfg.manufacturer ?? ''} ${cfg.model ?? ''} · ${cfg.ipAddress ?? ''}`}
            />
          </div>
        )
      })}
    </div>
  )
}
