/**
 * JanusMediaBridge — implementacja MediaBridge przeciw Janus Gateway
 * (`janus.plugin.sip`) przez oficjalny HTTP long-poll transport.
 * Projekt: docs/intercom-akuvox-call.md, sekcja 3.
 *
 * ── Protokół Janus (HTTP) ────────────────────────────────────────────────────
 * Bazujemy na oficjalnym REST API Janusa (https://janus.conf.meetecho.com/docs/rest):
 *
 *   1. POST  <base>                 { janus:'create' }                → session_id
 *   2. POST  <base>/<session>       { janus:'attach', plugin:'janus.plugin.sip' } → handle_id
 *   3. POST  <base>/<session>/<h>   { janus:'message', body:{ request:'register', ... } }
 *   4. GET   <base>/<session>       (long-poll) ← eventy async (incomingcall,
 *                                    accepted, hangup, registered, trickle, ...)
 *   5. POST  <base>/<session>/<h>   { janus:'message', body:{request:'accept'}, jsep }
 *   6. POST  <base>/<session>/<h>   { janus:'trickle', candidate }
 *   7. POST  <base>/<session>/<h>   { janus:'message', body:{request:'hangup'} }
 *   8. POST  <base>/<session>       { janus:'keepalive' }  co ~30 s
 *
 * Każdy request niesie unikalny `transaction` (string) — Janus echo-uje go w
 * odpowiedzi. `apisecret` dołączamy gdy `JANUS_API_SECRET` ustawione.
 *
 * SIP plugin: Akuvox dzwoni SIP-em na nasze konto (register identity). Janus
 * emituje `incomingcall` z `jsep` (offer SIP, SDP audio/wideo H.264). My ten
 * offer NIE oddajemy bezpośrednio apce — `janus.plugin.sip` sam mostkuje SIP↔
 * WebRTC: po `accept` z naszym WebRTC `jsep` (answer od iOS) Janus zestawia obie
 * nogi. Ale w naszym flow iOS jest WebRTC offerer (recvonly wideo + sendrecv
 * audio), więc używamy wariantu: Janus oddaje SIP offer → apka generuje WebRTC
 * answer (passthrough H.264, D4). Patrz `handleSdp`.
 *
 * Konfiguracja (env, czytane dopiero w connect() — NIE w konstruktorze):
 *   JANUS_HTTP_URL      bazowy URL transportu HTTP, np. http://127.0.0.1:8088/janus
 *   JANUS_API_SECRET    sekret API (transport-level `apisecret`), opcjonalny
 *   JANUS_SIP_IDENTITY  nasz SIP URI rejestrowany w plugin (np. sip:edge@127.0.0.1)
 *   JANUS_SIP_REALM     realm SIP (gdy registrar tego wymaga)
 *   JANUS_SIP_PROXY     proxy/registrar (np. sip:127.0.0.1:5060) — gdy używamy registrara
 *   JANUS_SIP_SECRET    hasło konta SIP (gdy register z autoryzacją)
 *
 * Bez działającego Janusa (`JANUS_HTTP_URL` puste) most pozostaje w trybie
 * STUB (no-op, ready=false) — Edge startuje normalnie.
 */
import { Logger } from '@nestjs/common'
import axios, { type AxiosInstance } from 'axios'
import { randomUUID } from 'crypto'
import type { BridgeSignal, MediaBridge, MediaBridgeEvents } from './media-bridge'

/** Surowy event Janusa z long-poll (uproszczony — bierzemy tylko to czego używamy). */
interface JanusEvent {
  janus: string
  session_id?: number
  sender?: number
  transaction?: string
  jsep?: { type: 'offer' | 'answer'; sdp: string }
  plugindata?: { plugin: string; data: Record<string, any> }
  [k: string]: any
}

