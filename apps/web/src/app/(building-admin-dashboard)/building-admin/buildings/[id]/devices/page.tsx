'use client'
/**
 * Faza 5 — Urządzenia (BA).
 *
 * Lista wszystkich urządzeń w budynku: Edge Mac Mini-iaki, domofony Akuvox,
 * kamery LPR Hikvision. Status online/offline z `EdgeGateway.isOnline()`
 * (live WS connection map) — Edge online ⇒ jego intercom-y i kamery też
 * traktujemy jako reachable, bo do nich Cloud gada przez Edge w LAN.
 *
 * Akcje:
 *   • Ping — sprawdza live WS state (toast z lastSeenAt + IP)
 *   • Restart — wysyła CMD `RESTART` przez WS. Edge musi zaimplementować
 *     handler (TODO Fazy 5 w `apps/edge/src`); na cloud-side tylko fire-message.
 *
 * Polling co 15s żeby badge online/offline były świeże bez F5.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { buildingAdminApi } from '@/lib/building-admin-api'

interface EdgeDevice {
  id: string
  buildingId: number
  type: string
  name: string | null
  isActivated: boolean
  activatedAt: string | null
  lastSeenAt: string | null
  ipAddress: string | null
  version: string | null
  createdAt: string
  online: boolean
  // Faza 7.6 — count outbox-row pending (zaplanowane do wysłania ale Edge offline
  // / lost ACK) i failed (po 10 nieudanych próbach → deadletter, alert).
  outbox: { pending: number; failed: number }
}

interface IntercomDevice {
  id: number
  name: string
  model: string | null
  ipAddress: string | null
  edgeDeviceId: string | null
  online: boolean
}

interface CameraDevice {
  id: number
  name: string
  manufacturer: string
  model: string | null
  ipAddress: string | null
  edgeDeviceId: string | null
  whitelistMode: string
  online: boolean
}

/**
 * Faza B-3: pojedyncze urządzenie z mirror-a (Edge sqlite → Cloud Postgres).
 * Zawiera wszystkie typy (intercom + camera + lpr + switch + knx + ...) bez
 * podziału na osobne tabele jak legacy `intercoms`/`cameras`.
 *
 * Driver-info i certification są wzbogacane w BA service przez lookup w
 * `@gatelynk/device-drivers`, więc UI nie fetchuje katalogu osobno.
 */
interface MirrorDevice {
  id: number
  deviceUuid: string
  edgeDeviceId: string | null
  type: string
  driverId: string | null
  config: Record<string, any>
  /** Faza B-4: nazwa wyświetlana — edytowalna inline przez BA. Init z `config.name`. */
  displayLabel: string | null
  labelUpdatedBy: 'edge-init' | 'building-admin' | 'integrator' | null
  labelUpdatedAt: string | null
  lastSyncedAt: string
  createdAt: string
  online: boolean
  driver: {
    id: string
    label: string
    icon?: string
    manufacturer: string
    capabilities: string[]
  } | null
  certification: {
    status: 'certified' | 'beta' | 'untested' | 'community'
    model?: string
    firmwareVersions?: string[]
    testedFirmware?: string[]
    testedAt?: string
    testedBy?: string
    knownIssues?: string[]
    recommendedFor?: string
  }
}

interface DevicesResponse {
  edges: EdgeDevice[]
  intercoms: IntercomDevice[]
  cameras: CameraDevice[]
  mirrorDevices: MirrorDevice[]
}

