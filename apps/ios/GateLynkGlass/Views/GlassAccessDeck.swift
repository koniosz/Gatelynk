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
// Interakcja (audyt UX 2026-09-21):
//   • WYBÓR wejścia jest jawny — rząd chipów z nazwami + „Wszystkie wejścia";
//     karuzela (swipe) zostaje skrótem, nie jedyną metodą (A02).
//   • OTWIERANIE to osobny, nazwany przycisk `AccessHoldButton` pod kadrem
//     (A01/A05) — postęp 2 s w obrębie przycisku, nie na całej karcie.
//   • „Podgląd" i „Domofon" to nazwane akcje pomocnicze pod CTA.
//   • STAN: bramy/szlabany nie raportują stanu fizycznego, więc deck nie
//     twierdzi „Zamknięta/Otwarte". Pokazuje wynik POLECENIA (przyjęte /
//     nieznany / błąd); realny stan ma tylko zamek Nuki (telemetria).
//   • Kolor akcentu identyfikuje wejście; kolor STANU jest semantyczny
//     (zieleń = ok, bursztyn = niewiadoma, czerwień = problem) — A03.
//   • Brama pożarowa: logika BEZ ZMIAN (osobny ekran potwierdzenia); w UI
//     oddzielona — chip „awaryjne" na końcu + przycisk „Otwórz awaryjnie…".

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
        // 1) Brama pożarowa — najwyższy priorytet (bezpieczeństwo). Najpierw
        //    DANE (category=FIRE_ESCAPE z API), heurystyka po nazwie to fallback.
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

    /// Wejście awaryjne — własna ścieżka (ekran potwierdzenia), bez hold-a.
    var isEmergency: Bool { self == .pozarowa }
}

// MARK: - Deck

struct GlassAccessDeck: View {
    let accessPoints: [AccessPoint]
    let loadFailed: Bool
    /// Realne polecenie otwarcia (GlassHomeView.openAccessPoint) — wynik
    /// zgodny z kontraktem API: przyjęte / błąd / nieznany.
    let onOpen: (AccessPoint) async -> AccessOpenOutcome
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
    /// Klucz UserDefaults ulubionego wejścia — per użytkownik + nieruchomość
    /// (nil dopóki Home nie zna obu identyfikatorów → brak ulubionego).
    var favoriteKey: String? = nil

