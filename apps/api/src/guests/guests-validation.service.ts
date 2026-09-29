import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { PushService, GUEST_USE_PUSH_THROTTLE_MS } from '../push/push.service'
import { AccessEventsService } from '../access-events/access-events.service'
import { isWithinSchedule, type RecurringSchedule } from './guest-restrictions.util'
import { signPushMediaToken } from '../lpr-reads/push-media-token'
import { isRegisteredVehiclePlate } from './guest-plate-guard'
import { warsawTime } from '../push/push-text'

/**
 * GuestValidationService — Faza 2B/3 Villa Natura.
 *
 * Wspólna logika dla dwóch ścieżek użycia gościa:
 *   • Domofon Akuvox → Edge → POST /api/edge/validate-pin (PIN flow)
 *   • LPR kamera → Edge → LPR_READ event → matchPlate (plate flow)
 *
 * Obie ścieżki:
 *   - sprawdzają, że gość jest ACTIVE w oknie czasowym,
 *   - przy pierwszym użyciu ustawiają `usedAt = NOW()`,
 *   - i tylko PRZY PIERWSZYM użyciu wysyłają push do mieszkańca-zapraszającego.
 *
 * Notyfikacja na pierwsze użycie (a nie na każde) — żeby nie spamować
 * mieszkańcem powiadomieniem przy każdym wjeździe/wyjściu pojazdu kuriera
 * w trakcie pobytu (np. gość-glovo robi 5 podjazdów dziennie).
 */
@Injectable()
export class GuestsValidationService {
  private readonly logger = new Logger(GuestsValidationService.name)

  constructor(
    private prisma: PrismaService,
    private push: PushService,
    private accessEvents: AccessEventsService,
  ) {}

