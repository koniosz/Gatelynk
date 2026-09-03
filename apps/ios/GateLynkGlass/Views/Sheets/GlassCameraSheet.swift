import SwiftUI

// MARK: - Sheet „Podgląd" — kamera domofonu (PROMPT 2)
//
// Port `cameraSheet()` z `Glass Depth Premium.html`:
//   • duży kadr (radius 18, ~190pt) — REALNE snapshoty kamery domofonu,
//     ten sam mechanizm co MiniCameraPreview / hybrydowe wideo rozmowy:
//     GET /resident/access-points/:id/snapshot?live=1 (Cloud proxy →
//     Edge → Akuvox), polling co ~1.5 s;
//   • nakładki gradient góra/dół dla czytelności;
//   • badge „● NA ŻYWO" (#FF3B30, migająca kropka 1.2 s) w lewym górnym;
//   • znacznik czasu tabular-nums w prawym dolnym;
//   • przycisk „Połącz z domofonem" → flow rozmowy (startOutboundCall /
//     picker stacji przy >1 — obsługuje GlassHomeView.startIntercomFlow).
//
// Źródło kadru: AKTYWNY punkt dostępu decka (2026-07-10) — kamera podąża
// za sekcją: „Wjazd" → domofon R29, „Wyjazd" → domofon E18. Snapshot i tak
// rozwiązuje kamerę po AccessPoint.id → deviceId → Akuvox GetSnapshot/RTSP,
// więc wystarczy podać właściwy punkt (wcześniej sheet na sztywno brał
// pierwszy AP z „wjazd" w nazwie → zawsze ten sam obraz).

struct GlassCameraSheet: View {
    /// Punkt dostępu aktywnej sekcji decka (jego domofon = źródło kadru).
    let accessPoint: AccessPoint
    let onConnectIntercom: () -> Void
    /// Otwarcie wejścia wprost z podglądu (2026-08-12) — hold 2 s jak na
    /// kaflach decka (mocne sygnały > subtelne animacje, anty-przypadkowe).
    let onOpen: (AccessPoint) async -> Bool
    let onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(GlassToastCenter.self) private var toast

    @State private var image: UIImage?
    @State private var failed = false
    @State private var blink = false
    @State private var now = Date()
    @State private var pollTask: Task<Void, Never>?

    // Live MJPEG (2026-08-12): strumień z Cloud proxy; polling snapshotów
    // zostaje jako siatka bezpieczeństwa (pierwsza klatka + fallback, gdy
    // strumień padnie — stary Edge / kaseta bez video.cgi i bez RTSP).
    @State private var streamLoader: MJPEGStreamLoader?
    @State private var streamAlive = false

    // Hold-to-open — stan przycisku „Otwórz".
    private enum OpenState: Equatable { case idle, busy, success, failure }
    @State private var openState: OpenState = .idle
    @State private var openPressing = false

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            GlassSheetHeader(
                kicker: "Podgląd",
                title: "Kamera — \(accessPoint.label.lowercased())",
                onClose: onClose
            )

            camView
                .padding(.bottom, 14)
                // FIX 2026-07-15: snapshot 4:3 z `.fill` WYSTAJE poza kadr
                // 190pt — clipShape przycina piksele, ale NIE hit-test.
                // Niewidoczny nadmiar obrazu zasłaniał ✕ w nagłówku
                // (dlatego „zamykanie krzyżykiem nie działa"). Kadr nie ma
                // żadnych elementów interaktywnych → wyłączamy mu hit-test.
                .allowsHitTesting(false)

            holdOpenButton
                .padding(.bottom, 8)

