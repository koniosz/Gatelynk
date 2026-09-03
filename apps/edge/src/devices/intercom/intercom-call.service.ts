/**
 * IntercomCallService (Edge) — ORKIESTRACJA połączeń domofonowych po stronie
 * Edge. Projekt: docs/intercom-akuvox-call.md.
 *
 * Rola: warstwa pomiędzy media serverem (MediaBridge / Janus) a tunelem do
 * Cloud. NIE implementuje SIP/RTP/WebRTC — to robi MediaBridge. Tu jest tylko
 * zarządzanie sesjami + emisja/odbiór eventów tunelu.
 *
 * Za flagą env INTERCOM_CALL_ENABLED (default false). Gdy off — `enabled`
 * zwraca false, `bootstrap()` nie łączy MediaBridge, a CMD-y z tunelu są no-op.
 *
 * ── PITFALLE (CLAUDE.md) ─────────────────────────────────────────────────────
 *   #18: ŻADNYCH wywołań store/IO w konstruktorze. MediaBridge.connect() leci w
 *        bootstrap(), wołanym z TunnelService.onModuleInit (gdy StoreService już
 *        zainicjalizowany). Tu trzymamy tylko referencje + Map sesji w pamięci.
 *   #8 : serwis MUSI być w DevicesModule.exports (TunnelService go injectuje).
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { StoreService } from '../../store/store.service'
import type { BridgeSignal, MediaBridge, MediaBridgeEvents } from './media-bridge'
import { JanusMediaBridge } from './janus-media-bridge'

/** Funkcja emisji eventu do Cloud — wstrzykiwana przez TunnelService.setTunnelSend. */
type TunnelSend = (event: string, data: Record<string, any>, deviceId?: string) => boolean

interface CallSession {
  sessionId: string
  /**
   * Identyfikator stacji: UUID urządzenia z device_config/intercom_bridge gdy
   * udało się zmapować (multi-station), inaczej surowy SIP fromUri (legacy).
   */
  intercomDeviceId: string
  intercomName?: string
  /** LAN IP stacji Akuvox (rozwiązany z fromUri albo rejestru) — snapshot/outbound. */
  intercomIp?: string
  startedAt: number
  state: 'RINGING' | 'ACTIVE' | 'ENDED'
}

@Injectable()
export class IntercomCallService implements OnModuleDestroy {
  private readonly logger = new Logger(IntercomCallService.name)
  private tunnelSend: TunnelSend | null = null
  private bridge: MediaBridge | null = null
  private bootstrapped = false
  private readonly sessions = new Map<string, CallSession>()
  // Offery apki które wyprzedziły CMD INTERCOM_CALL_STATION (race w tunelu) —
  // konsumowane w handleCallStation zaraz po startOutbound.
  private readonly pendingOffers = new Map<string, string>()

  // StoreService @Global() — bez extra importu w DevicesModule. NIE wołamy
  // store w konstruktorze (db inicjalizowane w onModuleInit StoreService).
  constructor(private readonly store: StoreService) {}

  /** Master feature-flag. */
  get enabled(): boolean {
    return process.env.INTERCOM_CALL_ENABLED === 'true'
  }

  /** Wstrzyknięcie sendEvent — wołane przez TunnelService.onModuleInit. */
  setTunnelSend(fn: TunnelSend) {
    this.tunnelSend = fn
  }

