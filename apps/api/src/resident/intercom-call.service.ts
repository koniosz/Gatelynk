/**
 * IntercomCallService (Cloud) — orkiestracja sesji połączeń domofonowych
 * po stronie chmury. Projekt: docs/intercom-akuvox-call.md.
 *
 * Za flagą env INTERCOM_CALL_ENABLED (default false). Gdy off — `enabled`
 * zwraca false, a controller zwraca 503/skip. Nic z tego nie rusza produkcji.
 *
 * Odpowiedzialności (Faza B):
 *   • handleInvite()       — Edge zgłosił INTERCOM_CALL_INVITE → ROZWIĄŻ kogo
 *     wołać (routing D2: domofon→unit→residenci, fallback bridgeEnabled), utwórz
 *     sesję RINGING + VoIP push do mieszkańców + zazbrój timeout no-answer.
 *   • answer/decline/hangup — mieszkaniec działa z apki → CMD do Edge.
 *     answer() = first-answer-wins (D5) — pierwszy odbiera, reszta dostaje cancel.
 *   • relaySignalFromApp() — WebRTC offer/answer/ICE z apki → Edge.
 *   • handleEnded()        — Edge zgłosił INTERCOM_CALL_ENDED → zamknij sesję.
 *
 * Routing (D2): patrz `resolveResidentsForInvite`. Łańcuch z docs sekcja 6:
 *   BuildingIntercom.edgeDeviceId / StairwellIntercom → stairwell → units →
 *   unit_residents (aktywne okno) → residenci. Gdy przycisk mapuje unitId —
 *   tylko ten lokal. Brak mapy lokalu → fallback wszyscy residenci budynku
 *   z `bridgeEnabled` domofonem.
 *
 * State machine (sekcja 4): INCOMING→RINGING→ACTIVE→ENDED/MISSED.
 *   - RINGING ustawiany w handleInvite + timeout no-answer (RINGING_TIMEOUT_MS).
 *   - ACTIVE ustawiany przez answer() (atomowo, tylko gdy answeredById NULL).
 *   - timeout → MISSED + INTERCOM_CALL_DECLINE(reason TIMEOUT) do Edge.
 *
 * Relay do Edge idzie istniejącym tunelem (EdgeGateway.sendToBuilding /
 * sendCommand). Sygnalizacja w dół do apki (Edge→app) jest buforowana w
 * pamięci i wystawiana przez SSE w controllerze (patrz `drainSignals`).
 */
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import { PrismaService } from '../prisma/prisma.service'
import { PushService } from '../push/push.service'
import { EdgeGateway } from '../edge/edge.gateway'

// Ten sam pattern co ResidentAssistantController / ResidentService — Cloud na
// Fly.io chodzi przez tailscaled userspace HTTP proxy na localhost:1055.
const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

export interface IntercomInvitePayload {
  sessionId: string
  intercomDeviceId?: string
  intercomName?: string
  unitId?: number
  unitLabel?: string
  /** Lista przekazana przez Edge — zwykle pusta; Cloud rozwiązuje sam (routing D2). */
  residentIds: number[]
  snapshotUrl?: string
  /**
   * Opcjonalny hint przycisku panelu (np. SIP extension / relayIndex zmapowany
   * na konkretny lokal). Gdy Edge to przekaże, zawęża routing do tego unitId.
   */
  buttonUnitId?: number
  /**
   * Numer wybrany z książki adresowej Akuvoxa (Remote Phonebook) = user-part
   * SIP To (np. "4"). Cloud mapuje go na `units.number` w budynku → routing
   * punktowy do mieszkańców tego lokalu. Pusty przy zbiorczym przycisku.
   */
  dialedExtension?: string
}

export interface IntercomSignal {
  sessionId: string
  kind: 'offer' | 'answer' | 'ice'
  sdp?: string
  candidate?: Record<string, unknown>
  from: 'edge' | 'app'
}

/** Wynik rozwiązania routingu — kogo wołać + metadane snapshot do sesji/push. */
interface ResolvedTargets {
  residentIds: number[]
  unitId: number | null
  unitLabel: string | null
  /** Skąd wzięliśmy listę — log/diagnostyka. */
  via: 'button-unit' | 'intercom-unit' | 'building-intercom-units' | 'fallback-building' | 'edge-supplied'
}

@Injectable()
export class IntercomCallService implements OnModuleDestroy {
  private readonly logger = new Logger(IntercomCallService.name)

  // Bufor sygnalizacji Edge→app per sessionId. SSE w controllerze drenuje.
  // In-memory (jak today/day-summary cache) — przy multi-instance Cloud trzeba
  // by to przenieść do Redis/pubsub (OTWARTA DECYZJA D1). Dziś 1 instancja API.
  private readonly signalBuffer = new Map<string, IntercomSignal[]>()

