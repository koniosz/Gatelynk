'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { buildingAdminApi } from '@/lib/building-admin-api'

interface Relay { id: string; label: string }
interface Intercom {
  manufacturer: string; model: string | null; ipAddress: string | null
  login: string | null; password: string | null; relays: Relay[] | null
}
interface Stairwell {
  id: number; name: string; intercom: Intercom | null
  units: { id: number; number: string; floor: number | null }[]
}

export default function BaStairwellDetailPage() {
  const { id, swId } = useParams()
  const [stairwell, setStairwell] = useState<Stairwell | null>(null)

  const load = useCallback(async () => {
    const r = await buildingAdminApi.get(`/building-admin/buildings/${id}/stairwells/${swId}`)
    setStairwell(r.data)
  }, [id, swId])

  useEffect(() => { load() }, [load])

  if (!stairwell) return <p className="text-gray-400">Ładowanie...</p>

  const ic = stairwell.intercom

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Link href={`/building-admin/buildings/${id}`} className="text-sm text-gray-400 hover:text-gray-600">
          ← Budynek
        </Link>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-2xl">🏛️</span>
          <h1 className="text-2xl font-bold text-gray-900">{stairwell.name}</h1>
        </div>
        <p className="text-gray-400 text-sm mt-0.5">Klatka schodowa</p>
      </div>

      {/* Lokale */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 mb-4">
        <h3 className="font-semibold text-gray-800 mb-3">🏠 Lokale ({stairwell.units?.length ?? 0})</h3>
        {(stairwell.units?.length ?? 0) > 0 ? (
          <div className="divide-y divide-gray-100 -mx-5">
            {stairwell.units.map((u) => (
              <div key={u.id} className="flex items-center justify-between px-5 py-2.5 text-sm">
                <span className="font-medium text-gray-900">{u.number}</span>
                {u.floor !== null && <span className="text-gray-400 text-xs">Piętro {u.floor}</span>}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-400">Brak przypisanych lokali</p>
        )}
      </div>

      {/* Domofon — read-only */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="font-semibold text-gray-800 mb-4">📟 Domofon Akuvox</h3>
        {ic ? (
          <div className="space-y-2">
            <InfoRow label="Producent" value={ic.manufacturer} />
            {ic.model && <InfoRow label="Model" value={ic.model} />}
            {ic.ipAddress && <InfoRow label="Adres IP" value={ic.ipAddress} />}
            {ic.login && <InfoRow label="Login" value={ic.login} />}
            {ic.password && <InfoRow label="Hasło" value={'•'.repeat(ic.password.length)} />}
            {Array.isArray(ic.relays) && ic.relays.length > 0 && (
              <div className="pt-2">
                <p className="text-xs text-gray-500 mb-1.5">⚡ Elektrozaczepy:</p>
                <div className="flex flex-wrap gap-2">
                  {ic.relays.map((r, i) => (
                    <span key={r.id}
                      className="text-xs bg-yellow-50 text-yellow-700 border border-yellow-200 px-2 py-1 rounded-full">
                      {i + 1}. {r.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-400">
            Domofon nie został jeszcze skonfigurowany przez integratora.
          </p>
        )}
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between text-sm py-0.5">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-gray-900">{value ?? <span className="text-gray-400 font-normal">—</span>}</span>
    </div>
  )
}
