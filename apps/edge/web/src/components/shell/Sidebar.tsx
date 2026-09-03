/**
 * GateLynk Edge — Sidebar (56px wide).
 *
 * Z handoff doc (sek. 5):
 *   • Tylko ikony + tooltip on hover
 *   • Aktywna pozycja: niebieskie tło + lewy 2px wskaźnik
 *   • Bez sekcji "settings" na dole — wszystko jako równorzędne tabs
 */
import { Link, useLocation } from 'wouter'
import {
  LayoutGrid,
  ShieldCheck,
  ScanLine,
  Activity,
  FileText,
  Settings,
  Bot,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface NavItem {
  href: string
  icon: LucideIcon
  labelKey: string
}

const NAV: NavItem[] = [
  { href: '/',           icon: LayoutGrid,  labelKey: 'sidebar.system' },
  { href: '/access',     icon: ShieldCheck, labelKey: 'sidebar.access' },
  { href: '/lpr',        icon: ScanLine,    labelKey: 'sidebar.lpr' },
  { href: '/monitoring', icon: Activity,    labelKey: 'sidebar.monitoring' },
  { href: '/logs',       icon: FileText,    labelKey: 'sidebar.logs' },
  { href: '/settings',   icon: Settings,    labelKey: 'sidebar.settings' },
]

export function Sidebar() {
  const [location] = useLocation()
  const { t } = useTranslation()

  return (
    <aside
      style={{
        width: 56,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 12,
        gap: 4,
      }}
    >
      {/* Logo placeholder — 32x32 z gradientem niebieskim */}
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          background: 'linear-gradient(135deg, var(--blue) 0%, var(--blue-600) 100%)',
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: 12,
          marginBottom: 8,
        }}
      >
        GL
      </div>

      {/* FAZA 8.h.6 (2026-06-05) — AI Engine standalone page (poza React SPA).
          Klik tu robi pełen page-load /ui/ai-engine.html — strona zarządza
          się sama (Alpine.js), używamy <a> nie <Link> żeby ominąć Wouter routing. */}
      <a
        href="/ui/ai-engine.html"
        title="AI Engine"
        style={{
          width: 40,
          height: 40,
          borderRadius: 'var(--r-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--muted)',
          background: 'transparent',
          position: 'relative',
          transition: 'background 120ms, color 120ms',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = 'transparent'
        }}
      >
        <Bot size={18} strokeWidth={2} />
      </a>

      {NAV.map((item) => {
        const Icon = item.icon
        const isActive = item.href === '/' ? location === '/' : location.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            title={t(item.labelKey)}
            style={{
              width: 40,
              height: 40,
              borderRadius: 'var(--r-2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: isActive ? 'var(--blue)' : 'var(--muted)',
              background: isActive ? 'var(--blue-50)' : 'transparent',
              position: 'relative',
              transition: 'background 120ms, color 120ms',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLElement).style.background = 'transparent'
              }
            }}
          >
            {/* Lewy 2px wskaźnik aktywny — z handoff doc */}
            {isActive && (
              <span
                style={{
                  position: 'absolute',
                  left: -8,
                  top: 8,
                  bottom: 8,
                  width: 2,
                  background: 'var(--blue)',
                  borderRadius: '0 2px 2px 0',
                }}
                aria-hidden="true"
              />
            )}
            <Icon size={18} strokeWidth={2} />
          </Link>
        )
      })}
    </aside>
  )
}
