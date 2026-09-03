import Foundation
import CallKit
import AVFoundation
import UIKit
import Network

#if canImport(WebRTC)
import WebRTC
#endif

// MARK: - CallManager — CallKit + WebRTC dla połączeń domofonowych
//
// Projekt: docs/intercom-akuvox-call.md. Za flagą INTERCOM_CALL_ENABLED na
// Cloud (push nie przyjdzie gdy off → ten manager bezczynny).
//
// Odpowiedzialności:
//   • CallKit (CXProvider/CXCallController) — natywny ekran połączenia.
//     reportIncomingCall() MUSI być wołane z VoIPManager natychmiast po VoIP push.
//   • WebRTC (RTCPeerConnection) — audio 2-way + wideo recvonly (gość → mieszkaniec).
//   • Sygnalizacja przez Cloud HTTPS + SSE (IntercomCallClient).
//
// WebRTC degraduje gdy zależność SPM nie dodana (`#if canImport(WebRTC)`):
// kod kompiluje się jako stub z logami, CallKit dalej działa (audio CallKit-only).
// Po dodaniu pakietu `stasel/WebRTC` (docs sekcja 8.5) realne media się włącza.

@Observable
final class CallManager: NSObject {

    static let shared = CallManager()

    // MARK: - Stan obserwowany przez IntercomCallView

    /// Aktualnie aktywna/dzwoniąca sesja (nil = brak połączenia).
    private(set) var activeSession: IntercomVoipPayload?
    /// Stan UI połączenia.
    private(set) var callState: CallState = .idle
    /// Czy mikrofon wyciszony.
    private(set) var isMuted = false
    /// Czy głośnik (speaker) włączony.
    private(set) var isSpeaker = true
    /// Hybrydowe wideo: obraz gościa ze snapshotów kamery Akuvox (WebRTC-wideo
    /// nie działa — H.264 interop). IntercomCallView renderuje to gdy brak
    /// remoteVideoTrack. Polling prowadzimy TUTAJ (nie w SwiftUI `.task`, które
    /// bywało nieuruchamiane), bo CallManager żyje przez całe połączenie.
    private(set) var snapshotImage: UIImage?
    /// Przycisk „Otwórz" — w trakcie żądania / po sukcesie (feedback w UI).
    private(set) var isOpening = false
    private(set) var doorOpened = false

    enum CallState: Equatable {
        case idle
        case ringing      // przychodzi, czeka na odbiór
        case connecting   // odebrano, WebRTC handshake
        case active       // media płynie
        case ended
    }

    // MARK: - CallKit

    private let provider: CXProvider
    private let callController = CXCallController()
    /// CallKit identyfikuje połączenie przez UUID; mapujemy go na sessionId.
    private var currentCallUUID: UUID?
    private var currentSessionId: String?
    /// Czy bieżąca sesja jest WYCHODZĄCA (mieszkaniec→stacja) — steruje raportem
    /// CallKit „connected" i logami. Resetowane w cleanup.
    private var isOutbound = false

