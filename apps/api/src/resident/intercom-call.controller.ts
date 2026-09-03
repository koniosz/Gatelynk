/**
 * IntercomCallController (Cloud, resident) — endpointy połączeń domofonowych
 * dla aplikacji iOS. Projekt: docs/intercom-akuvox-call.md.
 *
 * Cała funkcja za flagą INTERCOM_CALL_ENABLED — gdy off, każdy endpoint
 * zwraca 503 (zob. `assertEnabled`). Guard jwt-resident jak reszta resident
 * API; buildingId/residentId bierzemy z JWT (multi-building user wybiera
 * budynek przy logowaniu).
 *
 * Sygnalizacja w dół (Edge→app: answer/ICE) idzie przez SSE
 * (`GET .../signal/stream`) — spójnie z resztą resident API (HTTPS, bez
 * dodatkowego WS po stronie klienta). Patrz decyzja D1 w docs.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import type { Request, Response } from 'express'
import { interval, map, merge, Observable, of } from 'rxjs'
import { PushService } from '../push/push.service'
import { IntercomCallService, type IntercomSignal } from './intercom-call.service'
import { TurnCredentialsService } from './turn-credentials.service'

interface AuthReq extends Request {
  user: { id: number; email: string; buildingId: number; residentId: number }
}

@Controller('resident/intercom')
export class IntercomCallController {
  private readonly logger = new Logger(IntercomCallController.name)

  constructor(
    private readonly calls: IntercomCallService,
    private readonly push: PushService,
    private readonly turn: TurnCredentialsService,
  ) {}

  private assertEnabled() {
    if (!this.calls.enabled) {
      throw new ServiceUnavailableException(
        'Połączenia domofonowe są wyłączone (INTERCOM_CALL_ENABLED=false)',
      )
    }
  }

  /**
   * POST /api/resident/intercom/voip-token
   * Rejestracja VoIP (PushKit) tokenu — osobny kanał od zwykłego push.
   */
  @Post('voip-token')
  @UseGuards(AuthGuard('jwt-resident'))
  async registerVoipToken(
    @Body() body: {
      token: string
      environment?: 'production' | 'development'
      // 2026-07-15 — bundle apki; topic VoIP = <bundle>.voip per token.
      bundleId?: string
    },
    @Req() req: AuthReq,
  ) {
    this.assertEnabled()
    if (!body?.token) throw new BadRequestException('Missing "token"')
    return this.push.registerVoipToken(
      req.user.residentId, body.token, body.environment ?? 'production', body.bundleId,
    )
  }

  /** GET /api/resident/intercom/calls/active — fallback gdy push zgubiony. */
  @Get('calls/active')
  @UseGuards(AuthGuard('jwt-resident'))
  async active(@Req() req: AuthReq) {
    this.assertEnabled()
    return this.calls.listActiveForResident(req.user.buildingId)
  }

  /**
   * GET /api/resident/intercom/stations
   * Rejestr stacji z aktywnym mostem (multi-station, 2026-07-05). Apka pobiera
   * przed połączeniem wychodzącym: >1 stacja → pokazuje wybór z nazwami
   * („Wejście główne", „Brama wschodnia"...), potem POST call-station z
   * `intercomId`. Stara apka nie woła tego endpointu — przy 1 stacji
   * call-station działa jak dotąd.
   */
  @Get('stations')
  @UseGuards(AuthGuard('jwt-resident'))
  async stations(@Req() req: AuthReq) {
    this.assertEnabled()
    const stations = await this.calls.listStations(req.user.buildingId)
    return { stations: stations.map((s) => ({ id: s.id, name: s.name })) }
  }

  /**
   * GET /api/resident/intercom/calls/:id/ice-servers
   * Lista ICE servers (STUN publiczny + TURN z wygenerowanymi krótkożyciowymi
   * creds) dla WebRTC po stronie iOS. Wołane przy starcie WebRTC handshake
   * (CallManager.startWebRTC). Subject w TURN username = "<sessionId>-<residentId>"
   * (audyt po stronie coturn). Brak turnUrl/secretu → sam STUN (LAN działa,
   * off-site nie). Patrz D7 w docs.
   */
  @Get('calls/:id/ice-servers')
  @UseGuards(AuthGuard('jwt-resident'))
  async iceServers(@Param('id') id: string, @Req() req: AuthReq) {
    this.assertEnabled()
    const subject = `${id}-${req.user.residentId}`
    return this.turn.iceServersForBuilding(req.user.buildingId, subject)
  }

  /**
   * GET /api/resident/intercom/calls/:id/snapshot
   * Hybrydowe wideo (docs/intercom-akuvox-call.md): WebRTC-wideo Akuvoxa nie
   * działa, więc iOS pokazuje obraz gościa ze snapshotów kamery panelu. iOS
   * polluje ten endpoint co ~0.7-1.0 s w trakcie połączenia.
   *
   * Z sesji bierzemy buildingId → getEdgeIpForBuilding → proxy undici (TS) do
   * Edge `/assistant/intercom-snapshot?session=:id` → zwracamy image/jpeg.
   * Brak danych / sesja zakończona → 204 (iOS pokazuje ostatnią klatkę /
   * placeholder, bez błędu). Krótki timeout — to obraz live.
   */
  @Get('calls/:id/snapshot')
  @UseGuards(AuthGuard('jwt-resident'))
  async snapshot(
    @Param('id') id: string,
    @Req() req: AuthReq,
    @Res() res: Response,
    @Query('w') w?: string,
    @Query('q') q?: string,
  ) {
    this.assertEnabled()
    // w/q = preferowana szerokość i jakość JPEG (iOS dobiera pod WiFi/komórkę).
    const parseNum = (v?: string) => {
      const n = v ? Number.parseInt(v, 10) : NaN
      return Number.isFinite(n) ? n : undefined
    }
    await this.calls.pipeSnapshot(id, req.user.buildingId, res, {
      w: parseNum(w),
      q: parseNum(q),
    })
  }

  /**
   * POST /api/resident/intercom/calls/:id/open
   * Otwiera elektrozaczep domofonu z którego dzwoni gość (przycisk „Otwórz").
   * Działa w INCOMING/RINGING/ACTIVE — można wpuścić bez odbierania.
   */
  @Post('calls/:id/open')
  @UseGuards(AuthGuard('jwt-resident'))
  async open(@Param('id') id: string, @Req() req: AuthReq) {
    this.assertEnabled()
    return this.calls.openDoorForSession(id, req.user.buildingId, req.user.residentId)
  }

  /** POST /api/resident/intercom/calls/:id/answer */
  @Post('calls/:id/answer')
  @UseGuards(AuthGuard('jwt-resident'))
  async answer(@Param('id') id: string, @Req() req: AuthReq) {
    this.assertEnabled()
    // First-answer-wins (D5): `won=false` znaczy że ktoś inny już odebrał —
    // iOS dostanie sygnał cancel przez SSE i zakończy CallKit. Zwracamy
    // `won` żeby apka mogła od razu wiedzieć (bez czekania na SSE).
    const { won } = await this.calls.answer(id, req.user.residentId, req.user.buildingId)
    return { ok: true, sessionId: id, state: won ? 'ACTIVE' : 'TAKEN', won }
  }

  /**
   * POST /api/resident/intercom/call-station
   * Połączenie WYCHODZĄCE: mieszkaniec dzwoni do stacji domofonowej (podgląd
   * bramy + rozmowa). Zwraca `sessionId` — apka otwiera ekran połączenia jako
   * OFFERER (generuje WebRTC offer i wysyła przez calls/:id/signal).
   *
   * Multi-station: opcjonalne body `{ intercomId }` wybiera stację. Bez niego:
   * 1 stacja = jak dotąd; >1 = 400 STATION_CHOICE_REQUIRED z listą (patrz
   * GET /stations). Zajęty most = 409 STATION_BUSY.
   */
  @Post('call-station')
  @UseGuards(AuthGuard('jwt-resident'))
  async callStation(@Body() body: { intercomId?: number } | undefined, @Req() req: AuthReq) {
    this.assertEnabled()
    const rawId = body?.intercomId
    const intercomId =
      typeof rawId === 'number' && Number.isFinite(rawId) ? rawId : undefined
    const { sessionId, intercomName, intercomId: chosenId } = await this.calls.callStation(
      req.user.residentId,
      req.user.buildingId,
      intercomId,
    )
    return { ok: true, sessionId, intercomName, intercomId: chosenId, state: 'ACTIVE', role: 'caller' }
  }

  /** POST /api/resident/intercom/calls/:id/decline */
  @Post('calls/:id/decline')
  @UseGuards(AuthGuard('jwt-resident'))
  async decline(@Param('id') id: string, @Req() req: AuthReq) {
    this.assertEnabled()
    await this.calls.decline(id, req.user.residentId, req.user.buildingId)
    return { ok: true, sessionId: id, state: 'DECLINED' }
  }

  /** POST /api/resident/intercom/calls/:id/hangup */
  @Post('calls/:id/hangup')
  @UseGuards(AuthGuard('jwt-resident'))
  async hangup(@Param('id') id: string, @Req() req: AuthReq) {
    this.assertEnabled()
    await this.calls.hangup(id, req.user.buildingId)
    return { ok: true, sessionId: id, state: 'ENDED' }
  }

  /**
   * POST /api/resident/intercom/calls/:id/signal
   * WebRTC offer/answer/ICE z apki → Edge (Janus).
   */
  @Post('calls/:id/signal')
  @UseGuards(AuthGuard('jwt-resident'))
  async signal(
    @Param('id') id: string,
    @Body() body: { kind: 'offer' | 'answer' | 'ice'; sdp?: string; candidate?: Record<string, unknown> },
    @Req() req: AuthReq,
  ) {
    this.assertEnabled()
    if (!body?.kind || !['offer', 'answer', 'ice'].includes(body.kind)) {
      throw new BadRequestException('Invalid "kind" (offer|answer|ice)')
    }
    const sig: IntercomSignal = {
      sessionId: id,
      kind: body.kind,
      sdp: body.sdp,
      candidate: body.candidate,
      from: 'app',
    }
    await this.calls.relaySignalFromApp(req.user.buildingId, sig)
    return { ok: true }
  }

  /**
   * GET /api/resident/intercom/calls/:id/signal/stream  (Server-Sent Events)
   * Strumień sygnalizacji Edge→app (answer/ICE). iOS subskrybuje na czas
   * zestawiania WebRTC. Heartbeat co 15 s utrzymuje połączenie przez proxy.
   *
   * UWAGA: bufor sygnalizacji jest in-memory (1 instancja API). Multi-instance
   * wymaga pubsub (Redis) — patrz D1 w docs.
   */
  @Sse('calls/:id/signal/stream')
  @UseGuards(AuthGuard('jwt-resident'))
  signalStream(@Param('id') id: string): Observable<MessageEvent> {
    this.assertEnabled()
    // Co 500 ms drenujemy bufor sygnałów dla tej sesji; heartbeat co 15 s.
    const signals$ = interval(500).pipe(
      map(() => this.calls.drainSignals(id)),
      // Spłaszcz: emituj po jednym evencie per signal. (drainSignals zwraca
      // tablicę — gdy pusta, nie emitujemy nic poza heartbeatem niżej.)
      map((batch) => batch.map((s) => ({ data: s }) as MessageEvent)),
      // RxJS map zwraca tablicę MessageEvent[]; rozwijamy przez mergeMap-lite:
      // emitujemy jeden „batch" event z polem `signals` (iOS iteruje).
      map((events) => ({ data: { signals: events.map((e) => e.data) } }) as MessageEvent),
    )
    const heartbeat$ = interval(15_000).pipe(
      map(() => ({ data: { heartbeat: Date.now() } }) as MessageEvent),
    )
    return merge(of({ data: { ready: true, sessionId: id } } as MessageEvent), signals$, heartbeat$)
  }
}
