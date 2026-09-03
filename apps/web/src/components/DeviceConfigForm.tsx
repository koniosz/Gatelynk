'use client'
/**
 * Dynamiczny formularz konfiguracji urządzenia (domofon / kamera / LPR / itp.).
 *
 * Renderuje się na podstawie katalogu `@gatelynk/device-drivers`:
 *   • picker producent → model → driver (jeśli kilka driverów na markę),
 *   • pola formularza generowane z `driver.fields` (grupowane po `field.group`),
 *   • walidacja `field.required` + custom `field.validate`,
 *   • dynamiczna widoczność (`field.showWhen`),
 *   • sekcja „Możliwości" pokazująca capability tego drivera.
 *
 * Komponent jest „kontrolowany" — rodzic trzyma `value` i `onChange`. Dzięki
 * temu można go wpiąć w istniejące strony bez ich przepisywania (rodzic
 * nadal odpowiada za POST do API).
 */
import { useMemo } from 'react'
import {
  DRIVERS,
  driversForType,
  driversForManufacturer,
  findDriver,
  manufacturers,
  type DeviceType,
  type DeviceDriver,
  type DriverField,
  type FieldGroup,
} from '@gatelynk/device-drivers'

export interface DeviceConfigValue {
  driverId: string | null
  config: Record<string, unknown>
}

interface DeviceConfigFormProps {
  type: DeviceType
  value: DeviceConfigValue
  onChange: (next: DeviceConfigValue) => void
  /** Wyświetlać sekcję „Zaawansowane" rozwiniętą? */
  showAdvanced?: boolean
}

const GROUP_LABEL: Record<FieldGroup, { title: string; icon: string }> = {
  network:  { title: 'Sieć',                 icon: '🌐' },
  auth:     { title: 'Dane logowania',       icon: '🔑' },
  rtsp:     { title: 'RTSP / Streaming',     icon: '🎥' },
  relays:   { title: 'Przekaźniki',          icon: '⚡' },
  lpr:      { title: 'LPR / ANPR',            icon: '🚗' },
  ai:       { title: 'AI / Analityka',        icon: '🧠' },
  cloud:    { title: 'Chmura (API)',          icon: '☁️' },
  knx:      { title: 'KNX',                   icon: '🏗️' },
  advanced: { title: 'Zaawansowane',          icon: '🛠️' },
}

const GROUP_ORDER: FieldGroup[] = ['network', 'auth', 'rtsp', 'relays', 'lpr', 'cloud', 'knx', 'ai', 'advanced']

export function DeviceConfigForm({ type, value, onChange, showAdvanced = false }: DeviceConfigFormProps) {
  const allDrivers = useMemo(() => driversForType(type), [type])
  const allManufacturers = useMemo(() => manufacturers(type), [type])

  const driver = findDriver(value.driverId)
  const selectedManufacturer = driver?.manufacturer ?? ''
  const driversForMfr = useMemo(
    () => (selectedManufacturer ? driversForManufacturer(type, selectedManufacturer) : []),
    [type, selectedManufacturer],
  )

  // ── Mutators ─────────────────────────────────────────────────────────────
  const setManufacturer = (mfr: string) => {
    const list = driversForManufacturer(type, mfr)
    const newDriver = list[0]
    onChange({
      driverId: newDriver?.id ?? null,
      config: { ...(newDriver?.defaults ?? {}), ...value.config },
    })
  }

  const setDriverId = (id: string) => {
    const newDriver = findDriver(id)
    onChange({
      driverId: id,
      config: { ...(newDriver?.defaults ?? {}), ...value.config },
    })
  }

  const setFieldValue = (key: string, raw: unknown) => {
    onChange({
      driverId: value.driverId,
      config: { ...value.config, [key]: raw },
    })
  }

  // ── Pre-driver pickers (producent + model) ───────────────────────────────
  return (
    <div className="space-y-4">
      <Card icon="📟" title="Urządzenie">
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Producent"
            value={selectedManufacturer}
            onChange={setManufacturer}
            options={[
              { value: '', label: '— wybierz —' },
              ...allManufacturers.map((m) => ({ value: m, label: m })),
            ]}
          />
          {driversForMfr.length > 1 ? (
            <Select
              label="Model / linia produktowa"
              value={value.driverId ?? ''}
              onChange={setDriverId}
              options={driversForMfr.map((d) => ({ value: d.id, label: d.label }))}
            />
          ) : driver ? (
            <Field label="Model / linia produktowa">
              <span className="text-sm text-gray-700 px-3 py-1.5 bg-gray-100 rounded-lg">
                {driver.label}
              </span>
            </Field>
          ) : null}
        </div>

        {driver?.notes ? (
          <p className="text-xs text-gray-500 mt-3 leading-relaxed">{driver.notes}</p>
        ) : null}
      </Card>

      {!driver ? (
        <p className="text-sm text-gray-400 italic">
          Wybierz producenta, aby zobaczyć pola konfiguracyjne.
        </p>
      ) : (
        <DriverFields
          driver={driver}
          config={value.config}
          setFieldValue={setFieldValue}
          showAdvanced={showAdvanced}
        />
      )}

      {driver ? <CapabilitiesPanel driver={driver} /> : null}
    </div>
  )
}

