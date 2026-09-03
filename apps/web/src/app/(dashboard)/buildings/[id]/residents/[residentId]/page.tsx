'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'

interface UnitType { name: string }
interface Unit { id: number; number: string; unitType: UnitType }
interface UnitResident { id: number; unit: Unit; role: string; sinceDate: string; untilDate: string | null }
interface Resident {
  id: number; firstName: string; lastName: string
  email: string; phone?: string; createdAt: string
  unitResidents: UnitResident[]
}
interface Notification { id: number; title: string; body: string; sentAt: string }

const roleLabel = (r: string) => r === 'OWNER' ? 'Właściciel' : 'Najemca'
const roleBadge = (r: string) => r === 'OWNER'
  ? 'bg-blue-50 text-blue-700 border border-blue-200'
  : 'bg-orange-50 text-orange-700 border border-orange-200'

export default function ResidentDetailPage() {
  const { id: buildingId, residentId } = useParams()
  const [resident, setResident] = useState<Resident | null>(null)
  const [allUnits, setAllUnits] = useState<Unit[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [tab, setTab] = useState<'units' | 'messages'>('units')

  // Formularz przypisania lokalu
  const [showAssignForm, setShowAssignForm] = useState(false)
  const [newUnitId, setNewUnitId] = useState<string>('')
  const [newRole, setNewRole] = useState<'OWNER' | 'TENANT'>('OWNER')
  const [newSinceDate, setNewSinceDate] = useState(new Date().toISOString().split('T')[0])
  const [assigning, setAssigning] = useState(false)
  const [assignError, setAssignError] = useState<string | null>(null)

  // Formularz wiadomości push
  const [pushTitle, setPushTitle] = useState('')
  const [pushBody, setPushBody] = useState('')
  const [sending, setSending] = useState(false)
  const [sendSuccess, setSendSuccess] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [resRes, unitsRes, notifRes] = await Promise.all([
      api.get(`/buildings/${buildingId}/residents/${residentId}`),
      api.get(`/buildings/${buildingId}/units`),
      api.get(`/buildings/${buildingId}/notifications/resident/${residentId}`).catch(() => ({ data: [] })),
    ])
    setResident(resRes.data)
    setAllUnits(unitsRes.data)
    setNotifications(notifRes.data)
  }, [buildingId, residentId])

  useEffect(() => { load() }, [load])

  const activeAssignments = resident?.unitResidents.filter((ur) => !ur.untilDate) ?? []
  const historyAssignments = resident?.unitResidents.filter((ur) => ur.untilDate) ?? []
  const activeUnitIds = new Set(activeAssignments.map((a) => a.unit.id))
  const availableUnits = allUnits.filter((u) => !activeUnitIds.has(u.id))

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault()
    setAssigning(true)
    setAssignError(null)
    try {
      await api.post(`/buildings/${buildingId}/residents/${newUnitId}/assign`, {
        residentId: Number(residentId), role: newRole, sinceDate: newSinceDate,
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

  const handleSendPush = async (e: React.FormEvent) => {
    e.preventDefault()
    setSending(true)
    setSendError(null)
    setSendSuccess(false)
    try {
      await api.post(`/buildings/${buildingId}/notifications`, {
        residentId: Number(residentId), title: pushTitle, body: pushBody,
      })
      setSendSuccess(true)
      setPushTitle('')
      setPushBody('')
      await load()
    } catch (err: any) {
      setSendError(err?.response?.data?.message ?? 'Błąd wysyłania wiadomości')
    } finally { setSending(false) }
  }

  if (!resident) return <p className="text-gray-400 p-8">Ładowanie...</p>

  return (
    <div className="max-w-2xl space-y-5">
      {/* Breadcrumb */}
      <div>
        <Link href={`/buildings/${buildingId}`} className="text-sm text-gray-400 hover:text-gray-600">
          ← Budynek
        </Link>
      </div>

      {/* Karta mieszkańca */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-blue-100 flex items-center justify-center text-2xl font-bold text-blue-600">
              {resident.firstName[0]}{resident.lastName[0]}
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">
                {resident.firstName} {resident.lastName}
              </h1>
              <p className="text-sm text-gray-500 mt-0.5">
                Mieszkaniec od {new Date(resident.createdAt).toLocaleDateString('pl-PL')}
              </p>
            </div>
          </div>
        </div>

        {/* Dane kontaktowe */}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="bg-gray-50 rounded-lg px-4 py-3">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Email</p>
            <a href={`mailto:${resident.email}`} className="text-sm font-medium text-blue-600 hover:underline">
              {resident.email}
            </a>
          </div>
          <div className="bg-gray-50 rounded-lg px-4 py-3">
            <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Telefon</p>
            {resident.phone
              ? <a href={`tel:${resident.phone}`} className="text-sm font-medium text-blue-600 hover:underline">{resident.phone}</a>
              : <span className="text-sm text-gray-400">—</span>
            }
          </div>
        </div>

        {/* Skróty aktywnych lokali */}
        {activeAssignments.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {activeAssignments.map((ur) => (
              <span key={ur.id} className={`text-xs px-2.5 py-1 rounded-full font-medium ${roleBadge(ur.role)}`}>
                Lokal {ur.unit.number} · {ur.unit.unitType.name} · {roleLabel(ur.role)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Zakładki */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
        {([
          { key: 'units', label: `Lokale (${activeAssignments.length})` },
          { key: 'messages', label: `Wiadomości push (${notifications.length})` },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition ${
              tab === key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* === ZAKŁADKA LOKALE === */}
      {tab === 'units' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800">Przypisane lokale</h2>
            {availableUnits.length > 0 && (
              <button
                onClick={() => { setShowAssignForm(!showAssignForm); setNewUnitId(String(availableUnits[0]?.id)); setAssignError(null) }}
                className="text-sm text-blue-600 hover:text-blue-800 font-medium"
              >
                {showAssignForm ? 'Anuluj' : '+ Przypisz lokal'}
              </button>
            )}
          </div>

          {showAssignForm && (
            <form onSubmit={handleAssign} className="border border-blue-200 bg-blue-50 rounded-lg p-4 mb-4 space-y-3">
              <p className="text-sm font-medium text-blue-800">Nowe przypisanie</p>
              {assignError && <p className="text-xs text-red-600">{assignError}</p>}
              <select value={newUnitId} onChange={(e) => setNewUnitId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                {availableUnits.map((u) => (
                  <option key={u.id} value={u.id}>{u.number} — {u.unitType.name}</option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Rola</label>
                  <select value={newRole} onChange={(e) => setNewRole(e.target.value as any)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="OWNER">Właściciel</option>
                    <option value="TENANT">Najemca</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Od kiedy</label>
                  <input type="date" value={newSinceDate} onChange={(e) => setNewSinceDate(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <button type="submit" disabled={assigning}
                className="w-full bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {assigning ? 'Przypisywanie...' : 'Zapisz'}
              </button>
            </form>
          )}

          {activeAssignments.length === 0
            ? <p className="text-sm text-gray-400 text-center py-4">Brak przypisanych lokali</p>
            : <div className="divide-y divide-gray-100">
                {activeAssignments.map((ur) => (
                  <div key={ur.id} className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="font-medium text-gray-900 text-sm">
                          Lokal {ur.unit.number}
                          <span className="ml-1.5 text-gray-400 font-normal">{ur.unit.unitType.name}</span>
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">od {new Date(ur.sinceDate).toLocaleDateString('pl-PL')}</p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleBadge(ur.role)}`}>{roleLabel(ur.role)}</span>
                    </div>
                    <button onClick={() => handleEndAssignment(ur.id)}
                      className="text-xs text-red-500 hover:text-red-700 hover:underline">Zakończ</button>
                  </div>
                ))}
              </div>
          }

          {historyAssignments.length > 0 && (
            <details className="mt-4">
              <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">
                Historia ({historyAssignments.length})
              </summary>
              <div className="divide-y divide-gray-100 mt-2">
                {historyAssignments.map((ur) => (
                  <div key={ur.id} className="flex items-center justify-between py-2.5 opacity-50">
                    <div>
                      <p className="text-sm text-gray-700">Lokal {ur.unit.number} — {ur.unit.unitType.name}</p>
                      <p className="text-xs text-gray-400">
                        {new Date(ur.sinceDate).toLocaleDateString('pl-PL')} –{' '}
                        {ur.untilDate ? new Date(ur.untilDate).toLocaleDateString('pl-PL') : ''}
                      </p>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${roleBadge(ur.role)}`}>{roleLabel(ur.role)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* === ZAKŁADKA WIADOMOŚCI PUSH === */}
      {tab === 'messages' && (
        <div className="space-y-4">
          {/* Formularz wysyłania */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-800 mb-4">Wyślij wiadomość push</h2>
            <form onSubmit={handleSendPush} className="space-y-3">
              {sendError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">{sendError}</div>
              )}
              {sendSuccess && (
                <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3">
                  ✓ Wiadomość wysłana! Pojawi się na urządzeniu mieszkańca.
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tytuł <span className="text-red-500">*</span></label>
                <input type="text" value={pushTitle} onChange={(e) => setPushTitle(e.target.value)} required
                  placeholder="np. Ważne ogłoszenie" maxLength={100}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Treść <span className="text-red-500">*</span></label>
                <textarea value={pushBody} onChange={(e) => setPushBody(e.target.value)} required
                  rows={3} placeholder="np. Planowana przerwa w dostawie wody 15.03 godz. 10-14" maxLength={500}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
                <p className="text-xs text-gray-400 mt-1 text-right">{pushBody.length}/500</p>
              </div>
              <button type="submit" disabled={sending}
                className="w-full bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition">
                {sending ? 'Wysyłanie...' : '📨 Wyślij wiadomość push'}
              </button>
            </form>
          </div>

          {/* Historia wiadomości */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-800 mb-4">Historia wiadomości</h2>
            {notifications.length === 0
              ? <p className="text-sm text-gray-400 text-center py-4">Brak wysłanych wiadomości</p>
              : <div className="space-y-3">
                  {notifications.map((n) => (
                    <div key={n.id} className="border border-gray-100 rounded-lg p-4 bg-gray-50">
                      <div className="flex items-start justify-between">
                        <p className="text-sm font-semibold text-gray-900">{n.title}</p>
                        <span className="text-xs text-gray-400 ml-2 flex-shrink-0">
                          {new Date(n.sentAt).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">{n.body}</p>
                    </div>
                  ))}
                </div>
            }
          </div>
        </div>
      )}
    </div>
  )
}
