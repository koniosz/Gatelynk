'use client'
/**
 * Faza 4 — Zgłoszenia konsjerża.
 *
 * Konsjerż widzi tylko ticket-y typu `CONCIERGE` w swoim budynku (filtruje
 * backend po `tickets.type`). Może odpowiadać + zmieniać status (OPEN /
 * IN_PROGRESS / DONE). Pierwsza odpowiedź konsjerża automatycznie przesuwa
 * ticket z OPEN → IN_PROGRESS (parytet z BA flow).
 *
 * Layout świadomie kopiuje wzorzec z BA dashboard (`buildings/[id]/page.tsx`
 * tab "tickets") żeby konsjerż widzący oba panele nie musiał się przestawiać.
 * Różnice:
 *   • bez filtra po kategorii (concierge ticket-y są zazwyczaj „przesyłka",
 *     „odebrałem kuriera" — kategoria mniej istotna niż w admin tickets)
 *   • avatar/imię odpowiedzi: ADMIN/CONCIERGE/RESIDENT bubble — patrz
 *     `authorBubbleStyle()` poniżej. Backend zwraca `authorName` z join-a
 *     po `authorId` (Faza 4 migration).
 */
import { useCallback, useEffect, useState } from 'react'
import { conciergeApi } from '@/lib/concierge-api'

type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE'
type TicketStatusFilter = 'ALL' | TicketStatus

interface TicketReply {
  id: number
  authorType: 'RESIDENT' | 'ADMIN' | 'CONCIERGE'
  authorId: number | null
  authorName: string | null
  body: string
  createdAt: string
}

interface Ticket {
  id: number
  buildingId: number
  residentId: number
  category: 'ISSUE' | 'FEEDBACK' | 'QUESTION' | 'OTHER'
  type: 'ADMIN' | 'CONCIERGE'
  title: string
  body: string
  photo: string | null
  status: TicketStatus
  createdAt: string
  updatedAt: string
  resident: {
    id: number
    firstName: string
    lastName: string
    email: string | null
    avatar: string | null
  }
  replies: TicketReply[]
}

