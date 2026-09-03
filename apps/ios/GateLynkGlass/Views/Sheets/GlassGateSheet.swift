import SwiftUI

// MARK: - Sheet "Co chcesz otworzyć?"
//
// Lista realnych access pointów z /resident/access-points. CTA "Otwórz" →
// spinner "Otwieram" → "Otwarte ✓" (3s) → reset. Brama pożarowa (heurystyka
// label jak w GateActionSheet starej apki) → ekran potwierdzenia w tym
// samym sheecie (jak w prototypu HTML).
//
// 2026-07-07 (produkcja):
//   • „Połącz z domofonem" — outbound call do stacji (CallManager, WebRTC).
//     Multi-station: GET /resident/intercom/stations; >1 → wybór stacji
//     w tym samym sheecie (mode .stationPick), 0/1 → dzwonimy od razu.
//     409 STATION_BUSY / błędy → toast z komunikatem (obserwacja
//     CallManager.outboundError w GlassHomeView).
//   • Panel zamka Tedee („Mój dom") — widoczna zapowiedź WKRÓTCE
//     (decyzja właściciela), tap → sheet „wkrótce".

struct GlassGateSheet: View {
    let accessPoints: [AccessPoint]
    let onOpen: (AccessPoint) async -> Bool
    let onComingSoon: (GlassUpcomingFeature) -> Void
    let onClose: () -> Void

    @Environment(GlassToastCenter.self) private var toast

    private enum Mode: Equatable {
        case list
        case fireConfirm(Int)   // AccessPoint.id
        case stationPick
    }

    @State private var mode: Mode = .list
    @State private var ctaPhases: [Int: GlassCTAPhase] = [:]
    @State private var fireBusy = false
    @State private var fireDone = false
    @State private var stations: [IntercomStation] = []
    @State private var loadingStations = false

    /// `fireConfirmApId` — start od razu w trybie potwierdzenia bramy
    /// pożarowej (deck „Dostęp" z PROMPT 1 reużywa istniejący confirm —
    /// „Anuluj" prowadzi do pełnej listy).
    init(
        accessPoints: [AccessPoint],
        fireConfirmApId: Int? = nil,
        onOpen: @escaping (AccessPoint) async -> Bool,
        onComingSoon: @escaping (GlassUpcomingFeature) -> Void,
        onClose: @escaping () -> Void
    ) {
        self.accessPoints = accessPoints
        self.onOpen = onOpen
        self.onComingSoon = onComingSoon
        self.onClose = onClose
        _mode = State(initialValue: fireConfirmApId.map { .fireConfirm($0) } ?? .list)
    }

    var body: some View {
        switch mode {
        case .list:
            listContent
        case .fireConfirm(let apId):
            if let ap = accessPoints.first(where: { $0.id == apId }) {
                fireConfirmContent(ap)
            }
        case .stationPick:
            stationPickContent
        }
    }

    // MARK: Lista przejść

