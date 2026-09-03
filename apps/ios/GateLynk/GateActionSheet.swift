import SwiftUI

// MARK: - GateActionSheet
//
// Port designu z `docs/design/resident-2026-05-11/source/screens/gate.jsx`
// (wariant Hold — rekomendacja designera).
//
// Interakcja:
//   • Tap karty AP → rozwija się primary „przytrzymaj aby otworzyć"
//     z circular progress ring (3 sekundy).
//   • Brama pożarowa (icon == "gate" + label zawiera „pożar") → confirm
//     dialog zamiast Hold (bo to high-stakes action).
//   • Po success → status panel „Otwarte" + auto-close po ~2s.
//
// Sheet używa `.presentationDetents` żeby zajmował tylko ~75% ekranu — pod
// spodem widać background photo, daje to wrażenie nakładki nad Home.

struct GateActionSheet: View {
    let accessPoints: [AccessPoint]
    let onTrigger: (AccessPoint) async -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    /// Rozwinięte karty. Po otwarciu sheetu wypełniamy WSZYSTKIMI (patrz
    /// `.onAppear`) — user od razu widzi akcje każdego wejścia bez dodatkowego
    /// dotknięcia. Nagłówek dalej zwija/rozwija pojedynczą kartę.
    @State private var expandedIds: Set<Int> = []
    @State private var statusFor: Int? = nil
    @State private var statusKind: StatusKind = .opening

    enum StatusKind { case opening, opened, failed }