  /**
   * Inicjalizacja mostu media. Wołane z TunnelService.onModuleInit PO tym jak
   * StoreService.onModuleInit zainicjalizował DB (pitfall #18). Idempotentne.
   */
  async bootstrap(): Promise<void> {
    if (!this.enabled) {
      this.logger.log('INTERCOM_CALL_ENABLED=false — most połączeń nieaktywny')
      return
    }
    if (this.bootstrapped) return
    this.bootstrapped = true

    // Domyślny backend: Janus (rekomendacja — docs sekcja 3). Podmiana na
    // FreeSWITCH = tu nowa instancja, reszta serwisu bez zmian.
    this.bridge = new JanusMediaBridge()
    const events: MediaBridgeEvents = {
      onIncomingCall: (info) => this.onIncomingCall(info),
      onSignalToApp: (signal) => this.onSignalToApp(signal),
      onCallEnded: (info) => this.onCallEnded(info.sessionId, info.reason),
      // Multi-station: równoległe wywołanie odrzucone przez Janus (486) —
      // audit do Cloud. Gość przy stacji słyszy zajętość, sesja nie powstaje.
      onStationBusy: (info) => {
        this.tunnelSend?.('INTERCOM_STATION_BUSY', { fromUri: info.fromUri })
      },
    }
    await this.bridge.connect(events).catch((err: Error) =>
      this.logger.error(`MediaBridge.connect failed: ${err.message}`),
    )
    this.logger.log(`IntercomCallService bootstrap — bridge ready=${this.bridge?.isReady()}`)
  }

  /** Shutdown Edge — zwolnij most (long-poll/keepalive Janusa). */
  async onModuleDestroy(): Promise<void> {
    if (this.bridge?.destroy) {
      await this.bridge.destroy().catch((err: Error) =>
        this.logger.warn(`MediaBridge.destroy failed: ${err.message}`),
      )
    }
  }

  // ── MediaBridge → Cloud ───────────────────────────────────────────────────
  /**
   * Akuvox zadzwonił (media server terminował SIP INVITE). Rozwiązujemy kto
   * dzwoni i emitujemy INTERCOM_CALL_INVITE do Cloud.
   *
   * Mapowanie kogo wołać: Edge zna intercomDeviceId, ale pełna mapa
   * unit→residenci żyje w Cloud (Postgres). Dlatego Edge emituje `residentIds: []`
   * + wskazówki (intercomDeviceId, unitLabel jeśli panel ją poda przez SIP
   * extension), a Cloud `IntercomCallService.handleInvite` rozwiązuje residentów
   * (BuildingIntercom→Unit→UnitResident→Resident). Patrz docs sekcja 6.
   */
  private onIncomingCall(info: { sessionId: string; fromUri: string; toExtension?: string }) {
    if (!this.enabled || !this.tunnelSend) return
    // ── Multi-station (2026-07-05): fromUri → KTÓRA stacja dzwoni ────────────
    // SIP fromUri Akuvoxa zawiera jego LAN IP (direct-IP mode). Mapujemy IP na
    // stację z rejestru (intercom_bridge z Cloud → device_config fallback) i
    // wysyłamy Cloudowi UUID urządzenia + nazwę stacji. Cloud dopasuje
    // BuildingIntercom.edgeDeviceId (bridgeEnabled, nazwa do CallKit).
    // Gdy nie zmapujemy — legacy zachowanie: surowy fromUri (Cloud spadnie na
    // fallback-routing jak dotąd). NIE używamy toExtension jako deviceId:
    // w trybie książki adresowej to numer LOKALU ("4") — idzie osobno jako
    // dialedExtension → Cloud routuje punktowo do mieszkańców tego lokalu.
    const ip = this.extractIpFromSipUri(info.fromUri)
    const station = this.resolveStationByIp(ip)
    const intercomDeviceId = station?.edgeDeviceId ?? info.fromUri
    const dialedExtension = info.toExtension ?? null
    this.sessions.set(info.sessionId, {
      sessionId: info.sessionId,
      intercomDeviceId,
      intercomName: station?.name,
      intercomIp: ip ?? undefined,
      startedAt: Date.now(),
      state: 'RINGING',
    })
    this.tunnelSend('INTERCOM_CALL_INVITE', {
      sessionId: info.sessionId,
      intercomDeviceId,
      intercomName: station?.name,
      dialedExtension,
      // unitLabel/unitId/residentIds rozwiązuje Cloud (Edge nie ma mapy lokali).
      residentIds: [],
    })
    this.logger.log(
      `INTERCOM_CALL_INVITE → Cloud session=${info.sessionId} device=${intercomDeviceId} ` +
        `station="${station?.name ?? '?'}" ip=${ip ?? '?'} dialed=${dialedExtension ?? '-'}`,
    )
  }

