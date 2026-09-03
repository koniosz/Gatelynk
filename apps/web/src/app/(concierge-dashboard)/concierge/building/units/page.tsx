'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { conciergeApi } from '@/lib/concierge-api'

export default function ConciergeUnitsPage() {
  const [units, setUnits] = useState<any[]>([])
  const [unitsWithParcels, setUnitsWithParcels] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const router = useRouter()

  useEffect(() => {
    Promise.all([
      conciergeApi.get('/concierge/building/units'),
      conciergeApi.get('/concierge/building/parcels?status=RECEIVED'),
    ])
      .then(([uRes, pRes]) => {
        setUnits(uRes.data)
        setUnitsWithParcels(new Set<number>((pRes.data as any[]).map((p: any) => p.unitId)))
      })
      .catch(() => router.push('/concierge/login'))
      .finally(() => setLoading(false))
  }, [router])

  const garageKw = ['garaż', 'garage', 'miejsce parkingowe']
  const storageKw = ['komórka', 'komórki', 'piwnica', 'schowek', 'magazyn']
  const isGarage  = (u: any) => garageKw.some(k => u.unitType?.name?.toLowerCase().includes(k))
  const isStorage = (u: any) => storageKw.some(k => u.unitType?.name?.toLowerCase().includes(k))

  const filtered = units.filter((u) => {
    const q = search.toLowerCase()
    return (
      u.number.toLowerCase().includes(q) ||
      (u.unitType?.name ?? '').toLowerCase().includes(q) ||
      (u.stairwell?.name ?? '').toLowerCase().includes(q)
    )
  })

  const nonCommon   = filtered.filter((u) => !u.unitType?.isCommonArea)
  const commonUnits = filtered.filter((u) => u.unitType?.isCommonArea)
  const apartments  = nonCommon.filter(u => !isGarage(u) && !isStorage(u))
  const garages     = nonCommon.filter(isGarage)
  const storage     = nonCommon.filter(isStorage)

  const UnitRow = ({ u }: { u: any }) => {
    const hasParcel = unitsWithParcels.has(u.id)
    return (
      <div className={`px-5 py-3 flex items-center justify-between transition ${hasParcel ? 'bg-amber-50' : ''}`}>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-gray-900">{u.unitType?.name} {u.number}</p>
            {hasParcel && (
              <span title="Oczekująca przesyłka w depozycie"
                className="inline-flex items-center gap-1 text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-300 px-2 py-0.5 rounded-full">
                📦 paczka
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400">
            {u.floor !== null ? `Piętro ${u.floor}` : ''}
            {u.areaSqm ? ` · ${u.areaSqm} m²` : ''}
            {u.stairwell ? ` · ${u.stairwell.name}` : ''}
          </p>
        </div>
      </div>
    )
  }

  const SectionBlock = ({ icon, label, color, items, empty }: {
    icon: string; label: string; color: string; items: any[]; empty: string
  }) => (
    <div>
      <div className="flex items-center gap-2 px-1 mb-2">
        <span className="text-sm font-semibold text-gray-700">{icon} {label}</span>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${color}`}>{items.length}</span>
        <div className="flex-1 h-px bg-gray-200" />
      </div>
      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        {items.length === 0
          ? <p className="px-5 py-4 text-sm text-gray-400 text-center">{empty}</p>
          : items.map((u) => <UnitRow key={u.id} u={u} />)}
      </div>
    </div>
  )

  if (loading) return <p className="text-gray-400">Ładowanie...</p>

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">🏠 Lokale</h1>
        <span className="text-sm text-gray-400">{units.length} lokali</span>
      </div>

      <div className="mb-5">
        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Szukaj po numerze, typie, klatce..."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-4xl mb-3">🏠</p>
          <p className="text-gray-500 text-sm">
            {search ? 'Brak wyników dla podanej frazy' : 'Brak lokali'}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          <SectionBlock icon="🏠" label="Lokale mieszkalne" color="bg-blue-100 text-blue-700" items={apartments} empty="Brak lokali mieszkalnych" />
          <SectionBlock icon="🚗" label="Garaże / miejsca parkingowe" color="bg-slate-100 text-slate-600" items={garages} empty="Brak garaży" />
          <SectionBlock icon="📦" label="Komórki lokatorskie" color="bg-amber-100 text-amber-700" items={storage} empty="Brak komórek lokatorskich" />
          <SectionBlock icon="🏛️" label="Części wspólne" color="bg-purple-100 text-purple-700" items={commonUnits} empty="Brak części wspólnych" />
        </div>
      )}
    </div>
  )
}
