/**
 * Shape `Invite` zgodny ze spec backendu (`apps/api/src/invite/invite.service.ts`)
 * i `docs/design/guest-invite-2026-05-11/Guest Invite - Spec.md`.
 *
 * `internalId` to dodatek nasz — backend DTO ma `id` jako string typu „ap-12";
 * frontend nie potrzebuje internalId, ale jest w response żeby debugować łatwiej.
 */
export interface Invite {
  id: string
  token: string
  host: { firstName: string; lastName: string; initials: string }
  guest: { firstName: string; locale: 'pl' | 'en' | 'uk' | 'de' }
  estate: {
    name: string
    address: string
    apartment: string
    coords: { lat: number; lng: number } | null
    securityPhone: string | null
  }
  window: { startsAt: string; endsAt: string; timezone: string }
  access: InviteAccessPoint[]
  hasPin: boolean
  rules: string[]
  security: { invitedAt: string; e2eEncrypted: boolean; revoked: boolean }
  windowStatus: 'OK' | 'UPCOMING' | 'EXPIRED'
  /**
   * Harmonogram cykliczny dostępu (ADDYTYWNE, opcjonalne — starszy backend
   * nie zwraca pola). `null`/brak = dostęp przez cały okres ważności.
   * `text` to gotowy polski opis z backendu, np. „Codziennie 6:00–7:00".
   */
  schedule?: InviteSchedule | null
}

/** Harmonogram cykliczny zaproszenia — dni ISO (1=pn..7=nd), null = codziennie. */
export interface InviteSchedule {
  days: number[] | null
  startTime: string
  endTime: string
  text: string
}

export interface InviteAccessPoint {
  id: string
  internalId?: number
  kind: 'gate' | 'door' | 'elevator' | 'fire'
  title: string
  subtitle: string
  icon: 'gate' | 'door' | 'elevator' | 'home' | 'fire'
  cta: string
  confirm: boolean
  destructive: boolean
  meta: { floor: number | null; deviceVendor: string }
  /**
   * Limit otwarć per wejście (ADDYTYWNE, opcjonalne — starszy backend nie
   * zwraca). `null` = bez limitu; liczba = ile otwarć zostało (może być 0).
   */
  remainingUses?: number | null
  /** Maksymalna liczba otwarć dla tego wejścia; `null` = bez limitu. */
  maxUses?: number | null
  /** Drzwi mieszkania (zamek Nuki, category=UNIT_DOOR) — akcent bursztynowy. */
  unitDoor?: boolean
  /** true = klik wysyła prośbę do gospodarza (status 'pending' + polling). */
  approvalRequired?: boolean
  /**
   * Jednorazowy podpisany token (TTL 5 min) — POST /open dla unitDoor MUSI
   * go dołączyć. `null` = limit otwarć wyczerpany (przycisk „Wykorzystane ✓").
   * Po otwarciu backend zwraca `nextNonce` — podmieniamy w stanie klienta.
   */
  nonce?: string | null
}

/** Odpowiedź `GET /api/invite/:token/approval/:requestId` (polling co 2.5 s). */
export interface InviteApprovalStatus {
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED'
  gateOpened: boolean
  expiresAt: string
  remainingUses: number | null
  nextNonce: string | null
}