  /**
   * Multi-station: mapowanie LAN IP stacji → {edgeDeviceId, name}.
   * Źródła w kolejności:
   *   1. `intercom_bridge` (rejestr z Cloud, sync INTERCOM_SYNC_ALL) — po
   *      ip_address, a gdy IP tam puste to po device_config z tym samym IP.
   *   2. device_config typu INTERCOM (rejestr urządzeń Edge) po config.ipAddress
   *      — wtedy nazwa dobierana z intercom_bridge po edge_device_id.
   *   3. Fallback: JEDYNA stacja w rejestrze (typowa instalacja 1-panelowa) —
   *      zachowuje dzisiejsze zachowanie Villa Natura bez rekonfiguracji.
   */
  private resolveStationByIp(ip: string | null): { edgeDeviceId: string; name?: string } | null {
    const bridgeRows = this.safeIntercomBridgeList()
    const intercoms = this.store.getDeviceConfigs().filter((d) => d.type === 'INTERCOM')
    const ipOfDevice = (d: { config: unknown } | undefined): string | undefined =>
      (d?.config as { ipAddress?: string } | undefined)?.ipAddress

    if (ip) {
      // 1a. Rejestr Cloud po ip_address.
      const byBridgeIp = bridgeRows.find((r) => r.ipAddress === ip && r.edgeDeviceId)
      if (byBridgeIp?.edgeDeviceId) {
        return { edgeDeviceId: byBridgeIp.edgeDeviceId, name: byBridgeIp.name }
      }
      // 1b/2. device_config po config.ipAddress → nazwa z rejestru Cloud.
      const dev = intercoms.find((d) => ipOfDevice(d) === ip)
      if (dev) {
        const bridge = bridgeRows.find((r) => r.edgeDeviceId === dev.deviceId)
        return { edgeDeviceId: dev.deviceId, name: bridge?.name }
      }
    }

    // 3. Jedna stacja = bez dwuznaczności (legacy single-station).
    if (intercoms.length === 1) {
      const only = intercoms[0]
      const bridge = bridgeRows.find((r) => r.edgeDeviceId === only.deviceId)
      return { edgeDeviceId: only.deviceId, name: bridge?.name }
    }
    if (bridgeRows.length === 1 && bridgeRows[0].edgeDeviceId) {
      return { edgeDeviceId: bridgeRows[0].edgeDeviceId, name: bridgeRows[0].name }
    }
    return null
  }

  /** intercom_bridge może nie istnieć na starym store — nie wywalaj INVITE. */
  private safeIntercomBridgeList(): ReturnType<StoreService['intercomBridgeList']> {
    try {
      return this.store.intercomBridgeList()
    } catch {
      return []
    }
  }

  private onSignalToApp(signal: BridgeSignal & { from: 'edge' }) {
    if (!this.enabled || !this.tunnelSend) {
      this.logger.warn(
        `onSignalToApp DROPPED (enabled=${this.enabled} tunnel=${!!this.tunnelSend}) kind=${signal.kind} session=${signal.sessionId}`,
      )
      return
    }
    this.logger.log(`EVT INTERCOM_SIGNAL → Cloud kind=${signal.kind} session=${signal.sessionId}`)
    this.tunnelSend('INTERCOM_SIGNAL', { ...signal })
  }

  private onCallEnded(sessionId: string, reason: string) {
    const s = this.sessions.get(sessionId)
    if (s) s.state = 'ENDED'
    this.sessions.delete(sessionId)
    this.tunnelSend?.('INTERCOM_CALL_ENDED', { sessionId, endReason: reason })
    this.logger.log(`INTERCOM_CALL_ENDED → Cloud session=${sessionId} reason=${reason}`)
  }

