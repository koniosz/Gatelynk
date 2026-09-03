/**
 * Access tab — metodologie uwierzytelnienia (nie osobowe dane mieszkańców).
 *
 * Z handoff doc sek. 5:
 *   • Tabela z toggle on/off
 *   • Reguły metodologiczne: „Karty RFID", „Aplikacja mobilna", „Tablice
 *     rejestracyjne", „Kody QR", „PIN", „Tryb nocny"
 *   • Heatmap aktywności tygodnia — pominięto w MVP (sek. 8)
 *
 * Stub: backend `/api/rules` jeszcze nie istnieje. Stan trzymany local + toast
 * przy save. Persystencja w localStorage żeby instalator widział że jego
 * decyzje „pamiętają się" między reloadami.
 */
import { useState, useEffect } from 'react'
import {
  CreditCard, Smartphone, Car, QrCode, KeyRound, Moon,
  Check,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from '../i18n'

/**
 * Definicja reguły = stałe pola (id, ikona, schedule, mock lastUsed) + stan
 * `enabled` (toggled przez usera, persystencja w localStorage).
 *
 * Tłumaczone teksty (name / scope / description) NIE są w obiekcie — caller
 * resolve-uje je z dictionary po `id` (`access.<id>.name` itd.). Wcześniejsza
 * wersja trzymała surowe polskie stringi co psuło PL→EN.
 */
interface AccessRuleDef {
  id: 'rfid' | 'mobile' | 'lpr' | 'qr' | 'pin' | 'night'
  icon: LucideIcon
  defaultEnabled: boolean
  /** Klucz i18n dla harmonogramu (`access.schedule.247`) lub surowy string (godziny). */
  scheduleKey: string
  /** Klucz i18n dla „ostatnio:" — `null` gdy nigdy. Z mocku do czasu wpięcia `/access_events`. */
  lastUsed: { key: 'minAgo' | 'hrAgo' | 'none' | 'never'; n?: number } | null
}

const STORAGE_KEY = 'gle.access.rules'

const RULE_DEFS: AccessRuleDef[] = [
  { id: 'rfid',   icon: CreditCard, defaultEnabled: true,  scheduleKey: 'access.schedule.247',    lastUsed: { key: 'minAgo', n: 12 } },
  { id: 'mobile', icon: Smartphone, defaultEnabled: true,  scheduleKey: 'access.schedule.247',    lastUsed: { key: 'minAgo', n: 3  } },
  { id: 'lpr',    icon: Car,        defaultEnabled: true,  scheduleKey: 'access.schedule.247',    lastUsed: { key: 'minAgo', n: 47 } },
  { id: 'qr',     icon: QrCode,     defaultEnabled: false, scheduleKey: 'access.schedule.manual', lastUsed: { key: 'none' } },
  { id: 'pin',    icon: KeyRound,   defaultEnabled: true,  scheduleKey: 'access.schedule.247',    lastUsed: { key: 'hrAgo', n: 1  } },
  { id: 'night',  icon: Moon,       defaultEnabled: false, scheduleKey: '22:00 – 06:00',           lastUsed: { key: 'never' } },
]

export function AccessPage() {
  // `enabled` state per rule id — stała definicja + tylko boolean dla każdej.
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(RULE_DEFS.map((r) => [r.id, r.defaultEnabled])),
  )
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const { t } = useTranslation()

  // Persystencja w localStorage — backend `/api/rules` to follow-up.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const stored = JSON.parse(raw) as Record<string, boolean>
        setEnabledMap((prev) => ({ ...prev, ...stored }))
      }
    } catch { /* ignore */ }
  }, [])

  const toggle = (id: string) => {
    setEnabledMap((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
    setSavedIds((prev) => new Set(prev).add(id))
    setTimeout(() => {
      setSavedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, 1500)
  }

  const enabledCount = RULE_DEFS.filter((r) => enabledMap[r.id]).length

  /** Renderuje harmonogram: gdy `scheduleKey` istnieje w słowniku → t(), inaczej zwraca raw (np. "22:00 – 06:00"). */
  const renderSchedule = (key: string): string => {
    const translated = t(key)
    return translated === key ? key : translated
  }

  /** Renderuje „ostatnio: …" zgodnie ze stanem mocku. */
  const renderLastUsed = (def: AccessRuleDef['lastUsed']): string => {
    if (!def) return ''
    switch (def.key) {
      case 'minAgo': return t('access.lastUsed.minAgo', { n: def.n ?? 0 })
      case 'hrAgo':  return t('access.lastUsed.hrAgo',  { n: def.n ?? 0 })
      case 'none':   return t('access.lastUsed.none')
      case 'never':  return t('access.lastUsed.never')
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>
          {t('access.title')}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          {t('access.subtitle')}
        </p>
        <p style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 6 }}>
          {t('access.stats', { n: enabledCount, m: RULE_DEFS.length })}
        </p>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {RULE_DEFS.map((rule, i) => {
          const Icon = rule.icon
          const enabled = enabledMap[rule.id]
          const isSaved = savedIds.has(rule.id)
          return (
            <div
              key={rule.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: 16,
                borderBottom: i < RULE_DEFS.length - 1 ? '1px solid var(--border)' : 'none',
                background: enabled ? 'transparent' : 'var(--surface-2)',
                opacity: enabled ? 1 : 0.7,
                transition: 'background 120ms',
              }}
            >
              {/* Icon */}
              <div style={{
                width: 40, height: 40,
                borderRadius: 'var(--r-2)',
                background: enabled ? 'var(--blue-50)' : 'var(--surface-2)',
                border: '1px solid',
                borderColor: enabled ? 'var(--blue)' : 'var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: enabled ? 'var(--blue)' : 'var(--muted-2)',
                flexShrink: 0,
              }}>
                <Icon size={18} strokeWidth={1.8} />
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
                    {t(`access.${rule.id}.name`)}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {t(`access.${rule.id}.scope`)}
                  </span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0 0' }}>
                  {t(`access.${rule.id}.desc`)}
                </p>
                <div style={{
                  display: 'flex',
                  gap: 12,
                  marginTop: 6,
                  fontSize: 11,
                  color: 'var(--muted-2)',
                  fontFamily: '"IBM Plex Mono", monospace',
                }}>
                  <span>{t('access.label.schedule')}: {renderSchedule(rule.scheduleKey)}</span>
                  {rule.lastUsed && <span>{t('access.label.lastUsed')}: {renderLastUsed(rule.lastUsed)}</span>}
                </div>
              </div>

              {/* Toggle + saved indicator */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                {isSaved && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 11, color: 'var(--green)',
                  }}>
                    <Check size={12} />
                    {t('access.label.saved')}
                  </span>
                )}
                <Toggle checked={enabled} onChange={() => toggle(rule.id)} />
              </div>
            </div>
          )
        })}
      </div>

      <div style={{
        marginTop: 16,
        padding: 12,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-3)',
        fontSize: 11,
        color: 'var(--muted)',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
      }}>
        <span style={{ color: 'var(--blue)', flexShrink: 0 }}>ℹ</span>
        <div>{t('access.footer')}</div>
      </div>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      role="switch"
      aria-checked={checked}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        background: checked ? 'var(--blue)' : 'var(--border-strong)',
        border: 'none',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background 120ms',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2,
        left: checked ? 20 : 2,
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: 'white',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)',
        transition: 'left 120ms',
      }} />
    </button>
  )
}
