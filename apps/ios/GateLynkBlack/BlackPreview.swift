import SwiftUI

#if DEBUG
/// Local-only visual review. This entry point never restores a session, registers
/// push, contacts APIClient or supplies production identifiers to an action.
enum BlackPreviewMode {
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("-black-design-preview") }

    /// Warianty do kontroli wizualnej stanów P1 (2026-09-30) — argument
    /// `-black-preview-variant <nazwa>`. Bez argumentu: dotychczasowy podgląd,
    /// z którego korzystają testy UI.
    ///   many-gates      pięć wejść (w tym długa nazwa) — selektor przewijany
    ///   long-names      długa nazwa nieruchomości i długie imię
    ///   empty           brak wejść, brak paczki, brak modułów kontekstowych
    ///   camera-offline  nakładka „Obraz nieaktualny" (referencja compact-offline)
    static var variant: String {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-black-preview-variant"), i + 1 < args.count else { return "default" }
        return args[i + 1]
    }

    /// `-black-result-seconds <n>` — dłuższe wyświetlanie wyniku polecenia
    /// (test UI nawigacji trwa dłużej niż domyślne 4 s).
    static var resultSeconds: TimeInterval? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-black-result-seconds"), i + 1 < args.count else { return nil }
        return TimeInterval(args[i + 1])
    }
}

struct BlackPreview: View {
    @State private var accessState: BlackAccessState = {
        let state = BlackAccessState()
        if let seconds = BlackPreviewMode.resultSeconds {
            state.acceptedResultDuration = seconds
            state.otherResultDuration = seconds
        }
        return state
    }()
    @State private var tab: GlassHomeTab = .home
    @State private var panel: String?
    @State private var confirmFire = false
    private let variant = BlackPreviewMode.variant
    private var points: [AccessPoint] {
        let base = [
            AccessPoint(id: -101, label: "Wjazd", icon: "gate", deviceId: "design-preview", relayIndex: 0, sortOrder: 0, category: "MAIN_ENTRY", unitId: nil),
            AccessPoint(id: -102, label: "Wyjazd", icon: "gate", deviceId: "design-preview", relayIndex: 0, sortOrder: 1, category: "EXIT", unitId: nil),
            AccessPoint(id: -103, label: "Brama pożarowa", icon: "flame", deviceId: "design-preview", relayIndex: 0, sortOrder: 2, category: "FIRE_ESCAPE", unitId: nil)
        ]
        switch variant {
        case "empty": return []
        case "many-gates": return base + [
            AccessPoint(id: -104, label: "Furtka od ul. Niewinnej", icon: "door", deviceId: "design-preview", relayIndex: 0, sortOrder: 3, category: "PEDESTRIAN", unitId: nil),
            AccessPoint(id: -105, label: "Garaż podziemny", icon: "gate", deviceId: "design-preview", relayIndex: 0, sortOrder: 4, category: "GARAGE", unitId: nil)
        ]
        default: return base
        }
    }
    private var propertyName: String { variant == "long-names" ? "Osiedle Villa Natura Etap II — Niewinna 4" : "Osiedle VN" }
    private var greeting: String { variant == "long-names" ? "Cześć, Konstantyna-Aleksandra" : "Cześć, Konrad" }
    private var pictures: [Int: UIImage] {
        var output: [Int: UIImage] = [:]
        for (id, name) in [(-101, "BlackPreviewEntrance"), (-102, "BlackPreviewExit"), (-103, "BlackPreviewFire")] {
            if let image = UIImage(named: name) { output[id] = image }
        }
        return output
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                BlackBackground()
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 0) {
                        if tab == .home || tab == .access {
                            BlackAccessDeck(
                                interaction: accessState,
                                accessPoints: points, loadFailed: false,
                                onOpen: { _ in
                                    try? await Task.sleep(for: .milliseconds(600))
                                    return .accepted
                                },
                                onFireConfirm: { _ in confirmFire = true },
                                onOpenMenu: { panel = "Wszystkie wejścia" },
                                onCamera: { panel = "Kamera · \($0.label)" },
                                onIntercom: { panel = "Domofon · \($0.label)" },
                                cameraHeight: BlackTheme.cameraHeight(for: geometry.size.height),
                                isSuspended: panel != nil || confirmFire,
                                fixtureImages: pictures, demoMode: true,
                                demoCameraOffline: variant == "camera-offline"
                            )
                        }
                        if tab == .home {
                            BlackShortcutGrid(modules: BlackModule.allCases) { panel = $0.title }
                                .padding(.top, 7)
                                .padding(.bottom, 12)
                            if variant != "empty" {
                                BlackContextNotice(title: "Paczka czeka w recepcji", detail: "Odbierz dzisiaj do 20:00") { panel = "Przesyłki" }
                            }
                            BlackAssistantLink { panel = "Asystent GateLynk" }
                        } else if tab != .access {
                            BlackContextNotice(title: tab.title, detail: "Podgląd wyglądu · dane przykładowe", icon: "info") { panel = tab.title }
                                .padding(.top, 16)
                        }
                    }
                    .padding(.horizontal, 18)
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    BlackHomeHeader(propertyName: propertyName, title: greeting, compact: geometry.size.height < 750,
                                    onProperty: { panel = "Nieruchomość" }, onAccount: { panel = "Konto" })
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { BlackTabBar(selection: $tab) }
            }
        }
        .sheet(isPresented: Binding(get: { panel != nil }, set: { if !$0 { panel = nil } })) {
            VStack(alignment: .leading, spacing: 18) {
                Text(panel ?? "GateLynk_black").font(BlackTheme.heading(29))
                Text("Tryb demonstracyjny. Obrazy i dane są przykładowe. Nie jest wykonywane połączenie z domofonem ani sterowanie bramą.")
                    .font(.body).foregroundStyle(BlackTheme.muted)
                Button("Zamknij") { panel = nil }.buttonStyle(.borderedProminent).tint(BlackTheme.accent)
            }
            .padding(24).presentationDetents([.medium]).presentationBackground(BlackTheme.surface)
        }
        .confirmationDialog("Brama pożarowa — podgląd", isPresented: $confirmFire, titleVisibility: .visible) {
            Button("Zamknij podgląd") { confirmFire = false }
        } message: { Text("W aplikacji ten przycisk otwiera istniejący ekran potwierdzenia dostępu awaryjnego. Ta prezentacja nie steruje urządzeniem.") }
    }
}
#endif
