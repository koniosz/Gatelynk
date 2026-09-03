/**
 * LivePreviewModal — fullscreen-ish live podgląd z kamery / domofonu.
 *
 * Backend Edge ma `GET /devices/:id/stream` — MJPEG multipart, który przeglądarka
 * renderuje natywnie przez `<img src="...">` (continuous frames replacement).
 * To znacznie lepsze niż polling snapshot — prawdziwy live, minimal CPU.
 *
 * Fallback: jeśli MJPEG endpoint padnie (brak kamery / `pipeVideoStream` error),
 * UI pokaże komunikat błędu i opcjonalnie polling snapshot fallback.
 *
 * UX z handoff doc:
 *   • ESC zamyka modal
 *   • Klik na backdrop zamyka
 *   • Status badge na górze (LIVE z animowaną kropką)
 *   • Info bar dolny: IP, model, ostatni status check
 */
import { useEffect, useState } from 'react'
import { X, Wifi, RefreshCw, ExternalLink } from 'lucide-react'
import type { DeviceEntry } from '../../lib/types'

interface LivePreviewModalProps {
  device: DeviceEntry
  onClose: () => void
}

export function LivePreviewModal({ device, onClose }: LivePreviewModalProps) {
  const { config, deviceId } = device
  const [streamError, setStreamError] = useState(false)
  // Reload counter — pozwala wymusić nowy request gdy strumień padnie
  // (np. po krótkim disconnect kamery).
  const [reloadKey, setReloadKey] = useState(0)
  const streamUrl = `/devices/${deviceId}/stream?k=${reloadKey}`

  // ESC zamyka
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Disable body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-3)',
          boxShadow: 'var(--shadow-2)',
          maxWidth: 1280,
          width: '100%',
          maxHeight: 'calc(100vh - 48px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-2)',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
                {config.name ?? 'Podgląd'}
              </span>
              <LiveBadge />
            </div>
            <div style={{
              fontSize: 11,
              color: 'var(--muted)',
              fontFamily: '"IBM Plex Mono", monospace',
              marginTop: 2,
            }}>
              {config.manufacturer ?? '—'}
              {config.model ? ` · ${config.model}` : ''}
              {config.ipAddress ? ` · ${config.ipAddress}` : ''}
            </div>
          </div>
          <button
            className="btn-icon"
            onClick={() => { setStreamError(false); setReloadKey((k) => k + 1) }}
            title="Odśwież strumień"
          >
            <RefreshCw size={16} />
          </button>
          {config.ipAddress && (
            <a
              href={`http://${config.ipAddress}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-icon"
              title="Otwórz panel kamery"
            >
              <ExternalLink size={16} />
            </a>
          )}
          <button
            className="btn-icon"
            onClick={onClose}
            title="Zamknij (Esc)"
          >
            <X size={18} />
          </button>
        </div>

        {/* Stream content */}
        <div style={{
          flex: 1,
          minHeight: 0,
          background: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
        }}>
          {streamError ? (
            <ErrorState onRetry={() => { setStreamError(false); setReloadKey((k) => k + 1) }} />
          ) : (
            <img
              key={reloadKey}
              src={streamUrl}
              alt={`Strumień ${config.name ?? ''}`}
              onError={() => setStreamError(true)}
              style={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                display: 'block',
              }}
            />
          )}
        </div>

        {/* Footer info */}
        <div style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface-2)',
          fontSize: 11,
          color: 'var(--muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <span className="mono">deviceId: {deviceId.slice(0, 16)}…</span>
          {config.driverId && <span className="mono">driver: {config.driverId}</span>}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10 }}>
            ESC żeby zamknąć
          </span>
        </div>
      </div>
    </div>
  )
}

function LiveBadge() {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '2px 8px',
      borderRadius: 999,
      background: 'var(--red-50)',
      color: 'var(--red)',
      border: '1px solid var(--red)',
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--red)',
        animation: 'pulse-live 1.6s ease-in-out infinite',
      }} />
      Live
      <style>{`
        @keyframes pulse-live {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.9); }
        }
      `}</style>
    </span>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 16,
      color: 'var(--muted)',
      padding: 48,
      textAlign: 'center',
    }}>
      <Wifi size={48} strokeWidth={1.2} style={{ color: 'var(--muted-2)' }} />
      <div>
        <div style={{ fontSize: 14, color: 'var(--ink-2)', marginBottom: 4 }}>
          Strumień niedostępny
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Kamera może być offline, RTSP timeout, albo driver nie wspiera MJPEG proxy.
        </div>
      </div>
      <button className="btn btn-primary" onClick={onRetry}>
        <RefreshCw size={14} />
        Spróbuj ponownie
      </button>
    </div>
  )
}
