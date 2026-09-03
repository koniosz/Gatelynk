'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
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

const PARCEL_STATUS: Record<string, { label: string; cls: string }> = {
  RECEIVED: { label: 'W depozycie',  cls: 'bg-amber-100 text-amber-700 border-amber-300' },
  ISSUED:   { label: 'Odebrana',     cls: 'bg-green-100 text-green-700 border-green-300' },
  RETURNED: { label: 'Zwrócona',     cls: 'bg-gray-100  text-gray-600  border-gray-300'  },
}

export default function ConciergeUnitDetailPage() {
  const { unitId } = useParams()
  const router = useRouter()
  const [unit, setUnit] = useState<any>(null)
  const [parcels, setParcels] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!unitId) return
    Promise.all([
      conciergeApi.get(`/concierge/building/units/${unitId}`),
      conciergeApi.get(`/concierge/building/units/${unitId}/parcels`),
    ])
      .then(([uRes, pRes]) => {
        setUnit(uRes.data)
        setParcels(pRes.data)
      })
      .catch(() => router.push('/concierge/building/units'))
      .finally(() => setLoading(false))
  }, [unitId, router])

  if (loading) return <p className="text-gray-400">Ładowanie...</p>
  if (!unit) return null

  const icon = unitIcon(unit.unitType?.code, unit.unitType?.icon)
  const activeResidents = unit.unitResidents?.filter((ur: any) => !ur.untilDate) ?? []
  const pastResidents   = unit.unitResidents?.filter((ur: any) =>  ur.untilDate) ?? []
  const receivedParcels = parcels.filter((p) => p.status === 'RECEIVED')

  return (
    <div className="max-w-2xl">
      {/* Breadcrumb */}
      <Link href="/concierge/building/units"
        className="text-sm text-gray-400 hover:text-gray-600 mb-4 inline-block">
        ← Lokale
      </Link>

      {/* Nagłówek */}
      <div className="flex items-center gap-3 mb-6">
        <span className="text-4xl">{icon}</span>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {unit.unitType?.name} {unit.number}
          </h1>
          <div className="flex items-center gap-2 mt-1 text-sm text-gray-400">
            {unit.floor !== null && <span>Piętro {unit.floor}</span>}
            {unit.areaSqm && <><span>·</span><span>{unit.areaSqm} m²</span></>}
            {unit.stairwell && <><span>·</span><span>🏛️ {unit.stairwell.name}</span></>}
          </div>
        </div>
        {receivedParcels.length > 0 && (
          <Link
            href="/concierge/building/parcels"
            className="ml-auto inline-flex items-center gap-1.5 bg-amber-100 text-amber-700 border border-amber-300 text-sm font-medium px-3 py-1.5 rounded-full hover:bg-amber-200 transition"
          >
            📦 {receivedParcels.length} {receivedParcels.length === 1 ? 'paczka' : 'paczki'} w depozycie
          </Link>
        )}
      </div>

      {/* Aktywni mieszkańcy */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <h2 className="font-semibold text-gray-800 mb-3">
          👥 Aktywni mieszkańcy ({activeResidents.length})
        </h2>
        {activeResidents.length === 0 ? (
          <p className="text-sm text-gray-400">Brak aktywnych mieszkańców</p>
        ) : (
          <div className="divide-y divide-gray-100 -mx-5">
            {activeResidents.map((ur: any) => (
              <div key={ur.id} className="px-5 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {ur.resident?.firstName} {ur.resident?.lastName}
                  </p>
                  <p className="text-xs text-gray-400">{ur.resident?.email}</p>
                  {ur.resident?.phone && (
                    <p className="text-xs text-gray-400">{ur.resident.phone}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs border px-2 py-0.5 rounded-full ${
                    ur.role === 'OWNER'
                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                      : 'bg-gray-50 text-gray-600 border-gray-200'
                  }`}>
                    {ur.role === 'OWNER' ? '👤 Właściciel' : '👥 Najemca'}
                  </span>
                  <span className="text-xs text-gray-400">
                    od {new Date(ur.sinceDate).toLocaleDateString('pl-PL')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Przesyłki */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-gray-800">📦 Przesyłki ({parcels.length})</h2>
          {parcels.length > 0 && (
            <Link href="/concierge/building/parcels"
              className="text-sm text-blue-600 hover:text-blue-800 font-medium">
              Zarządzaj →
            </Link>
          )}
        </div>
        {parcels.length === 0 ? (
          <p className="text-sm text-gray-400">Brak przesyłek</p>
        ) : (
          <div className="divide-y divide-gray-100 -mx-5">
            {parcels.map((p) => {
              const st = PARCEL_STATUS[p.status] ?? PARCEL_STATUS['RECEIVED']
              return (
                <div key={p.id} className="px-5 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{p.trackingNumber}</p>
                    <p className="text-xs text-gray-400">
                      {p.courier}
                      {p.concierge?.name && ` · przyjął: ${p.concierge.name}`}
                    </p>
                    <p className="text-xs text-gray-400">
                      {new Date(p.receivedAt).toLocaleDateString('pl-PL', {
                        day: '2-digit', month: '2-digit', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </p>
                  </div>
                  <span className={`text-xs border px-2 py-0.5 rounded-full ${st.cls}`}>
                    {st.label}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Poprzedni mieszkańcy (zwinięte) */}
      {pastResidents.length > 0 && (
        <details className="bg-white rounded-xl border border-gray-200 p-5">
          <summary className="font-semibold text-gray-500 text-sm cursor-pointer select-none">
            Poprzedni mieszkańcy ({pastResidents.length})
          </summary>
          <div className="divide-y divide-gray-100 -mx-5 mt-3">
            {pastResidents.map((ur: any) => (
              <div key={ur.id} className="px-5 py-2 flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">
                    {ur.resident?.firstName} {ur.resident?.lastName}
                  </p>
                  <p className="text-xs text-gray-400">{ur.resident?.email}</p>
                </div>
                <span className="text-xs text-gray-400">
                  {new Date(ur.sinceDate).toLocaleDateString('pl-PL')} –{' '}
                  {new Date(ur.untilDate).toLocaleDateString('pl-PL')}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
