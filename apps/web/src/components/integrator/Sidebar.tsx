'use client'
/**
 * Sidebar — Panel Integratora (handoff §5).
 *
 * Layout (220px wide):
 *   ┌─────────────────────┐
 *   │ Logo + brand sub    │
 *   ├─────────────────────┤
 *   │ Nawigacja           │ — Obiekty | Edge | Narzędzia | Ustawienia
 *   │   (z licznikami)    │
 *   ├─────────────────────┤
 *   │ Aktywny obiekt      │ ← pojawia się dynamicznie
 *   │ (jeśli wybrany)     │
 *   ├─────────────────────┤
 *   │ ◯ Karta integratora │ avatar + imię + firma
 *   └─────────────────────┘
 *
 * Routing convention: `/integrator/<section>`.
 *   - properties (== buildings backend-side, ale UI label „Obiekty")
 *   - edges
 *   - tools
 *   - settings
 *
 * Aktywna sekcja: porównujemy `pathname` z `href` (startsWith) — dla
 * deep linking np. `/integrator/properties/123` highlightuje Obiekty.
 */
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Building2, Server, Wrench, Settings, ChevronRight, LayoutDashboard,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useActiveProperty } from './active-property-context'

interface NavItem {
  href: string
  icon: LucideIcon
  label: string
  count?: number   // do późniejszego wpięcia (np. liczba obiektów z badge-a)
}

const NAV_ITEMS: NavItem[] = [
  { href: '/integrator/dashboard',  icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/integrator/buildings',  icon: Building2, label: 'Obiekty' },
  { href: '/integrator/edges',      icon: Server,    label: 'Urządzenia Edge' },
  { href: '/integrator/tools',      icon: Wrench,    label: 'Narzędzia' },
  { href: '/integrator/settings',   icon: Settings,  label: 'Ustawienia' },
]

interface SidebarProps {
  integratorName?: string
  integratorCompany?: string
}

export function Sidebar({ integratorName, integratorCompany }: SidebarProps) {
  const pathname = usePathname()
  const { active } = useActiveProperty()

  return (
    <aside
      className="flex flex-col bg-surface border-r border-border"
      style={{ width: 220, fontFamily: 'var(--font-plex-sans, system-ui)' }}
    >
      {/* Logo + brand */}
      <div className="px-5 py-5 border-b border-border">
        <div className="text-base font-bold text-brand">GateLynk</div>
        <div className="text-[11px] text-muted mt-0.5">Panel Integratora</div>
      </div>

      {/* Główna nawigacja */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-r2 text-[13px] font-medium transition-colors ${
                isActive
                  ? 'bg-brand-50 text-brand'
                  : 'text-ink-2 hover:bg-surface-2'
              }`}
            >
              <Icon size={16} strokeWidth={1.8} />
              <span className="flex-1">{item.label}</span>
              {item.count !== undefined && (
                <span className="text-[10px] font-semibold text-muted">
                  {item.count}
                </span>
              )}
            </Link>
          )
        })}

        {/* Dynamiczna sekcja „Aktywny obiekt" — pojawia się gdy user wszedł
            w detal property. Zachowuje kontekst gdy nawiguje po sub-stronach. */}
        {active && (
          <div className="mt-6 pt-4 border-t border-border">
            <div className="px-3 text-[10px] font-bold uppercase tracking-wider text-muted-2 mb-2">
              Aktywny obiekt
            </div>
            <Link
              href={`/integrator/buildings/${active.id}`}
              className="flex items-center gap-2.5 px-3 py-2 rounded-r2 bg-surface-2 text-ink hover:bg-bg-2 transition-colors"
            >
              <Building2 size={15} strokeWidth={1.8} className="text-brand" />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-semibold truncate">{active.name}</div>
                {active.address && (
                  <div className="text-[10px] text-muted truncate">{active.address}</div>
                )}
              </div>
              <ChevronRight size={12} className="text-muted" />
            </Link>
          </div>
        )}
      </nav>

      {/* Karta integratora — footer */}
      <div className="px-3 py-3 border-t border-border">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <div className="w-8 h-8 rounded-full bg-brand-50 flex items-center justify-center text-[11px] font-semibold text-brand">
            {(integratorName ?? '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-semibold text-ink truncate">
              {integratorName ?? 'Integrator'}
            </div>
            {integratorCompany && (
              <div className="text-[10px] text-muted truncate">{integratorCompany}</div>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
