/**
 * DynamicConfigForm — renderuje formularz z driver-katalogu (`packages/device-drivers`).
 *
 * E-6.3: zastępuje hand-rolled `ConfigTab` w `DeviceDrawer`. Dla każdego pola
 * `DriverField` z `driver.fields[]` rysujemy odpowiedni komponent (`text` →
 * `<input>`, `select` → `<select>`, `boolean` → checkbox, …). Pola są grupowane
 * po `group` (network / auth / rtsp / relays / advanced / …).
 *
 * Reguły:
 *   • Pola `advanced` wstępnie schowane — accordion „Zaawansowane" rozwija je.
 *   • Pola z `showWhen()` filtrujemy na każdy render (dynamic visibility).
 *   • Walidacja per pole — `validate()` zwraca string z błędem.
 *   • Driver-less fallback: gdy `resolveDriver` zwróci `null`, renderujemy
 *     legacy podstawowy form (name/IP/login/password) — żeby starsze configi
 *     z bazy bez `driverId` dało się edytować.
 *   • Pola `repeating-group` (KNX objects) i `discovery-pick` (mDNS button) —
 *     stub-y, real implementacja w wizardzie (TODO E-7+).
 */
import { useMemo, useState } from 'react'
import {
  ChevronDown, ChevronRight, ShieldCheck, AlertTriangle, FlaskConical, Users,
} from 'lucide-react'
import {
  resolveDriverForUI,
  type DeviceDriver, type DriverField, type FieldGroup,
} from '../../lib/drivers'

interface DynamicConfigFormProps {
  type: string                   // DeviceType — INTERCOM / CAMERA / …
  config: Record<string, any>
  onChange: (cfg: Record<string, any>) => void
}

/** Etykiety grup w kolejności wyświetlania. */
const GROUP_ORDER: { id: FieldGroup; label: string }[] = [
  { id: 'network',  label: 'Sieć' },
  { id: 'auth',     label: 'Uwierzytelnienie' },
  { id: 'rtsp',     label: 'RTSP / Streaming' },
  { id: 'relays',   label: 'Przekaźniki' },
  { id: 'lpr',      label: 'LPR / Tablice' },
  { id: 'ai',       label: 'AI / Detekcja' },
  { id: 'cloud',    label: 'Chmura' },
  { id: 'knx',      label: 'KNX' },
  { id: 'advanced', label: 'Zaawansowane' },
]

export function DynamicConfigForm({ type, config, onChange }: DynamicConfigFormProps) {
  const driver = useMemo(() => resolveDriverForUI(type, config), [type, config])
  const [showAdvanced, setShowAdvanced] = useState(false)

  const update = (key: string, value: any) =>
    onChange({ ...config, [key]: value })

  // Driver-less fallback (legacy konfigi w bazie bez driverId i bez wpisu w katalogu)
  if (!driver) {
    return <DriverLessFallback config={config} onChange={onChange} type={type} />
  }

  // Pola pogrupowane po `field.group`. Filtrujemy przez `showWhen` na bieżący config.
  const visibleFields = driver.fields.filter(
    (f) => !f.showWhen || f.showWhen(config),
  )
  const byGroup = new Map<FieldGroup, DriverField[]>()
  for (const f of visibleFields) {
    const list = byGroup.get(f.group) ?? []
    list.push(f)
    byGroup.set(f.group, list)
  }

  return (
    <div>
      {/* Driver header — badge + manufacturer/model */}
      <DriverHeader driver={driver} />

      {/* Grupy pól w kolejności */}
      {GROUP_ORDER.map((group) => {
        const fields = byGroup.get(group.id)
        if (!fields || fields.length === 0) return null

        // „Zaawansowane" jako accordion
        if (group.id === 'advanced') {
          return (
            <AdvancedSection
              key={group.id}
              label={group.label}
              open={showAdvanced}
              onToggle={() => setShowAdvanced(!showAdvanced)}
              fields={fields}
              config={config}
              update={update}
            />
          )
        }

        return (
          <FieldGroupSection key={group.id} label={group.label}>
            {fields.map((f) => (
              <FieldRow key={f.key} field={f} value={config[f.key]} config={config} onChange={(v) => update(f.key, v)} />
            ))}
          </FieldGroupSection>
        )
      })}

      {/* Nazwa wyświetlana — pole stałe, nie z drivera (każde urządzenie ma name). */}
      <FieldGroupSection label="Wyświetlanie">
        <FormField label="Nazwa w panelu" help="Pokazywane w liście urządzeń, sterowaniu i logach.">
          <input
            type="text"
            value={config.name ?? ''}
            onChange={(e) => update('name', e.target.value)}
            placeholder={driver.label}
            className="dc-input"
          />
        </FormField>
      </FieldGroupSection>

      <FormStyles />
    </div>
  )
}