/** Stan jednej sesji połączenia mapowanej na handle SIP w Janusie. */
interface JanusCallState {
  sessionId: string // nasz IntercomCallSession.id
  /** SDP offer SIP otrzymany od Akuvoxa (Janus odda go apce jako WebRTC offer). */
  pendingSipOffer?: string
  /** Czy `accept` został już wysłany (mamy answer od apki). */
  accepted: boolean
  /**
   * Połączenie WYCHODZĄCE (mieszkaniec → stacja): docelowy SIP URI Akuvoxa
   * (np. "sip:192.168.1.100:5060"). Gdy ustawione, `handleSdp('offer')` robi
   * Janus `request:'call'` na ten URI zamiast czekać na incomingcall.
   */
  outboundUri?: string
  /** Kierunki mediów z oferty apki per m-linia (audio, video…) — do korekty
   * kierunków w answerze Janusa (patrz fixAnswerDirections). */
  offerDirections?: string[]
}

export class JanusMediaBridge implements MediaBridge {
  private readonly logger = new Logger(JanusMediaBridge.name)
  private events: MediaBridgeEvents | null = null
  private ready = false

  private http: AxiosInstance | null = null
  private apiSecret: string | null = null

  // Jeden globalny SIP handle (jedno konto Edge rejestrowane w plugin). Wszystkie
  // przychodzące Akuvox-call lecą na ten handle. Gdyby trzeba wielu kont — mapa
  // deviceId→handle (Faza D, multi-domofon na osobnych kontach SIP).
  private janusSessionId: number | null = null
  private sipHandleId: number | null = null

  // Mapowanie naszego sessionId ↔ stan połączenia. SIP plugin obsługuje jedno
  // aktywne wywołanie na handle; trzymamy 1:1 (multi-call wymaga osobnych handle).
  private readonly calls = new Map<string, JanusCallState>()
  // Korelacja: Janus identyfikuje połączenie po handle/Call-ID, my po sessionId.
  // Bieżące przychodzące (zanim Cloud nada answer) trzymamy jako `activeCallSid`.
  private activeSessionId: string | null = null

  private pollAbort: AbortController | null = null
  private keepaliveTimer: NodeJS.Timeout | null = null
  private stopped = false

  async connect(events: MediaBridgeEvents): Promise<void> {
    this.events = events
    const base = process.env.JANUS_HTTP_URL ?? ''
    if (!base) {
      this.logger.warn('JANUS_HTTP_URL nie ustawione — JanusMediaBridge działa w trybie STUB (no-op)')
      this.ready = false
      return
    }
    this.apiSecret = process.env.JANUS_API_SECRET ?? null
    this.http = axios.create({ baseURL: base.replace(/\/$/, ''), timeout: 15_000 })
    this.stopped = false

    try {
      // 1. create session
      this.janusSessionId = await this.createJanusSession()
      // 2. attach janus.plugin.sip
      this.sipHandleId = await this.attachSipPlugin(this.janusSessionId)
      // 3. register konto SIP (Akuvox dzwoni do nas)
      await this.sipRegister(this.janusSessionId, this.sipHandleId)
      // 4. long-poll na eventy + keepalive
      this.startLongPoll(this.janusSessionId)
      this.startKeepalive(this.janusSessionId)
      this.ready = true
      this.logger.log(
        `JanusMediaBridge ready — session=${this.janusSessionId} sipHandle=${this.sipHandleId}`,
      )
    } catch (err) {
      this.ready = false
      this.logger.error(`JanusMediaBridge.connect failed: ${(err as Error).message}`)
      throw err
    }
  }

  isReady(): boolean {
    return this.ready
  }

  /**
   * Multi-station (2026-07-05): jeden handle SIP = jedno aktywne połączenie.
   * `activeSessionId` żyje od incomingcall/startOutbound do hangup/ended —
   * gdy ustawione, kolejne wywołanie (z DOWOLNEJ stacji) musi dostać busy.
   */
  isBusy(): boolean {
    return this.activeSessionId != null
  }

