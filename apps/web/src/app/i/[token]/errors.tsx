import { Brand } from '@/components/invite/Brand'

/**
 * Zaślepki dla stanów krawędziowych zaproszenia. Wspólny styl z resztą strony
 * (`gli-stage`, `gli-page`, `gli-hero`).
 */
function Shell({ title, body, accent }: { title: string; body: string; accent: 'warn' | 'bad' | 'muted' }) {
  const accentColor =
    accent === 'bad' ? 'var(--gli-danger)' : accent === 'warn' ? 'var(--gli-warning)' : 'var(--gli-text-tertiary)'
  return (
    <div className="gli-stage">
      <div className="gli-page">
        <Brand />
        <div className="gli-hero" style={{ textAlign: 'center', padding: '32px 22px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: '8px 0 6px', color: accentColor }}>{title}</h1>
          <p style={{ fontSize: 14, color: 'var(--gli-text-secondary)', margin: 0, lineHeight: 1.5 }}>{body}</p>
        </div>
        <div className="gli-footer">Skontaktuj się z gospodarzem aby otrzymać nowe zaproszenie.</div>
      </div>
    </div>
  )
}

export function InviteRevoked() {
  return (
    <Shell
      title="Zaproszenie zostało anulowane"
      body="Gospodarz odwołał Twój dostęp. Skontaktuj się z nim, aby uzyskać nowe zaproszenie."
      accent="bad"
    />
  )
}

export function InviteExpired() {
  return (
    <Shell
      title="Zaproszenie wygasło"
      body="Okno czasowe dostępu się skończyło. Poproś gospodarza o nowe zaproszenie."
      accent="warn"
    />
  )
}

export function InviteUnknown() {
  return (
    <Shell
      title="Nie znaleziono zaproszenia"
      body="Sprawdź czy link jest poprawny. Jeśli kopiowałeś z SMS-a — upewnij się że nie został przycięty."
      accent="muted"
    />
  )
}
