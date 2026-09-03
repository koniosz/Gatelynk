'use client'

// Konsjerż: lista gości w budynku + tworzenie/edycja/anulowanie zaproszenia.
// Faza 2 bety Villa Natura — np. taksówkarz przy szlabanie albo serwis.
// PIN do domofonu generowany po stronie Cloud, tablica synchronizowana z LPR
// natychmiast (PLATE_UPSERT/PLATE_DELETE → Edge → kamera).

import { Fragment, useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { conciergeApi } from '@/lib/concierge-api'
import {
  AccessEvent,
  TYPE_ICON,
  TYPE_LABEL,
  formatEventTs,
  gateStatus,
  gateStatusClass,
} from '@/lib/access-events'
import { formatRestrictions } from '@/lib/guest-restrictions'

const inp = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500'
const lbl = 'block text-xs text-gray-600 mb-1'

/** Relative time po polsku — spójnie z tabem Goście w BA v2. */
function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'przed chwilą'
  if (s < 3600) return `${Math.floor(s / 60)} min temu`
  if (s < 86400) return `${Math.floor(s / 3600)} godz. temu`
  return `${Math.floor(s / 86400)} dni temu`
}

function toLocalInput(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
}

const fmt = (d: string) =>
  new Date(d).toLocaleString('pl-PL', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })

