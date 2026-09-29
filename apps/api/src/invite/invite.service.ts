/**
 * InviteService — endpointy `/api/invite/*` dla nowej strony zaproszenia
 * `apps/web/src/app/i/[token]/`. Spec: `docs/design/guest-invite-2026-05-11/`.
 *
 * Architektura: wrapper nad `GuestPortalService` + transformacje na shape
 * `Invite` ze specu + nowe akcje (lazy-fetch PIN, report nadużycia).
 *
 * Decyzje (potwierdzone z userem 2026-05-11):
 *   • Drop-in replace: `/g/[token]` redirektuje do `/i/[token]` (frontend).
 *   • Token = istniejący opaque `Guest.urlToken` (32 random bytes hex).
 *   • Urządzenia: Edge stack (Akuvox/Hikvision) — tak jak teraz; Tedee/Nuki TODO.
 *   • Krótkie ID `GTL-XXXX` (uppercase ostatnich 4 chars tokenu) widoczne tylko
 *     dla user-a, nie używane do auth.
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  GoneException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { GuestPortalService } from '../guest-portal/guest-portal.service'
import { PushService } from '../push/push.service'

// Stałe rate limity. Spec mówi: GET 20/h/IP, POST 6/min/token.
// In-memory mapy — wystarczające na 1 instancję; dla wielu Fly machines
// będzie eventual consistency, ale to ataker DDOS-style nie krytyczne tu.
const GET_RATE_WINDOW_MS = 60 * 60 * 1000 // 1h
const GET_RATE_MAX = 20
const POST_RATE_WINDOW_MS = 60 * 1000 // 1 min
const POST_RATE_MAX = 6

/**
 * Zasady osiedla „Dobrze wiedzieć" — 2026-07-07 (guest-pass redesign):
 * BRAK źródła danych w schemacie (`Building` nie ma `guestRules`), a poprzedni
 * hardcode wymyślał nieprawdziwe fakty („sektor B, miejsce 7") — usunięty.
 * Frontend renderuje sekcję warunkowo (pusta lista = sekcja ukryta).
 * TODO: kolumna `Building.guestRules` (JSON string[]) + edycja w panelu BA.
 */
const RULES_PL: string[] = []

export interface InvitePayload {
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
  /** Harmonogram cykliczny (2026-07-08) — null = dostęp przez cały okres.
   *  `text` = gotowy polski opis np. "Codziennie 6:00–7:00". */
  schedule: { days: number[] | null; startTime: string; endTime: string; text: string } | null
  access: InviteAccessPoint[]
  hasPin: boolean // czy PIN istnieje (true zawsze dla aktywnych) — wartość pobierana osobno przez POST /pin
  rules: string[]
  security: { invitedAt: string; e2eEncrypted: true; revoked: false }
  windowStatus: 'OK' | 'UPCOMING' | 'EXPIRED'
}

export interface InviteAccessPoint {
  id: string // np. "ap-12" — string żeby pasowało do spec typu (gate/door/fire); mapowane na DB id w POST /open
  internalId: number // realne `AccessPoint.id` z DB — używane przez POST /open
  kind: 'gate' | 'door' | 'elevator' | 'fire'
  title: string
  subtitle: string
  icon: 'gate' | 'door' | 'elevator' | 'home' | 'fire'
  cta: string
  confirm: boolean
  destructive: boolean
  /** Limit otwarć (Guest.allowedAccessPoints, 2026-07-08). null = bez limitu. */
  maxUses: number | null
  /** Ile otwarć zostało (min 0). null = bez limitu. */
  remainingUses: number | null
  /** 2026-07-08 (Nuki) — drzwi lokalu (AccessPoint.category=UNIT_DOOR). */
  unitDoor: boolean
  /** UNIT_DOOR: otwarcie wymaga zatwierdzenia hosta (push → Zatwierdź). */
  approvalRequired: boolean
  /** UNIT_DOOR: jednorazowy podpisany nonce (TTL 5 min) — POST /open wymaga
   *  go w body. null = zwykłe AP albo limit wyczerpany („Wykorzystane ✓"). */
  nonce: string | null
  meta: { floor: number | null; deviceVendor: 'akuvox' | 'nuki' | 'tedee' | 'custom' }
}

