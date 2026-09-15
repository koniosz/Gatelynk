import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { unitLabelSql } from '../common/unit-label'
import { GuestsValidationService } from '../guests/guests-validation.service'
import { AccessEventsService } from '../access-events/access-events.service'
import { PushService } from '../push/push.service'
import { signPushMediaToken } from './push-media-token'

/**
 * 2026-07-30 — meta przepustki wyjazdowej z Edge (docs/exit-grace-pass.md).
 * Edge dokleja do LPR_READ przy reason exit_pass / overstay / overstay_denied.
 */
interface ExitPassMeta {
  enteredAt?: number
  expiresAt?: number
  dwellMinutes?: number
  graceMinutes?: number
  afterExpiry?: string
  entryCameraDeviceId?: string | null
}

/**
 * LprReadsService — persistence + query layer for ANPR detections pushed from
 * Edge over the WS tunnel.
 *
 * Writes: `recordRead(...)` called by EdgeGateway on every LPR_READ event.
 * Reads:  `listForBuilding(...)` + `listForResident(...)` — scoped by role
 *         controllers (integrator / building-admin / concierge / resident).
 *
 * Retention: nightly sweep keeps 30 days. Matches the Edge-local policy.
 *
 * Implementation note: we use Prisma raw SQL (matching the CLAUDE.md workaround
 * for the Prisma 7.5 vs 5.22 monorepo version drift). This avoids the
 * `prisma generate` failure for newly-added models.
 */
@Injectable()
export class LprReadsService {
  private readonly logger = new Logger(LprReadsService.name)

  constructor(
    private prisma: PrismaService,
    private guestsValidation: GuestsValidationService,
    private accessEvents: AccessEventsService,
    private push: PushService,
  ) {}


  /**
   * Miniatura odczytu pobrana PRZEZ TUNEL (droga podstawowa).
   *
   * Edge łączy się do chmury wychodząco i trzyma to połączenie — jest więc
   * osiągalny zawsze, gdy jest online. Droga odwrotna („chmura łączy się do
   * Edge") wymaga dodatkowej sieci VPN i to ona zawiodła 2026-08-07, zabierając
   * miniatury na wszystkich obiektach po cichu.
   *
   * Zwraca `null` gdy Edge offline, brak zdjęcia albo przekroczono limit
   * równoczesnych żądań — wołający ma wtedy fallback na starą drogę HTTP.
   * `EdgeGateway` rozwiązywany leniwie, tym samym wzorcem co w drugą stronę,
   * żeby nie powstał cykl modułowy.
   */
  private edgeGateway?: { requestLprSnapshot(b: number, r: number): Promise<Buffer | null> }

  /**
   * Wstrzykiwane PRZEZ bramkę (push), nie pobierane przez nas (pull) — import
   * `EdgeGateway` tworzyłby cykl modułowy, bo bramka już zna ten serwis.
   */
  setEdgeGateway(gw: { requestLprSnapshot(b: number, r: number): Promise<Buffer | null> }) {
    this.edgeGateway = gw
  }

  async fetchSnapshotViaTunnel(readId: number, buildingId: number): Promise<Buffer | null> {
    try {
      if (!this.edgeGateway) return null
      const row = await this.prisma.$queryRaw<{ edgeReadId: number | null; hasImage: boolean }[]>`
        SELECT "edgeReadId", "hasImage"
          FROM "lpr_reads"
         WHERE id = ${readId} AND "buildingId" = ${buildingId}
         LIMIT 1
      `
      const r = row[0]
      if (!r?.hasImage || r.edgeReadId == null) return null
      return await this.edgeGateway.requestLprSnapshot(buildingId, r.edgeReadId)
    } catch {
      return null   // brak tunelu / serwis niegotowy — fallback zrobi swoje
    }
  }