    var body: some View {
        ZStack {
            GLColor.bg1(scheme).ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                header
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 10) {
                        if accessPoints.isEmpty {
                            emptyState
                        } else {
                            ForEach(accessPoints) { ap in
                                accessPointCard(ap)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 24)
                }
                // Po otwarciu sheetu rozwiń WSZYSTKIE karty (od razu widoczne
                // akcje). Jeśli user coś zwinął, jego wybór zostaje na czas
                // sesji (onAppear nie odpala się ponownie przy re-renderze).
                .onAppear {
                    if expandedIds.isEmpty {
                        expandedIds = Set(accessPoints.map(\.id))
                    }
                }
            }
        }
        .presentationDetents([.fraction(0.75), .large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(scheme)
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("OTWÓRZ")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.5)
                .foregroundStyle(GLColor.textTertiary(scheme))
            Text("Wybierz miejsce")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(GLColor.textPrimary(scheme))
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    private var emptyState: some View {
        GLCard {
            VStack(spacing: 8) {
                Image(systemName: "lock.slash")
                    .font(.system(size: 30))
                    .foregroundStyle(GLColor.textTertiary(scheme))
                Text("Brak skonfigurowanych przejść")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(GLColor.textSecondary(scheme))
                Text("Skontaktuj się z administratorem osiedla")
                    .font(.system(size: 12))
                    .foregroundStyle(GLColor.textTertiary(scheme))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
        }
    }

    // MARK: Card

    @ViewBuilder
    private func accessPointCard(_ ap: AccessPoint) -> some View {
        let isExpanded = expandedIds.contains(ap.id)
        let isFirePole = isFireGate(ap)

        VStack(spacing: 0) {
            // Header row — ikona + label + chevron / status.
            // `.contentShape(Rectangle())` = CAŁY prostokąt wiersza łapie dotyk
            // (bez tego SwiftUI hit-testuje tylko ikonę/tekst/strzałkę, a tap
            // w puste miejsce/`Spacer()` przepada → „trzeba kliknąć kilka razy").
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    if isExpanded { expandedIds.remove(ap.id) }
                    else { expandedIds.insert(ap.id) }
                }
            } label: {
                HStack(spacing: 14) {
                    GLIconBadge(
                        systemName: iconFor(ap),
                        size: 44,
                        tint: isFirePole
                            ? GLColor.danger(scheme)
                            : (ap.isUnitDoor ? Self.amber : GLColor.accent300(scheme)),
                    )
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ap.label)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(GLColor.textPrimary(scheme))
                        Text(subtitleFor(ap))
                            .font(.system(size: 12))
                            .foregroundStyle(GLColor.textTertiary(scheme))
                    }
                    Spacer(minLength: 0)
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(GLColor.textTertiary(scheme))
                }
                .padding(14)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Divider().padding(.horizontal, 14).overlay(GLColor.borderSubtle(scheme))

                if isFirePole {
                    fireConfirmAction(ap)
                } else {
                    // Domyślny layout: kółko hold-to-open + mini preview z kamery
                    // domofonu. `MiniCameraPreview` sam obsłuży fallback gdy
                    // endpoint snapshot nie ma kamery (np. dla AP „Mój dom" —
                    // intercom virtual bez fizycznej cam).
                    lprExpandedAction(ap)
                }
            }
        }
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous)
                .stroke(
                    isFirePole && isExpanded
                        ? GLColor.danger(scheme).opacity(0.35)
                        : GLColor.borderSubtle(scheme),
                    lineWidth: 1,
                ),
        )
        .glShadow(.sm)
    }

    // MARK: Hold-to-open

    private func holdToOpenButton(_ ap: AccessPoint) -> some View {
        HoldToOpenButton(
            label: statusFor == ap.id ? statusLabel : "Przytrzymaj aby otworzyć",
            kind: statusFor == ap.id ? statusKind : nil,
        ) {
            await trigger(ap)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 16)
    }

    // MARK: LPR (Wjazd / Wyjazd) — kółko + kamera

    /// Dwie kolumny: hold-to-open po lewej, mini live preview po prawej.
    /// Stream pollowany co ~2s przez `MiniCameraPreview` (endpoint resident
    /// `/access-points/:id/snapshot?live=1` zwraca świeży JPEG przy każdym
    /// hit-cie, Edge omija swój 60s cache).
    private func lprExpandedAction(_ ap: AccessPoint) -> some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                HoldToOpenButton(
                    label: statusFor == ap.id ? statusLabel : "Przytrzymaj",
                    kind: statusFor == ap.id ? statusKind : nil,
                    size: 120,
                ) {
                    await trigger(ap)
                }
                .frame(maxWidth: .infinity)

                MiniCameraPreview(accessPointId: ap.id)
                    .frame(width: 140, height: 140)
            }

            // „Wjazd" = brama wjazdowa z domofonem → przycisk połączenia ze
            // stacją domofonową (podgląd bramy + rozmowa). Zamiast osobnego
            // kafelka „Domofon" na ekranie głównym (usunięty) — funkcja żyje tu.
            if isEntryGate(ap) {
                intercomButton
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 16)
    }

    /// „Wjazd" rozpoznajemy po labelu (jak `isFireGate`) — tam podpinamy domofon.
    private func isEntryGate(_ ap: AccessPoint) -> Bool {
        ap.label.lowercased().contains("wjazd")
    }

    /// Multi-station (2026-07-05): stacje z aktywnym mostem — przy >1 pokazujemy
    /// wybór z nazwami („Wejście główne", „Brama wschodnia") zamiast dzwonić
    /// „w ciemno". 0/1 stacja albo stary backend → dzwonimy jak dotąd.
    @State private var stationChoices: [IntercomStation] = []
    @State private var showStationPicker = false
    @State private var loadingStations = false

    /// Połączenie ze stacją domofonową: zamyka sheet i inicjuje outbound call
    /// (CallManager pokazuje ekran połączenia przez app-level fullScreenCover).
    private var intercomButton: some View {
        Button {
            Task { await startIntercomCall() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "video.fill")
                    .font(.system(size: 15, weight: .semibold))
                Text(loadingStations ? "Łączenie…" : "Połącz z domofonem")
                    .font(.system(size: 15, weight: .semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(GLColor.accent300(scheme).opacity(0.16))
            .foregroundStyle(GLColor.accent300(scheme))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(loadingStations)
        .confirmationDialog(
            "Z którą stacją chcesz się połączyć?",
            isPresented: $showStationPicker,
            titleVisibility: .visible
        ) {
            ForEach(stationChoices) { station in
                Button(station.name) {
                    dismiss()
                    CallManager.shared.startOutboundCall(intercomId: station.id)
                }
            }
            Button("Anuluj", role: .cancel) {}
        }
    }

    /// Pobiera rejestr stacji; >1 → picker z nazwami, inaczej dzwoń od razu.
    /// Backward-compat: stary backend (bez GET /stations) → pusta lista → call
    /// bez intercomId (Cloud wybiera jedyną stację jak dotąd).
    @MainActor
    private func startIntercomCall() async {
        guard !loadingStations else { return }
        loadingStations = true
        let stations = await CallManager.shared.loadStations()
        loadingStations = false
        if stations.count > 1 {
            stationChoices = stations
            showStationPicker = true
        } else {
            dismiss()
            CallManager.shared.startOutboundCall(intercomId: stations.first?.id)
        }
    }

    private var statusLabel: String {
        switch statusKind {
        case .opening: return "Otwieranie…"
        case .opened:  return "Otwarte ✓"
        case .failed:  return "Nie udało się"
        }
    }

    // MARK: Fire gate — confirm zamiast hold

    @State private var fireConfirmFor: Int? = nil

    private func fireConfirmAction(_ ap: AccessPoint) -> some View {
        VStack(spacing: 10) {
            Text("To jest brama pożarowa — używaj tylko w sytuacjach awaryjnych.")
                .font(.system(size: 12))
                .foregroundStyle(GLColor.danger(scheme))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 14)

            Button {
                fireConfirmFor = ap.id
            } label: {
                Text("Otwórz bramę pożarową")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(GLColor.danger(scheme))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 14)
            .padding(.bottom, 16)
        }
        .padding(.top, 12)
        .alert("Otworzyć bramę pożarową?", isPresented: Binding(
            get: { fireConfirmFor == ap.id },
            set: { if !$0 { fireConfirmFor = nil } },
        )) {
            Button("Anuluj", role: .cancel) {}
            Button("Otwórz", role: .destructive) {
                Task { await trigger(ap) }
            }
        } message: {
            Text("Każde otwarcie bramy pożarowej jest logowane i raportowane do administratora osiedla.")
        }
    }

    // MARK: Trigger

    private func trigger(_ ap: AccessPoint) async {
        statusFor = ap.id
        statusKind = .opening
        await onTrigger(ap)
        statusKind = .opened
        try? await Task.sleep(nanoseconds: 1_400_000_000)
        statusFor = nil
        dismiss()
    }

    // MARK: Mapping

    /// Bursztynowy akcent UNIT_DOOR (drzwi mieszkania) — spójny z HomeView
    /// i kreatorem gościa.
    static let amber = Color(red: 1.0, green: 0.69, blue: 0.125)

    private func iconFor(_ ap: AccessPoint) -> String {
        // UNIT_DOOR (2026-07-08) — zamek drzwi mieszkania (np. Nuki).
        if ap.isUnitDoor { return "key.fill" }
        switch ap.icon {
        case "door":     return "door.left.hand.open"
        case "garage":   return "car.fill"
        case "gate":     return "rectangle.portrait.split.2x1"
        case "elevator": return "arrow.up.arrow.down"
        case "barrier":  return "minus.square.fill"
        default:         return "lock.fill"
        }
    }

    private func subtitleFor(_ ap: AccessPoint) -> String {
        if isFireGate(ap) { return "Tylko w sytuacjach awaryjnych" }
        if ap.isUnitDoor { return "Drzwi mieszkania" }
        switch ap.icon {
        case "barrier":  return "Brama LPR"
        case "garage":   return "Wjazd do garażu"
        case "elevator": return "Wezwij windę"
        case "door":     return "Wejście pieszo"
        case "gate":     return "Furtka"
        default:         return ""
        }
    }

    private func isFireGate(_ ap: AccessPoint) -> Bool {
        let l = ap.label.lowercased()
        return l.contains("poż") || l.contains("fire") || l.contains("awar")
    }
}

// MARK: - HoldToOpenButton
//
// Designer: „Hold" wariant — przytrzymaj 3 sekundy, progress ring wypełnia
// się, po zwolnieniu przed czasem cofa do 0. SwiftUI: DragGesture .onChanged
// startuje, .onEnded cofa albo finalizuje.

struct HoldToOpenButton: View {
    let label: String
    /// Gdy non-nil — pokazuje state zamiast progress ring (Otwieranie/Otwarte/Failed).
    let kind: GateActionSheet.StatusKind?
    /// Średnica kółka. Default 140 (single layout). W split-view (LPR z kamerą)
    /// 120 żeby zmieściło się obok 140-pix camera preview.
    var size: CGFloat = 140
    let action: () async -> Void

    @Environment(\.colorScheme) private var scheme
    @State private var progress: CGFloat = 0
    @State private var holding = false
    @State private var timer: Timer?

    private let holdDuration: TimeInterval = 1.6 // szybciej niż design (3s) — UX, 3s czuło się długo

    var body: some View {
        ZStack {
            Circle()
                .stroke(GLColor.borderSubtle(scheme), lineWidth: 4)
                .frame(width: size, height: size)

            Circle()
                .trim(from: 0, to: progress)
                .stroke(
                    GLColor.accentGradient(scheme),
                    style: StrokeStyle(lineWidth: 4, lineCap: .round),
                )
                .frame(width: size, height: size)
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 0.05), value: progress)

            VStack(spacing: 4) {
                Image(systemName: iconForKind)
                    .font(.system(size: size * 0.26, weight: .semibold))
                    .foregroundStyle(tintForKind)
                Text(label)
                    .font(.system(size: size * 0.10, weight: .medium))
                    .foregroundStyle(GLColor.textSecondary(scheme))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: size * 0.80)
            }
        }
        .frame(maxWidth: .infinity)
        .contentShape(Circle())
        .gesture(holdGesture)
        .onChange(of: kind) { _, _ in
            if kind != nil { progress = 1 }
        }
    }

    private var holdGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { _ in
                if !holding {
                    holding = true
                    startProgress()
                }
            }
            .onEnded { _ in
                holding = false
                stopProgress()
            }
    }

    private func startProgress() {
        timer?.invalidate()
        let interval: TimeInterval = 0.02
        let step = CGFloat(interval / holdDuration)
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { t in
            DispatchQueue.main.async {
                progress += step
                if progress >= 1 {
                    progress = 1
                    t.invalidate()
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    Task { await action() }
                }
            }
        }
    }

    private func stopProgress() {
        timer?.invalidate()
        if progress < 1 {
            withAnimation(.easeOut(duration: 0.2)) { progress = 0 }
        }
    }

    private var iconForKind: String {
        switch kind {
        case .opening: return "arrow.triangle.2.circlepath"
        case .opened:  return "checkmark"
        case .failed:  return "exclamationmark.triangle"
        case .none:    return "lock.fill"
        }
    }

    private var tintForKind: Color {
        switch kind {
        case .opened:  return GLColor.success(scheme)
        case .failed:  return GLColor.danger(scheme)
        default:       return GLColor.accent300(scheme)
        }
    }
}

