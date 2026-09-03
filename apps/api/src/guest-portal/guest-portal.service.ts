import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadGatewayException,
  GoneException,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { PrismaService } from '../prisma/prisma.service'
import { EdgeGateway } from '../edge/edge.gateway'
import { PushService, GUEST_USE_PUSH_THROTTLE_MS } from '../push/push.service'
import { AccessEventsService } from '../access-events/access-events.service'
import {
  hasPermission,
  normalizePermissions,
  apKey,
  type BuildingFeaturePermissions,
} from '../buildings/feature-permissions.constants'
import {
  isWithinSchedule,
  allowedEntryFor,
  describeSchedulePl,
  type AllowedAccessPointEntry,
  type RecurringSchedule,
} from '../guests/guest-restrictions.util'
import {
  issueGuestOpenNonce,
  verifyGuestOpenNonce,
  guestOpenNonceHash,
} from './guest-nonce.util'

/** TTL prośby o zatwierdzenie przez hosta (UNIT_DOOR approvalRequired). */
const APPROVAL_TTL_MS = 90_000

/**
 * GuestPortalService — bezkontaktowy mikroportal gościa.
 *
 * Architektura:
 *   • Gość dostaje URL `gatelynk.com/g/<token>` (Resend email lub iMessage SMS).
 *   • Portal pyta `GET /api/guest-portal/:token` o stan zaproszenia + listę
 *     punktów dostępu (`AccessPoint`) — wyświetla przyciski.
 *   • Klik → `POST /api/guest-portal/:token/open` z `accessPointId`. Service
 *     waliduje okno czasowe + idzie tą samą ścieżką co `ResidentService.openAccessPoint`
 *     (Edge HTTP `POST /devices/{deviceId}/relay/{relayIndex}` na porcie 4000).
 *
 * Bezpieczeństwo:
 *   • Token = 64-hex (32 random bytes) — entropia 256-bit, nieodgadywalny.
 *   • Brak guard-ów / JWT — sam token jest credentialem (capability URL).
 *   • Rate limit per-token: 10 open/min — chroni przed spam-em (gość który
 *     trzyma kciuk na przycisku).
 *   • Każde otwarcie → `markGuestUse`: `usedAt` przy pierwszym razie,
 *     push do mieszkańca z throttle 5 min per gość (2026-07-15).
 */

// Dispatcher do Edge przez Tailscale userspace proxy — dokładnie jak w
// ResidentService. Cloud na Fly.io chodzi w userspace mode (brak /dev/net/tun)
// i bez tego routingu fetch do `100.x.x.x:4000` time-out-uje.
const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

interface GuestPortalRow {
  id: number
  buildingId: number
  residentId: number
  name: string
  pin: string
  validFrom: Date
  validTo: Date
  status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED'
  usedAt: Date | null
  urlToken: string | null
  email: string | null
  // Ograniczenia dostępu (2026-07-08) — JSONB, NULL = bez ograniczeń.
  allowedAccessPoints: AllowedAccessPointEntry[] | null
  recurringSchedule: RecurringSchedule | null
}

export interface AccessPointPublic {
  id: number
  label: string
  icon: string | null
  sortOrder: number
  /** Semantyczna kategoria AP (FAZA c) — portal używa `FIRE_ESCAPE` do
   *  potwierdzenia w bottom sheet. Wartości w access-points.constants.ts. */
  category: string
  /** Limit otwarć dla tego AP (z Guest.allowedAccessPoints). null = bez limitu. */
  maxUses: number | null
  /** Ile otwarć zostało (maxUses − zużyte, min 0). null = bez limitu. */
  remainingUses: number | null
  /** 2026-07-08 (Nuki) — true dla drzwi lokalu (category=UNIT_DOOR). */
  unitDoor: boolean
  /** UNIT_DOOR: czy otwarcie wymaga zatwierdzenia przez hosta. */
  approvalRequired: boolean
  /** UNIT_DOOR: jednorazowy podpisany nonce (HMAC, TTL 5 min) wymagany przy
   *  open. null dla zwykłych AP oraz gdy limit wyczerpany. */
  nonce: string | null
}

/** Kształt odpowiedzi otwarcia portalowego (patrz openAccessPoint). */
export interface PortalOpenResult {
  success: boolean
  label: string
  /** Ile otwarć zostało po tym otwarciu. null = bez limitu. */
  remainingUses: number | null
  /** UNIT_DOOR: świeży nonce na kolejne otwarcie (gdy remaining > 0). */
  nextNonce: string | null
  /** Tryb zatwierdzania: request czeka na hosta. */
  pending?: boolean
  requestId?: string
  approvalExpiresAt?: string
}

/** Harmonogram cykliczny w odpowiedzi portalu — z gotowym polskim opisem. */
export interface PortalSchedule {
  days: number[] | null
  startTime: string
  endTime: string
  text: string
}

@Injectable()
export class GuestPortalService {
  private readonly logger = new Logger(GuestPortalService.name)

  /** Rate limit: token → ostatnie timestampy otwarć (okno 60s, max 10).
   *  In-memory, nie-distributed — pojedyncza instancja API jest OK na
   *  start (Fly autoscale → przyjmiemy że atak rozpłynie się między
   *  instances naturalnie; na potrzebę przepisać na Redis później). */
  private opensByToken: Map<string, number[]> = new Map()
  private static readonly RATE_LIMIT_WINDOW_MS = 60_000
  private static readonly RATE_LIMIT_MAX = 10

  constructor(
    private readonly prisma: PrismaService,
    private readonly edgeGateway: EdgeGateway,
    private readonly push: PushService,
    private readonly accessEvents: AccessEventsService,
  ) {}