// ── Renderer pól drivera ────────────────────────────────────────────────────

interface DriverFieldsProps {
  driver: DeviceDriver
  config: Record<string, unknown>
  setFieldValue: (key: string, value: unknown) => void
  showAdvanced: boolean
}

function DriverFields({ driver, config, setFieldValue, showAdvanced }: DriverFieldsProps) {
  // Pogrupuj pola
  const grouped = new Map<FieldGroup, DriverField[]>()
  for (const f of driver.fields) {
    if (f.showWhen && !f.showWhen(config)) continue
    const list = grouped.get(f.group) ?? []
    list.push(f)
    grouped.set(f.group, list)
  }

  return (
    <>
      {GROUP_ORDER.filter((g) => grouped.has(g)).map((group) => {
        const meta = GROUP_LABEL[group]
        const fields = grouped.get(group)!
        const collapsed = group === 'advanced' && !showAdvanced
        return (
          <CollapsibleCard
            key={group}
            icon={meta.icon}
            title={meta.title}
            initiallyCollapsed={collapsed}
          >
            <div className="space-y-3">
              {fields.map((f) => (
                <FieldEditor
                  key={f.key}
                  field={f}
                  value={config[f.key]}
                  onChange={(v) => setFieldValue(f.key, v)}
                />
              ))}
            </div>
          </CollapsibleCard>
        )
      })}
    </>
  )
}

// ── Pojedyncze pole ─────────────────────────────────────────────────────────

interface FieldEditorProps {
  field: DriverField
  value: unknown
  onChange: (v: unknown) => void
}

function FieldEditor({ field, value, onChange }: FieldEditorProps) {
  const fullSpan = field.type === 'relays' || field.type === 'textarea'
  return (
    <div className={fullSpan ? '' : ''}>
      <Label htmlFor={field.key} required={field.required}>{field.label}</Label>
      <FieldInput field={field} value={value} onChange={onChange} />
      {field.help ? <p className="text-xs text-gray-400 mt-1 leading-snug">{field.help}</p> : null}
    </div>
  )
}

function FieldInput({ field, value, onChange }: FieldEditorProps) {
  switch (field.type) {
    case 'text':
    case 'password': {
      const stringValue = typeof value === 'string' ? value : ''
      return (
        <input
          id={field.key}
          type={field.type === 'password' ? 'password' : 'text'}
          value={stringValue}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
          autoComplete="off"
        />
      )
    }
    case 'number': {
      const numValue = typeof value === 'number' ? value : (value === '' || value == null ? '' : Number(value))
      return (
        <input
          id={field.key}
          type="number"
          value={numValue === '' || Number.isNaN(numValue) ? '' : numValue}
          min={field.min}
          max={field.max}
          onChange={(e) => {
            const v = e.target.value
            onChange(v === '' ? null : Number(v))
          }}
          className={inputCls}
        />
      )
    }
    case 'boolean': {
      const checked = value === true
      return (
        <label className="inline-flex items-center gap-2 mt-1">
          <input
            id={field.key}
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300"
          />
          <span className="text-sm text-gray-700">{field.placeholder ?? 'Włączone'}</span>
        </label>
      )
    }
    case 'select': {
      return (
        <select
          id={field.key}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )
    }
    case 'textarea': {
      const stringValue = typeof value === 'string' ? value : ''
      return (
        <textarea
          id={field.key}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls + ' min-h-[80px] font-mono text-xs'}
          placeholder={field.placeholder}
        />
      )
    }
    case 'relays': {
      return <RelaysEditor value={value} onChange={onChange} />
    }
  }
}

// ── Edytor listy przekaźników ───────────────────────────────────────────────

interface RelayRow { index: number; name: string }