  // ── Cloud → MediaBridge (wołane z TunnelService dispatch CMD) ─────────────
  /** Mieszkaniec odebrał. Przygotuj WebRTC peera; jeśli most da offer — wyślij apce. */
  async handleAnswer(payload: { sessionId?: string; residentId?: number }): Promise<{ ok: boolean }> {
    if (!this.enabled) return { ok: false }
    const sessionId = String(payload?.sessionId ?? '')
    if (!sessionId || !this.bridge) return { ok: false }
    const s = this.sessions.get(sessionId)
    if (s) s.state = 'ACTIVE'
    const session = await this.bridge.createSession(sessionId)
    if (session?.sdpOffer) {
      this.onSignalToApp({ sessionId, kind: 'offer', sdp: session.sdpOffer, from: 'edge' })
    }
    this.logger.log(`handleAnswer session=${sessionId} resident=${payload?.residentId}`)
    return { ok: true }
  }

  /**
   * Połączenie WYCHODZĄCE: mieszkaniec dzwoni do stacji. Cloud przekazał IP
   * Akuvoxa; rejestrujemy sesję w moście z docelowym SIP URI. Apka prześle
   * potem swój WebRTC offer (INTERCOM_SIGNAL kind=offer) → Janus zadzwoni do
   * stacji (Auto Answer odbierze) → answer wróci do apki.
   */
  async handleCallStation(payload: {
    sessionId?: string
    intercomDeviceId?: string
    intercomId?: number
    akuvoxIp?: string
  }): Promise<{ ok: boolean; reason?: string }> {
    if (!this.enabled || !this.bridge?.startOutbound) return { ok: false }
    const sessionId = String(payload?.sessionId ?? '')
    if (!sessionId) {
      this.logger.warn('handleCallStation: brak sessionId')
      return { ok: false }
    }
    // Multi-station: most (1 handle SIP w Janusie) prowadzi 1 rozmowę naraz.
    // Cloud ma własny busy-guard na sesjach, ale race (INVITE w locie) łapiemy
    // tu — sesję zamykamy STATION_BUSY, apka dostaje cancel z powodem.
    if (this.bridge.isBusy?.()) {
      this.logger.warn(`handleCallStation session=${sessionId}: most zajęty — STATION_BUSY`)
      this.tunnelSend?.('INTERCOM_CALL_ENDED', { sessionId, endReason: 'STATION_BUSY' })
      return { ok: false, reason: 'STATION_BUSY' }
    }
    // Cloud podaje edgeDeviceId (lub od razu IP) — rozwiązujemy LAN-IP Akuvoxa
    // z device-config, fallback z rejestru stacji (intercom_bridge z Cloud).
    const ip = String(payload?.akuvoxIp ?? '').trim() || this.resolveAkuvoxIp(payload?.intercomDeviceId)
    if (!ip) {
      this.logger.warn(`handleCallStation: nie rozwiązano IP Akuvoxa (device=${payload?.intercomDeviceId ?? '?'})`)
      this.tunnelSend?.('INTERCOM_CALL_ENDED', { sessionId, endReason: 'NO_DEVICE' })
      return { ok: false, reason: 'NO_DEVICE' }
    }
    const uri = `sip:${ip}:5060`
    // Sesja pamięta KTÓRA stacja: UUID urządzenia (gdy Cloud podał) + IP.
    // Snapshot działa przez UUID-match (resolveAkuvoxDeviceIdForSession) albo IP.
    this.sessions.set(sessionId, {
      sessionId,
      intercomDeviceId: String(payload?.intercomDeviceId ?? ip),
      intercomIp: ip,
      startedAt: Date.now(),
      state: 'RINGING',
    })
    await this.bridge.startOutbound(sessionId, uri)
    this.logger.log(`handleCallStation session=${sessionId} device=${payload?.intercomDeviceId ?? '?'} → ${uri}`)
    // Offer apki mógł przyjść przed tym CMD (race w tunelu) — dosyłamy teraz.
    const pendingOffer = this.pendingOffers.get(sessionId)
    if (pendingOffer) {
      this.pendingOffers.delete(sessionId)
      this.logger.log(`konsumuję zbuforowany offer (session=${sessionId})`)
      await this.bridge.handleSdp?.(sessionId, 'offer', pendingOffer)
    }
    return { ok: true }
  }

