'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'

interface Resident { id: number; firstName: string; lastName: string; email: string; phone?: string }
interface UnitResident { id: number; resident: Resident; role: string; sinceDate: string; untilDate: string | null }
interface Stairwell { id: number; name: string }
interface Unit {
  id: number
  number: string
  floor: number | null
  areaSqm: string | null
  description: string | null
  stairwellId: number | null
  stairwell: Stairwell | null
  unitType: { name: string; icon: string }
  unitResidents: UnitResident[]
}

const roleLabel = (r: string) => r === 'OWNER' ? 'Właściciel' : 'Najemca'
const roleBadge = (r: string) => r === 'OWNER'
  ? 'bg-blue-50 text-blue-700 border border-blue-200'
  : 'bg-orange-50 text-orange-700 border border-orange-200'

const unitIconMap: Record<string, string> = {
  home: '🏠', apartment: '🏠', car: '🚗', garage: '🚗',
  archive: '📦', storage: '📦', waves: '🏊', pool: '🏊',
  dumbbell: '💪', gym: '💪', gamepad: '🎮', 'party-popper': '🎉',
}

export default function UnitDetailPage() {
  const { id: buildingId, unitId } = useParams()
  const [unit, setUnit] = useState<Unit | null>(null)
  const [allResidents, setAllResidents] = useState<Resident[]>([])
  const [stairwells, setStairwells] = useState<Stairwell[]>([])

  // Formularz przypisania
  const [showAssignForm, setShowAssignForm] = useState(false)
  const [assignResidentId, setAssignResidentId] = useState<string>('')
  const [assignRole, setAssignRole] = useState<'OWNER' | 'TENANT'>('OWNER')
  const [assignSince, setAssignSince] = useState(new Date().toISOString().split('T')[0])
  const [assigning, setAssigning] = useState(false)
  const [assignError, setAssignError] = useState<string | null>(null)

  // Edycja lokalu
  const [editMode, setEditMode] = useState(false)
  const [editNumber, setEditNumber] = useState('')
  const [editFloor, setEditFloor] = useState('')
  const [editArea, setEditArea] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editStairwellId, setEditStairwellId] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [unitRes, residentsRes, buildingRes] = await Promise.all([
      api.get(`/buildings/${buildingId}/units/${unitId}`),
      api.get(`/buildings/${buildingId}/residents`),
      api.get(`/buildings/${buildingId}`),
    ])
    setUnit(unitRes.data)
    setAllResidents(residentsRes.data)
    setStairwells(buildingRes.data.stairwells ?? [])
    // Ustaw domyślne wartości edycji
    const u = unitRes.data
    setEditNumber(u.number)
    setEditFloor(u.floor != null ? String(u.floor) : '')
    setEditArea(u.areaSqm ?? '')
    setEditDesc(u.description ?? '')
    setEditStairwellId(u.stairwellId != null ? String(u.stairwellId) : '')
  }, [buildingId, unitId])

  useEffect(() => { load() }, [load])

  const activeAssignments = unit?.unitResidents.filter((ur) => !ur.untilDate) ?? []
  const historyAssignments = unit?.unitResidents.filter((ur) => ur.untilDate) ?? []
  const assignedResidentIds = new Set(activeAssignments.map((a) => a.resident.id))
  const availableResidents = allResidents.filter((r) => !assignedResidentIds.has(r.id))

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!assignResidentId) return
    setAssigning(true)
    setAssignError(null)
    try {
      await api.post(`/buildings/${buildingId}/residents/${unitId}/assign`, {
        residentId: Number(assignResidentId),
        role: assignRole,
        sinceDate: assignSince,
      })
      setShowAssignForm(false)
      await load()
    } catch (err: any) {
      setAssignError(err?.response?.data?.message ?? 'Błąd przypisania')
    } finally { setAssigning(false) }
  }

  const handleEndAssignment = async (assignmentId: number) => {
    if (!confirm('Zakończyć to przypisanie?')) return
    await api.patch(`/buildings/${buildingId}/residents/assignments/${assignmentId}/end`, {})
    await load()
  }

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)
    try {
      await api.patch(`/buildings/${buildingId}/units/${unitId}`, {
        number: editNumber,
        floor: editFloor !== '' ? Number(editFloor) : null,
        areaSqm: editArea !== '' ? Number(editArea) : null,
        description: editDesc || null,
        stairwellId: editStairwellId !== '' ? Number(editStairwellId) : null,
      })
      setEditMode(false)
      await load()
    } catch (err: any) {
      setSaveError(err?.response?.data?.message ?? 'Błąd zapisu')
    } finally { setSaving(false) }
  }

  if (!unit) return <p className="text-gray-400 p-8">Ładowanie...</p>

  const icon = unitIconMap[unit.unitType.icon] ?? '🏠'

  return (
    <div className="max-w-2xl space-y-5">
      {/* Breadcrumb */}
      <div>
        <Link href={`/buildings/${buildingId}`} className="text-sm text-gray-400 hover:text-gray-600">
          ← Budynek
        </Link>
      </div>

      {/* Karta lokalu */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center text-3xl">
              {icon}
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Lokal {unit.number}</h1>
              <p className="text-sm text-gray-500 mt-0.5">{unit.unitType.name}</p>
              {unit.stairwell && !editMode && (
                <p className="text-xs text-blue-600 mt-0.5">🏛️ {unit.stairwell.name}</p>
              )}
            </div>
          </div>
          <button
            onClick={() => { setEditMode(!editMode); setSaveError(null) }}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            {editMode ? 'Anuluj' : '✏️ Edytuj'}
          </button>
        </div>

        {editMode ? (
          <form onSubmit={handleSaveEdit} className="mt-5 space-y-3">
            {saveError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{saveError}</div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Numer lokalu <span className="text-red-500">*</span></label>
                <input type="text" value={editNumber} onChange={(e) => setEditNumber(e.target.value)} required
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Piętro</label>
                <input type="number" value={editFloor} onChange={(e) => setEditFloor(e.target.value)}
                  placeholder="np. 3"
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Powierzchnia (m²)</label>
                <input type="number" step="0.01" value={editArea} onChange={(e) => setEditArea(e.target.value)}
                  placeholder="np. 52.5"
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Opis</label>
                <input type="text" value={editDesc} onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="Opcjonalnie"
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            {stairwells.length > 0 && (
              <div>
                <label className="block text-xs text-gray-600 mb-1">Klatka schodowa</label>
                <select value={editStairwellId} onChange={(e) => setEditStairwellId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">— Brak przypisania —</option>
                  {stairwells.map((sw) => (
                    <option key={sw.id} value={sw.id}>🏛️ {sw.name}</option>
                  ))}
                </select>
              </div>
            )}
            <button type="submit" disabled={saving}
              className="w-full bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition">
              {saving ? 'Zapisywanie...' : 'Zapisz zmiany'}
            </button>
          </form>
        ) : (
          <div className="mt-5 grid grid-cols-3 gap-3">
            <div className="bg-gray-50 rounded-lg px-4 py-3">
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Piętro</p>
              <p className="text-sm font-medium text-gray-900">{unit.floor != null ? unit.floor : '—'}</p>
            </div>
            <div className="bg-gray-50 rounded-lg px-4 py-3">
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Powierzchnia</p>
              <p className="text-sm font-medium text-gray-900">{unit.areaSqm ? `${unit.areaSqm} m²` : '—'}</p>
            </div>
            <div className="bg-gray-50 rounded-lg px-4 py-3">
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Zajęty</p>
              <p className="text-sm font-medium text-gray-900">
                {activeAssignments.length > 0
                  ? <span className="text-green-600">Tak ({activeAssignments.length})</span>
                  : <span className="text-gray-400">Wolny</span>
                }
              </p>
            </div>
            {unit.stairwell && (
              <div className="bg-blue-50 rounded-lg px-4 py-3">
                <p className="text-xs text-blue-400 uppercase tracking-wide mb-1">Klatka</p>
                <p className="text-sm font-medium text-blue-900">🏛️ {unit.stairwell.name}</p>
              </div>
            )}
            {unit.description && (
              <div className={`${unit.stairwell ? 'col-span-2' : 'col-span-3'} bg-gray-50 rounded-lg px-4 py-3`}>
                <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Opis</p>
                <p className="text-sm text-gray-700">{unit.description}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Aktualni mieszkańcy */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-800">
            Aktualni mieszkańcy
            {activeAssignments.length > 0 && (
              <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-normal">
                {activeAssignments.length}
              </span>
            )}
          </h2>
          {availableResidents.length > 0 && (
            <button
              onClick={() => {
                setShowAssignForm(!showAssignForm)
                setAssignResidentId(String(availableResidents[0]?.id))
                setAssignError(null)
              }}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              {showAssignForm ? 'Anuluj' : '+ Przypisz mieszkańca'}
            </button>
          )}
        </div>

        {showAssignForm && (
          <form onSubmit={handleAssign} className="border border-blue-200 bg-blue-50 rounded-lg p-4 mb-4 space-y-3">
            <p className="text-sm font-medium text-blue-800">Nowe przypisanie</p>
            {assignError && <p className="text-xs text-red-600">{assignError}</p>}
            <div>
              <label className="block text-xs text-gray-600 mb-1">Mieszkaniec</label>
              <select value={assignResidentId} onChange={(e) => setAssignResidentId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {availableResidents.map((r) => (
                  <option key={r.id} value={r.id}>{r.firstName} {r.lastName} — {r.email}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Rola</label>
                <select value={assignRole} onChange={(e) => setAssignRole(e.target.value as 'OWNER' | 'TENANT')}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="OWNER">Właściciel</option>
                  <option value="TENANT">Najemca</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Od kiedy</label>
                <input type="date" value={assignSince} onChange={(e) => setAssignSince(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <button type="submit" disabled={assigning}
              className="w-full bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {assigning ? 'Przypisywanie...' : 'Zapisz'}
            </button>
          </form>
        )}

        {activeAssignments.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-sm text-gray-400">Lokal jest wolny</p>
            {availableResidents.length === 0 && allResidents.length === 0 && (
              <p className="text-xs text-gray-400 mt-1">
                Brak mieszkańców w budynku.{' '}
                <Link href={`/buildings/${buildingId}/residents/new`} className="text-blue-600 hover:underline">
                  Dodaj mieszkańca
                </Link>
              </p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {activeAssignments.map((ur) => (
              <div key={ur.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-sm font-bold text-blue-600">
                    {ur.resident.firstName[0]}{ur.resident.lastName[0]}
                  </div>
                  <div>
                    <Link
                      href={`/buildings/${buildingId}/residents/${ur.resident.id}`}
                      className="text-sm font-medium text-gray-900 hover:text-blue-600"
                    >
                      {ur.resident.firstName} {ur.resident.lastName}
                    </Link>
                    <p className="text-xs text-gray-400">{ur.resident.email}</p>
                    <p className="text-xs text-gray-400">od {new Date(ur.sinceDate).toLocaleDateString('pl-PL')}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleBadge(ur.role)}`}>
                    {roleLabel(ur.role)}
                  </span>
                  <button
                    onClick={() => handleEndAssignment(ur.id)}
                    className="text-xs text-red-500 hover:text-red-700 hover:underline"
                  >
                    Zakończ
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Historia */}
      {historyAssignments.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <details>
            <summary className="font-semibold text-gray-800 cursor-pointer hover:text-gray-600 select-none">
              Historia przypisań ({historyAssignments.length})
            </summary>
            <div className="divide-y divide-gray-100 mt-4">
              {historyAssignments.map((ur) => (
                <div key={ur.id} className="flex items-center justify-between py-3 opacity-60">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-sm font-bold text-gray-500">
                      {ur.resident.firstName[0]}{ur.resident.lastName[0]}
                    </div>
                    <div>
                      <Link
                        href={`/buildings/${buildingId}/residents/${ur.resident.id}`}
                        className="text-sm font-medium text-gray-700 hover:text-blue-600"
                      >
                        {ur.resident.firstName} {ur.resident.lastName}
                      </Link>
                      <p className="text-xs text-gray-400">
                        {new Date(ur.sinceDate).toLocaleDateString('pl-PL')} –{' '}
                        {ur.untilDate ? new Date(ur.untilDate).toLocaleDateString('pl-PL') : ''}
                      </p>
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleBadge(ur.role)}`}>
                    {roleLabel(ur.role)}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
