/**
 * MediaBridge — abstrakcja media servera dla połączeń domofonowych
 * (SIP↔WebRTC). Projekt: docs/intercom-akuvox-call.md.
 *
 * IntercomCallService (orkiestracja) NIE zna szczegółów Janusa/FreeSWITCHa —
 * woła tylko ten interfejs. Domyślna implementacja to `JanusMediaBridge`
 * (Faza B), ale można ją podmienić bez ruszania orkiestracji (OTWARTA DECYZJA
 * D4 — gdyby Akuvox firmware wymagał FreeSWITCHa).
 *
 * UWAGA (pitfall CLAUDE.md #18): tu są TYLKO definicje + stub. ŻADNYCH wywołań
 * store/IO w konstruktorach — connect() leci dopiero gdy IntercomCallService
 * jest aktywowany (flaga ON + onModuleInit).
 */

/** Sygnał WebRTC przekazywany między apką (przez Cloud) a media serverem. */
export interface BridgeSignal {
  sessionId: string
  kind: 'offer' | 'answer' | 'ice'
  sdp?: string
  candidate?: Record<string, unknown>
}

/** Callbacki które media server wywołuje w stronę orkiestracji. */
export interface MediaBridgeEvents {
  /** Akuvox zadzwonił (SIP INVITE terminowany przez media server). */
  onIncomingCall: (info: {
    sessionId: string
    /** SIP identyfikator dzwoniącego — Edge mapuje na intercomDeviceId/unit. */
    fromUri: string
    /** Wskazówka który panel/extension (gdy registrar to przekazuje). */
    toExtension?: string
  }) => void
  /** Media server ma sygnał (answer/ICE) do przekazania apce. */
  onSignalToApp: (signal: BridgeSignal & { from: 'edge' }) => void
  /** Połączenie zakończone po stronie media servera / Akuvoxa. */
  onCallEnded: (info: { sessionId: string; reason: string }) => void
  /**
   * Multi-station (2026-07-05): media server odrzucił RÓWNOLEGŁE wywołanie
   * (np. druga stacja dzwoni gdy trwa rozmowa — Janus SIP plugin ma 1 handle
   * = 1 aktywne połączenie i odpowiada 486 Busy / `missed_call`). Sesja nie
   * powstaje; Edge emituje INTERCOM_STATION_BUSY do Cloud (audit).
   */
  onStationBusy?: (info: { fromUri: string }) => void
}

export interface MediaBridge {
  /** Nawiąż kontrolę z media serverem (Admin API). Idempotentne. */
  connect(events: MediaBridgeEvents): Promise<void>
  /** Czy most jest gotowy (media server osiągalny). */
  isReady(): boolean
  /**
   * Multi-station (2026-07-05): czy most prowadzi już aktywne połączenie.
   * Janus SIP plugin (1 handle) obsługuje 1 rozmowę naraz — orkiestracja
   * odrzuca outbound gdy busy (STATION_BUSY zamiast kolizji w Janusie).
   * Opcjonalne — brak implementacji = zakładamy wolny.
   */
  isBusy?(): boolean
  /**
   * Przygotuj sesję WebRTC dla odebranego połączenia. Zwraca initial offer
   * (gdy media server jest offer-er) albo null (gdy czeka na offer od apki).
   */
  createSession(sessionId: string): Promise<{ sdpOffer?: string } | null>
  /** Połączenie WYCHODZĄCE (mieszkaniec→stacja): zarejestruj sesję + URI Akuvoxa. */
  startOutbound?(sessionId: string, uri: string): Promise<void>
  /** Przekaż SDP (offer/answer) od apki do media servera. */
  handleSdp(sessionId: string, kind: 'offer' | 'answer', sdp: string): Promise<void>
  /** Przekaż kandydata ICE od apki. */
  addIceCandidate(sessionId: string, candidate: Record<string, unknown>): Promise<void>
  /** Zakończ połączenie (BYE do Akuvoxa + zamknięcie WebRTC). */
  hangup(sessionId: string, reason: string): Promise<void>
  /**
   * Zatrzymanie mostu (shutdown Edge) — przerwij long-poll/keepalive, zwolnij
   * sesję media servera. Opcjonalne: stub-implementacje mogą pominąć.
   */
  destroy?(): Promise<void>
}
