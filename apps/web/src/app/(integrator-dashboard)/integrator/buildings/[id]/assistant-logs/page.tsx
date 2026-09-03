'use client'
/**
 * IntegratorAssistantLogsPage (FAZA 8.h.25 — 2026-06-12).
 *
 * TYMCZASOWY panel do oceny odpowiedzi GateLynk AI. Każde pytanie residenta
 * (iOS) i BA (panel) jest logowane przez Cloud (assistant_query_logs).
 * Integrator przegląda pary Q/A i ocenia checkboxem OK / NIE OK — ocenione
 * pary staną się datasetem do dostrojenia LLM (eval catalog 8.h.21).
 *
 * Endpointy:
 *   GET   /integrator/buildings/:id/assistant-logs?limit&offset&rating
 *   PATCH /integrator/buildings/:id/assistant-logs/:logId  { ratingOk }
 *
 * UX: filtr chips (Wszystkie/Nieocenione/OK/Złe), tabela z expandable
 * odpowiedzią, toggle OK/NIE OK (drugi klik w aktywny przycisk cofa ocenę).
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Bot, Check, ChevronDown, ChevronUp, X } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'

interface AssistantLog {
  id: number
  buildingId: number
  role: 'RESIDENT' | 'BUILDING_ADMIN' | string
  userId: number | null
  question: string
  answer: string
  intent: string | null
  totalMs: number | null
  model: string | null
  smart: boolean
  ratingOk: boolean | null
  ratedAt: string | null
  createdAt: string
}

interface LogsResponse {
  items: AssistantLog[]
  total: number
  unrated: number
  limit: number
  offset: number
}

type RatingFilter = 'all' | 'unrated' | 'ok' | 'bad'

const PAGE_SIZE = 50

const FILTERS: Array<{ key: RatingFilter; label: string }> = [
  { key: 'all', label: 'Wszystkie' },
  { key: 'unrated', label: 'Nieocenione' },
  { key: 'ok', label: 'OK' },
  { key: 'bad', label: 'Złe' },
]

export default function IntegratorAssistantLogsPage() {
  const { id } = useParams()
  const buildingId = id as string

  const [data, setData] = useState<LogsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<RatingFilter>('all')
  const [offset, setOffset] = useState(0)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
      if (filter !== 'all') params.set('rating', filter)
      const res = await integratorApi.get(
        `/integrator/buildings/${buildingId}/assistant-logs?${params}`,
      )
      setData(res.data)
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Nie udało się pobrać logów')
    } finally {
      setLoading(false)
    }
  }, [buildingId, filter, offset])

  useEffect(() => {
    load()
    const onRefresh = () => load()
    window.addEventListener('integrator:refresh', onRefresh)
    return () => window.removeEventListener('integrator:refresh', onRefresh)
  }, [load])

  // Optimistic toggle: klik OK na już-OK → cofa ocenę (null).
  const rate = async (log: AssistantLog, value: boolean) => {
    const next = log.ratingOk === value ? null : value
    setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((l) => (l.id === log.id ? { ...l, ratingOk: next } : l)),
          }
        : prev,
    )
    try {
      await integratorApi.patch(
        `/integrator/buildings/${buildingId}/assistant-logs/${log.id}`,
        { ratingOk: next },
      )
    } catch {
      // rollback przy błędzie
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((l) =>
                l.id === log.id ? { ...l, ratingOk: log.ratingOk } : l,
              ),
            }
          : prev,
      )
    }
  }

  const toggleExpand = (logId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(logId)) next.delete(logId)
      else next.add(logId)
      return next
    })
  }

  const changeFilter = (f: RatingFilter) => {
    setFilter(f)
    setOffset(0)
  }

  const total = data?.total ?? 0
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <Link
          href={`/integrator/buildings/${buildingId}`}
          className="text-muted hover:text-ink-2 transition-colors"
          title="Wróć do obiektu"
        >
          <ArrowLeft size={18} />
        </Link>
        <div className="w-9 h-9 rounded-xl bg-violet-100 flex items-center justify-center">
          <Bot size={18} className="text-violet-600" />
        </div>
        <div>
          <h1 className="text-[16px] font-semibold text-ink-2">Logi GateLynk AI</h1>
          <p className="text-[12px] text-muted">
            Tymczasowy panel oceny odpowiedzi — ocenione pary Q/A posłużą do dostrojenia LLM
          </p>
        </div>
      </div>

      {/* Filtry + licznik */}
      <div className="flex items-center gap-2 mt-5 mb-4 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => changeFilter(f.key)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors ${
              filter === f.key
                ? 'bg-violet-600 border-violet-600 text-white'
                : 'bg-white border-gray-200 text-ink-2 hover:border-violet-300'
            }`}
          >
            {f.label}
            {f.key === 'unrated' && data && data.unrated > 0 && (
              <span
                className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${
                  filter === f.key ? 'bg-white/20' : 'bg-amber-100 text-amber-700'
                }`}
              >
                {data.unrated}
              </span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        <span className="text-[12px] text-muted">
          {total} {total === 1 ? 'wpis' : total < 5 && total > 0 ? 'wpisy' : 'wpisów'}
        </span>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-[13px] text-red-700 mb-4">
          {error}
        </div>
      )}

      {/* Lista logów */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading && !data ? (
          <div className="py-12 text-center text-[13px] text-muted">Ładowanie…</div>
        ) : !data || data.items.length === 0 ? (
          <div className="py-12 text-center">
            <Bot size={36} strokeWidth={1.5} className="text-gray-300 mx-auto mb-2" />
            <p className="text-[13px] text-muted">
              {filter === 'all'
                ? 'Brak zapisanych pytań — logi pojawią się gdy ktoś zapyta GateLynk AI'
                : 'Brak wpisów dla tego filtra'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.items.map((log) => {
              const isExpanded = expanded.has(log.id)
              const answerLong = log.answer.length > 220
              return (
                <li key={log.id} className="p-4 hover:bg-gray-50/60 transition-colors">
                  {/* Meta row */}
                  <div className="flex items-center gap-2 flex-wrap mb-1.5 text-[11px]">
                    <span className="text-muted tabular-nums">
                      {new Date(log.createdAt).toLocaleString('pl-PL', {
                        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded font-medium ${
                        log.role === 'RESIDENT'
                          ? 'bg-blue-50 text-blue-700'
                          : 'bg-purple-50 text-purple-700'
                      }`}
                    >
                      {log.role === 'RESIDENT' ? 'Mieszkaniec' : 'Administrator'}
                    </span>
                    {log.intent && (
                      <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-mono">
                        {log.intent}
                      </span>
                    )}
                    {log.model && (
                      <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                        {log.model}
                      </span>
                    )}
                    {log.totalMs != null && (
                      <span className="text-muted tabular-nums">{log.totalMs} ms</span>
                    )}
                  </div>

                  {/* Q + A + rating */}
                  <div className="flex gap-3 items-start">
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-ink-2 mb-1">
                        {log.question}
                      </p>
                      <p className="text-[13px] text-gray-600 whitespace-pre-wrap">
                        {isExpanded || !answerLong
                          ? log.answer
                          : `${log.answer.slice(0, 220)}…`}
                      </p>
                      {answerLong && (
                        <button
                          onClick={() => toggleExpand(log.id)}
                          className="mt-1 text-[11px] text-violet-600 hover:text-violet-800 font-medium inline-flex items-center gap-0.5"
                        >
                          {isExpanded ? (
                            <>Zwiń <ChevronUp size={12} /></>
                          ) : (
                            <>Pokaż całość <ChevronDown size={12} /></>
                          )}
                        </button>
                      )}
                    </div>

                    {/* Ocena */}
                    <div className="flex gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => rate(log, true)}
                        title={log.ratingOk === true ? 'Cofnij ocenę' : 'Odpowiedź OK'}
                        className={`w-9 h-9 rounded-lg border flex items-center justify-center transition-colors ${
                          log.ratingOk === true
                            ? 'bg-emerald-500 border-emerald-500 text-white'
                            : 'bg-white border-gray-200 text-gray-400 hover:border-emerald-400 hover:text-emerald-500'
                        }`}
                      >
                        <Check size={16} strokeWidth={2.5} />
                      </button>
                      <button
                        onClick={() => rate(log, false)}
                        title={log.ratingOk === false ? 'Cofnij ocenę' : 'Odpowiedź NIE OK'}
                        className={`w-9 h-9 rounded-lg border flex items-center justify-center transition-colors ${
                          log.ratingOk === false
                            ? 'bg-red-500 border-red-500 text-white'
                            : 'bg-white border-gray-200 text-gray-400 hover:border-red-400 hover:text-red-500'
                        }`}
                      >
                        <X size={16} strokeWidth={2.5} />
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Paginacja */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 text-[12px]">
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
            className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-ink-2 disabled:opacity-40 hover:border-violet-300 transition-colors"
          >
            ← Poprzednia
          </button>
          <span className="text-muted">
            Strona {page} z {pages}
          </span>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= total}
            className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-ink-2 disabled:opacity-40 hover:border-violet-300 transition-colors"
          >
            Następna →
          </button>
        </div>
      )}
    </div>
  )
}
