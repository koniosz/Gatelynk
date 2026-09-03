'use client'
/**
 * Faza B-5 (2026-05-14) — panel Integratora: pełen widok urządzeń z Edge mirror.
 *
 * Hierarchia odpowiedzialności (decyzja 2026-05-14 — patrz CLAUDE.md/Faza B):
 *   1. Integrator dodaje urządzenia w Edge wizard (`http://<edge>:4000/ui/wizard.html`)
 *      — IP/login/hasło/relays/test-matrix
 *   2. Edge push DEVICE_UPSERT → Cloud mirror
 *   3. Integrator widzi tu pełen widok, może zmienić `displayLabel` (`updatedBy='integrator'`)
 *   4. Mirror jest wystawiony Building Adminowi (też z edytowalnym labelem,
 *      `updatedBy='building-admin'`) — patrz `/building-admin/.../devices`.
 *
 * Różnice względem BA panelu:
 *   • Link „Otwórz Edge wizard" (`wizardUrlHint` z API) — szybki skrót integratorski
 *   • Edycja labela traktowana z wagą integratora (audit przez `labelUpdatedBy`)
 *   • W przyszłości (Faza B-6): AP mapping per urządzenie tu, nie w BA
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { integratorApi } from '@/lib/integrator-api'
import { IntegratorAccessPointsSection } from './IntegratorAccessPointsSection'
import { IntegratorLprLinkageCard } from './IntegratorLprLinkageCard'
import { IntegratorExitGraceCard } from './IntegratorExitGraceCard'
import { IntegratorAiEngineCard } from './IntegratorAiEngineCard'
import { IntegratorCameraSettingsCard } from './IntegratorCameraSettingsCard'
import { IntegratorEdgeActivationCard } from './IntegratorEdgeActivationCard'
import { IntegratorSmartLockCard } from './IntegratorSmartLockCard'
import { AkuvoxStationCard } from '@/components/AkuvoxStationCard'

interface EdgeDevice {
  id: string
  buildingId: number
  type: string
  name: string | null
  isActivated: boolean
  lastSeenAt: string | null
  ipAddress: string | null
  version: string | null
  online: boolean
  outbox: { pending: number; failed: number }
  /** Faza B-5: http://<edgeIp>:4000/ui/wizard.html — wymaga LAN/Tailscale dostępu */
  wizardUrlHint: string | null
  /** PR-1: pending kod aktywacyjny (null po aktywacji — kod jest konsumowany) */
  activationCode?: string | null
  activationCodeExpiresAt?: string | null
}

interface MirrorDevice {
  id: number
  deviceUuid: string
  edgeDeviceId: string | null
  type: string
  driverId: string | null
  config: Record<string, any>
  displayLabel: string | null
  labelUpdatedBy: 'edge-init' | 'building-admin' | 'integrator' | null
  labelUpdatedAt: string | null
  lastSyncedAt: string
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
    knownIssues?: string[]
  }
}

interface DevicesResponse {
  edges: EdgeDevice[]
  mirrorDevices: MirrorDevice[]
}

