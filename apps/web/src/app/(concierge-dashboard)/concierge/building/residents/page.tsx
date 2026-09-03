'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { conciergeApi } from '@/lib/concierge-api'

// ── Ikony typów lokali ────────────────────────────────────────────────────────
function unitIcon(code?: string, icon?: string): string {
  const byCode: Record<string, string> = {
    apartment:    '🏠',
    garage:       '🚗',
    storage:      '🗄️',
    pool:         '🏊',
    gym:          '💪',
    sauna:        '🧖',
    playroom:     '🎮',
    banquet_hall: '🎉',
  }
  const byIcon: Record<string, string> = {
    home:           '🏠',
    car:            '🚗',
    archive:        '🗄️',
    waves:          '🏊',
    dumbbell:       '💪',
    flame:          '🧖',
    gamepad:        '🎮',
    'party-popper': '🎉',
  }
  return (code && byCode[code]) || (icon && byIcon[icon]) || '🏠'
}

export default function ConciergeResidentsPage() {
  const [residents, setResidents] = useState<any[]>([])
  const [unitsWithParcels, setUnitsWithParcels] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const router = useRouter()

  useEffect(() => {
    Promise.all([
      conciergeApi.get('/concierge/building/residents'),
      conciergeApi.get('/concierge/building/parcels?status=RECEIVED'),
    ])
      .then(([rRes, pRes]) => {
        setResidents(rRes.data)
        setUnitsWithParcels(new Set<number>((pRes.data as any[]).map((p: any) => p.unitId)))
      })
      .catch(() => router.push('/concierge/login'))
      .finally(() => setLoading(false))
  }, [router])

  const filtered = residents.filter((r) => {
    const q = search.toLowerCase()
    return (
      r.firstName.toLowerCase().includes(q) ||
      r.lastName.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q) ||
      (r.phone ?? '').includes(q)
    )
  })

  if (loading) return <p className="text-gray-400">Ładowanie...</p>

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">👥 Mieszkańcy</h1>
        <span className="text-sm text-gray-400">{residents.length} osób</span>
      </div>

      {/* Wyszukiwarka */}
      <div className="mb-4">
        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Szukaj po imieniu, nazwisku, emailu..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-4xl mb-3">👥</p>
          <p className="text-gray-500 text-sm">
            {search ? 'Brak wyników dla podanej frazy' : 'Brak mieszkańców'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {filtered.map((r) => {
            const activeUnits = r.unitResidents?.filter((ur: any) => !ur.untilDate) ?? []
            const hasParcel = activeUnits.some((ur: any) => unitsWithParcels.has(ur.unit?.id))
            return (
              <div key={r.id} className={`px-5 py-3 transition ${hasParcel ? 'bg-amber-50' : ''}`}>
                <div className="flex items-start justify-between gap-3">
                  {/* Dane mieszkańca */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-gray-900">{r.firstName} {r.lastName}</p>
                      {hasParcel && (
                        <Link
                          href="/concierge/building/parcels"
                          title="Kliknij aby przejść do przesyłek"
                          className="inline-flex items-center gap-1 text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-300 px-2 py-0.5 rounded-full hover:bg-amber-200 transition"
                        >
                          📦 paczka
                        </Link>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{r.email}</p>
                    {r.phone && <p className="text-xs text-gray-400">{r.phone}</p>}
                  </div>

                  {/* Lokale jako linki z ikonami typów */}
                  <div className="flex flex-wrap gap-1 justify-end flex-shrink-0">
                    {activeUnits.map((ur: any) => {
                      const unitHasParcel = unitsWithParcels.has(ur.unit?.id)
                      const icon = unitIcon(ur.unit?.unitType?.code, ur.unit?.unitType?.icon)
                      return (
                        <Link
                          key={ur.unit?.id}
                          href={`/concierge/building/units/${ur.unit?.id}`}
                          title={`${ur.unit?.unitType?.name ?? 'Lokal'} ${ur.unit?.number} — kliknij aby zobaczyć szczegóły`}
                          className={`text-xs border px-2 py-0.5 rounded-full transition ${
                            unitHasParcel
                              ? 'bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-200'
                              : 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                          }`}
                        >
                          {icon} {ur.unit?.number}
                          {unitHasParcel && ' 📦'}
                        </Link>
                      )
                    })}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