    // MARK: - WebRTC (opcjonalne — za canImport)
    #if canImport(WebRTC)
    private var peerConnection: RTCPeerConnection?
    /// Lokalny audio track (mikrofon mieszkańca↑) — toggleMute steruje `isEnabled`.
    private var localAudioTrack: RTCAudioTrack?
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }()
    /// Zdalny track wideo (gość) — IntercomCallView renderuje przez RTCMTLVideoView.
    /// @Observable wykrywa zmianę → SwiftUI podpina track do RTCMTLVideoView.
    private(set) var remoteVideoTrack: RTCVideoTrack?
    /// Kandydaci ICE Janusa którzy przyszli ZANIM ustawiliśmy remoteDescription.
    /// SSE potrafi dostarczyć kandydata przed ofertą — `pc.add` bez remoteDescription
    /// jest odrzucany i kandydat przepada (→ ICE nie ma pary → brak audio, `sp=0`).
    /// Buforujemy i dosypujemy po setRemoteDescription.
    private var pendingRemoteCandidates: [RTCIceCandidate] = []
    private var hasRemoteDescription = false
    /// SDP ostatnio zastosowanej oferty — SSE bywa zdublowane; ponowny
    /// setRemoteDescription restartuje ICE i gubi zebrane pary.
    private var appliedOfferSdp: String?
    #endif

    /// Klient sygnalizacji (Cloud HTTPS + SSE).
    private let client = IntercomCallClient()
    /// Task pętli sygnalizacji (SSE) — anulowany w cleanup, żeby zamknąć strumień.
    private var signalingTask: Task<Void, Never>?
    /// Task pollingu snapshotu kamery gościa — anulowany w cleanup.
    private var snapshotTask: Task<Void, Never>?
    /// Monitor sieci — żeby na komórce (LTE) zmniejszyć rozdzielczość/jakość
    /// klatki i pollować wolniej (oszczędność transferu). Aktualizowany w tle.
    private let netMonitor = NWPathMonitor()
    private var onCellular = false

    private override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: .main)
        // Wykrywaj typ łącza (WiFi vs komórka) — sterujemy tym rozdzielczością
        // klatki i tempem pollingu. `isExpensive` łapie też hotspot/Personal Hotspot.
        netMonitor.pathUpdateHandler = { [weak self] path in
            self?.onCellular = path.isExpensive || path.usesInterfaceType(.cellular)
        }
        netMonitor.start(queue: DispatchQueue(label: "gl.callmanager.net"))
    }

    // MARK: - Wejście z VoIPManager

    /// Zgłoś CallKit dla przychodzącego połączenia. WOŁANE z VoIPManager
    /// natychmiast po VoIP push (wymóg iOS 13+).
    func reportIncomingCall(_ payload: IntercomVoipPayload) {
        let uuid = UUID()
        currentCallUUID = uuid
        currentSessionId = payload.sessionId
        activeSession = payload
        callState = .ringing

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: payload.intercomName)
        update.localizedCallerName = payload.unitLabel.isEmpty
            ? payload.intercomName
            : "\(payload.intercomName) · \(payload.unitLabel)"
        update.hasVideo = payload.hasVideo
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false

        provider.reportNewIncomingCall(with: uuid, update: update) { error in
            if let error {
                print("[Call] reportNewIncomingCall error: \(error.localizedDescription)")
                self.cleanup(.ended)
            }
        }
    }

    /// Awaryjne zgłoszenie+zakończenie gdy VoIP payload niepoprawny — spełnia
    /// wymóg iOS że KAŻDY VoIP push musi zgłosić CallKit.
    func reportAndEndInvalidCall() {
        let uuid = UUID()
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: "Domofon")
        provider.reportNewIncomingCall(with: uuid, update: update) { _ in
            self.provider.reportCall(with: uuid, endedAt: Date(), reason: .failed)
        }
    }

    // MARK: - Połączenie WYCHODZĄCE (mieszkaniec → stacja domofonowa)

    /// Błąd inicjowania połączenia ze stacją (np. brak domofonu / funkcja off)
    /// — HomeView może pokazać krótki alert. Czyszczone przy kolejnej próbie.
    private(set) var outboundError: String?

    /// Rejestr stacji z aktywnym mostem (multi-station). UI (GateActionSheet)
    /// pobiera przed wychodzącym: >1 stacja → wybór z nazwami, 1 → dzwoń od razu.
    /// Błąd sieci/starego backendu → pusta lista (dzwonimy bez intercomId — jak dotąd).
    func loadStations() async -> [IntercomStation] {
        (try? await client.stations()) ?? []
    }

    /// „Podgląd bramy / Połącz z domofonem" — mieszkaniec inicjuje połączenie do
    /// stacji domofonowej. POST /resident/intercom/call-station → Cloud tworzy
    /// sesję + zleca Edge `INTERCOM_CALL_STATION` (Janus zadzwoni do Akuvoxa z
    /// Auto Answer). Apka jest tu OFFERER-em (odwrotnie niż przy przychodzącym).
    ///
    /// Multi-station: `intercomId` wybiera stację (z GET /stations). Bez niego
    /// Cloud dzwoni do jedynej stacji (1-stacyjna instalacja = jak dotąd), a przy
    /// >1 stacji zwraca 400 STATION_CHOICE_REQUIRED — UI powinno najpierw wołać
    /// `loadStations()` i pokazać wybór.
    func startOutboundCall(intercomId: Int? = nil) {
        guard activeSession == nil else { return } // już w połączeniu
        outboundError = nil
        Task { [weak self] in
            guard let self else { return }
            do {
                struct Body: Encodable { let intercomId: Int? }
                struct Resp: Decodable { let sessionId: String; let intercomName: String? }
                let resp: Resp = try await APIClient.shared.post(
                    "/resident/intercom/call-station", body: Body(intercomId: intercomId))
                await MainActor.run {
                    self.beginOutbound(sessionId: resp.sessionId, name: resp.intercomName ?? "Domofon")
                }
            } catch {
                let msg = (error as? APIError).map(Self.describe) ?? error.localizedDescription
                print("[Call] call-station błąd: \(msg)")
                await MainActor.run { self.outboundError = msg }
            }
        }
    }

    private static func describe(_ e: APIError) -> String {
        switch e {
        case .httpError(_, let m):
            // Backend zwraca JSON ({ message, code, ... }) — wyciągnij czytelny
            // komunikat (np. „Stacja zajęta — trwa inne połączenie").
            if let data = m.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msg = obj["message"] as? String, !msg.isEmpty {
                return msg
            }
            return m.isEmpty ? "Nie udało się połączyć ze stacją" : m
        default: return "Nie udało się połączyć ze stacją"
        }
    }

    /// Rozpocznij wychodzące: zarejestruj CallKit jako połączenie wychodzące i
    /// odpal handshake jako offerer (w `CXStartCallAction`).
    @MainActor
    private func beginOutbound(sessionId: String, name: String) {
        let uuid = UUID()
        currentCallUUID = uuid
        currentSessionId = sessionId
        isOutbound = true
        // Syntetyczny payload (IntercomCallView czyta intercomName); OUTBOUND →
        // ekran połączenia prezentuje się przez .fullScreenCover (activeSession != nil).
        activeSession = IntercomVoipPayload([
            "sessionId": sessionId, "intercomName": name,
            "unitLabel": "", "snapshotUrl": "", "hasVideo": true,
        ])
        callState = .connecting
        let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: name))
        action.isVideo = true
        callController.request(CXTransaction(action: action)) { error in
            if let error { print("[Call] startCall request error: \(error.localizedDescription)") }
        }
    }

    // MARK: - Akcje użytkownika (z IntercomCallView)

    func answer() {
        guard let uuid = currentCallUUID else { return }
        let action = CXAnswerCallAction(call: uuid)
        callController.request(CXTransaction(action: action)) { error in
            if let error { print("[Call] answer request error: \(error.localizedDescription)") }
        }
    }

    func decline() {
        endCall(reason: .declinedElsewhere, notifyCloud: true)
    }

    func hangup() {
        endCall(reason: .remoteEnded, notifyCloud: true)
    }

    func toggleMute() {
        isMuted.toggle()
        #if canImport(WebRTC)
        localAudioTrack?.isEnabled = !isMuted
        #endif
    }

    func toggleSpeaker() {
        isSpeaker.toggle()
        #if canImport(WebRTC)
        // Zmiana routingu pod blokadą RTCAudioSession (libwebrtc trzyma sesję).
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.lockForConfiguration()
        try? rtcSession.overrideOutputAudioPort(isSpeaker ? .speaker : .none)
        rtcSession.unlockForConfiguration()
        #else
        let session = AVAudioSession.sharedInstance()
        try? session.overrideOutputAudioPort(isSpeaker ? .speaker : .none)
        #endif
    }

    /// „Otwórz" — otwiera elektrozaczep domofonu z którego dzwoni gość.
    /// POST /resident/intercom/calls/:id/open (Cloud → Edge relay). Działa też
    /// w trakcie dzwonienia (można wpuścić bez odbierania).
    func openDoor() {
        guard let sid = currentSessionId, !isOpening else { return }
        isOpening = true
        Task { [weak self] in
            guard let self else { return }
            do {
                struct OpenResp: Decodable { let success: Bool; let label: String? }
                let _: OpenResp = try await APIClient.shared.post(
                    "/resident/intercom/calls/\(sid)/open", body: [String: String]())
                await MainActor.run {
                    self.isOpening = false
                    self.doorOpened = true
                }
                print("[Call] OTWARTO ✓")
                // Po 3 s schowaj potwierdzenie (gdyby połączenie trwało dłużej).
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                await MainActor.run { self.doorOpened = false }
            } catch {
                await MainActor.run { self.isOpening = false }
                print("[Call] open błąd: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Wewnętrzne

    private func endCall(reason: CXCallEndedReason, notifyCloud: Bool) {
        if notifyCloud, let sid = currentSessionId {
            Task { try? await client.hangup(sessionId: sid) }
        }
        if let uuid = currentCallUUID {
            let action = CXEndCallAction(call: uuid)
            callController.request(CXTransaction(action: action)) { _ in }
        }
        cleanup(.ended)
    }

    private func cleanup(_ state: CallState) {
        signalingTask?.cancel()
        signalingTask = nil
        snapshotTask?.cancel()
        snapshotTask = nil
        snapshotImage = nil
        isOpening = false
        doorOpened = false
        #if canImport(WebRTC)
        // Pełen teardown: wyłącz tracki, zamknij peer connection, oddaj audio.
        localAudioTrack?.isEnabled = false
        localAudioTrack = nil
        remoteVideoTrack = nil
        pendingRemoteCandidates.removeAll()
        hasRemoteDescription = false
        appliedOfferSdp = nil
        peerConnection?.close()
        peerConnection = nil
        // Oddaj sesję audio (CallKit didDeactivate też to robi, ale przy
        // hangup/cancel bez CallKit-deactivate musimy posprzątać sami).
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        #endif
        callState = state
        activeSession = nil
        currentCallUUID = nil
        currentSessionId = nil
        isOutbound = false
        outboundError = nil
        isMuted = false
    }

    // MARK: - Snapshot kamery gościa (hybrydowe wideo)

    /// Pętla pollingu snapshotu — odpowiednik działającego `MiniCameraPreview`
    /// z GateActionSheet, ale wołana z CallManager (pewność uruchomienia).
    /// Edge skaluje klatkę do żądanej szerokości/jakości PRZED wysłaniem, więc
    /// na komórce ciągniemy mały obraz wolniej, a na WiFi większy i płynniej.
    /// 204/błąd = zostawiamy ostatnią klatkę (bez migotania).
    private func startSnapshotPolling(sessionId: String) {
        snapshotTask?.cancel()
        snapshotTask = Task { [weak self] in
            guard let self else { return }
            print("[Call] snapshot polling START session=\(sessionId)")
            // 2 równoległe workery trzymają 2 żądania „w locie" → klatki
            // przychodzą ~2× częściej. Realny limiter to latencja snapshotu
            // Akuvoxa (round-tripy iOS→Cloud→Edge się nakładają), nie sleep.
            await withTaskGroup(of: Void.self) { group in
                for _ in 0..<2 {
                    group.addTask { [weak self] in
                        await self?.snapshotWorker(sessionId: sessionId)
                    }
                }
            }
            print("[Call] snapshot polling STOP")
        }
    }

    /// Pojedynczy worker pętli snapshotu. Mniejszy obraz = szybszy fetch i mniej
    /// transferu (LTE). Pojedynczy fail = cichy retry. Edge skaluje serwerowo.
    private func snapshotWorker(sessionId: String) async {
        while !Task.isCancelled {
            // Pełnoekranowy podgląd (Glass Depth) → wyższa rozdzielczość niż dawny
            // mały kafel, żeby nie pikselowało. Grade/winieta maskuje resztę.
            let cell = self.onCellular
            let width = cell ? 480 : 640
            let quality = cell ? 48 : 56
            do {
                let data = try await APIClient.shared.getRawData(
                    "/resident/intercom/calls/\(sessionId)/snapshot?w=\(width)&q=\(quality)")
                if !data.isEmpty, let img = UIImage(data: data) {
                    await MainActor.run { self.snapshotImage = img }
                }
            } catch {
                // Pojedynczy fail nie jest błędem dla usera — kolejny poll spróbuje.
            }
            // Mały odstęp żeby nie zalać Edge/Akuvoxa; z 2 workerami FPS ~2×.
            try? await Task.sleep(nanoseconds: cell ? 200_000_000 : 60_000_000)
        }
    }

    // MARK: - WebRTC handshake (Faza C)

    /// Zestawia WebRTC po odebraniu. Bez zależności WebRTC = stub-log.
    ///
    /// Flow (Faza C, libwebrtc stasel/WebRTC):
    ///   1. dociągnij iceServers z Cloud (STUN + TURN HMAC creds),
    ///   2. zbuduj RTCPeerConnection (unifiedPlan),
    ///   3. transceiver audio .sendRecv (mikrofon↑ + audio gościa↓),
    ///   4. transceiver wideo .recvOnly (gość↓; iPhone NIE publikuje kamery = 1-way),
    ///   5. uruchom pętlę sygnalizacji: POST answer (D5) + SSE; Janus jest
    ///      offererem → przy `offer` z Edge generujemy answer (applyRemoteSignal).
    private func startWebRTC(sessionId: String) {
        #if canImport(WebRTC)
        // RTCAudioSession w trybie manualnym — to CallKit (didActivate) aktywuje
        // sesję audio, nie WebRTC. Obowiązkowy punkt styku CallKit↔WebRTC.
        RTCAudioSession.sharedInstance().useManualAudio = true
        RTCAudioSession.sharedInstance().isAudioEnabled = false

        signalingTask = Task { [weak self] in
            guard let self else { return }
            // Krok 1: ICE servers (creds krótkożyciowe — dociągamy tuż przed handshake).
            var iceServers: [RTCIceServer] = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
            do {
                let resp = try await self.client.iceServers(sessionId: sessionId)
                iceServers = resp.iceServers.map { s in
                    if let user = s.username, let cred = s.credential {
                        // TURN (turns:443 TLS) — stasel/WebRTC ma własny, wkompilowany
                        // zestaw CA (nie systemowy iOS) i odrzucał nasz cert Let's Encrypt
                        // (TLS alert → coturn "buffer operation error"). Serwer TURN jest
                        // nasz, autoryzują go creds HMAC, więc pomijamy walidację certu.
                        return RTCIceServer(urlStrings: s.urls, username: user, credential: cred,
                                            tlsCertPolicy: .insecureNoCheck)
                    }
                    return RTCIceServer(urlStrings: s.urls)
                }
                print("[Call] iceServers: \(iceServers.count) server(s), turn=\(resp.turnSource ?? "?")")
            } catch {
                print("[Call] iceServers fetch failed (\(error.localizedDescription)) — STUN only")
            }

            await MainActor.run { self.buildPeerConnection(iceServers: iceServers) }
            await self.runSignaling(sessionId: sessionId)
        }
        #else
        // Bez WebRTC: nadal robimy answer + SSE (np. odbierzemy cancel D5), ale
        // bez zestawiania media. CallKit pozostaje aktywne (audio-only placeholder).
        print("[Call] WebRTC framework niedostępny — sygnalizacja bez media (stub)")
        signalingTask = Task { await runSignaling(sessionId: sessionId) }
        callState = .active
        #endif
    }

    /// Zestawia WebRTC dla połączenia WYCHODZĄCEGO: iPhone jest OFFERER-em.
    /// 1. iceServers, 2. peer + transceivery (asOfferer), 3. createOffer →
    /// sendSignal(offer), 4. SSE: answer od Akuvoxa (przez Janus) → applyRemoteSignal.
    private func startWebRTCAsOfferer(sessionId: String) {
        #if canImport(WebRTC)
        RTCAudioSession.sharedInstance().useManualAudio = true
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        signalingTask = Task { [weak self] in
            guard let self else { return }
            let iceServers = await self.resolveIceServers(sessionId: sessionId)
            await MainActor.run { self.buildPeerConnection(iceServers: iceServers, asOfferer: true) }
            await self.makeOfferAndSignal(sessionId: sessionId)
        }
        #else
        print("[Call] WebRTC niedostępny — outbound bez media (stub)")
        callState = .active
        #endif
    }

    #if canImport(WebRTC)
    /// Dociąga iceServers (STUN + TURN HMAC, `tlsCertPolicy:.insecureNoCheck` dla
    /// naszego coturn). Wspólne dla outbound; przy błędzie sam STUN.
    private func resolveIceServers(sessionId: String) async -> [RTCIceServer] {
        var iceServers: [RTCIceServer] = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
        do {
            let resp = try await self.client.iceServers(sessionId: sessionId)
            iceServers = resp.iceServers.map { s in
                if let user = s.username, let cred = s.credential {
                    return RTCIceServer(urlStrings: s.urls, username: user, credential: cred,
                                        tlsCertPolicy: .insecureNoCheck)
                }
                return RTCIceServer(urlStrings: s.urls)
            }
            print("[Call] iceServers(out): \(iceServers.count) server(s), turn=\(resp.turnSource ?? "?")")
        } catch {
            print("[Call] iceServers(out) failed (\(error.localizedDescription)) — STUN only")
        }
        return iceServers
    }

    /// Wygeneruj ofertę, wyślij do Edge, słuchaj SSE (answer od Akuvoxa). Brak
    /// POST `answer` (to ścieżka przychodzących) — my dajemy ofertę i czekamy.
    private func makeOfferAndSignal(sessionId: String) async {
        guard let pc = peerConnection else {
            print("[Call] makeOffer: brak peerConnection"); return
        }
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        do {
            let offer = try await pc.offer(for: constraints)
            try await pc.setLocalDescription(offer)
            print("[Call] OUTBOUND offer audio dir: \(Self.audioDirection(in: offer.sdp))")
            try? await client.sendSignal(IntercomSignal(
                sessionId: sessionId, kind: "offer", sdp: offer.sdp, candidate: nil, from: "app"))
        } catch {
            print("[Call] makeOffer błąd: \(error.localizedDescription)"); return
        }
        do {
            for try await batch in client.signalStream(sessionId: sessionId) {
                for sig in batch.signals ?? [] { await applyRemoteSignal(sig) }
            }
        } catch {
            print("[Call] outbound signaling error: \(error.localizedDescription)")
        }
    }
    #endif

    #if canImport(WebRTC)
    /// Buduje RTCPeerConnection + transceivery (audio sendRecv, wideo recvOnly).
    /// Wołane na MainActor (peerConnection dotykane też z delegate'a/UI).
    ///
    /// `asOfferer=true` (połączenie WYCHODZĄCE — mieszkaniec dzwoni do stacji):
    /// to MY definiujemy m-linie, więc sami dodajemy transceivery (audio sendRecv
    /// + wideo recvOnly). W trybie answerer (`false`, przychodzące) transceivery
    /// powstają z oferty Janusa — patrz komentarz niżej.
    private func buildPeerConnection(iceServers: [RTCIceServer], asOfferer: Bool = false) {
        let config = RTCConfiguration()
        config.iceServers = iceServers
        config.sdpSemantics = .unifiedPlan
        // Zbieraj wszystkich kandydatów (host/srflx/relay) — off-site potrzebuje relay.
        config.continualGatheringPolicy = .gatherContinually
        // Na komórce (LTE): TYLKO relay. Operator blokuje UDP i wsadza telefon za
        // symetryczny CGNAT — host/srflx (oraz śmieci typu Tailscale/link-local) nie
        // łączą się i pollują ICE tak, że relay nie zdąży zanim Akuvox rozłączy.
        // Tryb relay-only → jeden kandydat (relay) → od razu para relay↔relay przez
        // coturn. Na WiFi zostawiamy .all (host = natychmiast, bez nadkładania przez FRA).
        // Na komórce: tylko relay (off-site). Na WiFi: .all (on-site host = szybkie,
        // sprawdzone). Relay przez TURN/TCP na surowym 3478 NIE działa u operatora
        // (iPhone odbiera ale nie nadaje) — docelowo TURN/TLS 443 to naprawia.
        config.iceTransportPolicy = onCellular ? .relay : .all
        print("[Call] iceTransportPolicy=\(onCellular ? "RELAY-ONLY (LTE)" : "all (WiFi)") — onCellular=\(onCellular)")
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            print("[Call] peerConnection() zwrócił nil — przerywam media")
            return
        }
        peerConnection = pc

        // Audio track (mikrofon mieszkańca↑). NIE pre-addujemy transceivera —
        // pre-added bywa osierocony po setRemoteDescription (Janus tworzy własny
        // m-line audio recvonly) → są 2 audio transceivery i answer wychodzi
        // recvonly. Zamiast tego transceivery powstają z oferty Janusa, a mikrofon
        // + sendRecv podpinamy w applyRemoteSignal do tego JEDNEGO właściwego.
        let audioSource = Self.factory.audioSource(with:
            RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let audioTrack = Self.factory.audioTrack(with: audioSource, trackId: "gl_audio0")
        audioTrack.isEnabled = !isMuted
        localAudioTrack = audioTrack

        if asOfferer {
            // Offerer: brak oferty Janusa do oparcia transceiverów → tworzymy sami.
            // Audio sendRecv = mikrofon mieszkańca↑ + audio bramy↓; wideo recvOnly =
            // podgląd wejścia↓ (iPhone NIE publikuje kamery). Akuvox z Auto Answer
            // odpowie swoim audio (+ wideo, choć render i tak idzie ze snapshotów).
            let audioInit = RTCRtpTransceiverInit()
            audioInit.direction = .sendRecv
            _ = pc.addTransceiver(with: audioTrack, init: audioInit)
            let videoInit = RTCRtpTransceiverInit()
            videoInit.direction = .recvOnly
            _ = pc.addTransceiver(of: .video, init: videoInit)
        }
    }
    #endif

    /// Pętla sygnalizacji: POST answer (D5 first-answer-wins) + subskrypcja SSE.
    /// SSE i obsługa cancel są niezależne od WebRTC; samo zastosowanie SDP/ICE
    /// do peera jest za `#if canImport(WebRTC)` w applyRemoteSignal.
    private func runSignaling(sessionId: String) async {
        do {
            // First-answer-wins: gdy `won == false` to inne urządzenie odebrało
            // wcześniej — kończymy CallKit lokalnie i nie zestawiamy media.
            let won = try await client.answer(sessionId: sessionId)
            if !won {
                print("[Call] answer: inne urządzenie już odebrało — kończę lokalnie")
                await MainActor.run { self.endCall(reason: .answeredElsewhere, notifyCloud: false) }
                return
            }
            // Subskrybuj strumień Edge→app (offer/answer/ICE/cancel).
            for try await batch in client.signalStream(sessionId: sessionId) {
                for sig in batch.signals ?? [] {
                    await applyRemoteSignal(sig)
                }
            }
        } catch {
            print("[Call] signaling error: \(error.localizedDescription)")
        }
    }

    /// Zastosuj sygnał przychodzący z Edge (przez Cloud SSE).
    ///  - cancel (D5/timeout) → zakończ CallKit lokalnie.
    ///  - offer/answer/ice    → przekaż do WebRTC peera (Faza C).
    private func applyRemoteSignal(_ sig: IntercomSignal) async {
        // CANCEL: candidate.cancel==true → ktoś inny odebrał / timeout / koniec.
        if sig.kind == "ice", sig.candidate?.cancel == true {
            let reason = sig.candidate?.reason ?? "?"
            print("[Call] remote cancel: \(reason)")
            await MainActor.run {
                self.endCall(reason: .answeredElsewhere, notifyCloud: false)
                // Multi-station: most zajęty (Edge złapał race po utworzeniu
                // sesji) — czytelny komunikat PO cleanup (cleanup zeruje pole).
                if reason == "STATION_BUSY" {
                    self.outboundError = "Stacja zajęta — trwa inne połączenie. Spróbuj za chwilę."
                }
            }
            return
        }
        #if canImport(WebRTC)
        guard let pc = peerConnection else { return }
        switch sig.kind {
        case "offer", "answer":
            guard let sdp = sig.sdp else { return }
            // Dedup: SSE potrafi przysłać tę samą ofertę 2× — ponowny
            // setRemoteDescription restartuje ICE i gubi zebrane pary.
            if sig.kind == "offer", appliedOfferSdp == sdp {
                print("[Call] remote offer (duplikat) — pomijam")
                return
            }
            print("[Call] remote \(sig.kind) received (\(sdp.count) B)")
            let desc = RTCSessionDescription(type: sig.kind == "offer" ? .offer : .answer, sdp: sdp)
            do { try await pc.setRemoteDescription(desc) }
            catch { print("[Call] setRemoteDescription error: \(error.localizedDescription)"); return }
            if sig.kind == "offer" {
                appliedOfferSdp = sdp
                print("[Call] offer audio dir: \(Self.audioDirection(in: sdp))")
            }
            hasRemoteDescription = true
            // Dosyp kandydatów które przyszły przed remoteDescription.
            if !pendingRemoteCandidates.isEmpty {
                print("[Call] flush \(pendingRemoteCandidates.count) buforowanych kandydatów")
                for cand in pendingRemoteCandidates { try? await pc.add(cand) }
                pendingRemoteCandidates.removeAll()
            }
            // Gdy dostaliśmy offer (nasz flow — Janus offerer) → wygeneruj answer.
            if sig.kind == "offer", let sid = currentSessionId {
                // Janus oferuje sendrecv, ale answer wychodził `recvonly` (mikrofon
                // nie nadawał, tylko 4 KB RTCP w górę). Pre-added transceiver bywa
                // degradowany po setRemoteDescription — wymuszamy sendRecv i pewność
                // że mikrofon jest podpięty do sendera PRZED wygenerowaniem answer.
                if let audioTx = pc.transceivers.first(where: { $0.mediaType == .audio }) {
                    if audioTx.sender.track == nil, let t = localAudioTrack { audioTx.sender.track = t }
                    audioTx.setDirection(.sendRecv, error: nil)
                    print("[Call] audio transceiver → sendRecv (track=\(audioTx.sender.track != nil))")
                }
                let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
                if let answer = try? await pc.answer(for: constraints) {
                    print("[Call] answer audio dir: \(Self.audioDirection(in: answer.sdp))")
                    try? await pc.setLocalDescription(answer)
                    try? await client.sendSignal(IntercomSignal(
                        sessionId: sid, kind: "answer", sdp: answer.sdp, candidate: nil, from: "app"))
                }
            }
        case "ice":
            guard let c = sig.candidate, c.isRealCandidate, let cand = c.candidate else { return }
            let typ = cand.components(separatedBy: " ").drop(while: { $0 != "typ" }).dropFirst().first ?? "?"
            let ice = RTCIceCandidate(sdp: cand, sdpMLineIndex: c.sdpMLineIndex ?? 0, sdpMid: c.sdpMid)
            // Bez remoteDescription `pc.add` jest odrzucany → buforuj na później.
            if hasRemoteDescription {
                print("[Call] remote cand: typ=\(typ)")
                try? await pc.add(ice)
            } else {
                print("[Call] remote cand: typ=\(typ) (buforuję — brak remoteDescription)")
                pendingRemoteCandidates.append(ice)
            }
        default:
            break
        }
        #endif
    }

    // MARK: - Audio session

    /// Konfiguracja kategorii audio (playAndRecord / voiceChat). Z WebRTC robimy
    /// to przez RTCAudioSession (lock + configureWebRTCSession), żeby libwebrtc i
    /// CallKit nie biły się o sesję. Realna AKTYWACJA następuje w didActivate.
    private func configureAudioSession() {
        #if canImport(WebRTC)
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.lockForConfiguration()
        let config = RTCAudioSessionConfiguration.webRTC()
        config.category = AVAudioSession.Category.playAndRecord.rawValue
        config.mode = AVAudioSession.Mode.voiceChat.rawValue
        config.categoryOptions = [.allowBluetooth]
        try? rtcSession.setConfiguration(config)
        rtcSession.unlockForConfiguration()
        #else
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
        try? session.overrideOutputAudioPort(isSpeaker ? .speaker : .none)
        #endif
    }

    /// Wyciąga kierunek (`sendrecv`/`sendonly`/`recvonly`/`inactive`) z sekcji
    /// `m=audio` w SDP — diagnostyka czy iPhone ma nadawać mikrofon.
    static func audioDirection(in sdp: String) -> String {
        var inAudio = false
        for line in sdp.components(separatedBy: "\n") {
            if line.hasPrefix("m=") { inAudio = line.hasPrefix("m=audio") }
            if inAudio {
                for d in ["sendrecv", "sendonly", "recvonly", "inactive"] where line.hasPrefix("a=\(d)") {
                    return d
                }
            }
        }
        return "?"
    }
}

// MARK: - CXProviderDelegate

extension CallManager: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        cleanup(.idle)
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let sid = currentSessionId else { action.fail(); return }
        callState = .connecting
        configureAudioSession()
        startWebRTC(sessionId: sid)
        startSnapshotPolling(sessionId: sid)
        action.fulfill()
    }

    /// Połączenie WYCHODZĄCE (mieszkaniec dzwoni do stacji). Konfiguruje audio,
    /// odpala WebRTC jako offerer + polling snapshotu. CallKit pokazuje wychodzące.
    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard let sid = currentSessionId else { action.fail(); return }
        callState = .connecting
        configureAudioSession()
        startWebRTCAsOfferer(sessionId: sid)
        startSnapshotPolling(sessionId: sid)
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if let sid = currentSessionId {
            Task { try? await client.hangup(sessionId: sid) }
        }
        cleanup(.ended)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        isMuted = action.isMuted
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // CallKit aktywował sesję audio — DOPIERO TERAZ wolno włączyć audio WebRTC
        // (manualAudio). To obowiązkowy punkt styku CallKit↔WebRTC: aktywacja
        // przed tym callbackiem powoduje że media nie płynie / system ją zabija.
        #if canImport(WebRTC)
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.audioSessionDidActivate(audioSession)
        rtcSession.isAudioEnabled = true
        try? audioSession.overrideOutputAudioPort(isSpeaker ? .speaker : .none)
        #endif
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        #if canImport(WebRTC)
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.audioSessionDidDeactivate(audioSession)
        rtcSession.isAudioEnabled = false
        #endif
    }
}