function RelaysEditor({ value, onChange }: { value: unknown; onChange: (v: RelayRow[]) => void }) {
  const list: RelayRow[] = Array.isArray(value)
    ? (value as Array<Partial<RelayRow>>).map((r, i) => ({
        index: typeof r?.index === 'number' ? r.index : i + 1,
        name: typeof r?.name === 'string' ? r.name : '',
      }))
    : []

  const update = (i: number, patch: Partial<RelayRow>) =>
    onChange(list.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const add = () => onChange([...list, { index: list.length + 1, name: '' }])
  const remove = (i: number) => onChange(list.filter((_, idx) => idx !== i))

  return (
    <div className="space-y-2">
      {list.length === 0 ? (
        <p className="text-sm text-gray-400 italic">Brak przekaźników.</p>
      ) : (
        list.map((r, i) => (
          <div key={i} className="flex gap-2 items-center">
            <input
              type="number"
              value={r.index}
              onChange={(e) => update(i, { index: Number(e.target.value) || 0 })}
              className={inputCls + ' w-16 flex-shrink-0'}
              min={0}
            />
            <input
              type="text"
              value={r.name}
              placeholder="np. Wejście główne, Brama garażowa…"
              onChange={(e) => update(i, { name: e.target.value })}
              className={inputCls}
            />
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-gray-400 hover:text-red-500 text-xl w-6 flex-shrink-0 leading-none"
              aria-label="Usuń"
            >×</button>
          </div>
        ))
      )}
      <button
        type="button"
        onClick={add}
        className="text-sm text-blue-600 hover:text-blue-800 font-medium"
      >+ Dodaj przekaźnik</button>
    </div>
  )
}

// ── Capabilities ────────────────────────────────────────────────────────────

function CapabilitiesPanel({ driver }: { driver: DeviceDriver }) {
  const items: Array<{ key: string; label: string; icon: string }> = [
    { key: 'openDoor',     label: 'Otwieranie drzwi', icon: '🚪' },
    { key: 'snapshot',     label: 'Snapshot HTTP',     icon: '📸' },
    { key: 'mjpeg',        label: 'Live MJPEG',        icon: '🎥' },
    { key: 'restart',      label: 'Zdalny restart',    icon: '🔄' },
    { key: 'lprPushList',  label: 'Lista tablic w kamerze', icon: '📋' },
    { key: 'lprEvents',    label: 'Push eventów ANPR', icon: '📡' },
    { key: 'aiAnalytics',  label: 'AI / analityka',    icon: '🧠' },
  ]
  return (
    <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">🧩 Możliwości tego modelu</h3>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => {
          const has = driver.capabilities.includes(it.key as never)
          return (
            <span
              key={it.key}
              className={`text-xs px-2 py-1 rounded-md border ${
                has
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-white text-gray-400 border-gray-200 line-through'
              }`}
            >
              {it.icon} {it.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ── Helpery prezentacyjne ───────────────────────────────────────────────────

const inputCls =
  'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'

function Card({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <h3 className="font-semibold text-gray-800 mb-3">{icon} {title}</h3>
      {children}
    </div>
  )
}

function CollapsibleCard({
  icon, title, children, initiallyCollapsed,
}: { icon: string; title: string; children: React.ReactNode; initiallyCollapsed: boolean }) {
  // Native <details> — zero state, działa tak samo jak controlled.
  return (
    <details open={!initiallyCollapsed} className="bg-white rounded-xl border border-gray-200 group">
      <summary className="px-5 py-3 font-semibold text-gray-800 cursor-pointer select-none flex items-center justify-between">
        <span>{icon} {title}</span>
        <span className="text-xs text-gray-400 group-open:rotate-180 transition-transform">▼</span>
      </summary>
      <div className="p-5 pt-0">{children}</div>
    </details>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function Label({ children, htmlFor, required }: { children: React.ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs text-gray-600 mb-1">
      {children}
      {required ? <span className="text-red-500 ml-0.5">*</span> : null}
    </label>
  )
}

function Select({
  label, value, onChange, options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div>
      <Label>{label}</Label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

// Eksport również typu `DeviceType` (wygodnie reeksportować, żeby strony nie
// musiały importować z dwóch miejsc).
export type { DeviceType } from '@gatelynk/device-drivers'

// Suppress unused-warning na DRIVERS — chcemy żeby tree-shaker zostawił katalog
// jeśli kiedyś będzie używany inny eksport. Tymczasowo: eksport pomocniczy.
export { DRIVERS }