  /**
   * Zdjęcie po (buildingId, edgeReadId) — dla publicznego endpointu
   * push-media (zdjęcie w powiadomieniu „gość wjechał/wyjechał").
   * Weryfikujemy w bazie, że taki odczyt istnieje i MA obraz — token
   * podpisany, ale defense-in-depth nic nie kosztuje.
   */
  async fetchSnapshotByEdgeReadId(buildingId: number, edgeReadId: number): Promise<Buffer | null> {
    try {
      if (!this.edgeGateway) return null
      const row = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT id FROM "lpr_reads"
         WHERE "buildingId" = ${buildingId} AND "edgeReadId" = ${edgeReadId}
           AND "hasImage" = true
         LIMIT 1
      `
      if (!row[0]) return null
      return await this.edgeGateway.requestLprSnapshot(buildingId, edgeReadId)
    } catch {
      return null
    }
  }

  /** Normalised plate shape — matches Edge-side normalisation. */
  private normalizePlate(p: string): string {
    return (p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  }

  /**
   * Persist a LPR_READ event coming from Edge. Called by EdgeGateway.
   * Silently ignores invalid payloads (we log & move on — never crash the WS).
   *
   * Idempotency: Edge robi backfill po reconnect (`SyncService.backfillUnsyncedLprReads`),
   * więc ten sam odczyt może przylecieć dwa razy — np. raz wysłany na żywo
   * przed dropem WS, a drugi raz w backfill po reconnect (Edge nie wie czy
   * pierwszy faktycznie doszedł, bo `ws.send` jest fire-and-forget). Partial
   * unique index na `(buildingId, cameraDeviceId, edgeReadId)` (migracja
   * 20260427120000) + `ON CONFLICT DO NOTHING` sprawia, że duplikat to no-op
   * zamiast unikalnego błędu / zduplikowanego wiersza.
   *
   * Edge zawsze wystawia `edgeReadId`, więc partial index (WHERE NOT NULL)
   * pokrywa wszystkie nowoczesne odczyty. Historyczne wiersze bez
   * `edgeReadId` pozostają poza indeksem — i tak nie da się ich
   * zdeduplikować.
   */
  async recordRead(
    buildingId: number,
    payload: {
      cameraDeviceId?: string
      plate?: string
      matched?: boolean
      owner?: string | null
      gateOpened?: boolean
      reason?: string | null
      confidence?: number | null
      direction?: string | null
      vehicleColor?: string | null
      vehicleBrand?: string | null
      vehicleType?: string | null
      vehicleSubtype?: string | null
      hasImage?: boolean
      edgeReadId?: number | null
      ts?: number
      /** 2026-07-30 — przepustka wyjazdowa (reason exit_pass/overstay/overstay_denied). */
      exitPass?: ExitPassMeta | null
      /** 2026-09-15 — surowy odczyt OCR przy reason=probable_match/unconfirmed. */
      ocrRaw?: string | null
    },
  ): Promise<void> {
    const plate = this.normalizePlate(payload.plate ?? '')
    if (!plate) {
      this.logger.warn(`LPR_READ dropped — empty plate (building ${buildingId})`)
      return
    }
    const cameraDeviceId = payload.cameraDeviceId ?? ''
    if (!cameraDeviceId) {
      this.logger.warn(`LPR_READ dropped — missing cameraDeviceId (building ${buildingId})`)
      return
    }
    const ts = payload.ts ? new Date(payload.ts) : new Date()
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "lpr_reads"
          ("buildingId", "cameraDeviceId", "plate", "matched", "owner",
           "gateOpened", "reason", "confidence", "direction", "edgeReadId", "ts",
           "vehicleColor", "vehicleBrand", "vehicleType", "vehicleSubtype", "hasImage")
        VALUES
          (${buildingId}, ${cameraDeviceId}, ${plate}, ${payload.matched ?? false}, ${payload.owner ?? null},
           ${payload.gateOpened ?? false}, ${payload.reason ?? null}, ${payload.confidence ?? null},
           ${payload.direction ?? null}, ${payload.edgeReadId ?? null}, ${ts},
           ${payload.vehicleColor ?? null}, ${payload.vehicleBrand ?? null},
           ${payload.vehicleType ?? null}, ${payload.vehicleSubtype ?? null},
           ${payload.hasImage ?? false})
        ON CONFLICT ("buildingId", "cameraDeviceId", "edgeReadId")
          WHERE "edgeReadId" IS NOT NULL
          DO NOTHING
      `
    } catch (err: any) {
      this.logger.warn(`Failed to persist LPR_READ for building ${buildingId}: ${err.message}`)
    }

    // Faza 2B/3: jeśli plate pasuje do ACTIVE gościa (w oknie), oznaczamy
    // pierwsze użycie + push do mieszkańca. Fire-and-forget — błąd matcha
    // NIE powinien zatrzymać przyjęcia eventu LPR.
    //
    // 2026-08-15: BEZ warunku `payload.matched`. `matched` mówi tylko, czy
    // tablica była na lokalnej whiteliście Edge'a w chwili odczytu — gość
    // dodany przy chwilowo rozłączonym Edge (zgubiony PLATE_UPSERT, sync
    // dopiero przy reconnect) miał matched=false i push o wjeździe/wyjeździe
    // PRZEPADAŁ, mimo że zaproszenie w Cloud było ważne (case Jadzia/WW807AT
    // 2026-08-12 09:20). Atrybucja gościa i tak liczy się tu, w Cloud;
    // matchPlate to jeden tani SELECT po tablicy, a throttle per gość chroni
    // przed dublami z dwóch kamer.
    this.guestsValidation
      .matchPlate(buildingId, plate, {
        direction: payload.direction ?? null,
        edgeReadId: payload.edgeReadId ?? null,
        hasImage: payload.hasImage ?? false,
      })
      .catch(() => { /* logged inside */ })

    // 2026-08-21 — push o przejeździe WŁASNEGO pojazdu (opt-in z karty
    // pojazdu w apce, kadr z LPR jak u gości). Fire-and-forget.
    this.notifyVehiclePassage(buildingId, plate, {
      direction: payload.direction ?? null,
      edgeReadId: payload.edgeReadId ?? null,
      hasImage: payload.hasImage ?? false,
      reason: payload.reason ?? null,
      ocrRaw: payload.ocrRaw ?? null,
    }).catch((err) =>
      this.logger.warn(`vehicle passage push failed for ${plate}: ${err?.message ?? err}`))

    // Faza 3: AccessEvent audit record (LPR_MATCH lub LPR_NO_MATCH).
    // Fire-and-forget — błąd auditu nie blokuje LPR.
    this.recordLprAccessEvent(buildingId, plate, ts, payload).catch((err) => {
      this.logger.warn(
        `AccessEvent hook (LPR) failed for building ${buildingId}: ${err?.message ?? err}`,
      )
    })

    // 2026-07-30 — przepustka wyjazdowa: OVERSTAY (wyjazd po oknie /
    // odmowa przy polityce DENY) → push do adminów budynku. Fire-and-forget.
    if (payload.reason === 'overstay' || payload.reason === 'overstay_denied') {
      this.notifyOverstay(buildingId, plate, payload).catch((err) => {
        this.logger.warn(`Overstay push failed for building ${buildingId}: ${err?.message ?? err}`)
      })
    }
  }

