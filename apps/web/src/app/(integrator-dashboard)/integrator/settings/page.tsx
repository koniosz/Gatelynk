'use client'
/**
 * SettingsPage (handoff §5 `<SettingsPage>`).
 *
 * Trzy sekcje:
 *   1. Konto integratora — name + company (email read-only, zmiana wymaga osobnego flow)
 *   2. Powiadomienia — preferencje toggle (offline alerts, FW updates, weekly summary, kanały email/push)
 *   3. API tokens — placeholder dla Sesji 4+ (automatyzacja przez API)
 *
 * Backend endpoints (Sesja 3):
 *   - GET    /integrator/me                              → profil
 *   - PUT    /integrator/me                              → update name/company
 *   - GET    /integrator/me/notifications/preferences    → prefs (z defaultami)
 *   - PUT    /integrator/me/notifications/preferences    → update
 */
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  User, Bell, Key, Save, Check, AlertTriangle, Mail, Smartphone, RefreshCw,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from '@/components/integrator/property/shared/Spinner'
import { AuditLogSection } from '@/components/integrator/AuditLogSection'
import { EmailChangeModal } from '@/components/integrator/EmailChangeModal'

interface MeProfile {
  id: number
  name: string
  email: string
  company?: string | null
  createdAt: string
  updatedAt: string
}

interface NotificationPrefs {
  offlineAlerts: boolean
  heartbeatDropAlerts: boolean
  firmwareUpdates: boolean
  emailChannel: boolean
  pushChannel: boolean
  weeklySummary: boolean
}