  /**
   * `GET /api/guest-portal/:token` — informacje dla portalu (gość widzi):
   *   • własne imię + nazwa budynku + zapraszający (kto cię zaprosił)
   *   • okno czasowe (do kiedy działa link)
   *   • listę bram do otwierania
   *   • PIN jako fallback (gdyby gość chciał skorzystać z klawiatury)
   *
   * Stan zaproszenia (`status`):
   *   • OK         — w oknie, można otwierać
   *   • UPCOMING   — przed validFrom (np. „zaproszenie ważne od 14:00")
   *   • EXPIRED    — po validTo lub status=EXPIRED
   *   • CANCELLED  — mieszkaniec odwołał
   *   • UNKNOWN    — token nie istnieje (404; portal pokazuje generyczny komunikat)
   */
  async getInvitation(token: string): Promise<{
    status: 'OK' | 'UPCOMING' | 'EXPIRED' | 'CANCELLED'
    guestName: string
    buildingName: string
    inviterName: string
    validFrom: string
    validTo: string
    pin: string
    accessPoints: AccessPointPublic[]
    /** Harmonogram cykliczny (2026-07-08) — null = cały okres ważności. */
    schedule: PortalSchedule | null
  }> {
    const guest = await this.findByToken(token)

    if (guest.status === 'CANCELLED') {
      throw new GoneException({
        code: 'CANCELLED',
        message: 'Zaproszenie zostało anulowane przez gospodarza.',
      })
    }

    const now = Date.now()
    const validFromMs = new Date(guest.validFrom).getTime()
    const validToMs = new Date(guest.validTo).getTime()

    let portalStatus: 'OK' | 'UPCOMING' | 'EXPIRED'
    if (guest.status === 'EXPIRED' || validToMs <= now) {
      // 410 Gone — portal pokaże informację „zaproszenie wygasło".
      throw new GoneException({
        code: 'EXPIRED',
        message: 'Zaproszenie wygasło. Skontaktuj się z gospodarzem.',
      })
    } else if (validFromMs > now) {
      portalStatus = 'UPCOMING'
    } else {
      portalStatus = 'OK'
    }

    // Building name + inviter — proste join-y. Resident ma firstName+lastName.
    const [building, inviter] = await Promise.all([
      this.prisma.building.findUnique({
        where: { id: guest.buildingId },
        select: { name: true },
      }),
      this.prisma.resident.findUnique({
        where: { id: guest.residentId },
        select: { firstName: true, lastName: true },
      }),
    ])

    if (!building) throw new NotFoundException('Budynek nie istnieje')

    const accessPoints = await this.listGuestAccessPoints(guest.buildingId, guest)

    // Harmonogram cykliczny — gotowy polski opis dla frontendu.
    const schedule: PortalSchedule | null = guest.recurringSchedule
      ? {
          days: guest.recurringSchedule.days ?? null,
          startTime: guest.recurringSchedule.startTime,
          endTime: guest.recurringSchedule.endTime,
          text: describeSchedulePl(guest.recurringSchedule) ?? '',
        }
      : null

    return {
      status: portalStatus,
      guestName: guest.name,
      buildingName: building.name,
      inviterName: inviter
        ? `${inviter.firstName} ${inviter.lastName}`.trim()
        : 'Mieszkaniec',
      validFrom: new Date(guest.validFrom).toISOString(),
      validTo: new Date(guest.validTo).toISOString(),
      pin: guest.pin,
      accessPoints,
      schedule,
    }
  }

