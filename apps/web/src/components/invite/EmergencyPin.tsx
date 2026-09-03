'use client'
import { useState } from 'react'
import { IconWarning, IconEye, IconCopy, IconCheck, IconClock } from './icons'

interface Props {
  token: string
  hasPin: boolean
  onToast: (msg: string, tone?: 'ok' | 'fail') => void
}

/**
 * PIN ukryty domyślnie (kropki). Reveal → POST /pin/:token (lazy fetch + audit
 * PIN_REVEAL); drugi klik oka ukrywa z powrotem (bez requestu). Copy →
 * PIN_COPY audit + Clipboard API + toast. Cyfry w Geist Mono.
 */
export function EmergencyPin({ token, hasPin, onToast }: Props) {
  const [pin, setPin] = useState<string | null>(null)
  const [formatted, setFormatted] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState<'reveal' | 'copy' | null>(null)
  const [copied, setCopied] = useState(false)

  const fetchPin = async (reason: 'reveal' | 'copy'): Promise<string | null> => {
    try {
      const res = await fetch(`/api/invite/${token}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      if (!res.ok) {
        onToast('Nie można pokazać PIN-u', 'fail')
        return null
      }
      const data = (await res.json()) as { pin: string; formatted: string }
      setPin(data.pin)
      setFormatted(data.formatted)
      return data.pin
    } catch {
      onToast('Błąd sieci', 'fail')
      return null
    }
  }

  const toggleReveal = async () => {
    if (busy) return
    if (revealed) {
      // Ukryj z powrotem — bez requestu, wartość zostaje w pamięci komponentu.
      setRevealed(false)
      return
    }
    setBusy('reveal')
    const value = pin ?? (await fetchPin('reveal'))
    if (value) setRevealed(true)
    setBusy(null)
  }

  const copy = async () => {
    if (busy) return
    setBusy('copy')
    const value = pin ?? (await fetchPin('copy'))
    if (value) {
      try {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        onToast('PIN skopiowany')
        setTimeout(() => setCopied(false), 1400)
      } catch {
        onToast('Nie udało się skopiować', 'fail')
      }
    }
    setBusy(null)
  }

  if (!hasPin) {
    return null
  }

  return (
    <>
      <div className="gli-section-h">
        <h2>Awaryjny PIN</h2>
        <span className="gli-hint">Gdy brak zasięgu</span>
      </div>
      <div className="gli-pin-card">
        <div className="gli-pin-head">
          <div className="gli-pin-icon">
            <IconWarning />
          </div>
          <div>
            <div className="gli-pin-title">Kod dostępu</div>
            <div className="gli-pin-desc">Wpisz na klawiaturze przy bramie lub drzwiach</div>
          </div>
        </div>
        <div className="gli-pin-body">
          <div className={revealed && pin ? 'gli-pin-digits' : 'gli-pin-digits gli-hidden'}>
            {revealed && pin ? (formatted ?? pin) : '• • • • • •'}
          </div>
          <div className="gli-pin-actions">
            <button
              type="button"
              className="gli-icon-btn"
              aria-label={revealed ? 'Ukryj PIN' : 'Pokaż PIN'}
              onClick={toggleReveal}
              disabled={busy === 'reveal'}
            >
              <IconEye />
            </button>
            <button
              type="button"
              className={copied ? 'gli-icon-btn gli-success' : 'gli-icon-btn'}
              aria-label="Kopiuj PIN"
              onClick={copy}
              disabled={busy === 'copy'}
            >
              {copied ? <IconCheck /> : <IconCopy />}
            </button>
          </div>
        </div>
        <div className="gli-pin-foot">
          <IconClock />
          PIN ważny przez cały czas zaproszenia
        </div>
      </div>
    </>
  )
}
