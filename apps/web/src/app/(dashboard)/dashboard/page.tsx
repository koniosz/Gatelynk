'use client'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

export default function DashboardPage() {
  const [license, setLicense] = useState<any>(null)
  const [buildings, setBuildings] = useState<any[]>([])

  useEffect(() => {
    api.get('/license/my').then((r) => setLicense(r.data)).catch(() => {})
    api.get('/buildings').then((r) => setBuildings(r.data)).catch(() => {})
  }, [])

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Panel główny</h1>

      {!license && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-6 flex items-center justify-between">
          <p className="text-yellow-800 text-sm">Brak aktywnej licencji</p>
          <Link href="/license/activate" className="text-sm font-medium text-yellow-700 underline">
            Aktywuj teraz
          </Link>
        </div>
      )}

      {license && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-sm text-gray-500">Plan</p>
            <p className="text-xl font-bold text-gray-900 mt-1">{license.plan.name}</p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-sm text-gray-500">Budynki</p>
            <p className="text-xl font-bold text-gray-900 mt-1">
              {buildings.length}
              {license.plan.maxBuildings && <span className="text-sm text-gray-400"> / {license.plan.maxBuildings}</span>}
            </p>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <p className="text-sm text-gray-500">Wygasa</p>
            <p className="text-xl font-bold text-gray-900 mt-1">
              {license.validUntil
                ? new Date(license.validUntil).toLocaleDateString('pl-PL')
                : 'Bezterminowo'}
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-800">Twoje budynki</h2>
        <Link
          href="/buildings/new"
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          + Dodaj budynek
        </Link>
      </div>

      {buildings.length === 0 ? (
        <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center">
          <p className="text-gray-400">Nie masz jeszcze żadnych budynków</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {buildings.map((b) => (
            <Link
              key={b.id}
              href={`/buildings/${b.id}`}
              className="bg-white rounded-xl border border-gray-200 p-5 hover:border-blue-300 hover:shadow-sm transition"
            >
              <p className="font-semibold text-gray-900">{b.name}</p>
              <p className="text-sm text-gray-500 mt-1">{b.address}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
