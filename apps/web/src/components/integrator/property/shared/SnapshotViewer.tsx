'use client'
/**
 * SnapshotViewer — komponent z dwoma trybami: snapshot (jednorazowy JPEG)
 * i live (MJPEG stream URL). Edge HTTP endpointy zwracają payload.
 *
 * UI:
 *   ┌──── label · IP ────────[Snapshot] [▶ Live]──┐
 *   │  obraz (max 360px wysokości)                │
 *   └──────────────────────────────────────────────┘
 */
import { useCallback, useState } from 'react'
import { Camera, Play, RefreshCw } from 'lucide-react'
import { integratorApi } from '@/lib/integrator-api'
import { Spinner } from './Spinner'

interface Props {
  buildingId: string
  deviceId: string
  label: string
}

export function SnapshotViewer({ buildingId, deviceId, label }: Props) {
  const [snap, setSnap] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const [mode, setMode] = useState<'snap' | 'live'>('snap')

  const fetchSnap = useCallback(async () => {
    setLoading(true)
    setStreamUrl(null)
    setMode('snap')
    try {
      const r = await integratorApi.get(`/integrator/buildings/${buildingId}/edge/snapshot?deviceId=${deviceId}`)
      setSnap(r.data.snapshot ?? null)
    } catch {
      setSnap(null)
    } finally {
      setLoading(false)
    }
  }, [buildingId, deviceId])

  const fetchLive = useCallback(async () => {
    setMode('live')
    try {
      const r = await integratorApi.get(`/integrator/buildings/${buildingId}/edge/stream-url?deviceId=${deviceId}`)
      setStreamUrl(r.data.url)
    } catch { /* no-op */ }
  }, [buildingId, deviceId])

  return (
    <div className="rounded-r3 border border-border overflow-hidden bg-ink">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-ink-2">
        <p className="text-[11px] text-muted-2 font-medium font-[var(--font-plex-mono)]">{label}</p>
        <div className="flex gap-1">
          <button
            onClick={fetchSnap}
            className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-r1 font-medium transition-colors ${
              mode === 'snap' ? 'bg-muted-2/40 text-white' : 'text-muted-2 hover:text-white hover:bg-muted/30'
            }`}
          >
            <Camera size={11} /> Snapshot
          </button>
          <button
            onClick={fetchLive}
            className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-r1 font-medium transition-colors ${
              mode === 'live' ? 'bg-danger text-white' : 'text-muted-2 hover:text-white hover:bg-muted/30'
            }`}
          >
            <Play size={11} /> Live
          </button>
          {mode === 'snap' && (
            <button
              onClick={fetchSnap}
              className="p-1 text-muted-2 hover:text-white transition-colors"
              title="Odśwież"
            >
              <RefreshCw size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Image area */}
      <div className="relative bg-ink flex items-center justify-center" style={{ minHeight: 200 }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner size={28} />
          </div>
        )}

        {mode === 'live' && streamUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={streamUrl} alt="Live stream" className="w-full object-contain" style={{ maxHeight: 360 }} />
        )}

        {mode === 'snap' && snap && !loading && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={snap} alt="Snapshot" className="w-full object-contain" style={{ maxHeight: 360 }} />
        )}

        {mode === 'snap' && !snap && !loading && (
          <div className="py-12 flex flex-col items-center gap-2 text-muted-2">
            <Camera size={32} strokeWidth={1.5} />
            <p className="text-[11px]">Kliknij Snapshot aby pobrać obraz</p>
          </div>
        )}
      </div>
    </div>
  )
}
