'use client'

// Admin budynku — historia zdarzeń gości w budynku.
// Analogiczny widok jak konsjerż, tylko że dla admina (jeden admin → wiele
// budynków, więc buildingId bierzemy z URL-a, nie z JWT).
//
// Łączy dwa źródła z backendu (UNION w `getGuestsHistoryFor`):
//   • PORTAL_OPEN — gość kliknął przycisk w portalu /g/<token> i otworzył bramę
//   • PLATE_MATCH — kamera LPR rozpoznała tablicę gościa w oknie ważności
//
// Sortowane po czasie DESC, limit 100 z backendu. Polling co 15s.
//
// Endpoint: `GET /building-admin/buildings/:id/guests/history`.

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { buildingAdminApi } from '@/lib/building-admin-api'

type HistoryItem =
  | {
      kind: 'PORTAL_OPEN'
      id: string
      ts: string
      guestId: number | null
      guestName: string | null
      vehiclePlate: string | null
      residentId: number | null
      residentName: string | null
      accessPointId: number | null
      accessPointLabel: string | null
      actorIp: string | null
    }
  | {
      kind: 'PLATE_MATCH'
      id: string
      ts: string
      guestId: number | null
      guestName: string | null
      vehiclePlate: string | null
      residentId: number | null
      residentName: string | null
      gateOpened: boolean
      reason: string | null
    }

const fmt = (d: string) =>
  new Date(d).toLocaleString('pl-PL', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })

function lprReasonLabel(reason: string | null, gateOpened: boolean): string {
  if (gateOpened) return 'otwarto'
  switch (reason) {
    case 'cooldown': return 'cooldown'
    case 'gate_error': return 'błąd bramki'
    case 'not_whitelisted': return 'spoza listy'
    case 'expired': return 'wygasłe'
    default: return reason ?? '—'
  }
}

export default function BaGuestsHistoryPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const initialLoad = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await buildingAdminApi.get(`/building-admin/buildings/${id}/guests/history`)
      setItems(res.data as HistoryItem[])
      setError(null)
    } catch (err: any) {
      if (err?.response?.status === 401) {
        router.push('/building-admin/login')
        return
      }
      setError(err?.response?.data?.message ?? 'Nie udało się pobrać historii')
    } finally {
      if (initialLoad.current) {
        setLoading(false)
        initialLoad.current = false
      }
    }
  }, [id, router])

  useEffect(() => {
    load()
    // Polling 15s — kompromis między „świeżością" a obciążeniem.
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])

  if (loading) return <p className="text-gray-400">Ładowanie...</p>

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h1 className="font-semibold text-gray-800 text-lg">
            📋 Historia zdarzeń gości ({items.length})
          </h1>
          <Link href={`/building-admin/buildings/${id}`}
            className="bg-gray-100 text-gray-700 text-sm px-3 py-1.5 rounded-lg hover:bg-gray-200 border border-gray-200">
            ← Powrót do budynku
          </Link>
        </div>

        {error && (
          <p className="text-xs text-red-600 mb-3">{error}</p>
        )}

        {items.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">
            Brak zdarzeń. Pojawią się tu gdy gość otworzy bramę przez portal
            albo kamera LPR rozpozna jego tablicę.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-5 py-2">Czas</th>
                  <th className="text-left px-3 py-2">Typ</th>
                  <th className="text-left px-3 py-2">Gość</th>
                  <th className="text-left px-3 py-2">Mieszkaniec</th>
                  <th className="text-left px-3 py-2">Punkt / Tablica</th>
                  <th className="text-left px-3 py-2">Wynik</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((it) => (
                  <tr key={it.id} className="hover:bg-gray-50">
                    <td className="px-5 py-2 text-xs text-gray-500 whitespace-nowrap">{fmt(it.ts)}</td>
                    <td className="px-3 py-2">
                      {it.kind === 'PORTAL_OPEN' ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                          🚪 Portal
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                          🚗 LPR
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900">
                        {it.guestName ?? <span className="text-gray-400 italic">usunięty</span>}
                      </div>
                      {it.kind === 'PORTAL_OPEN' && it.vehiclePlate && (
                        <div className="text-xs font-mono text-gray-400 uppercase">{it.vehiclePlate}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {it.residentName ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {it.kind === 'PORTAL_OPEN' ? (
                        <span className="text-gray-700">{it.accessPointLabel ?? '—'}</span>
                      ) : (
                        <span className="font-mono uppercase text-gray-700">{it.vehiclePlate ?? '—'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {it.kind === 'PORTAL_OPEN' ? (
                        <span className="text-green-700">otwarto</span>
                      ) : (
                        <span className={it.gateOpened ? 'text-green-700' : 'text-gray-500'}>
                          {lprReasonLabel(it.reason, it.gateOpened)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
