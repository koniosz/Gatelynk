'use client'
import { useEffect, useState } from 'react'
import { InviteAccessPoint } from './types'

interface Props {
  ap: InviteAccessPoint
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Bottom sheet potwierdzenia destructive akcji (brama pożarowa).
 * Wzorzec z handoffu: scrim blur 8px + panel glass z gripem, radius górny
 * 28px, animacja 300 ms `cubic-bezier(.32,.72,0,1)` (timing w invite.css).
 */
export function ConfirmSheet({ ap, onCancel, onConfirm }: Props) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setShow(true))
  }, [])

  const close = (after: () => void) => {
    setShow(false)
    setTimeout(after, 300)
  }

  return (
    <>
      <div className={`gli-scrim${show ? ' gli-show' : ''}`} onClick={() => close(onCancel)} />
      <div className={`gli-sheet${show ? ' gli-show' : ''}`} role="dialog" aria-modal="true">
        <div className="gli-sheet-grip" />
        {/* Label w cudzysłowie (mianownik) — bez odmiany przez przypadki,
            bezpieczne gramatycznie dla dowolnej nazwy AP z panelu admina. */}
        <h3>Otworzyć „{ap.title}&rdquo;?</h3>
        <p>
          Używaj tylko w sytuacji awaryjnej. Otwarcie zostanie zarejestrowane
          i wysłane do administracji osiedla oraz do gospodarza.
        </p>
        <div className="gli-row">
          <button className="gli-btn-secondary" onClick={() => close(onCancel)}>
            Anuluj
          </button>
          <button className={`gli-btn-primary${ap.destructive ? ' gli-fire' : ''}`} onClick={() => close(onConfirm)}>
            Tak, otwórz
          </button>
        </div>
        <div className="gli-sheet-note">Reakcja w &lt; 2&nbsp;sek. od potwierdzenia</div>
      </div>
    </>
  )
}