  /**
   * Przygotuj sesję WebRTC dla odebranego połączenia (MediaBridge interface).
   * W naszym flow Janus (przez SIP plugin) jest OFFER-erem: oddajemy apce SDP
   * offer pochodzący z SIP INVITE Akuvoxa. Zwracamy offer SDP, jeśli już mamy go
   * z `incomingcall`; inaczej null (apka i tak subskrybuje SSE i dostanie go
   * z eventu `onSignalToApp`).
   */
  async createSession(sessionId: string): Promise<{ sdpOffer?: string } | null> {
    const st = this.calls.get(sessionId)
    if (st?.pendingSipOffer) {
      // Oddaj offer apce również jako event (gdy apka już słucha SSE) — bez
      // tego apka, która zaczęła słuchać przed handleAnswer, mogłaby go ominąć.
      this.events?.onSignalToApp({ sessionId, kind: 'offer', sdp: st.pendingSipOffer, from: 'edge' })
      return { sdpOffer: st.pendingSipOffer }
    }
    return null
  }

  /**
   * Przekaż SDP od apki do Janus SIP handle.
   *  - 'answer' — apka odpowiada na SIP-offer (typowy nasz flow): wysyłamy
   *    `request:'accept'` z jsep=answer; Janus dzwoni do Akuvoxa media bridge.
   *  - 'offer'  — gdyby apka była offer-erem (alternatywa): `request:'call'`
   *    z jsep=offer (Janus zainicjuje SIP po naszej stronie). Trzymamy dla
   *    kompletności; default flow to 'answer'.
   */
  async handleSdp(sessionId: string, kind: 'offer' | 'answer', sdp: string): Promise<void> {
    if (!this.http || this.janusSessionId == null || this.sipHandleId == null) return
    const st = this.calls.get(sessionId)
    if (kind === 'offer' && st) {
      // Zapamiętaj kierunki mediów oferty — answer Janusa trzeba będzie
      // skorygować do dozwolonej odwrotności (fixAnswerDirections).
      st.offerDirections = JanusMediaBridge.mediaDirections(sdp)
    }
    if (kind === 'answer') {
      await this.sendToHandle(this.janusSessionId, this.sipHandleId, {
        janus: 'message',
        body: { request: 'accept' },
        jsep: { type: 'answer', sdp },
      })
      if (st) st.accepted = true
      this.logger.log(`handleSdp(${sessionId}, answer) → SIP accept wysłany`)
    } else {
      // apka jako offerer (połączenie WYCHODZĄCE mieszkaniec→stacja) — Janus
      // inicjuje SIP call do Akuvoxa pod URI ustawiony przez startOutbound.
      const uri = st?.outboundUri ?? process.env.JANUS_SIP_IDENTITY ?? ''
      await this.sendToHandle(this.janusSessionId, this.sipHandleId, {
        janus: 'message',
        body: { request: 'call', uri },
        jsep: { type: 'offer', sdp },
      })
      this.logger.log(`handleSdp(${sessionId}, offer) → SIP call → ${uri}`)
    }
  }

  /**
   * Połączenie WYCHODZĄCE: zarejestruj sesję z docelowym URI Akuvoxa. Po tym
   * apka prześle swój WebRTC offer (handleSdp 'offer'), a Janus zadzwoni do
   * stacji pod `uri`. Akuvox z Auto Answer odbierze → answer wróci eventem
   * `accepted` → onSignalToApp.
   */
  async startOutbound(sessionId: string, uri: string): Promise<void> {
    this.calls.set(sessionId, { sessionId, accepted: false, outboundUri: uri })
    this.activeSessionId = sessionId
    this.logger.log(`startOutbound(${sessionId}) → target ${uri} (czekam na offer apki)`)
  }

  /** Trickle ICE od apki → Janus handle. */
  async addIceCandidate(sessionId: string, candidate: Record<string, unknown>): Promise<void> {
    if (!this.http || this.janusSessionId == null || this.sipHandleId == null) return
    // Pusty/null candidate = koniec zbierania (completed). Janus akceptuje
    // { completed: true } albo { candidate: { ... } }.
    const isEnd =
      !candidate ||
      (candidate as any).completed === true ||
      ((candidate as any).candidate === '' && (candidate as any).sdpMid == null)
    await this.sendToHandle(this.janusSessionId, this.sipHandleId, {
      janus: 'trickle',
      ...(isEnd ? { candidate: { completed: true } } : { candidate }),
    })
  }

