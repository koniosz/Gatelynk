import SwiftUI

// MARK: - Deck „Dostęp" — stronicowany carousel punktów dostępu (Glass Depth v7)
//
// Port sekcji `#accCard` z `docs/design/glass-depth-v7-2026-07/
// handoff_dostep_deck/Glass Depth Premium.html` — pełnoszerokościowy paged
// carousel à la Mercedes me: jeden swipe = jedna sekcja (realny AccessPoint
// z API, kolejność sortOrder). Każdy slajd: duży dial (pierścień postępu +
// szklana tarcza `.acc-core` z JASNYM spotlightem + REALISTYCZNA IKONA 3D
// z assetów), nazwa, status z kropką, hint.
//
// Zmiana v7 vs #70: kwadratowa ikona SF w kolorowym chipie → szklana tarcza
// z radialnym spotlightem `rgba(255,255,255,.5)→.16→.05` + dolna poświata
// akcentu, na której „unosi się" ciemny metaliczny render 3D (transparent PNG
// z Assets.xcassets). Pierścień postępu zostaje WOKÓŁ tarczy.
//
// Tokeny z HTML (#accCard):
//   • karta: background rgba(255,255,255,.02) — NISKI blur (ultraThinMaterial),
//     border rgba(255,255,255,.12), inner-highlight top + subtelny bottom,
//     box-shadow 0 22px 48px rgba(0,0,0,.4)
//   • poświata radialna .acc-glow w akcencie aktywnej sekcji (opacity .16,
//     przejście .5s przy przewijaniu)
//   • dial 98pt, track stroke .14/5px, prog stroke akcent + drop-shadow glow
//   • .acc-core inset 8 (radial spotlight .5→.16→.05 + dolna poświata akcentu),
//     box-shadow inset top .6 + inset bottom bluish + outer .34
//   • ikona 3D ~82pt scaledToFit + drop-shadow 0 5px 9px rgba(10,14,30,.55)
//   • nazwa 23pt/650/−.02em (mt 10), status 12.5 (mt 5), hint 11.5/.5 (mt 6)
//   • kropki paginacji 6pt, aktywna 6→22 w akcencie (transition .3s)
//   • wypełnienie pierścienia .9s cubic-bezier(.4,0,.2,1)
//
// Interakcja tap: pierścień wypełnia się ~0.9 s, RÓWNOLEGLE leci realne
// API otwarcia (onOpen → openAccessPoint). Sukces → ✓ w kółku + zieleń
// (#34D399) + toast + auto-reset 3 s. Błąd/timeout → czerwony stan „Nie
// udało się otworzyć" (bez auto-sukcesu), reset 3 s. Brama pożarowa NIE
// otwiera z decka — onFireConfirm prowadzi do istniejącego ekranu
// potwierdzenia (GlassGateSheet.fireConfirm — nie osłabiamy bezpieczeństwa).
//
// Swipe vs tap: TabView(.page) rozróżnia natywnie.

// MARK: - Kategoria punktu dostępu (asset 3D + akcent + statusy) — 5 sekcji v7
//
// API residenta nie zwraca zawsze `AccessPoint.category` — dokładamy
// heurystykę po label/kategorii, spójną z GlassGateSheet.isFireGate. Kod jest
// danych-driven: N realnych punktów, każdy dostaje ikonę/akcent/statusy ze
// swojej kategorii. Mapowanie wg tabeli README v7.

enum GlassAccessCategory {
    case szlaban    // Szlaban        — #6E8BFF — „Opuszczony"
    case brama      // Brama wjazdowa — #34D399 — „Zamknięta"
    case pozarowa   // Brama pożarowa — #FF5A5F — „Gotowa"
    case furtka     // Furtka         — #C58BFF — „Zamknięta"
    case drzwi      // Drzwi wejściowe— #F0A93E — „Zamknięte"

    /// Heurystyka wg README v7: „szlaban"→szlaban, „brama"+„pożar/ppoż"→
    /// pożarowa, „furtka"→furtka, „drzwi/wejści"→drzwi, „brama/wjazd"→brama,
    /// fallback→brama. Pożarową rozpoznajemy też przez GlassGateSheet.isFireGate.
    static func classify(_ ap: AccessPoint) -> GlassAccessCategory {
        let l = ap.label.lowercased()
        // 1) Brama pożarowa — najwyższy priorytet (bezpieczeństwo).
        if GlassGateSheet.isFireGate(ap)
            || l.contains("pożar") || l.contains("pozar") || l.contains("ppoż")
            || l.contains("ppoz") {
            return .pozarowa
        }
        // 2) Szlaban.
        if l.contains("szlaban") { return .szlaban }
        // 3) Furtka (pieszo).
        if l.contains("furtk") { return .furtka }
        // 4) Drzwi wejściowe / wejście.
        if l.contains("drzwi") || l.contains("wejśc") || l.contains("wejsc") {
            return .drzwi
        }
        // 5) Brama wjazdowa.
        if l.contains("brama") || l.contains("wjazd") { return .brama }
        // Fallback po ikonie backendu, potem brama.
        switch ap.icon {
        case "barrier": return .szlaban
        case "door":    return .drzwi
        default:        return .brama
        }
    }

