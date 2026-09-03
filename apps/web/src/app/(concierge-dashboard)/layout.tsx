'use client'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { useRef, useState, useEffect, useCallback } from 'react'
import { clearConciergeToken, conciergeApi } from '@/lib/concierge-api'

function ConciergeGlobalSearch() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ residents: any[]; units: any[]; vehicles: any[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults(null); return }
    setLoading(true)
    try {
      const [rRes, uRes, vRes] = await Promise.all([
        conciergeApi.get('/concierge/building/residents'),
        conciergeApi.get('/concierge/building/units'),
        conciergeApi.get('/concierge/building/vehicles'),
      ])
      const ql = q.toLowerCase()
      const residents = (rRes.data as any[]).filter((r) =>
        `${r.firstName} ${r.lastName}`.toLowerCase().includes(ql) ||
        r.email.toLowerCase().includes(ql) ||
        (r.phone ?? '').includes(ql)
      )
      const units = (uRes.data as any[]).filter((u) =>
        (u.number ?? '').toLowerCase().includes(ql) ||
        (u.unitType?.name ?? '').toLowerCase().includes(ql)
      )
      const vehicles = (vRes.data as any[]).filter((v) =>
        v.make.toLowerCase().includes(ql) ||
        (v.model ?? '').toLowerCase().includes(ql) ||
        v.licensePlate.toLowerCase().includes(ql) ||
        v.color.toLowerCase().includes(ql) ||
        `${v.resident?.firstName ?? ''} ${v.resident?.lastName ?? ''}`.toLowerCase().includes(ql)
      )
      setResults({ residents, units, vehicles })
    } catch { /* ignore auth errors */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => doSearch(query), 300)
    return () => clearTimeout(t)
  }, [query, doSearch])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setQuery(''); setResults(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const navigate = (href: string) => {
    setQuery(''); setResults(null)
    router.push(href)
  }

  const total = results ? results.residents.length + results.units.length + results.vehicles.length : 0

  return (
    <div ref={wrapperRef} className="relative w-72">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="🔍 Szukaj mieszkańca, lokalu, pojazdu..."
        className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
      />
      {query && (
        <button onClick={() => { setQuery(''); setResults(null) }}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-base leading-none">
          ×
        </button>
      )}
      {query.trim() !== '' && (
        <div className="absolute top-full mt-1 left-0 right-0 bg-white rounded-xl border border-gray-200 shadow-lg z-50 overflow-hidden max-h-96 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-gray-400 text-sm">Szukanie...</div>
          ) : !results || total === 0 ? (
            <div className="p-4 text-center text-gray-400 text-sm">Brak wyników dla „{query}"</div>
          ) : (
            <>
              {results.residents.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    👥 Mieszkańcy ({results.residents.length})
                  </div>
                  {results.residents.map((r) => (
                    <button key={r.id}
                      onClick={() => navigate('/concierge/building/residents')}
                      className="w-full text-left px-3 py-2.5 hover:bg-blue-50 border-b border-gray-50 transition">
                      <div className="text-sm font-medium text-gray-900">{r.firstName} {r.lastName}</div>
                      <div className="text-xs text-gray-400">{r.email}{r.phone ? ` · ${r.phone}` : ''}</div>
                    </button>
                  ))}
                </div>
              )}
              {results.units.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    🏠 Lokale ({results.units.length})
                  </div>
                  {results.units.map((u) => (
                    <button key={u.id}
                      onClick={() => navigate(`/concierge/building/units/${u.id}`)}
                      className="w-full text-left px-3 py-2.5 hover:bg-blue-50 border-b border-gray-50 transition">
                      <div className="text-sm font-medium text-gray-900">{u.unitType?.name ?? 'Lokal'} {u.number}</div>
                      <div className="text-xs text-gray-400">Piętro {u.floor ?? '—'}</div>
                    </button>
                  ))}
                </div>
              )}
              {results.vehicles.length > 0 && (
                <div>
                  <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    🚗 Pojazdy ({results.vehicles.length})
                  </div>
                  {results.vehicles.map((v) => (
                    <button key={v.id}
                      onClick={() => navigate('/concierge/building/vehicles')}
                      className="w-full text-left px-3 py-2.5 hover:bg-blue-50 border-b border-gray-50 transition">
                      <div className="text-sm font-medium text-gray-900 font-mono uppercase">{v.licensePlate}</div>
                      <div className="text-xs text-gray-400">{v.make}{v.model ? ` ${v.model}` : ''} · {v.color}{v.resident ? ` · ${v.resident.firstName} ${v.resident.lastName}` : ''}</div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function ConciergeDashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()

  // FAZA b (2026-06-02) — Universal object types.
  // Backend `concierge.service.getMe` zwraca 403 gdy obiekt ma
  // `features.has_concierge=false`. Wtedy pokazujemy fullscreen blokadę z
  // wylogowaniem zamiast normalnego dashboardu.
  // FAZA e (2026-06-02) — featurePermissions z `/concierge/me` filtrują
  // sidebar nav items per feature.
  const [conciergeDisabled, setConciergeDisabled] = useState(false)
  const [featurePermissions, setFeaturePermissions] = useState<Record<string, boolean>>({})
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await conciergeApi.get('/concierge/me')
        if (cancelled) return
        const perms = (res.data as { featurePermissions?: unknown })?.featurePermissions
        if (perms && typeof perms === 'object') {
          const out: Record<string, boolean> = {}
          for (const [k, v] of Object.entries(perms as Record<string, unknown>)) {
            if (typeof v === 'boolean') out[k] = v
          }
          setFeaturePermissions(out)
        }
      } catch (err: any) {
        if (!cancelled && err?.response?.status === 403) {
          setConciergeDisabled(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Domyślnie widoczny gdy niezdefiniowany (defense — same logic as backend).
  const hasFeature = (key: string): boolean => {
    const v = featurePermissions[`feat_${key}`]
    if (typeof v === 'boolean') return v
    return true
  }

  // Tytuł karty — layout 'use client', więc bez `export const metadata`.
  // Root metadata template doda „— GateLynk".
  useEffect(() => { document.title = 'Panel Konsjerża — GateLynk' }, [])

  const handleLogout = () => {
    clearConciergeToken()
    router.push('/concierge/login')
  }

  // FAZA e — `feature` na każdym item-ie. Brak = zawsze widoczny (np. Budynek/
  // Mieszkańcy/Lokale to twarda baza, niezależna od permissions).
  const allNavItems: { href: string; label: string; icon: string; exact: boolean; feature?: string }[] = [
    { href: '/concierge/building', label: 'Budynek', icon: '🏠', exact: true },
    { href: '/concierge/building/residents', label: 'Mieszkańcy', icon: '👥', exact: false },
    { href: '/concierge/building/units', label: 'Lokale', icon: '🚪', exact: false },
    { href: '/concierge/building/parcels', label: 'Przesyłki', icon: '📦', exact: false, feature: 'parcels' },
    { href: '/concierge/building/reservations', label: 'Rezerwacje', icon: '📅', exact: false, feature: 'reservations' },
    { href: '/concierge/building/vehicles', label: 'Pojazdy', icon: '🚗', exact: false, feature: 'vehicles' },
    { href: '/concierge/building/guests', label: 'Goście', icon: '👤', exact: false, feature: 'guests' },
    { href: '/concierge/building/lpr-reads', label: 'Odczyty tablic', icon: '📸', exact: false, feature: 'lpr_audit' },
    { href: '/concierge/building/access-events', label: 'Wejścia (audit)', icon: '🚪', exact: false, feature: 'lpr_audit' },
    // 2026-05-25 — alerty bezpieczeństwa (fall detection). Konsjerż jest
    // pierwszym reagującym przy upadku w częściach wspólnych.
    { href: '/concierge/building/anomaly-events', label: 'Bezpieczeństwo', icon: '🛡', exact: false, feature: 'fall_detection' },
    // Faza 4 — ticket-y zaadresowane do konsjerża (`type='CONCIERGE'`).
    // Mieszkaniec wybiera adresata przy create. Admin nie widzi tych ticket-ów,
    // konsjerż nie widzi ticket-ów do administracji — separation of duties.
    { href: '/concierge/building/tickets', label: 'Zgłoszenia', icon: '🎫', exact: false, feature: 'tickets' },
    { href: '/concierge/building/notifications', label: 'Powiadomienia', icon: '🔔', exact: false, feature: 'notifications' },
    // Asystent AI (2026-05-22) — chat z LPR/vision/knowledge przez Edge.
    { href: '/concierge/building/assistant', label: 'Asystent AI', icon: '✨', exact: false },
  ]
  const navItems = allNavItems.filter((item) => !item.feature || hasFeature(item.feature))

  if (conciergeDisabled) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="max-w-md text-center bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          <div className="text-5xl mb-4">🚫</div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            Konsjerż nie jest dostępny w tym obiekcie
          </h1>
          <p className="text-sm text-gray-600 mb-6">
            Integrator wyłączył funkcję konsjerża dla tego budynku. Skontaktuj się z
            administracją osiedla jeśli uważasz, że to błąd.
          </p>
          <button
            onClick={handleLogout}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
          >
            Wyloguj
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-100">
          <span className="text-base font-bold text-blue-600">GateLynk</span>
          <p className="text-xs text-gray-400 mt-0.5">Panel Konsjerża</p>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const isActive = item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href)
            return (
              <Link key={item.href} href={item.href}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition ${
                  isActive ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-100'
                }`}>
                {item.icon} {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="p-4 border-t border-gray-100">
          <button onClick={handleLogout} className="text-sm text-gray-500 hover:text-gray-700">
            Wyloguj
          </button>
        </div>
      </aside>

      {/* Content */}
      <div className="flex-1 flex flex-col">
        <header className="bg-white border-b border-gray-200 px-8 py-3 flex items-center justify-between gap-4">
          <div className="text-sm text-gray-500 shrink-0">🎩 Obsługa mieszkańców</div>
          <ConciergeGlobalSearch />
        </header>
        <main className="flex-1 p-8 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
