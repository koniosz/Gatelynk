'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { buildingAdminApi } from '@/lib/building-admin-api'

export default function BaBuildingsPage() {
  const [buildings, setBuildings] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    buildingAdminApi.get('/building-admin/buildings')
      .then((r) => setBuildings(r.data))
      .catch(() => router.push('/building-admin/login'))
      .finally(() => setLoading(false))
  }, [router])

  if (loading) return <p className="text-gray-400">Ładowanie...</p>

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">🏢 Moje budynki</h1>

      {buildings.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-4xl mb-3">🏢</p>
          <p className="text-gray-500">Brak przypisanych budynków</p>
          <p className="text-gray-400 text-xs mt-1">Administrator konta przypisze Ci budynki</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {buildings.map((b) => (
            <Link key={b.id} href={`/building-admin/buildings/${b.id}`}
              className="bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-md hover:border-blue-200 transition">
              {/* Zdjęcie tła */}
              {b.backgroundImageBase64 && (
                <div className="relative h-24 overflow-hidden">
                  <img src={b.backgroundImageBase64} alt="" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-gradient-to-b from-black/10 to-black/40" />
                  {b.logoBase64 && (
                    <img src={b.logoBase64} alt="Logo" className="absolute bottom-2 left-3 h-8 max-w-[80px] object-contain drop-shadow" />
                  )}
                </div>
              )}
              <div className="p-5">
                <div className="flex items-center gap-3 mb-3">
                  {b.logoBase64 && !b.backgroundImageBase64
                    ? <img src={b.logoBase64} alt="Logo" className="h-9 w-9 rounded-lg object-contain border border-gray-100 bg-gray-50 shrink-0" />
                    : <span className="text-2xl">{({ PARKING: '🅿️', ESTATE: '🏘️', APART_HOTEL: '🏨' } as Record<string,string>)[b.objectType] ?? '🏢'}</span>
                  }
                  <div>
                    <p className="font-semibold text-gray-900">{b.name}</p>
                    <p className="text-xs text-gray-400">{b.address}</p>
                  </div>
                </div>
                <div className="flex gap-3 text-xs text-gray-500">
                  <span>🏛️ {b.stairwells?.length ?? 0} klatek</span>
                  <span>🏠 {b._count?.units ?? 0} lokali</span>
                  <span>👥 {b._count?.residents ?? 0} mieszkańców</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