  /**
   * `POST /api/guest-portal/:token/open` — gość klika przycisk „Otwórz wjazd".
   *
   * Walidacja w kolejności:
   *   1. Token istnieje i guest jest ACTIVE → poprawny capability URL.
   *   2. Czas now() ∈ [validFrom..validTo] → okno aktywne.
   *   3. Rate limit per-token (max 10/min) → ochrona przed spamem.
   *   4. AccessPoint należy do tego buildingu → izolacja między budynkami.
   *   5. Edge online (WS lub static IP fallback) → fizyczna komenda przejdzie.
   *
   * Po sukcesie:
   *   • `usedAt` ustawione (idempotentnie — pierwszy raz triggeruje push).
   *   • Cloud nie woła `markGuestUse` z osobnego serwisu, tylko inline raw SQL —
   *     to zaproszenie nie idzie przez Akuvox PIN, więc nie ma race-z LPR/PIN.
   */
  async openAccessPoint(
    token: string,
    accessPointId: number,
    actorIp: string | undefined,
    nonce?: string,
  ): Promise<PortalOpenResult> {
    const guest = await this.findByToken(token)

    if (guest.status === 'CANCELLED') {
      throw new GoneException({ code: 'CANCELLED' })
    }
    const now = Date.now()
    const validFromMs = new Date(guest.validFrom).getTime()
    const validToMs = new Date(guest.validTo).getTime()
    if (guest.status === 'EXPIRED' || validToMs <= now) {
      throw new GoneException({ code: 'EXPIRED' })
    }
    if (validFromMs > now) {
      throw new ForbiddenException({
        code: 'NOT_YET',
        message: 'Zaproszenie jeszcze nieaktywne.',
        validFrom: new Date(guest.validFrom).toISOString(),
      })
    }

    // Rate limit. Liczymy per-token, nie per-IP — gość może być za NAT-em
    // i dwóch gości z tego samego ISP nie powinno się blokować nawzajem.
    if (!this.allowOpen(token)) {
      throw new HttpException(
        {
          code: 'RATE_LIMIT',
          message: 'Za dużo prób w krótkim czasie. Spróbuj za chwilę.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    // Cross-building: AccessPoint musi należeć do buildingu zaproszenia.
    // Bez tego ktoś ze złamanego linku z budynku A mógłby otwierać bramy budynku B.
    //
    // 2026-07-07 (guest-pass redesign): gość NIE może otworzyć AP których nie
    // widzi w portalu — `scope=ADMIN_ONLY` oraz AP wyłączone dla roli resident
    // w Permissions Matrix są odrzucane (zawężenie, nigdy rozszerzenie uprawnień).
    const ap = await this.prisma.accessPoint.findFirst({
      where: {
        id: accessPointId,
        buildingId: guest.buildingId,
        isActive: true,
        scope: { not: 'ADMIN_ONLY' },
      },
    })
    if (!ap) throw new NotFoundException('Punkt dostępu nie istnieje')
    const perms = await this.loadPermissions(guest.buildingId)
    if (!hasPermission(perms, 'resident', apKey(ap.id))) {
      throw new NotFoundException('Punkt dostępu nie istnieje')
    }

    // ── Ograniczenia dostępu gościa (2026-07-08) ─────────────────────────────
    // Kolejność: allowlista AP → harmonogram cykliczny → limit użyć.
    // Odmowy audytowane w access_events (REMOTE_OPEN, gateOpened=false,
    // reason) — panel/iOS widzi próbę tak samo jak odmowy PIN na Edge.

    // 1. Allowlista AP — gość NIE otworzy wejścia spoza swojego zaproszenia.
    //    UNIT_DOOR (drzwi lokalu, Nuki): wpis musi być JAWNY — brak allowlisty
    //    („bez ograniczeń") NIE daje dostępu do drzwi lokalu.
    const isUnitDoor = ap.category === 'UNIT_DOOR'
    const apEntry = allowedEntryFor(guest.allowedAccessPoints, ap.id)
    if (!apEntry.allowed || (isUnitDoor && !apEntry.explicit)) {
      this.recordDeniedOpen(guest, ap.id, 'AP_NOT_ALLOWED', actorIp)
      throw new ForbiddenException({
        code: 'AP_NOT_ALLOWED',
        message: 'To wejście nie jest dostępne w Twoim zaproszeniu.',
      })
    }

    // 2. Harmonogram cykliczny (Europe/Warsaw) — działa W RAMACH okna ważności.
    if (!isWithinSchedule(guest.recurringSchedule, now)) {
      const text = describeSchedulePl(guest.recurringSchedule)
      this.recordDeniedOpen(guest, ap.id, 'OUT_OF_SCHEDULE', actorIp)
      throw new ForbiddenException({
        code: 'OUT_OF_SCHEDULE',
        message: text
          ? `Dostęp działa: ${text}. Spróbuj w tych godzinach.`
          : 'Dostęp poza godzinami harmonogramu.',
        scheduleText: text ?? undefined,
      })
    }

    // 3. Limit użyć per AP — suma wszystkich source'ów (portal + PIN + LPR
    //    raportowane z Edge). Eventual consistency: użycia PIN/LPR w czasie
    //    offline Edge dolicza się dopiero po dosyncu (okno niedokładności).
    let usedSoFar = 0
    if (apEntry.maxUses !== null) {
      usedSoFar = (await this.usesByAccessPoint(guest.id).catch(() => new Map())).get(ap.id) ?? 0
      if (usedSoFar >= apEntry.maxUses) {
        this.recordDeniedOpen(guest, ap.id, 'USES_EXHAUSTED', actorIp)
        throw new ForbiddenException({
          code: 'USES_EXHAUSTED',
          message: 'Limit otwarć dla tego wejścia został wykorzystany.',
        })
      }
    }

    // 4. UNIT_DOOR (Nuki): jednorazowy podpisany nonce — obowiązkowy.
    //    Weryfikacja stateless (HMAC + TTL 5 min), konsumpcja ATOMOWA przez
    //    INSERT unique(nonceHash) ON CONFLICT DO NOTHING — z dwóch równoległych
    //    requestów z tym samym nonce'em dokładnie jeden przechodzi dalej.
    //    Konsumujemy PO tańszych checkach (limit/harmonogram), żeby odmowa
    //    nie paliła nonce'a.
    if (isUnitDoor) {
      const v = verifyGuestOpenNonce(nonce, guest.id, ap.id)
      if (!v.ok) {
        this.recordDeniedOpen(guest, ap.id, 'NONCE_INVALID', actorIp)
        throw new ForbiddenException({
          code: 'NONCE_INVALID',
          message:
            v.reason === 'EXPIRED'
              ? 'Kod otwarcia wygasł — odśwież stronę i spróbuj ponownie.'
              : 'Nieprawidłowy kod otwarcia — odśwież stronę.',
        })
      }
      const consumed = await this.consumeNonce(guest.id, ap.id, nonce as string, v.expMs)
      if (!consumed) {
        this.recordDeniedOpen(guest, ap.id, 'NONCE_USED', actorIp)
        throw new ForbiddenException({
          code: 'NONCE_USED',
          message: 'Ten kod otwarcia został już wykorzystany.',
        })
      }
    }

    // 5. Tryb zatwierdzania przez hosta (UNIT_DOOR + approvalRequired):
    //    zamiast otwierać — PENDING request (TTL 90 s) + push do mieszkańca.
    //    Otwarcie wykona Cloud dopiero po POST /resident/guest-approvals/:id/approve.
    if (isUnitDoor && apEntry.approvalRequired) {
      return this.createApprovalRequest(guest, ap.id, ap.label, actorIp)
    }

    try {
      await this.callEdgeOpen(guest.buildingId, ap.deviceId, ap.relayIndex)
    } catch (err: any) {
      this.logger.warn(
        `Guest portal open failed: token=${this.maskToken(token)} ap=${ap.id} ` +
        `ip-actor=${actorIp ?? '?'} err=${err.message}`,
      )
      // UNIT_DOOR: nonce już skonsumowany — oddajemy świeży, żeby gość mógł
      // ponowić bez przeładowania strony (limit NIE został zliczony).
      throw new BadGatewayException({
        message: `Nie udało się otworzyć: ${err?.message ?? 'błąd bramki'}`,
        nextNonce: isUnitDoor ? issueGuestOpenNonce(guest.id, ap.id) : undefined,
      })
    }

    const result = await this.finalizeGuestOpen(guest, ap.id, ap.label, isUnitDoor, apEntry.maxUses, usedSoFar, actorIp, 'guest-portal')

    this.logger.log(
      `Guest portal opened: guest#${guest.id} (${guest.name}) → ` +
      `${ap.label} [building ${guest.buildingId}] from ip=${actorIp ?? '?'}`,
    )

    return result
  }

  /**
   * Wspólny epilog udanego otwarcia portalowego (bezpośredniego lub po
   * zatwierdzeniu przez hosta): zliczenie użycia, dosync Edge, audyt,
   * pushe, wyliczenie remainingUses + nextNonce.
   */
  private async finalizeGuestOpen(
    guest: GuestPortalRow,
    apId: number,
    apLabel: string,
    isUnitDoor: boolean,
    maxUses: number | null,
    usedSoFar: number,
    actorIp: string | undefined,
    source: 'guest-portal' | 'guest-portal-approval',
    approvedByResidentId?: number,
  ): Promise<PortalOpenResult> {
    // Zliczanie użyć (2026-07-08): otwarcie portalowe = użycie. INSERT
    // append-only (bez race read-modify-write). AWAIT — kolejny klik musi
    // widzieć zaktualizowany licznik.
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "guest_access_uses" ("buildingId", "guestId", "accessPointId", "source")
        VALUES (${guest.buildingId}, ${guest.id}, ${apId}, 'PORTAL')
      `
    } catch (err: any) {
      this.logger.warn(`guest_access_uses insert failed: ${err.message}`)
    }
    // Dosync snapshotu użyć portalowych do Edge (PIN_UPSERT z pełnym stanem
    // ograniczeń) — Edge liczy limit offline jako lokalne PIN/LPR + portal.
    this.resyncGuestRestrictionsToEdge(guest).catch((err) =>
      this.logger.warn(`resyncGuestRestrictionsToEdge failed: ${err.message}`),
    )

    // Każde otwarcie loguje do guest_events (panel "Historia gości").
    this.recordPortalOpenEvent(guest.buildingId, guest.id, guest.residentId, apId, actorIp)
      .catch((err) => this.logger.warn(`recordPortalOpenEvent failed: ${err.message}`))

    // Faza 3: AccessEvent audit (REMOTE_OPEN przez portal gościa).
    // meta.provider='nuki' dla drzwi lokalu (UNIT_DOOR — driver Nuki na Edge).
    this.accessEvents.record({
      buildingId: guest.buildingId,
      type: 'REMOTE_OPEN',
      accessPointId: apId,
      gateOpened: true,
      guestId: guest.id,
      residentId: guest.residentId,
      openedById: approvedByResidentId ?? undefined,
      openedByType: approvedByResidentId ? 'RESIDENT' : 'SYSTEM',
      meta: {
        source,
        actorIp: actorIp ?? null,
        ...(isUnitDoor ? { provider: 'nuki' } : {}),
      },
    }).catch(() => { /* logged inside */ })

    // Pushe do hosta (2026-07-15 — powiadamiamy przy KAŻDYM otwarciu):
    //   • UNIT_DOOR: KAŻDE otwarcie drzwi lokalu → push bez throttle (wymóg
    //     bezpieczeństwa; przy trybie zatwierdzania pomijamy — host właśnie
    //     sam zatwierdził).
    //   • pozostałe AP: KAŻDE otwarcie → push z throttle 5 min per gość
    //     (wspólny klucz `guest-use-<id>` z PIN/LPR — brak duplikatów, gdy
    //     gość użyje kilku kanałów naraz).
    if (isUnitDoor && !approvedByResidentId) {
      this.push
        .sendToResident(
          guest.residentId,
          '🚪 Twój gość otworzył drzwi mieszkania',
          `${guest.name} — ${apLabel}`,
          { kind: 'GUEST_UNIT_DOOR_OPEN', guestId: guest.id },
        )
        .catch((err) =>
          this.logger.warn(`Push (unit-door open) failed for guest#${guest.id}: ${err.message}`),
        )
    }
    // Dla UNIT_DOOR / approved open push już poszedł (lub host sam
    // zatwierdził) — markGuestUse tylko ustawia usedAt (silent).
    await this.markGuestUse(
      guest.id, guest.residentId, guest.name, apLabel, actorIp,
      isUnitDoor || !!approvedByResidentId,
    )

    const remainingUses = maxUses !== null ? Math.max(0, maxUses - (usedSoFar + 1)) : null
    const nextNonce =
      isUnitDoor && (remainingUses === null || remainingUses > 0)
        ? issueGuestOpenNonce(guest.id, apId)
        : null

    return { success: true, label: apLabel, remainingUses, nextNonce }
  }

  /**
   * Fizyczne otwarcie przez Edge — ta sama ścieżka co ResidentService
   * (HTTP `POST /devices/{deviceId}/relay/{relayIndex}` na porcie 4000).
   * Dla SMART_LOCK Edge dispatchuje do drivera NUKI (Web API unlatch) —
   * dlatego timeout 12 s (Nuki API ma własny timeout 10 s po stronie Edge).
   */
  private async callEdgeOpen(buildingId: number, deviceId: string, relayIndex: number): Promise<void> {
    let ip: string | undefined = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      const edge = await this.prisma.edgeDevice.findFirst({
        where: { buildingId, isActivated: true },
        orderBy: { lastSeenAt: 'desc' },
      })
      ip = edge?.ipAddress ?? undefined
    }
    if (!ip) {
      throw new Error('Brak połączenia z bramką — spróbuj ponownie za chwilę.')
    }
    const res = await undiciFetch(
      `http://${ip}:4000/devices/${deviceId}/relay/${relayIndex}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(12_000),
        dispatcher: edgeDispatcher,
      },
    )
    if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
  }

  /**
   * Atomowa konsumpcja nonce'a: INSERT unique(nonceHash) ON CONFLICT DO
   * NOTHING. Zwraca true gdy TEN request skonsumował nonce (rowCount=1);
   * false gdy ktoś był szybszy (drugi równoległy klik) — race-safe bez
   * SELECT-then-INSERT.
   */
  private async consumeNonce(
    guestId: number,
    accessPointId: number,
    nonce: string,
    expMs: number,
  ): Promise<boolean> {
    const hash = guestOpenNonceHash(nonce)
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO "guest_open_nonces" ("guestId", "accessPointId", "nonceHash", "expiresAt")
      VALUES (${guestId}, ${accessPointId}, ${hash}, ${new Date(expMs)})
      ON CONFLICT ("nonceHash") DO NOTHING
    `
    return inserted === 1
  }

  // ── Tryb zatwierdzania przez hosta (2026-07-08, UNIT_DOOR) ──────────────────

  /**
   * Tworzy PENDING request (TTL 90 s) + push do hosta. Idempotencja: świeży
   * PENDING dla tej samej pary (guest, AP) jest reużywany (bez drugiego pusha)
   * — gość który kliknie dwa razy nie spamuje mieszkańca.
   */
  private async createApprovalRequest(
    guest: GuestPortalRow,
    apId: number,
    apLabel: string,
    actorIp: string | undefined,
  ): Promise<PortalOpenResult> {
    const existing = await this.prisma.guestApprovalRequest.findFirst({
      where: {
        guestId: guest.id,
        accessPointId: apId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (existing) {
      return {
        success: true,
        label: apLabel,
        remainingUses: null,
        nextNonce: null,
        pending: true,
        requestId: String(existing.id),
        approvalExpiresAt: existing.expiresAt.toISOString(),
      }
    }

    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS)
    const row = await this.prisma.guestApprovalRequest.create({
      data: {
        buildingId: guest.buildingId,
        guestId: guest.id,
        accessPointId: apId,
        residentId: guest.residentId,
        status: 'PENDING',
        expiresAt,
        meta: { actorIp: actorIp ?? null },
      },
    })

    this.push
      .sendToResident(
        guest.residentId,
        '🔔 Gość prosi o otwarcie drzwi mieszkania',
        `${guest.name} — ${apLabel}. Zatwierdź w aplikacji (90 s).`,
        { kind: 'GUEST_APPROVAL', requestId: String(row.id), guestId: guest.id },
      )
      .catch((err) =>
        this.logger.warn(`Push (guest approval) failed for guest#${guest.id}: ${err.message}`),
      )

    this.logger.log(
      `Guest approval requested: guest#${guest.id} (${guest.name}) → ap#${apId} ` +
      `req#${row.id} [building ${guest.buildingId}]`,
    )

    return {
      success: true,
      label: apLabel,
      remainingUses: null,
      nextNonce: null,
      pending: true,
      requestId: String(row.id),
      approvalExpiresAt: expiresAt.toISOString(),
    }
  }

  /**
   * Polling gościa: `GET /api/invite/:token/approval/:requestId`.
   * Lazy-expire PENDING po TTL. Po APPROVED zwraca też świeże
   * remainingUses/nextNonce (przycisk może być klikalny ponownie).
   */
  async getApprovalStatus(
    token: string,
    requestId: number,
  ): Promise<{
    status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED'
    gateOpened: boolean
    expiresAt: string
    remainingUses: number | null
    nextNonce: string | null
  }> {
    const guest = await this.findByToken(token)
    const row = await this.prisma.guestApprovalRequest.findFirst({
      where: { id: BigInt(requestId), guestId: guest.id },
    })
    if (!row) throw new NotFoundException('Prośba nie istnieje')

    let status = row.status as 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED'
    if (status === 'PENDING' && row.expiresAt.getTime() <= Date.now()) {
      await this.prisma.$executeRaw`
        UPDATE "guest_approval_requests" SET status = 'EXPIRED'
         WHERE id = ${row.id} AND status = 'PENDING'
      `
      status = 'EXPIRED'
    }

    // remainingUses/nextNonce po APPROVED (przycisk może być klikalny dalej)
    // oraz po EXPIRED (nonce spłonął przy tworzeniu requestu — dajemy świeży,
    // żeby gość mógł poprosić ponownie bez przeładowania strony). Po DENIED
    // celowo NIE wydajemy nonce'a — host odmówił; reload strony i tak
    // wystawi nowy (limit dalej egzekwowany przy open).
    let remainingUses: number | null = null
    let nextNonce: string | null = null
    if ((status === 'APPROVED' && row.gateOpened) || status === 'EXPIRED') {
      const entry = allowedEntryFor(guest.allowedAccessPoints, row.accessPointId)
      if (entry.maxUses !== null) {
        const used = (await this.usesByAccessPoint(guest.id).catch(() => new Map()))
          .get(row.accessPointId) ?? 0
        remainingUses = Math.max(0, entry.maxUses - used)
      }
      if (remainingUses === null || remainingUses > 0) {
        nextNonce = issueGuestOpenNonce(guest.id, row.accessPointId)
      }
    }

    return {
      status,
      gateOpened: row.gateOpened,
      expiresAt: row.expiresAt.toISOString(),
      remainingUses,
      nextNonce,
    }
  }

  /** Lista PENDING requestów hosta (iOS karta zatwierdzania). Lazy-expire. */
  async listPendingApprovals(residentId: number): Promise<{
    id: string
    guestName: string
    accessPointLabel: string
    createdAt: string
    expiresAt: string
    secondsLeft: number
  }[]> {
    await this.prisma.$executeRaw`
      UPDATE "guest_approval_requests" SET status = 'EXPIRED'
       WHERE "residentId" = ${residentId} AND status = 'PENDING'
         AND "expiresAt" <= (NOW() AT TIME ZONE 'UTC')
    `
    const rows = await this.prisma.guestApprovalRequest.findMany({
      where: { residentId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        guest: { select: { name: true } },
        accessPoint: { select: { label: true } },
      },
    })
    const now = Date.now()
    return rows.map((r) => ({
      id: String(r.id),
      guestName: r.guest?.name ?? 'Gość',
      accessPointLabel: r.accessPoint?.label ?? 'Drzwi lokalu',
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      secondsLeft: Math.max(0, Math.round((r.expiresAt.getTime() - now) / 1000)),
    }))
  }

  /**
   * Host zatwierdza: atomowy claim (UPDATE ... WHERE status='PENDING' AND
   * expiresAt > NOW()) → otwarcie przez Edge → gateOpened + zliczenie użycia
   * + audyt (openedByType=RESIDENT — host fizycznie autoryzował).
   */
  async approveRequest(
    residentId: number,
    requestId: number,
  ): Promise<{ approved: true; gateOpened: boolean; label: string }> {
    const row = await this.prisma.guestApprovalRequest.findFirst({
      where: { id: BigInt(requestId), residentId },
      include: {
        guest: true,
        accessPoint: { select: { id: true, label: true, deviceId: true, relayIndex: true, category: true } },
      },
    })
    if (!row || !row.accessPoint) throw new NotFoundException('Prośba nie istnieje')

    const claimed = await this.prisma.$executeRaw`
      UPDATE "guest_approval_requests"
         SET status = 'APPROVED', "respondedAt" = (NOW() AT TIME ZONE 'UTC')
       WHERE id = ${row.id} AND status = 'PENDING'
         AND "expiresAt" > (NOW() AT TIME ZONE 'UTC')
    `
    if (claimed !== 1) {
      throw new HttpException(
        { code: 'ALREADY_HANDLED', message: 'Prośba wygasła lub została już obsłużona.' },
        HttpStatus.CONFLICT,
      )
    }

    let gateOpened = false
    try {
      await this.callEdgeOpen(row.buildingId, row.accessPoint.deviceId, row.accessPoint.relayIndex)
      gateOpened = true
    } catch (err: any) {
      this.logger.warn(`Approved open failed (req#${row.id}): ${err.message}`)
    }
    await this.prisma.$executeRaw`
      UPDATE "guest_approval_requests" SET "gateOpened" = ${gateOpened} WHERE id = ${row.id}
    `

    if (gateOpened && row.guest) {
      const guestRow: GuestPortalRow = {
        id: row.guest.id,
        buildingId: row.guest.buildingId,
        residentId: row.guest.residentId,
        name: row.guest.name,
        pin: row.guest.pin,
        validFrom: row.guest.validFrom,
        validTo: row.guest.validTo,
        status: row.guest.status as GuestPortalRow['status'],
        usedAt: row.guest.usedAt,
        urlToken: row.guest.urlToken,
        email: row.guest.email,
        allowedAccessPoints: (row.guest.allowedAccessPoints as unknown as AllowedAccessPointEntry[] | null) ?? null,
        recurringSchedule: (row.guest.recurringSchedule as unknown as RecurringSchedule | null) ?? null,
      }
      const entry = allowedEntryFor(guestRow.allowedAccessPoints, row.accessPoint.id)
      const used = entry.maxUses !== null
        ? (await this.usesByAccessPoint(guestRow.id).catch(() => new Map())).get(row.accessPoint.id) ?? 0
        : 0
      await this.finalizeGuestOpen(
        guestRow,
        row.accessPoint.id,
        row.accessPoint.label,
        row.accessPoint.category === 'UNIT_DOOR',
        entry.maxUses,
        used,
        undefined,
        'guest-portal-approval',
        residentId,
      )
    }

    return { approved: true, gateOpened, label: row.accessPoint.label }
  }

  /** Host odrzuca prośbę. Atomowo — tylko PENDING. */
  async denyRequest(
    residentId: number,
    requestId: number,
  ): Promise<{ denied: true }> {
    const updated = await this.prisma.$executeRaw`
      UPDATE "guest_approval_requests"
         SET status = 'DENIED', "respondedAt" = (NOW() AT TIME ZONE 'UTC')
       WHERE id = ${BigInt(requestId)} AND "residentId" = ${residentId} AND status = 'PENDING'
    `
    if (updated !== 1) {
      throw new HttpException(
        { code: 'ALREADY_HANDLED', message: 'Prośba wygasła lub została już obsłużona.' },
        HttpStatus.CONFLICT,
      )
    }
    return { denied: true }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * AP widoczne dla gościa w portalu (2026-07-07, guest-pass redesign):
   *   • `isActive` + `scope != ADMIN_ONLY` — brama pożarowa itd. jeśli
   *     integrator ustawił ADMIN_ONLY, gość jej nie widzi (i nie otworzy).
   *   • Permissions Matrix per rola RESIDENT (`ap_<id>`) — gość dziedziczy
   *     widoczność mieszkańca, nigdy więcej. Kategoria (FIRE_ESCAPE) jedzie
   *     do frontendu, który wymaga potwierdzenia w bottom sheet.
   *
   * 2026-07-08 (ograniczenia gościa): gdy `guest.allowedAccessPoints` != null,
   * lista jest dodatkowo zawężana do dozwolonych AP, a każdy wpis dostaje
   * `maxUses`/`remainingUses` („zostały 2 otwarcia") liczone z
   * guest_access_uses (wszystkie source'y: PORTAL + PIN + LPR z Edge).
   */
  private async listGuestAccessPoints(
    buildingId: number,
    guest?: Pick<GuestPortalRow, 'id' | 'allowedAccessPoints'>,
  ): Promise<AccessPointPublic[]> {
    const [aps, perms] = await Promise.all([
      this.prisma.accessPoint.findMany({
        where: { buildingId, isActive: true, scope: { not: 'ADMIN_ONLY' } },
        select: { id: true, label: true, icon: true, sortOrder: true, category: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
      this.loadPermissions(buildingId),
    ])
    const visible = aps.filter((ap) => hasPermission(perms, 'resident', apKey(ap.id)))

    const allowed = guest?.allowedAccessPoints ?? null
    // 2026-07-08 (Nuki): UNIT_DOOR (drzwi lokalu) NIGDY nie wchodzi w tryb
    // „bez ograniczeń" — na listę gościa trafia WYŁĄCZNIE gdy host jawnie
    // dodał je w zaproszeniu (wpis w allowedAccessPoints). Egzekwowane
    // symetrycznie w openAccessPoint (defense-in-depth).
    const restricted = visible.filter((ap) => {
      const entry = allowedEntryFor(allowed, ap.id)
      if (ap.category === 'UNIT_DOOR') return entry.allowed && entry.explicit
      return entry.allowed
    })

    // Zużycie per AP — tylko gdy jakiś AP ma limit (oszczędzamy query).
    const hasLimits = !!allowed?.some((a) => a.maxUses != null)
    let usedByAp = new Map<number, number>()
    if (guest && hasLimits) {
      usedByAp = await this.usesByAccessPoint(guest.id).catch(() => new Map())
    }

    return restricted.map((ap) => {
      const entry = allowedEntryFor(allowed, ap.id)
      const maxUses = entry.maxUses ?? null
      const remainingUses = maxUses !== null
        ? Math.max(0, maxUses - (usedByAp.get(ap.id) ?? 0))
        : null
      const unitDoor = ap.category === 'UNIT_DOOR'
      // Nonce tylko dla UNIT_DOOR z niewyczerpanym limitem — remainingUses=0
      // ⇒ nonce=null ⇒ frontend renderuje trwałe „Wykorzystane ✓".
      const nonce =
        unitDoor && guest && (remainingUses === null || remainingUses > 0)
          ? issueGuestOpenNonce(guest.id, ap.id)
          : null
      return {
        ...ap,
        maxUses,
        remainingUses,
        unitDoor,
        approvalRequired: unitDoor && entry.approvalRequired,
        nonce,
      }
    })
  }

  /** Zużyte otwarcia gościa per AP (wszystkie source'y) — Map apId → count. */
  private async usesByAccessPoint(guestId: number): Promise<Map<number, number>> {
    const rows = await this.prisma.$queryRaw<{ accessPointId: number | null; count: bigint }[]>`
      SELECT "accessPointId", COUNT(*)::bigint AS count
        FROM "guest_access_uses"
       WHERE "guestId" = ${guestId}
       GROUP BY "accessPointId"
    `
    const map = new Map<number, number>()
    for (const r of rows) {
      if (r.accessPointId !== null) map.set(r.accessPointId, Number(r.count))
    }
    return map
  }

  /**
   * Audyt odmowy otwarcia przez portal (ograniczenia gościa, 2026-07-08).
   * Fire-and-forget — REMOTE_OPEN z gateOpened=false + reason, spójnie
   * z odmowami PIN (EXPIRED/INACTIVE) po stronie Edge.
   */
  private recordDeniedOpen(
    guest: GuestPortalRow,
    accessPointId: number,
    reason: 'AP_NOT_ALLOWED' | 'OUT_OF_SCHEDULE' | 'USES_EXHAUSTED' | 'NONCE_INVALID' | 'NONCE_USED',
    actorIp: string | undefined,
  ): void {
    this.accessEvents.record({
      buildingId: guest.buildingId,
      type: 'REMOTE_OPEN',
      accessPointId,
      gateOpened: false,
      reason,
      guestId: guest.id,
      residentId: guest.residentId,
      openedByType: 'SYSTEM',
      meta: { source: 'guest-portal', actorIp: actorIp ?? null },
    }).catch(() => { /* logged inside */ })
    this.logger.log(
      `Guest portal open DENIED (${reason}): guest#${guest.id} ap=${accessPointId} ip=${actorIp ?? '?'}`,
    )
  }

  /**
   * Po otwarciu portalowym dosyłamy Edge pełen stan ograniczeń gościa
   * (PIN_UPSERT z portalUses) — Edge egzekwuje limit offline jako
   * COUNT(lokalne PIN/LPR) + snapshot portalowy. Stary Edge ignoruje pola.
   * Gdy Edge offline, PIN_UPSERT idzie przez outbox (dostarczony po
   * reconnect) — okno niedokładności = otwarcia portalowe do tego czasu.
   */
  private async resyncGuestRestrictionsToEdge(guest: GuestPortalRow): Promise<void> {
    // Bez limitów nie ma czego dosyłać — harmonogram/allowlista są statyczne
    // i pojechały przy create/update.
    const hasLimits = !!guest.allowedAccessPoints?.some((a) => a.maxUses != null)
    if (!hasLimits) return
    const rows = await this.prisma.$queryRaw<{ accessPointId: number | null; count: bigint }[]>`
      SELECT "accessPointId", COUNT(*)::bigint AS count
        FROM "guest_access_uses"
       WHERE "guestId" = ${guest.id} AND source = 'PORTAL'
       GROUP BY "accessPointId"
    `
    const portalUses: Record<string, number> = {}
    for (const r of rows) {
      if (r.accessPointId !== null) portalUses[String(r.accessPointId)] = Number(r.count)
    }
    this.edgeGateway.sendToBuilding(guest.buildingId, 'PIN_UPSERT', {
      pin: guest.pin,
      guestId: guest.id,
      guestName: guest.name,
      validFrom: new Date(guest.validFrom).toISOString(),
      validUntil: new Date(guest.validTo).toISOString(),
      allowedAccessPoints: guest.allowedAccessPoints ?? null,
      recurringSchedule: guest.recurringSchedule ?? null,
      portalUses,
    })
  }

  /** featurePermissions budynku — znormalizowane do typed shape. */
  private async loadPermissions(buildingId: number): Promise<BuildingFeaturePermissions> {
    const building = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { featurePermissions: true },
    })
    return normalizePermissions(building?.featurePermissions)
  }

  /** Lookup gościa po tokenie. 64-hex normalizujemy lowercase żeby
   *  copy-paste z różnych klientów nie psuł matchu. */
  private async findByToken(rawToken: string): Promise<GuestPortalRow> {
    const token = (rawToken ?? '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(token)) {
      // Format-błąd traktujemy jak 404 — nie ujawniamy że format ma znaczenie
      // (mniej info dla atakującego skanującego URL-e).
      throw new NotFoundException('Zaproszenie nie istnieje')
    }
    const rows = await this.prisma.$queryRaw<GuestPortalRow[]>`
      SELECT id, "buildingId", "residentId", name, pin,
             "validFrom", "validTo", status::text AS status,
             "usedAt", "urlToken", email,
             "allowedAccessPoints", "recurringSchedule"
        FROM "guests"
       WHERE "urlToken" = ${token}
       LIMIT 1
    `
    const g = rows[0]
    if (!g) throw new NotFoundException('Zaproszenie nie istnieje')
    return g
  }

  /** In-memory token bucket — sliding window 60s × max 10. */
  private allowOpen(token: string): boolean {
    const now = Date.now()
    const cutoff = now - GuestPortalService.RATE_LIMIT_WINDOW_MS
    const arr = (this.opensByToken.get(token) ?? []).filter((t) => t > cutoff)
    if (arr.length >= GuestPortalService.RATE_LIMIT_MAX) {
      this.opensByToken.set(token, arr) // zachowaj sliding window
      return false
    }
    arr.push(now)
    this.opensByToken.set(token, arr)
    return true
  }

  /** Każde otwarcie przez portal (2026-07-15 — wcześniej push szedł tylko
   *  przy pierwszym użyciu): ustawia `usedAt` przy pierwszym razie
   *  (race-safe `WHERE usedAt IS NULL`) i wysyła push do hosta z throttle
   *  5 min per gość. Klucz `guest-use-<id>` jest WSPÓLNY z PIN/LPR flow
   *  (`GuestsValidationService.notifyGuestUse`) — gość używający kilku
   *  kanałów w krótkim czasie generuje dokładnie jedno powiadomienie.
   *  Push fire-and-forget — błąd nie blokuje otwarcia bramy (gość już
   *  wszedł). `silent=true` (UNIT_DOOR / approved open) — dedykowany push
   *  o drzwiach lokalu już poszedł, nie dublujemy „otworzył wjazd".
   */
  private async markGuestUse(
    guestId: number,
    residentId: number,
    guestName: string,
    apLabel: string,
    actorIp: string | undefined,
    silent = false,
  ): Promise<void> {
    try {
      const result = await this.prisma.$executeRaw`
        UPDATE "guests"
           SET "usedAt" = NOW()
         WHERE id = ${guestId}
           AND "usedAt" IS NULL
      `
      const firstUse = result > 0
      if (firstUse) {
        this.logger.log(`First-use marked for guest#${guestId} (${apLabel}) from ip=${actorIp ?? '?'}`)
      }

      if (silent) return

      // Toggle per zaproszenie (2026-08-14) — jak w GuestsValidationService:
      // usedAt wyżej zapisany, push o aktywności pomijamy gdy wyłączony.
      const [row] = await this.prisma.$queryRaw<{ notifyOnUse: boolean }[]>`
        SELECT "notifyOnUse" FROM "guests" WHERE id = ${guestId}
      `
      if (row && row.notifyOnUse === false) return

      // Push fire-and-forget — błąd nie blokuje otwarcia.
      this.push
        .sendToResidentThrottled(
          `guest-use-${guestId}`,
          GUEST_USE_PUSH_THROTTLE_MS,
          residentId,
          '🚪 Gość otworzył wjazd',
          `${guestName} — ${apLabel}`,
          { kind: firstUse ? 'GUEST_PORTAL_OPEN' : 'GUEST_USE', guestId },
        )
        .catch((err) =>
          this.logger.warn(`Push (portal open) failed for guest#${guestId}: ${err.message}`),
        )
    } catch (err: any) {
      this.logger.warn(`markGuestUse failed for guest#${guestId}: ${err.message}`)
    }
  }

  /** INSERT do `guest_events` przy każdym kliknięciu w portalu. Wpis idzie
   *  niezależnie od first-use flag-i (żeby panel widział kolejne otwarcia
   *  tej samej sesji gościa). Raw SQL bo Prisma Client w monorepo flaky
   *  (patrz CLAUDE.md). */
  private async recordPortalOpenEvent(
    buildingId: number,
    guestId: number,
    residentId: number,
    accessPointId: number,
    actorIp: string | undefined,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "guest_events"
        ("buildingId", "guestId", "residentId", "via", "accessPointId", "actorIp")
      VALUES
        (${buildingId}, ${guestId}, ${residentId}, 'PORTAL_OPEN', ${accessPointId}, ${actorIp ?? null})
    `
  }

  /** Maskowanie tokenu w logach — pierwsze 8 + ostatnie 4. */
  private maskToken(t: string): string {
    if (t.length < 16) return '***'
    return `${t.slice(0, 8)}...${t.slice(-4)}`
  }
}
