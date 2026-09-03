'use client'
/**
 * Panel Integratora — AppShell (handoff §5).
 *
 * Layout:
 *   ┌──────────┬────────────────────────────────┐
 *   │ Sidebar  │ Topbar (breadcrumbs+search)    │
 *   │  220px   ├────────────────────────────────┤
 *   │          │                                │
 *   │          │ <main>{children}</main>        │
 *   │          │                                │
 *   └──────────┴────────────────────────────────┘
 *
 * Komponenty wydzielone do `components/integrator/`:
 *   - Sidebar (logo, nawigacja, aktywny obiekt, karta integratora)
 *   - Topbar (breadcrumbs, search, refresh, logout)
 *   - ActivePropertyProvider (Context dla „aktywny obiekt" cross-page)
 *
 * Po Sesji 1 (design system) ten layout zostaje — dalsze sesje rozszerzają
 * komponenty Sidebar (loadowanie liczników z `useQuery`) i dodają nowe
 * route-y (edges, tools, settings) bez zmiany tu.
 */
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { clearIntegratorToken } from '@/lib/integrator-api'
import { Sidebar } from '@/components/integrator/Sidebar'
import { Topbar } from '@/components/integrator/Topbar'
import { ActivePropertyProvider } from '@/components/integrator/active-property-context'

export default function IntegratorDashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  // TODO: po Sesji 1 zastąpić localStorage `currentUser` przez useQuery
  // do `/integrator/me` — dla MVP pierwszej sesji mamy hardcoded.
  const [integrator, setIntegrator] = useState<{ name?: string; company?: string }>({})

  useEffect(() => {
    document.title = 'Panel Integratora — GateLynk'
    try {
      const stored = localStorage.getItem('integrator:profile')
      if (stored) setIntegrator(JSON.parse(stored))
    } catch { /* ignore */ }
  }, [])

  const handleLogout = () => {
    clearIntegratorToken()
    router.push('/integrator/login')
  }

  return (
    <ActivePropertyProvider>
      <div
        className="min-h-screen flex bg-bg"
        style={{ fontFamily: 'var(--font-plex-sans, system-ui)' }}
      >
        <Sidebar
          integratorName={integrator.name}
          integratorCompany={integrator.company}
        />

        <div className="flex-1 flex flex-col min-w-0">
          <Topbar onLogout={handleLogout} />
          <main className="flex-1 overflow-auto p-6">
            {children}
          </main>
        </div>
      </div>
    </ActivePropertyProvider>
  )
}