    /// Nazwa assetu z ikoną 3D (Assets.xcassets, transparent PNG).
    var assetName: String {
        switch self {
        case .szlaban:  return "AccessSzlaban"
        case .brama:    return "AccessBrama"
        case .pozarowa: return "AccessPozarowa"
        case .furtka:   return "AccessFurtka"
        case .drzwi:    return "AccessDrzwi"
        }
    }

    /// Akcent per sekcja wg tabeli README v7.
    var accent: Color {
        switch self {
        case .szlaban:  return Color(hex: 0x6E8BFF)
        case .brama:    return Color(hex: 0x34D399)
        case .pozarowa: return Color(hex: 0xFF5A5F)
        case .furtka:   return Color(hex: 0xC58BFF)
        case .drzwi:    return Color(hex: 0xF0A93E)
        }
    }

    /// Status w spoczynku (data-idle w HTML).
    var idleStatus: String {
        switch self {
        case .szlaban:  return "Opuszczony"
        case .pozarowa: return "Gotowa"
        case .drzwi:    return "Zamknięte"
        default:        return "Zamknięta"  // szlaban ma własny, tu brama/furtka
        }
    }

    /// Status w trakcie akcji: szlaban „Podnoszę…", reszta „Otwieranie…".
    var openingStatus: String {
        self == .szlaban ? "Podnoszę…" : "Otwieranie…"
    }

    /// Status końcowy sukcesu: szlaban „Podniesiony", reszta „Otwarte".
    var doneStatus: String {
        self == .szlaban ? "Podniesiony" : "Otwarte"
    }

    /// Toast po sukcesie (data-toast w HTML).
    func successToast(label: String) -> String {
        self == .szlaban ? "\(label) — podniesiony" : "\(label) — otwarto"
    }

    /// Otwieranie przez press-and-hold 2 s (2026-07-15) — chroni przed
    /// przypadkowymi dotknięciami. Pożarowa zostaje na tap → ekran
    /// potwierdzenia (własna warstwa bezpieczeństwa).
    var hint: String {
        self == .pozarowa
            ? "Awaryjne — dotknij, aby otworzyć"
            : "Przytrzymaj 2 s, aby otworzyć"
    }
}

// MARK: - Deck

struct GlassAccessDeck: View {
    let accessPoints: [AccessPoint]
    let loadFailed: Bool
    /// Realne otwarcie (istniejący flow openAccessPoint w GlassHomeView).
    let onOpen: (AccessPoint) async -> Bool
    /// Brama pożarowa — ekran potwierdzenia (istniejący wzorzec).
    let onFireConfirm: (AccessPoint) -> Void
    /// Kicker „DOSTĘP" → pełne menu (GlassGateSheet).
    let onOpenMenu: () -> Void
    /// Ikona kamery → sheet „Podgląd" AKTYWNEJ sekcji (2026-07-10 — kamera
    /// podąża za sekcją: Wjazd→R29, Wyjazd→E18).
    let onCamera: (AccessPoint) -> Void
    /// Ikona słuchawki → flow rozmowy dla domofonu AKTYWNEJ sekcji.
    let onIntercom: (AccessPoint) -> Void
    var intercomBusy = false
    /// Zachowane dla kompatybilności call-site (GlassHomeView). Deck v7 jest
    /// czysto data-driven z realnych AP — nie doklejamy sztucznych slajdów,
    /// więc ten callback nie jest już wywoływany z decka. Default no-op.
    var onComingSoon: (GlassUpcomingFeature) -> Void = { _ in }
    /// Live stan zamków Nuki (keyed by apId) — dla kafla UNIT_DOOR pokazujemy
    /// realny „Zamknięty/Otwarty" zamiast statycznego „Zamknięte" (2026-07-10).
    /// Puste = brak danych / stary backend → fallback do statycznego statusu.
    var lockStatuses: [Int: NukiLockStatus] = [:]

    @Environment(GlassToastCenter.self) private var toast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum DialState: Equatable { case idle, opening, success, failure }

    @State private var activeIndex = 0
    @State private var dialStates: [Int: DialState] = [:]
    @State private var ringProgress: [Int: CGFloat] = [:]
    /// Diale aktualnie przytrzymywane palcem (press-and-hold 2 s).
    @State private var pressingIds: Set<Int> = []
    /// Postęp przytrzymania 0→1 (2 s) — napędza zalew CAŁEGO kafla „Dostęp"
    /// (pasek postępu na pełnej karcie + obwódka). Kciuk zasłania dial,
    /// więc feedback musi być widoczny poza nim (2026-07-15).
    @State private var holdGlow: CGFloat = 0
    /// Odliczanie „2 → 1" podczas trzymania (nil = brak).
    @State private var holdCountdown: Int?
    @State private var holdCountdownTask: Task<Void, Never>?
    /// Wariant 2026-08-17: tarcza kafla pokazuje SNAPSHOT z kamery danego
    /// wejścia zamiast ikony 3D (keyed by apId). Brak obrazu (kamera bez
    /// podglądu, np. RTSP wyłączone) → fallback do ikony — bez zmian UX.
    @State private var tileSnapshots: [Int: UIImage] = [:]
    /// Boost po otwarciu (2026-08-18): od commitu hold-2s przez ~25 s klatka
    /// co ~1,2 s — widać, jak szlaban/brama fizycznie się otwiera (i zamyka).
    @State private var snapshotBoostTask: Task<Void, Never>?

