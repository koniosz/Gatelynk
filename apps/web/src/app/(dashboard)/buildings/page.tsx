'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

export default function BuildingsPage() {
  const [buildings, setBuildings] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)

  const load = (withArchived: boolean) => {
    setLoading(true)
    const url = withArchived ? '/buildings?includeArchived=true' : '/buildings'
    api.get(url).then((r) => setBuildings(r.data)).finally(() => setLoading(false))
  }

  useEffect(() => { load(showArchived) }, [showArchived])

  const active = buildings.filter((b) => !b.isArchived)
  const archived = buildings.filter((b) => b.isArchived)

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-gray-900">Obiekty</h1>
          {!loading && (
            <span className="text-sm text-gray-400">
              {active.length} {active.length === 1 ? 'budynek' : active.length < 5 ? 'budynki' : 'budynków'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={`text-sm px-3 py-1.5 rounded-lg border transition ${
              showArchived
                ? 'bg-amber-50 border-amber-300 text-amber-700'
                : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300 hover:text-gray-700'
            }`}
          >
            {showArchived ? '🗄️ Ukryj zarchiwizowane' : '🗄️ Pokaż zarchiwizowane'}
          </button>
          <Link
            href="/buildings/new"
            className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            + Dodaj budynek
          </Link>
        </div>
      </div>

      {loading ? (
        <p className="text-gray-400">Ładowanie...</p>
      ) : buildings.length === 0 ? (
        <div className="bg-white rounded-xl border border-dashed border-gray-300 p-16 text-center">
          <p className="text-gray-400 mb-3">Nie masz jeszcze żadnych budynków</p>
          <Link href="/buildings/new" className="text-blue-600 text-sm hover:underline">
            Dodaj pierwszy budynek →
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Aktywne budynki */}
          {active.length > 0 && (
            <div className="grid grid-cols-2 gap-4">
              {active.map((b) => (
                <BuildingCard key={b.id} building={b} />
              ))}
            </div>
          )}

          {/* Brak aktywnych */}
          {active.length === 0 && showArchived && (
            <div className="bg-white rounded-xl border border-dashed border-gray-300 p-10 text-center">
              <p className="text-gray-400 mb-3">Wszystkie budynki są zarchiwizowane</p>
              <Link href="/buildings/new" className="text-blue-600 text-sm hover:underline">
                Dodaj nowy budynek →
              </Link>
            </div>
          )}

          {/* Zarchiwizowane */}
          {showArchived && archived.length > 0 && (
            <div>
              <div className="flex items-center gap-3 mb-3">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  Zarchiwizowane ({archived.length})
                </span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                {archived.map((b) => (
                  <BuildingCard key={b.id} building={b} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BuildingCard({ building: b }: { building: any }) {
  const amenities: string[] = []
  if (b.hasPool) amenities.push('🏊 Basen')
  if (b.hasGym) amenities.push('💪 Siłownia')
  if (b.hasSauna) amenities.push('🧖 Sauna')
  if (b.hasPlayroom) amenities.push('🎮 Sala zabaw')
  if (b.hasBanquetHall) amenities.push('🎉 Sala bankietowa')
  if (b.hasLobby) amenities.push('🛋️ Lobby')

  const isParking = b.objectType === 'PARKING'

  return (
    <Link
      href={`/buildings/${b.id}`}
      className={`bg-white rounded-xl border overflow-hidden hover:shadow-sm transition group ${
        b.isArchived ? 'border-amber-200 opacity-75 hover:opacity-100' : 'border-gray-200 hover:border-blue-300'
      }`}
    >
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
        {/* Nagłówek: logo + nazwa + strzałka */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            {b.logoBase64 && !b.backgroundImageBase64 && (
              <img src={b.logoBase64} alt="Logo" className="h-9 w-9 rounded-lg object-contain border border-gray-100 bg-gray-50 shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {isParking && <span className="text-base leading-none">🅿️</span>}
                <p className="font-semibold text-gray-900 truncate">{b.name}</p>
                {isParking && (
                  <span className="shrink-0 text-xs font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">Parking</span>
                )}
                {b.isArchived && (
                  <span className="shrink-0 text-xs font-medium bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Zarchiwizowany</span>
                )}
              </div>
              <p className="text-sm text-gray-500 mt-0.5 truncate">{b.address}</p>
            </div>
          </div>
          <span className="text-gray-300 group-hover:text-blue-400 transition text-lg leading-none mt-0.5 shrink-0">→</span>
        </div>

        {/* Statystyki */}
        <div className="flex items-center gap-4 mt-3">
          <span className="text-xs text-gray-400">
            {isParking ? '🅿️' : '🏠'}{' '}
            <span className="font-medium text-gray-600">{b._count?.units ?? 0}</span>{' '}
            {isParking ? 'miejsc' : 'lokali'}
          </span>
          <span className="text-xs text-gray-400">
            👤 <span className="font-medium text-gray-600">{b._count?.residents ?? 0}</span>{' '}
            {isParking ? 'użytkowników' : 'mieszkańców'}
          </span>
          {b.numberOfFloors != null && (
            <span className="text-xs text-gray-400">
              🏗️ <span className="font-medium text-gray-600">{b.numberOfFloors}</span> pięter
            </span>
          )}
        </div>

        {/* GateLynk Edge badges */}
        {(b.hasEdge || b.hasEdgeAI) && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {b.hasEdge && (
              <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full border border-blue-100 font-medium">
                🖥️ Edge
              </span>
            )}
            {b.hasEdgeAI && (
              <span className="text-xs bg-violet-50 text-violet-600 px-2 py-0.5 rounded-full border border-violet-100 font-medium">
                🤖 Edge AI
              </span>
            )}
          </div>
        )}

        {/* Udogodnienia (max 3) */}
        {amenities.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {amenities.slice(0, 3).map((a) => (
              <span key={a} className="text-xs bg-gray-50 text-gray-500 px-2 py-0.5 rounded-full border border-gray-100">{a}</span>
            ))}
            {amenities.length > 3 && (
              <span className="text-xs text-gray-400 px-1">+{amenities.length - 3}</span>
            )}
          </div>
        )}
      </div>
    </Link>
  )
}