  /**
   * LAN-IP Akuvoxa dla połączenia wychodzącego: najpierw po deviceId z device-
   * config typu INTERCOM, potem rejestr stacji z Cloud (intercom_bridge —
   * multi-station: ip_address per stacja), fallback do jedynego/pierwszego
   * INTERCOM z `ipAddress` (typowa instalacja = 1 panel per Edge).
   */
  private resolveAkuvoxIp(deviceId?: string): string {
    const intercoms = this.store.getDeviceConfigs().filter((d) => d.type === 'INTERCOM')
    const ipOf = (d: { config: unknown } | undefined): string | undefined =>
      (d?.config as { ipAddress?: string } | undefined)?.ipAddress
    if (deviceId) {
      const byId = intercoms.find((d) => d.deviceId === deviceId)
      if (ipOf(byId)) return ipOf(byId) as string
      // Rejestr stacji z Cloud — gdy urządzenia nie ma w device_config
      // (np. panel podpięty tylko przez building_intercoms.ipAddress).
      const bridge = this.safeIntercomBridgeList().find((r) => r.edgeDeviceId === deviceId)
      if (bridge?.ipAddress) return bridge.ipAddress
    }
    const withIp = intercoms.find((d) => ipOf(d))
    return ipOf(withIp) ?? ''
  }

  /** Odrzucenie / timeout — most wysyła SIP reject/BYE. */
  async handleDecline(payload: { sessionId?: string }): Promise<{ ok: boolean }> {
    if (!this.enabled) return { ok: false }
    const sessionId = String(payload?.sessionId ?? '')
    if (!sessionId || !this.bridge) return { ok: false }
    await this.bridge.hangup(sessionId, 'DECLINED')
    return { ok: true }
  }

  /** Rozłączenie aktywnego połączenia. */
  async handleHangup(payload: { sessionId?: string; by?: string }): Promise<{ ok: boolean }> {
    if (!this.enabled) return { ok: false }
    const sessionId = String(payload?.sessionId ?? '')
    if (!sessionId || !this.bridge) return { ok: false }
    await this.bridge.hangup(sessionId, payload?.by === 'caller' ? 'CALLER_HANGUP' : 'ANSWERED_HANGUP')
    return { ok: true }
  }

  // ── Hybrydowe wideo: snapshot kamery Akuvox dla aktywnej sesji ─────────────
  /**
   * Rozwiązuje deviceId urządzenia Akuvox (INTERCOM) dla danej sesji połączenia,
   * żeby DeviceRegistryService mógł pobrać snapshot kamery panelu (hybrydowe
   * wideo — WebRTC-wideo Akuvoxa nie działa, pokazujemy snapshoty, patrz
   * docs/intercom-akuvox-call.md).
   *
   * Mapowanie: sesja trzyma `intercomDeviceId` = SIP URI/extension peera (np.
   * `sip:192.168.1.100@192.168.1.100:5060`). Wyciągamy z niego IP i dopasowujemy
   * do device config typu INTERCOM po `config.ipAddress`. To te same urządzenia
   * co fast-path snapshot Akuvoxa w device-registry (GetSnapshot) — NIE
   * duplikujemy logiki snapshotu, zwracamy tylko deviceId.
   *
   * Fallback: gdy z URI nie da się wyłuskać IP (albo brak matcha), a jest
   * dokładnie JEDEN domofon w rejestrze — używamy go (typowa instalacja:
   * 1 panel Akuvox per Edge). Inaczej null → controller zwraca 404/204.
   */
  resolveAkuvoxDeviceIdForSession(sessionId: string): string | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null

