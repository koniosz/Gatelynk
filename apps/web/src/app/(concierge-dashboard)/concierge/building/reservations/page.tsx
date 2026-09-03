'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { conciergeApi } from '@/lib/concierge-api'

// ─── Helpers ────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function fmtTime(dt: string) {
  return new Date(dt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
}

function fmtDate(dt: string) {
  return new Date(dt).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function generateSlots(openTime: string, closeTime: string): string[] {
  const slots: string[] = []
  const [oh, om] = openTime.split(':').map(Number)
  const [ch, cm] = closeTime.split(':').map(Number)
  let cur = oh * 60 + om
  const end = ch * 60 + cm
  while (cur < end) {
    const h = String(Math.floor(cur / 60)).padStart(2, '0')
    const m = String(cur % 60).padStart(2, '0')
    slots.push(`${h}:${m}`)
    cur += 30
  }
  return slots
}

const DAYS_PL = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd']
const MONTHS_PL = [
  'Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec',
  'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień',
]

// ─── Mini Calendar ───────────────────────────────────────────────────────────
function MiniCalendar({ selected, onChange }: { selected: string; onChange: (d: string) => void }) {
  const selDate = new Date(selected + 'T00:00:00')
  const [viewYear, setViewYear] = useState(selDate.getFullYear())
  const [viewMonth, setViewMonth] = useState(selDate.getMonth()) // 0-based

  const today = todayStr()
  const firstDay = new Date(viewYear, viewMonth, 1)
  // Monday = 0 offset (ISO week)
  const startOffset = (firstDay.getDay() + 6) % 7
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1) }
    else setViewMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1) }
    else setViewMonth(m => m + 1)
  }

  const cells: (number | null)[] = [
    ...Array(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  // Pad to full weeks
  while (cells.length % 7 !== 0) cells.push(null)

  const toStr = (day: number) =>
    `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 select-none">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <button onClick={prevMonth}
          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition">
          ‹
        </button>
        <span className="text-sm font-semibold text-gray-800">
          {MONTHS_PL[viewMonth]} {viewYear}
        </span>
        <button onClick={nextMonth}
          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500 transition">
          ›
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 mb-1">
        {DAYS_PL.map((d) => (
          <div key={d} className="text-center text-xs font-medium text-gray-400 py-1">{d}</div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-y-0.5">
        {cells.map((day, i) => {
          if (!day) return <div key={`e-${i}`} />
          const str = toStr(day)
          const isToday = str === today
          const isSel = str === selected
          return (
            <button
              key={str}
              onClick={() => onChange(str)}
              className={`
                w-full aspect-square flex items-center justify-center rounded-lg text-xs font-medium transition
                ${isSel
                  ? 'bg-blue-600 text-white shadow-sm'
                  : isToday
                  ? 'bg-blue-50 text-blue-700 font-bold ring-1 ring-blue-300'
                  : 'text-gray-700 hover:bg-gray-100'}
              `}>
              {day}
            </button>
          )
        })}
      </div>

      {/* Footer: go to today */}
      {selected !== today && (
        <div className="mt-3 text-center">
          <button onClick={() => {
            const t = new Date(today + 'T00:00:00')
            setViewYear(t.getFullYear())
            setViewMonth(t.getMonth())
            onChange(today)
          }}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium">
            Dzisiaj
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function ConciergeReservationsPage() {
  const router = useRouter()
  const [commonAreas, setCommonAreas] = useState<any[]>([])
  const [residents, setResidents] = useState<any[]>([])
  const [selectedArea, setSelectedArea] = useState<any | null>(null)
  const [date, setDate] = useState(todayStr())
  const [reservations, setReservations] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [resLoading, setResLoading] = useState(false)

  // Create reservation modal
  const [showModal, setShowModal] = useState(false)
  const [modalStartTime, setModalStartTime] = useState('')
  const [modalEndTime, setModalEndTime] = useState('')
  const [modalResidentId, setModalResidentId] = useState('')
  const [modalNote, setModalNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Cancel
  const [cancellingId, setCancellingId] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([
      conciergeApi.get('/concierge/building/common-areas'),
      conciergeApi.get('/concierge/building/residents'),
    ])
      .then(([aRes, rRes]) => {
        setCommonAreas(aRes.data)
        setResidents(rRes.data)
        if (aRes.data.length > 0) setSelectedArea(aRes.data[0])
      })
      .catch(() => router.push('/concierge/login'))
      .finally(() => setLoading(false))
  }, [router])

  const loadReservations = useCallback(async () => {
    if (!selectedArea) return
    setResLoading(true)
    try {
      const r = await conciergeApi.get(
        `/concierge/building/common-areas/${selectedArea.id}/reservations?date=${date}`,
      )
      setReservations(r.data)
    } catch { } finally { setResLoading(false) }
  }, [selectedArea, date])

  useEffect(() => { loadReservations() }, [loadReservations])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true); setSaveError(null)
    try {
      const startAt = `${date}T${modalStartTime}:00`
      const endAt = `${date}T${modalEndTime}:00`
      await conciergeApi.post('/concierge/building/reservations', {
        unitId: selectedArea.id,
        residentId: +modalResidentId,
        startAt,
        endAt,
        note: modalNote || undefined,
      })
      setShowModal(false)
      setModalStartTime(''); setModalEndTime(''); setModalResidentId(''); setModalNote('')
      loadReservations()
    } catch (err: any) {
      setSaveError(err?.response?.data?.message ?? 'Błąd rezerwacji')
    } finally { setSaving(false) }
  }

  const handleCancel = async (resId: number) => {
    if (!confirm('Anulować tę rezerwację?')) return
    setCancellingId(resId)
    try {
      await conciergeApi.patch(`/concierge/building/reservations/${resId}/cancel`, {})
      loadReservations()
    } catch { } finally { setCancellingId(null) }
  }

  const openNewReservation = (startSlot: string) => {
    const settings = selectedArea?.commonAreaSettings
    const maxMin = settings?.maxSlotMinutes ?? 60
    const [sh, sm] = startSlot.split(':').map(Number)
    const endTotalMin = sh * 60 + sm + maxMin
    const eh = String(Math.floor(endTotalMin / 60)).padStart(2, '0')
    const em = String(endTotalMin % 60).padStart(2, '0')
    setModalStartTime(startSlot)
    setModalEndTime(`${eh}:${em}`)
    setModalResidentId('')
    setModalNote('')
    setSaveError(null)
    setShowModal(true)
  }

  if (loading) return <p className="text-gray-400">Ładowanie...</p>

  if (commonAreas.length === 0) {
    return (
      <div className="max-w-xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">📅 Rezerwacje</h1>
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-4xl mb-3">🏛️</p>
          <p className="text-gray-500 text-sm">Brak części wspólnych do rezerwacji.</p>
          <p className="text-gray-400 text-xs mt-1">Administrator musi dodać sauna, siłownia itp. jako części wspólne.</p>
        </div>
      </div>
    )
  }

  const settings = selectedArea?.commonAreaSettings
  const slots = settings ? generateSlots(settings.openTime, settings.closeTime) : []

  const slotToRes: Record<string, any> = {}
  reservations.forEach((res) => {
    const start = fmtTime(res.startAt)
    slotToRes[start] = res
  })

  const occupiedSlots = new Set<string>()
  reservations.forEach((res) => {
    slots.forEach((slot) => {
      const [sh, sm] = slot.split(':').map(Number)
      const slotMs = sh * 60 + sm
      const [rsh, rsm] = fmtTime(res.startAt).split(':').map(Number)
      const [reh, rem] = fmtTime(res.endAt).split(':').map(Number)
      const rStart = rsh * 60 + rsm
      const rEnd = reh * 60 + rem
      if (slotMs >= rStart && slotMs < rEnd) {
        occupiedSlots.add(slot)
      }
    })
  })

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">📅 Rezerwacje</h1>

      {/* Area selector */}
      <div className="mb-5">
        <select
          value={selectedArea?.id ?? ''}
          onChange={(e) => {
            const area = commonAreas.find((a) => a.id === +e.target.value)
            setSelectedArea(area ?? null)
          }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          {commonAreas.map((a) => (
            <option key={a.id} value={a.id}>{a.unitType?.name} {a.number}</option>
          ))}
        </select>
      </div>

      {/* Settings info */}
      {settings ? (
        <div className="mb-5 text-xs text-gray-400 flex gap-3 flex-wrap">
          <span>⏱ Maks. {settings.maxSlotMinutes} min</span>
          <span>🕐 {settings.openTime}–{settings.closeTime}</span>
          {settings.isPaid && settings.pricePerHour && <span>💰 {settings.pricePerHour} zł/h</span>}
        </div>
      ) : (
        <div className="mb-5 bg-amber-50 border border-amber-200 text-amber-700 text-sm rounded-lg p-3">
          ⚠️ Brak ustawień rezerwacji dla tej części wspólnej. Administrator musi skonfigurować godziny i max. czas.
        </div>
      )}

      {/* Main 3-col layout */}
      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr_1fr] gap-6 items-start">

        {/* ── Kalendarz ── */}
        <div className="space-y-3">
          <MiniCalendar selected={date} onChange={setDate} />
          <p className="text-xs text-center text-gray-400">
            {new Date(date + 'T00:00:00').toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>

        {/* ── Harmonogram ── */}
        {settings ? (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              📋 Harmonogram
            </h3>
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {resLoading ? (
                <p className="text-center text-gray-400 text-sm py-8">Ładowanie...</p>
              ) : slots.length === 0 ? (
                <p className="text-center text-gray-400 text-sm py-8">Brak slotów</p>
              ) : (
                slots.map((slot) => {
                  const isOccupied = occupiedSlots.has(slot)
                  const isStart = slotToRes[slot]
                  const res = isStart
                  return (
                    <div key={slot}
                      onClick={() => !isOccupied && openNewReservation(slot)}
                      className={`flex items-center gap-3 px-4 py-2 border-b border-gray-50 last:border-0 transition ${
                        isOccupied
                          ? 'bg-blue-50 cursor-default'
                          : 'hover:bg-green-50 cursor-pointer'
                      }`}>
                      <span className="text-xs text-gray-400 w-12 flex-shrink-0">{slot}</span>
                      {isOccupied ? (
                        <span className="text-xs text-blue-700 font-medium truncate">
                          {isStart
                            ? `${res.resident?.firstName} ${res.resident?.lastName} (${fmtTime(res.startAt)}–${fmtTime(res.endAt)})`
                            : ''}
                        </span>
                      ) : (
                        <span className="text-xs text-green-600">+ wolny</span>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        ) : <div />}

        {/* ── Lista rezerwacji ── */}
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">
            📋 Rezerwacje ({reservations.length})
            {settings && (
              <button onClick={() => openNewReservation(settings.openTime)}
                className="ml-3 text-xs text-blue-600 hover:text-blue-800 font-normal">
                + Nowa
              </button>
            )}
          </h3>
          {resLoading ? (
            <p className="text-center text-gray-400 text-sm py-8">Ładowanie...</p>
          ) : reservations.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
              <p className="text-gray-400 text-sm">Brak rezerwacji na ten dzień</p>
              {settings && (
                <button onClick={() => openNewReservation(settings.openTime)}
                  className="mt-3 bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700">
                  + Zarezerwuj
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {reservations.map((res) => {
                const isPaid = res.isPaid && res.pricePaid != null
                return (
                  <div key={res.id}
                    className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-start justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {res.resident?.firstName} {res.resident?.lastName}
                      </p>
                      <p className="text-xs text-gray-500">
                        {fmtTime(res.startAt)} – {fmtTime(res.endAt)}
                        {isPaid && <span className="ml-2 text-blue-600">💰 {Number(res.pricePaid).toFixed(2)} zł</span>}
                      </p>
                      {res.note && <p className="text-xs text-gray-400 mt-0.5 italic">{res.note}</p>}
                    </div>
                    <button
                      onClick={() => handleCancel(res.id)}
                      disabled={cancellingId === res.id}
                      className="text-xs text-gray-400 hover:text-red-600 ml-3 flex-shrink-0 disabled:opacity-50">
                      {cancellingId === res.id ? '...' : '❌'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Create reservation modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false) }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-1">📅 Nowa rezerwacja</h3>
            <p className="text-sm text-gray-500 mb-4">
              {selectedArea?.unitType?.name} {selectedArea?.number} · {fmtDate(date)}
            </p>
            <form onSubmit={handleCreate} className="space-y-3">
              {saveError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">
                  {saveError}
                </div>
              )}
              <div>
                <label className="block text-xs text-gray-600 mb-1">Mieszkaniec *</label>
                <select required value={modalResidentId} onChange={(e) => setModalResidentId(e.target.value)}
                  className={inp}>
                  <option value="">— Wybierz —</option>
                  {residents.map((r) => (
                    <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Czas od *</label>
                  <input type="time" required value={modalStartTime} onChange={(e) => setModalStartTime(e.target.value)} className={inp} />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Czas do *</label>
                  <input type="time" required value={modalEndTime} onChange={(e) => setModalEndTime(e.target.value)} className={inp} />
                </div>
              </div>
              {settings?.isPaid && settings?.pricePerHour && modalStartTime && modalEndTime && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-700">
                  💰 Szacowany koszt:{' '}
                  <strong>
                    {(() => {
                      const [sh, sm] = modalStartTime.split(':').map(Number)
                      const [eh, em] = modalEndTime.split(':').map(Number)
                      const hours = (eh * 60 + em - (sh * 60 + sm)) / 60
                      return (Math.ceil(hours) * Number(settings.pricePerHour)).toFixed(2)
                    })()} zł
                  </strong>
                  <span className="text-xs text-blue-500 ml-1">(płatność na miejscu)</span>
                </div>
              )}
              <div>
                <label className="block text-xs text-gray-600 mb-1">Notatka</label>
                <input type="text" value={modalNote} onChange={(e) => setModalNote(e.target.value)}
                  placeholder="Opcjonalna notatka..." className={inp} />
              </div>
              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={saving}
                  className="flex-1 bg-blue-600 text-white text-sm font-medium py-2.5 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {saving ? 'Rezerwuję...' : '✅ Zarezerwuj'}
                </button>
                <button type="button" onClick={() => setShowModal(false)}
                  className="flex-1 border border-gray-300 text-gray-700 text-sm py-2.5 rounded-lg hover:bg-gray-50">
                  Anuluj
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

const inp = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
