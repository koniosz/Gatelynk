/**
 * LanguageToggle — slider PL / EN w Topbarze.
 *
 * Wizualnie: pigułkowy switch z dwoma etykietami i pływającym tłem podświetlającym
 * aktualnie wybrany język. Klik dowolnej etykiety → natychmiast zmienia język
 * (bez animacji wyboru — ma być instant żeby nie irytować).
 *
 * Decyzja UX (vs jeden „toggle button"):
 *   Pokazujemy oba języki na raz żeby instalator nie musiał zgadywać co kryje
 *   się „za" toggle-em. Dwa stałe widoki PL/EN — wiesz natychmiast co jest
 *   aktywne, a co po kliknięciu.
 */
import { useLanguage } from '../../i18n'

export function LanguageToggle() {
  const { lang, setLang } = useLanguage()

  return (
    <div
      role="group"
      aria-label="Język interfejsu / Interface language"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        position: 'relative',
        height: 28,
        padding: 2,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        userSelect: 'none',
      }}
    >
      {/* Pływające tło wybranego języka */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 2,
          left: lang === 'pl' ? 2 : 'calc(50% + 0px)',
          width: 'calc(50% - 2px)',
          height: 'calc(100% - 4px)',
          background: 'var(--blue)',
          borderRadius: 999,
          transition: 'left 160ms ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}
      />
      <LangOption
        code="pl"
        active={lang === 'pl'}
        onClick={() => setLang('pl')}
        flag="🇵🇱"
        label="PL"
      />
      <LangOption
        code="en"
        active={lang === 'en'}
        onClick={() => setLang('en')}
        flag="🇬🇧"
        label="EN"
      />
    </div>
  )
}

function LangOption({ code, active, onClick, flag, label }: {
  code: string
  active: boolean
  onClick: () => void
  flag: string
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={code === 'pl' ? 'Polski' : 'English'}
      style={{
        position: 'relative',
        zIndex: 1,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: '0 10px',
        height: '100%',
        minWidth: 44,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        color: active ? 'white' : 'var(--muted)',
        fontWeight: 600,
        fontSize: 11,
        letterSpacing: 0.4,
        transition: 'color 120ms',
      }}
    >
      <span style={{ fontSize: 12, lineHeight: 1 }}>{flag}</span>
      {label}
    </button>
  )
}