  /**
   * Push OVERSTAY do adminów budynku (docs/exit-grace-pass.md §2 „audyt +
   * opcjonalny push do admina").
   *
   * Ograniczenie infrastruktury: PushService/APNs zna WYŁĄCZNIE tokeny
   * mieszkańców (push_tokens.residentId — patrz komentarz w
   * anomaly-events.service: „Building admins i concierges nie mają jeszcze
   * push-tokenów"). Dlatego dostarczamy push do KONT MIESZKAŃCA powiązanych
   * z adminami budynku po e-mailu (konwencja multi-konta: jeden email = konta
   * w wielu rolach/budynkach). Admin bez konta mieszkańca w tym budynku
   * zobaczy zdarzenie w feedzie „Wejścia (audit)" panelu BA — event
   * LPR_NO_MATCH z reason=overstay jest tam zawsze zapisywany.
   *
   * Throttle per (budynek, tablica) 5 min — kamera potrafi wysłać serię
   * eventów zanim auto przejedzie szlaban.
   */
  /** Cooldown per (budynek, tablica) — wzorzec AnomalyEventsService. */
  private readonly overstayCooldown = new Map<string, number>()

  private async notifyOverstay(
    buildingId: number,
    plate: string,
    payload: { reason?: string | null; exitPass?: ExitPassMeta | null },
  ): Promise<void> {
    // Cooldown NAJPIERW (jeden klucz dla wszystkich adminów — throttle w
    // PushService jest per wywołanie, więc zdławiłby drugiego admina).
    const cooldownKey = `${buildingId}:${plate}`
    const last = this.overstayCooldown.get(cooldownKey) ?? 0
    if (Date.now() - last < 5 * 60_000) return
    this.overstayCooldown.set(cooldownKey, Date.now())
    if (this.overstayCooldown.size > 2000) {
      const cutoff = Date.now() - 60 * 60_000
      for (const [k, t] of this.overstayCooldown) {
        if (t < cutoff) this.overstayCooldown.delete(k)
      }
    }

    const admins = await this.prisma.$queryRaw<{ residentId: number }[]>`
      SELECT DISTINCT r.id AS "residentId"
        FROM "building_admins" ba
        JOIN "building_admin_assignments" baa
          ON baa."buildingAdminId" = ba.id AND baa."buildingId" = ${buildingId}
        JOIN "residents" r
          ON lower(r.email) = lower(ba.email) AND r."buildingId" = ${buildingId}
    `
    if (admins.length === 0) {
      this.logger.log(
        `OVERSTAY ${plate} (b#${buildingId}) — brak kont push adminów; zdarzenie widoczne w feedzie Wejścia`,
      )
      return
    }
    const dwell = payload.exitPass?.dwellMinutes
    const denied = payload.reason === 'overstay_denied'
    const title = denied ? '⏱ Przekroczony czas pobytu — wyjazd zablokowany' : '⏱ Przekroczony czas pobytu'
    const body = denied
      ? `Pojazd ${plate} próbował wyjechać po przekroczeniu okna przepustki${dwell ? ` (${dwell} min na osiedlu)` : ''} — szlaban nie został otwarty (polityka DENY).`
      : `Pojazd ${plate} wyjechał po przekroczeniu okna przepustki${dwell ? ` (${dwell} min na osiedlu)` : ''} — szlaban otwarto (OPEN_AND_FLAG).`
    await Promise.all(
      admins.map((a) =>
        this.push.sendToResident(
          a.residentId,
          title,
          body,
          { type: 'OVERSTAY', buildingId, plate },
        ).catch((err: Error) =>
          this.logger.warn(`Overstay push to resident ${a.residentId} failed: ${err.message}`),
        ),
      ),
    )
  }