#if canImport(WebRTC)
// MARK: - RTCPeerConnectionDelegate (Faza C — szkielet)

extension CallManager: RTCPeerConnectionDelegate {
    func peerConnection(_ pc: RTCPeerConnection, didChange state: RTCSignalingState) {}
    func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let names = ["new","checking","connected","completed","failed","disconnected","closed","count"]
        print("[Call] ICE state → \(names.indices.contains(newState.rawValue) ? names[newState.rawValue] : String(newState.rawValue))")
        if newState == .connected || newState == .completed {
            DispatchQueue.main.async {
                self.callState = .active
                // Wychodzące: zgłoś CallKit „connected" (timer połączenia rusza).
                if self.isOutbound, let uuid = self.currentCallUUID {
                    self.provider.reportOutgoingCall(with: uuid, connectedAt: Date())
                }
            }
        }
    }
    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        let g = ["new","gathering","complete"]
        print("[Call] ICE gathering → \(g.indices.contains(newState.rawValue) ? g[newState.rawValue] : String(newState.rawValue))")
    }
    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        guard let sid = currentSessionId else { return }
        let ice = IntercomIceCandidate(
            candidate: candidate.sdp,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex
        )
        Task { try? await client.sendSignal(IntercomSignal(sessionId: sid, kind: "ice", sdp: nil, candidate: ice, from: "app")) }
    }
    func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {}

    /// Unified Plan: zdalny track gościa pojawia się przez receiver. Łapiemy
    /// wideo (gość→mieszkaniec) i publikujemy do UI; audio gra automatycznie.
    func peerConnection(_ pc: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams: [RTCMediaStream]) {
        if let video = rtpReceiver.track as? RTCVideoTrack {
            DispatchQueue.main.async { self.remoteVideoTrack = video }
        }
    }

    /// Wariant zdarzenia przy negocjacji transceiverów (niektóre wersje libwebrtc).
    func peerConnection(_ pc: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
        if transceiver.mediaType == .video, let video = transceiver.receiver.track as? RTCVideoTrack {
            DispatchQueue.main.async { self.remoteVideoTrack = video }
        }
    }
}
#endif

