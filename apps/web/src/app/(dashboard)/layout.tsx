import Link from 'next/link'
import { clearToken } from '@/lib/api'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b border-gray-100">
          <span className="text-lg font-bold text-blue-600">GateLynk</span>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          <Link href="/dashboard" className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 text-sm font-medium">
            Panel główny
          </Link>
          <Link href="/buildings" className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-700 hover:bg-gray-100 text-sm font-medium">
            Budynki
          </Link>
        </nav>
        <div className="p-4 border-t border-gray-100">
          <a href="/login" className="text-sm text-gray-500 hover:text-gray-700">Wyloguj</a>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8 overflow-auto">{children}</main>
    </div>
  )
}