const CATEGORY_LABEL: Record<string, string> = {
  ISSUE: '🔧 Usterka', FEEDBACK: '💬 Uwaga', QUESTION: '❓ Pytanie', OTHER: '📌 Inne',
}
const STATUS_CFG: Record<TicketStatus, { label: string; cls: string }> = {
  OPEN:        { label: 'Otwarte',    cls: 'bg-red-50 text-red-600 border-red-200' },
  IN_PROGRESS: { label: 'W toku',     cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  DONE:        { label: 'Zakończone', cls: 'bg-green-50 text-green-700 border-green-200' },
}

export default function ConciergeTicketsPage() {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<TicketStatusFilter>('ALL')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [replyBody, setReplyBody] = useState<Record<number, string>>({})
  const [replySending, setReplySending] = useState<number | null>(null)
  const [statusUpdating, setStatusUpdating] = useState<number | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    conciergeApi.get('/concierge/building/tickets')
      .then((res) => setTickets(res.data as Ticket[]))
      .catch((err) => { if (err?.response?.status !== 401) console.error(err) })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // Polling co 30s — żeby nowe ticket-y od mieszkańców wpadały bez F5.
  // Symetrycznie do BA dashboard.
  useEffect(() => {
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const handleReply = async (ticketId: number) => {
    const body = (replyBody[ticketId] ?? '').trim()
    if (!body) return
    setReplySending(ticketId)
    try {
      await conciergeApi.post(`/concierge/building/tickets/${ticketId}/replies`, { body })
      setReplyBody((p) => ({ ...p, [ticketId]: '' }))
      load()
    } catch (err: any) {
      alert(err?.response?.data?.message ?? 'Nie udało się wysłać odpowiedzi')
    } finally {
      setReplySending(null)
    }
  }

  const handleStatus = async (ticketId: number, status: TicketStatus) => {
    setStatusUpdating(ticketId)
    try {
      await conciergeApi.patch(`/concierge/building/tickets/${ticketId}/status`, { status })
      load()
    } catch (err: any) {
      alert(err?.response?.data?.message ?? 'Nie udało się zmienić statusu')
    } finally {
      setStatusUpdating(null)
    }
  }

  const openCount = tickets.filter((t) => t.status === 'OPEN').length
  const filtered = filter === 'ALL' ? tickets : tickets.filter((t) => t.status === filter)

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            🎫 Zgłoszenia
            {openCount > 0 && (
              <span className="ml-2 text-sm font-semibold bg-red-100 text-red-600 border border-red-200 px-2 py-0.5 rounded-full align-middle">
                {openCount} otwarte
              </span>
            )}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Zgłoszenia mieszkańców zaadresowane do konsjerża (paczki, kurierzy,
            sprawy bieżące). Sprawy techniczne i administracyjne trafiają do
            administratora osiedla.
          </p>
        </div>
        <button
          onClick={load}
          className="text-sm px-3 py-1.5 rounded-lg bg-white border border-gray-200 hover:bg-gray-50"
        >
          ↻ Odśwież
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex gap-1">
            {(['ALL', 'OPEN', 'IN_PROGRESS', 'DONE'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-xs px-3 py-1 rounded-full border transition ${
                  filter === f
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                }`}
              >
                {f === 'ALL' ? 'Wszystkie' : f === 'OPEN' ? 'Otwarte' : f === 'IN_PROGRESS' ? 'W toku' : 'Zakończone'}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-gray-400 text-center py-8">Ładowanie…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">
            {filter === 'ALL'
              ? 'Brak zgłoszeń do konsjerża. Mieszkańcy mogą zaadresować zgłoszenie do konsjerża z poziomu aplikacji mobilnej.'
              : 'Brak zgłoszeń w tej kategorii'}
          </p>
        ) : (
          <div className="divide-y divide-gray-100 -mx-5">
            {filtered.map((ticket) => {
              const isExpanded = expanded === ticket.id
              const st = STATUS_CFG[ticket.status] ?? STATUS_CFG.OPEN
              return (
                <div key={ticket.id} className="px-5">
                  <div
                    className="py-3 flex items-start justify-between gap-3 cursor-pointer hover:bg-gray-50 -mx-5 px-5"
                    onClick={() => setExpanded(isExpanded ? null : ticket.id)}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-400">
                          {CATEGORY_LABEL[ticket.category] ?? '📌 Inne'}
                        </span>
                        <p className="text-sm font-medium text-gray-900">{ticket.title}</p>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {ticket.resident?.firstName} {ticket.resident?.lastName}
                        {' · '}
                        {new Date(ticket.createdAt).toLocaleDateString('pl-PL', {
                          day: '2-digit', month: '2-digit', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                        {ticket.replies?.length > 0 && ` · 💬 ${ticket.replies.length}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-xs border px-2 py-0.5 rounded-full ${st.cls}`}>
                        {st.label}
                      </span>
                      <span className="text-gray-300">{isExpanded ? '▲' : '▼'}</span>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="pb-4 space-y-3">
                      <div className="bg-gray-50 rounded-lg p-3">
                        <p className="text-sm text-gray-700 whitespace-pre-wrap">{ticket.body}</p>
                      </div>

                      {ticket.photo && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={ticket.photo}
                          alt="Załączone zdjęcie"
                          className="max-h-64 rounded-lg border border-gray-200 object-contain"
                        />
                      )}

                      {ticket.replies?.length > 0 && (
                        <div className="space-y-2">
                          {ticket.replies.map((reply) => (
                            <ReplyBubble
                              key={reply.id}
                              reply={reply}
                              residentName={`${ticket.resident.firstName} ${ticket.resident.lastName}`}
                            />
                          ))}
                        </div>
                      )}

                      <div className="space-y-2">
                        <textarea
                          value={replyBody[ticket.id] ?? ''}
                          onChange={(e) =>
                            setReplyBody((p) => ({ ...p, [ticket.id]: e.target.value }))
                          }
                          placeholder="Odpowiedź dla mieszkańca…"
                          rows={2}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
                        />
                        <div className="flex gap-2 flex-wrap">
                          <button
                            onClick={() => handleReply(ticket.id)}
                            disabled={replySending === ticket.id || !replyBody[ticket.id]?.trim()}
                            className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                          >
                            {replySending === ticket.id ? 'Wysyłanie…' : '💬 Odpowiedz'}
                          </button>
                          <select
                            value={ticket.status}
                            onChange={(e) => handleStatus(ticket.id, e.target.value as TicketStatus)}
                            disabled={statusUpdating === ticket.id}
                            className="text-xs border border-gray-300 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                          >
                            <option value="OPEN">Otwarte</option>
                            <option value="IN_PROGRESS">W toku</option>
                            <option value="DONE">Zakończone</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** Bubble odpowiedzi w rozmowie. Trzy warianty zależnie od `authorType`:
 *  - RESIDENT (white, lewy)  — wiadomość od mieszkańca
 *  - ADMIN (blue, prawy)     — admin osiedla
 *  - CONCIERGE (emerald, prawy) — konsjerż (my); własne odpowiedzi w innym
 *    kolorze niż admin, żeby było wyraźnie widać kto co napisał gdy ticket
 *    wcześniej trafił do admina i został przekierowany.
 */
function ReplyBubble({ reply, residentName }: { reply: TicketReply; residentName: string }) {
  const baseCls = 'rounded-lg p-3 text-sm border'
  let bubbleCls = ''
  let authorIcon = ''
  let authorLabel = ''
  switch (reply.authorType) {
    case 'ADMIN':
      bubbleCls = 'bg-blue-50 border-blue-100 ml-8'
      authorIcon = '🏢'
      authorLabel = reply.authorName ?? 'Administrator'
      break
    case 'CONCIERGE':
      bubbleCls = 'bg-emerald-50 border-emerald-100 ml-8'
      authorIcon = '🛎'
      authorLabel = reply.authorName ?? 'Konsjerż'
      break
    case 'RESIDENT':
    default:
      bubbleCls = 'bg-white border-gray-200 mr-8'
      authorIcon = '👤'
      authorLabel = residentName
      break
  }
  return (
    <div className={`${baseCls} ${bubbleCls}`}>
      <p className="text-xs font-medium mb-1 text-gray-500">
        {authorIcon} {authorLabel}
        {' · '}
        {new Date(reply.createdAt).toLocaleDateString('pl-PL', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        })}
      </p>
      <p className="text-gray-700 whitespace-pre-wrap">{reply.body}</p>
    </div>
  )
}