  /**
   * Faza 3 audit hook — wstawia odpowiednik LPR_MATCH/LPR_NO_MATCH do
   * `access_events`. Wywoływany asynchronicznie z `recordRead` żeby nie
   * blokować ścieżki Edge → LPR.
   *
   * Resolves:
   *   • lprReadId — szukamy świeżo wstawionego wiersza po
   *     (buildingId, cameraDeviceId, edgeReadId) jeśli edgeReadId jest, inaczej
   *     po (buildingId, plate, ts) (limit 1 DESC). ON CONFLICT DO NOTHING
   *     gwarantuje, że ten sam edgeReadId daje ten sam id.
   *   • vehicleId/residentId — JOIN do `vehicles` po plate (matched=true).
   */
  /**
   * 2026-08-21 — powiadomienie o przejeździe WŁASNEGO pojazdu mieszkańca.
   * Lustrzane do flow gościa (guests-validation.matchPlate): opt-in per
   * pojazd (vehicles.notifyOnUse), kadr z odczytu LPR przez podpisany URL
   * push-media (Notification Service Extension pokaże zdjęcie w pushu),
   * throttle per pojazd+kierunek (dwie kamery na jednym przejeździe = 1 push).
   */
  private async notifyVehiclePassage(
    buildingId: number,
    plate: string,
    ctx: {
      direction?: string | null
      edgeReadId?: number | null
      hasImage?: boolean
      /** 2026-09-15 — `probable_match` = odczyt niepewny dopasowany do rejestru na Edge. */
      reason?: string | null
      ocrRaw?: string | null
    },
  ) {
    // Odczyt niepotwierdzony BEZ dopasowania to surowy OCR — nie ma do kogo pushować.
    if (ctx.reason === 'unconfirmed') return
    const rows = await this.prisma.$queryRaw<{ id: number; residentId: number | null }[]>`
      SELECT id, "residentId" FROM "vehicles"
       WHERE "buildingId" = ${buildingId}
         AND "licensePlate" = ${plate}
         AND status = 'APPROVED'
         AND "notifyOnUse" = TRUE
         AND "residentId" IS NOT NULL
       LIMIT 1
    `
    const v = rows[0]
    if (!v?.residentId) return

    let imageUrl: string | undefined
    if (ctx.hasImage && ctx.edgeReadId != null) {
      const base = (process.env.PUBLIC_BASE_URL ?? 'https://api.gatelynk.com').replace(/\/+$/, '')
      imageUrl = `${base}/api/push-media/lpr/${signPushMediaToken(buildingId, ctx.edgeReadId)}`
    }

    const isExit = String(ctx.direction ?? '').toUpperCase() === 'OUT'
    const probable = ctx.reason === 'probable_match'
    const dirWord = isExit ? 'wyjazd' : 'wjazd'
    await this.push.sendToResidentThrottled(
      `vehicle-${isExit ? 'exit' : 'entry'}-${v.id}`,
      3 * 60_000,
      v.residentId,
      probable
        ? (isExit ? '🚗 Prawdopodobnie Twój pojazd wyjechał' : '🚗 Prawdopodobnie Twój pojazd wjechał')
        : (isExit ? '🚗 Twój pojazd wyjechał' : '🚗 Twój pojazd wjechał'),
      probable
        ? `${plate} — ${dirWord} przez bramę. Odczyt niepewny` +
          (ctx.ocrRaw && ctx.ocrRaw !== plate ? ` (kamera odczytała ${ctx.ocrRaw}).` : '.')
        : `${plate} — ${dirWord} przez bramę.`,
      {
        kind: isExit ? 'VEHICLE_EXIT' : 'VEHICLE_ENTRY',
        vehicleId: v.id,
        plate,
        ts: Date.now(),
        ...(probable ? { probable: true, ocrRaw: ctx.ocrRaw ?? undefined } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      },
    )
  }

  private async recordLprAccessEvent(
    buildingId: number,
    plate: string,
    ts: Date,
    payload: {
      cameraDeviceId?: string
      matched?: boolean
      gateOpened?: boolean
      reason?: string | null
      direction?: string | null
      confidence?: number | null
      edgeReadId?: number | null
      exitPass?: ExitPassMeta | null
    },
  ): Promise<void> {
    // Lookup LprRead.id (po insercie/conflict).
    let lprReadId: number | null = null
    try {
      if (payload.edgeReadId != null && payload.cameraDeviceId) {
        const rows = await this.prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM "lpr_reads"
          WHERE "buildingId" = ${buildingId}
            AND "cameraDeviceId" = ${payload.cameraDeviceId}
            AND "edgeReadId" = ${payload.edgeReadId}
          LIMIT 1
        `
        lprReadId = rows[0]?.id ?? null
      }
      if (lprReadId == null) {
        const rows = await this.prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM "lpr_reads"
          WHERE "buildingId" = ${buildingId}
            AND plate = ${plate}
            AND ts = ${ts}
          ORDER BY id DESC
          LIMIT 1
        `
        lprReadId = rows[0]?.id ?? null
      }
    } catch {
      /* ignore lookup errors — wciąż zapisujemy event z lprReadId=null */
    }

    // Resolve vehicle/resident dla matched=true.
    let vehicleId: number | null = null
    let residentId: number | null = null
    if (payload.matched) {
      try {
        const rows = await this.prisma.$queryRaw<{ id: number; residentId: number | null }[]>`
          SELECT id, "residentId"
          FROM "vehicles"
          WHERE "buildingId" = ${buildingId}
            AND "licensePlate" = ${plate}
          ORDER BY id DESC
          LIMIT 1
        `
        if (rows[0]) {
          vehicleId = rows[0].id
          residentId = rows[0].residentId
        }
      } catch {
        /* ignore */
      }
    }

    // 2026-07-04 — link do aktywnego GOŚCIA po tablicy (guest.vehiclePlate).
    // Tablice gości idą na whitelistę LPR (owner „Gość X"), ale access_event
    // dotąd NIE dostawał guestId — historia gościa w iOS/panelach nie widziała
    // wjazdów autem. Match: status ACTIVE + ts w oknie [validFrom, validTo]
    // (ts odczytu, nie NOW() — backfill po reconnect Edge też trafia).
    // Robimy to dla MATCH i NO_MATCH (auto gościa przed syncem whitelisty to
    // wciąż aktywność gościa). residentId gościa (zapraszający) uzupełniamy
    // tylko gdy pojazd nie wskazał własnego rezydenta.
    let guestId: number | null = null
    let guestName: string | null = null
    try {
      const guests = await this.prisma.$queryRaw<
        { id: number; residentId: number; name: string }[]
      >`
        SELECT id, "residentId", name
        FROM "guests"
        WHERE "buildingId" = ${buildingId}
          AND "vehiclePlate" = ${plate}
          AND status = 'ACTIVE'
          AND ${ts} BETWEEN "validFrom" AND "validTo"
        ORDER BY id DESC
        LIMIT 1
      `
      if (guests[0]) {
        guestId = guests[0].id
        guestName = guests[0].name
        if (residentId == null) residentId = guests[0].residentId
      }
    } catch {
      /* ignore — event i tak leci, tylko bez linku do gościa */
    }

    await this.accessEvents.record({
      buildingId,
      type: payload.matched ? 'LPR_MATCH' : 'LPR_NO_MATCH',
      ts,
      direction: payload.direction ?? null,
      gateOpened: payload.gateOpened ?? false,
      reason: payload.reason ?? null,
      residentId,
      vehicleId,
      guestId,
      lprReadId,
      plate,
      openedById: null,
      openedByType: 'EDGE',
      meta: {
        cameraDeviceId: payload.cameraDeviceId ?? null,
        edgeReadId: payload.edgeReadId ?? null,
        confidence: payload.confidence ?? null,
        // Snapshot imienia gościa — przeżywa CASCADE delete gościa
        // (kolumna guestId robi się NULL, meta zostaje).
        ...(guestName ? { guestName } : {}),
        // 2026-07-30 — przepustka wyjazdowa: enteredAt/dwellMinutes dla
        // etykiet PL w feedzie („Wyjazd na przepustce — X min na osiedlu").
        ...(payload.exitPass ? { exitPass: payload.exitPass } : {}),
      },
    })
  }

  /**
   * Integrator scope: verify the building belongs to the integrator, then list.
   * Throws 404 if the integrator doesn't own the building.
   */
  async listForIntegrator(
    buildingId: number,
    adminId: number,
    opts: ReadQueryOpts,
  ) {
    const ok = await this.prisma.building.findFirst({
      where: { id: buildingId, adminId },
      select: { id: true },
    })
    if (!ok) throw new NotFoundException('Building not found')
    return this.queryReads(buildingId, opts)
  }

  /**
   * Building-admin scope: the admin must have this building in its JWT
   * `buildingIds` array (checked in the controller).
   */
  async listForBuildingAdmin(
    buildingId: number,
    buildingIds: number[],
    opts: ReadQueryOpts,
  ) {
    if (!buildingIds.includes(buildingId)) throw new ForbiddenException()
    return this.queryReads(buildingId, opts)
  }

  /**
   * Concierge scope: concierge has exactly one building in its JWT.
   */
  async listForConcierge(buildingId: number, opts: ReadQueryOpts) {
    return this.queryReads(buildingId, opts)
  }

  /**
   * Resident scope: fetch the resident's vehicle plates and only return reads
   * matching any of them (in this building). The enrichment columns (vehicle
   * owner, unit, etc.) are always present by construction here — but we keep
   * the same JOIN shape as the admin/concierge listings so the client side
   * doesn't have to branch on role.
   */
  async listForResident(residentId: number, buildingId: number, opts: ReadQueryOpts) {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { residentId, buildingId },
      select: { licensePlate: true },
    })
    const plates = vehicles
      .map(v => this.normalizePlate(v.licensePlate))
      .filter(p => p.length > 0)
    if (plates.length === 0) return { reads: [], plates: [], total: 0 }