// ── Driver header ─────────────────────────────────────────────────────────

function DriverHeader({ driver }: { driver: DeviceDriver }) {
  const cert = driver.certification?.status ?? 'untested'
  const badge = certBadge(cert)
  return (
    <div style={{
      padding: 12,
      border: '1px solid var(--border)',
      background: 'var(--surface-2)',
      borderRadius: 'var(--r-2)',
      marginBottom: 16,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
          {driver.label}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, fontFamily: '"IBM Plex Mono", monospace' }}>
          driver · {driver.id} · {driver.models.slice(0, 3).join(', ')}
          {driver.models.length > 3 ? `, +${driver.models.length - 3}` : ''}
        </div>
        {driver.notes && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>
            {driver.notes}
          </div>
        )}
      </div>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', borderRadius: 999,
        fontSize: 10, fontWeight: 600,
        background: badge.bg, color: badge.fg, border: `1px solid ${badge.fg}`,
        flexShrink: 0,
      }} title={driver.certification?.knownIssues?.join('; ')}>
        <badge.Icon size={11} />
        {badge.label}
      </span>
    </div>
  )
}

function certBadge(status: 'certified' | 'beta' | 'untested' | 'community') {
  switch (status) {
    case 'certified': return { Icon: ShieldCheck,    label: 'Certyfikowany', bg: 'var(--green-50)', fg: 'var(--green)' }
    case 'beta':      return { Icon: FlaskConical,   label: 'Beta',          bg: 'var(--amber-50)', fg: 'var(--amber)' }
    case 'community': return { Icon: Users,          label: 'Community',     bg: 'var(--blue-50)',  fg: 'var(--blue)'  }
    default:          return { Icon: AlertTriangle,  label: 'Nietestowany',  bg: 'var(--red-50)',   fg: 'var(--red)'   }
  }
}

// ── Field renderer ────────────────────────────────────────────────────────

function FieldRow({ field, value, config, onChange }: {
  field: DriverField
  value: any
  config: Record<string, any>
  onChange: (value: any) => void
}) {
  const err = field.validate?.(value, config)
  const showError = err && (value !== undefined && value !== '' && value !== null)

  return (
    <FormField
      label={field.label + (field.required ? ' *' : '')}
      help={field.help}
      error={showError ? err! : undefined}
    >
      <FieldInput field={field} value={value} onChange={onChange} />
    </FormField>
  )
}

function FieldInput({ field, value, onChange }: {
  field: DriverField
  value: any
  onChange: (value: any) => void
}) {
  switch (field.type) {
    case 'text':
    case 'mac':
    case 'group-address':
      return (
        <input
          type="text"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? (field.default != null ? String(field.default) : '')}
          className={field.type === 'text' ? 'dc-input' : 'dc-input mono'}
        />
      )
    case 'password':
      return (
        <input
          type="password"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? '••••••••'}
          className="dc-input mono"
          autoComplete="new-password"
        />
      )
    case 'textarea':
      return (
        <textarea
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="dc-input mono"
          rows={4}
          style={{ resize: 'vertical', minHeight: 80 }}
        />
      )
    case 'number':
      return (
        <input
          type="number"
          min={field.min} max={field.max}
          value={value ?? ''}
          onChange={(e) => {
            const v = e.target.value
            onChange(v === '' ? undefined : Number(v))
          }}
          placeholder={field.placeholder ?? (field.default != null ? String(field.default) : '')}
          className="dc-input mono"
        />
      )
    case 'select':
      return (
        <select
          value={value ?? field.default ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="dc-input"
        >
          {!field.required && <option value="">— wybierz —</option>}
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      )
    case 'boolean':
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            role="switch"
            aria-checked={!!value}
            onClick={() => onChange(!value)}
            style={{
              width: 40, height: 22, borderRadius: 11,
              background: value ? 'var(--blue)' : 'var(--border-strong)',
              border: 'none', position: 'relative', cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <span style={{
              position: 'absolute', top: 2,
              left: value ? 20 : 2,
              width: 18, height: 18, borderRadius: '50%',
              background: 'white',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              transition: 'left 120ms',
            }} />
          </button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {value ? 'Włączone' : 'Wyłączone'}
          </span>
        </div>
      )
    case 'relays':
      // Edycja w osobnej zakładce „Przekaźniki" — tu read-only summary
      return <RelaysSummary value={value} />
    case 'discovery-pick':
      return (
        <div style={{ fontSize: 12, color: 'var(--muted)', padding: 8, background: 'var(--surface-2)', borderRadius: 'var(--r-2)', border: '1px dashed var(--border-strong)' }}>
          ℹ Discovery (mDNS / scan LAN) — funkcja używana w wizardzie. Tu pole tylko read-only.
          {value && <div className="mono" style={{ marginTop: 4 }}>wybrane: {String(value)}</div>}
        </div>
      )
    case 'repeating-group':
      return (
        <div style={{ fontSize: 12, color: 'var(--muted)', padding: 8, background: 'var(--surface-2)', borderRadius: 'var(--r-2)', border: '1px dashed var(--border-strong)' }}>
          ℹ Lista pod-obiektów (np. KNX objects) — edycja w osobnym widoku (TODO). Liczba wpisów: {Array.isArray(value) ? value.length : 0}.
        </div>
      )
    default:
      return (
        <input
          type="text"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="dc-input"
        />
      )
  }
}

