/**
 * WizardPage — 5-step kreator dodawania urządzenia.
 *
 * Zastępuje stary `apps/edge/public/wizard.html` (Alpine.js + Tailwind CDN).
 * Wszystkie endpointy backendowe bez zmian:
 *   GET    /devices/drivers[?type=]
 *   POST   /devices/discover                  → { runId }
 *   GET    /devices/discover/:runId           → DiscoveryRunStatus
 *   POST   /devices                           → { deviceId }
 *   PATCH  /devices/:id
 *   POST   /devices/:id/test-matrix
 *
 * Stan trzymany w pamięci. Po Save → user wraca na /ui (lista urządzeń się
 * odświeży przy mount).
 *
 * Deep-link `?type=INTERCOM` — z `AddDeviceMenu` skacze od razu do Step 2.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import {
  Bell, Camera, Car, ArrowUpDown, Lightbulb, Power, Cpu, Search,
  ArrowLeft, ArrowRight, Plus, Trash2, RotateCw, CheckCircle2,
  XCircle, AlertTriangle, Check, RefreshCw, Network,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from '../lib/api'
import { useTranslation } from '../i18n'
import type {
  DeviceType, DeviceConfig, Driver, DriverField, FieldGroup,
  DiscoveryCandidate, TestMatrix,
} from '../lib/types'

// ── Type catalog: ikona + label klucz + driver-search filter ───────────────
const DEVICE_TYPE_ICONS: Record<DeviceType, LucideIcon> = {
  INTERCOM:   Bell,
  CAMERA:     Camera,
  LPR_CAMERA: Car,
  ELEVATOR:   ArrowUpDown,
  LIGHTING:   Lightbulb,
  SWITCH:     Power,
  LAN_SWITCH: Network,
  LOCK:       Power,
  KNX_BRIDGE: Cpu,
  KNX_OBJECT: Cpu,
}

const SHOWN_DEVICE_TYPES: DeviceType[] = [
  'INTERCOM', 'CAMERA', 'LPR_CAMERA', 'ELEVATOR',
  'LIGHTING', 'SWITCH', 'LAN_SWITCH', 'KNX_BRIDGE',
]

type StepNum = 1 | 2 | 3 | 4 | 5

export function WizardPage() {
  const { t } = useTranslation()
  const [, setLocation] = useLocation()

  // ── State ─────────────────────────────────────────────────────────────
  const [step, setStep] = useState<StepNum>(1)
  const [selectedType, setSelectedType] = useState<DeviceType | null>(null)
  const [availableDrivers, setAvailableDrivers] = useState<Driver[]>([])
  const [discoveryRunning, setDiscoveryRunning] = useState(false)
  const [discoveryDone, setDiscoveryDone] = useState(false)
  const [discoveryProgress, setDiscoveryProgress] = useState(0)
  const [discoveryCandidates, setDiscoveryCandidates] = useState<DiscoveryCandidate[]>([])
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null)
  const [config, setConfig] = useState<DeviceConfig>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [testMatrix, setTestMatrix] = useState<TestMatrix | null>(null)
  const [testRunning, setTestRunning] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Deep-link `?type=...` ─────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const initialType = params.get('type') as DeviceType | null
    if (initialType && SHOWN_DEVICE_TYPES.includes(initialType)) {
      handleSelectType(initialType, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Computed ──────────────────────────────────────────────────────────
  const candidatesForType = useMemo(() => {
    if (!selectedType) return []
    return discoveryCandidates.filter((c) => c.suggestedType === selectedType || !c.suggestedType)
  }, [discoveryCandidates, selectedType])

  const otherCandidates = useMemo(() => {
    if (!selectedType) return []
    return discoveryCandidates.filter((c) => c.suggestedType && c.suggestedType !== selectedType)
  }, [discoveryCandidates, selectedType])

  const fieldsByGroup = useMemo(() => {
    if (!selectedDriver) return {} as Record<FieldGroup, DriverField[]>
    const map: Partial<Record<FieldGroup, DriverField[]>> = {}

    // Syntetyczne pole „Model" — wstrzykiwane dla KAŻDEGO sterownika, zamiast
    // dopisywania go ręcznie do `fields` w katalogu. Od modelu zależą ścieżki
    // API i obejścia firmware, więc instalator musi go widzieć i móc zmienić.
    const models = selectedDriver.models ?? []
    if (models.length) {
      const opts = models.map((m) => ({ value: m, label: m }))
      const current = (config as any).model
      // Model z discovery bywa spoza katalogu (nowa rewizja) — dokładamy go,
      // żeby wybór z listy go nie skasował.
      if (current && !models.includes(current)) {
        opts.unshift({ value: current, label: `${current} (wykryty)` })
      }
      map['device' as FieldGroup] = [{
        key: 'model',
        label: 'Model urządzenia',
        type: 'select',
        group: 'device' as FieldGroup,
        required: true,
        options: opts,
        help: 'Warianty różniące się sufiksem (np. „/P" = odczyt tablic) to RÓŻNE urządzenia.',
      } as unknown as DriverField]
    }

    for (const f of selectedDriver.fields) {
      const g = f.group || 'advanced'
      if (!map[g]) map[g] = []
      map[g]!.push(f)
    }
    return map as Record<FieldGroup, DriverField[]>
  }, [selectedDriver, config])

  const visibleGroups: FieldGroup[] = useMemo(() => {
    const order: FieldGroup[] = ['device' as FieldGroup, 'network', 'auth', 'rtsp', 'relays', 'lpr', 'cloud', 'knx', 'ai', 'advanced']
    return order.filter((g) => fieldsByGroup[g]?.length > 0)
  }, [fieldsByGroup])

  const canProceed = useMemo(() => {
    if (step === 1) return !!selectedType
    if (step === 2) return !!selectedDriver
    if (step === 3) return validateConfig(false)
    if (step === 4) return true
    if (step === 5) return !!(config.name ?? '').trim()
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectedType, selectedDriver, config])

  // ── Step 1 → Step 2: load drivers for selected type ───────────────────
  async function handleSelectType(type: DeviceType, autoAdvance = false) {
    setSelectedType(type)
    setError(null)
    try {
      const drivers = await api.listDrivers(type)
      setAvailableDrivers(drivers)
      if (autoAdvance) setStep(2)
    } catch (err: any) {
      setError(t('wizard.error.driverCatalog') + ': ' + (err?.message ?? err))
    }
  }

  // ── Step 2: discovery scan ────────────────────────────────────────────
  async function startDiscovery() {
    setDiscoveryRunning(true)
    setDiscoveryDone(false)
    setDiscoveryProgress(0)
    setDiscoveryCandidates([])
    setError(null)

    let progressTimer: ReturnType<typeof setInterval> | null = null
    try {
      const { runId } = await api.startDiscovery({ protocols: ['mdns', 'knxnet-ip'], timeoutMs: 15000 })
      const startedAt = Date.now()
      progressTimer = setInterval(() => {
        const elapsed = Date.now() - startedAt
        setDiscoveryProgress(Math.min(98, Math.round((elapsed / 15000) * 100)))
      }, 300)

      let result
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        result = await api.getDiscoveryRun(runId)
        if (result.status === 'done') break
      }
      if (progressTimer) clearInterval(progressTimer)
      setDiscoveryProgress(100)
      setDiscoveryCandidates(result?.candidates ?? [])
      setDiscoveryDone(true)
    } catch (err: any) {
      setError(t('wizard.error.scan') + ': ' + (err?.message ?? err))
    } finally {
      if (progressTimer) clearInterval(progressTimer)
      setDiscoveryRunning(false)
    }
  }

  // ── Step 2: pick candidate / manual driver ─────────────────────────────
  async function pickCandidate(c: DiscoveryCandidate) {
    if (c.suggestedDriverId) await loadDriver(c.suggestedDriverId)
    const next: DeviceConfig = { ...config }
    if (c.ip) next.ipAddress = c.ip
    if (c.port && next.httpPort === undefined) next.httpPort = c.port
    if (c.mac) next.mac = c.mac
    if (c.friendlyName && !next.name) next.name = c.friendlyName
    setConfig(next)
    setStep(3)
  }

  async function pickManualDriver(driverId: string) {
    await loadDriver(driverId)
  }

  async function loadDriver(driverId: string) {
    let driver = availableDrivers.find((d) => d.id === driverId) ?? null
    if (!driver) {
      try {
        const all = await api.listDrivers()
        driver = all.find((d) => d.id === driverId) ?? null
      } catch { /* ignore */ }
    }
    if (!driver) return
    setSelectedDriver(driver)
    setConfig((prev) => {
      const next: DeviceConfig = {
        ...(driver!.defaults ?? {}),
        ...prev,
        driverId,
        manufacturer: driver!.manufacturer,
      }
      // NIE wybieramy modelu za instalatora — patrz syntetyczne pole „model"
      // w `fieldsByGroup`. Wcześniej wpadał tu po cichu `models[0]`, przez co
      // kamery DS-2CD4A26FWD-IZS/P zapisały się jako iDS-TCM403-AI (VN 2026-08-07).
      // Model wykryty przez discovery zostaje — jest wiarygodny.
      return next
    })
  }

  // ── Step 3: form helpers ──────────────────────────────────────────────
  function setField(key: string, value: any) {
    setConfig((prev) => ({ ...prev, [key]: value }))
    setFieldErrors((prev) => {
      const { [key]: _, ...rest } = prev
      return rest
    })
  }

  function addRelay() {
    setConfig((prev) => {
      const relays = prev.relays ?? []
      return { ...prev, relays: [...relays, { index: relays.length + 1, name: '' }] }
    })
  }

  function updateRelay(i: number, field: 'index' | 'name', value: any) {
    setConfig((prev) => {
      const relays = [...(prev.relays ?? [])]
      relays[i] = { ...relays[i], [field]: value }
      return { ...prev, relays }
    })
  }

  function removeRelay(i: number) {
    setConfig((prev) => {
      const relays = (prev.relays ?? []).filter((_, idx) => idx !== i)
      return { ...prev, relays }
    })
  }

  function validateConfig(commit = true): boolean {
    if (!selectedDriver) return false
    const errors: Record<string, string> = {}
    for (const f of selectedDriver.fields) {
      const v = (config as any)[f.key]
      if (f.required && (v === undefined || v === null || v === '')) {
        errors[f.key] = t('wizard.field.required')
      }
    }
    if (commit) setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  // ── Step 4: run test matrix ───────────────────────────────────────────
  async function runTest() {
    if (!deviceId) {
      setError('Brak deviceId — zapisz device najpierw')
      return
    }
    setTestRunning(true)
    setTestMatrix(null)
    try {
      const matrix = await api.testMatrix(deviceId)
      setTestMatrix(matrix)
    } catch (err: any) {
      setError(t('wizard.error.test') + ': ' + (err?.message ?? err))
    } finally {
      setTestRunning(false)
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────
  async function handleNext() {
    setError(null)
    if (step === 3) {
      if (!validateConfig()) return
      await saveDeviceDraft()
      return
    }
    if (step === 5) {
      await saveDeviceFinal()
      return
    }
    setStep((step + 1) as StepNum)
  }

  function handleBack() {
    if (step > 1) setStep((step - 1) as StepNum)
  }

  async function saveDeviceDraft() {
    if (!selectedType) return
    setSaving(true)
    try {
      if (deviceId) {
        await api.updateDevice(deviceId, { type: selectedType, config })
      } else {
        const created = await api.createDevice({ type: selectedType, config })
        setDeviceId(created.deviceId)
      }
      setStep(4)
      setTimeout(() => runTest(), 100)
    } catch (err: any) {
      setError(t('wizard.error.save') + ': ' + (err?.message ?? err))
    } finally {
      setSaving(false)
    }
  }

  async function saveDeviceFinal() {
    if (!deviceId || !selectedType) {
      setError('Brak deviceId')
      return
    }
    setSaving(true)
    try {
      await api.updateDevice(deviceId, { type: selectedType, config })
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(t('wizard.error.save') + ': ' + (err?.message ?? err))
    } finally {
      setSaving(false)
    }
  }

  function resetWizard() {
    setStep(1)
    setSelectedType(null)
    setAvailableDrivers([])
    setDiscoveryRunning(false)
    setDiscoveryDone(false)
    setDiscoveryProgress(0)
    setDiscoveryCandidates([])
    setSelectedDriver(null)
    setConfig({})
    setFieldErrors({})
    setDeviceId(null)
    setTestMatrix(null)
    setSavedAt(null)
    setError(null)
  }

  // ── Render ────────────────────────────────────────────────────────────
  const stepTitles: Record<StepNum, string> = {
    1: t('wizard.step.1'),
    2: t('wizard.step.2'),
    3: t('wizard.step.3'),
    4: t('wizard.step.4'),
    5: t('wizard.step.5'),
  }

  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        marginBottom: 16, gap: 16, flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>
            {t('wizard.title')}
          </h1>
          <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            {t('wizard.subtitle', { step: String(step), total: '5', title: stepTitles[step] })}
          </p>
        </div>
        <button className="btn" onClick={() => setLocation('/')}>
          <ArrowLeft size={14} />
          {t('wizard.backToPanel')}
        </button>
      </div>

      {/* Step pills */}
      <StepPills step={step} t={t} />

      {/* Step content */}
      {step === 1 && (
        <Step1Type
          t={t}
          selectedType={selectedType}
          onSelect={(type) => handleSelectType(type)}
        />
      )}

      {step === 2 && (
        <Step2Discovery
          t={t}
          selectedType={selectedType}
          availableDrivers={availableDrivers}
          discoveryRunning={discoveryRunning}
          discoveryDone={discoveryDone}
          discoveryProgress={discoveryProgress}
          allCandidates={discoveryCandidates}
          candidatesForType={candidatesForType}
          otherCandidates={otherCandidates}
          startDiscovery={startDiscovery}
          pickCandidate={pickCandidate}
          pickManualDriver={pickManualDriver}
          selectedDriverId={selectedDriver?.id ?? null}
        />
      )}

      {step === 3 && selectedDriver && (
        <Step3Config
          t={t}
          driver={selectedDriver}
          config={config}
          fieldErrors={fieldErrors}
          visibleGroups={visibleGroups}
          fieldsByGroup={fieldsByGroup}
          onSetField={setField}
          onAddRelay={addRelay}
          onUpdateRelay={updateRelay}
          onRemoveRelay={removeRelay}
        />
      )}

      {step === 4 && (
        <Step4Test
          t={t}
          testMatrix={testMatrix}
          testRunning={testRunning}
          onRun={runTest}
        />
      )}

      {step === 5 && (
        <Step5Save
          t={t}
          config={config}
          savedAt={savedAt}
          deviceId={deviceId}
          onSetName={(name) => setField('name', name)}
          onGoToPanel={() => setLocation('/')}
          onResetWizard={resetWizard}
        />
      )}

      {/* Footer */}
      {!savedAt && (
        <div style={{
          marginTop: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, flexWrap: 'wrap',
        }}>
          <button className="btn" onClick={handleBack} disabled={step <= 1}>
            <ArrowLeft size={14} />
            {t('wizard.prev')}
          </button>
          {error && (
            <div style={{ color: 'var(--red)', fontSize: 12, flex: 1, textAlign: 'center' }}>
              {error}
            </div>
          )}
          <button className="btn btn-primary" onClick={handleNext} disabled={!canProceed || saving}>
            {saving ? <RotateCw size={14} className="spin" /> : null}
            {step === 5 ? t('wizard.finish') : t('wizard.next')}
            {!saving && <ArrowRight size={14} />}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Step Pills ─────────────────────────────────────────────────────────────

function StepPills({ step, t }: { step: StepNum; t: (k: string) => string }) {
  const labels = [
    t('wizard.pill.1'),
    t('wizard.pill.2'),
    t('wizard.pill.3'),
    t('wizard.pill.4'),
    t('wizard.pill.5'),
  ]
  return (
    <div style={{
      display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap',
    }}>
      {labels.map((label, i) => {
        const n = (i + 1) as StepNum
        const isActive = step === n
        const isDone = step > n
        return (
          <div
            key={n}
            style={{
              flex: '1 1 120px',
              padding: '10px 8px',
              textAlign: 'center',
              fontSize: 12,
              fontWeight: isActive ? 600 : 500,
              borderRadius: 'var(--r-2)',
              border: `1px solid ${isActive ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
              background: isActive
                ? 'var(--accent-soft, rgba(37,99,235,0.12))'
                : isDone
                  ? 'var(--success-soft, rgba(34,197,94,0.10))'
                  : 'var(--surface-2)',
              color: isActive ? 'var(--ink)' : isDone ? 'var(--success, #22c55e)' : 'var(--muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            {isDone && <Check size={12} />}
            <span>{i + 1}. {label}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Step 1: Type ───────────────────────────────────────────────────────────

function Step1Type({
  t, selectedType, onSelect,
}: {
  t: (k: string) => string
  selectedType: DeviceType | null
  onSelect: (type: DeviceType) => void
}) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', margin: 0, marginBottom: 4 }}>
        {t('wizard.step1.title')}
      </h2>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 16px 0' }}>
        {t('wizard.step1.hint')}
      </p>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 10,
      }}>
        {SHOWN_DEVICE_TYPES.map((type) => {
          const Icon = DEVICE_TYPE_ICONS[type]
          const isSelected = selectedType === type
          return (
            <button
              key={type}
              onClick={() => onSelect(type)}
              style={{
                background: isSelected ? 'var(--accent-soft, rgba(37,99,235,0.12))' : 'var(--surface-2)',
                border: `2px solid ${isSelected ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
                borderRadius: 'var(--r-2)',
                padding: '18px 12px',
                textAlign: 'center',
                cursor: 'pointer',
                color: 'var(--ink)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                transition: 'border-color 120ms, background 120ms',
              }}
            >
              <Icon size={28} strokeWidth={1.6} style={{ color: isSelected ? 'var(--accent, #2563eb)' : 'var(--ink-2)' }} />
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {t(`wizard.type.${type}.label`)}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                {t(`wizard.type.${type}.desc`)}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}


/**
 * Czy kandydat to kamera ANPR.
 *
 * Adres sprzętowy tego NIE rozróżnia — Hikvision ma wspólny prefiks dla
 * wszystkich kamer. Jedynym sygnałem przed podaniem hasła jest symbol modelu
 * z ogłoszenia w sieci: rodziny `DS-2CD4A..FWD` / `iDS-TCM` / `iDS-2CD7A`,
 * a sufiks `/P` oznacza wariant z odczytem tablic.
 */
function isLprCandidate(c: DiscoveryCandidate): boolean {
  const s = `${(c as any).model ?? ''} ${c.friendlyName ?? ''} ${c.hostname ?? ''}`.toUpperCase()
  return /DS-2CD4A\d{2}FWD|IDS-TCM|IDS-2CD7A|\/P\b/.test(s)
}

/** Dzieli znalezione urządzenia na sekcje widoczne w kreatorze. */
function groupCandidates(all: DiscoveryCandidate[]) {
  const groups = [
    { key: 'INTERCOM',   label: 'Domofony',         icon: '🚪', items: [] as DiscoveryCandidate[] },
    { key: 'LPR_CAMERA', label: 'Kamery LPR',       icon: '🚗', items: [] as DiscoveryCandidate[] },
    { key: 'CAMERA',     label: 'Pozostałe kamery', icon: '📹', items: [] as DiscoveryCandidate[] },
    { key: 'OTHER',      label: 'Inne urządzenia',  icon: '📡', items: [] as DiscoveryCandidate[] },
  ]
  const by = (k: string) => groups.find((g) => g.key === k)!
  for (const c of all) {
    if (c.suggestedType === 'INTERCOM') by('INTERCOM').items.push(c)
    else if (c.suggestedType === 'LPR_CAMERA' || isLprCandidate(c)) by('LPR_CAMERA').items.push(c)
    else if (c.suggestedType === 'CAMERA') by('CAMERA').items.push(c)
    else by('OTHER').items.push(c)
  }
  return groups.filter((g) => g.items.length > 0)
}

// ── Step 2: Discovery ──────────────────────────────────────────────────────

function Step2Discovery({
  t, selectedType, availableDrivers,
  discoveryRunning, discoveryDone, discoveryProgress,
  allCandidates, candidatesForType, otherCandidates,
  startDiscovery, pickCandidate, pickManualDriver, selectedDriverId,
}: {
  t: (k: string, vars?: Record<string, string>) => string
  selectedType: DeviceType | null
  availableDrivers: Driver[]
  discoveryRunning: boolean
  discoveryDone: boolean
  discoveryProgress: number
  allCandidates: DiscoveryCandidate[]
  candidatesForType: DiscoveryCandidate[]
  otherCandidates: DiscoveryCandidate[]
  startDiscovery: () => void
  pickCandidate: (c: DiscoveryCandidate) => void
  pickManualDriver: (id: string) => void
  selectedDriverId: string | null
}) {
  const [showOther, setShowOther] = useState(false)
  const matched = candidatesForType.filter((c) => c.suggestedDriverId).length

  return (
    <div className="card" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', margin: 0, marginBottom: 4 }}>
        {t('wizard.step2.title')}
      </h2>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 16px 0' }}>
        {t('wizard.step2.hint')}
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={startDiscovery} disabled={discoveryRunning}>
          {discoveryRunning ? <RotateCw size={14} className="spin" /> : <Search size={14} />}
          {discoveryRunning ? t('wizard.step2.scanning') : t('wizard.step2.scanBtn')}
        </button>
        {!discoveryRunning && discoveryDone && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {t('wizard.step2.found', {
              total: String(candidatesForType.length + otherCandidates.length),
              matched: String(matched),
            })}
          </span>
        )}
      </div>

      {discoveryRunning && (
        <div style={{
          height: 6, width: '100%',
          background: 'var(--surface-2)',
          borderRadius: 3, overflow: 'hidden', marginBottom: 14,
        }}>
          <div style={{
            height: '100%',
            width: `${discoveryProgress}%`,
            background: 'var(--accent, #2563eb)',
            transition: 'width 0.3s',
          }} />
        </div>
      )}

      {/* Podział na sekcje zamiast jednej płaskiej listy — zgłoszenie Konrada
          2026-08-07: instalator widział wszystko naraz i musiał zgadywać po
          adresie IP, co jest domofonem, a co kamerą. */}
      {groupCandidates(allCandidates).map((g) => (
        <div key={g.key} style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', margin: '0 0 8px 0' }}>
            {g.icon} {g.label}{' '}
            <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({g.items.length})</span>
            {selectedType && g.key !== selectedType && (
              <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 11 }}>
                {' '}— inny typ niż wybrany
              </span>
            )}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {g.items.map((c) => (
              <CandidateRow
                key={`${c.ip}-${c.mac ?? ''}`}
                candidate={c}
                onClick={() => pickCandidate(c)}
                muted={!!selectedType && g.key !== selectedType}
              />
            ))}
          </div>
        </div>
      ))}

      {false && otherCandidates.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setShowOther(!showOther)}
            style={{
              background: 'transparent', border: 'none',
              fontSize: 12, color: 'var(--muted)', cursor: 'pointer',
              padding: 0, display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <span>{showOther ? '▼' : '▶'}</span>
            {t('wizard.step2.otherFound', { count: String(otherCandidates.length) })}
          </button>
          {showOther && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, opacity: 0.65 }}>
              {otherCandidates.map((c) => (
                <CandidateRow key={`${c.ip}-${c.mac ?? ''}`} candidate={c} onClick={() => pickCandidate(c)} muted />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Manual fallback */}
      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', margin: '0 0 8px 0' }}>
          {t('wizard.step2.manualHeader')}
        </h3>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 8,
        }}>
          {availableDrivers.map((d) => (
            <DriverRow
              key={d.id}
              driver={d}
              selected={d.id === selectedDriverId}
              onClick={() => pickManualDriver(d.id)}
              t={t}
            />
          ))}
        </div>
        {availableDrivers.length === 0 && selectedType && (
          <div style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
            {t('wizard.step2.noDrivers')}
          </div>
        )}
      </div>
    </div>
  )
}

function CandidateRow({ candidate, onClick, muted }: { candidate: DiscoveryCandidate; onClick: () => void; muted?: boolean }) {
  const matched = !!candidate.suggestedDriverId
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: 'var(--surface-2)',
        border: `1px solid ${matched ? 'var(--success, #22c55e)' : 'var(--border)'}`,
        borderRadius: 'var(--r-2)',
        padding: '10px 12px',
        textAlign: 'left',
        cursor: 'pointer',
        color: 'var(--ink)',
        opacity: muted ? 0.7 : 1,
      }}
    >
      <div style={{ fontSize: 18 }}>{matched ? '🎯' : '❓'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>
          {candidate.friendlyName || candidate.hostname || candidate.ip}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {candidate.ip}{candidate.port ? `:${candidate.port}` : ''} · {candidate.foundVia}
          {candidate.mac ? ` · ${candidate.mac}` : ''}
        </div>
      </div>
      <span style={{
        fontSize: 10, fontWeight: 600,
        padding: '3px 6px',
        borderRadius: 'var(--r-1)',
        background: matched ? 'var(--success-soft, rgba(34,197,94,0.12))' : 'var(--surface)',
        color: matched ? 'var(--success, #22c55e)' : 'var(--muted)',
        border: '1px solid var(--border)',
      }}>
        {candidate.suggestedDriverId ?? 'wybierz'}
      </span>
    </button>
  )
}

function DriverRow({
  driver, selected, onClick, t,
}: {
  driver: Driver
  selected: boolean
  onClick: () => void
  t: (k: string) => string
}) {
  const cert = driver.certification?.status ?? 'untested'
  const certColors: Record<string, { bg: string; fg: string }> = {
    certified: { bg: 'var(--success-soft, rgba(34,197,94,0.12))', fg: 'var(--success, #22c55e)' },
    beta:      { bg: 'var(--amber-50)', fg: 'var(--amber)' },
    community: { bg: 'var(--accent-soft, rgba(37,99,235,0.12))', fg: 'var(--accent, #2563eb)' },
    untested:  { bg: 'var(--surface)', fg: 'var(--muted)' },
  }
  const c = certColors[cert]
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: selected ? 'var(--accent-soft, rgba(37,99,235,0.12))' : 'var(--surface-2)',
        border: `1px solid ${selected ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
        borderRadius: 'var(--r-2)',
        padding: '10px 12px',
        textAlign: 'left',
        cursor: 'pointer',
        color: 'var(--ink)',
      }}
    >
      <div style={{ fontSize: 18 }}>{driver.icon ?? '⚙️'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 13 }}>
          <span>{driver.label}</span>
          <span style={{
            fontSize: 9, fontWeight: 600,
            padding: '2px 5px',
            borderRadius: 'var(--r-1)',
            background: c.bg,
            color: c.fg,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
          }}>
            {t(`wizard.cert.${cert}`)}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {driver.models.slice(0, 4).join(', ')}
        </div>
      </div>
    </button>
  )
}

// ── Step 3: Dynamic form ───────────────────────────────────────────────────

const GROUP_LABEL_KEYS: Record<FieldGroup, string> = {
  network:  'wizard.group.network',
  auth:     'wizard.group.auth',
  rtsp:     'wizard.group.rtsp',
  relays:   'wizard.group.relays',
  lpr:      'wizard.group.lpr',
  ai:       'wizard.group.ai',
  cloud:    'wizard.group.cloud',
  knx:      'wizard.group.knx',
  advanced: 'wizard.group.advanced',
}

function Step3Config({
  t, driver, config, fieldErrors, visibleGroups, fieldsByGroup,
  onSetField, onAddRelay, onUpdateRelay, onRemoveRelay,
}: {
  t: (k: string) => string
  driver: Driver
  config: DeviceConfig
  fieldErrors: Record<string, string>
  visibleGroups: FieldGroup[]
  fieldsByGroup: Record<FieldGroup, DriverField[]>
  onSetField: (key: string, value: any) => void
  onAddRelay: () => void
  onUpdateRelay: (i: number, key: 'index' | 'name', value: any) => void
  onRemoveRelay: (i: number) => void
}) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', margin: 0, marginBottom: 2 }}>
        {t('wizard.step3.title')} <span style={{ color: 'var(--accent, #2563eb)' }}>{driver.label}</span>
      </h2>
      {driver.notes && (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 16px 0' }}>
          {driver.notes}
        </p>
      )}

      {visibleGroups.map((group) => (
        <fieldset
          key={group}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-2)',
            background: 'var(--surface-2)',
            padding: '12px 16px',
            margin: '0 0 12px 0',
          }}
        >
          <legend style={{
            fontWeight: 700, fontSize: 12,
            color: 'var(--ink)',
            padding: '0 6px',
          }}>
            {t(GROUP_LABEL_KEYS[group])}
          </legend>
          {fieldsByGroup[group].map((field) => (
            <FieldRow
              key={field.key}
              t={t}
              field={field}
              value={(config as any)[field.key]}
              error={fieldErrors[field.key]}
              relays={config.relays}
              onSetField={onSetField}
              onAddRelay={onAddRelay}
              onUpdateRelay={onUpdateRelay}
              onRemoveRelay={onRemoveRelay}
            />
          ))}
        </fieldset>
      ))}
    </div>
  )
}

function FieldRow({
  t, field, value, error, relays,
  onSetField, onAddRelay, onUpdateRelay, onRemoveRelay,
}: {
  t: (k: string) => string
  field: DriverField
  value: any
  error?: string
  relays?: { index: number; name: string }[]
  onSetField: (key: string, value: any) => void
  onAddRelay: () => void
  onUpdateRelay: (i: number, key: 'index' | 'name', value: any) => void
  onRemoveRelay: (i: number) => void
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '7px 10px',
    border: `1px solid ${error ? 'var(--red)' : 'var(--border)'}`,
    background: 'var(--surface)',
    color: 'var(--ink)',
    borderRadius: 'var(--r-2)',
    fontSize: 13,
    fontFamily: 'inherit',
  }

  let control: React.ReactNode
  if (field.type === 'password') {
    control = (
      <input type="password" placeholder={field.placeholder ?? ''}
        value={value ?? ''} onChange={(e) => onSetField(field.key, e.target.value)} style={inputStyle} />
    )
  } else if (field.type === 'number') {
    control = (
      <input type="number" min={field.min} max={field.max}
        value={value ?? ''} onChange={(e) => onSetField(field.key, Number(e.target.value))} style={inputStyle} />
    )
  } else if (field.type === 'select') {
    control = (
      <select value={value ?? field.default ?? ''} onChange={(e) => onSetField(field.key, e.target.value)} style={inputStyle}>
        <option value="">— {t('wizard.field.choose')} —</option>
        {(field.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    )
  } else if (field.type === 'boolean') {
    control = (
      <input type="checkbox" checked={!!(value ?? field.default ?? false)}
        onChange={(e) => onSetField(field.key, e.target.checked)} />
    )
  } else if (field.type === 'textarea') {
    control = (
      <textarea rows={3} placeholder={field.placeholder ?? ''}
        value={value ?? ''} onChange={(e) => onSetField(field.key, e.target.value)} style={inputStyle} />
    )
  } else if (field.type === 'relays') {
    control = (
      <div>
        {(relays ?? []).map((r, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '80px 1fr 36px',
            gap: 6, marginBottom: 6, alignItems: 'center',
          }}>
            <input type="number" min={1} max={8} value={r.index}
              onChange={(e) => onUpdateRelay(i, 'index', Number(e.target.value))}
              style={inputStyle} />
            <input type="text" placeholder={t('wizard.relays.placeholder')} value={r.name}
              onChange={(e) => onUpdateRelay(i, 'name', e.target.value)}
              style={inputStyle} />
            <button type="button" className="btn" onClick={() => onRemoveRelay(i)} title={t('wizard.relays.remove')}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button type="button" className="btn" onClick={onAddRelay}>
          <Plus size={14} />
          {t('wizard.relays.add')}
        </button>
      </div>
    )
  } else {
    // text, mac, group-address, default fallback
    control = (
      <input type="text" placeholder={field.placeholder ?? ''}
        value={value ?? ''} onChange={(e) => onSetField(field.key, e.target.value)} style={inputStyle} />
    )
  }

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '180px 1fr',
      gap: 12, alignItems: 'start', padding: '6px 0',
    }}>
      <label style={{ fontSize: 13, color: 'var(--ink)', paddingTop: 6 }}>
        {field.label}{field.required && <span style={{ color: 'var(--red)' }}> *</span>}
        {field.help && (
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400, marginTop: 2 }}>
            {field.help}
          </div>
        )}
      </label>
      <div>
        {control}
        {error && (
          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{error}</div>
        )}
      </div>
    </div>
  )
}

// ── Step 4: Test matrix ────────────────────────────────────────────────────

function Step4Test({
  t, testMatrix, testRunning, onRun,
}: {
  t: (k: string, vars?: Record<string, string>) => string
  testMatrix: TestMatrix | null
  testRunning: boolean
  onRun: () => void
}) {
  const entries = useMemo(() => buildTestMatrixEntries(testMatrix, t), [testMatrix, t])
  return (
    <div className="card" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', margin: 0, marginBottom: 4 }}>
        {t('wizard.step4.title')}
      </h2>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 16px 0' }}>
        {t('wizard.step4.hint')}
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={onRun} disabled={testRunning}>
          {testRunning ? <RotateCw size={14} className="spin" /> : <Search size={14} />}
          {testRunning ? t('wizard.step4.running') : t('wizard.step4.run')}
        </button>
        {testMatrix && !testRunning && (
          <>
            <button className="btn" onClick={onRun}>
              <RefreshCw size={14} />
              {t('wizard.step4.retry')}
            </button>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {t('wizard.step4.result')}:{' '}
              <strong style={{ color: testMatrix.online ? 'var(--success, #22c55e)' : 'var(--red)' }}>
                {testMatrix.online ? `✓ ${t('wizard.step4.online')}` : `⚠ ${t('wizard.step4.incomplete')}`}
              </strong>
              {' · '}
              {testMatrix.finishedAt - testMatrix.startedAt} ms
            </div>
          </>
        )}
      </div>

      {testMatrix && !testRunning && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {entries.map((entry) => (
            <div key={entry.key} style={{
              display: 'grid', gridTemplateColumns: '24px 200px 1fr',
              gap: 10, alignItems: 'center',
              padding: '8px 12px',
              background: 'var(--surface-2)',
              borderLeft: `3px solid ${entry.statusColor}`,
              borderRadius: 'var(--r-2)',
            }}>
              <entry.Icon size={16} style={{ color: entry.statusColor }} />
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>{entry.label}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{entry.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface TestEntryView {
  key: string
  label: string
  detail: string
  statusColor: string
  Icon: LucideIcon
}

function buildTestMatrixEntries(matrix: TestMatrix | null, t: (k: string) => string): TestEntryView[] {
  if (!matrix) return []
  const labelMap: Record<string, string> = {
    network:     'wizard.test.network',
    auth:        'wizard.test.auth',
    ping:        'wizard.test.ping',
    snapshot:    'wizard.test.snapshot',
    restart:     'wizard.test.restart',
    openDoor:    'wizard.test.openDoor',
    toggle:      'wizard.test.toggle',
    lock:        'wizard.test.lock',
    unlock:      'wizard.test.unlock',
    rtsp:        'wizard.test.rtsp',
    mjpeg:       'wizard.test.mjpeg',
    lprPushList: 'wizard.test.lprPushList',
    lprEvents:   'wizard.test.lprEvents',
  }
  const out: TestEntryView[] = []
  for (const [key, v] of Object.entries(matrix.capabilities ?? {})) {
    if (!v) continue
    let detail = ''
    let statusColor = 'var(--muted)'
    let Icon: LucideIcon = AlertTriangle
    if (v.tested && v.ok) {
      detail = (v.detail ?? '') + (v.latencyMs ? ` (${v.latencyMs} ms)` : '')
      statusColor = 'var(--success, #22c55e)'
      Icon = CheckCircle2
    } else if (v.tested && v.ok === false) {
      detail = v.error || t('wizard.test.error')
      statusColor = 'var(--red)'
      Icon = XCircle
    } else if (v.supported) {
      detail = v.hint || t('wizard.test.manual')
      statusColor = 'var(--amber)'
      Icon = AlertTriangle
    } else {
      continue
    }
    out.push({
      key,
      label: t(labelMap[key] ?? key) || key,
      detail,
      statusColor,
      Icon,
    })
  }
  return out
}

// ── Step 5: Save + final label ─────────────────────────────────────────────

function Step5Save({
  t, config, savedAt, deviceId,
  onSetName, onGoToPanel, onResetWizard,
}: {
  t: (k: string) => string
  config: DeviceConfig
  savedAt: number | null
  deviceId: string | null
  onSetName: (name: string) => void
  onGoToPanel: () => void
  onResetWizard: () => void
}) {
  if (savedAt) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center' }}>
        <CheckCircle2 size={48} style={{ color: 'var(--success, #22c55e)', margin: '0 auto 12px' }} />
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
          {t('wizard.step5.done')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 20 }}>
          deviceId: <code style={{
            fontFamily: '"IBM Plex Mono", monospace',
            background: 'var(--surface-2)',
            padding: '2px 6px', borderRadius: 'var(--r-1)',
          }}>{deviceId}</code>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
          <button className="btn btn-primary" onClick={onGoToPanel}>
            {t('wizard.step5.backToPanel')}
          </button>
          <button className="btn" onClick={onResetWizard}>
            <Plus size={14} />
            {t('wizard.step5.addAnother')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 20 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', margin: 0, marginBottom: 4 }}>
        {t('wizard.step5.title')}
      </h2>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 16px 0' }}>
        {t('wizard.step5.hint')}
      </p>

      <div style={{
        display: 'grid', gridTemplateColumns: '180px 1fr',
        gap: 12, alignItems: 'start', padding: '6px 0',
      }}>
        <label style={{ fontSize: 13, color: 'var(--ink)', paddingTop: 6 }}>
          {t('wizard.step5.nameLabel')} <span style={{ color: 'var(--red)' }}>*</span>
          <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400, marginTop: 2 }}>
            {t('wizard.step5.nameHelp')}
          </div>
        </label>
        <input type="text" placeholder={t('wizard.step5.namePlaceholder')}
          value={config.name ?? ''}
          onChange={(e) => onSetName(e.target.value)}
          style={{
            width: '100%',
            padding: '7px 10px',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--ink)',
            borderRadius: 'var(--r-2)',
            fontSize: 13,
          }}
        />
      </div>
    </div>
  )
}