    /// Deck v7: dokładnie tyle slajdów ile realnych punktów dostępu
    /// (sortOrder). Bez sztucznych zapowiedzi.
    private var slideCount: Int { accessPoints.count }

    /// Klucz restartu pętli snapshotów: zmiana sekcji (swipe) LUB nadejście /
    /// zmiana listy wejść z API. Sam `activeIndex` nie wystarczał — patrz
    /// komentarz przy `.task(id:)` (FIX 2026-08-19).
    private var snapshotTaskKey: String {
        "\(activeIndex)|" + accessPoints.map { String($0.id) }.joined(separator: ",")
    }

    private var activeAccent: Color {
        guard accessPoints.indices.contains(activeIndex) else {
            return GlassColor.orbPurple
        }
        return GlassAccessCategory.classify(accessPoints[activeIndex]).accent
    }

    /// Punkt dostępu aktualnie widocznej sekcji — źródło kamery/domofonu
    /// dla ikon w nagłówku (kamera i słuchawka podążają za swipe'em).
    private var activeAP: AccessPoint? {
        accessPoints.indices.contains(activeIndex) ? accessPoints[activeIndex] : accessPoints.first
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            if accessPoints.isEmpty {
                emptyState
            } else {
                deck
                dots
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 16)
        // Snapshoty do tarcz: restart przy zmianie sekcji (swipe) ORAZ gdy
        // lista wejść przyjedzie z API. FIX 2026-08-19: przy starcie apki
        // deck renderuje się z PUSTĄ listą (AP ładują się async) — pętla
        // kończyła się natychmiast i odpalała dopiero po swipe (zmiana
        // activeIndex). Klucz zawiera więc też id-ki punktów dostępu.
        .task(id: snapshotTaskKey) { await snapshotLoop() }
        .onDisappear { snapshotBoostTask?.cancel() }
        .background { cardBackground }
        .overlay {
            // Border rgba(255,255,255,.12) + inner-highlight top.
            RoundedRectangle(cornerRadius: GlassRadius.primary, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
        }
        .overlay {
            // Press-and-hold (2026-07-15): akcentowa obwódka całej karty
            // rozjaśnia się z postępem trzymania — czytelny feedback, którego
            // kciuk nie zasłania. Gruba (2.5pt) i z mocnym glow, żeby efekt
            // był oczywisty również w pełnym słońcu.
            RoundedRectangle(cornerRadius: GlassRadius.primary, style: .continuous)
                .strokeBorder(activeAccent.opacity(min(1, 1.2 * holdGlow)), lineWidth: 3)
                .shadow(color: activeAccent.opacity(0.9 * holdGlow), radius: 16)
                .allowsHitTesting(false)
        }
        .overlay(alignment: .top) {
            // Duże odliczanie „2 → 1" u góry karty (poza kciukiem) — razem
            // z zalewem koloru nie sposób przegapić, że trwa otwieranie.
            if let n = holdCountdown {
                Text("\(n)")
                    .font(.system(size: 46, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white)
                    .shadow(color: activeAccent, radius: 14)
                    .shadow(color: .black.opacity(0.6), radius: 4, y: 2)
                    .padding(.top, 8)
                    .id(n)   // zmiana cyfry = nowy widok → transition
                    .transition(.scale(scale: 1.6).combined(with: .opacity))
                    .allowsHitTesting(false)
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: holdCountdown)
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.primary, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [Color.white.opacity(0.34), .clear],
                        startPoint: .top, endPoint: .center
                    ),
                    lineWidth: 1
                )
                .blendMode(.plusLighter)
                .allowsHitTesting(false)
        }
        .clipShape(RoundedRectangle(cornerRadius: GlassRadius.primary, style: .continuous))
        .shadow(color: .black.opacity(0.4), radius: 24, x: 0, y: 18)
        .onChange(of: accessPoints.count) { _, _ in
            // Pull-to-refresh może zmniejszyć listę — nie zostawiaj selekcji
            // poza zakresem (TabView pokazałby pustą stronę).
            if activeIndex >= slideCount { activeIndex = max(0, slideCount - 1) }
        }
    }

    // MARK: Tło karty — liquid-glass NISKI blur + poświata radialna w akcencie