  /** Zakończ połączenie (SIP BYE + zamknięcie handle media). */
  async hangup(sessionId: string, reason: string): Promise<void> {
    const st = this.calls.get(sessionId)
    if (this.http && this.janusSessionId != null && this.sipHandleId != null) {
      // 'decline' jest poprawne WYŁĄCZNIE dla nieodebranego połączenia
      // PRZYCHODZĄCEGO (status=invited). Dla wychodzącego (outboundUri) plugin
      // po 'call' jest w calling/incall — 'decline' dostaje "Wrong state (not
      // invited?)", BYE nie wychodzi i handle zostaje w incall NA ZAWSZE, a
      // każda kolejna rozmowa jest głucha (ICE failed). Bug znaleziony
      // 2026-07-29: wszystkie rozmowy od 15.07 bez audio.
      const request = st?.accepted || st?.outboundUri ? 'hangup' : 'decline'
      await this.sendToHandle(this.janusSessionId, this.sipHandleId, {
        janus: 'message',
        body: { request, code: 486 },
      }).catch((err: Error) => this.logger.warn(`hangup(${sessionId}) send failed: ${err.message}`))
    }
    this.calls.delete(sessionId)
    if (this.activeSessionId === sessionId) this.activeSessionId = null
    this.logger.log(`hangup(${sessionId}, ${reason})`)
    this.events?.onCallEnded({ sessionId, reason })
  }

  /** Zatrzymanie bridge (shutdown Edge). Przerywa long-poll + keepalive. */
  async destroy(): Promise<void> {
    this.stopped = true
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.pollAbort?.abort()
    this.ready = false
  }

  /** Helper dla testów/Fazy B: emit sygnału do apki. */
  emitSignalToApp(signal: BridgeSignal): void {
    this.events?.onSignalToApp({ ...signal, from: 'edge' })
  }

  // ── Korekta kierunków mediów w answerze (RFC 3264) ──────────────────────────