            GlassButton(title: "Połącz z domofonem", style: .ghost) {
                onConnectIntercom()
            }
        }
        .onAppear {
            startStream()
            startPolling()
            // UWAGA: NIE używać globalnego withAnimation(.repeatForever) —
            // taka transakcja „zaraża" inne animacje (m.in. zamknięcie sheetu
            // przez ✕ zapętlało się i wyglądało jak martwy przycisk).
            // Animacja jest zscope'owana do kropki w liveBadge (value: blink).
            if !reduceMotion { blink = true }
        }
        .onDisappear {
            pollTask?.cancel()
            streamLoader?.stop()
        }
        .onReceive(ticker) { now = $0 }
    }

    // MARK: Kadr (HTML .cam-view: 190pt, radius 18, gradienty, LIVE, czas)

    private var camView: some View {
        ZStack {
            Color.black

            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else if failed {
                VStack(spacing: 6) {
                    Image(systemName: "video.slash")
                        .font(.system(size: 26))
                        .foregroundStyle(.white.opacity(0.4))
                    Text("Brak podglądu")
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.55))
                }
            } else {
                ProgressView().tint(.white.opacity(0.7))
            }

            // Nakładka gradientowa góra/dół (HTML .cam-view::after)
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.35), location: 0),
                    .init(color: .clear, location: 0.32),
                    .init(color: .clear, location: 0.68),
                    .init(color: .black.opacity(0.55), location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )
            .allowsHitTesting(false)

            // Badge NA ŻYWO + timestamp
            VStack {
                HStack {
                    liveBadge
                    Spacer()
                }
                Spacer()
                HStack {
                    Spacer()
                    Text(Self.timestamp.string(from: now))
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.85))
                }
            }
            .padding(12)
        }
        .frame(height: 190)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
        }
    }

    /// „● NA ŻYWO" — czerwone tło rgba(255,59,48,.92), kropka miga 1.2 s
    /// (HTML @keyframes blink; reduceMotion → kropka stała).
    private var liveBadge: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(.white)
                .frame(width: 6, height: 6)
                .opacity(reduceMotion ? 1 : (blink ? 0.3 : 1))
                .animation(
                    reduceMotion ? nil : .easeInOut(duration: 0.6).repeatForever(autoreverses: true),
                    value: blink
                )
            Text("NA ŻYWO")
                .font(.system(size: 10.5, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background {
            Capsule().fill(Color(hex: 0xFF3B30).opacity(0.92))
        }
    }

    // MARK: Polling snapshotów (jak MiniCameraPreview, ~1.5 s)

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await fetchFrame(apId: accessPoint.id)
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
        }
    }

    private func fetchFrame(apId: Int) async {
        do {
            // ?live=1 omija 60 s cache Edge — świeża klatka przy każdym poll-u.
            let data = try await APIClient.shared.getRawData(
                "/resident/access-points/\(apId)/snapshot?live=1"
            )
            if let img = UIImage(data: data) {
                await MainActor.run {
                    image = img
                    failed = false
                }
            } else if image == nil {
                await MainActor.run { failed = true }
            }
        } catch {
            // Pojedynczy fail = cichy retry; bez klatki po błędzie → placeholder.
            if image == nil {
                await MainActor.run { failed = true }
            }
        }
    }

    // MARK: Przycisk „Otwórz" — hold 2 s (wzorzec z decka)

    private var holdOpenButton: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.08))
            // Zalew postępu przez pełne 2 s trzymania (mocny sygnał).
            GeometryReader { geo in
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(GlassColor.accentGradient)
                    .frame(width: openPressing ? geo.size.width : 0)
                    .animation(
                        openPressing ? .linear(duration: 2.0) : .easeOut(duration: 0.3),
                        value: openPressing
                    )
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

            HStack(spacing: 8) {
                switch openState {
                case .idle:
                    Image(systemName: "lock.open.fill").font(.system(size: 14, weight: .semibold))
                    Text(openPressing ? "Trzymaj…" : "Przytrzymaj, aby otworzyć")
                        .font(.system(size: 15, weight: .bold))
                case .busy:
                    ProgressView().tint(.white)
                    Text("Otwieram…").font(.system(size: 15, weight: .bold))
                case .success:
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 15, weight: .bold))
                    Text("Otwarto").font(.system(size: 15, weight: .bold))
                case .failure:
                    Image(systemName: "xmark.circle.fill").font(.system(size: 15, weight: .bold))
                    Text("Nie udało się — spróbuj ponownie").font(.system(size: 14, weight: .bold))
                }
            }
            .foregroundStyle(.white)
        }
        .frame(height: 52)
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(
                    openState == .success
                        ? Color(hex: 0x34D399).opacity(0.7)
                        : openState == .failure
                            ? Color(hex: 0xFF6B6B).opacity(0.7)
                            : Color.white.opacity(0.18),
                    lineWidth: 1
                )
        }
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .onTapGesture {
            // Krótki tap = podpowiedź (spójnie z kaflami decka).
            if openState == .idle { toast.show("Przytrzymaj 2 sekundy, aby otworzyć") }
        }
        .onLongPressGesture(minimumDuration: 2.0, maximumDistance: 60) {
            commitOpen()
        } onPressingChanged: { pressing in
            guard openState == .idle else { return }
            openPressing = pressing
            if pressing { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        }
        .accessibilityLabel("Otwórz \(accessPoint.label) — przytrzymaj 2 sekundy")
    }

    private func commitOpen() {
        guard openState == .idle else { return }
        openPressing = false
        openState = .busy
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        Task {
            let ok = await onOpen(accessPoint)
            await MainActor.run {
                openState = ok ? .success : .failure
                UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            }
            // Po chwili wracamy do stanu wyjściowego (można otworzyć ponownie).
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            await MainActor.run { openState = .idle }
        }
    }

    // MARK: Live MJPEG (2026-08-12)

    private func startStream() {
        guard streamLoader == nil else { return }
        guard let url = URL(string: APIClient.shared.baseURL + "/resident/access-points/\(accessPoint.id)/stream") else { return }
        let loader = MJPEGStreamLoader()
        loader.onFrame = { img in
            Task { @MainActor in
                image = img
                failed = false
                // Pierwsza klatka strumienia → polling przestaje być potrzebny.
                if !streamAlive {
                    streamAlive = true
                    pollTask?.cancel()
                }
            }
        }
        loader.onEnd = {
            Task { @MainActor in
                // Strumień padł (stary Edge / kaseta bez MJPEG / zerwane LTE)
                // → wracamy do pollingu snapshotów. Bez pętli reconnectu:
                // sheet żyje krótko, a polling i tak daje „prawie-live".
                guard streamAlive || pollTask == nil || pollTask!.isCancelled else { return }
                streamAlive = false
                startPolling()
            }
        }
        loader.start(url: url, token: KeychainHelper.load(forKey: KeychainHelper.tokenKey))
        streamLoader = loader
    }

    /// „07.07 · 22:14" — tabular-nums jak w HTML .cam-time.
    private static let timestamp: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "dd.MM · HH:mm:ss"
        return df
    }()
}

