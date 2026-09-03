'use client'
import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'

interface Unit { id: number; number: string; unitType: { name: string } }

interface UnitAssignment {
  unitId: string
  role: 'OWNER' | 'TENANT'
  sinceDate: string
}

export default function NewResidentPage() {
  const router = useRouter()
  const { id: buildingId } = useParams()

  const [units, setUnits] = useState<Unit[]>([])
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [assignments, setAssignments] = useState<UnitAssignment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const today = new Date().toISOString().split('T')[0]

  useEffect(() => {
    api.get(`/buildings/${buildingId}/units`).then((r) => setUnits(r.data))
  }, [buildingId])

  const addAssignment = () => {
    if (units.length === 0) return
    setAssignments((prev) => [
      ...prev,
      { unitId: String(units[0].id), role: 'OWNER', sinceDate: today },
    ])
  }

  const updateAssignment = (index: number, field: keyof UnitAssignment, value: string) => {
    setAssignments((prev) => prev.map((a, i) => (i === index ? { ...a, [field]: value } : a)))
  }

  const removeAssignment = (index: number) => {
    setAssignments((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      // 1. Utwórz mieszkańca
      const res = await api.post(`/buildings/${buildingId}/residents`, {
        firstName,
        lastName,
        email,
        phone: phone || undefined,
      })
      const newResidentId = res.data.id

      // 2. Przypisz do wybranych lokali
      for (const a of assignments) {
        await api.post(`/buildings/${buildingId}/residents/${a.unitId}/assign`, {
          residentId: newResidentId,
          role: a.role,
          sinceDate: a.sinceDate,
        })
      }

      router.push(`/buildings/${buildingId}/residents/${newResidentId}`)
    } catch (err: any) {
      setError(err?.response?.data?.message ?? 'Błąd podczas dodawania mieszkańca')
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
        <h1 className="text-2xl font-bold text-gray-900 mt-1">Nowy mieszkaniec</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Dane osobowe */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <h2 className="font-semibold text-gray-800">Dane osobowe</h2>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Imię <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                placeholder="Jan"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Nazwisko <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                required
                placeholder="Kowalski"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email <span className="text-red-500">*</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="jan.kowalski@example.com"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Telefon (opcjonalnie)
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+48 600 000 000"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Przypisanie lokali */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">Przypisz do lokali</h2>
            <button
              type="button"
              onClick={addAssignment}
              disabled={units.length === 0}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium disabled:opacity-40"
            >
              + Dodaj lokal
            </button>
          </div>

          {units.length === 0 && (
            <p className="text-sm text-gray-400">Brak dostępnych lokali w tym budynku</p>
          )}

          {assignments.length === 0 && units.length > 0 && (
            <p className="text-sm text-gray-400">Kliknij „+ Dodaj lokal" aby przypisać mieszkańca do lokalu</p>
          )}

          {assignments.map((a, i) => (
            <div key={i} className="border border-gray-200 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Lokal {i + 1}</span>
                <button
                  type="button"
                  onClick={() => removeAssignment(i)}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  Usuń
                </button>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Lokal</label>
                <select
                  value={a.unitId}
                  onChange={(e) => updateAssignment(i, 'unitId', e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.number} — {u.unitType.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Rola</label>
                  <select
                    value={a.role}
                    onChange={(e) => updateAssignment(i, 'role', e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="OWNER">Właściciel</option>
                    <option value="TENANT">Najemca</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Od kiedy</label>
                  <input
                    type="date"
                    value={a.sinceDate}
                    onChange={(e) => updateAssignment(i, 'sinceDate', e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="flex-1 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {loading ? 'Dodawanie...' : 'Dodaj mieszkańca'}
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
