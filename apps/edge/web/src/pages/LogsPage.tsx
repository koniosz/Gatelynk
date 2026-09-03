/**
 * Logs tab — terminal-style stream zdarzeń Edge.
 *
 * Z handoff doc sek. 5:
 *  • IBM Plex Mono dla linii logów
 *  • Filtry: poziom (info/warn/err/dbg) — checkbox/toggle each
 *  • Search box (po category + message)
 *  • Live indicator (SSE status)
 *  • Pauza/Wznów (pending count badge przy pauzie)
 *  • Pobierz .log
 *  • Auto-scroll do dołu (stick to bottom)
 *  • Kolorowanie poziomów + lewy border accent
 *
 * Backend wpis ma `level` ∈ {info, success, warning, error, debug} — mapujemy
 * na UI 4-poziomowe (info / success / warn / err) bo „debug" w UI to po prostu
 * „info" dla instalatora.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Download, Search, Trash2, Wifi, WifiOff, ChevronDown } from 'lucide-react'
import { useLogs, type LogEntry, type LogLevel } from '../lib/useLogs'
import { useTranslation } from '../i18n'

type LevelFilter = 'info' | 'success' | 'warning' | 'error' | 'debug'

const LEVEL_COLORS: Record<LevelFilter, { text: string; bg: string; border: string; label: string }> = {
  info:    { text: 'var(--blue)',   bg: 'var(--blue-50)',   border: 'var(--blue)',   label: 'INFO' },
  success: { text: 'var(--green)',  bg: 'var(--green-50)',  border: 'var(--green)',  label: 'OK' },
  warning: { text: 'var(--amber)',  bg: 'var(--amber-50)',  border: 'var(--amber)',  label: 'WARN' },
  error:   { text: 'var(--red)',    bg: 'var(--red-50)',    border: 'var(--red)',    label: 'ERR' },
  debug:   { text: 'var(--muted)',  bg: 'var(--surface-2)', border: 'var(--border-strong)', label: 'DBG' },
}

const ALL_LEVELS: LevelFilter[] = ['info', 'success', 'warning', 'error', 'debug']

export function LogsPage() {
  const { entries, connected, paused, pendingCount, error, togglePause, clear, download } = useLogs()
  const [search, setSearch] = useState('')
  const [activeLevels, setActiveLevels] = useState<Set<LevelFilter>>(
    new Set(ALL_LEVELS),
  )
  const { t } = useTranslation()

  // Filtrowanie — search + level
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries.filter((e) => {
      if (!activeLevels.has(e.level as LevelFilter)) return false
      if (!q) return true
      return (
        e.category.toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q) ||
        (e.detail ?? '').toLowerCase().includes(q)
      )
    })
  }, [entries, search, activeLevels])

  // Auto-scroll do dołu — tylko gdy user nie scrolluje w górę.
  const containerRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (stickToBottom.current && !paused) {
      el.scrollTop = el.scrollHeight
    }
  }, [filtered, paused])

  const onScroll = () => {
    const el = containerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottom.current = distFromBottom < 50
  }

  const toggleLevel = (lv: LevelFilter) => {
    setActiveLevels((prev) => {
      const next = new Set(prev)
      if (next.has(lv)) next.delete(lv); else next.add(lv)
      return next
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>
          {t('logs.title')}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
          {t('logs.subtitle')}
        </p>
      </div>

      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12,
        flexWrap: 'wrap',
      }}>
        {/* Search */}
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 360 }}>
          <Search size={14} style={{
            position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--muted-2)',
          }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Szukaj kategorii lub treści…"
            style={{
              width: '100%',
              padding: '8px 12px 8px 32px',
              borderRadius: 'var(--r-2)',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--ink)',
              fontSize: 13,
            }}
          />
        </div>

        {/* Level filters */}
        <div style={{ display: 'flex', gap: 4 }}>
          {ALL_LEVELS.map((lv) => {
            const colors = LEVEL_COLORS[lv]
            const active = activeLevels.has(lv)
            return (
              <button
                key={lv}
                onClick={() => toggleLevel(lv)}
                title={`Pokaż ${colors.label}`}
                style={{
                  padding: '6px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: '"IBM Plex Mono", monospace',
                  borderRadius: 'var(--r-2)',
                  border: '1px solid',
                  cursor: 'pointer',
                  background: active ? colors.bg : 'transparent',
                  borderColor: active ? colors.border : 'var(--border)',
                  color: active ? colors.text : 'var(--muted-2)',
                  opacity: active ? 1 : 0.55,
                  transition: 'all 80ms',
                }}
              >
                {colors.label}
              </button>
            )
          })}
        </div>

        <div style={{ flex: 1 }} />

        {/* Pendings during pause */}
        {paused && pendingCount > 0 && (
          <span style={{ fontSize: 11, color: 'var(--amber)' }}>
            +{pendingCount} oczekuje
          </span>
        )}

        {/* Connection status */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 11,
          color: connected ? 'var(--green)' : 'var(--red)',
        }}>
          {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
          {connected ? 'Live' : t('common.disconnected')}
        </div>

        {/* Actions */}
        <button
          className="btn"
          onClick={togglePause}
          title={paused ? t('logs.resume') : t('logs.pause')}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? t('logs.resume') : t('logs.pause')}
        </button>
        <ExportLogsButton onSnapshot={download} snapshotEmpty={entries.length === 0} />
        <button
          className="btn-icon"
          onClick={clear}
          title={t('logs.clear')}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {error && (
        <div className="card" style={{
          padding: 12,
          marginBottom: 12,
          background: 'var(--red-50)',
          borderColor: 'var(--red)',
          color: 'var(--red)',
          fontSize: 12,
        }}>
          {error}
        </div>
      )}

      {/* Stream area */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="card"
        style={{
          flex: 1,
          minHeight: 0,
          padding: 0,
          overflowY: 'auto',
          background: 'var(--bg-2)',
          fontFamily: '"IBM Plex Mono", monospace',
          fontSize: 12,
          lineHeight: 1.5,
        }}
      >
        {filtered.length === 0 ? (
          <div style={{
            padding: 48,
            textAlign: 'center',
            color: 'var(--muted)',
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontSize: 13,
          }}>
            {entries.length === 0
              ? 'Brak wpisów — czekam na zdarzenia z Edge…'
              : `Brak wpisów dla filtra (${entries.length} dostępnych)`}
          </div>
        ) : (
          <div style={{ padding: '4px 0' }}>
            {filtered.map((e) => (
              <LogRow key={e.id} entry={e} />
            ))}
          </div>
        )}
      </div>

      {/* Footer info */}
      <div style={{
        marginTop: 8,
        fontSize: 11,
        color: 'var(--muted)',
        display: 'flex',
        justifyContent: 'space-between',
      }}>
        <span>
          {filtered.length} z {entries.length} wpisów
          {entries.length >= 500 && ' (limit 500 — starsze wypadają)'}
        </span>
        <span>Bufor live SSE · refresh przez clear</span>
      </div>
    </div>
  )
}