  /** Normalizujemy tablicę identycznie jak Edge (uppercase, A-Z0-9). */
  private normalizePlate(p: string): string {
    return (p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  }

  /**
   * PIN flow — wywoływany z controllera `/api/edge/validate-pin`.
   *
   * Zwraca:
   *   - `allowed: true` + dane gościa, jeśli PIN pasuje, status ACTIVE
   *     i NOW() w oknie [validFrom, validTo].
   *   - `allowed: false` z `reason` jeśli PIN nie istnieje, gość nieaktywny
   *     albo poza oknem.
   *
   * Edge wykorzystuje to do podjęcia decyzji „otworzyć domofon czy nie".
   * `reason` lecąco do logu Edge (debug) — końcowemu userowi pokazujemy
   * tylko „PIN niepoprawny" / „Pin wygasł" w UI Akuvox.
   */
  async validatePin(buildingId: number, pin: string): Promise<{
    allowed: boolean
    reason?: string
    guestId?: number
    guestName?: string
  }> {
    if (!/^\d{6}$/.test(pin)) {
      // Zły format → audit z reason. Brak guestId, ale wciąż wartościowe
      // dla wykrywania prób bruteforce'u na klawiaturze Akuvox.
      this.recordPinAccessEvent(buildingId, null, null, false, 'BAD_FORMAT').catch(() => {})
      return { allowed: false, reason: 'BAD_FORMAT' }
    }

    const rows = await this.prisma.$queryRaw<{
      id: number
      residentId: number
      buildingId: number
      name: string
      vehiclePlate: string | null
      validFrom: Date
      validTo: Date
      status: string
      usedAt: Date | null
      notifyOnUse: boolean
      recurringSchedule: RecurringSchedule | null
    }[]>`
      SELECT id, "residentId", "buildingId", name, "vehiclePlate",
             "validFrom", "validTo", status::text AS status, "usedAt",
             "notifyOnUse", "recurringSchedule"
        FROM "guests"
       WHERE "buildingId" = ${buildingId} AND pin = ${pin}
       LIMIT 1
    `
    const g = rows[0]
    if (!g) {
      this.recordPinAccessEvent(buildingId, null, null, false, 'PIN_NOT_FOUND').catch(() => {})
      return { allowed: false, reason: 'PIN_NOT_FOUND' }
    }
    if (g.status === 'CANCELLED') {
      this.recordPinAccessEvent(buildingId, g.id, g.residentId, false, 'CANCELLED').catch(() => {})
      return { allowed: false, reason: 'CANCELLED' }
    }
    if (g.status === 'EXPIRED') {
      this.recordPinAccessEvent(buildingId, g.id, g.residentId, false, 'EXPIRED').catch(() => {})
      return { allowed: false, reason: 'EXPIRED' }
    }
    const now = new Date()
    if (now < g.validFrom) {
      this.recordPinAccessEvent(buildingId, g.id, g.residentId, false, 'NOT_YET_VALID').catch(() => {})
      return { allowed: false, reason: 'NOT_YET_VALID' }
    }
    if (now >= g.validTo) {
      this.recordPinAccessEvent(buildingId, g.id, g.residentId, false, 'EXPIRED').catch(() => {})
      return { allowed: false, reason: 'EXPIRED' }
    }
    if (g.status !== 'ACTIVE') {
      this.recordPinAccessEvent(buildingId, g.id, g.residentId, false, 'INACTIVE').catch(() => {})
      return { allowed: false, reason: 'INACTIVE' }
    }

    // Harmonogram cykliczny (2026-07-08) — defense-in-depth: normalnie Edge
    // odmawia lokalnie (offline-first), ale gdyby Edge miał stale guest_pins,
    // Cloud-side walidacja też zatrzymuje. Allowlista AP tu NIE jest
    // sprawdzana — Cloud w tym flow nie wie który AP odpala (Edge wie i
    // egzekwuje przez checkGuestRestrictions).
    if (!isWithinSchedule(g.recurringSchedule, now.getTime())) {
      this.recordPinAccessEvent(buildingId, g.id, g.residentId, false, 'OUT_OF_SCHEDULE').catch(() => {})
      return { allowed: false, reason: 'OUT_OF_SCHEDULE' }
    }

    // KAŻDE użycie → push do zapraszającego (throttle 5 min per gość);
    // usedAt ustawiane przy pierwszym razie. (2026-07-15 — wcześniej push
    // szedł tylko przy pierwszym użyciu.)
    await this.notifyGuestUse(g.id, g.residentId, g.name, 'PIN', undefined, g.notifyOnUse)

    // PIN poprawny — audit ALLOW (każdy raz, bez TTL — analitykę zostawiamy
    // konsumentom feed-a).
    this.recordPinAccessEvent(buildingId, g.id, g.residentId, true, null).catch(() => {})

    return { allowed: true, guestId: g.id, guestName: g.name }
  }

  /**
   * Faza 3 audit hook — wstawia PIN_USED do `access_events`.
   * `gateOpened=true` tylko jeśli walidacja zwraca allowed; przy odrzuceniu
   * Edge nie otwiera bramy ale i tak chcemy wpis (potencjalny bruteforce).
   */
  private async recordPinAccessEvent(
    buildingId: number,
    guestId: number | null,
    residentId: number | null,
    allowed: boolean,
    reason: string | null,
  ): Promise<void> {
    await this.accessEvents.record({
      buildingId,
      type: 'PIN_USED',
      gateOpened: allowed,
      reason,
      guestId,
      residentId,
      openedById: null,
      openedByType: 'EDGE',
    })
  }

  /**
   * LPR flow — wywoływany z LprReadsService.recordRead po zapisie eventu.
   *
   * Nie kontroluje czy gate się otworzył (to robi Edge lokalnie po `matched`),
   * tylko aktualizuje stan po stronie Cloud. 2026-07-15: powiadamiamy przy
   * KAŻDYM wjeździe gościa (throttle 5 min w PushService — LPR na 2 kamerach
   * / cofanie przez bramę nie duplikuje pushy), nie tylko przy pierwszym.
   *
   * Świadomie NIE odrzucamy reads przy CANCELLED/EXPIRED — same w sobie
   * stanowią ślad „auto X przyjechało po wygaśnięciu", co warto trzymać
   * w lpr_reads. Tu tylko gating notyfikacji.
   */
  async matchPlate(
    buildingId: number,
    plateRaw: string,
    ctx?: { direction?: string | null; edgeReadId?: number | null; hasImage?: boolean },
  ): Promise<void> {
    const plate = this.normalizePlate(plateRaw)
    if (!plate) return

    try {
      const rows = await this.prisma.$queryRaw<{
        id: number
        residentId: number
        name: string
        usedAt: Date | null
        notifyOnUse: boolean
      }[]>`
        SELECT id, "residentId", name, "usedAt", "notifyOnUse"
          FROM "guests"
         WHERE "buildingId" = ${buildingId}
           AND status = 'ACTIVE'
           AND "vehiclePlate" = ${plate}
           AND NOW() BETWEEN "validFrom" AND "validTo"
         LIMIT 1
      `
      const g = rows[0]
      if (!g) return

      // Anty-stalking, druga warstwa (2026-08-12): wpis gościa z tablicą
      // ZAREJESTROWANEGO pojazdu (sprzed blokady w create/update albo dodany
      // inną drogą) nie generuje powiadomień — ruch zarejestrowanych aut to
      // prywatność ich właścicieli, nie „użycie zaproszenia".
      if (await isRegisteredVehiclePlate(this.prisma, buildingId, plate)) {
        this.logger.warn(
          `matchPlate: guest#${g.id} ma tablicę zarejestrowanego pojazdu (${plate}) — pomijam powiadomienia`,
        )
        return
      }

      // Zdjęcie w pushu (2026-08-12): APNs nie przenosi obrazów — payload
      // dostaje publiczny, podpisany URL do kadru z odczytu, a Notification
      // Service Extension w iOS pobiera go przed pokazaniem powiadomienia.
      // Bez rozszerzenia (starsza apka) push po prostu przychodzi bez zdjęcia.
      let imageUrl: string | undefined
      if (ctx?.hasImage && ctx.edgeReadId != null) {
        const base = (process.env.PUBLIC_BASE_URL ?? 'https://api.gatelynk.com').replace(/\/+$/, '')
        imageUrl = `${base}/api/push-media/lpr/${signPushMediaToken(buildingId, ctx.edgeReadId)}`
      }

      // Kierunek semantyczny liczy Edge (linki kamera→AP / forward-reverse /
      // nazwa kamery). OUT = wyjazd gościa; wszystko inne traktujemy jak
      // dotąd, czyli jako wjazd — lepiej nadmiarowo powiadomić o wjeździe
      // niż zgubić powiadomienie przez niepewny kierunek.
      const dir = String(ctx?.direction ?? '').toUpperCase()
      if (dir === 'OUT') {
        await this.notifyGuestExit(g.id, g.residentId, g.name, imageUrl, g.notifyOnUse)
        return
      }
      await this.notifyGuestUse(g.id, g.residentId, g.name, 'PLATE', imageUrl, g.notifyOnUse)
    } catch (err: any) {
      this.logger.warn(`matchPlate failed for ${plate}: ${err.message}`)
    }
  }

  /**
   * Wyjazd gościa (2026-08-12) — osobny throttle-key niż wjazd, żeby
   * sekwencja „wjazd → 3 min → wyjazd" dała OBA powiadomienia (wspólny klucz
   * z 5-minutowym oknem zjadłby wyjazd). NIE dotykamy `usedAt` — to znacznik
   * pierwszego UŻYCIA zaproszenia, a wyjazd nim nie jest.
   */
  private async notifyGuestExit(
    guestId: number,
    residentId: number,
    guestName: string,
    imageUrl?: string,
    notifyOnUse = true,
  ): Promise<void> {
    if (!notifyOnUse) return
    this.push.sendToResidentThrottled(
      `guest-exit-${guestId}`,
      GUEST_USE_PUSH_THROTTLE_MS,
      residentId,
      'Wyjazd gościa',
      `${guestName} opuścił(a) teren osiedla o ${warsawTime()}.`,
      {
        kind: 'GUEST_EXIT',
        guestId,
        via: 'PLATE',
        ts: Date.now(),
        ...(imageUrl ? { imageUrl } : {}),
      },
    ).catch((err) =>
      this.logger.warn(`Push (exit) to resident ${residentId} failed: ${err.message}`),
    )
  }

  /**
   * Każde udane użycie zaproszenia: ustawia `usedAt` przy pierwszym razie
   * (race-safe `usedAt IS NULL`) i wysyła push do zapraszającego.
   * Throttle 5 min per gość w PushService — wspólny klucz `guest-use-<id>`
   * z guest-portal, więc PIN + tablica + link milisekundy po sobie dają
   * dokładnie JEDNO powiadomienie.
   */
  private async notifyGuestUse(
    guestId: number,
    residentId: number,
    guestName: string,
    via: 'PIN' | 'PLATE',
    imageUrl?: string,
    notifyOnUse = true,
  ): Promise<void> {
    try {
      const updated = await this.prisma.$executeRaw`
        UPDATE "guests"
           SET "usedAt" = NOW()
         WHERE id = ${guestId} AND "usedAt" IS NULL
      `
      // $executeRaw zwraca liczbę zaktualizowanych wierszy; >0 = to było
      // pierwsze użycie (informacja tylko do payloadu `kind`).
      const firstUse = updated > 0

      // Toggle per zaproszenie (2026-08-14): mieszkaniec wyłączył pushe
      // o aktywności tego gościa — usedAt wyżej ZOSTAJE (to dane), sam push
      // pomijamy. Prośby o otwarcie (GUEST_APPROVAL) mają własną ścieżkę
      // i zawsze dochodzą.
      if (!notifyOnUse) return

      const title = via === 'PIN' ? 'Gość przy domofonie' : 'Wjazd gościa'
      const body  = via === 'PIN'
        ? `${guestName} użył(a) kodu PIN przy domofonie o ${warsawTime()}.`
        : `${guestName} wjechał(a) na teren osiedla o ${warsawTime()}.`

      // Fire-and-forget — push errors są logowane wewnątrz PushService.
      this.push.sendToResidentThrottled(
        `guest-use-${guestId}`,
        GUEST_USE_PUSH_THROTTLE_MS,
        residentId,
        title,
        body,
        {
          kind: firstUse ? 'GUEST_FIRST_USE' : 'GUEST_USE',
          guestId,
          via,
          // Czas zdarzenia (epoch ms) — ekran szczegółów gościa pokazuje
          // „wjazd o HH:MM" niezależnie od tego, kiedy user tapnął push.
          ts: Date.now(),
          // Kadr z pojazdem — pobierany przez Notification Service Extension.
          ...(imageUrl ? { imageUrl } : {}),
        },
      ).catch((err) =>
        this.logger.warn(`Push to resident ${residentId} failed: ${err.message}`),
      )
    } catch (err: any) {
      this.logger.warn(`notifyGuestUse(${guestId}) failed: ${err.message}`)
    }
  }
}