export default function SettingsPage() {
  const router = useRouter()
  const [me, setMe] = useState<MeProfile | null>(null)
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.all([
      integratorApi.get<MeProfile>('/integrator/me'),
      integratorApi.get<NotificationPrefs>('/integrator/me/notifications/preferences'),
    ])
      .then(([meRes, prefsRes]) => {
        setMe(meRes.data)
        setPrefs(prefsRes.data)
      })
      .catch((err: unknown) => {
        const status = (err as { response?: { status?: number; data?: { message?: string } } })?.response?.status
        if (status === 401) {
          router.push('/integrator/login')
          return
        }
        // Logujemy do konsoli (devtools) + UI pokazuje friendly message zamiast wiecznego spinnera
        // eslint-disable-next-line no-console
        console.error('[SettingsPage] /me fetch failed:', err)
        const apiMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        setError(apiMsg ?? 'Nie udało się załadować ustawień — sprawdź połączenie z API')
      })
      .finally(() => setLoading(false))
  }, [router])

  useEffect(() => { load() }, [load])

  // Reaguj na refresh button z Topbar
  useEffect(() => {
    const onRefresh = () => load()
    window.addEventListener('integrator:refresh', onRefresh)
    return () => window.removeEventListener('integrator:refresh', onRefresh)
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-muted text-[13px]">
        <Spinner size={14} /> Ładowanie ustawień…
      </div>
    )
  }

  if (error || !me || !prefs) {
    return (
      <div className="max-w-3xl mx-auto py-12">
        <div className="bg-danger-50 border border-danger/30 rounded-r3 p-6 text-center">
          <AlertTriangle size={32} strokeWidth={1.5} className="text-danger mx-auto mb-3" />
          <h2 className="text-[14px] font-semibold text-danger mb-1">Nie udało się załadować ustawień</h2>
          <p className="text-[12px] text-danger/80 mb-4">{error ?? 'Brak danych z API'}</p>
          <button
            onClick={load}
            className="inline-flex items-center gap-2 bg-danger text-white text-[13px] font-medium px-4 py-2 rounded-r2 hover:bg-danger/90 transition-colors"
          >
            <RefreshCw size={13} />
            Spróbuj ponownie
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="mb-2">
        <h1 className="text-xl font-semibold text-ink">Ustawienia</h1>
        <p className="text-[13px] text-muted mt-1">
          Konto integratora, powiadomienia, API
        </p>
      </div>

      <ProfileSection me={me} onUpdate={setMe} />
      <NotificationsSection prefs={prefs} onUpdate={setPrefs} />
      <AuditLogSection />
      <ApiTokensPlaceholder />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Konto
// ─────────────────────────────────────────────────────────────────────────────

function ProfileSection({ me, onUpdate }: {
  me: MeProfile
  onUpdate: (m: MeProfile) => void
}) {
  const [name, setName] = useState(me.name)
  const [company, setCompany] = useState(me.company ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emailModalOpen, setEmailModalOpen] = useState(false)

  const hasChanges = name !== me.name || (company || null) !== (me.company || null)

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const r = await integratorApi.put('/integrator/me', { name, company: company || null })
      onUpdate(r.data)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Błąd zapisu'
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionCard icon={User} title="Konto integratora">
      <form onSubmit={handleSave} className="space-y-4">
        <Field label="Imię i nazwisko">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={INPUT_CLS}
            required
          />
        </Field>

        <Field label="Firma" hint="Wyświetlane w karcie integratora w Sidebarze (opcjonalne)">
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className={INPUT_CLS}
            placeholder="np. AlfaSecurity Sp. z o.o."
          />
        </Field>

        <Field label="Email" hint="Email logowania — kliknij Zmień żeby wystartować weryfikację nowego adresu">
          <div className="flex gap-2">
            <input
              value={me.email}
              disabled
              className={`${INPUT_CLS_DISABLED} flex-1`}
            />
            <button
              type="button"
              onClick={() => setEmailModalOpen(true)}
              className="inline-flex items-center gap-1.5 text-[12px] text-brand hover:text-brand-600 border border-brand/30 hover:bg-brand-50 px-3 py-1.5 rounded-r2 font-medium transition-colors flex-shrink-0"
            >
              <Mail size={12} strokeWidth={2} />
              Zmień
            </button>
          </div>
        </Field>

        <div className="flex items-center gap-3 pt-2 border-t border-border">
          <button
            type="submit"
            disabled={!hasChanges || saving}
            className="inline-flex items-center gap-1.5 bg-brand text-white text-[13px] py-2 px-4 rounded-r2 hover:bg-brand-600 disabled:opacity-50 transition-colors font-medium"
          >
            {saving ? <Spinner size={13} className="text-white" /> : <Save size={13} />}
            {saving ? 'Zapisywanie…' : 'Zapisz zmiany'}
          </button>
          {saved && (
            <span className="inline-flex items-center gap-1 text-[12px] text-success font-medium">
              <Check size={13} strokeWidth={2.5} /> Zapisano
            </span>
          )}
          {error && (
            <span className="inline-flex items-center gap-1 text-[12px] text-danger">
              <AlertTriangle size={13} /> {error}
            </span>
          )}
        </div>
      </form>

      <EmailChangeModal
        open={emailModalOpen}
        onClose={() => setEmailModalOpen(false)}
        currentEmail={me.email}
      />
    </SectionCard>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Powiadomienia
// ─────────────────────────────────────────────────────────────────────────────

interface PrefItem {
  key: keyof NotificationPrefs
  label: string
  description: string
  icon: LucideIcon
}

const ALERT_PREFS: PrefItem[] = [
  {
    key: 'offlineAlerts',
    label: 'Edge offline > 5 min',
    description: 'Alert gdy któryś z Edge-y w portfolio rozłączy się dłużej niż 5 minut',
    icon: AlertTriangle,
  },
  {
    key: 'heartbeatDropAlerts',
    label: 'Drop heartbeat',
    description: 'Alert gdy Edge nagle przestaje wysyłać heartbeat (potencjalna awaria sieci)',
    icon: AlertTriangle,
  },
  {
    key: 'firmwareUpdates',
    label: 'Dostępna aktualizacja firmware',
    description: 'Powiadomienie gdy producent wypuści nową wersję firmware dla zarządzanych Edge',
    icon: AlertTriangle,
  },
  {
    key: 'weeklySummary',
    label: 'Tygodniowe podsumowanie',
    description: 'Co poniedziałek o 9:00 — raport: liczba zdarzeń, uptime, alerty, drobne rekomendacje',
    icon: Mail,
  },
]

const CHANNEL_PREFS: PrefItem[] = [
  {
    key: 'emailChannel',
    label: 'Powiadomienia email',
    description: 'Wysyłaj powiadomienia na adres email konta',
    icon: Mail,
  },
  {
    key: 'pushChannel',
    label: 'Push (mobile)',
    description: 'Powiadomienia push w aplikacji mobilnej GateLynk Integrator (wkrótce)',
    icon: Smartphone,
  },
]

function NotificationsSection({ prefs, onUpdate }: {
  prefs: NotificationPrefs
  onUpdate: (p: NotificationPrefs) => void
}) {
  const [saving, setSaving] = useState<keyof NotificationPrefs | null>(null)

  const toggle = async (key: keyof NotificationPrefs) => {
    setSaving(key)
    try {
      const r = await integratorApi.put('/integrator/me/notifications/preferences', {
        [key]: !prefs[key],
      })
      onUpdate(r.data)
    } finally {
      setSaving(null)
    }
  }

  return (
    <SectionCard icon={Bell} title="Powiadomienia">
      <div className="space-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-2 mb-2">
          Alerty
        </h3>
        {ALERT_PREFS.map((pref) => (
          <PrefRow key={pref.key} pref={pref} value={prefs[pref.key]} onToggle={toggle} loading={saving === pref.key} />
        ))}
      </div>

      <div className="mt-6 pt-4 border-t border-border space-y-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-2 mb-2">
          Kanały
        </h3>
        {CHANNEL_PREFS.map((pref) => (
          <PrefRow key={pref.key} pref={pref} value={prefs[pref.key]} onToggle={toggle} loading={saving === pref.key} />
        ))}
      </div>
    </SectionCard>
  )
}

function PrefRow({ pref, value, onToggle, loading }: {
  pref: PrefItem
  value: boolean
  onToggle: (key: keyof NotificationPrefs) => void
  loading: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="flex items-start gap-3 min-w-0">
        <pref.icon size={14} strokeWidth={1.8} className="text-muted-2 flex-shrink-0 mt-0.5" />
        <div>
          <div className="text-[13px] font-medium text-ink">{pref.label}</div>
          <div className="text-[11px] text-muted leading-relaxed">{pref.description}</div>
        </div>
      </div>
      <button
        onClick={() => onToggle(pref.key)}
        disabled={loading}
        role="switch"
        aria-checked={value}
        className={`relative inline-flex items-center w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
          value ? 'bg-brand' : 'bg-border-strong'
        } ${loading ? 'opacity-60' : ''}`}
      >
        <span
          className={`inline-block w-3.5 h-3.5 rounded-full bg-white transform transition-transform shadow-sm ${
            value ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  API tokens (placeholder Sesja 5+)
// ─────────────────────────────────────────────────────────────────────────────

function ApiTokensPlaceholder() {
  return (
    <SectionCard icon={Key} title="API tokens">
      <div className="flex items-start gap-3 py-3 px-4 bg-surface-2 rounded-r2 border border-dashed border-border">
        <Key size={20} strokeWidth={1.5} className="text-muted-2 flex-shrink-0" />
        <div>
          <p className="text-[13px] font-medium text-muted">
            Tokeny dla automatyzacji — wkrótce
          </p>
          <p className="text-[11px] text-muted-2 mt-1 leading-relaxed">
            Możliwość generowania API tokens dla narzędzi DevOps i integracji własnych (Webhook,
            CI/CD pipelines, custom dashboards). Z rate-limiting i audit log.
          </p>
        </div>
      </div>
    </SectionCard>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_CLS = 'w-full border border-border rounded-r2 px-3 py-1.5 text-[13px] bg-surface text-ink focus:outline-none focus:border-brand placeholder:text-muted-2'
const INPUT_CLS_DISABLED = 'w-full border border-border rounded-r2 px-3 py-1.5 text-[13px] bg-surface-2 text-muted cursor-not-allowed'

function SectionCard({ icon: Icon, title, children }: {
  icon: LucideIcon; title: string; children: React.ReactNode
}) {
  return (
    <div className="bg-surface border border-border rounded-r3 overflow-hidden">
      <header className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
        <Icon size={16} strokeWidth={1.8} className="text-ink-2" />
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
      </header>
      <div className="p-5">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-muted-2 mt-1">{hint}</p>}
    </div>
  )
}
