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
    /// Otwarcie wejścia wprost z podglądu — TEN SAM przycisk co na Domu
    /// (`AccessHoldButton`: nazwa celu, 2 s, realny wynik polecenia).
    let onOpen: (AccessPoint) async -> AccessOpenOutcome
    let onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(GlassToastCenter.self) private var toast

    @State private var image: UIImage?
    @State private var failed = false
    @State private var blink = false
    @State private var now = Date()
    /// Czas OSTATNIEJ odebranej klatki. Audyt UX 2026-09-21: plakietka
    /// „NA ŻYWO" świeciła zawsze, a znacznik czasu pokazywał zegar telefonu —
    /// stary obraz po zerwaniu łącza wyglądał jak transmisja.
    @State private var lastFrameAt: Date?
    @State private var pollTask: Task<Void, Never>?

    // Live MJPEG (2026-08-12): strumień z Cloud proxy; polling snapshotów
    // zostaje jako siatka bezpieczeństwa (pierwsza klatka + fallback, gdy
    // strumień padnie — stary Edge / kaseta bez video.cgi i bez RTSP).
    @State private var streamLoader: MJPEGStreamLoader?
    @State private var streamAlive = false

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

            AccessHoldButton(targetName: accessPoint.label) { await onOpen(accessPoint) }
                .padding(.bottom, 8)

            GlassButton(title: "Domofon — połącz z: \(accessPoint.label)", style: .ghost) {
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
                        .foregroundStyle(.white.opacity(0.5))
                    Text("Brak połączenia z kamerą")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.75))
                }
            } else {
                VStack(spacing: 8) {
                    ProgressView().tint(.white.opacity(0.7))
                    Text("Ładowanie obrazu…")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.white.opacity(0.7))
                }
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
                    feedBadge
                    Spacer()
                }
                Spacer()
                HStack {
                    Spacer()
                    // Czas KLATKI, nie zegar telefonu.
                    if let lastFrameAt {
                        Text(Self.timestamp.string(from: lastFrameAt))
                            .font(.system(size: 11.5).monospacedDigit())
                            .foregroundStyle(.white.opacity(0.9))
                            .accessibilityLabel("Obraz z godziny \(Self.timestamp.string(from: lastFrameAt))")
                    }
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

    /// Klatka jest „na żywo", gdy przyszła w ostatnich 5 s (strumień MJPEG
    /// albo polling co 1,5 s). Starsza = „Ostatni obraz" z godziną klatki.
    private var isLive: Bool {
        guard let lastFrameAt else { return false }
        return now.timeIntervalSince(lastFrameAt) < 5
    }

    @ViewBuilder
    private var feedBadge: some View {
        if image == nil {
            EmptyView()
        } else if isLive {
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
            // Zieleń = stan poprawny; czerwień rezerwujemy dla problemów.
            .background { Capsule().fill(GlassColor.success.opacity(0.9)) }
        } else {
            HStack(spacing: 6) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 10, weight: .bold))
                Text("OSTATNI OBRAZ — BRAK TRANSMISJI")
                    .font(.system(size: 10, weight: .bold))
                    .tracking(0.5)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background { Capsule().fill(Color(hex: 0xC78A2B).opacity(0.95)) }
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
                    lastFrameAt = Date()
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

    // MARK: Live MJPEG (2026-08-12)

    private func startStream() {
        guard streamLoader == nil else { return }
        guard let url = URL(string: APIClient.shared.baseURL + "/resident/access-points/\(accessPoint.id)/stream") else { return }
        let loader = MJPEGStreamLoader()
        loader.onFrame = { img in
            Task { @MainActor in
                image = img
                failed = false
                lastFrameAt = Date()
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