// MARK: - MiniCameraPreview
//
// Live preview z kamery DOMOFONU (Akuvox R29 ze zbliżeniem na szlaban).
// `AccessPoint.deviceId` to UUID intercom-u w Edge store — kamera LPR jest
// osobnym urządzeniem (po słupku, dalsza perspektywa). Snapshot endpoint
// `/resident/access-points/:id/snapshot?live=1` proxy-uje do
// `http://<edge>:4000/devices/<intercomUuid>/snapshot?live=1` (patrz
// `resident.service.pipeSnapshot`).
//
// `live=1` omija Edge 60s cache → świeży frame przy każdym poll-u. Polling
// co ~2s — kompromis live/load. Stary HomeView używał tego samego endpointa
// w `AccessPointCameraView` (full-screen modal). Tu tylko mini wersja w
// expanded sheet card.
//
// Pierwszy fetch może trwać 500ms-2s (Edge musi zassać z kamery przez ISAPI/
// proxy), więc pokazujemy ProgressView dopóki pierwszego JPEG-a nie ma.

struct MiniCameraPreview: View {
    let accessPointId: Int

    @Environment(\.colorScheme) private var scheme
    @State private var image: UIImage?
    @State private var loading = true
    @State private var failed = false
    @State private var task: Task<Void, Never>?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(GLColor.bg3(scheme))

            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else if loading {
                ProgressView()
                    .tint(GLColor.accent300(scheme))
            } else if failed {
                VStack(spacing: 4) {
                    Image(systemName: "video.slash")
                        .font(.system(size: 22))
                        .foregroundStyle(GLColor.textTertiary(scheme))
                    Text("Brak podglądu")
                        .font(.system(size: 11))
                        .foregroundStyle(GLColor.textTertiary(scheme))
                }
            }

