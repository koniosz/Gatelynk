import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'crypto'
import { StoreService } from '../../store/store.service'
import { IntercomService } from './intercom.service'
// Lazy reference — IntercomPinService > AccessPointsModule > DevicesModule
// (poprzez OutputDriverRegistry) > IntercomService > IntercomPinService.
import type { AccessPointExecutorService } from '../../access-points/access-point-executor.service'
import {
  isWithinSchedule,
  allowedEntryFor,
  parseAllowedAccessPoints,
  parseRecurringSchedule,
  type AllowedAccessPointEntry,
  type RecurringSchedule,
} from './guest-restrictions.util'

/**
 * IntercomPinService — Faza 2D Villa Natura.
 *
 * Lokalna walidacja kodu domofonu na Edge:
 *   1. Cloud syncuje aktywne PIN-y gości tutaj przez tunel
 *      (`PIN_UPSERT` / `PIN_DELETE` / `PIN_SYNC_ALL`).
 *   2. Akuvox jest skonfigurowany z Action URL → `http://<edge>:4000/akuvox/event`
 *      — wystrzeliwuje request gdy ktoś wpisze kod na klawiaturze.
 *   3. Edge sprawdza kod w lokalnym `guest_pins`. Jeśli ważny i w oknie
 *      czasowym — woła `OpenDoor` na tym samym Akuvox + emituje
 *      `GUEST_PIN_USED` (Cloud po stronie WS robi `markFirstUse` + push).
 *
 * Dlaczego lokalnie a nie zawsze przez Cloud:
 *   • Edge musi działać też gdy WS jest offline („zatrzymanie internetu na
 *     5 minut nie powinno blokować dostępu zaproszonego gościa”).
 *   • Latencja klawiatury — naciskasz kod, a brama się NIE otwiera od razu
 *     przez round-trip do AWS, tylko lokalnie w <100ms.
 *
 * Audyt usedAt + push do mieszkańca dzieje się i tak po stronie Cloud, ale
 * jako asynchroniczny event („eventually consistent”) — gość już wszedł.
 */
@Injectable()
export class IntercomPinService {
  private readonly logger = new Logger(IntercomPinService.name)

  /** Wstrzykiwane lazy przez TunnelService po tym jak ten się zainicjalizuje
   *  — żeby uniknąć cyklicznej zależności DevicesModule ↔ TunnelModule. */
  private tunnelSend: ((event: string, data: Record<string, any>, deviceId?: string) => boolean) | null = null

  constructor(
    private store: StoreService,
    private intercom: IntercomService,
  ) {}

  setTunnelSend(fn: (event: string, data: Record<string, any>, deviceId?: string) => boolean) {
    this.tunnelSend = fn
  }

  /**
   * AccessPointExecutorService wstrzykiwane lazy (setter-based). Patrz
   * TunnelService.onModuleInit. Refactor 2026-06-01.
   */
  private accessPointExecutor: AccessPointExecutorService | null = null
  setAccessPointExecutor(executor: AccessPointExecutorService) {
    this.accessPointExecutor = executor
  }