function RelaysSummary({ value }: { value: any }) {
  const relays: Array<{ index: number; name: string }> = Array.isArray(value) ? value : []
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)', padding: 8, background: 'var(--surface-2)', borderRadius: 'var(--r-2)' }}>
      {relays.length === 0
        ? 'Brak skonfigurowanych przekaźników — przejdź do zakładki „Przekaźniki".'
        : `${relays.length} przekaźnik(ów). Edycja w zakładce „Przekaźniki".`}
    </div>
  )
}

// ── Group sections ────────────────────────────────────────────────────────

function FieldGroupSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h3 style={{
        fontSize: 11, fontWeight: 600,
        color: 'var(--muted)',
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        margin: '0 0 10px 0',
      }}>
        {label}
      </h3>
      {children}
    </div>
  )
}

function AdvancedSection({ label, open, onToggle, fields, config, update }: {
  label: string
  open: boolean
  onToggle: () => void
  fields: DriverField[]
  config: Record<string, any>
  update: (k: string, v: any) => void
}) {
  return (
    <div style={{ marginBottom: 18, border: '1px solid var(--border)', borderRadius: 'var(--r-2)' }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          padding: '10px 12px',
          background: 'transparent',
          border: 'none',
          color: 'var(--ink-2)',
          fontSize: 12,
          fontWeight: 500,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {label} ({fields.length})
      </button>
      {open && (
        <div style={{ padding: '4px 12px 12px 12px', borderTop: '1px solid var(--border)' }}>
          {fields.map((f) => (
            <FieldRow key={f.key} field={f} value={config[f.key]} config={config} onChange={(v) => update(f.key, v)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Driver-less fallback (legacy configi) ──────────────────────────────────

function DriverLessFallback({ config, onChange, type }: {
  config: Record<string, any>
  onChange: (cfg: Record<string, any>) => void
  type: string
}) {
  const update = (key: string, value: any) => onChange({ ...config, [key]: value })
  return (
    <div>
      <div style={{
        padding: 10, marginBottom: 12,
        background: 'var(--amber-50)',
        border: '1px solid var(--amber)',
        color: 'var(--amber)',
        borderRadius: 'var(--r-2)',
        fontSize: 12,
      }}>
        ⚠ Brak drivera w katalogu dla {config.manufacturer ?? '?'} {config.model ?? ''} ({type}).
        Pokazuję uproszczony formularz. Aby uzyskać dynamiczny formularz dodaj urządzenie przez wizard.
      </div>

      <FormField label="Nazwa w panelu">
        <input
          type="text"
          value={config.name ?? ''}
          onChange={(e) => update('name', e.target.value)}
          className="dc-input"
        />
      </FormField>
      <FormField label="Adres IP">
        <input
          type="text"
          value={config.ipAddress ?? ''}
          onChange={(e) => update('ipAddress', e.target.value)}
          className="dc-input mono"
        />
      </FormField>
      <FormField label="Login">
        <input
          type="text"
          value={config.login ?? ''}
          onChange={(e) => update('login', e.target.value)}
          className="dc-input mono"
        />
      </FormField>
      <FormField label="Hasło">
        <input
          type="password"
          value={config.password ?? ''}
          onChange={(e) => update('password', e.target.value)}
          className="dc-input mono"
        />
      </FormField>

      <FormStyles />
    </div>
  )
}

// ── Shared primitives ─────────────────────────────────────────────────────

function FormField({ label, help, error, children }: {
  label: string
  help?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{
        display: 'block',
        fontSize: 11, fontWeight: 500,
        color: 'var(--muted)',
        marginBottom: 4,
      }}>
        {label}
      </label>
      {children}
      {help && !error && (
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
          {help}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4, lineHeight: 1.4 }}>
          ✗ {error}
        </div>
      )}
    </div>
  )
}

function FormStyles() {
  return (
    <style>{`
      .dc-input {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--ink);
        border-radius: var(--r-2);
        font-size: 13px;
        font-family: "IBM Plex Sans", sans-serif;
      }
      .dc-input.mono { font-family: "IBM Plex Mono", monospace; }
      .dc-input:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 2px var(--blue-50); }
      select.dc-input { cursor: pointer; }
    `}</style>
  )
}