export default function IntegratorDevicesPage() {
  const params = useParams<{ id: string }>()
  const buildingId = Number(params.id)
  const [data, setData] = useState<DevicesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedMirrorId, setExpandedMirrorId] = useState<number | null>(null)
  const [editingLabelId, setEditingLabelId] = useState<number | null>(null)
  const [editingLabelValue, setEditingLabelValue] = useState('')
  const [savingLabelId, setSavingLabelId] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    integratorApi
      .get(`/integrator/buildings/${buildingId}/devices`)
      .then((r) => setData(r.data as DevicesResponse))
      .catch((err) => setError(err?.response?.data?.message ?? 'Błąd ładowania'))
      .finally(() => setLoading(false))
  }, [buildingId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3500)
  }

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
      await integratorApi.patch(
        `/integrator/buildings/${buildingId}/devices/mirror/${m.id}/label`,
        { displayLabel: trimmed },
      )
      setData((prev) => prev ? {
        ...prev,
        mirrorDevices: prev.mirrorDevices.map((x) =>
          x.id === m.id ? { ...x, displayLabel: trimmed, labelUpdatedBy: 'integrator' as const } : x,
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

  return (
    <div className="max-w-6xl">
      <div className="mb-4">
        <Link
          href={`/integrator/buildings/${buildingId}`}
          className="text-sm text-gray-400 hover:text-gray-600"
        >
          ← Budynek
        </Link>
      </div>

      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🔧 Urządzenia (panel integratora)</h1>
          <p className="text-sm text-gray-500 mt-1">
            Pełen widok urządzeń z Edge sqlite + mirror w Cloud. Tu zarządzasz mapowaniem
            i etykietami; pełna konfiguracja techniczna (IP/hasła/relays/test) odbywa się
            w <span className="font-mono text-gray-700">Edge wizard</span> (link niżej przy
            każdym Edge serwerze). Status online/offline odświeża się co 15 s.
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

          {/* PR-1 (2026-07) — karta „Edge / kod aktywacyjny": generowanie kodu,
              lista EdgeDevice (status/IP/wersja/lastSeen/pending kod), usuwanie.
              Zastępuje dawną sekcję „Edge serwery" (kod generowało się tylko
              w legacy panelu superadmina). */}
          <IntegratorEdgeActivationCard
            buildingId={buildingId}
            edges={data.edges}
            onChanged={load}
          />

          {/* 2026-06-02 — wiring techniczny przeniesiony z BA do Integratora.
              Edycja binding device→output + LPR camera→AP linkage. */}
          <IntegratorAccessPointsSection buildingId={buildingId} />
          <IntegratorLprLinkageCard buildingId={buildingId} />

          {/* 2026-07-30 — Przepustka wyjazdowa (exit grace pass): pojazd spoza
              whitelisty może wyjechać w oknie czasowym od wjazdu. Config w
              Building.features.exitGrace, sync do Edge przez BUILDING_CONFIG_UPDATE. */}
          <IntegratorExitGraceCard buildingId={buildingId} />

          {/* FAZA 8.g (2026-06-03) — AI Engine config + test connection. */}
          <IntegratorAiEngineCard buildingId={buildingId} />

          {/* FAZA 8.h (2026-06-03) — Per-kamera role (STANDARD/LPR) + AI toggle. */}
          <IntegratorCameraSettingsCard buildingId={buildingId} />

          {/* 2026-07 — zamki Nuki na drzwiach mieszkań (AP category=UNIT_DOOR,
              token API pass-through na Edge — patrz banner na karcie). */}
          <IntegratorSmartLockCard buildingId={buildingId} />

          {/* 2026-07-30 — Akuvox Directory Sync v2 (per-urządzenie, template-driven,
              dry-run). Legacy karta niżej działa dalej — docs/akuvox-directory-v2-analysis.md. */}
          <div className="rounded-xl border border-blue-200 bg-blue-50/50 p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h3 className="text-base font-semibold text-gray-800">🔄 Akuvox → Directory Sync (v2)</h3>
                <p className="mt-1 text-sm text-gray-500 max-w-2xl">
                  Nowa synchronizacja katalogu kontaktów per-urządzenie: mapowanie, podgląd ekranu,
                  template-driven eksport/import, dry-run. Zastępuje docelowo Remote Phonebook i eksport
                  per-budynek (te działają dalej — karta „Stacja domofonowa" niżej jest legacy).
                </p>
              </div>
              <Link
                href={`/integrator/buildings/${buildingId}/akuvox-directory`}
                className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 shrink-0"
              >
                Otwórz Directory Sync →
              </Link>
            </div>
          </div>

          {/* 2026-06-22 — Eksport listy mieszkańców do Akuvox + ściąga konfiguracji stacji.
              LEGACY (2026-07-30): następca = Directory Sync v2 (karta wyżej). */}
          <AkuvoxStationCard
            api={integratorApi}
            exportUrl={`/integrator/buildings/${buildingId}/akuvox-userdata.tgz`}
            showConfig
          />

          {/* Mirror devices */}
          <Section title="🪞 Urządzenia (Edge mirror)" count={data.mirrorDevices.length}>
            {data.mirrorDevices.length === 0 ? (
              <Empty>
                Brak urządzeń w Edge sqlite. Dodaj przez wizard (link „Edge wizard" przy Edge serwerze powyżej).
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
                                  <button data-no-expand onClick={(e) => { e.stopPropagation(); saveLabel(m) }} disabled={isSaving}
                                    className="text-xs px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 disabled:opacity-40">
                                    ✓
                                  </button>
                                  <button data-no-expand onClick={(e) => { e.stopPropagation(); cancelLabelEdit() }} disabled={isSaving}
                                    className="text-xs px-2 py-1 rounded bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40">
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
                                  <LabelOriginBadge updatedBy={m.labelUpdatedBy} updatedAt={m.labelUpdatedAt} />
                                </>
                              )}
                            </div>
                            <div className="text-xs text-gray-400 font-mono">{m.deviceUuid.slice(0, 12)}…</div>
                          </td>
                          <td className="px-4 py-3"><StatusBadge online={m.online} /></td>
                          <td className="px-4 py-3">
                            <div className="text-xs text-gray-700">
                              <span className="inline-block px-1.5 py-0.5 bg-gray-100 rounded font-mono mr-1">{m.type}</span>
                              {m.driver?.label ?? <span className="text-gray-400 italic">driver „{m.driverId ?? 'nieznany'}"</span>}
                            </div>
                            {cfg.model && <div className="text-xs text-gray-500 mt-0.5">Model: <span className="font-mono">{cfg.model}</span></div>}
                          </td>
                          <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                            {cfg.ipAddress ?? <span className="text-gray-400 italic">—</span>}
                          </td>
                          <td className="px-4 py-3"><CertBadge cert={m.certification} /></td>
                          <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">{formatLastSeen(m.lastSyncedAt)}</td>
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

// ── Helpers (kopia z BA devices/page.tsx — w przyszłości wyniesione do shared) ──

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="font-semibold text-gray-800">
          {title}<span className="ml-2 text-xs font-normal text-gray-400">({count})</span>
        </h2>
      </div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-gray-400">{children}</div>
}

function StatusBadge({ online, activated }: { online: boolean; activated?: boolean }) {
  if (activated === false) {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />Nieaktywowany
      </span>
    )
  }
  return online ? (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Online
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
      <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />Offline
    </span>
  )
}

function typeIcon(type: string): string {
  const map: Record<string, string> = {
    INTERCOM: '🔔', CAMERA: '📷', LPR_CAMERA: '🚗', ELEVATOR: '🛗',
    LIGHTING: '💡', SWITCH: '🔌', LOCK: '🔐', KNX_BRIDGE: '🏗️', KNX_OBJECT: '💡',
  }
  return map[type] ?? '⚙️'
}

function CertBadge({ cert }: { cert: MirrorDevice['certification'] }) {
  const status = cert?.status ?? 'untested'
  const config: Record<string, { label: string; cls: string; title?: string }> = {
    certified: { label: '✅ Certyfikowany', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', title: cert.testedAt ? `Testowano: ${cert.testedAt}` : 'Certyfikowany przez GateLynk QA' },
    beta:      { label: '🟡 Beta',          cls: 'bg-amber-50 text-amber-700 border-amber-200',     title: 'Driver działa w ograniczonym zakresie' },
    community: { label: '🤝 Community',     cls: 'bg-blue-50 text-blue-700 border-blue-200',         title: 'Driver społecznościowy' },
    untested:  { label: '⚪ Nietestowany',  cls: 'bg-gray-100 text-gray-600 border-gray-200',        title: 'Brak weryfikacji' },
  }
  const c = config[status] ?? config.untested
  const fws = cert?.firmwareVersions ?? cert?.testedFirmware
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${c.cls}`} title={c.title}>
      {c.label}
      {fws && fws.length > 0 && <span className="text-[10px] opacity-75 font-mono">{fws.slice(0, 2).join(', ')}{fws.length > 2 ? '…' : ''}</span>}
    </span>
  )
}

function LabelOriginBadge({ updatedBy, updatedAt }: { updatedBy: MirrorDevice['labelUpdatedBy']; updatedAt: string | null }) {
  if (!updatedBy || updatedBy === 'edge-init') return null
  const cfg = {
    'integrator':     { label: 'INT', cls: 'bg-purple-50 text-purple-700 border-purple-200', title: 'Zmienione przez integratora' },
    'building-admin': { label: 'BA',  cls: 'bg-blue-50 text-blue-700 border-blue-200',       title: 'Zmienione przez admina budynku' },
  }[updatedBy]
  if (!cfg) return null
  return (
    <span
      className={`text-[10px] px-1 py-0.5 rounded border ${cfg.cls}`}
      title={`${cfg.title}${updatedAt ? ` · ${new Date(updatedAt).toLocaleString('pl-PL')}` : ''}`}
    >
      {cfg.label}
    </span>
  )
}

function MirrorExpanded({ device }: { device: MirrorDevice }) {
  const cfg = device.config ?? {}
  const INSTALL_KEYS = new Set(['name', 'ipAddress', 'login', 'channel', 'manufacturer', 'model', 'driverId', 'relays'])
  const SENSITIVE_FLAGS = Object.keys(cfg).filter((k) => k.endsWith('IsSet'))
  const installEntries = Object.entries(cfg).filter(([k]) => INSTALL_KEYS.has(k))
  const constantEntries = Object.entries(cfg).filter(([k]) => !INSTALL_KEYS.has(k) && !k.endsWith('IsSet'))

  return (
    <div className="space-y-3 text-xs">
      {device.certification?.knownIssues && device.certification.knownIssues.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded p-2">
          <div className="font-semibold text-amber-800 mb-1">⚠️ Znane issue</div>
          <ul className="list-disc list-inside text-amber-700 space-y-0.5">
            {device.certification.knownIssues.map((i, idx) => <li key={idx}>{i}</li>)}
          </ul>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-white rounded border border-gray-200 p-2">
          <div className="font-semibold text-gray-700 mb-1">📝 Konfiguracja instalacji</div>
          {installEntries.length === 0 ? <div className="text-gray-400 italic">brak</div> : (
            <table className="w-full">
              <tbody>{installEntries.map(([k, v]) => (
                <tr key={k}><td className="text-gray-500 pr-2 align-top">{k}</td>
                <td className="text-gray-900 font-mono break-all">
                  {Array.isArray(v) ? `${v.length} pozycji` : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <div className="bg-white rounded border border-gray-200 p-2">
          <div className="font-semibold text-gray-700 mb-1">⚙️ Stałe drivera (zaszyte)</div>
          {constantEntries.length === 0 ? <div className="text-gray-400 italic">brak</div> : (
            <table className="w-full">
              <tbody>{constantEntries.map(([k, v]) => (
                <tr key={k}><td className="text-gray-500 pr-2 align-top">{k}</td>
                <td className="text-gray-900 font-mono break-all">
                  {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </td></tr>
              ))}</tbody>
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
              <span key={c} className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded text-xs">{c}</span>
            ))}
          </div>
        </div>
      )}
    </div>
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