  // ── Sync z Cloud (PIN_UPSERT / PIN_DELETE / PIN_SYNC_ALL) ───────────────────
  /**
   * Format payloadu z Cloud (mirroruje konwencję PLATE_UPSERT):
   *   { pin: '123456', guestId: 42, guestName: 'Jan', validFrom?, validUntil?,
   *     allowedAccessPoints?, recurringSchedule?, portalUses? }
   * Daty są ISO string-ami (lub Date) — parsujemy do epoch ms.
   *
   * 2026-07-08 — ograniczenia dostępu gościa (pola opcjonalne, stary Cloud
   * ich nie śle → NULL = bez ograniczeń, backward-compat):
   *   • allowedAccessPoints — [{apId, maxUses?}]
   *   • recurringSchedule   — {days, startTime, endTime, tz}
   *   • portalUses          — {"<apId>": n} snapshot użyć PORTALOWYCH z Cloud
   *     (użycia PIN/LPR liczymy lokalnie w guest_uses — suma obu = zużycie).
   */
  upsertPin(payload: {
    pin?: unknown
    guestId?: unknown
    guestName?: unknown
    validFrom?: unknown
    validUntil?: unknown
    allowedAccessPoints?: unknown
    recurringSchedule?: unknown
    portalUses?: unknown
  }): { upserted: boolean } {
    const pin = String(payload.pin ?? '').trim()
    const guestId = Number(payload.guestId ?? 0)
    if (!/^\d{4,12}$/.test(pin) || !Number.isFinite(guestId) || guestId <= 0) {
      throw new Error('PIN_UPSERT: invalid pin or guestId')
    }
    const guestName = typeof payload.guestName === 'string' ? payload.guestName : null
    const validFrom = this.toMillis(payload.validFrom)
    const validUntil = this.toMillis(payload.validUntil)
    const restrictions = this.serializeRestrictions(
      payload.allowedAccessPoints, payload.recurringSchedule, payload.portalUses,
    )

    // Per-pole „preserve gdy klucz nieobecny": nowy Cloud (resident flow +
    // portal resync) ZAWSZE śle te klucze (null = jawny brak ograniczeń).
    // Stary Cloud oraz ścieżki BA/concierge (re-sync okna czasowego) nie
    // znają pól — INSERT OR REPLACE nie może wtedy skasować ograniczeń.
    const existing = this.store.guestRestrictionsByGuestId(guestId)
    if (existing) {
      if (!('allowedAccessPoints' in payload)) restrictions.allowedAps = existing.allowedAps
      if (!('recurringSchedule' in payload)) restrictions.schedule = existing.schedule
      if (!('portalUses' in payload)) restrictions.cloudUses = existing.cloudUses
    }

    this.store.guestPinUpsert(pin, guestId, guestName, validFrom, validUntil, restrictions)
    this.logger.log(
      `PIN upsert: ${this.maskPin(pin)} guest#${guestId} ` +
      `${validFrom ? new Date(validFrom).toISOString() : 'now'} → ` +
      `${validUntil ? new Date(validUntil).toISOString() : '∞'}` +
      `${restrictions.allowedAps ? ' +apList' : ''}${restrictions.schedule ? ' +schedule' : ''}`,
    )
    return { upserted: true }
  }

  /**
   * Waliduje/serializuje pola ograniczeń z payloadu Cloud do JSON stringów
   * pod kolumny sqlite. Nieparsowalne dane → NULL (fail-open do zachowania
   * legacy: okno validFrom..validUntil nadal pilnowane) + warn w logu.
   */
  private serializeRestrictions(
    rawAllowed: unknown,
    rawSchedule: unknown,
    rawPortalUses: unknown,
  ): { allowedAps: string | null; schedule: string | null; cloudUses: string | null } {
    let allowedAps: string | null = null
    let schedule: string | null = null
    let cloudUses: string | null = null
    try {
      const parsed = parseAllowedAccessPoints(rawAllowed)
      allowedAps = parsed ? JSON.stringify(parsed) : null
    } catch (err: any) {
      this.logger.warn(`PIN sync: invalid allowedAccessPoints ignored (${err.message})`)
    }
    try {
      const parsed = parseRecurringSchedule(rawSchedule)
      schedule = parsed ? JSON.stringify(parsed) : null
    } catch (err: any) {
      this.logger.warn(`PIN sync: invalid recurringSchedule ignored (${err.message})`)
    }
    if (rawPortalUses && typeof rawPortalUses === 'object' && !Array.isArray(rawPortalUses)) {
      const clean: Record<string, number> = {}
      for (const [k, v] of Object.entries(rawPortalUses as Record<string, unknown>)) {
        const n = Number(v)
        if (Number.isFinite(n) && n > 0) clean[k] = Math.floor(n)
      }
      cloudUses = Object.keys(clean).length > 0 ? JSON.stringify(clean) : null
    }
    return { allowedAps, schedule, cloudUses }
  }

  deletePin(payload: { pin?: unknown; guestId?: unknown }): { deleted: number } {
    const pin = typeof payload.pin === 'string' ? payload.pin.trim() : ''
    const guestId = Number(payload.guestId ?? 0)
    if (pin) {
      const ok = this.store.guestPinDelete(pin)
      if (ok) this.logger.log(`PIN delete: ${this.maskPin(pin)}`)
      return { deleted: ok ? 1 : 0 }
    }
    if (guestId > 0) {
      const n = this.store.guestPinDeleteByGuest(guestId)
      if (n > 0) this.logger.log(`PIN delete by guest#${guestId}: ${n} row(s)`)
      return { deleted: n }
    }
    throw new Error('PIN_DELETE: missing pin or guestId')
  }

