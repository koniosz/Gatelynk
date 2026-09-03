import { Invite } from './types'

interface Props {
  invite: Invite
}

/**
 * Stopka wg handoffu guest-pass-2026-07: krótkie ID zaproszenia (GTL-XXXX,
 * nie-używane do auth) + „Zgłoś nadużycie" jako mailto na kontakt platformy.
 *
 * Uczciwie „Połączenie szyfrowane" (TLS) zamiast „end-to-end" z prototypu —
 * link NIE jest szyfrowany e2e i nie składamy takiej obietnicy prawnie.
 */
const ABUSE_CONTACT = 'office@gatelynk.com'

export function Footer({ invite }: Props) {
  const mailto =
    `mailto:${ABUSE_CONTACT}` +
    `?subject=${encodeURIComponent(`Zgłoszenie nadużycia — zaproszenie ${invite.id}`)}` +
    `&body=${encodeURIComponent(
      `Zgłaszam nadużycie zaproszenia o identyfikatorze ${invite.id}.\n\nOpis problemu:\n`,
    )}`

  return (
    <div className="gli-footer">
      Połączenie szyfrowane · ID&nbsp;zaproszenia <strong>{invite.id}</strong>
      <br />
      Otrzymujesz je, bo {invite.host.firstName} {invite.host.lastName} udostępnił(a) Ci dostęp w Gatelynk.
      <br />
      <a href={mailto}>Zgłoś nadużycie</a>
    </div>
  )
}
