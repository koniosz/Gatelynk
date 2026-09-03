/**
 * AssistantFab — floating-action-button + slide-in drawer dla Edge AI chat.
 *
 * Wisi w prawym dolnym rogu każdej strony (mount w App.tsx). Bottom-right
 * żeby nie kolidował z sidebarem (left) ani topbarem (top).
 *
 * Klik FAB → drawer (440px) z prawej. Chat UI:
 *   • Header z X (close) + ↺ (clear conversation)
 *   • Empty state z 5 sugerowanymi pytaniami
 *   • Message list z bubble UI (user prawy, assistant lewy)
 *   • Streaming token-by-token z animated cursor
 *   • Tool trace pod każdą AI-odpowiedzią (collapsed by default)
 *   • Input + Send (Enter submits, Shift+Enter = newline)
 *
 * Gdy Ollama niedostępna → FAB jest wyszarzony + tooltip wyjaśnia jak włączyć.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Sparkles, X, RotateCw, Send, AlertCircle, ChevronDown, ChevronRight, Loader2,
  Zap, Brain,
} from 'lucide-react'
import { useAssistant, type ToolTrace } from '../../lib/useAssistant'
import { useTranslation } from '../../i18n'

export function AssistantFab() {
  const [open, setOpen] = useState(false)
  const { available } = useAssistant()  // poll status background

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={available === false
          ? 'Assistant unavailable — Ollama not running on Edge'
          : 'Edge AI Assistant'
        }
        aria-label="Open AI Assistant"
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          width: 52,
          height: 52,
          borderRadius: '50%',
          border: 'none',
          background: available === false
            ? 'var(--surface-2)'
            : 'linear-gradient(135deg, var(--blue) 0%, var(--blue-600) 100%)',
          color: available === false ? 'var(--muted-2)' : 'white',
          boxShadow: 'var(--shadow-2)',
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 90,    // pod modalami (zIndex 200+) ale nad zwykłą zawartością
          transition: 'transform 120ms, box-shadow 120ms',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)'
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.transform = 'scale(1)'
        }}
      >
        <Sparkles size={22} strokeWidth={2} />
      </button>

      {open && <ChatDrawer onClose={() => setOpen(false)} />}
    </>
  )
}

function ChatDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const {
    messages, status, available, streamingAnswer, currentTools, send, clear,
    smartMode, setSmartMode, followUps,
  } = useAssistant()
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ESC zamyka
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Auto-scroll do dołu gdy nowa wiadomość albo streaming
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, streamingAnswer])

  // Focus input on open
  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSend = () => {
    const q = input.trim()
    if (!q || status === 'streaming') return
    send(q)
    setInput('')
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const suggested = [
    t('assistant.suggest.1'),
    t('assistant.suggest.2'),
    t('assistant.suggest.3'),
    t('assistant.suggest.4'),
    t('assistant.suggest.5'),
  ]

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.3)',
        zIndex: 150,
        display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: '100vw',
          height: '100vh',
          background: 'var(--surface)',
          borderLeft: '1px solid var(--border)',
          boxShadow: 'var(--shadow-2)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, var(--blue) 0%, var(--blue-600) 100%)',
            color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Sparkles size={16} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
              {t('assistant.header')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {t('assistant.subtitle')}
            </div>
          </div>
          {/* Tryb mądry/szybki — persistent w localStorage */}
          <button
            className="btn-icon"
            onClick={() => setSmartMode(!smartMode)}
            disabled={status === 'streaming'}
            title={
              smartMode
                ? 'Tryb mądry (LLM, ~7s) — kliknij dla trybu szybkiego'
                : 'Tryb szybki (template, ~10ms) — kliknij dla trybu mądrego'
            }
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: smartMode ? 'var(--blue)' : 'var(--muted)',
              fontWeight: 600,
              padding: '4px 8px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-1)',
              background: smartMode ? 'var(--blue-50)' : 'var(--surface-2)',
            }}
          >
            {smartMode ? <Brain size={13} /> : <Zap size={13} />}
            {smartMode ? 'Mądry' : 'Szybki'}
          </button>
          {messages.length > 0 && (
            <button
              className="btn-icon"
              onClick={clear}
              title={t('common.refresh')}
            >
              <RotateCw size={16} />
            </button>
          )}
          <button className="btn-icon" onClick={onClose} title={`${t('common.close')} (Esc)`}>
            <X size={18} />
          </button>
        </div>

        {/* Unavailable banner */}
        {available === false && (
          <div style={{
            padding: 12,
            background: 'var(--red-50)',
            borderBottom: '1px solid var(--red)',
            color: 'var(--red)',
            fontSize: 12,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{t('assistant.unavailable')}</span>
          </div>
        )}

        {/* Messages */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {messages.length === 0 && !streamingAnswer && (
            <EmptyState
              t={t}
              suggested={suggested}
              onPick={(q) => send(q)}
              disabled={status === 'streaming' || available === false}
            />
          )}

          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} content={m.content} tools={m.tools} totalMs={m.totalMs} error={m.error} t={t} />
          ))}

          {/* Live streaming bubble */}
          {status === 'streaming' && (
            <StreamingBubble
              text={streamingAnswer}
              tools={currentTools}
              t={t}
            />
          )}
        </div>

        {/* Follow-ups (smart mode) — clickable chips nad inputem */}
        {smartMode && followUps.length > 0 && status !== 'streaming' && (
          <div style={{
            padding: '8px 12px',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface-2)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            flexShrink: 0,
          }}>
            <div style={{
              fontSize: 10,
              color: 'var(--muted)',
              width: '100%',
              marginBottom: 2,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}>
              Dalej:
            </div>
            {followUps.map((fu, i) => (
              <button
                key={i}
                onClick={() => send(fu)}
                style={{
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: 16,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={fu}
              >
                {fu.length > 50 ? fu.slice(0, 50) + '…' : fu}
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <div style={{
          padding: 12,
          borderTop: '1px solid var(--border)',
          background: 'var(--surface-2)',
          display: 'flex',
          gap: 8,
          alignItems: 'flex-end',
          flexShrink: 0,
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={t('assistant.placeholder')}
            disabled={status === 'streaming' || available === false}
            rows={1}
            style={{
              flex: 1,
              padding: '8px 12px',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--ink)',
              borderRadius: 'var(--r-2)',
              fontSize: 13,
              resize: 'none',
              maxHeight: 120,
              fontFamily: 'inherit',
            }}
          />
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={!input.trim() || status === 'streaming' || available === false}
            title={t('assistant.send')}
            style={{ flexShrink: 0 }}
          >
            {status === 'streaming' ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  )
}

function EmptyState({ t, suggested, onPick, disabled }: {
  t: (k: string) => string
  suggested: string[]
  onPick: (q: string) => void
  disabled: boolean
}) {
  return (
    <div style={{ padding: '8px 4px' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
        {t('assistant.empty.title')}
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, margin: '0 0 16px 0' }}>
        {t('assistant.empty.hint')}
      </p>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
        {t('assistant.suggested')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {suggested.map((q, i) => (
          <button
            key={i}
            onClick={() => !disabled && onPick(q)}
            disabled={disabled}
            style={{
              padding: '10px 12px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-2)',
              fontSize: 12,
              color: 'var(--ink-2)',
              textAlign: 'left',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              transition: 'background 80ms, border-color 80ms',
            }}
            onMouseEnter={(e) => {
              if (!disabled) {
                (e.currentTarget as HTMLElement).style.background = 'var(--blue-50)'
                ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--blue)'
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'
              ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'
            }}
          >
            💡 {q}
          </button>
        ))}
      </div>
    </div>
  )
}

function Bubble({ role, content, tools, totalMs, error, t }: {
  role: 'user' | 'assistant' | 'system'
  content: string
  tools?: ToolTrace[]
  totalMs?: number
  error?: string
  t: (k: string) => string
}) {
  const isUser = role === 'user'

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
      gap: 4,
    }}>
      <span style={{
        fontSize: 10,
        fontWeight: 600,
        color: 'var(--muted-2)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}>
        {isUser ? t('assistant.youSaid') : t('assistant.aiSaid')}
      </span>
      <div style={{
        maxWidth: '85%',
        padding: '10px 14px',
        borderRadius: 'var(--r-3)',
        background: isUser ? 'var(--blue)' : 'var(--surface-2)',
        color: isUser ? 'white' : 'var(--ink)',
        border: isUser ? 'none' : '1px solid var(--border)',
        fontSize: 13,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {error ? (
          <span style={{ color: 'var(--red)' }}>✗ {t('assistant.error')}: {error}</span>
        ) : content}
      </div>
      {!isUser && tools && tools.length > 0 && (
        <ToolTraceDetails tools={tools} totalMs={totalMs} t={t} />
      )}
    </div>
  )
}

function StreamingBubble({ text, tools, t }: {
  text: string
  tools: ToolTrace[]
  t: (k: string) => string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
      <span style={{
        fontSize: 10, fontWeight: 600,
        color: 'var(--muted-2)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}>
        {t('assistant.aiSaid')}
      </span>
      {/* Tool indicators podczas streaming - „⚙ Querying relay triggers…" */}
      {tools.length > 0 && !text && (
        <div style={{
          padding: '6px 10px',
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-2)',
          fontSize: 11,
          color: 'var(--muted)',
          fontFamily: '"IBM Plex Mono", monospace',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Loader2 size={11} className="spin" />
          ⚙ {tools.map((t) => t.name).join(', ')}
        </div>
      )}
      {text && (
        <div style={{
          maxWidth: '85%',
          padding: '10px 14px',
          borderRadius: 'var(--r-3)',
          background: 'var(--surface-2)',
          color: 'var(--ink)',
          border: '1px solid var(--border)',
          fontSize: 13,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {text}
          <span style={{
            display: 'inline-block',
            width: 6, height: 14,
            background: 'var(--blue)',
            marginLeft: 2,
            verticalAlign: 'text-bottom',
            animation: 'blink 1s infinite',
          }} />
        </div>
      )}
      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}

function ToolTraceDetails({ tools, totalMs, t }: {
  tools: ToolTrace[]
  totalMs?: number
  t: (k: string) => string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{
      width: '85%',
      marginTop: 2,
      fontSize: 10,
      color: 'var(--muted-2)',
      fontFamily: '"IBM Plex Mono", monospace',
    }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'transparent',
          border: 'none',
          padding: '2px 0',
          cursor: 'pointer',
          color: 'var(--muted)',
          fontSize: 10,
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        ⚙ {t('assistant.tools.label')}: {tools.length}
        {totalMs != null && ` · ${totalMs}ms`}
      </button>
      {open && (
        <div style={{ paddingLeft: 14, paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {tools.map((tt, i) => (
            <div key={i} style={{ color: 'var(--ink-2)' }}>
              {tt.name}({Object.entries(tt.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})
              {tt.durationMs != null && <span style={{ color: 'var(--muted-2)' }}> · {tt.durationMs}ms</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