  syncAllPins(payload: { pins?: unknown; items?: unknown }): { count: number } {
    const items = Array.isArray(payload.pins) ? payload.pins
      : Array.isArray((payload as any).items) ? (payload as any).items
      : []
    const rows = items
      .map((it: any) => {
        const restrictions = this.serializeRestrictions(
          it?.allowedAccessPoints, it?.recurringSchedule, it?.portalUses,
        )
        return {
          pin: String(it?.pin ?? '').trim(),
          guestId: Number(it?.guestId ?? 0),
          guestName: typeof it?.guestName === 'string' ? it.guestName : null,
          validFrom: this.toMillis(it?.validFrom),
          validUntil: this.toMillis(it?.validUntil),
          allowedAps: restrictions.allowedAps,
          schedule: restrictions.schedule,
          cloudUses: restrictions.cloudUses,
        }
      })
      .filter((r) => /^\d{4,12}$/.test(r.pin) && r.guestId > 0)

    this.store.guestPinReplaceAll(rows)
    this.logger.log(`PIN sync-all: replaced with ${rows.length} pin(s)`)
    return { count: rows.length }
  }

  // ── Akuvox Action URL → walidacja PIN-u + open relay ────────────────────────
  /**
   * Wywołane z `AkuvoxEventController` gdy domofon zgłasza zdarzenie
   * z klawiatury. Akuvox firmware 18.30.x ma Action URL z placeholderami
   * `$code_value` (wpisany kod) i `$mac` (MAC urządzenia).
   *
   * Edge:
   *   1. Sprawdza PIN w lokalnym storze (offline-friendly).
   *   2. Jeśli ważny — woła `OpenDoor` na intercomie wskazanym przez `mac`
   *      (lub na default-owym, jak nie znamy MAC).
   *   3. Emituje `GUEST_PIN_USED` event do Cloud (audyt usedAt + push).
   */
  async handleKeypadEvent(input: {
    pin: string
    intercomDeviceId?: string
    mac?: string
    rawEvent?: string
  }): Promise<{
    matched: boolean
    opened: boolean
    guestId?: number
    guestName?: string | null
    reason?: string
  }> {
    // Akuvox firmware potrafi doklejać znaki sterujące (`#` jako confirm,
    // `\r\n` na końcu, czasem prefix typu `*123456#`). Stripujemy wszystko
    // poza cyframi przed walidacją — działa też dla typowych
    // niespodzianek typu spacja w środku.
    const raw = (input.pin ?? '').trim()
    const pin = raw.replace(/\D/g, '')
    if (!/^\d{4,12}$/.test(pin)) {
      // Sygnatura zamiast wartości — żeby diagnostykować bez ujawniania PIN-u.
      const nonDigits = raw.length - pin.length
      this.logger.debug(
        `Akuvox event: bad PIN format (raw ${raw.length} chars, ${pin.length} digits, ${nonDigits} non-digits)`,
      )
      return { matched: false, opened: false, reason: 'BAD_FORMAT' }
    }
    if (pin.length !== raw.length) {
      this.logger.debug(`Akuvox PIN sanitized: stripped ${raw.length - pin.length} non-digit char(s)`)
    }

    // 2026-06-02 — kolejność lookup: GUEST → RESIDENT.
    // Powód: guest_pins są time-windowed (validFrom..validUntil) i wygasają
    // automatycznie; resident_pins są permanentne. Guest PIN ma więc krótsze
    // życie i powinien być sprawdzany pierwszy — jeśli aktywny guest "wynajął"
    // PIN od mieszkańca (przypadek edge case kolizji), guest match wygrywa.
    // Cloud-side validation zapobiega kolizji przy ustawieniu PIN-u
    // mieszkańca, ale defensive lookup zachowuje rygor.
    const match = this.store.guestPinMatch(pin)
    const residentMatch = match ? null : this.store.residentPinMatch(pin)
    if (!match && !residentMatch) {
      this.logger.log(`Akuvox event: PIN ${this.maskPin(pin)} → not found / out of window`)
      // Nawet brak matcha logujemy — pozwoli to w przyszłości wykryć
      // brute force (10⁶ przestrzeń × N gości = wykrywalne).
      this.tunnelSend?.('GUEST_PIN_REJECTED', {
        pin: this.maskPin(pin),
        intercomDeviceId: input.intercomDeviceId,
        mac: input.mac,
        ts: Date.now(),
      })

      // FAZA d (2026-06-02) — Courier visit flow. Dla 4-cyfrowych kodów Edge
      // emituje `COURIER_VISIT_NEW` żeby Cloud zaktualizował CourierVisit
      // i broadcastował push do mieszkańców. Cloud-side filtruje per
      // features.delivery_to_door (osiedle domów) — Edge nie zna tej flagi,
      // wysyła zawsze. Cloud ignoruje gdy obiekt nie wspiera kurierów.
      if (pin.length === 4) {
        this.tunnelSend?.('COURIER_VISIT_NEW', {
          code: pin,
          intercomDeviceId: input.intercomDeviceId,
          mac: input.mac,
          ts: Date.now(),
        })
      }

      return { matched: false, opened: false, reason: 'NOT_FOUND_OR_EXPIRED' }
    }

    // RESIDENT PIN flow — jeśli mieszkaniec wpisał swój stały PIN.
    if (residentMatch && !match) {
      let opened = false
      const linkedAp = this.findLinkedAp(input.intercomDeviceId, 0)
      if (linkedAp && this.accessPointExecutor) {
        const result = await this.accessPointExecutor.fire(linkedAp.id, {
          trigger: 'PIN_VALID',
          actor: `RESIDENT:${residentMatch.residentId}`,
          meta: {
            intercomDeviceId: input.intercomDeviceId,
            mac: input.mac,
            residentId: residentMatch.residentId,
            residentName: residentMatch.residentName,
            maskedPin: this.maskPin(pin),
          },
        })
        opened = result.opened
      } else {
        try {
          const result = await this.intercom.execute('OPEN_DOOR', {
            deviceId: input.intercomDeviceId,
            doorIndex: 0,
            source: 'RESIDENT_PIN',
          })
          opened = !!(result as any)?.opened
        } catch (err: any) {
          this.logger.warn(`OpenDoor after RESIDENT_PIN match failed: ${err.message}`)
        }
      }
      // Audyt — tunnel event do Cloud (rejestracja w access_events).
      // openedByType=RESIDENT, openedById=residentMatch.residentId
      this.tunnelSend?.('RESIDENT_PIN_USED', {
        residentId: residentMatch.residentId,
        intercomDeviceId: input.intercomDeviceId,
        mac: input.mac,
        opened,
        ts: Date.now(),
      })
      this.logger.log(
        `RESIDENT_PIN match: resident#${residentMatch.residentId} (${residentMatch.residentName}) → opened=${opened}`,
      )
      return {
        matched: true,
        opened,
        reason: opened ? undefined : 'OPEN_FAILED',
      }
    }

    // Refactor 2026-06-01: jeśli intercom jest podłączony do AccessPoint
    // (jest jakieś AP w lokalnym storze z outputDeviceUuid === intercomDeviceId
    // i outputIndex === 0), routujemy przez AccessPointExecutor — daje to
    // audyt PIN_USED powiązany z konkretnym AP zamiast generycznego event-u.
    //
    // Fallback: brak AP albo executor nie wstrzyknięty → stara ścieżka
    // (intercom.execute direct) — zachowane backwards-compat na wypadek
    // gdy Cloud nie syncuje jeszcze AP do Edge.
    let opened = false
    const linkedAp = this.findLinkedAp(input.intercomDeviceId, 0)

    // ── Ograniczenia dostępu gościa (2026-07-08) — OFFLINE enforcement ─────
    // PIN na domofonie otwiera konkretny AP: ten powiązany ze stacją
    // (findLinkedAp po intercomDeviceId/outputIndex=0 — dokładnie ten sam AP
    // który za chwilę odpalimy). Sprawdzamy przeciw allowlist + harmonogram
    // + limit użyć ZANIM przekaźnik ruszy. Odmowy audytowane jak
    // NOT_FOUND_OR_EXPIRED: event do Cloud (kolejka offline) + log.
    {
      const denial = this.checkGuestRestrictions(match, linkedAp?.id ?? null)
      if (denial) {
        this.logger.log(
          `Akuvox event: PIN ${this.maskPin(pin)} guest#${match.guestId} → DENIED ${denial}` +
          ` (ap=${linkedAp?.id ?? '?'})`,
        )
        this.tunnelSend?.('GUEST_ACCESS_DENIED', {
          guestId: match.guestId,
          accessPointId: linkedAp?.id ?? null,
          source: 'PIN',
          reason: denial,
          intercomDeviceId: input.intercomDeviceId,
          mac: input.mac,
          ts: Date.now(),
        })
        return { matched: true, opened: false, guestId: match.guestId, guestName: match.guestName, reason: denial }
      }
    }

    if (linkedAp && this.accessPointExecutor) {
      const result = await this.accessPointExecutor.fire(linkedAp.id, {
        trigger: 'PIN_VALID',
        actor: `GUEST:${match.guestId}`,
        meta: {
          intercomDeviceId: input.intercomDeviceId,
          mac: input.mac,
          guestId: match.guestId,
          maskedPin: this.maskPin(pin),
        },
      })
      opened = result.opened
      if (!opened) {
        this.logger.warn(`PIN executor fire(#${linkedAp.id}) failed: ${result.reason ?? '?'}`)
      }
    } else {
      try {
        const result = await this.intercom.execute('OPEN_DOOR', {
          deviceId: input.intercomDeviceId,
          doorIndex: 0,
          source: 'PIN',
        })
        opened = !!(result as any)?.opened
      } catch (err: any) {
        this.logger.warn(`OpenDoor after PIN match failed: ${err.message}`)
      }
    }

    // Zliczanie użyć (2026-07-08): każde FAKTYCZNE otwarcie przez gościa
    // zapisujemy lokalnie (limit liczony offline) + raportujemy do Cloud
    // eventem GUEST_ACCESS_USED z dedup uuid (retry z offline queue nie
    // zdubluje licznika po stronie Cloud).
    if (opened) {
      const useId = randomUUID()
      try {
        this.store.guestUseRecord(match.guestId, linkedAp?.id ?? null, 'PIN', useId)
      } catch (err: any) {
        this.logger.warn(`guestUseRecord failed: ${err.message}`)
      }
      this.tunnelSend?.('GUEST_ACCESS_USED', {
        guestId: match.guestId,
        accessPointId: linkedAp?.id ?? null,
        source: 'PIN',
        useId,
        ts: Date.now(),
      })
    }

    // Audyt + push do mieszkańca — fire-and-forget przez tunel. Cloud
    // (EdgeGateway) wywoła GuestsValidationService.markFirstUse(),
    // który jest idempotentny (race-safe UPDATE z `usedAt IS NULL`).
    this.tunnelSend?.('GUEST_PIN_USED', {
      guestId: match.guestId,
      pin,                              // pełny PIN — Cloud weryfikuje
      intercomDeviceId: input.intercomDeviceId,
      mac: input.mac,
      accessPointId: linkedAp?.id ?? null,
      opened,
      ts: Date.now(),
    })

    this.logger.log(
      `Akuvox event: PIN ${this.maskPin(pin)} → guest#${match.guestId} ` +
      `(${match.guestName ?? '?'}) opened=${opened}`,
    )

    return {
      matched: true,
      opened,
      guestId: match.guestId,
      guestName: match.guestName,
    }
  }

