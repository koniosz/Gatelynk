/**
 * GateLynk Edge — Theme toggle (sun/moon).
 *
 * Z handoff doc (sek. 5): „Dark mode pierwszorzędny. Instalatorzy często
 * pracują wieczorem/w nocy. Dark to domyślny tryb. Light to alternatywa."
 *
 * Persystencja w `localStorage` pod `gle.theme` (zarządzane w `App.tsx`).
 */
import { Sun, Moon } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface ThemeToggleProps {
  theme: 'light' | 'dark'
  onToggle: () => void
}

export function ThemeToggle({ theme, onToggle }: ThemeToggleProps) {
  const Icon = theme === 'dark' ? Sun : Moon
  const { t } = useTranslation()
  return (
    <button
      onClick={onToggle}
      className="btn-icon"
      title={theme === 'dark' ? t('topbar.theme.dark') : t('topbar.theme.light')}
      aria-label={t('topbar.theme.aria')}
    >
      <Icon size={18} strokeWidth={2} />
    </button>
  )
}