  // Timery no-answer per sessionId (RINGING zbyt długo → MISSED). Czyszczone
  // przy answer/decline/hangup/ended. Trzymane w pamięci — restart Cloud
  // anuluje (sesja zostanie zamknięta przez Edge BYE / ręczny sweep). Patrz
  // `RINGING_TIMEOUT_MS`.
  private readonly ringTimers = new Map<string, NodeJS.Timeout>()

  /** Ile czekamy na odebranie zanim oznaczymy MISSED (sekcja 4 / Faza D). */
  private static readonly RINGING_TIMEOUT_MS = 35_000

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly edgeGateway: EdgeGateway,
  ) {}

  onModuleDestroy() {
    for (const t of this.ringTimers.values()) clearTimeout(t)
    this.ringTimers.clear()
  }

  /** Master feature-flag. Controller i EdgeGateway sprawdzają to zanim cokolwiek zrobią. */
  get enabled(): boolean {
    return process.env.INTERCOM_CALL_ENABLED === 'true'
  }

  // ── Edge → Cloud: przychodzące wywołanie ──────────────────────────────────
  /**
   * Akuvox zadzwonił; Edge przekazał intercomDeviceId (+ ewentualny przycisk).
   * Tu: rozwiązujemy kogo wołać (routing D2), tworzymy sesję RINGING, wysyłamy
   * VoIP push do każdego mieszkańca i zazbrajamy timeout no-answer.
   */
  async handleInvite(buildingId: number, p: IntercomInvitePayload): Promise<void> {
    if (!this.enabled) return
    if (!p?.sessionId) {
      this.logger.warn(`handleInvite [b#${buildingId}]: brak sessionId — ignoruję`)
      return
    }

    // ── Routing D2 ──────────────────────────────────────────────────────────
    // Gdy Edge dostarczył residentIds (np. starszy build albo własny lookup) —
    // honorujemy je. W przeciwnym razie rozwiązujemy z DB.
    let resolved: ResolvedTargets
    if (Array.isArray(p.residentIds) && p.residentIds.length > 0) {
      resolved = {
        residentIds: p.residentIds,
        unitId: p.unitId ?? null,
        unitLabel: p.unitLabel ?? null,
        via: 'edge-supplied',
      }
    } else {
      resolved = await this.resolveResidentsForInvite(buildingId, p).catch((err: Error) => {
        this.logger.error(`routing D2 failed [b#${buildingId}] session=${p.sessionId}: ${err.message}`)
        return { residentIds: [], unitId: p.unitId ?? null, unitLabel: p.unitLabel ?? null, via: 'fallback-building' as const }
      })
    }

    const intercomName = p.intercomName ?? (await this.resolveIntercomName(p.intercomDeviceId))
    const unitLabel = resolved.unitLabel ?? p.unitLabel ?? null

    await this.prisma.intercomCallSession.upsert({
      where: { id: p.sessionId },
      create: {
        id: p.sessionId,
        buildingId,
        intercomDeviceId: p.intercomDeviceId ?? null,
        intercomName: intercomName ?? null,
        unitId: resolved.unitId ?? null,
        unitLabel,
        state: 'RINGING',
        ringingAt: new Date(),
        meta: {
          ...(p.snapshotUrl ? { snapshotUrl: p.snapshotUrl } : {}),
          routedVia: resolved.via,
          residentCount: resolved.residentIds.length,
        },
      },
      update: { state: 'RINGING', ringingAt: new Date() },
    })

    this.logger.log(
      `INVITE [b#${buildingId}] session=${p.sessionId} device=${p.intercomDeviceId} ` +
        `unit=${unitLabel ?? '?'} via=${resolved.via} → ${resolved.residentIds.length} resident(s)`,
    )

    // Brak adresatów — od razu MISSED (NO_DEVICE / brak mieszkańców), Edge
    // dostaje DECLINE żeby zamknąć SIP leg.
    if (resolved.residentIds.length === 0) {
      this.logger.warn(`INVITE session=${p.sessionId}: brak mieszkańców do zawołania → MISSED`)
      await this.markMissed(p.sessionId, buildingId, 'NO_DEVICE')
      return
    }

    // VoIP push do każdego mieszkańca — budzi apkę → CallKit.
    for (const residentId of resolved.residentIds) {
      this.push
        .sendVoipToResident(residentId, {
          type: 'intercom_call',
          sessionId: p.sessionId,
          intercomName: intercomName ?? 'Domofon',
          unitLabel: unitLabel ?? '',
          snapshotUrl: p.snapshotUrl ?? '',
          hasVideo: true,
        })
        .catch((err: Error) =>
          this.logger.warn(`VoIP push failed resident=${residentId}: ${err.message}`),
        )
    }

    // Timeout no-answer — RINGING zbyt długo → MISSED + hangup w bridge.
    this.armRingTimeout(p.sessionId, buildingId)
  }

  /**
   * Routing D2 (deterministyczny). Zwraca listę residentId do zawołania +
   * snapshot unitId/unitLabel do sesji. Łańcuch (docs sekcja 6):
   *
   *   1. Jeśli przycisk mapuje konkretny unitId (`buttonUnitId`/`unitId`) →
   *      tylko aktywni mieszkańcy tego lokalu.
   *   2. Inaczej z intercomDeviceId → BuildingIntercom (per-budynek) LUB
   *      StairwellIntercom (per-klatka):
   *        • StairwellIntercom → stairwell.units → ich mieszkańcy.
   *        • BuildingIntercom (brama główna) → wszyscy mieszkańcy budynku.
   *   3. Fallback (brak dopasowania domofonu / brak mapy) → wszyscy mieszkańcy
   *      budynku, o ile JAKIKOLWIEK domofon ma bridgeEnabled=true (bezpiecznik:
   *      bez aktywnego mostu nie wołamy nikogo).
   *
   * Wszystko raw SQL z aktywnym oknem unit_residents (untilDate IS NULL OR
   * > NOW()) — spójnie z `collectPlateSyncItems` / access-events.
   */
  private async resolveResidentsForInvite(
    buildingId: number,
    p: IntercomInvitePayload,
  ): Promise<ResolvedTargets> {
    // ── 0. Numer z książki Akuvoxa (Remote Phonebook) → konkretny lokal ──────
    // Gość dotknął kontaktu → Akuvox dzwoni na "<unit.number>@<host>" →
    // toExtension = numer lokalu. Mapujemy go na units.number w budynku.
    let dialedUnitId: number | null = null
    const ext = (p.dialedExtension ?? '').trim()
    if (ext) {
      // Książka Akuvoxa wybiera `unit.id` (czysty int). Próbujemy id, potem
      // `unit.number` (gdyby ktoś skonfigurował numeryczne numery lokali).
      if (/^\d+$/.test(ext)) {
        const byId = await this.prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM "units" WHERE "buildingId" = ${buildingId} AND id = ${Number(ext)} LIMIT 1
        `
        if (byId[0]) dialedUnitId = byId[0].id
      }
      if (dialedUnitId == null) {
        const byNum = await this.prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM "units" WHERE "buildingId" = ${buildingId} AND "number" = ${ext} LIMIT 1
        `
        if (byNum[0]) dialedUnitId = byNum[0].id
      }
      if (dialedUnitId == null) {
        this.logger.warn(`INVITE: dialedExtension="${ext}" nie pasuje do lokalu [b#${buildingId}]`)
      }
    }

    const targetUnitId = p.buttonUnitId ?? p.unitId ?? dialedUnitId

    // ── 1. Przycisk → konkretny lokal ────────────────────────────────────────
    if (targetUnitId != null) {
      const unit = await this.prisma.$queryRaw<
        { id: number; number: string; stairwellName: string | null }[]
      >`
        SELECT u.id, u.number, s.name AS "stairwellName"
          FROM "units" u
          LEFT JOIN "stairwells" s ON s.id = u."stairwellId"
         WHERE u.id = ${targetUnitId} AND u."buildingId" = ${buildingId}
         LIMIT 1
      `
      const residentIds = await this.residentsForUnits([targetUnitId])
      const label = unit[0]
        ? (unit[0].stairwellName ? `${unit[0].stairwellName}/${unit[0].number}` : unit[0].number)
        : (p.unitLabel ?? null)
      return { residentIds, unitId: targetUnitId, unitLabel: label, via: 'button-unit' }
    }

    // ── 2. intercomDeviceId → klatka / budynek ───────────────────────────────
    const deviceId = p.intercomDeviceId ?? null
    if (deviceId) {
      // StairwellIntercom — link przez stairwell_intercoms.* (driver/config).
      // StairwellIntercom NIE ma edgeDeviceId; link panel↔urządzenie idzie przez
      // config (driverId blob). Najpewniejszy deterministyczny link to
      // BuildingIntercom.edgeDeviceId. Sprawdzamy go najpierw.
      const bi = await this.prisma.$queryRaw<
        { id: number; name: string; bridgeEnabled: boolean }[]
      >`
        SELECT id, name, "bridgeEnabled"
          FROM "building_intercoms"
         WHERE "buildingId" = ${buildingId} AND "edgeDeviceId" = ${deviceId}
         LIMIT 1
      `
      if (bi[0]) {
        if (!bi[0].bridgeEnabled) {
          this.logger.warn(
            `INVITE: domofon ${deviceId} (BuildingIntercom#${bi[0].id}) ma bridgeEnabled=false — pomijam`,
          )
          return { residentIds: [], unitId: null, unitLabel: null, via: 'building-intercom-units' }
        }
        // BuildingIntercom = brama główna / panel zbiorczy → wszyscy mieszkańcy
        // budynku (z aktywnym oknem). Nazwa panelu jako snapshot.
        const residentIds = await this.residentsForBuilding(buildingId)
        return {
          residentIds,
          unitId: null,
          unitLabel: null,
          via: 'building-intercom-units',
        }
      }

      // StairwellIntercom — domofon klatkowy. Link panel→urządzenie żyje w
      // stairwell_intercoms.config (driver blob). Dopasowujemy po config->>'edgeDeviceId'
      // gdy dostępne; inaczej spada do fallbacku poniżej.
      const si = await this.prisma.$queryRaw<{ stairwellId: number }[]>`
        SELECT "stairwellId"
          FROM "stairwell_intercoms"
         WHERE config ->> 'edgeDeviceId' = ${deviceId}
           AND "stairwellId" IN (SELECT id FROM "stairwells" WHERE "buildingId" = ${buildingId})
         LIMIT 1
      `
      if (si[0]) {
        const units = await this.prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM "units" WHERE "stairwellId" = ${si[0].stairwellId}
        `
        const residentIds = await this.residentsForUnits(units.map((u) => u.id))
        return { residentIds, unitId: null, unitLabel: null, via: 'intercom-unit' }
      }
    }

    // ── 3. Fallback: wszyscy mieszkańcy budynku, jeśli most aktywny ───────────
    const anyBridge = await this.prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*)::bigint AS cnt
        FROM "building_intercoms"
       WHERE "buildingId" = ${buildingId} AND "bridgeEnabled" = TRUE
    `
    if (Number(anyBridge[0]?.cnt ?? 0n) === 0) {
      this.logger.warn(
        `INVITE [b#${buildingId}]: brak domofonu z bridgeEnabled=true — fallback pusty`,
      )
      return { residentIds: [], unitId: null, unitLabel: null, via: 'fallback-building' }
    }
    const residentIds = await this.residentsForBuilding(buildingId)
    return { residentIds, unitId: null, unitLabel: null, via: 'fallback-building' }
  }

  /** Aktywni mieszkańcy danych lokali (okno unit_residents otwarte). */
  private async residentsForUnits(unitIds: number[]): Promise<number[]> {
    if (unitIds.length === 0) return []
    const rows = await this.prisma.$queryRaw<{ residentId: number }[]>`
      SELECT DISTINCT ur."residentId"
        FROM "unit_residents" ur
       WHERE ur."unitId" = ANY(${unitIds}::int[])
         AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
    `
    return rows.map((r) => r.residentId)
  }

  /** Wszyscy mieszkańcy budynku z aktywnym przypisaniem do jakiegokolwiek lokalu. */
  private async residentsForBuilding(buildingId: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<{ residentId: number }[]>`
      SELECT DISTINCT ur."residentId"
        FROM "unit_residents" ur
        JOIN "units" u ON u.id = ur."unitId"
       WHERE u."buildingId" = ${buildingId}
         AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
    `
    return rows.map((r) => r.residentId)
  }

  /** Snapshot nazwy panelu z BuildingIntercom (gdy Edge jej nie podał). */
  private async resolveIntercomName(deviceId?: string): Promise<string | null> {
    if (!deviceId) return null
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT name FROM "building_intercoms" WHERE "edgeDeviceId" = ${deviceId} LIMIT 1
    `
    return rows[0]?.name ?? null
  }

  // ── App → Edge: akcje mieszkańca ──────────────────────────────────────────
  /**
   * Mieszkaniec odebrał. First-answer-wins (D5): atomowy updateMany ustawia
   * answeredById TYLKO gdy puste — zwracana liczba wierszy mówi czy to my
   * wygraliśmy. Jeśli ktoś już odebrał (count=0), wysyłamy temu urządzeniu
   * sygnał `cancel` (CallKit-end), bez ANSWER do Edge.
   */
  async answer(sessionId: string, residentId: number, buildingId: number): Promise<{ won: boolean }> {
    if (!this.enabled) return { won: false }
    const res = await this.prisma.intercomCallSession.updateMany({
      where: { id: sessionId, answeredById: null, state: { in: ['INCOMING', 'RINGING'] } },
      data: { state: 'ACTIVE', answeredById: residentId, answeredAt: new Date() },
    })
    if (res.count === 0) {
      // Ktoś inny już odebrał (lub sesja zakończona) — to urządzenie ma zakończyć
      // CallKit. Buforujemy `cancel` do SSE; iOS kończy połączenie lokalnie.
      this.logger.log(`ANSWER session=${sessionId} resident=${residentId} — przegrane (już odebrane)`)
      this.bufferCancelForApp(sessionId, 'ALREADY_ANSWERED')
      return { won: false }
    }
    this.clearRingTimeout(sessionId)
    await this.edgeGateway.sendToBuilding(buildingId, 'INTERCOM_CALL_ANSWER', { sessionId, residentId })
    this.logger.log(`ANSWER session=${sessionId} resident=${residentId} — wygrane (ACTIVE)`)
    return { won: true }
  }

  /**
   * Rejestr stacji dostępnych do połączenia wychodzącego: wszystkie domofony
   * budynku z aktywnym mostem (`bridgeEnabled=true` + `edgeDeviceId`).
   * Zwracane iOS-owi przez GET /resident/intercom/stations — apka pokazuje
   * wybór gdy stacji jest więcej niż jedna.
   */
  async listStations(
    buildingId: number,
  ): Promise<{ id: number; name: string; edgeDeviceId: string }[]> {
    if (!this.enabled) return []
    const rows = await this.prisma.$queryRaw<
      { id: number; name: string | null; edgeDeviceId: string }[]
    >`
      SELECT id, name, "edgeDeviceId"
        FROM "building_intercoms"
       WHERE "buildingId" = ${buildingId}
         AND "bridgeEnabled" = TRUE
         AND "edgeDeviceId" IS NOT NULL
       ORDER BY id ASC`
    return rows.map((r) => ({ id: r.id, name: r.name ?? 'Domofon', edgeDeviceId: r.edgeDeviceId }))
  }

  /**
   * Połączenie WYCHODZĄCE: mieszkaniec dzwoni do stacji domofonowej (podgląd
   * bramy + rozmowa). Multi-station (2026-07-05): opcjonalny `intercomId`
   * wybiera KTÓRĄ stację wołamy. Bez niego: 1 stacja z mostem = jak dotąd
   * (backward-compat ze starą apką), >1 = 400 z kodem STATION_CHOICE_REQUIRED
   * + listą stacji (nowa apka i tak pobiera GET /stations i wysyła intercomId).
   *
   * Tworzymy sesję i zlecamy Edge `INTERCOM_CALL_STATION`. Apka następnie
   * wyśle swój WebRTC offer zwykłym kanałem INTERCOM_SIGNAL; Janus zadzwoni
   * do Akuvoxa (Auto Answer odbierze), a answer wróci przez SSE.
   */
  async callStation(
    residentId: number,
    buildingId: number,
    intercomId?: number,
  ): Promise<{ sessionId: string; intercomName: string; intercomId: number }> {
    if (!this.enabled) {
      throw new BadRequestException('Połączenia domofonowe są wyłączone')
    }
    // Cloud NIE zna LAN-IP Akuvoxa (`building_intercoms.ipAddress` bywa NULL —
    // IP żyje w rejestrze urządzeń na Edge). Wybieramy domofon z mostkiem po
    // `edgeDeviceId`; Edge sam rozwiąże IP z device-config (fallback do jedynego
    // INTERCOM). Patrz lekcja w pamięci: operacje na urządzeniu → deleguj do Edge.
    const stations = await this.listStations(buildingId)
    if (stations.length === 0) {
      throw new BadRequestException('Brak skonfigurowanej stacji domofonowej w tym budynku')
    }

    let station: { id: number; name: string; edgeDeviceId: string } | undefined
    if (intercomId != null) {
      station = stations.find((s) => s.id === intercomId)
      if (!station) {
        throw new BadRequestException({
          message: 'Wybrana stacja nie istnieje albo nie ma aktywnego mostu',
          code: 'STATION_NOT_FOUND',
          stations: stations.map((s) => ({ id: s.id, name: s.name })),
        })
      }
    } else if (stations.length === 1) {
      station = stations[0]
    } else {
      // >1 stacja i brak wyboru — nie dzwonimy „w ciemno". Apka dostaje listę
      // (w body błędu ORAZ przez GET /stations) i ponawia z intercomId.
      throw new BadRequestException({
        message: 'W budynku jest kilka stacji — wybierz do której dzwonisz',
        code: 'STATION_CHOICE_REQUIRED',
        stations: stations.map((s) => ({ id: s.id, name: s.name })),
      })
    }

    // ── Busy-guard (równoległość) ────────────────────────────────────────────
    // Janus SIP plugin na Edge ma dziś JEDEN handle (= 1 aktywne połączenie na
    // budynek). Druga rozmowa — z dowolnej stacji — zderzyłaby się w moście,
    // więc odrzucamy z czytelnym komunikatem. Okno 10 min chroni przed wiecznym
    // blokowaniem przez osieroconą sesję ACTIVE (crash Edge bez ENDED).
    const busy = await this.prisma.intercomCallSession.findFirst({
      where: {
        buildingId,
        state: { in: ['INCOMING', 'RINGING', 'ACTIVE'] },
        startedAt: { gt: new Date(Date.now() - 10 * 60_000) },
      },
      select: { id: true, state: true, intercomName: true },
    })
    if (busy) {
      throw new ConflictException({
        message: `Stacja zajęta — trwa inne połączenie (${busy.intercomName ?? 'domofon'})`,
        code: 'STATION_BUSY',
      })
    }

    const sessionId = randomUUID()
    const intercomName = station.name
    await this.prisma.intercomCallSession.create({
      data: {
        id: sessionId,
        buildingId,
        intercomDeviceId: station.edgeDeviceId,
        intercomName,
        state: 'ACTIVE',
        ringingAt: new Date(),
        answeredById: residentId,
        answeredAt: new Date(),
        meta: {
          direction: 'OUTBOUND',
          initiatedBy: residentId,
          edgeDeviceId: station.edgeDeviceId,
          intercomId: station.id,
        },
      },
    })
    await this.edgeGateway.sendToBuilding(buildingId, 'INTERCOM_CALL_STATION', {
      sessionId,
      intercomDeviceId: station.edgeDeviceId,
      intercomId: station.id,
    })
    this.logger.log(
      `CALL_STATION [b#${buildingId}] resident=${residentId} → intercom#${station.id} ` +
        `device=${station.edgeDeviceId} session=${sessionId}`,
    )
    return { sessionId, intercomName, intercomId: station.id }
  }

  /** Odrzucenie z apki. Edge wysyła SIP reject/BYE. */
  async decline(sessionId: string, residentId: number, buildingId: number): Promise<void> {
    if (!this.enabled) return
    this.clearRingTimeout(sessionId)
    // Odrzucenie przez JEDNO urządzenie nie kończy sesji dla pozostałych — Edge
    // dostanie DECLINE i sam zdecyduje (przy 1 mieszkańcu = BYE). Stan na MISSED
    // dopiero po timeout/wszystkich-decline; tu tylko notyfikujemy Edge.
    await this.edgeGateway.sendToBuilding(buildingId, 'INTERCOM_CALL_DECLINE', { sessionId, residentId })
    this.logger.log(`DECLINE session=${sessionId} resident=${residentId}`)
  }

  /** Rozłączenie aktywnego połączenia z apki. */
  async hangup(sessionId: string, buildingId: number): Promise<void> {
    if (!this.enabled) return
    this.clearRingTimeout(sessionId)
    await this.edgeGateway.sendToBuilding(buildingId, 'INTERCOM_CALL_HANGUP', { sessionId, by: 'app' })
    this.logger.log(`HANGUP session=${sessionId} (by app)`)
  }

  /** WebRTC offer/answer/ICE z apki → Edge (do Janusa). */
  async relaySignalFromApp(buildingId: number, signal: IntercomSignal): Promise<void> {
    if (!this.enabled) return
    await this.edgeGateway.sendToBuilding(buildingId, 'INTERCOM_SIGNAL', { ...signal, from: 'app' })
  }

  // ── Edge → Cloud: sygnalizacja w dół (answer/ICE) + koniec ────────────────
  /** Edge przysłał WebRTC signal do apki. Buforujemy; SSE w controllerze drenuje. */
  bufferSignalForApp(signal: IntercomSignal): void {
    if (!this.enabled) return
    const buf = this.signalBuffer.get(signal.sessionId) ?? []
    buf.push({ ...signal, from: 'edge' })
    this.signalBuffer.set(signal.sessionId, buf)
  }

  /**
   * Specjalny sygnał `cancel` — pozostałe urządzenia (D5) lub timeout. Nie jest
   * to WebRTC offer/answer/ice, więc niesiemy go w polu candidate.reason. iOS
   * po odebraniu kończy CallKit (CXEndCallAction).
   */
  private bufferCancelForApp(sessionId: string, reason: string): void {
    const buf = this.signalBuffer.get(sessionId) ?? []
    // kind='ice' z candidate.cancel — iOS rozpoznaje cancel po candidate.cancel===true.
    buf.push({ sessionId, kind: 'ice', candidate: { cancel: true, reason }, from: 'edge' })
    this.signalBuffer.set(sessionId, buf)
  }

  /** SSE: pobierz i wyczyść zbuforowane sygnały dla sesji. */
  drainSignals(sessionId: string): IntercomSignal[] {
    const buf = this.signalBuffer.get(sessionId)
    if (!buf || buf.length === 0) return []
    this.signalBuffer.set(sessionId, [])
    return buf
  }

  /** Edge zgłosił koniec. Zamknij sesję + (TODO Faza D) wpis access_events INTERCOM_CALL. */
  async handleEnded(sessionId: string, endReason: string): Promise<void> {
    if (!this.enabled) return
    this.clearRingTimeout(sessionId)
    await this.prisma.intercomCallSession
      .update({
        where: { id: sessionId },
        data: { state: 'ENDED', endedAt: new Date(), endReason: endReason || 'ANSWERED_HANGUP' },
      })
      .catch(() => {
        /* sesja mogła nie istnieć — ignoruj */
      })
    // Zostawiamy bufor cancel jeszcze chwilę dla SSE pozostałych urządzeń —
    // ale czyścimy po krótkim czasie żeby nie ciekła pamięć. Powód przekazujemy
    // 1:1 (np. STATION_BUSY z Edge) — iOS pokazuje czytelny komunikat.
    this.bufferCancelForApp(sessionId, endReason || 'ENDED')
    setTimeout(() => this.signalBuffer.delete(sessionId), 5_000)
    this.logger.log(`ENDED session=${sessionId} reason=${endReason}`)
    // TODO Faza D: zapisz AccessEvent typu INTERCOM_CALL (enum już istnieje),
    // gateOpened=false, residentId=answeredById. Statystyki połączeń w BA panelu.
  }

  // ── State machine: timeout no-answer (RINGING → MISSED) ────────────────────
  /** Zazbrój timer no-answer dla dzwoniącej sesji. Idempotentne (resetuje stary). */
  private armRingTimeout(sessionId: string, buildingId: number): void {
    this.clearRingTimeout(sessionId)
    const t = setTimeout(() => {
      this.ringTimers.delete(sessionId)
      this.markMissed(sessionId, buildingId, 'TIMEOUT').catch((err: Error) =>
        this.logger.warn(`markMissed(timeout) session=${sessionId} failed: ${err.message}`),
      )
    }, IntercomCallService.RINGING_TIMEOUT_MS)
    // unref żeby pojedynczy dzwoniący timer nie trzymał procesu przy zamykaniu.
    if (typeof t.unref === 'function') t.unref()
    this.ringTimers.set(sessionId, t)
  }

  private clearRingTimeout(sessionId: string): void {
    const t = this.ringTimers.get(sessionId)
    if (t) {
      clearTimeout(t)
      this.ringTimers.delete(sessionId)
    }
  }

  /**
   * Oznacz sesję jako MISSED (timeout / brak urządzeń) — tylko gdy jeszcze
   * RINGING/INCOMING (nie nadpisujemy ACTIVE gdy ktoś zdążył odebrać). Wysyła
   * DECLINE do Edge (zamknięcie SIP leg) i cancel do urządzeń (CallKit-end).
   */
  private async markMissed(sessionId: string, buildingId: number, reason: string): Promise<void> {
    const res = await this.prisma.intercomCallSession.updateMany({
      where: { id: sessionId, state: { in: ['INCOMING', 'RINGING'] } },
      data: { state: 'MISSED', endedAt: new Date(), endReason: reason },
    })
    if (res.count === 0) return // ktoś odebrał w międzyczasie — nic nie robimy
    await this.edgeGateway
      .sendToBuilding(buildingId, 'INTERCOM_CALL_DECLINE', { sessionId, reason })
      .catch(() => {/* Edge offline — Edge i tak dostanie BYE od Akuvoxa */})
    this.bufferCancelForApp(sessionId, reason)
    setTimeout(() => this.signalBuffer.delete(sessionId), 5_000)
    this.logger.log(`MISSED session=${sessionId} reason=${reason}`)
  }

  // ── Hybrydowe wideo: proxy snapshotu kamery Akuvox dla sesji ───────────────
  /**
   * Proxy live snapshotu kamery panelu Akuvox dla aktywnej sesji → image/jpeg.
   * Hybrydowe wideo (docs/intercom-akuvox-call.md). iOS polluje to w trakcie
   * połączenia bo WebRTC-wideo Akuvoxa nie działa.
   *
   * Walidujemy że sesja należy do budynku mieszkańca (tenant guard), rozwiązujemy
   * Edge IP (live WS → DB fallback, jak `ResidentService.pipeSnapshot`) i
   * proxujemy undici przez TS do Edge `/assistant/intercom-snapshot?session=:id`.
   * Każdy „pusty" przypadek (sesja zakończona, brak Edge, Edge 204/błąd) →
   * 204 zamiast 5xx, żeby iOS pokazał ostatnią klatkę / placeholder bez błędu.
   */
  async pipeSnapshot(
    sessionId: string,
    buildingId: number,
    res: import('express').Response,
    opts?: { w?: number; q?: number },
  ): Promise<void> {
    if (!this.enabled) {
      res.status(204).end()
      return
    }

    const session = await this.prisma.intercomCallSession.findFirst({
      where: { id: sessionId, buildingId },
      select: { id: true, state: true },
    })
    // Sesja nie istnieje / inny budynek / już zakończona → nic do pokazania.
    if (!session || !['INCOMING', 'RINGING', 'ACTIVE'].includes(session.state)) {
      res.status(204).end()
      return
    }

    // Edge IP: live WS najpierw, DB fallback (spójnie z ResidentService).
    let ip: string | undefined = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      const edge = await this.prisma.edgeDevice.findFirst({
        where: { buildingId, isActivated: true },
        orderBy: { lastSeenAt: 'desc' },
      })
      ip = edge?.ipAddress ?? undefined
    }
    if (!ip) {
      res.status(204).end()
      return
    }

    try {
      // Przekazujemy parametry skalowania (w=szerokość, q=jakość JPEG) do Edge —
      // Edge skaluje klatkę PRZED wysłaniem przez tunel/LTE (iOS dobiera je pod sieć).
      const sizeParams =
        (opts?.w ? `&w=${opts.w}` : '') + (opts?.q ? `&q=${opts.q}` : '')
      const edgeUrl = `http://${ip}:4000/assistant/intercom-snapshot?session=${encodeURIComponent(sessionId)}${sizeParams}`
      const edgeRes = await undiciFetch(edgeUrl, {
        dispatcher: edgeDispatcher,
        signal: AbortSignal.timeout(5000),
      })
      // Edge zwraca 204 gdy brak kadru / urządzenia — przepuszczamy 204.
      if (edgeRes.status === 204 || !edgeRes.ok) {
        res.status(204).end()
        return
      }
      const buf = Buffer.from(await edgeRes.arrayBuffer())
      if (buf.length === 0) {
        res.status(204).end()
        return
      }
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'no-store, no-cache')
      res.setHeader('Content-Length', buf.length)
      res.end(buf)
    } catch (err: any) {
      // Live obraz — pojedynczy fail nie jest błędem dla usera (kolejny poll
      // spróbuje znowu). 204 zamiast 502.
      this.logger.debug(`intercom snapshot proxy failed session=${sessionId}: ${err?.message}`)
      res.status(204).end()
    }
  }

  /**
   * Otwiera elektrozaczep domofonu z którego dzwoni gość — przycisk „Otwórz".
   * UWAGA: `session.intercomDeviceId` to SIP URI/extension (to co Edge wysłał
   * w INVITE), NIE UUID urządzenia — dlatego Cloud NIE rozwiązuje AP sam.
   * Proxujemy do Edge `/assistant/intercom-open?session=:id`, a Edge mapuje
   * sesję→domofon (`resolveAkuvoxDeviceIdForSession`) i wyzwala relay 0.
   * Działa w INCOMING/RINGING/ACTIVE (można wpuścić bez odbierania).
   */
  async openDoorForSession(
    sessionId: string,
    buildingId: number,
    residentId: number,
  ): Promise<{ success: boolean }> {
    const session = await this.prisma.intercomCallSession.findFirst({
      where: { id: sessionId, buildingId },
      select: { id: true, state: true },
    })
    if (!session || !['INCOMING', 'RINGING', 'ACTIVE'].includes(session.state)) {
      throw new BadRequestException('Połączenie nie jest już aktywne')
    }

    // Edge IP: live WS najpierw, DB fallback (jak pipeSnapshot).
    let ip: string | undefined = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (!ip) {
      const edge = await this.prisma.edgeDevice.findFirst({
        where: { buildingId, isActivated: true },
        orderBy: { lastSeenAt: 'desc' },
      })
      ip = edge?.ipAddress ?? undefined
    }
    if (!ip) throw new BadGatewayException('Brak połączenia z bramką — spróbuj ponownie')

    const edgeUrl = `http://${ip}:4000/assistant/intercom-open?session=${encodeURIComponent(sessionId)}`
    const res = await undiciFetch(edgeUrl, {
      method: 'POST',
      dispatcher: edgeDispatcher,
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      this.logger.warn(`intercom open session=${sessionId} → Edge HTTP ${res.status}`)
      throw new BadGatewayException('Nie udało się otworzyć (bramka)')
    }
    this.logger.log(`intercom open session=${sessionId} by resident=${residentId} → OK`)
    return { success: true }
  }

  /** Aktywne/dzwoniące sesje mieszkańca — fallback gdy VoIP push zgubiony. */
  async listActiveForResident(buildingId: number) {
    if (!this.enabled) return []
    return this.prisma.intercomCallSession.findMany({
      where: { buildingId, state: { in: ['INCOMING', 'RINGING', 'ACTIVE'] } },
      orderBy: { startedAt: 'desc' },
      take: 10,
    })
  }
}
