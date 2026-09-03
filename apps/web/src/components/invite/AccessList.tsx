'use client'
import { useEffect, useRef, useState } from 'react'
import { Invite, InviteAccessPoint, InviteApprovalStatus } from './types'
import { IconGate, IconDoor, IconElevator, IconHome, IconFire, IconKey, IconCheck, IconClock } from './icons'
import { ConfirmSheet } from './ConfirmSheet'

interface Props {
  invite: Invite
  onToast: (msg: string, tone?: 'ok' | 'fail') => void
}

/**
 * Stany pojedynczego CTA — odpowiadają designerskim klasom .opening/.done/.failed.
 * Rozszerzone o UNIT_DOOR (zamek Nuki):
 *   • 'pending' — prośba wysłana do gospodarza, polling co 2.5 s + countdown
 *   • 'denied'  — gospodarz odmówił (trwałe do reloadu strony)
 */
type RowState = 'idle' | 'opening' | 'pending' | 'done' | 'failed' | 'denied'

/** Auto-reset CTA do stanu idle — 3.5 s wg timingów z handoffu. */
const RESET_MS = 3500

/** Polling statusu zatwierdzenia gospodarza (UNIT_DOOR approvalRequired). */
const APPROVAL_POLL_MS = 2500

/**
 * Polska odmiana licznika otwarć: 1 otwarcie / 2-4 otwarcia / 5+ otwarć
 * (z regułą 12-14 → „otwarć", jak w standardowej pluralizacji PL).
 */
function formatRemainingUses(n: number): string {
  if (n <= 0) return 'limit wykorzystany'
  if (n === 1) return 'zostało 1 otwarcie'
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return `zostały ${n} otwarcia`
  }
  return `zostało ${n} otwarć`
}