    private var listContent: some View {
        VStack(spacing: 9) {
            GlassSheetHeader(kicker: "Dostęp", title: "Co chcesz otworzyć?", onClose: onClose)

            if accessPoints.isEmpty {
                GlassSheetEmptyState(
                    icon: "lock.slash",
                    text: "Brak skonfigurowanych przejść.\nSkontaktuj się z administratorem osiedla."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(accessPoints) { ap in
                            row(ap)
                        }
                        // 2026-07-08 — zapowiedź Tedee tylko gdy w API nie ma
                        // REALNEGO zamka drzwi mieszkania (category==UNIT_DOOR);
                        // realny renderuje się wyżej jako zwykły row (klucz +
                        // bursztyn, istniejący flow open).
                        if !accessPoints.contains(where: { $0.isUnitDoor }) {
                            tedeeRow
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }

            intercomButton
                .padding(.top, 4)
        }
    }

    // MARK: Domofon — połączenie wychodzące (multi-station)

    private var intercomButton: some View {
        Button {
            Task { await startIntercomCall() }
        } label: {
            HStack(spacing: 8) {
                if loadingStations {
                    ProgressView().tint(.white).scaleEffect(0.7)
                } else {
                    Image(systemName: "video.fill")
                        .font(.system(size: 14, weight: .semibold))
                }
                Text(loadingStations ? "Łączenie…" : "Połącz z domofonem")
                    .font(.system(size: 14.5, weight: .semibold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(GlassColor.accentBlue.opacity(0.22))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(GlassColor.accentBlue.opacity(0.5), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .disabled(loadingStations)
    }

    /// Pobiera rejestr stacji; >1 → wybór w sheecie, 0/1 → dzwoń od razu.
    /// Backward-compat: stary backend (bez GET /stations) → pusta lista →
    /// call bez intercomId (Cloud sam wybiera jedyną stację).
    @MainActor
    private func startIntercomCall() async {
        guard !loadingStations else { return }
        loadingStations = true
        let loaded = await CallManager.shared.loadStations()
        loadingStations = false
        if loaded.count > 1 {
            stations = loaded
            mode = .stationPick
        } else {
            onClose()
            CallManager.shared.startOutboundCall(intercomId: loaded.first?.id)
        }
    }

    /// Wybór stacji (>1 z aktywnym mostem) — nazwy jak w CallKit.
    private var stationPickContent: some View {
        VStack(spacing: 9) {
            GlassSheetHeader(kicker: "Domofon", title: "Z którą stacją?", onClose: onClose)

            ForEach(stations) { station in
                GlassActionRow(
                    orbGradient: [GlassColor.accentBlue, GlassColor.orbViolet],
                    orbIcon: "phone.fill",
                    title: station.name,
                    subtitle: "Stacja domofonowa"
                ) {
                    GlassOpenCTA(phase: .idle, idleText: "Połącz") {
                        onClose()
                        CallManager.shared.startOutboundCall(intercomId: station.id)
                    }
                }
            }

            GlassButton(title: "Anuluj", style: .ghost) {
                mode = .list
            }
            .padding(.top, 4)
        }
    }

    // MARK: „Mój dom" (Tedee) — zapowiedź WKRÓTCE

    private var tedeeRow: some View {
        Button {
            onComingSoon(.tedeeLock)
        } label: {
            GlassActionRow(
                orbGradient: [GlassColor.accentLight, GlassColor.orbPurple],
                orbIcon: "lock.open.rotation",
                title: "Mój dom — drzwi mieszkania",
                subtitle: "Inteligentny zamek",
                dimmed: true
            ) {
                GlassSoonBadge()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func row(_ ap: AccessPoint) -> some View {
        let fire = Self.isFireGate(ap)
        GlassActionRow(
            orbGradient: fire
                ? [GlassColor.dangerSoft, GlassColor.dangerDeep]
                : Self.orbGradient(for: ap),
            orbIcon: Self.icon(for: ap),
            title: ap.label,
            subtitle: fire ? "Wymaga potwierdzenia" : Self.subtitle(for: ap)
        ) {
            if fire {
                GlassOpenCTA(phase: .idle, idleText: "Awaryjnie", danger: true) {
                    mode = .fireConfirm(ap.id)
                }
            } else {
                GlassOpenCTA(phase: ctaPhases[ap.id] ?? .idle) {
                    Task { await runOpen(ap) }
                }
            }
        }
    }

    private func runOpen(_ ap: AccessPoint) async {
        guard (ctaPhases[ap.id] ?? .idle) == .idle else { return }
        ctaPhases[ap.id] = .busy
        let ok = await onOpen(ap)
        if ok {
            ctaPhases[ap.id] = .ok
            toast.show("\(ap.label) — otwarto")
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } else {
            ctaPhases[ap.id] = .idle
            toast.show("Nie udało się otworzyć", error: true)
            return
        }
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        ctaPhases[ap.id] = .idle
    }

    // MARK: Potwierdzenie bramy pożarowej

    private func fireConfirmContent(_ ap: AccessPoint) -> some View {
        VStack(spacing: 0) {
            GlassSheetHeader(kicker: "Brama pożarowa", title: "Czy na pewno?", onClose: onClose)

            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(GlassColor.dangerSoft)
                Text("Otwarcie zostanie zarejestrowane\ni zgłoszone do administracji.")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                Text("Używaj wyłącznie w sytuacji awaryjnej.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
            }
            .frame(maxWidth: .infinity)
            .padding(16)
            .background {
                RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                    .fill(GlassColor.dangerSoft.opacity(0.12))
            }
            .overlay {
                RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                    .strokeBorder(GlassColor.dangerSoft.opacity(0.35), lineWidth: 1)
            }
            .padding(.bottom, 14)

            if fireDone {
                GlassButton(title: "Brama pożarowa otwarta ✓", style: .ghost) {}
                    .disabled(true)
            } else {
                GlassButton(
                    title: "Tak, otwórz bramę",
                    style: .danger,
                    busyText: "Otwieram…",
                    isBusy: fireBusy
                ) {
                    Task { await runFireOpen(ap) }
                }
            }

            Spacer().frame(height: 9)

            GlassButton(title: "Anuluj", style: .ghost) {
                mode = .list
            }
        }
    }

    private func runFireOpen(_ ap: AccessPoint) async {
        fireBusy = true
        let ok = await onOpen(ap)
        fireBusy = false
        if ok {
            fireDone = true
            toast.show("Powiadomiono administrację")
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            onClose()
        } else {
            toast.show("Nie udało się otworzyć", error: true)
        }
    }

    // MARK: Mapowanie (spójne z GateActionSheet głównej apki)

    static func isFireGate(_ ap: AccessPoint) -> Bool {
        let l = ap.label.lowercased()
        return l.contains("poż") || l.contains("fire") || l.contains("awar")
    }

    static func icon(for ap: AccessPoint) -> String {
        // UNIT_DOOR (2026-07-08) — realny zamek drzwi mieszkania (np. Nuki).
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

    static func subtitle(for ap: AccessPoint) -> String {
        if ap.isUnitDoor { return "Drzwi mieszkania" }
        switch ap.icon {
        case "barrier":  return "Brama LPR"
        case "garage":   return "Wjazd do garażu"
        case "elevator": return "Wezwij windę"
        case "door":     return "Wejście pieszo"
        case "gate":     return "Furtka"
        default:         return "Przejście"
        }
    }

    static func orbGradient(for ap: AccessPoint) -> [Color] {
        // Bursztynowy akcent dla zamka drzwi mieszkania — spójny z deckiem
        // (GlassAccessCategory.unitDoor) i kaflami orbAmber.
        if ap.isUnitDoor { return [GlassColor.orbAmber1, GlassColor.orbAmber2] }
        switch ap.icon {
        case "barrier": return [GlassColor.accentBlue, GlassColor.orbViolet]
        case "door":    return [GlassColor.success, GlassColor.accentBlue]
        case "gate":    return [GlassColor.accentLight, GlassColor.accentBlue]
        default:        return [GlassColor.accentBlue, GlassColor.orbViolet]
        }
    }
}
