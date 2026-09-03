/**
 * i18n GateLynk Edge — kontekst + hook `useTranslation()`.
 *
 * Decyzje:
 *  • Bez zewnętrznej zależności (react-i18next). Edge SPA jest świadomie
 *    minimalistyczne, dwa języki nie wymagają biblioteki.
 *  • Język persystowany w localStorage pod `gle.lang` (analogicznie do
 *    `gle.theme`).
 *  • Pierwszy start: `navigator.language` — gdy zaczyna się od `pl`, używamy
 *    `pl`. Inaczej `en`. Instalatorzy w PL zobaczą polski, zagraniczni —
 *    angielski.
 *  • Render-thrash: Context value przepychany przez `useMemo` żeby nie
 *    odpalać re-renderu wszystkich consumerów przy każdej zmianie.
 *  • Interpolation: `{n}` / `{plate}` w stringu — `t('key', { n: 5 })`.
 *
 * Fallback: gdy klucz nie istnieje w wybranym języku → próbujemy w PL →
 * gdy też nie ma → zwracamy surowy klucz. W produkcji każdy missing key
 * widać w UI (`'mojklucz'` zamiast tekstu) i łatwo zauważyć.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { DICTIONARY, type Lang } from './dict'

const STORAGE_KEY = 'gle.lang'

interface LanguageContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  toggle: () => void
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

function detectInitialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'pl' || stored === 'en') return stored
  } catch { /* SSR / privacy mode */ }
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('pl')) {
    return 'pl'
  }
  return 'en'
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, lang) } catch { /* no-op */ }
    document.documentElement.lang = lang
  }, [lang])

  const value = useMemo<LanguageContextValue>(() => ({
    lang,
    setLang: setLangState,
    toggle: () => setLangState((prev) => (prev === 'pl' ? 'en' : 'pl')),
  }), [lang])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used inside <LanguageProvider>')
  return ctx
}

/**
 * Hook do tłumaczeń.
 *
 * Użycie:
 *   const { t } = useTranslation()
 *   <h1>{t('system.title')}</h1>
 *   <p>{t('common.ago_min', { n: 5 })}</p>          // → "5 min ago"
 *   <p>{t('drawer.delete.confirm', { name })}</p>   // → 'Remove device "X"?'
 */
export function useTranslation() {
  const { lang } = useLanguage()
  const t = useMemo(() => {
    const primary = DICTIONARY[lang]
    const fallback = DICTIONARY.pl
    return (key: string, vars?: Record<string, string | number>): string => {
      const raw = primary[key] ?? fallback[key] ?? key
      if (!vars) return raw
      return raw.replace(/\{(\w+)\}/g, (m, k) => {
        return k in vars ? String(vars[k]) : m
      })
    }
  }, [lang])
  return { t, lang }
}
