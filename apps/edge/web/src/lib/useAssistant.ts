/**
 * useAssistant — hook do SSE-based Edge AI chat.
 *
 * Łączy się z `GET /assistant/ask-stream?q=...` przez `EventSource`, agreguje
 * tokeny w `streamingAnswer`, zbiera trace narzędzi w `currentTools`.
 *
 * UI używa tego tak:
 *   const { messages, send, status, currentTools, streamingAnswer } = useAssistant()
 *   <button onClick={() => send('Czy był dziś kurier?')} />
 *   {streamingAnswer && <div>{streamingAnswer}</div>}    // live tokens
 *
 * Po zakończeniu streamingu, ostatnia odpowiedź ląduje w `messages` jako
 * `{ role: 'assistant', content, tools }`, a `streamingAnswer` wraca do ''.
 *
 * Status:
 *   'idle' — czeka na pytanie
 *   'streaming' — leci odpowiedź (UI pokazuje cursor)
 *   'error' — ostatni call failed (UI pokazuje toast)
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToolTrace {
  name: string
  args: Record<string, any>
  resultPreview?: string
  durationMs?: number
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  tools?: ToolTrace[]
  totalMs?: number
  error?: string
}

export type AssistantStatus = 'idle' | 'streaming' | 'error'

export function useAssistant() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState<AssistantStatus>('idle')
  const [available, setAvailable] = useState<boolean | null>(null)
  const [streamingAnswer, setStreamingAnswer] = useState('')
  const [currentTools, setCurrentTools] = useState<ToolTrace[]>([])
  const [error, setError] = useState<string | null>(null)
  // Smart mode: LLM-generated natural responses + follow-up suggestions.
  // Trade-off: 7-14s vs 5-15ms template mode. Persisted w localStorage.
  const [smartMode, setSmartModeState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    const saved = window.localStorage.getItem('gl_assistant_smart')
    return saved === null ? true : saved === '1'
  })
  const setSmartMode = useCallback((on: boolean) => {
    setSmartModeState(on)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('gl_assistant_smart', on ? '1' : '0')
    }
  }, [])
  // Follow-up suggestions z ostatniej assistant response (smart-mode tylko).
  const [followUps, setFollowUps] = useState<string[]>([])
  // AbortController + ref do messages — żeby `send` widział aktualny stan
  // (closure problem: `send` z useCallback widzi messages w momencie tworzenia
  // callbacka, nie w momencie wywołania, gdyby user szybko klikał).
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  useEffect(() => { messagesRef.current = messages }, [messages])

  // Sprawdź dostępność Ollama przy mount + co 30s
  useEffect(() => {
    let cancelled = false
    const check = () => {
      fetch('/assistant/status')
        .then((r) => r.ok ? r.json() : Promise.reject(r.status))
        .then((d) => { if (!cancelled) setAvailable(!!d.available) })
        .catch(() => { if (!cancelled) setAvailable(false) })
    }
    check()
    const t = setInterval(check, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  // Abort streamingu na unmount (np. user zamknął drawer w trakcie odpowiedzi)
  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  /**
   * Wysyła nowe pytanie + pełną historię konwersacji (max 6 ostatnich tur)
   * do backendu przez POST. Body: { question, history }.
   *
   * Czemu NIE EventSource: nie wspiera POST, więc historię trzeba by enkodować
   * w URL — niepraktyczne (limit długości, problemy z znakami specjalnymi).
   * Zamiast tego: `fetch` z `body.getReader()` parsuje SSE wire format ręcznie.
   */
  const send = useCallback(async (question: string) => {
    const q = question.trim()
    if (!q || status === 'streaming') return

    // Append user message immediately
    setMessages((prev) => [...prev, { role: 'user', content: q }])
    setStreamingAnswer('')
    setCurrentTools([])
    setError(null)
    setStatus('streaming')

    // Abort any prior stream
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    // Build history payload — TYLKO user/assistant + non-empty content.
    // Wycinamy `error: true` wpisy z asystenta (były błędy, nie part konwersacji).
    const history = messagesRef.current
      .filter((m) =>
        (m.role === 'user' || m.role === 'assistant') &&
        !m.error &&
        m.content.trim().length > 0,
      )
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const localTools: ToolTrace[] = []
    let accumulated = ''
    let receivedDone = false

    try {
      const res = await fetch('/assistant/ask-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history, smart: smartMode }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      // SSE parser — frames are `event: <name>\ndata: <payload>\n\n`.
      // Multiple frames per chunk possible; split on '\n\n'.
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)

          let eventName = ''
          const dataLines: string[] = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) eventName = line.slice(7)
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
          }
          const data = dataLines.join('\n')

          if (eventName === 'tool-start') {
            try {
              const t = JSON.parse(data) as ToolTrace
              localTools.push(t)
              setCurrentTools([...localTools])
            } catch { /* ignore */ }
          } else if (eventName === 'tool-done') {
            try {
              const t = JSON.parse(data) as ToolTrace
              const i = localTools.findIndex((x) => x.name === t.name && (x as any).resultPreview === undefined)
              if (i >= 0) localTools[i] = t
              else localTools.push(t)
              setCurrentTools([...localTools])
            } catch { /* ignore */ }
          } else if (eventName === 'token') {
            accumulated += data
            setStreamingAnswer(accumulated)
          } else if (eventName === 'done') {
            receivedDone = true
            try {
              const result = JSON.parse(data) as {
                answer: string
                trace: ToolTrace[]
                totalMs: number
                followUps?: string[]
              }
              const finalAnswer = result.answer || accumulated
              setMessages((prev) => [...prev, {
                role: 'assistant',
                content: finalAnswer,
                tools: result.trace ?? localTools,
                totalMs: result.totalMs,
              }])
              // Update follow-ups dla UI (smart-mode tylko)
              setFollowUps(Array.isArray(result.followUps) ? result.followUps : [])
            } catch {
              setMessages((prev) => [...prev, { role: 'assistant', content: accumulated, tools: localTools }])
              setFollowUps([])
            }
          } else if (eventName === 'error') {
            let errMsg = 'Stream error'
            try { errMsg = JSON.parse(data).message ?? errMsg } catch { /* ignore */ }
            throw new Error(errMsg)
          }
        }
      }

      if (!receivedDone) {
        // Stream finished without `done` — fall back to whatever we got.
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: accumulated || '(empty response)',
          tools: localTools,
        }])
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // user-initiated abort, nic nie zapisuj
      } else {
        const errMsg = err?.message ?? String(err)
        setError(errMsg)
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: '',
          error: errMsg,
          tools: localTools,
        }])
        setStatus('error')
      }
    } finally {
      setStreamingAnswer('')
      setCurrentTools([])
      if (!ctrl.signal.aborted) setStatus('idle')
      abortRef.current = null
    }
  }, [status, smartMode])

  const clear = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setMessages([])
    setStreamingAnswer('')
    setCurrentTools([])
    setError(null)
    setFollowUps([])
    setStatus('idle')
  }, [])

  return {
    messages, status, available,
    streamingAnswer, currentTools, error,
    send, clear,
    smartMode, setSmartMode,
    followUps,
  }
}