    const intercoms = this.store
      .getDeviceConfigs()
      .filter((d) => d.type === 'INTERCOM')
    if (intercoms.length === 0) return null

    // Multi-station: sesja trzyma już UUID urządzenia (onIncomingCall /
    // handleCallStation mapują stację przy starcie) — dopasuj bezpośrednio.
    const byUuid = intercoms.find((d) => d.deviceId === s.intercomDeviceId)
    if (byUuid) return byUuid.deviceId

    // Legacy: intercomDeviceId = SIP URI → wyciągnij IP. Preferuj zapamiętane
    // intercomIp (multi-station), potem parsowanie URI.
    const ip = s.intercomIp ?? this.extractIpFromSipUri(s.intercomDeviceId)
    if (ip) {
      const match = intercoms.find(
        (d) => (d.config as { ipAddress?: string })?.ipAddress === ip,
      )
      if (match) return match.deviceId
    }

    // Fallback: jeden domofon = bez dwuznaczności.
    if (intercoms.length === 1) return intercoms[0].deviceId

    this.logger.warn(
      `resolveAkuvoxDeviceIdForSession(${sessionId}): nie zmapowano IP "${ip ?? '?'}" ` +
        `na żaden z ${intercoms.length} domofonów`,
    )
    return null
  }

  /**
   * Wyciąga adres IP z SIP URI / extension. Akceptuje formy:
   *   `sip:192.168.1.100@192.168.1.100:5060`, `192.168.1.100`,
   *   `100@192.168.1.100`, `sip:100@192.168.1.100:5060`.
   * Bierze pierwszy IPv4 napotkany w stringu (host po `@`, inaczej pierwszy).
   */
  private extractIpFromSipUri(uri: string | undefined): string | null {
    if (!uri) return null
    const ipv4 = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g
    // Preferuj host po '@' (część domeny SIP), inaczej pierwszy IPv4 w stringu.
    const afterAt = uri.includes('@') ? uri.slice(uri.lastIndexOf('@') + 1) : uri
    const hostMatch = afterAt.match(ipv4)
    if (hostMatch && hostMatch[0]) return hostMatch[0]
    const anyMatch = uri.match(ipv4)
    return anyMatch && anyMatch[0] ? anyMatch[0] : null
  }

  /** WebRTC offer/answer/ICE od apki → most. */
  async handleSignal(payload: {
    sessionId?: string
    kind?: 'offer' | 'answer' | 'ice'
    sdp?: string
    candidate?: Record<string, unknown>
    from?: string
  }): Promise<{ ok: boolean }> {
    if (!this.enabled || !this.bridge) return { ok: false }
    const sessionId = String(payload?.sessionId ?? '')
    if (!sessionId || !payload?.kind) return { ok: false }
    // Tylko sygnały od apki (from:'app') aplikujemy do mostu — sygnały
    // from:'edge' to echo, ignorujemy.
    if (payload.from === 'edge') return { ok: true }
    this.logger.log(`CMD signal od apki kind=${payload.kind} session=${sessionId}`)
    if (payload.kind === 'ice' && payload.candidate) {
      await this.bridge.addIceCandidate(sessionId, payload.candidate)
    } else if ((payload.kind === 'offer' || payload.kind === 'answer') && payload.sdp) {
      // RACE (2026-07-29): CMD INTERCOM_SIGNAL(offer) potrafi wyprzedzić
      // CMD INTERCOM_CALL_STATION w tunelu — wtedy most nie zna jeszcze
      // outboundUri i 'call' poszedłby z pustym URI (albo wcale). Buforujemy;
      // handleCallStation skonsumuje po startOutbound.
      if (payload.kind === 'offer' && !this.sessions.has(sessionId)) {
        this.pendingOffers.set(sessionId, payload.sdp)
        this.logger.warn(`offer PRZED call-station — zbuforowany (session=${sessionId})`)
        return { ok: true }
      }
      await this.bridge.handleSdp(sessionId, payload.kind, payload.sdp)
    }
    return { ok: true }
  }
}