export default function BaDevicesPage() {
  const params = useParams<{ id: string }>()
  const buildingId = Number(params.id)
  const [data, setData] = useState<DevicesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyEdgeId, setBusyEdgeId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Faza B-3: rozwijane wiersze mirror-a (pokazują pełen config JSON).
  const [expandedMirrorId, setExpandedMirrorId] = useState<number | null>(null)
  // Faza B-4: inline edit displayLabel. `editingId` = wiersz w trybie edycji,
  // `editingValue` = bieżący tekst inputa, `savingId` = blokada przy save.
  const [editingLabelId, setEditingLabelId] = useState<number | null>(null)
  const [editingLabelValue, setEditingLabelValue] = useState('')
  const [savingLabelId, setSavingLabelId] = useState<number | null>(null)

  const startLabelEdit = (m: MirrorDevice) => {
    setEditingLabelId(m.id)
    setEditingLabelValue(m.displayLabel ?? (m.config?.name as string) ?? '')
  }
  const cancelLabelEdit = () => {
    setEditingLabelId(null)
    setEditingLabelValue('')
  }
  const saveLabel = async (m: MirrorDevice) => {
    const trimmed = editingLabelValue.trim()
    if (!trimmed) return
    if (trimmed === (m.displayLabel ?? '')) { cancelLabelEdit(); return }
    setSavingLabelId(m.id)
    try {
      await buildingAdminApi.patch(
        `/building-admin/buildings/${buildingId}/devices/mirror/${m.id}/label`,
        { displayLabel: trimmed },
      )
      // Optymistycznie zaktualizuj lokalny stan, potem re-load żeby dostać
      // świeży `labelUpdatedAt`/`labelUpdatedBy`.
      setData((prev) => prev ? {
        ...prev,
        mirrorDevices: prev.mirrorDevices.map((x) =>
          x.id === m.id ? { ...x, displayLabel: trimmed, labelUpdatedBy: 'building-admin' as const } : x,
        ),
      } : prev)
      showToast(`✓ Nazwa zaktualizowana`)
      cancelLabelEdit()
    } catch (err: any) {
      showToast(`✗ ${err?.response?.data?.message ?? 'Błąd zapisu'}`)
    } finally {
      setSavingLabelId(null)
    }
  }

  const load = useCallback(() => {
    buildingAdminApi
      .get(`/building-admin/buildings/${buildingId}/devices`)
      .then((r) => setData(r.data as DevicesResponse))
      .catch((err) => setError(err?.response?.data?.message ?? 'Błąd ładowania'))
      .finally(() => setLoading(false))
  }, [buildingId])

  useEffect(() => { load() }, [load])

  // Live status — poll co 15s. EdgeGateway nie broadcastuje zmian (są tylko
  // w pamięci procesu API), więc jedyny sposób na świeży status to polling.
  // Patrz Faza 7.6 tech-debt — kolejka outbox + push event.
  useEffect(() => {
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

  const ping = async (edgeId: string) => {
    setBusyEdgeId(edgeId)
    try {
      const res = await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/devices/${edgeId}/ping`,
      )
      const { online, lastSeenAt, ipAddress } = res.data as {
        online: boolean; lastSeenAt: string | null; ipAddress: string | null
      }
      showToast(
        online
          ? `✓ Online${ipAddress ? ` · ${ipAddress}` : ''}`
          : `⚠️ Offline · ostatnio: ${lastSeenAt ? new Date(lastSeenAt).toLocaleString('pl-PL') : 'nigdy'}`,
      )
      load()
    } catch (err: any) {
      showToast(`✗ ${err?.response?.data?.message ?? 'Błąd ping'}`)
    } finally {
      setBusyEdgeId(null)
    }
  }

  const restart = async (edgeId: string) => {
    if (!confirm('Zrestartować Edge? Wszystkie aktywne sesje LPR zostaną przerwane na ~30s.')) return
    setBusyEdgeId(edgeId)
    try {
      await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/devices/${edgeId}/restart`,
      )
      showToast('✓ Polecenie restartu wysłane')
      load()
    } catch (err: any) {
      showToast(`✗ ${err?.response?.data?.message ?? 'Błąd restart'}`)
    } finally {
      setBusyEdgeId(null)
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="mb-4">
        <Link
          href={`/building-admin/buildings/${buildingId}`}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          ← Budynek
        </Link>
      </div>

      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">📡 Urządzenia</h1>
          <p className="text-sm text-gray-500 mt-1">
            Edge serwer + domofony + kamery. Status online/offline odświeża się
            co 15 s. „Edge online" oznacza że domofony i kamery w jego LAN są
            osiągalne dla Cloud (gada przez tunel WS).
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 shrink-0"
        >
          ↻ Odśwież
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">
          Ładowanie…
        </div>
      ) : data ? (
        <div className="space-y-6">
          {/* Edge devices */}
          <Section title="🖥 Edge serwery" count={data.edges.length}>
            {data.edges.length === 0 ? (
              <Empty>
                Brak skonfigurowanych Edge serwerów. Dodaj urządzenie z poziomu
                panelu integratora.
              </Empty>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-2">Nazwa</th>
                    <th className="px-4 py-2 w-32">Status</th>
                    <th className="px-4 py-2 w-44">Ostatnio widziany</th>
                    <th className="px-4 py-2">IP</th>
                    <th className="px-4 py-2">Wersja</th>
                    <th className="px-4 py-2 text-right w-48">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {data.edges.map((e) => (
                    <tr key={e.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">
                          {e.name ?? <span className="text-gray-400 italic">—</span>}
                        </div>
                        <div className="text-xs text-gray-400 font-mono">
                          {e.type} · {e.id.slice(0, 12)}…
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge online={e.online} activated={e.isActivated} />
                        {e.outbox.pending > 0 && (
                          <span
                            className="ml-1 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200"
                            title="Wiadomości w outbox-ie czekające na dostarczenie do Edge"
                          >
                            ⏳ {e.outbox.pending}
                          </span>
                        )}
                        {e.outbox.failed > 0 && (
                          <span
                            className="ml-1 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200"
                            title="Wiadomości po 10 nieudanych próbach (deadletter)"
                          >
                            ⚠ {e.outbox.failed}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                        {formatLastSeen(e.lastSeenAt)}
                      </td>
                      <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                        {e.ipAddress ?? <span className="text-gray-400 italic">—</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs">
                        {e.version ?? <span className="text-gray-400 italic">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button
                          onClick={() => ping(e.id)}
                          disabled={busyEdgeId === e.id}
                          className="text-xs px-2.5 py-1 rounded bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50 mr-1.5"
                        >
                          📡 Ping
                        </button>
                        <button
                          onClick={() => restart(e.id)}
                          disabled={busyEdgeId === e.id || !e.online}
                          className="text-xs px-2.5 py-1 rounded bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 disabled:opacity-40"
                          title={e.online ? 'Wysłać polecenie restartu' : 'Edge musi być online'}
                        >
                          ↻ Restart
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {/* Mirror devices (Faza B-3) — pełen widok z Edge sqlite */}
          <Section
            title="🪞 Wszystkie urządzenia (sync z Edge)"
            count={data.mirrorDevices.length}
          >
            {data.mirrorDevices.length === 0 ? (
              <Empty>
                Brak urządzeń w Edge sqlite. Dodaj przez wizard:
                <span className="ml-1 font-mono text-xs">http://&lt;edge-ip&gt;:4000/ui/wizard.html</span>
              </Empty>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-2">Nazwa</th>
                    <th className="px-4 py-2 w-32">Status</th>
                    <th className="px-4 py-2">Typ / Driver</th>
                    <th className="px-4 py-2">IP w LAN</th>
                    <th className="px-4 py-2">Certyfikacja</th>
                    <th className="px-4 py-2 w-32">Ostatni sync</th>
                  </tr>
                </thead>
                <tbody>
                  {data.mirrorDevices.map((m) => {
                    const isOpen = expandedMirrorId === m.id
                    const cfg = m.config ?? {}
                    const isEditing = editingLabelId === m.id
                    const isSaving = savingLabelId === m.id
                    return (
                      <>
                        <tr
                          key={m.id}
                          className="border-b border-gray-50 hover:bg-gray-50"
                        >
                          <td
                            className="px-4 py-3"
                            // Klik w cell rozwija/zwija — ale NIE gdy edytujemy label.
                            onClick={(e) => {
                              if (isEditing) return
                              const target = e.target as HTMLElement
                              if (target.closest('button[data-no-expand]')) return
                              setExpandedMirrorId(isOpen ? null : m.id)
                            }}
                            style={{ cursor: isEditing ? 'text' : 'pointer' }}
                          >
                            <div className="font-medium text-gray-900 flex items-center gap-2">
                              <span>{m.driver?.icon ?? typeIcon(m.type)}</span>
                              {isEditing ? (
                                <div className="flex items-center gap-1 flex-1" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="text"
                                    value={editingLabelValue}
                                    onChange={(e) => setEditingLabelValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') saveLabel(m)
                                      if (e.key === 'Escape') cancelLabelEdit()
                                    }}
                                    autoFocus
                                    disabled={isSaving}
                                    className="flex-1 text-sm px-2 py-1 border border-blue-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-200"
                                    placeholder="Nazwa wyświetlana"
                                  />
                                  <button
                                    data-no-expand
                                    onClick={(e) => { e.stopPropagation(); saveLabel(m) }}
                                    disabled={isSaving}
                                    className="text-xs px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 disabled:opacity-40"
                                    title="Zapisz (Enter)"
                                  >
                                    ✓
                                  </button>
                                  <button
                                    data-no-expand
                                    onClick={(e) => { e.stopPropagation(); cancelLabelEdit() }}
                                    disabled={isSaving}
                                    className="text-xs px-2 py-1 rounded bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                                    title="Anuluj (Esc)"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <span>{m.displayLabel ?? cfg.name ?? <span className="text-gray-400 italic">—</span>}</span>
                                  <button
                                    data-no-expand
                                    onClick={(e) => { e.stopPropagation(); startLabelEdit(m) }}
                                    className="text-xs px-1.5 py-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                                    title="Zmień nazwę wyświetlaną"
                                  >
                                    ✎
                                  </button>
                                  {m.labelUpdatedBy === 'building-admin' && (
                                    <span
                                      className="text-[10px] px-1 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200"
                                      title={`Zmienione przez admina budynku${m.labelUpdatedAt ? ` · ${new Date(m.labelUpdatedAt).toLocaleString('pl-PL')}` : ''}`}
                                    >
                                      BA
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                            <div className="text-xs text-gray-400 font-mono">
                              {m.deviceUuid.slice(0, 12)}…
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge online={m.online} />
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-xs text-gray-700">
                              <span className="inline-block px-1.5 py-0.5 bg-gray-100 rounded font-mono mr-1">
                                {m.type}
                              </span>
                              {m.driver?.label ?? (
                                <span className="text-gray-400 italic">
                                  driver „{m.driverId ?? 'nieznany'}"
                                </span>
                              )}
                            </div>
                            {cfg.model && (
                              <div className="text-xs text-gray-500 mt-0.5">
                                Model: <span className="font-mono">{cfg.model}</span>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                            {cfg.ipAddress ?? <span className="text-gray-400 italic">—</span>}
                          </td>
                          <td className="px-4 py-3">
                            <CertBadge cert={m.certification} />
                          </td>
                          <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">
                            {formatLastSeen(m.lastSyncedAt)}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-gray-50 bg-gray-50/50">
                            <td colSpan={6} className="px-4 py-3">
                              <MirrorExpanded device={m} />
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Section>

          {/* Intercoms */}
          <Section title="🔔 Domofony" count={data.intercoms.length}>
            {data.intercoms.length === 0 ? (
              <Empty>Brak domofonów w tym budynku.</Empty>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-2">Nazwa</th>
                    <th className="px-4 py-2 w-32">Status</th>
                    <th className="px-4 py-2">Model</th>
                    <th className="px-4 py-2">IP w LAN</th>
                    <th className="px-4 py-2">Edge</th>
                  </tr>
                </thead>
                <tbody>
                  {data.intercoms.map((i) => (
                    <tr key={i.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{i.name}</td>
                      <td className="px-4 py-3">
                        <StatusBadge online={i.online} />
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {i.model ?? <span className="text-gray-400 italic">—</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                        {i.ipAddress ?? <span className="text-gray-400 italic">—</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                        {i.edgeDeviceId
                          ? `${i.edgeDeviceId.slice(0, 12)}…`
                          : <span className="text-amber-600">Brak Edge</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {/* Cameras */}
          <Section title="📸 Kamery LPR" count={data.cameras.length}>
            {data.cameras.length === 0 ? (
              <Empty>Brak kamer LPR w tym budynku.</Empty>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-2">Nazwa</th>
                    <th className="px-4 py-2 w-32">Status</th>
                    <th className="px-4 py-2">Producent / Model</th>
                    <th className="px-4 py-2">IP w LAN</th>
                    <th className="px-4 py-2">Tryb whitelist</th>
                    <th className="px-4 py-2">Edge</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cameras.map((c) => (
                    <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{c.name}</td>
                      <td className="px-4 py-3">
                        <StatusBadge online={c.online} />
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {c.manufacturer}
                        {c.model ? ` · ${c.model}` : ''}
                      </td>
                      <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                        {c.ipAddress ?? <span className="text-gray-400 italic">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <span className="inline-block px-2 py-0.5 bg-gray-100 rounded text-gray-700">
                          {c.whitelistMode}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                        {c.edgeDeviceId
                          ? `${c.edgeDeviceId.slice(0, 12)}…`
                          : <span className="text-amber-600">Brak Edge</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>
      ) : null}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  )
}

function Section({
  title, count, children,
}: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="font-semibold text-gray-800">
          {title}
          <span className="ml-2 text-xs font-normal text-gray-400">({count})</span>
        </h2>
      </div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-8 text-center text-sm text-gray-400">
      {children}
    </div>
  )
}

function StatusBadge({ online, activated }: { online: boolean; activated?: boolean }) {
  if (activated === false) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
        Nieaktywowany
      </span>
    )
  }
  return online ? (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      Online
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
      <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
      Offline
    </span>
  )
}

function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) return '—'
  const d = new Date(lastSeenAt)
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diffSec < 60)    return 'przed chwilą'
  if (diffSec < 3600)  return `${Math.floor(diffSec / 60)} min temu`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} h temu`
  return d.toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ─── Faza B-3 helpers ───────────────────────────────────────────────────────

function typeIcon(type: string): string {
  const map: Record<string, string> = {
    INTERCOM:   '🔔',
    CAMERA:     '📷',
    LPR_CAMERA: '🚗',
    ELEVATOR:   '🛗',
    LIGHTING:   '💡',
    SWITCH:     '🔌',
    LOCK:       '🔐',
    KNX_BRIDGE: '🏗️',
    KNX_OBJECT: '💡',
  }
  return map[type] ?? '⚙️'
}

function CertBadge({ cert }: { cert: MirrorDevice['certification'] }) {
  const status = cert?.status ?? 'untested'
  const config: Record<string, { label: string; cls: string; title?: string }> = {
    certified: {
      label: '✅ Certyfikowany',
      cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      title: cert.testedAt ? `Testowano: ${cert.testedAt}` : 'Certyfikowany przez GateLynk QA',
    },
    beta: {
      label: '🟡 Beta',
      cls: 'bg-amber-50 text-amber-700 border-amber-200',
      title: 'Driver działa w ograniczonym zakresie',
    },
    community: {
      label: '🤝 Community',
      cls: 'bg-blue-50 text-blue-700 border-blue-200',
      title: 'Driver społecznościowy — GateLynk nie utrzymuje',
    },
    untested: {
      label: '⚪ Nietestowany',
      cls: 'bg-gray-100 text-gray-600 border-gray-200',
      title: 'Brak weryfikacji u realnego klienta',
    },
  }
  const c = config[status] ?? config.untested
  const fws = cert?.firmwareVersions ?? cert?.testedFirmware
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${c.cls}`}
      title={c.title}
    >
      {c.label}
      {fws && fws.length > 0 && (
        <span className="text-[10px] opacity-75 font-mono">
          {fws.slice(0, 2).join(', ')}{fws.length > 2 ? '…' : ''}
        </span>
      )}
    </span>
  )
}

function MirrorExpanded({ device }: { device: MirrorDevice }) {
  const cfg = device.config ?? {}
  // Pokazujemy klucze configu w 3 grupach: instalacyjne (user-supplied),
  // zaszyte (z driver.constants po merge w controller), wrażliwe (xIsSet).
  const INSTALL_KEYS = new Set(['name', 'ipAddress', 'login', 'channel', 'manufacturer', 'model', 'driverId', 'relays'])
  const SENSITIVE_FLAGS = Object.keys(cfg).filter((k) => k.endsWith('IsSet'))
  const installEntries = Object.entries(cfg).filter(([k]) => INSTALL_KEYS.has(k))
  const constantEntries = Object.entries(cfg).filter(
    ([k]) => !INSTALL_KEYS.has(k) && !k.endsWith('IsSet'),
  )

  return (
    <div className="space-y-3 text-xs">
      {device.certification?.knownIssues && device.certification.knownIssues.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded p-2">
          <div className="font-semibold text-amber-800 mb-1">⚠️ Znane issue</div>
          <ul className="list-disc list-inside text-amber-700 space-y-0.5">
            {device.certification.knownIssues.map((i, idx) => (
              <li key={idx}>{i}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Instalacyjne (user-supplied) */}
        <div className="bg-white rounded border border-gray-200 p-2">
          <div className="font-semibold text-gray-700 mb-1">📝 Konfiguracja instalacji</div>
          {installEntries.length === 0 ? (
            <div className="text-gray-400 italic">brak</div>
          ) : (
            <table className="w-full">
              <tbody>
                {installEntries.map(([k, v]) => (
                  <tr key={k}>
                    <td className="text-gray-500 pr-2 align-top">{k}</td>
                    <td className="text-gray-900 font-mono break-all">
                      {Array.isArray(v) ? `${v.length} pozycji` : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Driver constants (zaszyte) + sensitive flags */}
        <div className="bg-white rounded border border-gray-200 p-2">
          <div className="font-semibold text-gray-700 mb-1">⚙️ Stałe drivera (zaszyte)</div>
          {constantEntries.length === 0 ? (
            <div className="text-gray-400 italic">brak</div>
          ) : (
            <table className="w-full">
              <tbody>
                {constantEntries.map(([k, v]) => (
                  <tr key={k}>
                    <td className="text-gray-500 pr-2 align-top">{k}</td>
                    <td className="text-gray-900 font-mono break-all">
                      {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {SENSITIVE_FLAGS.length > 0 && (
            <div className="mt-2 pt-2 border-t border-gray-100">
              <div className="font-semibold text-gray-700 mb-1">🔒 Sekrety (na Edge)</div>
              <div className="text-gray-600">
                {SENSITIVE_FLAGS.map((k) => (
                  <div key={k} className="font-mono">
                    {k.replace('IsSet', '')}: <span className="text-emerald-700">{cfg[k] ? '✓ ustawione' : '✗ brak'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {device.driver?.capabilities && device.driver.capabilities.length > 0 && (
        <div className="bg-white rounded border border-gray-200 p-2">
          <div className="font-semibold text-gray-700 mb-1">🎯 Capabilities</div>
          <div className="flex flex-wrap gap-1">
            {device.driver.capabilities.map((c) => (
              <span key={c} className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded text-xs">
                {c}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
