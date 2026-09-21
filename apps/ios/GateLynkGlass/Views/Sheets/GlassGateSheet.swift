import SwiftUI

// MARK: - Sheet „Wszystkie wejścia"
//
// Lista realnych access pointów z /resident/access-points. Audyt UX
// 2026-09-21: dotknięcie wiersza WYBIERA wejście i rozwija ten sam przycisk
// co na Domu (`AccessHoldButton`, 2 s, realny wynik polecenia) — wcześniej
// „Otwórz" w wierszu otwierało jednym tapem i kończyło „Otwarte ✓" bez
// telemetrii. Wejścia awaryjne są w OSOBNEJ sekcji na końcu; ich logika
// (ekran potwierdzenia) jest bez zmian.
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
    let onOpen: (AccessPoint) async -> AccessOpenOutcome
    let onComingSoon: (GlassUpcomingFeature) -> Void
    let onClose: () -> Void

    @Environment(GlassToastCenter.self) private var toast

    private enum Mode: Equatable {
        case list
        case fireConfirm(Int)   // AccessPoint.id
        case stationPick
    }

    @State private var mode: Mode = .list
    /// Wejście wybrane na liście — pod nim rozwija się przycisk otwierania.
    @State private var selectedApId: Int?
    @State private var fireBusy = false
    @State private var fireOutcome: AccessOpenOutcome?
    @State private var stations: [IntercomStation] = []
    @State private var loadingStations = false

    /// `fireConfirmApId` — start od razu w trybie potwierdzenia bramy
    /// pożarowej (deck „Dostęp" z PROMPT 1 reużywa istniejący confirm —
    /// „Anuluj" prowadzi do pełnej listy).
    init(
        accessPoints: [AccessPoint],
        fireConfirmApId: Int? = nil,
        onOpen: @escaping (AccessPoint) async -> AccessOpenOutcome,
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

    private var regularPoints: [AccessPoint] { accessPoints.filter { !Self.isFireGate($0) } }
    private var emergencyPoints: [AccessPoint] { accessPoints.filter { Self.isFireGate($0) } }

    private var listContent: some View {
        VStack(spacing: 9) {
            GlassSheetHeader(kicker: "Dostęp", title: "Wszystkie wejścia", onClose: onClose)

            if accessPoints.isEmpty {
                GlassSheetEmptyState(
                    icon: "lock.slash",
                    text: "Brak skonfigurowanych przejść.\nSkontaktuj się z administratorem osiedla."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(regularPoints) { ap in
                            row(ap)
                        }
                        if !emergencyPoints.isEmpty {
                            Text("AWARYJNE")
                                .font(.system(size: 11, weight: .bold))
                                .tracking(1.2)
                                .foregroundStyle(GlassColor.dangerSoft.opacity(0.95))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.top, 8)
                                .accessibilityAddTraits(.isHeader)
                            ForEach(emergencyPoints) { ap in
                                row(ap)
                            }
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

    @ViewBuilder
    private func row(_ ap: AccessPoint) -> some View {
        let fire = Self.isFireGate(ap)
        let selected = selectedApId == ap.id
        VStack(spacing: 8) {
            Button {
                if fire {
                    mode = .fireConfirm(ap.id)   // logika awaryjna bez zmian
                } else {
                    withAnimation(.easeInOut(duration: 0.22)) {
                        selectedApId = selected ? nil : ap.id
                    }
                }
            } label: {
                GlassActionRow(
                    orbGradient: fire
                        ? [GlassColor.dangerSoft, GlassColor.dangerDeep]
                        : Self.orbGradient(for: ap),
                    orbIcon: Self.icon(for: ap),
                    title: ap.label,
                    subtitle: fire ? "Awaryjne — wymaga potwierdzenia" : Self.subtitle(for: ap)
                ) {
                    Image(systemName: fire ? "chevron.right" : (selected ? "chevron.up" : "chevron.down"))
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white.opacity(0.55))
                        .frame(width: 30, height: 30)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(fire ? "Otwiera ekran potwierdzenia" : "Rozwija przycisk otwierania")

            if selected && !fire {
                AccessHoldButton(targetName: ap.label) { await onOpen(ap) }
                    .id(ap.id)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    // MARK: Potwierdzenie bramy pożarowej

    private func fireConfirmContent(_ ap: AccessPoint) -> some View {
        VStack(spacing: 0) {
            GlassSheetHeader(kicker: "Brama pożarowa", title: "Czy na pewno?", onClose: onClose)

            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(GlassColor.dangerSoft)
                Text("Otwarcie zostanie zapisane w historii\nzdarzeń osiedla, którą widzi administracja.")
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

            if let fireOutcome, fireOutcome != .accepted {
                Text(fireOutcome == .unknown
                     ? "Wynik nieznany — nie wiemy, czy polecenie dotarło. Sprawdź bramę; nie ponawiamy automatycznie."
                     : "Nie udało się wysłać polecenia. Brama NIE została otwarta z aplikacji.")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(fireOutcome == .unknown ? GlassColor.orbAmber1 : GlassColor.dangerSoft)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 10)
            }

            if fireOutcome == .accepted {
                GlassButton(title: "Polecenie otwarcia przyjęte ✓", style: .ghost) {}
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
        guard !fireBusy else { return }   // dubel dotknięcia ≠ druga komenda
        fireBusy = true
        let outcome = await onOpen(ap)
        fireBusy = false
        fireOutcome = outcome
        if outcome == .accepted {
            // Backend zapisuje REMOTE_OPEN w audycie; NIE wysyła osobnego
            // powiadomienia do administracji — nie twierdzimy, że wysłał.
            toast.show("\(ap.label) — polecenie otwarcia przyjęte")
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            onClose()
        }
    }

    // MARK: Mapowanie (spójne z GateActionSheet głównej apki)

    static func isFireGate(_ ap: AccessPoint) -> Bool {
        // Najpierw dane z API (kategoria nadana przez integratora), heurystyka
        // po nazwie zostaje dla obiektów bez ustawionej kategorii.
        if ap.category == "FIRE_ESCAPE" { return true }
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
