'use client'
/**
 * Topbar — breadcrumbs + global search + refresh + logout.
 *
 * Breadcrumbs są **klikalne**: każdy okruszek ma href. Składamy dynamicznie:
 *   /integrator/buildings           → „Obiekty"
 *   /integrator/buildings/123       → „Obiekty › Nazwa obiektu" (z context)
 *   /integrator/buildings/123/devices → „Obiekty › Nazwa › Urządzenia"
 *
 * Refresh przycisk emit-uje window event `integrator:refresh` — strona kt6óra
 * subscribuje (przez useEffect listener) trigger-uje swój re-fetch. Decoupling
 * vs explicit prop drilling.
 *
 * Search: na razie input bez logiki — w MVP będzie filtr po nazwie obiektu
 * globalnie (przekierowanie do /integrator/buildings?q=).
 */
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { useMemo, useState } from 'react'
import { ChevronRight, RefreshCw, Search, LogOut } from 'lucide-react'
import { useActiveProperty } from './active-property-context'

interface Crumb {
  label: string
  href?: string
}

interface TopbarProps {
  onLogout: () => void
}

export function Topbar({ onLogout }: TopbarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const { active } = useActiveProperty()
  const [refreshing, setRefreshing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const crumbs = useMemo(() => buildCrumbs(pathname, active), [pathname, active])

  const handleRefresh = () => {
    setRefreshing(true)
    window.dispatchEvent(new CustomEvent('integrator:refresh'))
    setTimeout(() => setRefreshing(false), 600)
  }

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const q = searchQuery.trim()
    router.push(q ? `/integrator/buildings?q=${encodeURIComponent(q)}` : '/integrator/buildings')
  }

  return (
    <header
      className="flex items-center justify-between bg-surface border-b border-border px-6"
      style={{ height: 52, fontFamily: 'var(--font-plex-sans, system-ui)' }}
    >
      {/* Lewo: breadcrumbs */}
      <nav aria-label="breadcrumb" className="flex items-center gap-1 min-w-0 flex-1">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1
          return (
            <span key={i} className="flex items-center gap-1 min-w-0">
              {crumb.href && !isLast ? (
                <Link
                  href={crumb.href}
                  className="text-[13px] text-muted hover:text-ink truncate"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className={`text-[13px] truncate ${isLast ? 'text-ink font-medium' : 'text-muted'}`}>
                  {crumb.label}
                </span>
              )}
              {!isLast && <ChevronRight size={12} className="text-muted-2 flex-shrink-0" />}
            </span>
          )
        })}
      </nav>

      {/* Prawo: search + refresh + logout */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <form onSubmit={handleSearchSubmit} className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2 pointer-events-none" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Szukaj obiektu, IP, MAC…"
            className="pl-8 pr-3 py-1.5 text-[12px] bg-surface-2 border border-border rounded-r2 focus:outline-none focus:border-brand text-ink placeholder:text-muted-2 w-56"
          />
        </form>

        <button
          onClick={handleRefresh}
          title="Odśwież aktualny widok"
          className="p-1.5 rounded-r2 text-muted hover:text-ink hover:bg-surface-2 transition-colors"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>

        <button
          onClick={onLogout}
          title="Wyloguj"
          className="p-1.5 rounded-r2 text-muted hover:text-ink hover:bg-surface-2 transition-colors"
        >
          <LogOut size={14} />
        </button>
      </div>
    </header>
  )
}

/**
 * Budowanie crumbs z pathname + active property.
 *
 * Pattern matching:
 *   /integrator/buildings                       → Konfiguracja techniczna › Obiekty
 *   /integrator/buildings/[id]                  → … › <active.name>
 *   /integrator/buildings/[id]/devices          → … › <active.name> › Urządzenia
 *   /integrator/buildings/[id]/stairwells/[sid] → … › <active.name> › Klatka
 *   /integrator/edges|tools|settings            → Konfiguracja techniczna › <Sekcja>
 */
function buildCrumbs(pathname: string, active: { id: number; name: string } | null): Crumb[] {
  const base: Crumb[] = [{ label: 'Konfiguracja techniczna' }]
  const segments = pathname.replace(/^\/integrator\/?/, '').split('/').filter(Boolean)

  if (segments.length === 0) return base

  if (segments[0] === 'buildings') {
    base.push({ label: 'Obiekty', href: '/integrator/buildings' })
    if (segments[1]) {
      base.push({
        label: active?.name ?? `Obiekt #${segments[1]}`,
        href: `/integrator/buildings/${segments[1]}`,
      })
      if (segments[2] === 'devices') base.push({ label: 'Urządzenia' })
      if (segments[2] === 'stairwells' && segments[3]) {
        base.push({ label: `Klatka ${segments[3]}` })
      }
    }
  } else if (segments[0] === 'edges') {
    base.push({ label: 'Urządzenia Edge' })
  } else if (segments[0] === 'tools') {
    base.push({ label: 'Narzędzia' })
  } else if (segments[0] === 'settings') {
    base.push({ label: 'Ustawienia' })
  }

  return base
}
