'use client'
/**
 * Integracje → Akuvox → Directory Sync (v2, 2026-07-30) — panel Integratora.
 * Analiza + decyzja lokalizacji (Integrator, nie BA): docs/akuvox-directory-v2-analysis.md §6.
 *
 * Widoki (pkt 14 spec; Etap 1 = A/B/C + E-częściowo):
 *   A Urządzenie   — model, IP, MAC, firmware, tryb, ostatnia synchronizacja, capabilities
 *   B Mapowanie    — displayMode/groupBy/szablony/prywatność
 *   C Podgląd      — dokładna lista wpisów + wyszukiwanie + ostrzeżenia + liczba
 *   D Różnice      — PLACEHOLDER (Etap 2); dry-run dostępny w E
 *   E Import/Eksport — pobierz plik, wgraj template, wgraj eksport z urządzenia,
 *                      sprawdź zgodność (dry-run), potwierdź import
 *   F Historia     — PLACEHOLDER (Etap 2)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { integratorApi } from '@/lib/integrator-api'

// ── Typy (lustro API) ──────────────────────────────────────────────────────────

interface AkuvoxDeviceRow {
  id: number
  name: string
  model: string | null
  ipAddress: string | null
  macAddress: string | null
  firmwareVersion: string | null
  hardwareVersion: string | null
  dialHost: string | null
  syncMode: string
  contactAuthority: string
  adapter: string
  mapping: Partial<Mapping>
  credentialUser: string | null
  credentialIsSet: boolean
  enabled: boolean
  lastSyncAt: string | null
  lastSyncChecksum: string | null
  deviceSnapshotEntryCount: number | null
  deviceSnapshotTakenAt: string | null
}

interface Mapping {
  displayMode: 'person' | 'unit' | 'unit_group_call'
  groupBy: 'none' | 'building' | 'staircase' | 'floor'
  displayNameTemplate: string
  roomNumberTemplate: string
  hideLastName: boolean
  anonymizeDirectory: boolean
}

interface Capabilities {
  model: string
  firmwareVersion: string
  supportsLegacyPhonebookUrl: boolean
  supportsDirectoryUsers: boolean
  supportsContactDetails: boolean
  supportsCsvImport: boolean
  supportsXmlImport: boolean
  supportsTgzImport: boolean
  supportsHttpApi: boolean
  supportsDirectoryWriteApi: boolean
  recommendedAdapter: string
}

interface DirectoryEntry {
  externalId: string
  userId: string
  name: string
  roomNumber?: string
  groupName?: string
  enabled: boolean
  contacts: { phone: string; priority: string; dialAccount: string }[]
}

interface DirectoryResponse {
  entries: DirectoryEntry[]
  count: number
  validCount: number
  issues: { level: 'error' | 'warning'; code: string; message: string }[]
  directoryChecksum: string
}

interface FieldChange {
  field: string
  before: string
  after: string
}

interface PreviewResult {
  summary: { create: number; update: number; disable: number; delete: number; unchanged: number; conflicts: number }
  changes: { op: string; externalId?: string; name: string; detail?: string; fields?: FieldChange[] }[]
  warnings: string[]
  errors: string[]
  directoryChecksum: string
  conflicts: { externalId?: string; key: string; reason: string; desiredName?: string; currentName?: string; currentManagedBy?: string }[]
  preservedForeignCount: number
  comparedFields: string[]
}

interface SyncRun {
  id: number
  kind: string
  status: string
  operator: string | null
  summary: { create: number; update: number; disable: number; delete: number; unchanged: number; conflicts: number } | null
  warnings: string[] | null
  errors: string[] | null
  directoryChecksum: string | null
  fileName: string | null
  createdAt: string
}

interface MigrationRow {
  unitId: number
  legacyName: string
  v2Name: string
  dial: string
  legacyGroup: string
  v2Group: string
  differences: { field: string; legacy: string; v2: string; expected: boolean; note?: string }[]
  status: 'identical' | 'ok' | 'differs'
}

interface MigrationReport {
  rows: MigrationRow[]
  summary: { total: number; identical: number; expectedOnly: number; differing: number; missingInV2: number; extraInV2: number }
  notes: string[]
  proposedMapping?: Mapping
  adopted?: boolean
  syncRunId?: number
}

type Tab = 'device' | 'mapping' | 'preview' | 'diff' | 'importexport' | 'history'

const TABS: { id: Tab; label: string }[] = [
  { id: 'device', label: 'A · Urządzenie' },
  { id: 'mapping', label: 'B · Mapowanie' },
  { id: 'preview', label: 'C · Podgląd' },
  { id: 'diff', label: 'D · Różnice' },
  { id: 'importexport', label: 'E · Import/Eksport' },
  { id: 'history', label: 'F · Historia' },
]

const DEFAULT_MAPPING: Mapping = {
  displayMode: 'unit',
  groupBy: 'none',
  displayNameTemplate: '{{unitNumber}} — {{lastNames}}',
  roomNumberTemplate: '{{unitNumber}}',
  hideLastName: false,
  anonymizeDirectory: false,
}

export default function AkuvoxDirectoryPage() {
  const params = useParams<{ id: string }>()
  const buildingId = Number(params.id)

  const [devices, setDevices] = useState<AkuvoxDeviceRow[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>('device')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const device = devices.find((d) => d.id === selectedId) ?? null

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }, [])

  const loadDevices = useCallback(() => {
    integratorApi
      .get<AkuvoxDeviceRow[]>(`/integrations/akuvox/buildings/${buildingId}/devices`)
      .then((r) => {
        setDevices(r.data)
        setSelectedId((prev) => prev ?? r.data[0]?.id ?? null)
        setError(null)
      })
      .catch((err) => setError(err?.response?.data?.message ?? 'Błąd ładowania urządzeń'))
      .finally(() => setLoading(false))
  }, [buildingId])

  useEffect(() => {
    loadDevices()
  }, [loadDevices])

  return (
    <div className="max-w-6xl">
      <div className="mb-4">
        <Link href={`/integrator/buildings/${buildingId}/devices`} className="text-sm text-gray-400 hover:text-gray-600">
          ← Urządzenia
        </Link>
      </div>

      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">🔄 Integracje → Akuvox → Directory Sync</h1>
          <p className="text-sm text-gray-500 mt-1 max-w-3xl">
            Synchronizacja katalogu kontaktów GateLynk → Akuvox (firmware 29.30.10.x). GateLynk jest źródłem
            prawdy; urządzenie trzyma lokalną kopię. MVP: eksport/import ręczny (template-driven).{' '}
            <span className="text-gray-400">Stara integracja (Remote Phonebook / UserData.tgz per-budynek) działa dalej — patrz karta „Stacja domofonowa Akuvox".</span>
          </p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 shrink-0"
        >
          + Dodaj urządzenie
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg mb-4">{error}</div>
      )}

      {showCreate && (
        <CreateDeviceCard
          buildingId={buildingId}
          onCreated={(d) => {
            setShowCreate(false)
            setSelectedId(d.id)
            loadDevices()
            showToast('✓ Urządzenie dodane')
          }}
          onError={(m) => showToast(`✗ ${m}`)}
        />
      )}

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">Ładowanie…</div>
      ) : devices.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-500">
          Brak zarejestrowanych urządzeń Akuvox dla synchronizacji katalogu.
          <br />
          Dodaj pierwsze urządzenie (np. „Brama główna R29C"), żeby skonfigurować Directory Sync.
        </div>
      ) : (
        <>
          {/* Wybór urządzenia */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            {devices.map((d) => (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={`text-sm px-3 py-1.5 rounded-lg border ${
                  d.id === selectedId
                    ? 'bg-blue-50 border-blue-300 text-blue-800 font-medium'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                🔔 {d.name}
                <span className="ml-1 text-xs text-gray-400">{d.model ?? '?'} · fw {d.firmwareVersion ?? '?'}</span>
              </button>
            ))}
          </div>

          {/* Zakładki A–F */}
          <div className="flex gap-1 border-b border-gray-200 mb-4 flex-wrap">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`text-sm px-3 py-2 -mb-px border-b-2 ${
                  tab === t.id
                    ? 'border-blue-600 text-blue-700 font-medium'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {device && tab === 'device' && (
            <DeviceTab device={device} onSaved={() => { loadDevices(); showToast('✓ Zapisano') }} onError={(m) => showToast(`✗ ${m}`)} />
          )}
          {device && tab === 'mapping' && (
            <MappingTab device={device} onSaved={() => { loadDevices(); showToast('✓ Mapowanie zapisane') }} onError={(m) => showToast(`✗ ${m}`)} />
          )}
          {device && tab === 'preview' && <PreviewTab deviceId={device.id} />}
          {device && tab === 'diff' && <DiffTab deviceId={device.id} />}
          {device && tab === 'importexport' && (
            <ImportExportTab device={device} onChanged={loadDevices} showToast={showToast} />
          )}
          {device && tab === 'history' && <HistoryTab device={device} />}
        </>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  )
}

// ── Karty pomocnicze ──────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-4">
      <div className="px-4 py-3 border-b border-gray-100">
        <h2 className="font-semibold text-gray-800 text-sm">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-gray-600 text-xs font-medium">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

const inputCls =
  'w-full text-sm px-2.5 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200 bg-white'

// ── Tworzenie urządzenia ──────────────────────────────────────────────────────

function CreateDeviceCard({
  buildingId,
  onCreated,
  onError,
}: {
  buildingId: number
  onCreated: (d: AkuvoxDeviceRow) => void
  onError: (msg: string) => void
}) {
  const [form, setForm] = useState({ name: '', model: 'R29C', firmwareVersion: '29.30.10.128', ipAddress: '', macAddress: '' })
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!form.name.trim()) return onError('Podaj nazwę urządzenia')
    setBusy(true)
    try {
      const r = await integratorApi.post<AkuvoxDeviceRow>(`/integrations/akuvox/buildings/${buildingId}/devices`, form)
      onCreated(r.data)
    } catch (err: unknown) {
      onError((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Błąd zapisu')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Nowe urządzenie Akuvox (cel synchronizacji katalogu)">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Field label="Nazwa *">
          <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Brama główna R29C" />
        </Field>
        <Field label="Model">
          <input className={inputCls} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </Field>
        <Field label="Firmware">
          <input className={inputCls} value={form.firmwareVersion} onChange={(e) => setForm({ ...form, firmwareVersion: e.target.value })} />
        </Field>
        <Field label="IP (LAN)">
          <input className={inputCls} value={form.ipAddress} onChange={(e) => setForm({ ...form, ipAddress: e.target.value })} placeholder="192.168.1.109" />
        </Field>
        <Field label="MAC">
          <input className={inputCls} value={form.macAddress} onChange={(e) => setForm({ ...form, macAddress: e.target.value })} />
        </Field>
      </div>
      <div className="mt-3">
        <button onClick={submit} disabled={busy} className="text-sm px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
          {busy ? 'Zapisywanie…' : 'Dodaj urządzenie'}
        </button>
      </div>
    </Card>
  )
}

// ── A · Urządzenie ────────────────────────────────────────────────────────────

function DeviceTab({
  device,
  onSaved,
  onError,
}: {
  device: AkuvoxDeviceRow
  onSaved: () => void
  onError: (m: string) => void
}) {
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [form, setForm] = useState({
    name: device.name,
    model: device.model ?? '',
    ipAddress: device.ipAddress ?? '',
    macAddress: device.macAddress ?? '',
    firmwareVersion: device.firmwareVersion ?? '',
    dialHost: device.dialHost ?? '',
    syncMode: device.syncMode,
    contactAuthority: device.contactAuthority,
    adapter: device.adapter,
    credentialUser: device.credentialUser ?? '',
    credentialPassword: '',
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    integratorApi
      .get<Capabilities>(`/integrations/akuvox/devices/${device.id}/capabilities`)
      .then((r) => setCaps(r.data))
      .catch(() => setCaps(null))
  }, [device.id, device.firmwareVersion, device.model])

  const save = async () => {
    setBusy(true)
    try {
      const payload: Record<string, unknown> = { ...form }
      if (!form.credentialPassword) delete payload.credentialPassword
      await integratorApi.patch(`/integrations/akuvox/devices/${device.id}`, payload)
      setForm((f) => ({ ...f, credentialPassword: '' }))
      onSaved()
    } catch (err: unknown) {
      onError((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Błąd zapisu')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card title="A · Urządzenie — dane i tryb synchronizacji">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Nazwa">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Model">
            <input className={inputCls} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </Field>
          <Field label="Firmware">
            <input className={inputCls} value={form.firmwareVersion} onChange={(e) => setForm({ ...form, firmwareVersion: e.target.value })} placeholder="29.30.10.465" />
          </Field>
          <Field label="IP (LAN)">
            <input className={inputCls} value={form.ipAddress} onChange={(e) => setForm({ ...form, ipAddress: e.target.value })} />
          </Field>
          <Field label="MAC">
            <input className={inputCls} value={form.macAddress} onChange={(e) => setForm({ ...form, macAddress: e.target.value })} />
          </Field>
          <Field label="Host SIP dzwonienia (dialHost)">
            <input
              className={inputCls}
              value={form.dialHost}
              onChange={(e) => setForm({ ...form, dialHost: e.target.value })}
              placeholder="np. 192.168.1.127 (LAN IP huba Edge)"
            />
          </Field>
          <div className="col-span-2 text-xs text-amber-700 self-end pb-2">
            Numery w plikach kontaktów będą postaci <span className="font-mono">lokal@host</span> (routing
            per-lokal). Wpisz LAN IP huba Edge — NIE kopiuj ślepo IP z listy urządzeń (bywa adresem
            Tailscale, niedostępnym dla stacji). Puste = goły numer lokalu (ostrzeżenie przy CSV).
          </div>
          <Field label="Tryb synchronizacji">
            <select className={inputCls} value={form.syncMode} onChange={(e) => setForm({ ...form, syncMode: e.target.value })}>
              <option value="MANUAL_EXPORT">MANUAL_EXPORT (MVP)</option>
              <option value="MANUAL_IMPORT">MANUAL_IMPORT (MVP)</option>
              <option value="PROVISIONING">PROVISIONING (Etap 2)</option>
              <option value="DEVICE_API">DEVICE_API (Etap 3)</option>
            </select>
          </Field>
          <Field label="Źródło kontaktów (authority)">
            <select className={inputCls} value={form.contactAuthority} onChange={(e) => setForm({ ...form, contactAuthority: e.target.value })}>
              <option value="GATELYNK">GATELYNK — GateLynk rządzi katalogiem</option>
              <option value="SMARTPLUS">SMARTPLUS — chmura Akuvox</option>
              <option value="MERGED">MERGED — współistnienie (GateLynk tylko swoje wpisy)</option>
              <option value="MANUAL">MANUAL — bez synchronizacji</option>
            </select>
          </Field>
          <Field label="Adapter">
            <select className={inputCls} value={form.adapter} onChange={(e) => setForm({ ...form, adapter: e.target.value })}>
              <option value="legacy-contacts">legacy-contacts (starsze firmware, format E18C)</option>
              <option value="directory-user">directory-user (29.30.10.465+, wymaga template)</option>
            </select>
          </Field>
        </div>

        <div className="mt-4 pt-3 border-t border-gray-100 grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Login web UI urządzenia">
            <input className={inputCls} value={form.credentialUser} onChange={(e) => setForm({ ...form, credentialUser: e.target.value })} autoComplete="off" />
          </Field>
          <Field label={`Hasło web UI ${device.credentialIsSet ? '(✓ ustawione — wpisz, by nadpisać)' : '(brak)'}`}>
            <input type="password" className={inputCls} value={form.credentialPassword} onChange={(e) => setForm({ ...form, credentialPassword: e.target.value })} placeholder="••••••••" autoComplete="new-password" />
          </Field>
          <div className="col-span-2 text-xs text-gray-400 self-end pb-2">
            Hasło jest szyfrowane (AES-256-GCM, klucz AKUVOX_CRED_KEY) i nigdy nie wraca do przeglądarki.
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button onClick={save} disabled={busy} className="text-sm px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Zapisywanie…' : 'Zapisz'}
          </button>
          <span className="text-xs text-gray-400">
            Ostatnia synchronizacja: {device.lastSyncAt ? new Date(device.lastSyncAt).toLocaleString('pl-PL') : '—'}
            {device.lastSyncChecksum ? ` · checksum ${device.lastSyncChecksum.slice(0, 12)}…` : ''}
          </span>
        </div>
      </Card>

      <Card title="Możliwości firmware (wykryte z modelu + wersji — bez odpytywania urządzenia)">
        {!caps ? (
          <div className="text-sm text-gray-400">Uzupełnij model i firmware, żeby zobaczyć capabilities.</div>
        ) : (
          <div className="flex flex-wrap gap-2 text-xs">
            <CapBadge ok={caps.supportsLegacyPhonebookUrl} label="Remote Phonebook URL" />
            <CapBadge ok={caps.supportsDirectoryUsers} label="Directory → User" />
            <CapBadge ok={caps.supportsContactDetails} label="Contact Details (1+ numerów)" />
            <CapBadge ok={caps.supportsTgzImport} label="Import TGZ" />
            <CapBadge ok={caps.supportsXmlImport} label="Import XML" />
            <CapBadge ok={caps.supportsCsvImport} label="Import CSV" />
            <CapBadge ok={caps.supportsHttpApi} label="HTTP API (menu)" />
            <CapBadge ok={caps.supportsDirectoryWriteApi} label="Zapis katalogu przez API" />
            <span className="px-2 py-0.5 rounded border bg-blue-50 border-blue-200 text-blue-700">
              Rekomendowany adapter: {caps.recommendedAdapter}
            </span>
          </div>
        )}
        <p className="text-xs text-gray-400 mt-3">
          „Zapis katalogu przez API" pozostaje wyłączony, dopóki oficjalne endpointy Akuvox nie zostaną
          potwierdzone dokumentacją lub testem na urządzeniu (Etap 3).
        </p>
      </Card>

      {form.syncMode === 'PROVISIONING' && <ProvisioningCard deviceId={device.id} />}

      <MigrationCard deviceId={device.id} onAdopted={onSaved} onError={onError} />
    </>
  )
}

// ── Provisioning (Etap 2, za flagą — default OFF) ─────────────────────────────

function ProvisioningCard({ deviceId }: { deviceId: number }) {
  const [info, setInfo] = useState<{
    enabled: boolean
    active: boolean
    path: string
    token: string
    note: string
  } | null>(null)

  useEffect(() => {
    integratorApi
      .get(`/integrations/akuvox/devices/${deviceId}/provisioning-info`)
      .then((r) => setInfo(r.data))
      .catch(() => setInfo(null))
  }, [deviceId])

  if (!info) return null
  const base = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/api').replace(/\/api$/, '')
  const url = `${base}${info.path}?t=${info.token}`
  return (
    <Card title="Provisioning — plik katalogu pod stabilnym URL-em (za flagą)">
      <div
        className={`text-xs px-3 py-1.5 rounded border mb-2 ${
          info.active
            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
            : 'bg-amber-50 border-amber-200 text-amber-700'
        }`}
      >
        {info.active
          ? '✓ Aktywny — urządzenie może pobierać plik z URL-a poniżej.'
          : `⏸ Nieaktywny — flaga AKUVOX_PROVISIONING_SYNC=${info.enabled ? 'on' : 'off (default)'}${info.enabled ? '' : '; endpoint odpowiada 404'}.`}
      </div>
      <div className="font-mono text-xs bg-gray-50 border border-gray-200 rounded p-2 break-all select-all">{url}</div>
      <p className="text-xs text-gray-400 mt-2">⚠️ {info.note}</p>
    </Card>
  )
}

// ── Kreator migracji legacy → v2 (pkt 20, Etap 2) ─────────────────────────────

function MigrationCard({
  deviceId,
  onAdopted,
  onError,
}: {
  deviceId: number
  onAdopted: () => void
  onError: (m: string) => void
}) {
  const [report, setReport] = useState<MigrationReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [expandedUnit, setExpandedUnit] = useState<number | null>(null)

  const run = async (action: 'preview' | 'adopt') => {
    setBusy(true)
    try {
      const r = await integratorApi.post<MigrationReport>(
        `/integrations/akuvox/devices/${deviceId}/migration/${action}`,
      )
      setReport(r.data)
      if (action === 'adopt') onAdopted()
    } catch (err: unknown) {
      onError((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Błąd migracji')
    } finally {
      setBusy(false)
    }
  }

  const statusBadge = (s: MigrationRow['status']) =>
    s === 'identical' ? (
      <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700">identyczny</span>
    ) : s === 'ok' ? (
      <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700">OK (oczekiwane różnice)</span>
    ) : (
      <span className="text-xs px-1.5 py-0.5 rounded bg-rose-50 border border-rose-200 text-rose-700">wymaga uwagi</span>
    )

  return (
    <Card title="Migracja z Remote Phonebook (legacy → v2)">
      <p className="text-xs text-gray-500 mb-3">
        Porównuje wpisy generowane przez STARĄ integrację (Remote Phonebook XML / UserData.tgz per-budynek)
        z projekcją v2 pod mapowaniem parytetowym. „Przejmij konfigurację" zapisuje mapowanie parytetowe na
        tym urządzeniu i raport w historii — starej konfiguracji NIE usuwa (Remote Phonebook działa dalej,
        rollback = ponowne włączenie go na urządzeniu).
      </p>
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => run('preview')}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
        >
          {busy ? 'Porównywanie…' : '🔍 Podgląd migracji'}
        </button>
        {report && !report.adopted && (
          <button
            onClick={() => run('adopt')}
            disabled={busy || report.summary.differing > 0}
            title={report.summary.differing > 0 ? 'Rozwiąż różnice „wymaga uwagi" przed przejęciem' : undefined}
            className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            ✓ Przejmij konfigurację (adopt)
          </button>
        )}
        {report?.adopted && (
          <span className="text-xs px-2 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-700">
            ✓ Mapowanie parytetowe zapisane (operacja #{report.syncRunId})
          </span>
        )}
      </div>

      {report && (
        <>
          <div className="flex flex-wrap gap-2 mb-2 text-xs">
            <SummaryBadge label="Wpisów" value={report.summary.total} cls="bg-gray-50 border-gray-200 text-gray-600" />
            <SummaryBadge label="Identycznych" value={report.summary.identical} cls="bg-emerald-50 border-emerald-200 text-emerald-700" />
            <SummaryBadge label="OK (oczekiwane)" value={report.summary.expectedOnly} cls="bg-blue-50 border-blue-200 text-blue-700" />
            <SummaryBadge label="Wymaga uwagi" value={report.summary.differing} cls="bg-rose-50 border-rose-200 text-rose-700" />
          </div>
          <ul className="text-xs text-gray-400 list-disc list-inside mb-3">
            {report.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
          <div className="overflow-x-auto max-h-80 overflow-y-auto border border-gray-100 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 border-b border-gray-100 sticky top-0">
                <tr className="text-left font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-3 py-2">Legacy (dziś)</th>
                  <th className="px-3 py-2">v2 (po migracji)</th>
                  <th className="px-3 py-2 w-20">Numer</th>
                  <th className="px-3 py-2">Grupa</th>
                  <th className="px-3 py-2 w-40">Status</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <>
                    <tr
                      key={r.unitId}
                      className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                      onClick={() => setExpandedUnit(expandedUnit === r.unitId ? null : r.unitId)}
                    >
                      <td className="px-3 py-1.5 text-gray-700">{r.legacyName}</td>
                      <td className="px-3 py-1.5 text-gray-900 font-medium">{r.v2Name}</td>
                      <td className="px-3 py-1.5 font-mono">{r.dial}</td>
                      <td className="px-3 py-1.5 text-gray-600">
                        {r.legacyGroup === r.v2Group ? r.v2Group : `${r.legacyGroup} → ${r.v2Group}`}
                      </td>
                      <td className="px-3 py-1.5">{statusBadge(r.status)}</td>
                    </tr>
                    {expandedUnit === r.unitId && r.differences.length > 0 && (
                      <tr className="bg-gray-50/60 border-b border-gray-50">
                        <td colSpan={5} className="px-4 py-2">
                          {r.differences.map((d, i) => (
                            <div key={i} className={d.expected ? 'text-gray-500' : 'text-rose-700'}>
                              {d.expected ? '· ' : '⚠ '}
                              <span className="font-mono">{d.field}</span>: &quot;{d.legacy}&quot; → &quot;{d.v2}&quot;
                              {d.note ? <span className="text-gray-400"> — {d.note}</span> : null}
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  )
}

function CapBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`px-2 py-0.5 rounded border ${ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-gray-50 border-gray-200 text-gray-400'}`}>
      {ok ? '✓' : '✗'} {label}
    </span>
  )
}

// ── B · Mapowanie ─────────────────────────────────────────────────────────────

function MappingTab({
  device,
  onSaved,
  onError,
}: {
  device: AkuvoxDeviceRow
  onSaved: () => void
  onError: (m: string) => void
}) {
  const [m, setM] = useState<Mapping>({ ...DEFAULT_MAPPING, ...device.mapping })
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await integratorApi.patch(`/integrations/akuvox/devices/${device.id}`, { mapping: m })
      onSaved()
    } catch (err: unknown) {
      onError((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Błąd zapisu')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="B · Mapowanie — jak katalog GateLynk trafia na ekran domofonu">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Tryb wpisów (displayMode)">
          <select className={inputCls} value={m.displayMode} onChange={(e) => setM({ ...m, displayMode: e.target.value as Mapping['displayMode'] })}>
            <option value="unit">unit — jeden wpis na lokal (jak dotąd)</option>
            <option value="person">person — jeden wpis na mieszkańca</option>
            <option value="unit_group_call">unit_group_call — wpis zbiorczy (dzwoni do wszystkich w lokalu)</option>
          </select>
        </Field>
        <Field label="Grupowanie (groupBy)">
          <select className={inputCls} value={m.groupBy} onChange={(e) => setM({ ...m, groupBy: e.target.value as Mapping['groupBy'] })}>
            <option value="none">none — grupy kontaktowe z panelu BA</option>
            <option value="building">building — po budynku/ulicy</option>
            <option value="staircase">staircase — po klatce</option>
            <option value="floor">floor — po piętrze</option>
          </select>
        </Field>
        <Field label="Szablon nazwy (displayNameTemplate)">
          <input className={inputCls} value={m.displayNameTemplate} onChange={(e) => setM({ ...m, displayNameTemplate: e.target.value })} />
        </Field>
        <Field label="Szablon numeru lokalu (roomNumberTemplate)">
          <input className={inputCls} value={m.roomNumberTemplate} onChange={(e) => setM({ ...m, roomNumberTemplate: e.target.value })} />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-6 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={m.hideLastName} onChange={(e) => setM({ ...m, hideLastName: e.target.checked })} />
          Ukryj nazwiska
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={m.anonymizeDirectory} onChange={(e) => setM({ ...m, anonymizeDirectory: e.target.checked })} />
          Anonimizuj katalog (tylko „Lokal X")
        </label>
      </div>
      <p className="text-xs text-gray-400 mt-3">
        Dostępne pola szablonów: {'{{lastName}} {{firstName}} {{lastNames}} {{unitNumber}} {{unitId}} {{buildingNumber}} {{staircase}} {{floor}} {{contactGroup}}'}.
        Na ekran domofonu nigdy nie trafiają telefony, e-maile ani wewnętrzne ID GateLynk.
      </p>
      <div className="mt-3">
        <button onClick={save} disabled={busy} className="text-sm px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
          {busy ? 'Zapisywanie…' : 'Zapisz mapowanie'}
        </button>
        <span className="ml-3 text-xs text-gray-400">Efekt sprawdzisz w zakładce „C · Podgląd".</span>
      </div>
    </Card>
  )
}

// ── C · Podgląd ───────────────────────────────────────────────────────────────

function PreviewTab({ deviceId }: { deviceId: number }) {
  const [data, setData] = useState<DirectoryResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    setData(null)
    integratorApi
      .get<DirectoryResponse>(`/integrations/akuvox/devices/${deviceId}/directory`)
      .then((r) => setData(r.data))
      .catch((e) => setErr(e?.response?.data?.message ?? 'Błąd ładowania podglądu'))
  }, [deviceId])

  const filtered = useMemo(() => {
    if (!data) return []
    const q = search.trim().toLowerCase()
    if (!q) return data.entries
    return data.entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (e.roomNumber ?? '').toLowerCase().includes(q) ||
        (e.groupName ?? '').toLowerCase().includes(q) ||
        e.contacts.some((c) => c.phone.toLowerCase().includes(q)),
    )
  }, [data, search])

  if (err) return <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">{err}</div>
  if (!data) return <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">Ładowanie…</div>

  return (
    <Card title={`C · Podgląd — dokładna lista wpisów na ekranie domofonu (${data.count})`}>
      {data.issues.length > 0 && (
        <div className="mb-3 space-y-1">
          {data.issues.map((i, idx) => (
            <div
              key={idx}
              className={`text-xs px-3 py-1.5 rounded border ${
                i.level === 'error' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-amber-50 border-amber-200 text-amber-700'
              }`}
            >
              {i.level === 'error' ? '⛔' : '⚠️'} {i.message}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-3 mb-3">
        <input
          className={`${inputCls} max-w-xs`}
          placeholder="Szukaj: nazwa / lokal / grupa / numer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="text-xs text-gray-400">
          {filtered.length} z {data.count} wpisów · poprawnych: {data.validCount} · checksum {data.directoryChecksum.slice(0, 12)}…
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="px-3 py-2 w-10">#</th>
              <th className="px-3 py-2">Nazwa (ekran)</th>
              <th className="px-3 py-2">Lokal</th>
              <th className="px-3 py-2">Grupa</th>
              <th className="px-3 py-2">Numery (priorytet)</th>
              <th className="px-3 py-2 w-28">externalId</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.externalId} className="border-b border-gray-50 hover:bg-gray-50">
                <td className="px-3 py-2 text-gray-400 text-xs">{e.userId}</td>
                <td className="px-3 py-2 font-medium text-gray-900">{e.name}</td>
                <td className="px-3 py-2 text-gray-600">{e.roomNumber ?? '—'}</td>
                <td className="px-3 py-2 text-gray-600">{e.groupName ?? '—'}</td>
                <td className="px-3 py-2 text-gray-600 font-mono text-xs">
                  {e.contacts.map((c) => `${c.phone} (${c.priority}/${c.dialAccount})`).join(', ')}
                </td>
                <td className="px-3 py-2 text-gray-400 font-mono text-xs">{e.externalId}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="text-center text-sm text-gray-400 py-6">Brak wpisów</div>}
      </div>
    </Card>
  )
}

// ── D · Różnice (pełny widok, Etap 2) ─────────────────────────────────────────

const OP_LABELS: Record<string, { label: string; cls: string }> = {
  create: { label: 'DODANE', cls: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
  update: { label: 'ZMIENIONE', cls: 'bg-blue-50 border-blue-200 text-blue-700' },
  disable: { label: 'WYŁĄCZANE', cls: 'bg-amber-50 border-amber-200 text-amber-700' },
  delete: { label: 'USUWANE', cls: 'bg-rose-50 border-rose-200 text-rose-700' },
}

function DiffTab({ deviceId }: { deviceId: number }) {
  const [data, setData] = useState<PreviewResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Guard na podwójne wywołanie useEffect (React StrictMode w dev) — drugi
  // równoległy POST odbiłby się od blokady synchronizacji per urządzenie (409).
  const inFlight = useRef(false)

  const load = useCallback(() => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setErr(null)
    integratorApi
      .post<PreviewResult>(`/integrations/akuvox/devices/${deviceId}/directory/sync/preview`)
      .then((r) => setData(r.data))
      .catch((e) => setErr(e?.response?.data?.message ?? 'Błąd porównania'))
      .finally(() => {
        inFlight.current = false
        setBusy(false)
      })
  }, [deviceId])

  useEffect(() => {
    load()
  }, [load])

  if (err) return <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">{err}</div>
  if (!data)
    return <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">Porównywanie…</div>

  return (
    <Card title="D · Różnice — katalog GateLynk vs stan urządzenia (dry-run, nic nie zmienia)">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <button
          onClick={load}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
        >
          {busy ? 'Porównywanie…' : '↻ Odśwież porównanie'}
        </button>
        <div className="flex flex-wrap gap-2 text-xs">
          <SummaryBadge label="Nowe" value={data.summary.create} cls="bg-emerald-50 border-emerald-200 text-emerald-700" />
          <SummaryBadge label="Zmienione" value={data.summary.update} cls="bg-blue-50 border-blue-200 text-blue-700" />
          <SummaryBadge label="Wyłączane" value={data.summary.disable} cls="bg-amber-50 border-amber-200 text-amber-700" />
          <SummaryBadge label="Usuwane" value={data.summary.delete} cls="bg-rose-50 border-rose-200 text-rose-700" />
          <SummaryBadge label="Bez zmian" value={data.summary.unchanged} cls="bg-gray-50 border-gray-200 text-gray-600" />
          <SummaryBadge label="Konflikty" value={data.summary.conflicts} cls="bg-purple-50 border-purple-200 text-purple-700" />
          <SummaryBadge label="Obce zachowane" value={data.preservedForeignCount} cls="bg-gray-50 border-gray-200 text-gray-600" />
        </div>
      </div>

      {data.comparedFields.length > 0 && (
        <p className="text-xs text-gray-400 mb-2">
          Porównywane pola (wg template'a formatu): {data.comparedFields.join(', ')} — pola nieprzenoszone
          przez format nie generują fałszywych różnic.
        </p>
      )}

      {data.errors.map((e, i) => (
        <div key={i} className="text-xs px-3 py-1.5 rounded border bg-red-50 border-red-200 text-red-700 mb-1">⛔ {e}</div>
      ))}
      {data.warnings.map((w, i) => (
        <div key={i} className="text-xs px-3 py-1.5 rounded border bg-amber-50 border-amber-200 text-amber-700 mb-1">⚠️ {w}</div>
      ))}

      {data.changes.length === 0 && data.conflicts.length === 0 ? (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-4 text-center mt-2">
          ✓ Katalog urządzenia zgodny z GateLynk — brak różnic.
        </div>
      ) : (
        <div className="mt-2 border border-gray-100 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr className="text-left font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2 w-28">Operacja</th>
                <th className="px-3 py-2">Wpis</th>
                <th className="px-3 py-2">Szczegóły (przed → po)</th>
              </tr>
            </thead>
            <tbody>
              {data.changes.map((c, i) => (
                <tr key={i} className="border-b border-gray-50 align-top">
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded border ${OP_LABELS[c.op]?.cls ?? ''}`}>
                      {OP_LABELS[c.op]?.label ?? c.op}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900">{c.name}</div>
                    {c.externalId && <div className="text-gray-400 font-mono">{c.externalId}</div>}
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {c.fields && c.fields.length > 0 ? (
                      c.fields.map((f, j) => (
                        <div key={j}>
                          <span className="text-gray-400">{f.field}:</span> &quot;{f.before}&quot; → <span className="font-medium text-gray-900">&quot;{f.after}&quot;</span>
                        </div>
                      ))
                    ) : (
                      (c.detail ?? '—')
                    )}
                  </td>
                </tr>
              ))}
              {data.conflicts.map((c, i) => (
                <tr key={`c${i}`} className="border-b border-gray-50 align-top bg-purple-50/40">
                  <td className="px-3 py-2">
                    <span className="px-1.5 py-0.5 rounded border bg-purple-50 border-purple-200 text-purple-700">KONFLIKT</span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900">{c.desiredName ?? c.currentName ?? c.key}</div>
                    {c.currentManagedBy && <div className="text-gray-400">zarządzany przez: {c.currentManagedBy}</div>}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-xs text-gray-400 mt-2">Checksum katalogu GateLynk: {data.directoryChecksum}</div>
    </Card>
  )
}

// ── F · Historia (pełny widok, Etap 2) ────────────────────────────────────────

const KIND_LABELS: Record<string, string> = {
  PREVIEW: 'Dry-run',
  EXPORT: 'Eksport pliku',
  APPLY: 'Import potwierdzony',
  TEMPLATE_UPLOAD: 'Template wgrany',
  DEVICE_EXPORT_UPLOAD: 'Eksport z urządzenia',
  MIGRATION: 'Migracja legacy→v2',
  PROVISION_FETCH: 'Pobranie provisioning',
}

function HistoryTab({ device }: { device: AkuvoxDeviceRow }) {
  const [runs, setRuns] = useState<SyncRun[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [kindFilter, setKindFilter] = useState<string>('ALL')

  useEffect(() => {
    setRuns(null)
    integratorApi
      .get<SyncRun[]>(`/integrations/akuvox/devices/${device.id}/directory/sync/history?limit=100`)
      .then((r) => setRuns(r.data))
      .catch((e) => setErr(e?.response?.data?.message ?? 'Błąd ładowania historii'))
  }, [device.id])

  if (err) return <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2 rounded-lg">{err}</div>
  if (!runs)
    return <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-400 text-sm">Ładowanie…</div>

  const kinds = ['ALL', ...new Set(runs.map((r) => r.kind))]
  const filtered = kindFilter === 'ALL' ? runs : runs.filter((r) => r.kind === kindFilter)
  const changeCount = (s: SyncRun['summary']) => (s ? s.create + s.update + s.disable + s.delete : null)

  return (
    <Card title={`F · Historia synchronizacji — ${device.name} (${filtered.length})`}>
      <div className="flex gap-1 mb-3 flex-wrap">
        {kinds.map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            className={`text-xs px-2 py-1 rounded border ${
              kindFilter === k ? 'bg-blue-50 border-blue-300 text-blue-800' : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
          >
            {k === 'ALL' ? 'Wszystkie' : (KIND_LABELS[k] ?? k)}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div className="text-center text-sm text-gray-400 py-6">Brak operacji</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr className="text-left font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2 w-32">Data</th>
                <th className="px-3 py-2">Operacja</th>
                <th className="px-3 py-2 w-24">Wynik</th>
                <th className="px-3 py-2">Operator</th>
                <th className="px-3 py-2 w-20">Zmian</th>
                <th className="px-3 py-2 w-28">Checksum</th>
                <th className="px-3 py-2">Plik</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const hasDetails =
                  (r.errors && r.errors.length > 0) || (r.warnings && r.warnings.length > 0) || r.summary != null
                const isOpen = expandedId === r.id
                return (
                  <>
                    <tr
                      key={r.id}
                      className={`border-b border-gray-50 ${hasDetails ? 'cursor-pointer hover:bg-gray-50' : ''}`}
                      onClick={() => hasDetails && setExpandedId(isOpen ? null : r.id)}
                    >
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                        {new Date(r.createdAt).toLocaleString('pl-PL')}
                      </td>
                      <td className="px-3 py-2 text-gray-900">{KIND_LABELS[r.kind] ?? r.kind}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`px-1.5 py-0.5 rounded border ${
                            r.status === 'OK'
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                              : r.status === 'WARNING'
                                ? 'bg-amber-50 border-amber-200 text-amber-700'
                                : 'bg-rose-50 border-rose-200 text-rose-700'
                          }`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-600">{r.operator ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{changeCount(r.summary) ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-gray-400">
                        {r.directoryChecksum ? `${r.directoryChecksum.slice(0, 10)}…` : '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{r.fileName ?? '—'}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-gray-50/60 border-b border-gray-50">
                        <td colSpan={7} className="px-4 py-2">
                          {r.summary && (
                            <div className="flex flex-wrap gap-2 mb-1">
                              <SummaryBadge label="Nowe" value={r.summary.create} cls="bg-emerald-50 border-emerald-200 text-emerald-700" />
                              <SummaryBadge label="Zmienione" value={r.summary.update} cls="bg-blue-50 border-blue-200 text-blue-700" />
                              <SummaryBadge label="Wyłączane" value={r.summary.disable} cls="bg-amber-50 border-amber-200 text-amber-700" />
                              <SummaryBadge label="Usuwane" value={r.summary.delete} cls="bg-rose-50 border-rose-200 text-rose-700" />
                              <SummaryBadge label="Bez zmian" value={r.summary.unchanged} cls="bg-gray-50 border-gray-200 text-gray-600" />
                              <SummaryBadge label="Konflikty" value={r.summary.conflicts} cls="bg-purple-50 border-purple-200 text-purple-700" />
                            </div>
                          )}
                          {(r.warnings ?? []).map((w, i) => (
                            <div key={i} className="text-amber-700">⚠️ {w}</div>
                          ))}
                          {(r.errors ?? []).map((e, i) => (
                            <div key={i} className="text-rose-700">⛔ {e}</div>
                          ))}
                          {r.directoryChecksum && (
                            <div className="text-gray-400 font-mono mt-1">checksum: {r.directoryChecksum}</div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ── E · Import/Eksport ────────────────────────────────────────────────────────

function ImportExportTab({
  device,
  onChanged,
  showToast,
}: {
  device: AkuvoxDeviceRow
  onChanged: () => void
  showToast: (m: string) => void
}) {
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const apiErr = (err: unknown) =>
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Błąd operacji'

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      showToast(`✗ ${apiErr(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const download = () =>
    run('download', async () => {
      const res = await integratorApi.post(`/integrations/akuvox/devices/${device.id}/directory/sync/export`, null, {
        responseType: 'blob',
      })
      const disposition = (res.headers['content-disposition'] as string | undefined) ?? ''
      const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'GateLynkDirectory'
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showToast(`✓ Pobrano ${fileName}`)
    })

  const upload = (kind: 'template' | 'device-export') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    await run(kind, async () => {
      const fd = new FormData()
      fd.append('file', file)
      const url =
        kind === 'template'
          ? `/integrations/akuvox/devices/${device.id}/directory/template`
          : `/integrations/akuvox/devices/${device.id}/directory/device-export`
      const r = await integratorApi.post(url, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      showToast(
        kind === 'template'
          ? `✓ Template zapisany (format ${(r.data as { format: string }).format})`
          : `✓ Eksport z urządzenia wczytany (${(r.data as { entryCount: number }).entryCount} wpisów)`,
      )
      onChanged()
    })
  }

  const dryRun = () =>
    run('preview', async () => {
      const r = await integratorApi.post<PreviewResult>(`/integrations/akuvox/devices/${device.id}/directory/sync/preview`)
      setPreview(r.data)
    })

  const applyConfirm = () =>
    run('apply', async () => {
      const r = await integratorApi.post(`/integrations/akuvox/devices/${device.id}/directory/sync/apply`)
      showToast(`✓ Import potwierdzony (checksum ${(r.data as { directoryChecksum: string }).directoryChecksum.slice(0, 12)}…)`)
      setPreview(null)
      onChanged()
    })

  return (
    <>
      <Card title="E · Import/Eksport — synchronizacja ręczna (MVP)">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border border-gray-200 rounded-lg p-3">
            <div className="font-medium text-sm text-gray-800 mb-1">1. Template formatu (z urządzenia)</div>
            <p className="text-xs text-gray-500 mb-2">
              Wyeksportuj z urządzenia przykładowy plik użytkowników i wgraj go tutaj — GateLynk nauczy się
              formatu ({device.model ?? '?'} / fw {device.firmwareVersion ?? '?'}). Adapter „directory-user" bez
              template'a odmawia generacji.
            </p>
            <label className="inline-block text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 cursor-pointer">
              {busy === 'template' ? 'Wgrywanie…' : '📤 Wgraj template'}
              <input type="file" className="hidden" accept=".tgz,.gz,.xml,.csv" onChange={upload('template')} disabled={busy !== null} />
            </label>
          </div>

          <div className="border border-gray-200 rounded-lg p-3">
            <div className="font-medium text-sm text-gray-800 mb-1">2. Eksport bieżącego katalogu z urządzenia</div>
            <p className="text-xs text-gray-500 mb-2">
              Wgraj aktualny eksport z urządzenia — baza porównań (chroni kontakty lokalne/SmartPlus przed
              nadpisaniem).{' '}
              {device.deviceSnapshotEntryCount != null
                ? `Ostatni: ${device.deviceSnapshotEntryCount} wpisów (${device.deviceSnapshotTakenAt ? new Date(device.deviceSnapshotTakenAt).toLocaleString('pl-PL') : ''}).`
                : 'Jeszcze nie wgrano.'}
            </p>
            <label className="inline-block text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 cursor-pointer">
              {busy === 'device-export' ? 'Wgrywanie…' : '📥 Wgraj eksport z urządzenia'}
              <input type="file" className="hidden" accept=".tgz,.gz,.xml,.csv" onChange={upload('device-export')} disabled={busy !== null} />
            </label>
          </div>

          <div className="border border-gray-200 rounded-lg p-3">
            <div className="font-medium text-sm text-gray-800 mb-1">3. Sprawdź zgodność (dry-run)</div>
            <p className="text-xs text-gray-500 mb-2">
              Porównanie katalogu GateLynk ze stanem urządzenia — bez generowania pliku i bez zmian.
            </p>
            <button onClick={dryRun} disabled={busy !== null} className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
              {busy === 'preview' ? 'Porównywanie…' : '🔍 Sprawdź zgodność (dry-run)'}
            </button>
          </div>

          <div className="border border-gray-200 rounded-lg p-3">
            <div className="font-medium text-sm text-gray-800 mb-1">4. Wygeneruj i pobierz plik importu</div>
            <p className="text-xs text-gray-500 mb-2">
              Plik w formacie template'a ({device.adapter}); import wykonujesz ręcznie w web UI urządzenia,
              a potem potwierdzasz poniżej.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={download} disabled={busy !== null} className="text-sm px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                {busy === 'download' ? 'Generowanie…' : '⬇️ Pobierz plik importu'}
              </button>
              <button onClick={applyConfirm} disabled={busy !== null} className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                {busy === 'apply' ? 'Zapisywanie…' : '✓ Potwierdź wykonany import'}
              </button>
            </div>
          </div>
        </div>
      </Card>

      {preview && (
        <Card title="Wynik dry-run (podgląd zmian — nic nie zostało zapisane)">
          <div className="flex flex-wrap gap-2 mb-3 text-xs">
            <SummaryBadge label="Nowe" value={preview.summary.create} cls="bg-emerald-50 border-emerald-200 text-emerald-700" />
            <SummaryBadge label="Zmienione" value={preview.summary.update} cls="bg-blue-50 border-blue-200 text-blue-700" />
            <SummaryBadge label="Wyłączane" value={preview.summary.disable} cls="bg-amber-50 border-amber-200 text-amber-700" />
            <SummaryBadge label="Usuwane" value={preview.summary.delete} cls="bg-rose-50 border-rose-200 text-rose-700" />
            <SummaryBadge label="Bez zmian" value={preview.summary.unchanged} cls="bg-gray-50 border-gray-200 text-gray-600" />
            <SummaryBadge label="Konflikty" value={preview.summary.conflicts} cls="bg-purple-50 border-purple-200 text-purple-700" />
          </div>
          {preview.errors.map((e, i) => (
            <div key={i} className="text-xs px-3 py-1.5 rounded border bg-red-50 border-red-200 text-red-700 mb-1">⛔ {e}</div>
          ))}
          {preview.warnings.map((w, i) => (
            <div key={i} className="text-xs px-3 py-1.5 rounded border bg-amber-50 border-amber-200 text-amber-700 mb-1">⚠️ {w}</div>
          ))}
          {preview.changes.length > 0 && (
            <div className="mt-2 max-h-64 overflow-y-auto border border-gray-100 rounded-lg">
              <table className="w-full text-xs">
                <tbody>
                  {preview.changes.map((c, i) => (
                    <tr key={i} className="border-b border-gray-50">
                      <td className="px-3 py-1.5 w-20 font-mono">{c.op}</td>
                      <td className="px-3 py-1.5 font-medium text-gray-800">{c.name}</td>
                      <td className="px-3 py-1.5 text-gray-400">{c.detail ?? c.externalId ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="text-xs text-gray-400 mt-2">Checksum katalogu: {preview.directoryChecksum}</div>
        </Card>
      )}
    </>
  )
}

function SummaryBadge({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <span className={`px-2 py-1 rounded border ${cls}`}>
      {label}: <span className="font-semibold">{value}</span>
    </span>
  )
}
