'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useRef, useEffect } from 'react'
import { api, clearToken } from '@/lib/api'

function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    if (query.length < 2) { setResults(null); setOpen(false); return }
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        const r = await api.get(`/search?q=${encodeURIComponent(query)}`)
        setResults(r.data)
        setOpen(true)
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  const go = (url: string) => { setOpen(false); setQuery(''); router.push(url) }
  const hasResults = results && (
    results.buildings?.length > 0 ||
    results.residents?.length > 0 ||
    results.units?.length > 0
  )

  return (
    <div ref={ref} className="relative w-80">
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results && setOpen(true)}
          placeholder="Szukaj budynku, lokalu lub mieszkańca..."
          className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white"
        />
        {loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs">...</span>
        )}
      </div>

      {open && (
        <div className="absolute top-full mt-1 left-0 w-full bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden max-h-96 overflow-y-auto">
          {!hasResults ? (
            <p className="px-4 py-3 text-sm text-gray-400">Brak wyników</p>
          ) : (
            <>
              {results.buildings?.length > 0 && (
                <div>
                  <p className="px-4 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50">Obiekty</p>
                  {results.buildings.map((b: any) => (
                    <button
                      key={b.id}
                      onClick={() => go(`/buildings/${b.id}`)}
                      className="w-full text-left px-4 py-2.5 hover:bg-blue-50 flex items-center gap-2"
                    >
                      <span className="text-base">🏢</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{b.name}</p>
                        <p className="text-xs text-gray-400">{b.address}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {results.units?.length > 0 && (
                <div>
                  <p className="px-4 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50">Lokale</p>
                  {results.units.map((u: any) => {
                    const unitIconMap: Record<string, string> = {
                      home: '🏠', apartment: '🏠', car: '🚗', garage: '🚗',
                      archive: '📦', storage: '📦', waves: '🏊', pool: '🏊',
                      dumbbell: '💪', gym: '💪', gamepad: '🎮', 'party-popper': '🎉',
                    }
                    const icon = unitIconMap[u.unitType.icon] ?? '🏠'
                    return (
                      <button
                        key={u.id}
                        onClick={() => go(`/buildings/${u.building.id}/units/${u.id}`)}
                        className="w-full text-left px-4 py-2.5 hover:bg-blue-50 flex items-center gap-2"
                      >
                        <span className="text-base">{icon}</span>
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            Lokal {u.number}
                            <span className="ml-1.5 text-gray-400 font-normal text-xs">{u.unitType.name}</span>
                          </p>
                          <p className="text-xs text-gray-400">
                            {u.building.name}{u.floor != null ? ` · p. ${u.floor}` : ''}{u.areaSqm ? ` · ${u.areaSqm} m²` : ''}
                          </p>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
              {results.residents?.length > 0 && (
                <div>
                  <p className="px-4 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50">Mieszkańcy</p>
                  {results.residents.map((r: any) => (
                    <button
                      key={r.id}
                      onClick={() => go(`/buildings/${r.building.id}/residents/${r.id}`)}
                      className="w-full text-left px-4 py-2.5 hover:bg-blue-50 flex items-center gap-2"
                    >
                      <span className="text-base">👤</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{r.firstName} {r.lastName}</p>
                        <p className="text-xs text-gray-400">{r.email} · {r.building.name}</p>
                      </div>
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

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname()
  const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
        active
          ? 'bg-blue-50 text-blue-700'
          : 'text-gray-700 hover:bg-gray-100'
      }`}
    >
      {children}
    </Link>
  )
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()

  // Tytuł karty przeglądarki — layout jest 'use client', więc ustawiamy
  // przez `document.title`. Root metadata template odpowiada za sufiks.
  useEffect(() => { document.title = 'Superadmin — GateLynk' }, [])

  const handleLogout = () => {
    clearToken()
    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-100">
          <span className="text-lg font-bold text-blue-600">GateLynk</span>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          <NavLink href="/dashboard">🏠 Panel główny</NavLink>
          <NavLink href="/buildings">🏢 Obiekty</NavLink>
          <NavLink href="/settings">⚙️ Ustawienia</NavLink>
        </nav>
        <div className="p-4 border-t border-gray-100">
          <button
            onClick={handleLogout}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Wyloguj
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col">
        {/* Top bar */}
        <header className="bg-white border-b border-gray-200 px-8 py-3 flex items-center justify-between">
          <GlobalSearch />
          <div className="text-sm text-gray-400">Superadmin</div>
        </header>

        {/* Content */}
        <main className="flex-1 p-8 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
