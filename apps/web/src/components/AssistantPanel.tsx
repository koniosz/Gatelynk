'use client'
/**
 * AssistantPanel — chat-style UI dla GateLynk AI Assistant.
 *
 * Reusable component używany przez:
 *   • BA panel (apps/web/.../building-admin/buildings/[id]/assistant/page.tsx)
 *     endpointPath: `/building-admin/buildings/${id}/assistant/ask`
 *     apiClient: buildingAdminApi
 *   • Concierge panel (apps/web/.../concierge/building/assistant/page.tsx)
 *     endpointPath: `/concierge/assistant/ask`
 *     apiClient: conciergeApi
 *
 * UI:
 *   • Header z toggle "Tryb mądry" (smart mode)
 *   • Scrollable feed bubbles (user prawo niebieski, AI lewo biały)
 *   • Follow-up chips pod ostatnią AI bubble
 *   • Composer textarea + send button
 *
 * Multi-turn: trzymamy `messages` in-memory + wysyłamy last 6 jako `history`
 * w body (Cloud forwarduje do Edge → prototype rewrite-uje zaimki/elipsy).
 *
 * Auth/baseURL pochodzą z passed-in `apiClient` (axios instance). Component
 * nie wie czy to BA czy Concierge — zero coupling z auth logic.
 */
import { useEffect, useRef, useState } from 'react'
import type { AxiosInstance } from 'axios'

interface AssistantPanelProps {
  /** Axios instance z baseURL + Authorization header bearer JWT. */
  apiClient: AxiosInstance
  /** Path względem axios baseURL, np. "/building-admin/buildings/9/assistant/ask". */
  endpointPath: string
  /** Optional UI header label. Default "Asystent AI". */
  title?: string
  /** Optional sample prompts shown w empty state. */
  samplePrompts?: string[]
}

interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  intent?: string
  totalMs?: number
  modelUsed?: string
  followUps?: string[]
  rewrittenQuestion?: string
}

interface AssistantResponse {
  answer: string
  intent?: string
  totalMs?: number
  modelUsed?: string
  followUps?: string[]
  rewrittenQuestion?: string
}

const DEFAULT_SAMPLES = [
  'Co ciekawego działo się w ostatniej godzinie?',
  'Kto jest administratorem osiedla?',
  'Ile białych aut dziś wjechało?',
  'Czy był dzisiaj DHL?',
]

const HISTORY_TURNS = 6

