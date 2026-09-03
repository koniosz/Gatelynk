'use client'
import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'

interface Resident { id: number; firstName: string; lastName: string; email: string }

const unitIconMap: Record<string, string> = {
  home: '🏠', apartment: '🏠', car: '🚗', garage: '🚗',
  archive: '📦', storage: '📦', waves: '🏊', pool: '🏊',
  dumbbell: '💪', gym: '💪', gamepad: '🎮', 'party-popper': '🎉',
}

export default function NewUnitPage() {
  const router = useRouter()
  const { id: buildingId } = useParams()

  const [unitTypes, setUnitTypes] = useState<any[]>([])
  const [residents, setResidents] = useState<Resident[]>([])

  const [number, setNumber] = useState('')
  const [unitTypeId, setUnitTypeId] = useState<string>('')
  const [floor, setFloor] = useState('')
  const [areaSqm, setAreaSqm] = useState('')
  const [description, setDescription] = useState('')

  // Przypisanie mieszkańca
  const [assignResident, setAssignResident] = useState(false)
  const [residentId, setResidentId] = useState<string>('')
  const [role, setRole] = useState<'OWNER' | 'TENANT'>('OWNER')
  const [sinceDate, setSinceDate] = useState(new Date().toISOString().split('T')[0])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get(`/buildings/${buildingId}/unit-types`).then((r) => {
      setUnitTypes(r.data)
      if (r.data.length > 0) setUnitTypeId(String(r.data[0].id))
    })
    api.get(`/buildings/${buildingId}/residents`).then((r) => {
      setResidents(r.data)
      if (r.data.length > 0) setResidentId(String(r.data[0].id))
    })
  }, [buildingId])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      // 1. Utwórz lokal
      const res = await api.post(`/buildings/${buildingId}/units`, {
        number,
        unitTypeId: Number(unitTypeId),
        floor: floor !== '' ? Number(floor) : undefined,
        areaSqm: areaSqm !== '' ? Number(areaSqm) : undefined,
        description: description || undefined,
      })
      const newUnitId = res.data.id

      // 2. Opcjonalnie przypisz mieszkańca
      if (assignResident && residentId) {
        await api.post(`/buildings/${buildingId}/residents/${newUnitId}/assign`, {
          residentId: Number(residentId),
          role,
          sinceDate,
        })
      }

      router.push(`/buildings/${buildingId}`)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Błąd podczas tworzenia lokalu')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-lg">
      <div className="mb-6">
        <Link href={`/buildings/${buildingId}`} className="text-sm text-gray-400 hover:text-gray-600">
          ← Budynek
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-1">Nowy lokal</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Dane lokalu */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="font-semibold text-gray-800">Dane lokalu</h2>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Numer lokalu <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              required
              placeholder="np. 1A, 23, G-5"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Typ lokalu <span className="text-red-500">*</span>
            </label>
            <select
              value={unitTypeId}
              onChange={(e) => setUnitTypeId(e.target.value)}
              required
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              {unitTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {unitIconMap[t.icon] ?? ''} {t.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Piętro</label>
              <input
                type="number"
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
                placeholder="np. 3"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Powierzchnia (m²)</label>
              <input
                type="number"
                step="0.01"
                value={areaSqm}
                onChange={(e) => setAreaSqm(e.target.value)}
                placeholder="np. 52.5"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Opis (opcjonalnie)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Dodatkowe informacje o lokalu"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Przypisanie mieszkańca */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">Przypisz mieszkańca</h2>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-sm text-gray-500">
                {assignResident ? 'Włączone' : 'Wyłączone'}
              </span>
              <div
                onClick={() => setAssignResident(!assignResident)}
                className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${
                  assignResident ? 'bg-blue-600' : 'bg-gray-300'
                }`}
              >
                <div
                  className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                    assignResident ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </div>
            </label>
          </div>

          {residents.length === 0 && (
            <p className="text-sm text-gray-400">
              Brak mieszkańców w budynku.{' '}
              <Link href={`/buildings/${buildingId}/residents/new`} className="text-blue-600 hover:underline">
                Dodaj mieszkańca
              </Link>{' '}
              najpierw.
            </p>
          )}

          {assignResident && residents.length > 0 && (
            <div className="space-y-3 pt-1">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mieszkaniec</label>
                <select
                  value={residentId}
                  onChange={(e) => setResidentId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {residents.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.firstName} {r.lastName} — {r.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Rola</label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as 'OWNER' | 'TENANT')}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="OWNER">Właściciel</option>
                    <option value="TENANT">Najemca</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Od kiedy</label>
                  <input
                    type="date"
                    value={sinceDate}
                    onChange={(e) => setSinceDate(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {loading ? 'Tworzenie...' : 'Dodaj lokal'}
          </button>
          <Link
            href={`/buildings/${buildingId}`}
            className="flex-1 text-center border border-gray-300 text-gray-700 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 transition"
          >
            Anuluj
          </Link>
        </div>
      </form>
    </div>
  )
}
