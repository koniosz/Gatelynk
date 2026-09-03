/**
 * Hooks: `useSystemInfo` (instant snapshot) + `useMetrics` (time-series).
 *
 * Polling co 15 s — Edge nie ma WebSocket-a dla metryk, REST poll wystarcza
 * (60s cron próbkuje, więc nawet 15s poll daje sensowny widok aktualności).
 */
import { useEffect, useState } from 'react'
import { setEdgeTimezone } from './edgeTime'

export interface SystemInfo {
  hostname: string
  ip: string
  mac: string
  serial: string
  firmware: string
  uptimeSec: number
  cpu: { model: string; usage: number }
  ram: { used: number; total: number }
  disk: { used: number; total: number }
  temp: number | null
  cloud: 'connected' | 'degraded' | 'disconnected'
  lan: { state: 'up' | 'down'; linkMbps: number }
  wan: { state: 'up' | 'down'; linkMbps: number; isp: string }
  /** Strefa czasowa maszyny Edge (np. `Europe/Warsaw`) — patrz `edgeTime.ts`. */
  timezone?: string
  /** Bonus fields from `/api/system` controller (activation status). */
  activated?: boolean
  deviceId?: string
  buildingId?: number
}

export interface Metrics {
  timestamps: string[]
  cpu: number[]
  ram: number[]          // %
  disk: number[]         // %
  temp: (number | null)[]
  netIn: number[]        // Mbps
  netOut: number[]       // Mbps
  devicesOnline: number[]
  relayTriggers: number[]
  lprReads: number[]
}

export function useSystemInfo(intervalMs = 15_000) {
  const [data, setData] = useState<SystemInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Increment to trigger out-of-cycle reload (np. po activate/deactivate, gdy
  // chcemy zaktualizować Cloud panel natychmiast, nie czekać 15s).
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch('/api/system')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((d: SystemInfo) => {
          if (cancelled) return
          // Zdarzenia pokazujemy w czasie OBIEKTU — ustawiamy strefę zanim
          // komponenty sformatują jakąkolwiek datę.
          setEdgeTimezone(d.timezone)
          setData(d); setError(null)
        })
        .catch((err) => { if (!cancelled) setError(err.message) })
    }
    load()
    const t = setInterval(load, intervalMs)
    return () => { cancelled = true; clearInterval(t) }
  }, [intervalMs, reloadTick])

  return { data, error, refresh: () => setReloadTick((n) => n + 1) }
}

export interface RecentRelayTrigger {
  ts: number
  deviceId: string
  /** Czytelna nazwa urządzenia z `device_config.config.name` (JOIN po stronie
   *  StoreService). `null` gdy urządzenie zostało skasowane — UI fallbackuje
   *  na skrócony deviceId. */
  deviceName: string | null
  deviceType?: string | null
  relayIndex: number
  source: 'HTTP' | 'PIN' | 'HOLD_OPEN' | 'LPR' | 'OTHER'
}

export interface RecentLprRead {
  id: number
  cameraDeviceId: string
  plate: string
  matched: boolean
  gateOpened: boolean
  confidence: number | null
  direction: string | null
  ts: number
}

/** Pobiera listę ostatnich ~50 odczytów LPR (bezpośrednio z `lpr_reads`). */
export function useRecentLprReads(intervalMs = 10_000) {
  const [data, setData] = useState<RecentLprRead[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch('/api/metrics/recent-lpr-reads')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((d: { reads: RecentLprRead[] }) => {
          if (!cancelled) { setData(d.reads ?? []); setError(null) }
        })
        .catch((err) => { if (!cancelled) setError(err.message) })
    }
    load()
    const t = setInterval(load, intervalMs)
    return () => { cancelled = true; clearInterval(t) }
  }, [intervalMs])

  return { data, error }
}

/** Pobiera listę ostatnich ~50 relay-trigerów (ring buffer w MetricsService). */
export function useRecentRelayTriggers(intervalMs = 10_000) {
  const [data, setData] = useState<RecentRelayTrigger[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch('/api/metrics/recent-relay-triggers')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((d: { triggers: RecentRelayTrigger[] }) => {
          if (!cancelled) { setData(d.triggers ?? []); setError(null) }
        })
        .catch((err) => { if (!cancelled) setError(err.message) })
    }
    load()
    const t = setInterval(load, intervalMs)
    return () => { cancelled = true; clearInterval(t) }
  }, [intervalMs])

  return { data, error }
}

export function useMetrics(range: string = '1h', intervalMs = 15_000) {
  const [data, setData] = useState<Metrics | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch(`/api/metrics?range=${encodeURIComponent(range)}`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.json()
        })
        .then((d: Metrics) => { if (!cancelled) { setData(d); setError(null) } })
        .catch((err) => { if (!cancelled) setError(err.message) })
    }
    load()
    const t = setInterval(load, intervalMs)
    return () => { cancelled = true; clearInterval(t) }
  }, [range, intervalMs])

  return { data, error }
}