    const limit = clampInt(opts.limit ?? 200, 1, 1000)
    const offset = clampInt(opts.offset ?? 0, 0, 1_000_000)
    const totalRows = await this.prisma.$queryRaw<{ c: number }[]>`
      SELECT COUNT(*)::int AS c
        FROM "lpr_reads" r
       WHERE r."buildingId" = ${buildingId}
         AND r.plate = ANY(${plates}::text[])
    `
    const rows = await this.prisma.$queryRaw<ReadRow[]>`
      SELECT ${READ_SELECT}
        FROM "lpr_reads" r
        ${VEHICLE_JOIN}
       WHERE r."buildingId" = ${buildingId}
         AND r.plate = ANY(${plates}::text[])
       ORDER BY r.ts DESC
       LIMIT ${limit} OFFSET ${offset}
    `
    return { reads: rows, plates, total: totalRows[0]?.c ?? 0 }
  }

  /**
   * Shared query implementation — applies plate substring search + matched
   * filter + free-text `q` + offset/limit pagination.
   *
   * Filtry łączymy dynamicznie przez `Prisma.sql` fragmenty (parametry zawsze
   * przez placeholdery — bezpieczne SQL injection-wise). `q` szuka po
   * tablicy + owner + brandzie + modelu + kolorze + nazwie serwisu +
   * imieniu/nazwisku rezydenta + numerze lokalu — czyli wszystkim co user
   * widzi w wierszu listy. Wszystkie kolumny tekstowe lecą `ILIKE` (Postgres
   * case-insensitive), `r.plate` osobno bo jest zawsze upper-case → robimy
   * też porównanie z normalised query (`normalizePlate`). Bez separate
   * trigram indexu — przy 30-dniowym oknie (max ~30k wierszy/budynek)
   * sequential scan na ~10ms, OK.
   *
   * Zwracamy też `total` (count(*) dla tych samych filtrów ale bez
   * offset/limit) żeby UI mogło pokazać paginację „strona X z Y".
   */
  private async queryReads(
    buildingId: number,
    opts: ReadQueryOpts,
  ): Promise<{ reads: ReadRow[]; total: number }> {
    const limit = clampInt(opts.limit ?? 50, 1, 200)
    const offset = clampInt(opts.offset ?? 0, 0, 1_000_000)
    const plateQ = opts.plate ? this.normalizePlate(opts.plate) : ''
    const q = (opts.q ?? '').trim()

    // All column refs are qualified (`r.`, `v.`, `res.`, `cu.`) because after
    // joining `vehicles`/`residents`/`units` many field names collide with
    // `lpr_reads` (buildingId, residentId…). Leaving them unqualified triggers
    // ambiguous-column errors at runtime.
    const parts: Prisma.Sql[] = [Prisma.sql`r."buildingId" = ${buildingId}`]
    if (opts.cameraDeviceId) parts.push(Prisma.sql`r."cameraDeviceId" = ${opts.cameraDeviceId}`)
    if (opts.matched !== undefined) parts.push(Prisma.sql`r.matched = ${opts.matched}`)
    if (plateQ) parts.push(Prisma.sql`r.plate LIKE ${'%' + plateQ + '%'}`)
    if (opts.identified === true) parts.push(Prisma.sql`v.id IS NOT NULL`)
    if (opts.identified === false) parts.push(Prisma.sql`v.id IS NULL`)

    // Filtr po konkretnym dniu (YYYY-MM-DD) wybranym z kalendarza. `r.ts` to
    // `timestamp` (UTC), a użytkownik myśli w czasie lokalnym (Europe/Warsaw) —
    // konwertujemy instant → data lokalna i porównujemy z wybranym dniem.
    // DST obsługuje baza stref Postgresa. Przy ~30k wierszy/budynek seq-scan
    // jest tani (komentarz wyżej), więc brak indeksu funkcyjnego to OK.
    if (opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day)) {
      parts.push(
        Prisma.sql`(r.ts AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Warsaw')::date = ${opts.day}::date`,
      )
    }

    if (q.length > 0) {
      // Multi-column free-text. Plate column normalised tak samo jak query,
      // żeby „WA 12345" znalazło „WA12345". Resztę kolumn ILIKE (case-insens).
      // Tagi pojazdu są TEXT[] — rozplatamy `unnest` i ILIKE-ujemy każdy tag
      // (case-insensitive partial match: „kurier" znajdzie tag „Kurier GLS").
      // Patrz issue raportowane 2026-05-11: user wpisywał „kurier" i nie
      // dostawał wpisów z tagiem, tylko z `serviceName` zawierającym "kurier".
      const qLike = `%${q}%`
      const plateLike = `%${this.normalizePlate(q)}%`
      parts.push(Prisma.sql`(
        r.plate LIKE ${plateLike}
        OR r.owner ILIKE ${qLike}
        OR r."vehicleBrand" ILIKE ${qLike}
        OR r."vehicleColor" ILIKE ${qLike}
        OR v.make ILIKE ${qLike}
        OR v.model ILIKE ${qLike}
        OR v.color ILIKE ${qLike}
        OR v."serviceName" ILIKE ${qLike}
        OR v.notes ILIKE ${qLike}
        OR EXISTS (SELECT 1 FROM unnest(COALESCE(v.tags, '{}'::text[])) AS t WHERE t ILIKE ${qLike})
        OR res."firstName" ILIKE ${qLike}
        OR res."lastName" ILIKE ${qLike}
        OR cu.unit_number ILIKE ${qLike}
        OR vu.number ILIKE ${qLike}
      )`)
    }

    const where = Prisma.join(parts, ' AND ')

    // Total — ten sam WHERE + JOIN, bez ORDER BY/LIMIT. Subquery przez CTE byłby
    // czystszy, ale dwa zapytania to też OK przy małej tabeli i pozwala na
    // niezależny EXPLAIN gdyby trzeba było zoptymalizować.
    const totalRows = await this.prisma.$queryRaw<{ c: number }[]>`
      SELECT COUNT(*)::int AS c
        FROM "lpr_reads" r
        ${VEHICLE_JOIN}
       WHERE ${where}
    `
    const rows = await this.prisma.$queryRaw<ReadRow[]>`
      SELECT ${READ_SELECT}
        FROM "lpr_reads" r
        ${VEHICLE_JOIN}
       WHERE ${where}
       ORDER BY r.ts DESC
       LIMIT ${limit} OFFSET ${offset}
    `
    return { reads: rows, total: totalRows[0]?.c ?? 0 }
  }

  /**
   * Resolve the URL of the JPEG snapshot for a given cloud-side read ID.
   *
   * Cloud doesn't store snapshots — they live on the Edge. To show the
   * picture in a web panel we proxy: cloud panel → cloud API → Edge HTTP
   * server (`http://<edge-ip>:4000/lpr/reads/<edgeReadId>/image`).
   *
   * `buildingId` is always checked so one tenant can't probe another's
   * snapshots by guessing numeric IDs.
   *
   * Returns `null` when:
   *   - the read doesn't exist / is in a different building
   *   - the read has no snapshot (hasImage=false or edgeReadId is null)
   *   - no activated Edge device is registered for this building
   *   - the Edge has no known reachable IP yet
   *
   * The caller (controller) translates `null` into a 404.
   */
  async resolveImageUrl(readId: number, buildingId: number): Promise<string | null> {
    const read = await this.prisma.$queryRaw<
      { edgeReadId: number | null; hasImage: boolean }[]
    >`
      SELECT "edgeReadId", "hasImage"
        FROM "lpr_reads"
       WHERE id = ${readId} AND "buildingId" = ${buildingId}
       LIMIT 1
    `
    const row = read[0]
    if (!row || !row.hasImage || row.edgeReadId == null) return null

    // We pick the most-recently-seen activated Edge for this building.
    // In practice there's exactly one Edge per building; `lastSeenAt DESC`
    // is just a safety tiebreaker if a replacement device was activated
    // without deactivating the old one first.
    const edge = await this.prisma.edgeDevice.findFirst({
      where: { buildingId, isActivated: true, ipAddress: { not: null } },
      select: { ipAddress: true },
      orderBy: { lastSeenAt: 'desc' },
    })
    if (!edge?.ipAddress) return null

    // Edge HTTP server always listens on port 4000 (`apps/edge/src/main.ts`).
    return `http://${edge.ipAddress}:4000/lpr/reads/${row.edgeReadId}/image`
  }

  /** Retention sweep: drop reads older than 30 days. Runs every hour. */
  @Interval(60 * 60 * 1000)
  async retentionSweep() {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const res = await this.prisma.$executeRaw`
        DELETE FROM "lpr_reads" WHERE "ts" < ${cutoff}
      `
      if (res > 0) {
        this.logger.log(`LPR reads retention: removed ${res} row(s) older than 30 days`)
      }
    } catch (err: any) {
      this.logger.warn(`LPR reads retention sweep failed: ${err.message}`)
    }
  }
}

