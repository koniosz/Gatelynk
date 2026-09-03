/**
 * Hook do streamu logów Edge.
 *
 * Backend:
 *   GET  /logs         → historia (do 500 entries z bufora `EventLogService`)
 *   GET  /logs/stream  → SSE EventSource (catch-up 50 + live append)
 *
 * Lokalnie:
 *   • Circular buffer 500 entries — większe wpisy auto-shift
 *   • Dedup po `id` (catch-up + history mogą dublować się przy connect)
 *   • Pause — wstrzymuje append (live entries lecą do `pendingCount`,
 *     po unpause wrzucamy wszystkie hurtem)
 *   • Auto-reconnect (EventSource robi to natywnie, ale exposujemy status)
 */
import { useEffect, useRef, useState, useCallback } from 'react'

export type LogLevel = 'info' | 'success' | 'warning' | 'error' | 'debug'

export interface LogEntry {
  id: number
  ts: string
  level: LogLevel
  category: string
  message: string
  detail?: string
}

const MAX_BUFFER = 500

export function useLogs() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [connected, setConnected] = useState(false)
  const [paused, setPaused] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const pausedRef = useRef(paused)
  const pendingRef = useRef<LogEntry[]>([])
  const seenIdsRef = useRef<Set<number>>(new Set())

  useEffect(() => { pausedRef.current = paused }, [paused])

  // Helper — dorzuca entry do bufora (z dedup + circular shift).
  const appendEntry = useCallback((entry: LogEntry) => {
    if (seenIdsRef.current.has(entry.id)) return
    seenIdsRef.current.add(entry.id)

    if (pausedRef.current) {
      // W trakcie pauzy — zachowaj w bufor, pokaż dopiero po unpause
      pendingRef.current.push(entry)
      setPendingCount(pendingRef.current.length)
      return
    }

    setEntries((prev) => {
      const next = [...prev, entry]
      if (next.length > MAX_BUFFER) {
        const dropped = next.splice(0, next.length - MAX_BUFFER)
        // Także usuń id-y z seen set żeby pamięć nie rosła w nieskończoność
        for (const d of dropped) seenIdsRef.current.delete(d.id)
      }
      return next
    })
  }, [])

  // 1. Initial fetch historii
  useEffect(() => {
    let cancelled = false
    fetch('/logs')
      .then((r) => r.json())
      .then((data: LogEntry[]) => {
        if (cancelled) return
        // Dodajemy id-y do dedup-seta przed setEntries — żeby SSE catch-up
        // nie wrzucił duplikatów na pierwsze sekundy.
        for (const e of data) seenIdsRef.current.add(e.id)
        setEntries(data)
      })
      .catch((err) => {
        if (!cancelled) setError(`Nie udało się załadować historii: ${err.message}`)
      })
    return () => { cancelled = true }
  }, [])

  // 2. SSE stream — live append
  useEffect(() => {
    const source = new EventSource('/logs/stream')
    source.onopen = () => {
      setConnected(true)
      setError(null)
    }
    source.onmessage = (e) => {
      try {
        const entry: LogEntry = JSON.parse(e.data)
        appendEntry(entry)
      } catch {
        // ignore parse errors
      }
    }
    source.onerror = () => {
      setConnected(false)
      // EventSource auto-reconnects, więc nie close-ujemy
    }
    return () => {
      source.close()
      setConnected(false)
    }
  }, [appendEntry])

  const resume = useCallback(() => {
    setPaused(false)
    // Wrzuć pending entries do widoku
    const pending = pendingRef.current
    pendingRef.current = []
    setPendingCount(0)
    setEntries((prev) => {
      const next = [...prev, ...pending]
      if (next.length > MAX_BUFFER) {
        next.splice(0, next.length - MAX_BUFFER)
      }
      return next
    })
  }, [])

  const pause = useCallback(() => setPaused(true), [])
  const togglePause = useCallback(() => paused ? resume() : pause(), [paused, pause, resume])

  const clear = useCallback(() => {
    setEntries([])
    seenIdsRef.current.clear()
    pendingRef.current = []
    setPendingCount(0)
  }, [])

  const download = useCallback(() => {
    // Plain text format — instalator otwiera w notatniku / tail-uje.
    const lines = entries.map((e) =>
      `${e.ts}  ${e.level.toUpperCase().padEnd(7)} ${e.category.padEnd(12)} ${e.message}` +
      (e.detail ? `\n    ${e.detail.replace(/\n/g, '\n    ')}` : ''),
    )
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gatelynk-edge-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.log`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [entries])

  return {
    entries,
    connected,
    paused,
    pendingCount,
    error,
    togglePause,
    clear,
    download,
  }
}
