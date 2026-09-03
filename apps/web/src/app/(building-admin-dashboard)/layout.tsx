'use client'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { clearBaToken } from '@/lib/building-admin-api'

export default function BuildingAdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()

  // Tytuł karty — layout 'use client', więc bez `export const metadata`.
  // Root metadata template (`%s — GateLynk`) doda sufiks.
  useEffect(() => { document.title = 'Panel Administratora — GateLynk' }, [])

  const handleLogout = () => {
    clearBaToken()
    router.push('/building-admin/login')
  }

  // Pojedynczy punkt wejścia — admin wchodzi w konkretny obiekt, a stamtąd
  // otwiera pod-strony (mieszkańcy, odczyty tablic, itp.). Dzięki temu
  // kontekst budynku jest zawsze jawny.
  const navItems = [
    { href: '/building-admin/buildings', icon: '🏢', label: 'Obiekty' },
  ]

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-100">
          <span className="text-base font-bold text-blue-600">GateLynk</span>
          <p className="text-xs text-gray-400 mt-0.5">Panel Administratora</p>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href)
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
        <header className="bg-white border-b border-gray-200 px-8 py-3 flex items-center justify-between">
          <div className="text-sm text-gray-500">🏢 Zarządzanie budynkiem</div>
          <div className="text-sm text-gray-400">Building Administrator</div>
        </header>
        <main className="flex-1 p-8 overflow-auto">{children}</main>
      </div>
    </div>
  )
}