            // Mały „LIVE" badge w lewym górnym rogu — żeby user widział że
            // to nie statyczna miniatura.
            if image != nil {
                VStack {
                    HStack {
                        HStack(spacing: 4) {
                            Circle()
                                .fill(GLColor.danger(scheme))
                                .frame(width: 6, height: 6)
                            Text("LIVE")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.white)
                        }
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color.black.opacity(0.55))
                        .clipShape(Capsule())
                        Spacer()
                    }
                    Spacer()
                }
                .padding(6)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
        )
        .onAppear { startPolling() }
        .onDisappear { task?.cancel() }
    }

    private func startPolling() {
        task?.cancel()
        task = Task {
            while !Task.isCancelled {
                await fetchOne()
                // Pierwszy frame natychmiast pokazujemy + leci polling.
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func fetchOne() async {
        do {
            let data = try await APIClient.shared.getRawData(
                "/resident/access-points/\(accessPointId)/snapshot?live=1",
            )
            if let img = UIImage(data: data) {
                await MainActor.run {
                    self.image = img
                    self.loading = false
                    self.failed = false
                }
            } else {
                await MainActor.run { failed = true; loading = false }
            }
        } catch {
            await MainActor.run {
                if image == nil { failed = true }
                loading = false
            }
        }
    }
}