export interface ReadQueryOpts {
  plate?: string
  matched?: boolean
  cameraDeviceId?: string
  limit?: number
  /**
   * Pagination offset (0-based). Combined z `limit` daje OFFSET-based
   * pagination — przy 30-dniowym oknie i max ~30k wierszy/budynek to
   * wystarczająco szybkie (kilka ms). Cursor pagination zostawiamy na
   * przyszłość jeśli ruch wzrośnie.
   */
  offset?: number
  /**
   * Free-text search po polach widocznych w wierszu (plate, owner, brand,
   * model, color, serviceName, residentFirstName/lastName, unitNumber).
   * Obsługa po stronie servera = wyszukiwarka „live" widzi wszystkie wpisy
   * z 30-dniowego okna, nie tylko aktualnie załadowaną stronę.
   */
  q?: string
  /**
   * Filter by identification state:
   *   true  → only reads where the plate is already linked to a Vehicle row
   *   false → only reads whose plate is NOT linked to any Vehicle (need
   *           manual assignment by admin/concierge)
   *   undefined → no filter
   */
  identified?: boolean
  /**
   * Pojedynczy dzień `YYYY-MM-DD` (wybrany z kalendarza) — pokazuje tylko
   * odczyty z tej daty w czasie lokalnym Europe/Warsaw. Walidacja formatu w
   * controllerze + ponownie w queryReads (defensywnie). undefined → bez filtra.
   */
  day?: string
}

