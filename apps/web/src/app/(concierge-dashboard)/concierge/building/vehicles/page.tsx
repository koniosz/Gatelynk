'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { conciergeApi } from '@/lib/concierge-api'

export default function ConciergeVehiclesPage() {
  const [vehicles, setVehicles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const router = useRouter()

  useEffect(() => {
    conciergeApi.get('/concierge/building/vehicles')
      .then((res) => setVehicles(res.data))
      .catch(() => router.push('/concierge/login'))
      .finally(() => setLoading(false))
  }, [router])

  const filtered = vehicles.filter((v) => {
    const q = search.toLowerCase()
    return (
      v.make.toLowerCase().includes(q) ||
      (v.model ?? '').toLowerCase().includes(q) ||
      v.licensePlate.toLowerCase().includes(q) ||
      v.color.toLowerCase().includes(q) ||
      `${v.resident?.firstName} ${v.resident?.lastName}`.toLowerCase().includes(q)
    )
  })

  if (loading) return <p className="text-gray-400">Ładowanie...</p>

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">🚗 Pojazdy</h1>
        <span className="text-sm text-gray-400">{vehicles.length} pojazdów</span>
      </div>

      <div className="mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Szukaj po marce, tablicy, kolorze lub mieszkańcu..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-4xl mb-3">🚗</p>
          <p className="text-gray-500 text-sm">
            {search ? 'Brak wyników dla podanej frazy' : 'Brak zarejestrowanych pojazdów'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {filtered.map((v) => (
            <div key={v.id} className="px-5 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900 font-mono tracking-wide uppercase">
                    {v.licensePlate}
                  </span>
                  <span className="text-sm text-gray-700">{v.make}{v.model ? ` ${v.model}` : ''}</span>
                  <span className="text-xs text-gray-400">· {v.color}</span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {v.resident ? `${v.resident.firstName} ${v.resident.lastName}` : '—'}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