    @Environment(GlassToastCenter.self) private var toast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var activeIndex = 0
    /// Faza polecenia per wejście (z AccessHoldButton) — steruje linią stanu
    /// i znacznikiem na kadrze. Klucz = AccessPoint.id, więc spóźniona
    /// odpowiedź poprzedniego wejścia nie zmienia widoku innego.
    @State private var phases: [Int: AccessOpenPhase] = [:]
    /// Ulubione wejście (UserDefaults pod `favoriteKey`).
    @State private var favoriteApId: Int?
    @State private var favoriteApplied = false
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
                entranceChips
                deck
                if let ap = activeAP {
                    primaryAction(ap)
                        .padding(.top, 10)
                    secondaryActions(ap)
                        .padding(.top, 8)
                }
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
        .onAppear { applyFavoriteIfNeeded() }
        .onChange(of: accessPoints.map(\.id)) { _, _ in applyFavoriteIfNeeded() }
        .onChange(of: favoriteKey) { _, _ in
            favoriteApplied = false
            applyFavoriteIfNeeded()
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
                    colors: [activeAccent.opacity(0.16), .clear],
                    center: UnitPoint(x: 0.5, y: 0.12),
                    startRadius: 0, endRadius: 300
                )
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.5), value: activeIndex)
            }
    }

    // MARK: Nagłówek — kicker + jawne „Wszystkie wejścia"

    private var header: some View {
        HStack {
            Text("DOSTĘP")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.3)
                .foregroundStyle(.white.opacity(0.82))
                .accessibilityAddTraits(.isHeader)

            Spacer()

            Button(action: onOpenMenu) {
                HStack(spacing: 4) {
                    Text("Wszystkie wejścia")
                        .font(.system(size: 12.5, weight: .semibold))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                }
                .foregroundStyle(.white.opacity(0.9))
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: Jawny wybór wejścia — chipy z nazwami (A02)

    /// Zwykłe wejścia w kolejności z API, awaryjne NA KOŃCU (wizualnie
    /// oddzielone kreską) — funkcja awaryjna nie stoi w ciągu codziennych.
    private var chipOrder: [(index: Int, ap: AccessPoint)] {
        let all = accessPoints.enumerated().map { (index: $0.offset, ap: $0.element) }
        let regular = all.filter { !GlassAccessCategory.classify($0.ap).isEmergency }
        let emergency = all.filter { GlassAccessCategory.classify($0.ap).isEmergency }
        return regular + emergency
    }

    private var entranceChips: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(chipOrder, id: \.ap.id) { item in
                        let emergency = GlassAccessCategory.classify(item.ap).isEmergency
                        if emergency, item.index == chipOrder.first(where: { GlassAccessCategory.classify($0.ap).isEmergency })?.index,
                           chipOrder.contains(where: { !GlassAccessCategory.classify($0.ap).isEmergency }) {
                            Rectangle()
                                .fill(Color.white.opacity(0.22))
                                .frame(width: 1, height: 22)
                                .accessibilityHidden(true)
                        }
                        entranceChip(item.ap, index: item.index, emergency: emergency)
                            .id(item.ap.id)
                    }
                }
                .padding(.vertical, 2)
            }
            .onChange(of: activeIndex) { _, _ in
                if let id = activeAP?.id {
                    withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .center) }
                }
            }
        }
        .padding(.top, 2)
    }

    private func entranceChip(_ ap: AccessPoint, index: Int, emergency: Bool) -> some View {
        let selected = index == activeIndex
        let accent = GlassAccessCategory.classify(ap).accent
        return Button {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) { activeIndex = index }
        } label: {
            HStack(spacing: 6) {
                if emergency {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(Color(hex: 0xFF8A80))
                } else {
                    Circle().fill(accent).frame(width: 7, height: 7)
                }
                Text(ap.label)
                    .font(.system(size: 13, weight: selected ? .bold : .semibold))
                    .lineLimit(1)
                if favoriteApId == ap.id {
                    Image(systemName: "star.fill")
                        .font(.system(size: 9.5))
                        .foregroundStyle(GlassColor.orbAmber1)
                }
            }
            .foregroundStyle(.white.opacity(selected ? 1 : 0.85))
            .padding(.horizontal, 13)
            .frame(minHeight: 44)
            .background {
                Capsule().fill(Color.white.opacity(selected ? 0.22 : 0.08))
            }
            .overlay {
                Capsule().strokeBorder(
                    emergency ? Color(hex: 0xFF8A80).opacity(selected ? 0.9 : 0.45)
                              : Color.white.opacity(selected ? 0.55 : 0.16),
                    lineWidth: 1
                )
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "\(ap.label)\(emergency ? ", wejście awaryjne" : "")\(favoriteApId == ap.id ? ", ulubione" : "")"
        )
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    // MARK: Deck — TabView(.page); swipe zostaje SKRÓTEM do chipów

    private var deck: some View {
        TabView(selection: $activeIndex) {
            ForEach(Array(accessPoints.enumerated()), id: \.element.id) { idx, ap in
                slide(ap)
                    .tag(idx)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        // Foto-kafel (140 pt) + nazwa + linia stanu; bez podglądów niższy dial.
        .frame(height: tileSnapshots.isEmpty ? 172 : 214)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: tileSnapshots.isEmpty)
        .padding(.top, 8)
    }

    private func slide(_ ap: AccessPoint) -> some View {
        let cat = GlassAccessCategory.classify(ap)
        let phase = phases[ap.id, default: .idle]
        // Live stan zamka Nuki dla tego kafla (tylko UNIT_DOOR ma wpis).
        let lock = lockStatuses[ap.id]

        return VStack(spacing: 0) {
            if let snap = tileSnapshots[ap.id] {
                photoTile(ap, category: cat, phase: phase, snapshot: snap)
            } else {
                dial(ap, category: cat, phase: phase)
            }

            // Nazwa KONKRETNEGO wejścia + gwiazdka ulubionego.
            HStack(spacing: 6) {
                Text(ap.label)
                    .font(.system(size: 22, weight: .semibold))
                    .tracking(-0.4)
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if !cat.isEmergency {
                    favoriteButton(ap)
                }
            }
            .padding(.top, 6)

            statusLine(phase: phase, lock: lock)
        }
        .frame(maxWidth: .infinity)
    }

    private func favoriteButton(_ ap: AccessPoint) -> some View {
        let isFav = favoriteApId == ap.id
        return Button {
            setFavorite(isFav ? nil : ap.id)
            toast.show(isFav ? "Usunięto ulubione wejście" : "\(ap.label) — ulubione wejście na Domu")
        } label: {
            Image(systemName: isFav ? "star.fill" : "star")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(isFav ? GlassColor.orbAmber1 : .white.opacity(0.7))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isFav ? "Usuń \(ap.label) z ulubionych" : "Ustaw \(ap.label) jako ulubione wejście")
    }

    /// Linia stanu. Bez telemetrii NIE twierdzimy nic o bramie — pokazujemy
    /// wyłącznie wynik polecenia. Zamek Nuki ma realny stan z API.
    @ViewBuilder
    private func statusLine(phase: AccessOpenPhase, lock: NukiLockStatus?) -> some View {
        if let line = statusContent(phase: phase, lock: lock) {
            HStack(spacing: 7) {
                Circle()
                    .fill(line.color)
                    .frame(width: 7, height: 7)
                Text(line.text)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.88))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func statusContent(phase: AccessOpenPhase, lock: NukiLockStatus?) -> (text: String, color: Color)? {
        switch phase {
        case .sending:  return ("Wysyłanie polecenia…", Color(hex: 0x6E8BFF))
        case .accepted: return ("Polecenie otwarcia przyjęte", GlassColor.success)
        case .unknown:  return ("Wynik nieznany — sprawdź wejście", Color(hex: 0xF0A93E))
        case .failed:   return ("Nie udało się otworzyć", Color(hex: 0xFF6B6B))
        case .idle, .holding:
            guard let lock else { return nil }   // brak telemetrii → brak twierdzeń o stanie
            guard lock.online, let s = lock.effectiveStateLabel else {
                return ("Brak aktualnego statusu zamka", Color(hex: 0x8A93A6))
            }
            let text = lock.doorState == 3 ? "\(s) · drzwi otwarte" : s
            let color: Color = switch lock.badge {
            case .secure:     Color(hex: 0x34D399)
            case .open:       Color(hex: 0xF0A93E)
            case .transition: Color(hex: 0x6E8BFF)
            case .unknown, .offline: Color(hex: 0x8A93A6)
            }
            return (text, color)
        }
    }

    // MARK: Główne CTA + akcje pomocnicze (A01)

    @ViewBuilder
    private func primaryAction(_ ap: AccessPoint) -> some View {
        let cat = GlassAccessCategory.classify(ap)
        if cat.isEmergency {
            // Logika awaryjna BEZ ZMIAN: dotknięcie → ekran potwierdzenia.
            Button { onFireConfirm(ap) } label: {
                HStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color(hex: 0xFF8A80))
                        .frame(width: 26)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Otwórz awaryjnie…")
                            .font(.system(.headline).weight(.bold))
                            .foregroundStyle(.white)
                        Text("\(ap.label) — wymaga potwierdzenia")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.white.opacity(0.78))
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white.opacity(0.5))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: 60)
                .background {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color(hex: 0xFF5A5F).opacity(0.14))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Color(hex: 0xFF8A80).opacity(0.6), lineWidth: 1)
                }
            }
            .buttonStyle(.plain)
        } else {
            AccessHoldButton(
                targetName: ap.label,
                onPhaseChange: { phase in
                    phases[ap.id] = phase
                    // Po przyjęciu polecenia gęstsze kadry — mieszkaniec WIDZI,
                    // co dzieje się przy wejściu (to jedyny realny dowód stanu).
                    if phase == .sending { startSnapshotBoost(ap) }
                },
                onCommit: { await onOpen(ap) }
            )
            .id(ap.id)   // zmiana wejścia = nowy przycisk (czyści przytrzymanie)
        }
    }

    @ViewBuilder
    private func secondaryActions(_ ap: AccessPoint) -> some View {
        // Zamek Nuki (UNIT_DOOR) nie ma kamery ani domofonu.
        if !ap.isUnitDoor {
            HStack(spacing: 8) {
                secondaryButton("Podgląd", icon: "video.fill") { onCamera(ap) }
                secondaryButton("Domofon", icon: "phone.fill", busy: intercomBusy) { onIntercom(ap) }
            }
        }
    }

    private func secondaryButton(
        _ title: String, icon: String, busy: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if busy {
                    ProgressView().tint(.white).scaleEffect(0.7)
                } else {
                    Image(systemName: icon).font(.system(size: 13, weight: .semibold))
                }
                Text(title).font(.system(size: 14, weight: .semibold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 46)
            .background {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .fill(Color.white.opacity(0.10))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    // MARK: Ulubione wejście (per użytkownik + nieruchomość)

    private func applyFavoriteIfNeeded() {
        guard let key = favoriteKey, !accessPoints.isEmpty else { return }
        let stored = UserDefaults.standard.object(forKey: key) as? Int
        favoriteApId = stored
        guard !favoriteApplied else { return }
        favoriteApplied = true
        if let stored, let idx = accessPoints.firstIndex(where: { $0.id == stored }) {
            activeIndex = idx
        }
    }

    private func setFavorite(_ apId: Int?) {
        favoriteApId = apId
        guard let key = favoriteKey else { return }
        if let apId {
            UserDefaults.standard.set(apId, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    // MARK: Foto-kafel — duży prostokątny kadr z kamery wejścia (2026-08-18)

    private func photoTile(
        _ ap: AccessPoint, category cat: GlassAccessCategory,
        phase: AccessOpenPhase, snapshot: UIImage,
    ) -> some View {
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
            .overlay(alignment: .topLeading) {
                // Znacznik WYNIKU POLECENIA (mały, z tekstem) — nie wielki ✓ na
                // kadrze, który czytało się jak „brama otwarta". Stan fizyczny
                // pokazuje sam obraz z kamery.
                if let badge = resultBadge(phase) {
                    HStack(spacing: 5) {
                        Image(systemName: badge.icon).font(.system(size: 10.5, weight: .bold))
                        Text(badge.text).font(.system(size: 11, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .background { Capsule().fill(badge.color.opacity(0.92)) }
                    .padding(9)
                    .transition(.opacity)
                }
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
            .contentShape(shape)
            // Dotknięcie kadru = skrót do nazwanej akcji „Podgląd" (nie otwiera).
            .onTapGesture { if !ap.isUnitDoor { onCamera(ap) } }
            .accessibilityLabel("Obraz z kamery: \(ap.label)")
            .accessibilityHint("Otwiera podgląd z kamery")
    }

    private func resultBadge(_ phase: AccessOpenPhase) -> (icon: String, text: String, color: Color)? {
        switch phase {
        case .accepted: return ("checkmark", "Polecenie przyjęte", GlassColor.success)
        case .unknown:  return ("questionmark", "Wynik nieznany", Color(hex: 0xC78A2B))
        case .failed:   return ("xmark", "Nie udało się", Color(hex: 0xD9534F))
        default:        return nil
        }
    }

    // MARK: Dial — pierścień postępu + szklana tarcza z ikoną 3D

    private func dial(_ ap: AccessPoint, category cat: GlassAccessCategory, phase: AccessOpenPhase) -> some View {
        let ringColor: Color = switch phase {
        case .accepted: GlassColor.success
        case .unknown:  Color(hex: 0xF0A93E)
        case .failed:   Color(hex: 0xFF6B6B)
        default: cat.accent
        }
        let coreGlow = ringColor
        let ringFull: Bool = switch phase {
        case .sending, .accepted, .unknown, .failed: true
        default: false
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
                    .trim(from: 0, to: ringFull ? 1 : 0)
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
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.35), value: phase)

                // Warstwa ikony: idle/opening → render 3D, success → ✓, failure → ✗.
                dialGlyph(cat: cat, phase: phase)
        }
        .frame(width: 98, height: 98)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: ringFull)
        .accessibilityHidden(true)   // nazwa i stan są w tekście pod spodem
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
    private func dialGlyph(cat: GlassAccessCategory, phase: AccessOpenPhase) -> some View {
        switch phase {
        case .accepted:
            Image(systemName: "checkmark")
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(Color(hex: 0xEAFBF2))
                .shadow(color: .black.opacity(0.5), radius: 10, y: 4)
                .transition(.scale.combined(with: .opacity))
        case .unknown:
            Image(systemName: "questionmark")
                .font(.system(size: 32, weight: .bold))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.5), radius: 10, y: 4)
                .transition(.scale.combined(with: .opacity))
        case .failed:
            Image(systemName: "xmark")
                .font(.system(size: 32, weight: .bold))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.5), radius: 10, y: 4)
                .transition(.scale.combined(with: .opacity))
        default:
            // Realistyczna ikona 3D „unosząca się" w tarczy.
            Image(cat.assetName)
                .resizable()
                .scaledToFit()
                .frame(width: 76, height: 76)
                .shadow(color: Color(hex: 0x0A0E1E).opacity(0.55), radius: 9, x: 0, y: 5)
        }
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

}

// (GlassDialPressStyle usunięty 2026-07-15 — dial nie jest już Buttonem;
//  scale przy wciśnięciu robi pressingIds + scaleEffect w dial().)