// MARK: - IntercomCallClient — sygnalizacja przez Cloud (HTTPS + SSE)
//
// Wszystkie endpointy: /api/resident/intercom/... (guard jwt-resident,
// za flagą INTERCOM_CALL_ENABLED). JWT z Keychain jak APIClient.
// docs/intercom-akuvox-call.md sekcja 5.

final class IntercomCallClient {
    private var baseURL: String { APIClient.shared.baseURL }
    private var token: String? { KeychainHelper.load(forKey: KeychainHelper.tokenKey) }

    private func request(_ path: String, method: String, body: Encodable? = nil) async throws {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try JSONEncoder().encode(AnyEncodable(body)) }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.networkError(URLError(.badServerResponse))
        }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if !(200..<300).contains(http.statusCode) {
            let msg = String(data: data, encoding: .utf8) ?? "\(http.statusCode)"
            throw APIError.httpError(http.statusCode, msg)
        }
    }

    /// Rejestracja VoIP tokenu (PushKit) — wołane przez AuthManager po loginie.
    func registerVoipToken(_ voipToken: String, environment: String) async throws {
        struct Body: Encodable { let token: String; let environment: String }
        try await request("/resident/intercom/voip-token", method: "POST",
                          body: Body(token: voipToken, environment: environment))
    }

    /// Odbierz połączenie. Zwraca `won` (D5 first-answer-wins): false = inne
    /// urządzenie już odebrało. Cloud zwraca `{ ok, state, won }`.
    func answer(sessionId: String) async throws -> Bool {
        struct Resp: Decodable { let won: Bool? }
        let resp: Resp = try await requestJSON("/resident/intercom/calls/\(sessionId)/answer", method: "POST")
        return resp.won ?? true
    }
    func decline(sessionId: String) async throws {
        try await request("/resident/intercom/calls/\(sessionId)/decline", method: "POST")
    }
    func hangup(sessionId: String) async throws {
        try await request("/resident/intercom/calls/\(sessionId)/hangup", method: "POST")
    }
    func sendSignal(_ signal: IntercomSignal) async throws {
        try await request("/resident/intercom/calls/\(signal.sessionId)/signal", method: "POST", body: signal)
    }

    /// Dociągnij ICE servers (STUN + TURN z krótkożyciowymi creds) dla sesji.
    /// Wołane tuż przed zestawieniem RTCPeerConnection. Brak TURN → tylko STUN.
    func iceServers(sessionId: String) async throws -> IntercomIceServers {
        try await requestJSON("/resident/intercom/calls/\(sessionId)/ice-servers", method: "GET")
    }

    /// Multi-station: rejestr stacji z aktywnym mostem (GET /resident/intercom/stations).
    /// >1 stacja → UI pokazuje wybór z nazwami przed POST call-station.
    func stations() async throws -> [IntercomStation] {
        struct Resp: Decodable { let stations: [IntercomStation] }
        let resp: Resp = try await requestJSON("/resident/intercom/stations", method: "GET")
        return resp.stations
    }

    /// Wariant request zwracający zdekodowane body.
    private func requestJSON<T: Decodable>(_ path: String, method: String, body: Encodable? = nil) async throws -> T {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = try JSONEncoder().encode(AnyEncodable(body)) }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.networkError(URLError(.badServerResponse)) }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if !(200..<300).contains(http.statusCode) {
            throw APIError.httpError(http.statusCode, String(data: data, encoding: .utf8) ?? "\(http.statusCode)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// SSE: strumień sygnalizacji Edge→app (GET .../signal/stream).
    /// Parsuje linie `data: {json}` na IntercomSignalBatch. Strumień żyje do
    /// zakończenia połączenia (CallManager przerywa Task przy cleanup) albo
    /// rozłączenia przez serwer. Spójne z resztą resident API (HTTPS, bez WS).
    func signalStream(sessionId: String) -> AsyncThrowingStream<IntercomSignalBatch, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let url = URL(string: baseURL + "/resident/intercom/calls/\(sessionId)/signal/stream") else {
                        throw APIError.invalidURL
                    }
                    var req = URLRequest(url: url)
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        throw APIError.httpError(http.statusCode, "SSE \(http.statusCode)")
                    }
                    let decoder = JSONDecoder()
                    for try await line in bytes.lines {
                        // Format SSE: "data: {json}". Ignorujemy puste linie/komentarze.
                        guard line.hasPrefix("data:") else { continue }
                        let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        guard !json.isEmpty, let d = json.data(using: .utf8) else { continue }
                        if let batch = try? decoder.decode(IntercomSignalBatch.self, from: d) {
                            continuation.yield(batch)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Multi-station (2026-07-05): stacja domofonowa z aktywnym mostem rozmów.
/// Kształt z GET /resident/intercom/stations — id = building_intercoms.id (Cloud),
/// name = czytelna nazwa („Wejście główne") pokazywana w wyborze i CallKit.
struct IntercomStation: Decodable, Identifiable {
    let id: Int
    let name: String
}

/// Type-erasing wrapper żeby Encodable body dało się zakodować bez generyka.
private struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init(_ wrapped: Encodable) { encodeFn = wrapped.encode }
    func encode(to encoder: Encoder) throws { try encodeFn(encoder) }
}