  // ── Ograniczenia gościa (2026-07-08) ────────────────────────────────────────
  /**
   * Walidacja ograniczeń gościa dla konkretnego AP. Zwraca reason odmowy
   * albo null gdy dostęp dozwolony. Kolejność (najbardziej specyficzny błąd
   * pierwszy): allowlista AP → harmonogram → limit użyć.
   *
   * `apId=null` = nie wiemy który AP odpali (legacy intercom bez AP w storze):
   *   • gdy gość MA allowlistę → odmowa AP_NOT_ALLOWED (bez wiedzy o AP nie
   *     da się bezpiecznie zawęzić — fail-closed),
   *   • limit sprawdzamy wtedy przeciw sumie wszystkich użyć gościa.
   *
   * Zużycie = lokalne guest_uses (PIN+LPR na tym Edge — pełne, bo budynek ma
   * 1 Edge) + snapshot użyć PORTALOWYCH z Cloud (cloud_uses, dosyłany w
   * PIN_UPSERT po każdym otwarciu portalowym i w SYNC_ALL przy reconnect).
   * Okno niedokładności: otwarcia portalowe w czasie offline Edge nie są
   * wliczane aż do resync — limit może być przekroczony o ich liczbę
   * (eventual consistency, akceptowane; patrz guest-restrictions.util.ts).
   */
  checkGuestRestrictions(
    match: { guestId: number; allowedAps: string | null; schedule: string | null; cloudUses: string | null },
    apId: number | null,
  ): 'AP_NOT_ALLOWED' | 'OUT_OF_SCHEDULE' | 'USES_EXHAUSTED' | null {
    const allowed = this.safeParse<AllowedAccessPointEntry[]>(match.allowedAps)
    const schedule = this.safeParse<RecurringSchedule>(match.schedule)
    const cloudUses = this.safeParse<Record<string, number>>(match.cloudUses) ?? {}

    // 1. Allowlista AP.
    let maxUses: number | null = null
    if (allowed && allowed.length > 0) {
      if (apId === null) return 'AP_NOT_ALLOWED'
      const entry = allowedEntryFor(allowed, apId)
      if (!entry.allowed) return 'AP_NOT_ALLOWED'
      maxUses = entry.maxUses
    }

    // 2. Harmonogram cykliczny (strefa Europe/Warsaw liczona w JS — sqlite bez TZ).
    if (!isWithinSchedule(schedule, Date.now())) return 'OUT_OF_SCHEDULE'

    // 3. Limit użyć per AP.
    if (maxUses !== null) {
      const local = this.store.guestUseCountLocal(match.guestId, apId)
      const portal = apId !== null ? (cloudUses[String(apId)] ?? 0) : Object.values(cloudUses).reduce((a, b) => a + b, 0)
      if (local + portal >= maxUses) return 'USES_EXHAUSTED'
    }
    return null
  }