function LogRow({ entry }: { entry: LogEntry }) {
  const colors = LEVEL_COLORS[entry.level as LogLevel] ?? LEVEL_COLORS.info
  const time = new Date(entry.ts)
  const hh = time.getHours().toString().padStart(2, '0')
  const mm = time.getMinutes().toString().padStart(2, '0')
  const ss = time.getSeconds().toString().padStart(2, '0')
  const ms = time.getMilliseconds().toString().padStart(3, '0')
  const timeStr = `${hh}:${mm}:${ss}`

  const [expanded, setExpanded] = useState(false)
  const hasDetail = !!entry.detail
  const detailPreview = hasDetail ? entry.detail!.slice(0, 200) : ''

  return (
    <div
      onClick={() => hasDetail && setExpanded(!expanded)}
      style={{
        padding: '3px 12px 3px 14px',
        borderLeft: `3px solid ${colors.border}`,
        cursor: hasDetail ? 'pointer' : 'default',
        background: expanded ? 'var(--surface-2)' : 'transparent',
        transition: 'background 60ms',
      }}
      onMouseEnter={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)' }}
      onMouseLeave={(e) => { if (!expanded) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <div style={{
        display: 'flex',
        gap: 12,
        alignItems: 'baseline',
      }}>
        <span style={{ color: 'var(--muted-2)', minWidth: 100 }}>
          {timeStr}<span style={{ color: 'var(--muted-2)', opacity: 0.6 }}>.{ms}</span>
        </span>
        <span style={{
          minWidth: 52,
          fontSize: 10,
          fontWeight: 700,
          color: colors.text,
          letterSpacing: 0.4,
        }}>
          {colors.label}
        </span>
        <span style={{
          minWidth: 90,
          color: 'var(--muted)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}>
          {entry.category}
        </span>
        <span style={{
          color: 'var(--ink)',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {entry.message}
        </span>
        {hasDetail && (
          <span style={{
            color: 'var(--muted-2)',
            fontSize: 10,
            flexShrink: 0,
          }}>
            {expanded ? '▾' : '▸'} detail
          </span>
        )}
      </div>
      {expanded && hasDetail && (
        <div style={{
          marginTop: 4,
          marginLeft: 100 + 12 + 52 + 12 + 90 + 12,
          padding: '6px 10px',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-1)',
          fontSize: 11,
          color: 'var(--ink-2)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {detailPreview}
          {entry.detail && entry.detail.length > 200 && (
            <span style={{ color: 'var(--muted)' }}>
              {'\n'}…(skrócone, {entry.detail.length} znaków)
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * ExportLogsButton — dropdown z opcjami:
 *   • Bieżący widok (in-memory, klient generuje TXT z bufora) — używa `onSnapshot`
 *   • 24h / 3d / 7d — uderza w `GET /logs/export?range=...&format=...`
 *
 * Format default = TXT (best dla bug raportu); JSON i CSV w pod-menu.
 * Browser pobiera plik dzięki `Content-Disposition: attachment` z serwera.
 */
function ExportLogsButton({ onSnapshot, snapshotEmpty }: {
  onSnapshot: () => void
  snapshotEmpty: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<'txt' | 'json' | 'csv'>('txt')
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Click outside zamyka menu
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const exportRange = (range: '24h' | '3d' | '7d') => {
    // `window.location.href` triggeruje pobieranie dzięki Content-Disposition.
    // Alternatywa: `<a download>` ale `href` wystarcza i nie potrzebuje DOM
    // mutacji.
    window.location.href = `/logs/export?range=${range}&format=${format}`
    setOpen(false)
  }

  const handleSnapshot = () => {
    onSnapshot()
    setOpen(false)
  }

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <button
        className="btn"
        onClick={() => setOpen(!open)}
        title={t('logs.export')}
      >
        <Download size={14} />
        {t('logs.export')}
        <ChevronDown size={12} style={{ marginLeft: 2 }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          right: 0,
          minWidth: 240,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-2)',
          boxShadow: 'var(--shadow-2)',
          padding: 6,
          zIndex: 50,
        }}>
          {/* Format picker */}
          <div style={{
            padding: '4px 8px 8px 8px',
            borderBottom: '1px solid var(--border)',
            marginBottom: 4,
          }}>
            <div style={{
              fontSize: 10, fontWeight: 600,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              marginBottom: 4,
            }}>
              {t('logs.export.format')}
            </div>
            <div style={{ display: 'flex', gap: 2 }}>
              {(['txt', 'json', 'csv'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFormat(f)}
                  style={{
                    flex: 1,
                    padding: '4px 6px',
                    fontSize: 10, fontWeight: 600,
                    background: format === f ? 'var(--blue)' : 'var(--surface-2)',
                    color: format === f ? 'white' : 'var(--ink-2)',
                    border: '1px solid',
                    borderColor: format === f ? 'var(--blue)' : 'var(--border)',
                    borderRadius: 'var(--r-1)',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}
                >
                  {f}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: 'var(--muted-2)', marginTop: 6 }}>
              {format === 'txt'  && t('logs.export.txt')}
              {format === 'json' && t('logs.export.json')}
              {format === 'csv'  && t('logs.export.csv')}
            </div>
          </div>

          {/* Range options */}
          <MenuItem onClick={() => exportRange('24h')} label={t('logs.export.menu.24h')} />
          <MenuItem onClick={() => exportRange('3d')}  label={t('logs.export.menu.3d')} />
          <MenuItem onClick={() => exportRange('7d')}  label={t('logs.export.menu.7d')} />

          <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
            <MenuItem
              onClick={handleSnapshot}
              label={t('logs.export.menu.view')}
              disabled={snapshotEmpty}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function MenuItem({ onClick, label, disabled }: {
  onClick: () => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        background: 'transparent',
        border: 'none',
        fontSize: 12,
        color: disabled ? 'var(--muted-2)' : 'var(--ink-2)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        borderRadius: 'var(--r-1)',
        transition: 'background 80ms',
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'transparent'
      }}
    >
      {label}
    </button>
  )
}
