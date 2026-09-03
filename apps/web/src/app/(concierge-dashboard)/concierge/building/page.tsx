'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { conciergeApi } from '@/lib/concierge-api'

export default function ConciergeBuildingPage() {
  const [building, setBuilding] = useState<any>(null)
  const [activeParcels, setActiveParcels] = useState(0)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    Promise.all([
      conciergeApi.get('/concierge/building'),
      conciergeApi.get('/concierge/building/parcels?status=RECEIVED'),
    ])
      .then(([bRes, pRes]) => {
        setBuilding(bRes.data)
        setActiveParcels(Array.isArray(pRes.data) ? pRes.data.length : 0)
      })
      .catch(() => router.push('/concierge/login'))
      .finally(() => setLoading(false))
  }, [router])

  if (loading) return <p className="text-gray-400">Ładowanie...</p>
  if (!building) return null

  return (
    <div className="max-w-2xl">
      {/* Banner z tłem / logo */}
      {building.backgroundImageBase64 ? (
        <div className="relative rounded-2xl overflow-hidden mb-6 h-36">
          <img src={building.backgroundImageBase64} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-4 flex items-end gap-3">
            {building.logoBase64 && (
              <img src={building.logoBase64} alt="Logo" className="h-12 max-w-[120px] object-contain drop-shadow-lg shrink-0" />
            )}
            <div>
              <h1 className="text-xl font-bold text-white leading-tight drop-shadow">{building.name}</h1>
              <p className="text-xs text-white/70">{building.address}</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="mb-6 flex items-center gap-4">
          {building.logoBase64 ? (
            <img src={building.logoBase64} alt="Logo" className="h-14 max-w-[120px] object-contain rounded-xl border border-gray-100 bg-white p-1 shrink-0" />
          ) : (
            <span className="text-3xl">{({ PARKING: '🅿️', ESTATE: '🏘️', APART_HOTEL: '🏨' } as Record<string,string>)[building.objectType] ?? '🏢'}</span>
          )}
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{building.name}</h1>
            <p className="text-sm text-gray-400">{building.address}</p>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard icon="👥" label="Mieszkańcy" value={building._count?.residents ?? 0}
          href="/concierge/building/residents" />
        <StatCard icon="🏠" label="Lokale" value={building._count?.units ?? 0}
          href="/concierge/building/units" />
        <StatCard icon="🏛️" label="Klatki" value={building.stairwells?.length ?? 0} />
        <StatCard icon="📦" label="Przesyłki" value={activeParcels}
          href="/concierge/building/parcels" highlight={activeParcels > 0} />
      </div>

      {/* Szybki dostęp */}
      <div className="grid grid-cols-2 gap-4">
        <QuickLink href="/concierge/building/residents" icon="👥" label="Lista mieszkańców"
          desc="Przeglądaj i wyszukuj mieszkańców" />
        <QuickLink href="/concierge/building/units" icon="🏠" label="Lista lokali"
          desc="Przeglądaj lokale budynku" />
        <QuickLink href="/concierge/building/parcels" icon="📦" label="Przesyłki"
          desc="Zarządzaj przesyłkami w depozycie" />
        <QuickLink href="/concierge/building/notifications" icon="🔔" label="Wyślij powiadomienie"
          desc="Poinformuj mieszkańców" />
      </div>
    </div>
  )
}

function StatCard({ icon, label, value, href, highlight }: {
  icon: string; label: string; value: number; href?: string; highlight?: boolean
}) {
  const content = (
    <div className={`bg-white rounded-xl border p-4 text-center hover:shadow-sm transition ${highlight ? 'border-orange-300 bg-orange-50' : 'border-gray-200'}`}>
      <p className="text-2xl mb-1">{icon}</p>
      <p className={`text-2xl font-bold ${highlight ? 'text-orange-600' : 'text-gray-900'}`}>{value}</p>
      <p className="text-xs text-gray-400">{label}</p>
    </div>
  )
  return href ? <Link href={href}>{content}</Link> : content
}

function QuickLink({ href, icon, label, desc }: {
  href: string; icon: string; label: string; desc: string
}) {
  return (
    <Link href={href}
      className="bg-white rounded-xl border border-gray-200 p-4 hover:shadow-md hover:border-blue-200 transition">
      <p className="text-2xl mb-2">{icon}</p>
      <p className="text-sm font-medium text-gray-900">{label}</p>
      <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
    </Link>
  )
}