    private var cardBackground: some View {
        // README v7: background rgba(255,255,255,.02), blur ~11px (CELOWO
        // niski — wyższy zamienia szkło w lity panel). ultraThinMaterial to
        // najcieńszy wbudowany materiał; tint .02 zamiast .055 (#70) trzyma
        // „mocno przezroczyste" szkło. (TODO: custom 11px UIVisualEffect gdyby
        // trzeba jeszcze niższego blur.)
        RoundedRectangle(cornerRadius: GlassRadius.primary, style: .continuous)
            .fill(.ultraThinMaterial)
            .overlay {
                RoundedRectangle(cornerRadius: GlassRadius.primary, style: .continuous)
                    .fill(Color.white.opacity(0.02))
            }
            .overlay {
                // HTML .acc-glow: radial 120%×85% at 50% 12%, opacity .16,
                // przejście koloru .5s przy przewijaniu. Podczas press-and-hold
                // poświata narasta razem z holdGlow (0.16 → ~0.7) — cały kafel
                // WYRAŹNIE „ładuje się" kolorem sekcji przez 2 s trzymania.
                RadialGradient(
                    colors: [activeAccent.opacity(0.16 + 0.55 * holdGlow), .clear],
                    center: UnitPoint(x: 0.5, y: 0.12),
                    startRadius: 0, endRadius: 300
                )
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.5), value: activeIndex)
            }
            .overlay {
                // CAŁY KAFEL jako pasek postępu (2026-07-15): akcentowy zalew
                // sunie od lewej do prawej przez pełne 2 s trzymania, ze
                // świecącą pionową krawędzią-„skanerem" na froncie. Widoczny
                // na całej wysokości karty — kciuk na dialu go nie zasłania.
                GeometryReader { geo in
                    HStack(spacing: 0) {
                        LinearGradient(
                            colors: [activeAccent.opacity(0.28), activeAccent.opacity(0.55)],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: geo.size.width * holdGlow)

                        // Świecąca krawędź frontu zalewu.
                        Rectangle()
                            .fill(activeAccent)
                            .frame(width: 3)
                            .shadow(color: activeAccent, radius: 8)
                            .opacity(holdGlow > 0.01 && holdGlow < 0.995 ? 1 : 0)

                        Color.clear
                    }
                }
                .allowsHitTesting(false)
            }
    }

    // MARK: Nagłówek — kicker + 2 okrągłe ikony glass 34pt

    private var header: some View {
        HStack {
            Button(action: onOpenMenu) {
                Text("DOSTĘP")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.3)
                    .foregroundStyle(.white.opacity(0.78))
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Spacer()

            // Zamek Nuki (UNIT_DOOR) nie ma kamery ani domofonu — ikony
            // znikają, gdy aktywna sekcja to drzwi mieszkania (2026-07-15).
            if let ap = activeAP, !ap.isUnitDoor {
                HStack(spacing: 8) {
                    // Kolory wg konwencji telefonii (zgłoszenie 2026-08-12):
                    // ZIELONA słuchawka = zadzwoń (czerwona oznacza „rozłącz"
                    // i myliła); kamera na niebieskim akcencie apki — wideo
                    // nie ma utrwalonej konwencji koloru, a dwa zielone orby
                    // obok siebie zlewałyby się w jedno.
                    headerIcon(
                        "video.fill",
                        gradient: [GlassColor.accentLight, GlassColor.accentBlue],
                        label: "Podgląd z kamery"
                    ) {
                        onCamera(ap)
                    }
                    headerIcon(
                        "phone.fill",
                        gradient: [GlassColor.successLight, GlassColor.success],
                        label: "Domofon", busy: intercomBusy
                    ) {
                        onIntercom(ap)
                    }
                }
            }
        }
    }

    private func headerIcon(
        _ systemName: String, gradient: [Color], label: String, busy: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        // 2026-07-17: pełnokolorowe orby jak przy pojazdach/gościach —
        // gradientowe kółko (kamera niebieska, telefon zielony) zamiast
        // szklanego tła; spinner zachowany dla stanu łączenia z domofonem.
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(LinearGradient(colors: gradient, startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay {
                        Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: 0.8)
                            .blendMode(.plusLighter)
                    }
                    .shadow(color: .black.opacity(0.35), radius: 6, y: 3)
                    .shadow(color: (gradient.last ?? .clear).opacity(0.5), radius: 8, y: 4)
                if busy {
                    ProgressView().tint(.white).scaleEffect(0.7)
                } else {
                    Image(systemName: systemName)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: 40, height: 40)
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel(label)
    }

    // MARK: Deck — TabView(.page), jeden swipe = jedna sekcja

    private var deck: some View {
        TabView(selection: $activeIndex) {
            ForEach(Array(accessPoints.enumerated()), id: \.element.id) { idx, ap in
                slide(ap)
                    .tag(idx)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        // 2026-08-18: foto-kafel (140 pt) + teksty potrzebują więcej miejsca
        // niż tarcza 98 pt. Wysokość rośnie dopiero gdy JAKIKOLWIEK snapshot
        // się załadował — bez podglądów deck wygląda jak dotychczas.
        .frame(height: tileSnapshots.isEmpty ? 186 : 236)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: tileSnapshots.isEmpty)
        .padding(.top, 6)
    }

    private func slide(_ ap: AccessPoint) -> some View {
        let cat = GlassAccessCategory.classify(ap)
        let state = dialStates[ap.id, default: .idle]
        // Live stan zamka Nuki dla tego kafla (tylko UNIT_DOOR ma wpis).
        let lock = lockStatuses[ap.id]

        return VStack(spacing: 0) {
            // Wariant 2026-08-18: gdy jest snapshot z kamery wejścia — DUŻY
            // prostokątny kadr zamiast tarczy z ikoną 3D (w kółku 82 pt obraz
            // z fisheye był „totalnie niewidoczny" — feedback Konrada).
            // Brak podglądu (RTSP off itp.) → klasyczna tarcza.
            if let snap = tileSnapshots[ap.id] {
                photoTile(ap, category: cat, state: state, snapshot: snap)
            } else {
                dial(ap, category: cat, state: state)
            }

            // Nazwa — 23pt / 650 / −.02em, margin-top 10 (data-driven z AP).
            Text(ap.label)
                .font(.system(size: 23, weight: .semibold))
                .tracking(-0.46)
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.top, 10)

            // Status z kropką w akcencie, margin-top 5. Dla zamka Nuki
            // w spoczynku pokazujemy realny stan („Zamknięty/Otwarty") kolorem.
            HStack(spacing: 7) {
                Circle()
                    .fill(statusDotColor(state, category: cat, lock: lock))
                    .frame(width: 6, height: 6)
                    .shadow(color: statusDotColor(state, category: cat, lock: lock), radius: 4)
                // Podczas przytrzymania status zmienia się na „Przytrzymaj…" —
                // razem z domykającym się pierścieniem daje jasny feedback.
                Text(pressingIds.contains(ap.id) && state == .idle
                     ? "Przytrzymaj…"
                     : statusText(state, category: cat, lock: lock))
                    .font(.system(size: 12.5))
                    .foregroundStyle(.white.opacity(0.8))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .padding(.top, 5)

            // Hint — 11.5pt opacity .5, margin-top 6.
            Text(cat.hint)
                .font(.system(size: 11.5, weight: .medium))
                .tracking(0.2)
                .foregroundStyle(.white.opacity(0.5))
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Foto-kafel — duży prostokątny kadr z kamery wejścia (2026-08-18)

    private func photoTile(
        _ ap: AccessPoint, category cat: GlassAccessCategory,
        state: DialState, snapshot: UIImage,
    ) -> some View {
        let accent: Color = switch state {
        case .success: GlassColor.success
        case .failure: Color(hex: 0xFF3B30)
        default: cat.accent
        }
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)

        return Image(uiImage: snapshot)
            .resizable()
            .scaledToFill()
            .frame(maxWidth: .infinity)
            .frame(height: 140)
            .clipShape(shape)
            .overlay {
                // Winieta dolna — kadr nie „świeci" pod nazwą sekcji.
                shape.fill(
                    LinearGradient(
                        colors: [.clear, .clear, Color.black.opacity(0.35)],
                        startPoint: .top, endPoint: .bottom
                    )
                )
            }
            .overlay {
                // Stany ✓/✗ — kolorowy zalew + duży znak na środku kadru.
                if state == .success || state == .failure {
                    shape.fill(accent.opacity(0.45))
                    Image(systemName: state == .success ? "checkmark" : "xmark")
                        .font(.system(size: 44, weight: .bold))
                        .foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.5), radius: 10, y: 4)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .overlay(alignment: .bottomLeading) {
                // Pasek postępu otwierania na dolnej krawędzi kadru —
                // odpowiednik pierścienia z tarczy (ringProgress 0→1 ~0.9 s).
                GeometryReader { geo in
                    let progress = state == .success || state == .failure
                        ? 1 : ringProgress[ap.id, default: 0]
                    VStack {
                        Spacer()
                        Capsule()
                            .fill(accent)
                            .frame(width: max(0, (geo.size.width - 20) * progress), height: 4)
                            .shadow(color: accent.opacity(0.9), radius: 5)
                            .padding(.horizontal, 10)
                            .padding(.bottom, 8)
                    }
                }
                .allowsHitTesting(false)
            }
            .overlay {
                // Szklana ramka — spójna z inner-highlight reszty decka.
                shape.strokeBorder(
                    LinearGradient(
                        colors: [Color.white.opacity(0.45), Color.white.opacity(0.08)],
                        startPoint: .top, endPoint: .bottom
                    ),
                    lineWidth: 1
                )
            }
            .shadow(color: .black.opacity(0.4), radius: 12, y: 6)
            .scaleEffect(pressingIds.contains(ap.id) ? 0.97 : 1)
            .animation(.timingCurve(0.34, 1.56, 0.64, 1, duration: 0.2),
                       value: pressingIds.contains(ap.id))
            .contentShape(shape)
            // Te same gesty co tarcza: tap = hint / pożarowa → potwierdzenie,
            // hold 2 s = otwarcie (zalew karty + odliczanie bez zmian).
            .onTapGesture {
                if cat == .pozarowa {
                    onFireConfirm(ap)
                } else if dialStates[ap.id, default: .idle] == .idle {
                    toast.show("Przytrzymaj 2 sekundy, aby otworzyć")
                }
            }
            .onLongPressGesture(minimumDuration: 2.0, maximumDistance: 60) {
                commitHoldOpen(ap, category: cat)
            } onPressingChanged: { pressing in
                handlePressing(pressing, ap: ap, category: cat)
            }
            .accessibilityLabel("\(ap.label) — \(cat.hint)")
    }

    // MARK: Dial — pierścień postępu + szklana tarcza z ikoną 3D

    private func dial(_ ap: AccessPoint, category cat: GlassAccessCategory, state: DialState) -> some View {
        let ringColor: Color = switch state {
        case .success: GlassColor.success
        case .failure: Color(hex: 0xFF3B30)
        default: cat.accent
        }
        // Dolna poświata tarczy (HTML: radial at 50% 120%) — kolor śledzi stan.
        let coreGlow: Color = switch state {
        case .success: GlassColor.success
        case .failure: Color(hex: 0xFF3B30)
        default: cat.accent
        }

        return ZStack {
                // Track — rgba(255,255,255,.14), stroke ~4 (skala 98/120).
                Circle()
                    .stroke(Color.white.opacity(0.14), lineWidth: 4)
                    .padding(5)

                // Progress ring — wypełnia się DOPIERO po commit-cie otwarcia
                // (kciuk i tak zasłania dial podczas trzymania; feedback
                // przytrzymania robi kafel — holdGlow).
                Circle()
                    .trim(from: 0, to: state == .success || state == .failure
                          ? 1 : ringProgress[ap.id, default: 0])
                    .stroke(ringColor, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .padding(5)
                    .shadow(color: ringColor.opacity(0.9), radius: 5)

                // Szklana tarcza .acc-core (inset 8) — jasny spotlight + dolna
                // poświata akcentu, cień wewn. (top highlight + bluish bottom)
                // i zewn. dla głębi.
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color.white.opacity(0.5),
                                Color(hex: 0xE2E8F6).opacity(0.16),
                                Color(hex: 0xB4C4E6).opacity(0.05)
                            ],
                            center: UnitPoint(x: 0.38, y: 0.30),
                            startRadius: 1, endRadius: 44
                        )
                    )
                    .overlay {
                        // Dolna poświata w kolorze stanu (radial at 50% 120%).
                        Circle().fill(
                            RadialGradient(
                                colors: [coreGlow.opacity(0.7), .clear],
                                center: UnitPoint(x: 0.5, y: 1.18),
                                startRadius: 0, endRadius: 60
                            )
                        )
                    }
                    .overlay {
                        // Inner bottom bluish shadow (inset 0 -8px 20px).
                        Circle().fill(
                            RadialGradient(
                                colors: [.clear, Color(hex: 0x3C508C).opacity(0.25)],
                                center: UnitPoint(x: 0.5, y: 0.95),
                                startRadius: 20, endRadius: 46
                            )
                        )
                        .allowsHitTesting(false)
                    }
                    .overlay {
                        // Inner top highlight (inset 0 1px 0 rgba(255,255,255,.6)).
                        Circle().strokeBorder(
                            LinearGradient(
                                colors: [Color.white.opacity(0.6), Color.white.opacity(0.05)],
                                startPoint: .top, endPoint: .bottom
                            ),
                            lineWidth: 1
                        )
                        .blendMode(.plusLighter)
                    }
                    .shadow(color: .black.opacity(0.34), radius: 14, y: 8)
                    .padding(8)
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.35), value: state)

                // Warstwa ikony: idle/opening → render 3D, success → ✓, failure → ✗.
                dialGlyph(cat: cat, state: state)
        }
        .frame(width: 98, height: 98)
        .scaleEffect(pressingIds.contains(ap.id) ? 0.95 : 1)
        .animation(.timingCurve(0.34, 1.56, 0.64, 1, duration: 0.2), value: pressingIds.contains(ap.id))
        .contentShape(Circle())
        // Press-and-hold 2 s (2026-07-15): trzymanie wypełnia pierścień,
        // puszczenie przed czasem cofa go (anty-przypadkowe otwarcia).
        // Pożarowa: zwykły tap → ekran potwierdzenia (jak dotąd).
        .onTapGesture {
            if cat == .pozarowa {
                onFireConfirm(ap)
            } else if dialStates[ap.id, default: .idle] == .idle {
                // Krótki tap = podpowiedź zamiast otwarcia.
                toast.show("Przytrzymaj 2 sekundy, aby otworzyć")
            }
        }
        .onLongPressGesture(minimumDuration: 2.0, maximumDistance: 60) {
            commitHoldOpen(ap, category: cat)
        } onPressingChanged: { pressing in
            handlePressing(pressing, ap: ap, category: cat)
        }
        .accessibilityLabel("\(ap.label) — \(cat.hint)")
    }

    /// Palec dotknął / puścił dial przed upływem 2 s. Feedback trzymania:
    /// dyskretna animacja CAŁEGO kafla (holdGlow → poświata + obwódka karty),
    /// bo kciuk zasłania dial. Puszczenie przed czasem cofa poświatę.
    private func handlePressing(_ pressing: Bool, ap: AccessPoint, category cat: GlassAccessCategory) {
        guard cat != .pozarowa else { return }
        if pressing {
            guard dialStates[ap.id, default: .idle] == .idle else { return }
            pressingIds.insert(ap.id)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            // Zalew karty przez pełne 2 s trzymania.
            withAnimation(reduceMotion ? nil : .linear(duration: 2.0)) {
                holdGlow = 1
            }
            // Odliczanie 2 → 1 (duża cyfra u góry karty) + haptic na zmianie.
            holdCountdown = 2
            holdCountdownTask?.cancel()
            holdCountdownTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled else { return }
                holdCountdown = 1
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            }
        } else {
            pressingIds.remove(ap.id)
            holdCountdownTask?.cancel()
            holdCountdown = nil
            // Puszczono przed commitem → zalew gaśnie.
            if dialStates[ap.id, default: .idle] == .idle {
                withAnimation(.easeOut(duration: 0.35)) { holdGlow = 0 }
            }
        }
    }

    /// Przytrzymano pełne 2 s — odpalamy realne otwarcie (pierścień wypełnia
    /// się teraz standardowo w runOpen, poświata kafla gaśnie).
    private func commitHoldOpen(_ ap: AccessPoint, category cat: GlassAccessCategory) {
        guard cat != .pozarowa else { return }
        guard dialStates[ap.id, default: .idle] == .idle else { return }
        pressingIds.remove(ap.id)
        holdCountdownTask?.cancel()
        holdCountdown = nil
        withAnimation(.easeOut(duration: 0.4)) { holdGlow = 0 }
        dialStates[ap.id] = .opening
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        startSnapshotBoost(ap)
        Task { await runOpen(ap, category: cat) }
    }

    // MARK: Snapshoty w tarczach (wariant 2026-08-17)

    /// Restart przy każdej zmianie `activeIndex` (`.task(id:)`): najpierw
    /// jednorazowo dociąga brakujące obrazy WSZYSTKICH sekcji (Edge ma 60 s
    /// cache — tanie), potem odświeża AKTYWNĄ sekcję co 10 s z `live=1`.
    /// Błąd pobrania = zostaje ikona 3D (fallback w dial()).
    private func snapshotLoop() async {
        // 2026-08-18: NAJPIERW ostatnie znane kadry z dysku — kafel ma obraz
        // natychmiast po starcie apki (0 ms sieci), świeży podmienia go za
        // chwilę. Cloud trzyma warm-klatki w RAM, więc i sieć wraca szybko.
        loadCachedTilesFromDisk()
        // 2026-08-19: aktywna sekcja NAJPIERW (na nią patrzy user), reszta
        // RÓWNOLEGLE — sekwencyjny prefetch potrafił opóźnić pierwszy kadr
        // o kilka sekund, gdy wolniejsza kamera stała wcześniej w liście.
        if let first = activeAP, tileSnapshots[first.id] == nil {
            await fetchTileSnapshot(apId: first.id, live: false)
        }
        await withTaskGroup(of: Void.self) { group in
            for ap in accessPoints
            where tileSnapshots[ap.id] == nil && ap.id != activeAP?.id {
                group.addTask { await fetchTileSnapshot(apId: ap.id, live: false) }
            }
        }
        guard let active = activeAP else { return }
        while !Task.isCancelled {
            await fetchTileSnapshot(apId: active.id, live: true)
            try? await Task.sleep(nanoseconds: 10_000_000_000)
        }
    }

    /// Po zatwierdzeniu otwarcia (hold 2 s) podbijamy częstotliwość klatek
    /// dla TEGO wejścia: ~1,2 s przez 25 s — pokrywa pełny cykl szlabanu
    /// (podniesienie + opuszczenie). Nowy boost anuluje poprzedni; deck
    /// znika → onDisappear ubija task. Równoległa pętla 10 s nie przeszkadza
    /// (dubel klatki jest nieszkodliwy).
    private func startSnapshotBoost(_ ap: AccessPoint) {
        snapshotBoostTask?.cancel()
        snapshotBoostTask = Task {
            let deadline = Date().addingTimeInterval(25)
            while !Task.isCancelled && Date() < deadline {
                await fetchTileSnapshot(apId: ap.id, live: true)
                try? await Task.sleep(nanoseconds: 1_200_000_000)
            }
        }
    }

    private func fetchTileSnapshot(apId: Int, live: Bool) async {
        do {
            // ?w=720&q=60 — wariant kaflowy skalowany na Edge (~50–90 KB
            // zamiast 300–740 KB pełnej klatki); Cloud grzeje go warmerem.
            let path = "/resident/access-points/\(apId)/snapshot?w=720&q=60" + (live ? "&live=1" : "")
            let data = try await APIClient.shared.getRawData(path)
            if let img = UIImage(data: data) {
                // Ostatni dobry kadr na dysk — następny start apki pokaże go
                // od pierwszej klatki, zanim sieć w ogóle odpowie.
                try? data.write(to: Self.tileCacheURL(apId), options: .atomic)
                await MainActor.run {
                    withAnimation(reduceMotion ? nil : .easeIn(duration: 0.3)) {
                        tileSnapshots[apId] = img
                    }
                }
            }
        } catch {
            // Cichy fallback — tarcza zostaje z ikoną 3D. Kolejna próba przy
            // następnym przejściu pętli / zmianie sekcji.
        }
    }

    // MARK: Cache dyskowy kadrów (2026-08-18) — natychmiastowy render po starcie

    private static func tileCacheURL(_ apId: Int) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("gl_tile_\(apId).jpg")
    }

    private func loadCachedTilesFromDisk() {
        for ap in accessPoints where tileSnapshots[ap.id] == nil {
            if let data = try? Data(contentsOf: Self.tileCacheURL(ap.id)),
               let img = UIImage(data: data) {
                tileSnapshots[ap.id] = img
            }
        }
    }

    @ViewBuilder
    private func dialGlyph(cat: GlassAccessCategory, state: DialState) -> some View {
        switch state {
        case .idle, .opening:
            // Realistyczna ikona 3D „unosząca się" w tarczy — 82pt scaledToFit,
            // drop-shadow 0 5px 9px rgba(10,14,30,.55).
            Image(cat.assetName)
                .resizable()
                .scaledToFit()
                .frame(width: 76, height: 76)
                .shadow(color: Color(hex: 0x0A0E1E).opacity(0.55), radius: 9, x: 0, y: 5)
        case .success:
            // ✓ w kółku (tarcza jest zielona) — jak checkIco w HTML.
            Image(systemName: "checkmark")
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(Color(hex: 0xEAFBF2))
                .shadow(color: .black.opacity(0.5), radius: 10, y: 4)
                .transition(.scale.combined(with: .opacity))
        case .failure:
            Image(systemName: "xmark")
                .font(.system(size: 32, weight: .bold))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.5), radius: 10, y: 4)
                .transition(.scale.combined(with: .opacity))
        }
    }

    private func statusText(
        _ state: DialState, category cat: GlassAccessCategory, lock: NukiLockStatus? = nil
    ) -> String {
        switch state {
        case .idle:
            // Zamek Nuki: realny stan zamiast statycznego „Zamknięte".
            if let lock, lock.online, let s = lock.effectiveStateLabel {
                // Drzwi otwarte (czujnik) doklejamy — mieszkaniec widzi że lokal
                // nie jest domknięty mimo zaryglowanego rygla.
                if lock.doorState == 3 { return "\(s) · drzwi otwarte" }
                return s
            }
            if lock != nil { return "offline" }   // zamek jest, ale brak odczytu
            return cat.idleStatus
        case .opening: return cat.openingStatus
        case .success: return cat.doneStatus
        case .failure: return "Nie udało się otworzyć"
        }
    }

    private func statusDotColor(
        _ state: DialState, category cat: GlassAccessCategory, lock: NukiLockStatus? = nil
    ) -> Color {
        switch state {
        case .success: return GlassColor.success
        case .failure: return Color(hex: 0xFF3B30)
        default:
            if let lock {
                switch lock.badge {
                case .secure:     return Color(hex: 0x34D399)   // zielony — zamknięty
                case .open:       return Color(hex: 0xF0A93E)   // bursztyn — otwarty
                case .transition: return Color(hex: 0x6E8BFF)   // niebieski — w ruchu
                case .unknown, .offline: return Color(hex: 0x8A93A6) // szary
                }
            }
            return cat.accent
        }
    }

    // MARK: Paginacja — kropka 6pt, aktywna wydłuża się do 22 w akcencie

    private var dots: some View {
        HStack(spacing: 7) {
            ForEach(0..<slideCount, id: \.self) { i in
                Capsule()
                    .fill(i == activeIndex ? activeAccent : Color.white.opacity(0.28))
                    .frame(width: i == activeIndex ? 22 : 6, height: 6)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: activeIndex)
        .padding(.top, 8)
    }

    // MARK: Pusty stan (łączenie / offline)

    private var emptyState: some View {
        VStack(spacing: 10) {
            if loadFailed {
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: 26))
                    .foregroundStyle(.white.opacity(0.4))
                Text("Brak połączenia — odśwież")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.white.opacity(0.6))
            } else {
                ProgressView().tint(.white.opacity(0.7))
                Text("Łączenie z osiedlem…")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 186)
        .padding(.top, 6)
    }

    // MARK: Interakcja otwierania

    @MainActor
    private func runOpen(
        _ ap: AccessPoint, category cat: GlassAccessCategory, ringPrefilled: Bool = false
    ) async {
        // Press-and-hold (2026-07-15): pierścień wypełnił się już podczas
        // 2 s trzymania — nie animujemy drugi raz. (Stara ścieżka tap
        // z wypełnianiem 0.9 s zostaje dla ewentualnych przyszłych wywołań.)
        if !ringPrefilled {
            ringProgress[ap.id] = 0
            if reduceMotion {
                ringProgress[ap.id] = 1
            } else {
                withAnimation(.timingCurve(0.4, 0, 0.2, 1, duration: 0.9)) {
                    ringProgress[ap.id] = 1
                }
            }
        }

        let started = Date()
        let ok = await onOpen(ap)
        // Nie kończymy wcześniej niż animacja pierścienia (spójny rytm z HTML).
        let minWait = ringPrefilled ? 0.2 : 0.9
        let remaining = minWait - Date().timeIntervalSince(started)
        if remaining > 0 {
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
        }

        if ok {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
                dialStates[ap.id] = .success
            }
            toast.show(cat.successToast(label: ap.label))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } else {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
                dialStates[ap.id] = .failure
            }
            toast.show("Nie udało się otworzyć", error: true)
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }

        // Auto-reset po 3 s (HTML) — dotyczy też stanu błędu (wraca do idle,
        // nigdy do sukcesu).
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        var t = Transaction()
        t.disablesAnimations = true
        withTransaction(t) { ringProgress[ap.id] = 0 }
        withAnimation(.easeInOut(duration: 0.3)) { dialStates[ap.id] = .idle }
    }
}

// (GlassDialPressStyle usunięty 2026-07-15 — dial nie jest już Buttonem;
//  scale przy wciśnięciu robi pressingIds + scaleEffect w dial().)