export default function AssistantPanel({
  apiClient,
  endpointPath,
  title = 'Asystent AI',
  samplePrompts = DEFAULT_SAMPLES,
}: AssistantPanelProps) {
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [draft, setDraft] = useState('')
  const [smart, setSmart] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Scroll-to-bottom przy każdej nowej wiadomości / loading-spinner.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, loading])

  async function send(question: string) {
    const trimmed = question.trim()
    if (!trimmed || loading) return

    // History = ostatnie 6 wiadomości PRZED dorzuceniem aktualnego pytania.
    const history = messages.slice(-HISTORY_TURNS).map((m) => ({
      role: m.role,
      content: m.text.slice(0, 1000),
    }))

    const userMsg: AssistantMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: trimmed,
    }
    setMessages((prev) => [...prev, userMsg])
    setDraft('')
    setLoading(true)
    setError(null)

    try {
      const res = await apiClient.post<AssistantResponse>(endpointPath, {
        question: trimmed,
        smart,
        history: history.length > 0 ? history : undefined,
      })
      const aiMsg: AssistantMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        text: res.data.answer,
        intent: res.data.intent,
        totalMs: res.data.totalMs,
        modelUsed: res.data.modelUsed,
        followUps: res.data.followUps,
        rewrittenQuestion: res.data.rewrittenQuestion,
      }
      setMessages((prev) => [...prev, aiMsg])
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ??
        err?.message ??
        'Asystent niedostępny'
      setError(String(msg))
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    void send(draft)
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter wysyła; Shift+Enter dodaje newline (UX z większości chat UI).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(draft)
    }
  }

  function newConversation() {
    setMessages([])
    setError(null)
  }

  const lastMsg = messages[messages.length - 1]
  const showFollowUps =
    lastMsg?.role === 'assistant' &&
    Array.isArray(lastMsg.followUps) &&
    lastMsg.followUps.length > 0

  return (
    <div className="flex h-full flex-col bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="text-purple-500 text-xl">✨</span>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={smart}
              onChange={(e) => setSmart(e.target.checked)}
              className="h-4 w-4 accent-purple-500"
            />
            Tryb mądry
          </label>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={newConversation}
              className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Nowa rozmowa
            </button>
          )}
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-gray-50 dark:bg-gray-950">
        {messages.length === 0 && (
          <EmptyState samplePrompts={samplePrompts} onPick={send} />
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <UserBubble key={m.id} text={m.text} />
          ) : (
            <AIBubble key={m.id} msg={m} />
          ),
        )}
        {loading && <LoadingBubble smart={smart} />}
        {showFollowUps && (
          <FollowUpChips
            chips={lastMsg.followUps!}
            onPick={(c) => void send(c)}
          />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Error banner */}
      {error && (
        <div className="border-t border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-5 py-2 text-sm text-red-700 dark:text-red-300 flex items-center justify-between">
          <span>⚠️ {error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-xs text-red-600 dark:text-red-400 hover:underline"
          >
            zamknij
          </button>
        </div>
      )}

      {/* Composer */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-5 py-3"
      >
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Zadaj pytanie..."
            rows={1}
            disabled={loading}
            className="flex-1 resize-none rounded-2xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 disabled:opacity-50"
            style={{ maxHeight: 120, minHeight: 38 }}
          />
          <button
            type="submit"
            disabled={loading || !draft.trim()}
            className="rounded-full bg-purple-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-600 disabled:bg-gray-300 dark:disabled:bg-gray-700"
          >
            ➤
          </button>
        </div>
        <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
          Shift+Enter = nowa linia · Enter = wyślij
        </p>
      </form>
    </div>
  )
}

// ─── sub-components ────────────────────────────────────────────────────────

function EmptyState({
  samplePrompts,
  onPick,
}: {
  samplePrompts: string[]
  onPick: (q: string) => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
      <div className="text-4xl">✨</div>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Zapytaj GateLynk AI o aktywność osiedla — LPR, kamery, dokumenty.
      </p>
      <div className="mt-2 flex w-full max-w-md flex-col gap-2">
        {samplePrompts.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:border-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950/30"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-purple-500 px-4 py-2 text-sm text-white shadow-sm whitespace-pre-wrap">
        {text}
      </div>
    </div>
  )
}

function AIBubble({ msg }: { msg: AssistantMessage }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        <div className="rounded-2xl rounded-bl-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm text-gray-900 dark:text-gray-100 shadow-sm whitespace-pre-wrap">
          {msg.text}
        </div>
        {(msg.intent || msg.totalMs || msg.rewrittenQuestion) && (
          <div className="mt-1 flex flex-wrap items-center gap-2 px-2 text-[10px] text-gray-400 dark:text-gray-500">
            {msg.intent && (
              <span className="rounded-full bg-purple-100 dark:bg-purple-900/30 px-2 py-0.5 text-purple-700 dark:text-purple-300">
                {msg.intent}
              </span>
            )}
            {msg.totalMs != null && <span>{msg.totalMs} ms</span>}
            {msg.modelUsed && <span>· {msg.modelUsed}</span>}
            {msg.rewrittenQuestion && (
              <span title={msg.rewrittenQuestion} className="italic">
                · rewrite: „{msg.rewrittenQuestion.slice(0, 50)}{msg.rewrittenQuestion.length > 50 ? '…' : ''}"
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function LoadingBubble({ smart }: { smart: boolean }) {
  return (
    <div className="flex justify-start">
      <div className="rounded-2xl rounded-bl-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm text-gray-500 dark:text-gray-400 shadow-sm">
        <span className="inline-flex items-center gap-1">
          <span className="animate-bounce">·</span>
          <span className="animate-bounce [animation-delay:120ms]">·</span>
          <span className="animate-bounce [animation-delay:240ms]">·</span>
        </span>
        <span className="ml-2">{smart ? 'Myślę…' : 'Sprawdzam…'}</span>
      </div>
    </div>
  )
}

function FollowUpChips({
  chips,
  onPick,
}: {
  chips: string[]
  onPick: (chip: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2 pl-2">
      {chips.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick(c)}
          className="rounded-full border border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/40 px-3 py-1 text-xs font-medium text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/60"
        >
          {c}
        </button>
      ))}
    </div>
  )
}