  /** Kierunek mediów per m-linia SDP (brak atrybutu = sendrecv). */
  static mediaDirections(sdp: string): string[] {
    const dirs: string[] = []
    let inMedia = false
    for (const raw of sdp.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.startsWith('m=')) {
        dirs.push('sendrecv')
        inMedia = true
        continue
      }
      if (!inMedia) continue
      const m = line.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/)
      if (m) dirs[dirs.length - 1] = m[1]
    }
    return dirs
  }

  /**
   * Zwęź kierunki answera do dozwolonej odwrotności oferty (RFC 3264):
   * oferta recvonly → answer max sendonly; sendonly → max recvonly;
   * inactive → inactive. Oferta sendrecv = bez zmian. Bez tego libWebRTC
   * (iOS) odrzuca answer w całości ("Incompatible send direction").
   */
  static fixAnswerDirections(answerSdp: string, offerDirs: string[]): string {
    const nl = answerSdp.includes('\r\n') ? '\r\n' : '\n'
    const lines = answerSdp.split(nl)
    let mIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('m=')) {
        mIdx++
        continue
      }
      if (mIdx < 0) continue
      const m = lines[i].trim().match(/^a=(sendrecv|sendonly|recvonly|inactive)$/)
      if (!m) continue
      const offerDir = offerDirs[mIdx] ?? 'sendrecv'
      if (offerDir === 'sendrecv') continue
      const maxAllowed =
        offerDir === 'recvonly' ? 'sendonly' : offerDir === 'sendonly' ? 'recvonly' : 'inactive'
      if (m[1] === 'sendrecv' || offerDir === 'inactive') {
        lines[i] = `a=${maxAllowed}`
      }
    }
    return lines.join(nl)
  }

  // ── Janus transport (HTTP) ─────────────────────────────────────────────────

  private withSecret<T extends Record<string, any>>(body: T): T & { apisecret?: string } {
    return this.apiSecret ? { ...body, apisecret: this.apiSecret } : body
  }

  /** Utwórz nową sesję Janusa (transport-level). Zwraca session_id. */
  private async createJanusSession(): Promise<number> {
    const tx = randomUUID()
    const res = await this.http!.post('', this.withSecret({ janus: 'create', transaction: tx }))
    const id = res.data?.data?.id
    if (typeof id !== 'number') throw new Error(`Janus create: brak session id (${JSON.stringify(res.data)})`)
    return id
  }

  private async attachSipPlugin(janusSession: number): Promise<number> {
    const tx = randomUUID()
    const res = await this.http!.post(
      `/${janusSession}`,
      this.withSecret({ janus: 'attach', plugin: 'janus.plugin.sip', transaction: tx }),
    )
    const id = res.data?.data?.id
    if (typeof id !== 'number') throw new Error(`Janus attach sip: brak handle id (${JSON.stringify(res.data)})`)
    return id
  }

  private async sipRegister(janusSession: number, handle: number): Promise<void> {
    const identity = process.env.JANUS_SIP_IDENTITY ?? ''
    if (!identity) {
      // Brak konta SIP — używamy trybu "guest" (Janus pozwala odbierać na
      // do_not_register tożsamości w niektórych konfiguracjach). Logujemy,
      // bo bez registrara Akuvox musi dzwonić direct-IP na handle.
      this.logger.warn('JANUS_SIP_IDENTITY nie ustawione — rejestracja SIP pominięta (direct-IP mode)')
      await this.sendToHandle(janusSession, handle, {
        janus: 'message',
        body: { request: 'register', type: 'guest', username: 'sip:edge@127.0.0.1' },
      }).catch(() => {/* guest register może nie być wspierany — ignoruj */})
      return
    }
    const body: Record<string, any> = {
      request: 'register',
      username: identity,
    }
    if (process.env.JANUS_SIP_PROXY) body.proxy = process.env.JANUS_SIP_PROXY
    if (process.env.JANUS_SIP_REALM) body.authuser = process.env.JANUS_SIP_REALM
    if (process.env.JANUS_SIP_SECRET) body.secret = process.env.JANUS_SIP_SECRET
    await this.sendToHandle(janusSession, handle, { janus: 'message', body })
    this.logger.log(`SIP register wysłany dla ${identity}`)
  }

  /** POST message/trickle/keepalive na konkretny handle. Zwraca data odpowiedzi. */
  private async sendToHandle(
    janusSession: number,
    handle: number,
    payload: Record<string, any>,
  ): Promise<any> {
    const tx = randomUUID()
    const res = await this.http!.post(
      `/${janusSession}/${handle}`,
      this.withSecret({ ...payload, transaction: tx }),
    )
    return res.data
  }

  private startKeepalive(janusSession: number): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    // Janus domyślnie wygasza sesję po 60 s bezczynności — keepalive co 30 s.
    this.keepaliveTimer = setInterval(() => {
      if (this.stopped || !this.http) return
      this.http
        .post(`/${janusSession}`, this.withSecret({ janus: 'keepalive', transaction: randomUUID() }))
        .catch((err) => this.logger.warn(`keepalive failed: ${(err as Error).message}`))
    }, 30_000)
    if (typeof this.keepaliveTimer.unref === 'function') this.keepaliveTimer.unref()
  }

  /**
   * Pętla long-poll: GET /<session> blokuje do ~30 s aż przyjdzie event, potem
   * od razu pollujemy ponownie. Po błędzie sieci — backoff 2 s i retry (Janus
   * mógł zrestartować; przy trwałym braku ready=false).
   */
  private startLongPoll(janusSession: number): void {
    const loop = async () => {
      while (!this.stopped && this.http) {
        this.pollAbort = new AbortController()
        try {
          const res = await this.http.get(`/${janusSession}`, {
            params: this.apiSecret ? { apisecret: this.apiSecret, maxev: 10 } : { maxev: 10 },
            signal: this.pollAbort.signal,
            timeout: 35_000,
          })
          const events: JanusEvent[] = Array.isArray(res.data) ? res.data : [res.data]
          for (const ev of events) this.handleJanusEvent(ev)
        } catch (err) {
          if (this.stopped) break
          // Timeout long-polla (brak eventów) = normalne; po prostu ponawiamy.
          const msg = (err as Error).message ?? ''
          if (/timeout|aborted|ECONNABORTED/i.test(msg)) continue
          this.logger.warn(`long-poll error: ${msg} — retry za 2 s`)
          await new Promise((r) => setTimeout(r, 2_000))
        }
      }
    }
    void loop()
  }

  // ── Obsługa eventów Janusa ──────────────────────────────────────────────────

  private handleJanusEvent(ev: JanusEvent): void {
    if (!ev || typeof ev !== 'object') return
    const data = ev.plugindata?.data
    const result = data?.result
    const sipEvent: string | undefined = result?.event

    switch (sipEvent) {
      case 'registered':
        this.logger.log(`SIP registered: ${result?.username ?? ''}`)
        return
      case 'registration_failed':
        this.logger.error(`SIP registration_failed: code=${result?.code} reason=${result?.reason}`)
        return
      case 'incomingcall':
        this.onIncomingCall(ev, result)
        return
      case 'missed_call':
        // Multi-station: druga stacja zadzwoniła gdy handle był zajęty —
        // Janus SIP plugin sam odpowiedział 486 Busy i zgłasza missed_call.
        // Gość przy tej stacji słyszy zajętość; informujemy orkiestrację
        // (Edge → Cloud INTERCOM_STATION_BUSY, audit dla instalatora).
        this.logger.warn(
          `missed_call (handle zajęty) caller=${result?.caller ?? '?'} — równoległe wywołanie odrzucone`,
        )
        this.events?.onStationBusy?.({ fromUri: String(result?.caller ?? 'unknown') })
        return
      case 'progress':
      case 'accepted':
        // Druga noga (Akuvox) zaakceptowała / media gotowe. Dla połączenia
        // WYCHODZĄCEGO (apka→stacja) answer WebRTC dla apki przychodzi właśnie
        // tutaj — z 'accepted' (200 OK) ALBO z 'progress' (183 z SDP; wtedy
        // późniejszy 'accepted' jest już BEZ jsep — Janus wysyła jsep raz).
        // Brak obsługi 'progress' = zgubiony answer = apka bez remote
        // description = ICE failed = głucha rozmowa.
        this.logger.log(
          `SIP ${sipEvent}: jsep=${ev.jsep ? ev.jsep.type : 'brak'} activeSession=${this.activeSessionId ?? 'brak'}`,
        )
        if (ev.jsep && this.activeSessionId) {
          // ROOT CAUSE głuchych rozmów wychodzących (2026-07-29): plugin SIP
          // przepisuje kierunki mediów z SDP Akuvoxa (sendrecv na video), a
          // apka oferuje video recvonly. RFC 3264: answer na recvonly może być
          // tylko sendonly/inactive — libWebRTC w iOS odrzuca cały answer
          // ("Incompatible send direction"), setRemoteDescription pada i ICE
          // nigdy nie startuje. Korygujemy kierunki do dozwolonych.
          const st = this.calls.get(this.activeSessionId)
          let sdp = ev.jsep.sdp
          if (ev.jsep.type === 'answer' && st?.offerDirections?.length) {
            const fixed = JanusMediaBridge.fixAnswerDirections(sdp, st.offerDirections)
            if (fixed !== sdp) {
              this.logger.log(`answer: skorygowano kierunki mediów pod ofertę apki (${st.offerDirections.join(',')})`)
              sdp = fixed
            }
          }
          this.events?.onSignalToApp({
            sessionId: this.activeSessionId,
            kind: ev.jsep.type,
            sdp,
            from: 'edge',
          })
        }
        return
      case 'hangup':
      case 'bye':
        this.onSipHangup(result)
        return
      default:
        break
    }

    // Trickle ICE od Janusa (kierunek edge→app). Janus wysyła własne kandydaty
    // przez plugindata albo bezpośrednio jako event `trickle` z `candidate`.
    if (ev.janus === 'trickle' && ev.candidate && this.activeSessionId) {
      this.logger.log(`trickle Janus→app session=${this.activeSessionId}`)
      this.events?.onSignalToApp({
        sessionId: this.activeSessionId,
        kind: 'ice',
        candidate: ev.candidate,
        from: 'edge',
      })
    }
  }

  /**
   * Akuvox zadzwonił. Janus przekazał SIP offer w `ev.jsep`. Tworzymy nowy
   * sessionId (UUID — Cloud tworzy IntercomCallSession z tego id po
   * INTERCOM_CALL_INVITE), zapamiętujemy offer i powiadamiamy orkiestrację.
   *
   * Offer NIE jest jeszcze oddawany apce — najpierw Cloud rozwiązuje kogo wołać
   * i wysyła VoIP push. Apka po odebraniu (`INTERCOM_CALL_ANSWER` → handleAnswer
   * → MediaBridge.createSession) dostanie offer i odeśle answer (handleSdp).
   */
  private onIncomingCall(ev: JanusEvent, result: Record<string, any>): void {
    // Defense-in-depth (multi-station): jeśli trwa już połączenie, NIE
    // nadpisujemy stanu (activeSessionId/pendingSipOffer) drugim wywołaniem.
    // Normalnie Janus SIP plugin sam odpowiada 486 zanim tu dojdziemy
    // (event `missed_call`), więc ta ścieżka to bezpiecznik. NIE wysyłamy
    // własnego decline — na wspólnym handle mógłby trafić AKTYWNĄ rozmowę.
    if (this.activeSessionId != null) {
      const busyFrom: string = result?.username ?? result?.displayname ?? 'sip:unknown'
      this.logger.warn(
        `incomingcall podczas aktywnej sesji ${this.activeSessionId} — ignoruję (busy) from=${busyFrom}`,
      )
      this.events?.onStationBusy?.({ fromUri: busyFrom })
      return
    }
    const sessionId = randomUUID()
    const fromUri: string = result?.username ?? result?.displayname ?? 'sip:unknown'
    // Numer wybrany z książki domofonu (= id lokalu). Janus SIP plugin podaje
    // URI wołanego w `callee` (np. "sip:49@192.168.1.127:5060"). Wyciągamy
    // user-part → Cloud routuje punktowo do mieszkańców tego lokalu. Pusty przy
    // bezpośrednim przycisku (direct-IP do samego IP, bez user-part).
    const calleeUri: string = result?.callee ?? result?.to ?? ''
    const toExtension = this.userPartOf(calleeUri)
    this.calls.set(sessionId, {
      sessionId,
      pendingSipOffer: ev.jsep?.sdp,
      accepted: false,
    })
    this.activeSessionId = sessionId
    this.logger.log(
      `incomingcall from=${fromUri} callee="${calleeUri}" ext=${toExtension ?? '-'} → sessionId=${sessionId}`,
    )
    this.events?.onIncomingCall({ sessionId, fromUri, toExtension })
  }

  /** "sip:49@192.168.1.127:5060" → "49"; brak user-part → undefined. */
  private userPartOf(uri: string): string | undefined {
    const m = /^sips?:([^@;>]+)@/i.exec((uri || '').trim())
    const u = m?.[1]?.trim()
    return u && u.length > 0 ? u : undefined
  }

  private onSipHangup(result: Record<string, any>): void {
    const sessionId = this.activeSessionId
    const reason: string = result?.reason ?? 'CALLER_HANGUP'
    if (sessionId) {
      this.calls.delete(sessionId)
      this.activeSessionId = null
      this.events?.onCallEnded({ sessionId, reason })
    }
  }
}
