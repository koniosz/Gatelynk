'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'

export default function BuildingPage() {
  const { id } = useParams()
  const [building, setBuilding] = useState<any>(null)
  const [units, setUnits] = useState<any[]>([])
  const [residents, setResidents] = useState<any[]>([])
  const [tab, setTab] = useState<'units' | 'residents'>('units')

  useEffect(() => {
    api.get(`/buildings/${id}`).then((r) => setBuilding(r.data))
    api.get(`/buildings/${id}/units`).then((r) => setUnits(r.data))
    api.get(`/buildings/${id}/residents`).then((r) => setResidents(r.data))
  }, [id])

  if (!building) return <p className="text-gray-400">Ładowanie...</p>

  return (
    <div>
      <div className="mb-6">
        <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-600">← Budynki</Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">{building.name}</h1>
        <p className="text-gray-500 text-sm">{building.address}</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-gray-200 mb-6">
        {(['units', 'residents'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-3 text-sm font-medium border-b-2 transition ${tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {t === 'units' ? `Lokale (${units.length})` : `Mieszkańcy (${residents.length})`}
          </button>
        ))}
      </div>

      {tab === 'units' && (
        <div>
          <div className="flex justify-end mb-4">
            <Link href={`/buildings/${id}/units/new`} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700">
              + Dodaj lokal
            </Link>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {units.length === 0 && (
              <p className="p-6 text-center text-gray-400 text-sm">Brak lokali</p>
            )}
            {units.map((u) => (
              <div key={u.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <span className="font-medium text-gray-900">{u.number}</span>
                  <span className="ml-2 text-sm text-gray-500">{u.unitType.name}</span>
                  {u.floor !== null && <span className="ml-2 text-xs text-gray-400">p. {u.floor}</span>}
                </div>
                {u.areaSqm && <span className="text-sm text-gray-400">{u.areaSqm} m²</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'residents' && (
        <div>
          <div className="flex justify-end mb-4">
            <Link href={`/buildings/${id}/residents/new`} className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700">
              + Dodaj mieszkańca
            </Link>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {residents.length === 0 && (
              <p className="p-6 text-center text-gray-400 text-sm">Brak mieszkańców</p>
            )}
            {residents.map((r) => (
              <div key={r.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <span className="font-medium text-gray-900">{r.firstName} {r.lastName}</span>
                  <span className="ml-2 text-sm text-gray-400">{r.email}</span>
                </div>
                <button
                  onClick={async () => {
                    await api.post(`/invitations/buildings/${id}/send`, {
                      residentId: r.id,
                      unitId: r.unitResidents[0]?.unit?.id,
                    })
                    alert('Zaproszenie wysłane!')
                  }}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Wyślij zaproszenie
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