// MARK: - MJPEGStreamLoader — klient multipart/x-mixed-replace
//
// Minimalny czytnik MJPEG: URLSession streamuje bajty, my wycinamy z bufora
// kompletne JPEG-i po markerach SOI (FFD8) / EOI (FFD9) i oddajemy UIImage
// per klatka. Boundary celowo ignorujemy — markery wystarczają, a różne
// firmware Akuvox używają różnych boundary.

final class MJPEGStreamLoader: NSObject, URLSessionDataDelegate {
    var onFrame: ((UIImage) -> Void)?
    var onEnd: (() -> Void)?

    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var buffer = Data()

    func start(url: URL, token: String?) {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 15        // czas na PIERWSZE bajty
        cfg.timeoutIntervalForResource = 6 * 60   // > serwerowy limit 5 min
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        self.session = session
        var req = URLRequest(url: url)
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let task = session.dataTask(with: req)
        self.task = task
        task.resume()
    }

    func stop() {
        onFrame = nil
        onEnd = nil
        task?.cancel()
        session?.invalidateAndCancel()
        session = nil
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let ok = (response as? HTTPURLResponse)?.statusCode == 200
        completionHandler(ok ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        while
            let soi = buffer.range(of: Data([0xFF, 0xD8])),
            let eoi = buffer.range(of: Data([0xFF, 0xD9]), options: [], in: soi.upperBound..<buffer.endIndex)
        {
            let frame = buffer.subdata(in: soi.lowerBound..<eoi.upperBound)
            buffer.removeSubrange(buffer.startIndex..<eoi.upperBound)
            if let img = UIImage(data: frame) { onFrame?(img) }
        }
        // Ochrona przed rozjazdem parsera (śmieci bez EOI) — 3 MB to kilka
        // klatek FullHD; powyżej tniemy do ostatniego SOI.
        if buffer.count > 3_000_000 {
            if let soi = buffer.range(of: Data([0xFF, 0xD8]), options: .backwards) {
                buffer.removeSubrange(buffer.startIndex..<soi.lowerBound)
            } else {
                buffer.removeAll(keepingCapacity: true)
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onEnd?()
    }
}