/** Zaciska wartość do bezpiecznego zakresu int. NaN/Infinity → min. */
function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  return Math.max(min, Math.min(max, Math.floor(v)))
}

export interface ReadRow {
  id: number
  buildingId: number
  cameraDeviceId: string
  plate: string
  matched: boolean
  owner: string | null
  gateOpened: boolean
  reason: string | null
  confidence: number | null
  direction: string | null
  edgeReadId: number | null
  ts: Date
  vehicleColor: string | null
  vehicleBrand: string | null
  vehicleType: string | null
  vehicleSubtype: string | null
  hasImage: boolean

  // Identification enrichment — present when the plate is already linked to
  // a Vehicle row. All null when the plate isn't identified; clients render
  // an "Identify…" CTA whenever `vehicleId === null`.
  vehicleId: number | null
  vehicleKind: string | null          // 'RESIDENT' | 'SERVICE' | 'DELIVERY' | 'EMERGENCY' | 'PUBLIC'
  vehicleServiceName: string | null   // e.g. 'Glovo', 'MPO Odpady'
  vehicleMake: string | null
  vehicleModel: string | null
  vehicleColorStored: string | null   // `color` from the Vehicle row (human-entered)
  vehicleTags: string[]               // free-form tags entered by admin/concierge (kabrio, Glovo…)
  // Resident columns are only populated when the vehicle row has a
  // residentId (RESIDENT cars + resident-owned service vehicles). For
  // building-wide services they remain null.
  residentId: number | null
  residentFirstName: string | null
  residentLastName: string | null
  unitId: number | null
  unitNumber: string | null
  unitFloor: number | null
  // 2026-09-07 — lokal przypisany WPROST do pojazdu (unitId wyżej może być
  // lokalem mieszkańca z unit_residents). Label wg common/unit-label.ts.
  vehicleUnitId: number | null
  vehicleUnitLabel: string | null
  // Atrybucja gościa (2026-08-13) — wypełnione tylko, gdy odczyt nie ma
  // pojazdu w rejestrze, a tablica należała do aktywnego w chwili odczytu
  // zaproszenia. Panel pokazuje wtedy „Gość lokalu X" zamiast „nieznany".
  guestName: string | null
  guestUnitLabel: string | null
}