export default function ConciergeGuestsPage() {
  const router = useRouter()

  const [guests, setGuests] = useState<any[]>([])
  const [residents, setResidents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [residentId, setResidentId] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [hasVehicle, setHasVehicle] = useState(false)
  const [plate, setPlate] = useState('')
  const [email, setEmail] = useState('')
  const [validFrom, setValidFrom] = useState('')
  const [validTo, setValidTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<number | null>(null)
  const [resendingId, setResendingId] = useState<number | null>(null)

  // Ostatnia aktywność per gość (feed access_events ?guestsOnly=true, 1 request)
  // + rozwijana historia per-gość (lazy ?guestId=). 2026-07-04.
  const [lastActivity, setLastActivity] = useState<Map<number, AccessEvent>>(new Map())
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [guestEvents, setGuestEvents] = useState<AccessEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      const [gRes, rRes, evRes] = await Promise.all([
        conciergeApi.get('/concierge/building/guests'),
        conciergeApi.get('/concierge/building/residents'),
        conciergeApi
          .get('/concierge/access-events?guestsOnly=true&limit=200')
          .catch(() => null), // starszy backend — kolumna aktywności po prostu pusta
      ])
      if (evRes) {
        const map = new Map<number, AccessEvent>()
        for (const ev of (evRes.data.events ?? []) as AccessEvent[]) {
          if (ev.guestId != null && !map.has(ev.guestId)) map.set(ev.guestId, ev)
        }
        setLastActivity(map)
      }
      // Lista pokazuje tylko aktywnych — wygasłe/anulowane idą do
      // /concierge/building/guests/history. Filter po stronie klienta:
      // backend wciąż zwraca wszystko (dla potencjalnych innych konsumentów).
      const now = Date.now()
      setGuests(
        gRes.data.filter(
          (g: any) =>
            g.status === 'ACTIVE' && new Date(g.validTo).getTime() > now,
        ),
      )
      setResidents(rRes.data)
    } catch {
      router.push('/concierge/login')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => { load() }, [load])

  const openForm = (g: any | null) => {
    setEditing(g)
    setError(null)
    if (g) {
      setResidentId(String(g.residentId))
      setName(g.name)
      setPhone(g.phone ?? '')
      setHasVehicle(!!g.vehiclePlate)
      setPlate(g.vehiclePlate ?? '')
      setEmail(g.email ?? '')
      setValidFrom(toLocalInput(g.validFrom))
      setValidTo(toLocalInput(g.validTo))
    } else {
      const now = new Date()
      const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000)
      setResidentId('')
      setName('')
      setPhone('')
      setHasVehicle(false)
      setPlate('')
      setEmail('')
      setValidFrom(toLocalInput(now))
      setValidTo(toLocalInput(tomorrow))
    }
    setShowForm(true)
  }

  const closeForm = () => {
    setShowForm(false)
    setEditing(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    setSaving(true); setError(null)
    try {
      const trimmedPlate = plate.trim().toUpperCase()
      const validFromISO = new Date(validFrom).toISOString()
      const validToISO = new Date(validTo).toISOString()

      if (editing) {
        await conciergeApi.patch(`/concierge/building/guests/${editing.id}`, {
          name: name.trim(),
          phone: phone.trim() === '' ? null : phone.trim(),
          vehiclePlate: hasVehicle ? trimmedPlate : null,
          validFrom: validFromISO,
          validTo: validToISO,
        })
      } else {
        if (!residentId) throw new Error('Wybierz mieszkańca')
        await conciergeApi.post('/concierge/building/guests', {
          residentId: +residentId,
          name: name.trim(),
          phone: phone.trim() || undefined,
          vehiclePlate: hasVehicle ? trimmedPlate : undefined,
          // Gdy email podany → backend wysyła Resend email z linkiem do portalu.
          email: email.trim() || undefined,
          validFrom: validFromISO,
          validTo: validToISO,
        })
      }
      await load()
      closeForm()
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? 'Błąd zapisu')
    } finally {
      setSaving(false)
    }
  }

  const cancelGuest = async (guestId: number) => {
    if (!confirm('Anulować zaproszenie? Gość nie wjedzie więcej i tablica zniknie z LPR.')) return
    setCancellingId(guestId)
    try {
      await conciergeApi.delete(`/concierge/building/guests/${guestId}`)
      await load()
    } catch (err: any) {
      alert(err?.response?.data?.message ?? 'Nie udało się anulować zaproszenia')
    } finally {
      setCancellingId(null)
    }
  }

  /**
   * Wysyła ponownie email z linkiem do portalu zaproszenia. Jeśli gość nie
   * ma zapisanego emaila, prompt o niego (i zapisze go w bazie). Pokazuje
   * alert z potwierdzeniem albo komunikatem błędu.
   */
  const resendEmail = async (g: any) => {
    let target = g.email
    if (!target) {
      target = window.prompt(`Podaj adres email dla ${g.name}:`)?.trim()
      if (!target) return
    }
    setResendingId(g.id)
    try {
      const res = await conciergeApi.post(`/concierge/building/guests/${g.id}/resend-email`, {
        email: target,
      })
      if (res.data?.sent) {
        alert(`✓ Email wysłany na ${res.data.email}`)
        await load()
      } else {
        alert(`⚠ Nie udało się wysłać emaila na ${target}. Sprawdź czy adres jest prawidłowy.`)
      }
    } catch (err: any) {
      alert(err?.response?.data?.message ?? 'Błąd wysyłania emaila')
    } finally {
      setResendingId(null)
    }
  }

  /** Toggle rozwijanej historii gościa — lazy fetch unified access_events. */
  const toggleHistory = async (guestId: number) => {
    if (expandedId === guestId) {
      setExpandedId(null)
      return
    }
    setExpandedId(guestId)
    setGuestEvents([])
    setEventsLoading(true)
    try {
      const res = await conciergeApi.get(`/concierge/access-events?guestId=${guestId}&limit=50`)
      setGuestEvents((res.data.events ?? []) as AccessEvent[])
    } catch {
      setGuestEvents([])
    } finally {
      setEventsLoading(false)
    }
  }

  if (loading) return <p className="text-gray-400">Ładowanie...</p>

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h1 className="font-semibold text-gray-800 text-lg">👤 Goście aktywni ({guests.length})</h1>
          <div className="flex gap-2">
            <Link href="/concierge/building/guests/history"
              className="bg-gray-100 text-gray-700 text-sm px-3 py-1.5 rounded-lg hover:bg-gray-200 border border-gray-200">
              📋 Historia zdarzeń
            </Link>
            <button onClick={() => openForm(null)}
              className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700">
              + Zaproś gościa
            </button>
          </div>
        </div>

        {showForm && (
          <form onSubmit={submit}
            className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
            <h3 className="text-sm font-semibold text-blue-800">
              {editing ? `Edycja: ${editing.name}` : 'Nowe zaproszenie'}
            </h3>

            {!editing && (
              <div>
                <label className={lbl}>Mieszkaniec (zaprasza) *</label>
                <select required value={residentId} onChange={(e) => setResidentId(e.target.value)}
                  className={inp}>
                  <option value="">— wybierz mieszkańca —</option>
                  {residents.map((r: any) => (
                    <option key={r.id} value={r.id}>{r.firstName} {r.lastName}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className={lbl}>Imię i nazwisko gościa *</label>
                <input required value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="np. Jan Kowalski" className={inp} />
              </div>
              <div>
                <label className={lbl}>Telefon</label>
                <input value={phone} onChange={(e) => setPhone(e.target.value)}
                  placeholder="+48..." className={inp} />
              </div>
            </div>

            {!editing && (
              <div>
                <label className={lbl}>
                  Email (opcjonalnie) — gość dostanie link do portalu
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="gosc@example.com"
                  className={inp}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Jeśli wpiszesz email, system od razu wyśle wiadomość z linkiem do
                  strony zaproszenia i kodem PIN.
                </p>
              </div>
            )}

            <div>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={hasVehicle}
                  onChange={(e) => setHasVehicle(e.target.checked)} />
                Przyjedzie samochodem
              </label>
              {hasVehicle && (
                <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())}
                  placeholder="Tablica rejestracyjna" className={`${inp} mt-2 font-mono uppercase`} />
              )}
              <p className="text-xs text-gray-500 mt-1">
                {hasVehicle
                  ? 'Tablica trafi do listy LPR na czas pobytu.'
                  : 'Pieszy gość — wystarczy PIN do domofonu.'}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className={lbl}>Ważne od *</label>
                <input required type="datetime-local" value={validFrom}
                  onChange={(e) => setValidFrom(e.target.value)} className={inp} />
              </div>
              <div>
                <label className={lbl}>Ważne do *</label>
                <input required type="datetime-local" value={validTo}
                  onChange={(e) => setValidTo(e.target.value)} className={inp} />
              </div>
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}

            <div className="flex gap-2">
              <button type="submit" disabled={saving}
                className="flex-1 bg-blue-600 text-white text-sm py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving ? 'Zapisywanie...' : editing ? 'Zapisz zmiany' : 'Zaproś gościa'}
              </button>
              <button type="button" onClick={closeForm}
                className="px-4 bg-gray-200 text-sm rounded-lg hover:bg-gray-300">
                Anuluj
              </button>
            </div>
          </form>
        )}

        {guests.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">Brak zaproszonych gości</p>
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-5 py-2">Gość</th>
                  <th className="text-left px-3 py-2">PIN</th>
                  <th className="text-left px-3 py-2">Tablica</th>
                  <th className="text-left px-3 py-2">Zaprosił</th>
                  <th className="text-left px-3 py-2">Od</th>
                  <th className="text-left px-3 py-2">Do</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-left px-3 py-2">Aktywność</th>
                  <th className="text-right px-5 py-2">Akcje</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {guests.map((g: any) => {
                  const isExpiredByDate = new Date(g.validTo) <= new Date()
                  const effectiveStatus =
                    g.status === 'ACTIVE' && isExpiredByDate ? 'EXPIRED' : g.status
                  const isActive = g.status === 'ACTIVE' && !isExpiredByDate
                  const statusLabel: Record<string, string> = {
                    ACTIVE: 'Aktywne', EXPIRED: 'Wygasło', CANCELLED: 'Anulowane',
                  }
                  const statusColor: Record<string, string> = {
                    ACTIVE: 'bg-green-100 text-green-700',
                    EXPIRED: 'bg-orange-100 text-orange-700',
                    CANCELLED: 'bg-red-100 text-red-700',
                  }
                  const last = lastActivity.get(g.id)
                  const isExpanded = expandedId === g.id
                  // Ograniczenia dostępu (read-only) — pola addytywne z nowszego
                  // backendu; stary nie zwraca → badge się nie renderuje.
                  const restrictions = formatRestrictions(g)
                  return (
                    <Fragment key={g.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-5 py-2">
                        <div className="font-medium text-gray-900 flex items-center gap-1.5">
                          {g.name}
                          {restrictions && (
                            <span
                              title={restrictions}
                              className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 whitespace-nowrap cursor-help">
                              🔒 Ograniczenia
                            </span>
                          )}
                        </div>
                        {g.phone && <div className="text-xs text-gray-400">{g.phone}</div>}
                        {restrictions && (
                          <div className="text-xs text-amber-600">{restrictions}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono font-bold text-blue-600">{g.pin}</td>
                      <td className="px-3 py-2 font-mono text-xs uppercase">
                        {g.vehiclePlate || <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {g.resident ? `${g.resident.firstName} ${g.resident.lastName}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">{fmt(g.validFrom)}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{fmt(g.validTo)}</td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${statusColor[effectiveStatus] ?? 'bg-gray-100 text-gray-700'}`}>
                          {statusLabel[effectiveStatus] ?? effectiveStatus}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <button
                          onClick={() => toggleHistory(g.id)}
                          title={last ? `${TYPE_LABEL[last.type]} · ${formatEventTs(last.ts)}` : 'Pokaż historię aktywności'}
                          className="text-gray-600 hover:text-blue-600 hover:underline whitespace-nowrap">
                          {last ? `${TYPE_ICON[last.type]} ${timeAgo(last.ts)}` : '—'}
                          <span className="ml-1 text-gray-400">{isExpanded ? '▲' : '▼'}</span>
                        </button>
                      </td>
                      <td className="px-5 py-2 text-right">
                        {isActive ? (
                          <div className="inline-flex gap-2 text-xs">
                            <button onClick={() => openForm(g)}
                              className="text-blue-600 hover:underline">Edytuj</button>
                            <button
                              disabled={resendingId === g.id || !g.urlToken}
                              onClick={() => resendEmail(g)}
                              title={g.email ? `Wyślij ponownie na ${g.email}` : 'Wprowadź email i wyślij link do portalu'}
                              className="text-emerald-600 hover:underline disabled:opacity-50">
                              {resendingId === g.id
                                ? '...'
                                : g.emailSentAt ? '↻ Email' : '✉ Wyślij email'}
                            </button>
                            <button
                              disabled={cancellingId === g.id}
                              onClick={() => cancelGuest(g.id)}
                              className="text-red-600 hover:underline disabled:opacity-50">
                              {cancellingId === g.id ? '...' : 'Anuluj'}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={9} className="px-5 py-3 bg-gray-50">
                          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                            🕐 Historia aktywności — {g.name}
                          </div>
                          {eventsLoading ? (
                            <p className="text-xs text-gray-400">Ładowanie…</p>
                          ) : guestEvents.length === 0 ? (
                            <p className="text-xs text-gray-400">
                              Brak zdarzeń — pojawią się gdy gość użyje PIN-u, wjedzie autem (LPR)
                              albo otworzy bramę przez portal.
                            </p>
                          ) : (
                            <div className="space-y-1.5">
                              {guestEvents.map((ev) => {
                                const gs = gateStatus(ev)
                                return (
                                  <div key={ev.id}
                                    className="flex items-center gap-3 bg-white border border-gray-200 rounded-lg px-3 py-1.5">
                                    <span>{TYPE_ICON[ev.type]}</span>
                                    <div className="flex-1 min-w-0">
                                      <span className="text-xs font-medium text-gray-800">
                                        {TYPE_LABEL[ev.type]}
                                      </span>
                                      {ev.plate && (
                                        <span className="ml-2 text-xs font-mono uppercase text-gray-600">{ev.plate}</span>
                                      )}
                                      {ev.accessPointLabel && (
                                        <span className="ml-2 text-xs text-gray-400">{ev.accessPointLabel}</span>
                                      )}
                                    </div>
                                    <span className={`text-xs px-1.5 py-0.5 rounded ${gateStatusClass(gs.tone)}`}
                                      title={gs.hint}>
                                      {gs.label}
                                    </span>
                                    <span className="text-xs text-gray-500 whitespace-nowrap">{formatEventTs(ev.ts)}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