export function AccessList({ invite, onToast }: Props) {
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({})
  const [confirmFor, setConfirmFor] = useState<InviteAccessPoint | null>(null)

  // Lokalny licznik pozostałych otwarć per wejście — inicjalizowany z SSR
  // (`remainingUses`), aktualizowany po sukcesie / USES_EXHAUSTED bez refetch.
  // undefined/null = bez limitu (starszy backend nie zwraca pola).
  const [usesLeft, setUsesLeft] = useState<Record<string, number | null>>(() => {
    const init: Record<string, number | null> = {}
    for (const ap of invite.access) init[ap.id] = ap.remainingUses ?? null
    return init
  })

  // UNIT_DOOR: jednorazowy nonce per wejście (SSR → `ap.nonce`), podmieniany
  // na `nextNonce` z odpowiedzi /open lub /approval. null = limit wyczerpany.
  const [nonces, setNonces] = useState<Record<string, string | null>>(() => {
    const init: Record<string, string | null> = {}
    for (const ap of invite.access) init[ap.id] = ap.nonce ?? null
    return init
  })

  // Tryb zatwierdzania — aktywne prośby (apId → requestId + deadline ms).
  const [pending, setPending] = useState<Record<string, { requestId: string; expiresAt: number }>>({})

  // 403 AP_NOT_ALLOWED — wejście znika z listy (backend już go nie honoruje).
  const [hiddenAps, setHiddenAps] = useState<Record<string, boolean>>({})

  // Live świadomość okna czasowego: strona otwarta dłużej niż okno →
  // przyciski same się disabled-ują (i odwrotnie: UPCOMING → aktywują po starcie).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const start = new Date(invite.window.startsAt).getTime()
  const end = new Date(invite.window.endsAt).getTime()
  const disabled = invite.windowStatus === 'EXPIRED' || now < start || now >= end

  const pendingCount = Object.keys(pending).length

  // Sekundowy tick TYLKO gdy jest aktywna prośba — countdown na CTA.
  const [nowSec, setNowSec] = useState(() => Date.now())
  useEffect(() => {
    if (pendingCount === 0) return
    setNowSec(Date.now())
    const t = setInterval(() => setNowSec(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pendingCount])

  /** Przejęcie remainingUses/nextNonce z odpowiedzi backendu (opened/approval). */
  const adoptCounters = (apId: string, remainingUses: number | null | undefined, nextNonce: string | null | undefined) => {
    if (typeof remainingUses === 'number') {
      setUsesLeft((u) => ({ ...u, [apId]: remainingUses }))
    }
    if (nextNonce !== undefined) {
      setNonces((n) => ({ ...n, [apId]: nextNonce }))
    }
  }

  /** Terminalny wynik prośby o zatwierdzenie (APPROVED/DENIED/EXPIRED). */
  const handleApprovalResult = (ap: InviteAccessPoint, data: InviteApprovalStatus) => {
    if (data.status === 'APPROVED' && data.gateOpened) {
      adoptCounters(ap.id, data.remainingUses, data.nextNonce)
      setRowStates((s) => ({ ...s, [ap.id]: 'done' }))
      onToast(`${ap.title} — otwarte`)
      setTimeout(() => setRowStates((s) => ({ ...s, [ap.id]: 'idle' })), RESET_MS)
      return
    }
    if (data.status === 'APPROVED') {
      // Zatwierdzone, ale bramka/zamek nie zadziałał — pozwól ponowić.
      if (data.nextNonce) setNonces((n) => ({ ...n, [ap.id]: data.nextNonce }))
      setRowStates((s) => ({ ...s, [ap.id]: 'failed' }))
      onToast('Zatwierdzono, ale nie udało się otworzyć — spróbuj ponownie', 'fail')
      setTimeout(() => setRowStates((s) => ({ ...s, [ap.id]: 'idle' })), RESET_MS)
      return
    }
    if (data.status === 'DENIED') {
      // Trwałe do reloadu — celowo bez auto-resetu.
      setRowStates((s) => ({ ...s, [ap.id]: 'denied' }))
      onToast('Gospodarz odmówił', 'fail')
      return
    }
    // EXPIRED — brak odpowiedzi gospodarza; przywróć przycisk (świeży nonce
    // z odpowiedzi; null + remainingUses 0 = limit dobity → „Wykorzystane ✓").
    adoptCounters(ap.id, data.remainingUses, data.nextNonce)
    setRowStates((s) => ({ ...s, [ap.id]: 'idle' }))
    onToast('Brak odpowiedzi gospodarza', 'fail')
  }

  // Polling /approval/:requestId co 2.5 s dla wszystkich aktywnych próśb.
  const inFlight = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (pendingCount === 0) return
    const poll = async () => {
      for (const [apId, info] of Object.entries(pending)) {
        if (inFlight.current.has(info.requestId)) continue
        inFlight.current.add(info.requestId)
        try {
          const res = await fetch(
            `/api/invite/${invite.token}/approval/${encodeURIComponent(info.requestId)}`,
            { cache: 'no-store' },
          )
          const data = (await res.json().catch(() => ({}))) as Partial<InviteApprovalStatus>
          if (!res.ok || !data.status || data.status === 'PENDING') continue
          const ap = invite.access.find((a) => a.id === apId)
          setPending((p) => {
            const { [apId]: _drop, ...rest } = p
            return rest
          })
          if (ap) handleApprovalResult(ap, data as InviteApprovalStatus)
        } catch {
          // Błąd sieci przy pollingu — próbujemy dalej do expiresAt.
        } finally {
          inFlight.current.delete(info.requestId)
        }
      }
    }
    const t = setInterval(poll, APPROVAL_POLL_MS)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, invite.token])

  const trigger = async (ap: InviteAccessPoint) => {
    if (disabled || usesLeft[ap.id] === 0) return
    if (ap.confirm) {
      setConfirmFor(ap)
      return
    }
    await doOpen(ap)
  }

  const doOpen = async (ap: InviteAccessPoint) => {
    const st = rowStates[ap.id]
    if (st === 'opening' || st === 'pending' || st === 'denied') return
    setRowStates((s) => ({ ...s, [ap.id]: 'opening' }))
    try {
      const res = await fetch(`/api/invite/${invite.token}/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessId: ap.id,
          clientTs: Date.now(),
          confirmedAt: ap.confirm ? Date.now() : undefined,
          // UNIT_DOOR: zawsze dołączamy aktualny nonce (jednorazowy, TTL 5 min).
          ...(ap.unitDoor ? { nonce: nonces[ap.id] ?? undefined } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))

      // Tryb zatwierdzania (UNIT_DOOR approvalRequired) — prośba poszła do
      // gospodarza; CTA w stan „Czekam…" + polling do approvalExpiresAt (~90 s).
      if (res.ok && data.status === 'pending' && data.requestId) {
        const expiresAt = data.approvalExpiresAt
          ? new Date(data.approvalExpiresAt).getTime()
          : Date.now() + 90_000
        setPending((p) => ({ ...p, [ap.id]: { requestId: String(data.requestId), expiresAt } }))
        setRowStates((s) => ({ ...s, [ap.id]: 'pending' }))
        return
      }

      if (!res.ok || data.status === 'failed' || data.status === 'timeout') {
        // Nowe kody 403 z backendu (ograniczenia dostępu) — pokazujemy
        // czytelny polski `message` z odpowiedzi zamiast generycznego błędu.
        const code = typeof data.code === 'string' ? data.code : ''
        let msg = typeof data.message === 'string' ? data.message : 'Nie udało się otworzyć'
        if (code === 'OUT_OF_SCHEDULE' && invite.schedule?.text && !msg.includes(invite.schedule.text)) {
          msg = `${msg} Dostęp: ${invite.schedule.text}.`
        }
        if (code === 'USES_EXHAUSTED') {
          // Limit dobity po stronie backendu — od razu wygaszamy przycisk lokalnie.
          setUsesLeft((u) => ({ ...u, [ap.id]: 0 }))
        }
        if (code === 'NONCE_INVALID' || code === 'NONCE_USED') {
          msg = 'Odśwież stronę, aby spróbować ponownie'
        }
        if (code === 'AP_NOT_ALLOWED') {
          // Backend już nie honoruje tego wejścia — ukrywamy wiersz.
          setHiddenAps((h) => ({ ...h, [ap.id]: true }))
        }
        // Błąd bramki może nieść świeży nonce — podmień, żeby dało się ponowić.
        if (typeof data.nextNonce === 'string' && data.nextNonce) {
          setNonces((n) => ({ ...n, [ap.id]: data.nextNonce }))
        }
        setRowStates((s) => ({ ...s, [ap.id]: 'failed' }))
        onToast(msg, 'fail')
        setTimeout(() => setRowStates((s) => ({ ...s, [ap.id]: 'idle' })), RESET_MS)
        return
      }

      // Sukces ('opened') — remainingUses/nextNonce z backendu są autorytatywne;
      // fallback: lokalny dekrement (starszy backend bez pola remainingUses).
      if (typeof data.remainingUses === 'number') {
        setUsesLeft((u) => ({ ...u, [ap.id]: data.remainingUses as number }))
      } else {
        setUsesLeft((u) => {
          const cur = u[ap.id]
          return typeof cur === 'number' ? { ...u, [ap.id]: Math.max(0, cur - 1) } : u
        })
      }
      if ('nextNonce' in data) {
        setNonces((n) => ({ ...n, [ap.id]: (data.nextNonce as string | null) ?? null }))
      }
      setRowStates((s) => ({ ...s, [ap.id]: 'done' }))
      onToast(`${ap.title} — otwarte`)
      setTimeout(() => setRowStates((s) => ({ ...s, [ap.id]: 'idle' })), RESET_MS)
    } catch {
      setRowStates((s) => ({ ...s, [ap.id]: 'failed' }))
      onToast('Błąd sieci — spróbuj ponownie', 'fail')
      setTimeout(() => setRowStates((s) => ({ ...s, [ap.id]: 'idle' })), RESET_MS)
    }
  }

  const visibleAccess = invite.access.filter((ap) => !hiddenAps[ap.id])
  if (visibleAccess.length === 0) return null

  return (
    <>
      <div className="gli-section-h">
        <h2>Twoje wejścia</h2>
        <span className="gli-hint">Naciśnij, aby otworzyć</span>
      </div>

      {/* Harmonogram cykliczny — tylko gdy backend go zwrócił (null = cały okres). */}
      {invite.schedule && (
        <div className="gli-schedule-row">
          <IconClock size={14} />
          <span>
            Dostęp: <strong>{invite.schedule.text}</strong>
          </span>
        </div>
      )}

      <div className="gli-access-list">
        {visibleAccess.map((ap) => {
          const remaining = usesLeft[ap.id]
          const exhausted = remaining === 0
          const state = rowStates[ap.id] ?? 'idle'
          const isPending = state === 'pending'
          const isDenied = state === 'denied'
          const secondsLeft = isPending && pending[ap.id]
            ? Math.max(0, Math.ceil((pending[ap.id].expiresAt - nowSec) / 1000))
            : null
          return (
            <button
              key={ap.id}
              type="button"
              className={`gli-access-row${exhausted ? ' gli-exhausted' : ''}`}
              disabled={disabled || exhausted || state === 'opening' || isPending || isDenied}
              onClick={() => trigger(ap)}
            >
              <div className={`gli-access-icon${ap.destructive ? ' gli-fire' : ''}${ap.unitDoor ? ' gli-unit-door' : ''}`}>
                {ap.unitDoor ? <IconKey /> : <AccessIcon kind={ap.icon} />}
              </div>
              <div className="gli-access-text">
                <div className="gli-access-title">{ap.title}</div>
                <div className="gli-access-sub">{ap.subtitle}</div>
                {isPending && (
                  <div className="gli-access-pending-note">
                    Czekam na zatwierdzenie gospodarza…
                    {secondsLeft !== null && ` (${secondsLeft} s)`}
                  </div>
                )}
                {!isPending && typeof remaining === 'number' && (
                  <div className={`gli-access-uses${exhausted ? ' gli-exhausted' : ''}`}>
                    {formatRemainingUses(remaining)}
                  </div>
                )}
              </div>
              <Cta state={state} ap={ap} exhausted={exhausted} secondsLeft={secondsLeft} />
            </button>
          )
        })}
      </div>

      {confirmFor && (
        <ConfirmSheet
          ap={confirmFor}
          onCancel={() => setConfirmFor(null)}
          onConfirm={async () => {
            const ap = confirmFor
            setConfirmFor(null)
            await doOpen(ap)
          }}
        />
      )}
    </>
  )
}

function Cta({ state, ap, exhausted, secondsLeft }: {
  state: RowState
  ap: InviteAccessPoint
  exhausted: boolean
  secondsLeft: number | null
}) {
  // Trwały stan „Wykorzystane ✓" — nadpisuje idle/failed, nie znika po re-render
  // (derived z licznika otwarć, nie z timeout-owanego rowState).
  if (exhausted && state !== 'done' && state !== 'opening' && state !== 'pending') {
    return (
      <span className="gli-access-cta gli-used-up">
        <IconCheck size={12} strokeWidth={2.4} />
        Wykorzystane
      </span>
    )
  }
  const baseCls = `gli-access-cta${ap.destructive ? ' gli-fire' : ''}${ap.unitDoor ? ' gli-unit-door' : ''}`
  switch (state) {
    case 'opening':
      return (
        <span className="gli-access-cta gli-opening">
          <span className="gli-spinner" />
          {ap.unitDoor && ap.approvalRequired ? 'Wysyłam' : 'Otwieram'}
        </span>
      )
    case 'pending':
      return (
        <span className="gli-access-cta gli-pending">
          <span className="gli-spinner" />
          Czekam{secondsLeft !== null ? ` ${secondsLeft} s` : '…'}
        </span>
      )
    case 'done':
      return (
        <span className="gli-access-cta gli-done">
          <IconCheck size={12} strokeWidth={2.4} />
          Otwarte
        </span>
      )
    case 'failed':
      return <span className="gli-access-cta gli-failed">Nie udało się</span>
    case 'denied':
      return <span className="gli-access-cta gli-denied">Gospodarz odmówił</span>
    default:
      return <span className={baseCls}>{ap.cta}</span>
  }
}

function AccessIcon({ kind }: { kind: InviteAccessPoint['icon'] }) {
  switch (kind) {
    case 'gate':     return <IconGate />
    case 'door':     return <IconDoor />
    case 'elevator': return <IconElevator />
    case 'home':     return <IconHome />
    case 'fire':     return <IconFire />
  }
}