/**
 * Full SELECT list for LPR read queries. Column names are qualified because
 * we JOIN three auxiliary tables and several names collide (`buildingId`,
 * `residentId`, `color`…). Aliases with `AS` land as camelCase keys on the
 * response — keeps the JSON shape stable while the SQL stays explicit.
 */
const READ_SELECT = Prisma.sql`
  r.id,
  r."buildingId",
  r."cameraDeviceId",
  r.plate,
  r.matched,
  r.owner,
  r."gateOpened",
  r.reason,
  r.confidence,
  r.direction,
  r."edgeReadId",
  r.ts,
  r."vehicleColor",
  r."vehicleBrand",
  r."vehicleType",
  r."vehicleSubtype",
  r."hasImage",
  v.id                AS "vehicleId",
  v.kind::text        AS "vehicleKind",
  v."serviceName"     AS "vehicleServiceName",
  v.make              AS "vehicleMake",
  v.model             AS "vehicleModel",
  v.color             AS "vehicleColorStored",
  COALESCE(v.tags, '{}') AS "vehicleTags",
  res.id              AS "residentId",
  res."firstName"     AS "residentFirstName",
  res."lastName"      AS "residentLastName",
  COALESCE(vu.id, cu.unit_id)         AS "unitId",
  COALESCE(vu.number, cu.unit_number) AS "unitNumber",
  COALESCE(vu.floor, cu.unit_floor)   AS "unitFloor",
  vu.id               AS "vehicleUnitId",
  ${unitLabelSql('vu', 'vus')} AS "vehicleUnitLabel",
  gst.guest_name         AS "guestName",
  gst.guest_unit_number  AS "guestUnitLabel"
`

/**
 * JOIN chain: read → vehicle (by plate within the same building) → resident
 * → resident's current unit.
 *
 * Why LATERAL for the unit? A resident can occupy several units simultaneously
 * (e.g. ownership in one + tenancy in another). We want a single current unit
 * per read — the most recent active tenancy/ownership — so we pick it with
 * `ORDER BY ur."sinceDate" DESC LIMIT 1` inside a LATERAL subquery. This keeps
 * one row per read; otherwise the JOIN would multiply rows and break the
 * client pagination.
 *
 * `untilDate IS NULL OR untilDate > now()` treats open-ended tenancies as
 * current and respects explicit end-dates.
 */
const VEHICLE_JOIN = Prisma.sql`
  LEFT JOIN "vehicles"  v   ON v."licensePlate" = r.plate
                            AND v."buildingId"  = r."buildingId"
  LEFT JOIN "residents" res ON res.id = v."residentId"
  -- 2026-09-07: lokal przypisany WPROST do pojazdu — wygrywa nad lokalem
  -- mieszkańca (COALESCE w READ_SELECT), bo to jawna decyzja administratora.
  LEFT JOIN "units"      vu  ON vu.id = v."unitId"
  LEFT JOIN "stairwells" vus ON vus.id = vu."stairwellId"
  LEFT JOIN LATERAL (
    SELECT u.id       AS unit_id,
           u.number   AS unit_number,
           u.floor    AS unit_floor
      FROM "unit_residents" ur
      JOIN "units" u ON u.id = ur."unitId"
     WHERE ur."residentId" = res.id
       AND (ur."untilDate" IS NULL OR ur."untilDate" > now())
     ORDER BY ur."sinceDate" DESC
     LIMIT 1
  ) cu ON true
  -- Atrybucja GOŚCIA (zgłoszenie 2026-08-13): odczyt bez pojazdu w rejestrze,
  -- ale z tablicą aktywnego W CHWILI ODCZYTU zaproszenia → panel pokazuje
  -- „Gość lokalu X" zamiast „nieznany". Okno po r.ts (nie NOW!), żeby
  -- atrybucja została w historii także po wygaśnięciu zaproszenia.
  -- Warunek v.id IS NULL: tablica zarejestrowanego pojazdu nigdy nie jest
  -- „gościem" (spójnie z blokadą anty-stalkingową z 2026-08-12).
  LEFT JOIN LATERAL (
    SELECT g.name AS guest_name,
           gu.number AS guest_unit_number
      FROM "guests" g
      LEFT JOIN LATERAL (
        SELECT u.number
          FROM "unit_residents" ur
          JOIN "units" u ON u.id = ur."unitId"
         WHERE ur."residentId" = g."residentId"
           AND (ur."untilDate" IS NULL OR ur."untilDate" > now())
         ORDER BY ur."sinceDate" DESC
         LIMIT 1
      ) gu ON true
     WHERE v.id IS NULL
       AND g."buildingId" = r."buildingId"
       AND g."vehiclePlate" IS NOT NULL
       AND regexp_replace(upper(g."vehiclePlate"), '[^A-Z0-9]', '', 'g') = r.plate
       AND r.ts BETWEEN g."validFrom" AND g."validTo"
     ORDER BY g.id DESC
     LIMIT 1
  ) gst ON true
`