@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name)

  /** Per-IP licznik GET — { ip → [timestamps] } */
  private getHits = new Map<string, number[]>()
  /** Per-token licznik POST — { token → [timestamps] } */
  private postHits = new Map<string, number[]>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly guestPortal: GuestPortalService,
    private readonly push: PushService,
  ) {}

  /**
   * `GET /api/invite/:token` — payload dla SSR strony.
   *
   * Mapuje wynik `guestPortal.getInvitation()` na shape `InvitePayload` ze
   * specu. **NIE** zwraca wartości PIN — gość pyta o nią explicit przez
   * `POST /pin` (audit purposes).
   *
   * Rzuca:
   *   • 404 NotFoundException — token nieznany
   *   • 410 GoneException — wygasłe / anulowane (frontend → not-found.tsx)
   *   • 429 — rate limit (20/h/IP)
   */
  async getInvite(token: string, ip: string | undefined): Promise<InvitePayload> {
    this.assertRateLimit('get', ip ?? 'unknown', this.getHits, GET_RATE_WINDOW_MS, GET_RATE_MAX)

    const portal = await this.guestPortal.getInvitation(token)

    // Pobranie reszty danych potrzebnych do payloadu Invite (host imię/nazwisko
    // pełne, estate.address, coords, securityPhone, apartament).
    // `guestPortal.getInvitation` zwraca tylko `inviterName` jako string —
    // pobieramy raw resident + building osobno żeby dostać firstName/lastName +
    // address + lat/lng + securityPhone.
    const guest = await this.prisma.guest.findFirst({
      where: { urlToken: token },
      select: {
        id: true,
        name: true,
        residentId: true,
        buildingId: true,
        validFrom: true,
        validTo: true,
        createdAt: true,
        resident: { select: { firstName: true, lastName: true } },
        building: { select: { name: true, address: true } },
      },
    })
    if (!guest) throw new NotFoundException('Invite not found')

    // Apartment string — pierwszy aktywny unit residenta (pivot UnitResident).
    const unit = await this.prisma.unitResident.findFirst({
      where: { residentId: guest.residentId, untilDate: null },
      include: { unit: { include: { stairwell: true } } },
      orderBy: { sinceDate: 'desc' },
    })
    const apartmentStr = unit
      ? [
          unit.unit?.stairwell?.name ? `Klatka ${unit.unit.stairwell.name}` : null,
          unit.unit?.floor != null ? `${unit.unit.floor} p.` : null,
          unit.unit?.number ? `m. ${unit.unit.number}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : ''

    // Krótkie czytelne ID — uppercase ostatnich 4 znaków tokenu.
    const id = `GTL-${token.slice(-4).toUpperCase()}`

    // Audit invite.viewed — fire-and-forget. Spec wymaga widoczności w
    // panelu hosta („Historia zaproszenia"). Pierwszy view ma znaczenie,
    // ale spamujemy logi gdyby bot scrappował. Dla MVP loguj każdy hit;
    // dla skali — dedupe per token+IP w 1h-okienku (TODO).
    this.prisma
      .$executeRaw`
        INSERT INTO "guest_events"
          ("buildingId", "residentId", "guestId", "via", "actorIp", "ts")
        VALUES (
          ${guest.buildingId},
          ${guest.residentId},
          ${guest.id},
          'PORTAL_VIEW',
          ${ip ?? null},
          NOW()
        )
      `
      .catch((err) => this.logger.warn(`PORTAL_VIEW audit failed: ${err.message}`))

    return {
      id,
      token,
      host: {
        firstName: guest.resident.firstName,
        lastName: guest.resident.lastName,
        initials: (guest.resident.firstName?.[0] ?? '?').toUpperCase(),
      },
      guest: {
        firstName: guest.name.split(' ')[0] ?? 'Witaj',
        locale: 'pl', // domyślnie pl; spec pozwala na 4 lang, frontend wybiera
      },
      estate: {
        name: guest.building.name,
        address: guest.building.address,
        apartment: apartmentStr,
        coords: null, // TODO: dodać `Building.lat/lng` w przyszłości
        securityPhone: null, // TODO: dodać `Building.securityPhone` w przyszłości
      },
      window: {
        startsAt: guest.validFrom.toISOString(),
        endsAt: guest.validTo.toISOString(),
        timezone: 'Europe/Warsaw',
      },
      schedule: portal.schedule,
      access: portal.accessPoints.map((ap) => this.toInviteAccessPoint(ap)),
      hasPin: portal.status !== 'EXPIRED',
      rules: RULES_PL,
      security: {
        invitedAt: guest.createdAt.toISOString(),
        e2eEncrypted: true,
        revoked: false,
      },
      windowStatus: portal.status as 'OK' | 'UPCOMING' | 'EXPIRED',
    }
  }

  /**
   * `POST /api/invite/:token/open` — proxy do `guestPortal.openAccessPoint`
   * z accessId mappingiem na `AccessPoint.id` (DB).
   *
   * Spec body: `{ accessId, clientTs, confirmedAt? }`. Tu `accessId` to nasz
   * wewnętrzny stringowy ID (np. „ap-12"); parsujemy z prefixu.
   */
  async openAccess(
    token: string,
    accessId: string,
    actorIp: string | undefined,
    nonce?: string,
  ): Promise<{
    status: 'opened' | 'failed' | 'timeout' | 'pending'
    message?: string
    remainingUses?: number | null
    nextNonce?: string | null
    requestId?: string
    approvalExpiresAt?: string
  }> {
    this.assertRateLimit('open', token, this.postHits, POST_RATE_WINDOW_MS, POST_RATE_MAX)

    const internalId = this.parseAccessId(accessId)
    if (internalId == null) {
      throw new HttpException({ code: 'INVALID_ACCESS_ID' }, HttpStatus.BAD_REQUEST)
    }

    try {
      const result = await this.guestPortal.openAccessPoint(token, internalId, actorIp, nonce)
      if (result.pending) {
        // Tryb zatwierdzania przez hosta — frontend polluje
        // GET /invite/:token/approval/:requestId.
        return {
          status: 'pending',
          message: result.label,
          requestId: result.requestId,
          approvalExpiresAt: result.approvalExpiresAt,
        }
      }
      return {
        status: result.success ? 'opened' : 'failed',
        message: result.label,
        remainingUses: result.remainingUses,
        nextNonce: result.nextNonce,
      }
    } catch (err: any) {
      if (err.status === HttpStatus.GONE) throw err
      if (err.status === HttpStatus.FORBIDDEN) throw err
      if (err.status === HttpStatus.TOO_MANY_REQUESTS) throw err
      if (err.status === HttpStatus.NOT_FOUND) throw err
      // BadGateway po skonsumowanym nonce niesie `nextNonce` — przekaż dalej,
      // żeby gość mógł ponowić bez przeładowania strony.
      const nextNonce = err?.response?.nextNonce
      return {
        status: 'failed',
        message: err.message ?? 'Edge timeout',
        ...(nextNonce ? { nextNonce } : {}),
      }
    }
  }

  /**
   * `GET /api/invite/:token/approval/:requestId` — polling gościa w trybie
   * zatwierdzania (UNIT_DOOR approvalRequired). Zwraca status + po APPROVED
   * świeże remainingUses/nextNonce.
   */
  async approvalStatus(token: string, requestId: string) {
    const id = Number(requestId)
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpException({ code: 'INVALID_REQUEST_ID' }, HttpStatus.BAD_REQUEST)
    }
    return this.guestPortal.getApprovalStatus(token, id)
  }

  /**
   * `POST /api/invite/:token/pin` — lazy fetch PIN-u. Spec mówi że pin
   * NIE może być w response GET — dopiero po explicit żądaniu.
   *
   * Body: `{ reason: 'reveal' | 'copy' }` — wpisywane do audit log.
   */
  async revealPin(
    token: string,
    reason: 'reveal' | 'copy',
    actorIp: string | undefined,
  ): Promise<{ pin: string; formatted: string }> {
    this.assertRateLimit('pin', token, this.postHits, POST_RATE_WINDOW_MS, POST_RATE_MAX)

    const portal = await this.guestPortal.getInvitation(token)
    if (portal.status !== 'OK') {
      throw new GoneException({ code: 'WINDOW_INACTIVE' })
    }

    const guest = await this.prisma.guest.findFirst({
      where: { urlToken: token },
      select: { id: true, buildingId: true, residentId: true },
    })
    if (!guest) throw new NotFoundException()

    // Audit do guest_events. Schema: kolumny `via` (varchar 32), `actorIp`,
    // `ts` (DEFAULT NOW). PIN_REVEAL / PIN_COPY są nowymi via-values — schema
    // trzyma to jako VARCHAR (nie enum), więc dodajemy bez migracji.
    await this.prisma
      .$executeRaw`
        INSERT INTO "guest_events"
          ("buildingId", "residentId", "guestId", "via", "actorIp", "ts")
        VALUES (
          ${guest.buildingId},
          ${guest.residentId},
          ${guest.id},
          ${reason === 'copy' ? 'PIN_COPY' : 'PIN_REVEAL'},
          ${actorIp ?? null},
          NOW()
        )
      `
      .catch((err) => {
        this.logger.warn(`PIN audit insert failed: ${err.message}`)
      })

    return {
      pin: portal.pin,
      formatted: this.formatPin(portal.pin),
    }
  }

  /**
   * `POST /api/invite/:token/report` — zgłoszenie nadużycia. Anuluje
   * zaproszenie + push do hosta + alert dla admina osiedla.
   *
   * Body: `{ reason }` (opcjonalny string krótki).
   */
  async reportAbuse(
    token: string,
    reason: string | undefined,
    actorIp: string | undefined,
  ): Promise<{ reported: true }> {
    this.assertRateLimit('report', token, this.postHits, POST_RATE_WINDOW_MS, POST_RATE_MAX)

    const guest = await this.prisma.guest.findFirst({
      where: { urlToken: token },
      select: { id: true, name: true, buildingId: true, residentId: true, status: true },
    })
    if (!guest) throw new NotFoundException()

    // Anuluj zaproszenie — flag `CANCELLED` w bazie. Każda kolejna próba
    // dostępu (GET / POST open / POST pin) zwróci 410 Gone.
    if (guest.status !== 'CANCELLED') {
      await this.prisma.$executeRaw`
        UPDATE "guests" SET "status" = 'CANCELLED'::"GuestStatus" WHERE id = ${guest.id}
      `
    }

    // Push do hosta — „Twoje zaproszenie zostało zgłoszone jako nadużycie".
    this.push
      .sendToResident(
        guest.residentId,
        'Zaproszenie zgłoszone jako nadużycie',
        `Zaproszenie dla „${guest.name}” zostało zgłoszone jako nadużycie i automatycznie anulowane.`,
        { type: 'invite_reported', guestId: guest.id },
      )
      .catch(() => {/* fire-and-forget */})

    // Audit do guest_events (via=REPORTED). Reason loguje się tylko do
    // server-log-a — `guest_events` nie ma jeszcze kolumny `meta`. Jeśli
    // potrzebne strukturalnie, dodać migracją ALTER TABLE ADD meta JSONB.
    await this.prisma
      .$executeRaw`
        INSERT INTO "guest_events"
          ("buildingId", "residentId", "guestId", "via", "actorIp", "ts")
        VALUES (
          ${guest.buildingId},
          ${guest.residentId},
          ${guest.id},
          'REPORTED',
          ${actorIp ?? null},
          NOW()
        )
      `
      .catch((err) => this.logger.warn(`Report audit insert failed: ${err.message}`))

    this.logger.warn(
      `Invite reported as abuse: guest#${guest.id} (${guest.name}) ` +
        `building=${guest.buildingId} ip=${actorIp ?? '?'} reason=${reason ?? '-'}`,
    )

    return { reported: true }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Mapuje AccessPoint z DB na shape ze specu. Icon→kind mapping zgodny z designem.
   *  FIRE: autorytatywnie z `AccessPoint.category === 'FIRE_ESCAPE'` (FAZA c),
   *  fallback heurystyka po labelu (stare AP sprzed kategorii). */
  private toInviteAccessPoint(ap: {
    id: number
    label: string
    icon: string | null
    sortOrder: number
    category?: string
    maxUses?: number | null
    remainingUses?: number | null
    unitDoor?: boolean
    approvalRequired?: boolean
    nonce?: string | null
  }): InviteAccessPoint {
    const icon = (ap.icon ?? 'door') as 'door' | 'gate' | 'elevator' | 'barrier' | 'home' | 'fire'
    const labelLower = ap.label.toLowerCase()
    const isUnitDoor = ap.unitDoor === true || ap.category === 'UNIT_DOOR'
    const isFire =
      ap.category === 'FIRE_ESCAPE' ||
      labelLower.includes('poż') || labelLower.includes('fire') || labelLower.includes('awar')
    const isElevator = icon === 'elevator' || labelLower.includes('winda') || labelLower.includes('elevator')
    const isGate = icon === 'gate' || icon === 'barrier' || labelLower.includes('brama') || labelLower.includes('szlaban')

    const kind: 'gate' | 'door' | 'elevator' | 'fire' = isFire && !isUnitDoor
      ? 'fire'
      : isElevator && !isUnitDoor
        ? 'elevator'
        : isGate && !isUnitDoor
          ? 'gate'
          : 'door'

    const cta = kind === 'elevator' ? 'Wezwij' : kind === 'fire' ? 'Awaryjnie' : 'Otwórz'

    // Subtitle z label-a — pierwsza po średniku część albo label sam.
    // Spec ma fixed labels, my zgadujemy z `AccessPoint.label`.
    const subtitle = isUnitDoor
      ? (ap.approvalRequired ? 'Drzwi mieszkania · wymaga zgody gospodarza' : 'Drzwi mieszkania · zamek Nuki')
      : this.deriveSubtitle(ap.label, kind)

    return {
      id: `ap-${ap.id}`,
      internalId: ap.id,
      kind,
      title: ap.label,
      subtitle,
      icon: isUnitDoor
        ? 'home'
        : kind === 'fire' ? 'fire' : kind === 'elevator' ? 'elevator' : kind === 'gate' ? 'gate' : 'door',
      cta: isUnitDoor && ap.approvalRequired ? 'Poproś o otwarcie' : cta,
      confirm: kind === 'fire',
      destructive: kind === 'fire',
      maxUses: ap.maxUses ?? null,
      remainingUses: ap.remainingUses ?? null,
      unitDoor: isUnitDoor,
      approvalRequired: ap.approvalRequired === true,
      nonce: ap.nonce ?? null,
      meta: {
        floor: null,
        deviceVendor: isUnitDoor ? 'nuki' : 'akuvox',
      },
    }
  }

  private deriveSubtitle(label: string, kind: string): string {
    const lower = label.toLowerCase()
    if (kind === 'fire') return 'Tylko w sytuacji awaryjnej'
    if (kind === 'gate') return 'Wjazd główny · szlaban'
    if (kind === 'elevator') return 'Wezwie windę i wybierze piętro'
    if (lower.includes('klatka')) return 'Wejście do klatki'
    if (lower.includes('mieszk')) return 'Drzwi mieszkania'
    return 'Wejście pieszo'
  }

  /** "482309" → "482 309" do display. */
  private formatPin(pin: string): string {
    if (pin.length !== 6) return pin
    return `${pin.slice(0, 3)} ${pin.slice(3)}`
  }

  /**
   * Parsuje `ap-12` → `12`. Pozostawia generic prefix-handling — w przyszłości
   * dla Tedee dostaniemy `td-{uuid}` i to też trzeba będzie obsłużyć.
   */
  private parseAccessId(accessId: string): number | null {
    const m = accessId.match(/^ap-(\d+)$/)
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) ? n : null
  }

  /**
   * Sliding-window rate limit. Map[key] → [timestamps] w ostatnim oknie.
   * Throw 429 gdy lista przekracza limit.
   */
  private assertRateLimit(
    op: string,
    key: string,
    map: Map<string, number[]>,
    windowMs: number,
    max: number,
  ): void {
    const now = Date.now()
    const cutoff = now - windowMs
    const list = (map.get(key) ?? []).filter((t) => t > cutoff)
    if (list.length >= max) {
      throw new HttpException(
        { code: 'RATE_LIMIT', op, retryAfter: Math.ceil(windowMs / 1000) },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }
    list.push(now)
    map.set(key, list)
  }
}