  private safeParse<T>(json: string | null): T | null {
    if (!json) return null
    try {
      return JSON.parse(json) as T
    } catch {
      return null
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  /** ISO/Date/null → epoch ms lub null. Cloud przesyła ISO string-i. */
  private toMillis(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (v instanceof Date) return v.getTime()
    if (typeof v === 'string') {
      const t = Date.parse(v)
      return Number.isNaN(t) ? null : t
    }
    return null
  }

  /** Bezpieczne logowanie — pierwsze 2 cyfry + `***` + ostatnia. */
  private maskPin(pin: string): string {
    if (pin.length < 4) return '****'
    return `${pin.slice(0, 2)}***${pin.slice(-1)}`
  }

  /**
   * Znajdź AccessPoint który jest podpięty do danego intercomu na konkretnym
   * wyjściu (doorIndex). Używane po PIN_VALID do routowania przez executor
   * zamiast bezpośredniego intercom.execute.
   *
   * Refactor 2026-06-01. Edge ma `access_points` tabelę z `output_device_uuid`
   * + `output_index` — szukamy match-u. Gdy intercomDeviceId nieznany (Akuvox
   * nie podaje), bierzemy AP które matchuje tylko po outputIndex (=PIN keypad
   * to default doorIndex=0 na większości intercomów).
   */
  private findLinkedAp(intercomDeviceId: string | undefined, outputIndex: number) {
    const aps = this.store.apsList()
    if (intercomDeviceId) {
      // exact match
      const exact = aps.find(
        ap => ap.isActive && ap.outputDeviceUuid === intercomDeviceId && ap.outputIndex === outputIndex,
      )
      if (exact) return exact
      // fallback: legacy binding (deviceId+relayIndex zostały przy backfillu)
      return aps.find(
        ap => ap.isActive && ap.legacyDeviceId === intercomDeviceId && ap.legacyRelayIndex === outputIndex,
      )
    }
    // Brak deviceId — wybierz pierwszy AP z odpowiednim outputIndex.
    return aps.find(ap => ap.isActive && ap.outputIndex === outputIndex)
  }
}
