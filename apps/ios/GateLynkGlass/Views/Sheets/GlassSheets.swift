import SwiftUI

// MARK: - Bottom sheets — wspólny wzorzec
//
// README: scrim rgba(5,8,16,.45)+blur, sheet rgba(16,20,34,.85)+blur(40)
// saturate(180%), radius górny 34, grip 40×5, wejście translateY(105%)→0
// 380ms cubic-bezier(.32,.72,0,1), max-height 80%, nagłówek kicker+tytuł+✕.
//
// Implementacja: własny overlay w GlassHomeView (nie systemowy .sheet) —
// daje dokładny timing, chained sheets (Otwórz → potwierdzenie pożarowej)
// i glass look bez walki z UIKit.

enum GlassSheetKind: Identifiable, Equatable {
    case gate
    /// Podgląd z kamery domofonu (PROMPT 2) — live snapshoty + „Połącz".
    case camera
    /// Wybór stacji domofonowej (>1 stacja z aktywnym mostem).
    case stationPick
    /// Potwierdzenie bramy pożarowej z decka (GlassGateSheet w trybie confirm).
    case fireConfirm(Int)
    case vehicles
    case guests
    case payments
    case tickets
    case parcels
    case announcements
    case chat
    case more
    /// Historia zdarzeń osiedla (parity z HistoryView głównej apki).
    case history
    /// Kalendarz wydarzeń osiedla (2026-07-16 — parity ze starą apką).
    case calendar
    /// Onboarding zamka Nuki przez mieszkańca (2026-07-09) — świadoma zgoda.
    case nukiOnboarding
    /// Zapowiedź funkcji („WKRÓTCE") — patrz GlassComingSoon.swift.
    case comingSoon(GlassUpcomingFeature)
    /// Nieruchomości (multi-property, 2026-08-11) — ikonka domku w lewym
    /// górnym rogu: zmiana obiektu / jak dodać kolejny.
    case properties
    /// Zdarzenie gościa (2026-08-13) — deep-link z pusha „Gość wjechał/
    /// wyjechał" (GUEST_FIRST_USE / GUEST_USE / GUEST_EXIT): kadr z LPR
    /// + szczegóły gościa. Route sparsowany w AppDelegate.
    case guestEvent(GuestEventPushRoute)
    /// Karta do czytania pusha treściowego (2026-08-28): Kronika dnia /
    /// poranny brief / przypomnienie o kubłach. Route z AppDelegate;
    /// Kronika dociąga pełną wersję z `/resident/assistant/chronicle`.
    case pushContent(ContentPushRoute)

    var id: String {
        switch self {
        case .gate: return "gate"
        case .camera: return "camera"
        case .stationPick: return "stationPick"
        case .fireConfirm(let apId): return "fireConfirm-\(apId)"
        case .vehicles: return "vehicles"
        case .guests: return "guests"
        case .payments: return "payments"
        case .tickets: return "tickets"
        case .parcels: return "parcels"
        case .announcements: return "announcements"
        case .chat: return "chat"
        case .more: return "more"
        case .history: return "history"
        case .calendar: return "calendar"
        case .nukiOnboarding: return "nukiOnboarding"
        case .comingSoon(let f): return "comingSoon-\(f.rawValue)"
        case .properties: return "properties"
        case .guestEvent(let r): return "guestEvent-\(r.id)"
        case .pushContent(let r): return "pushContent-\(r.id)"
        }
    }
}

// MARK: - Kontener sheetu

struct GlassSheetContainer<Content: View>: View {
    let onClose: () -> Void
    @ViewBuilder let content: Content

    @State private var dragOffset: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            // Grip
            Capsule()
                .fill(Color.white.opacity(0.28))
                .frame(width: 40, height: 5)
                .padding(.top, 8)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())

            content
                .padding(.horizontal, 18)
                .padding(.bottom, 30)
        }
        .frame(maxWidth: .infinity)
        .background {
            UnevenRoundedRectangle(
                topLeadingRadius: GlassRadius.sheet,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: GlassRadius.sheet,
                style: .continuous
            )
            .fill(.ultraThinMaterial)
            .overlay {
                UnevenRoundedRectangle(
                    topLeadingRadius: GlassRadius.sheet,
                    bottomLeadingRadius: 0,
                    bottomTrailingRadius: 0,
                    topTrailingRadius: GlassRadius.sheet,
                    style: .continuous
                )
                .fill(GlassColor.sheetBg.opacity(0.72))
            }
            .ignoresSafeArea(edges: .bottom)
        }
        .overlay(alignment: .top) {
            UnevenRoundedRectangle(
                topLeadingRadius: GlassRadius.sheet,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: GlassRadius.sheet,
                style: .continuous
            )
            .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
            .ignoresSafeArea(edges: .bottom)
        }
        .shadow(color: .black.opacity(0.5), radius: 30, y: -12)
        .offset(y: max(0, dragOffset))
        .gesture(
            DragGesture()
                .onChanged { value in
                    dragOffset = value.translation.height
                }
                .onEnded { value in
                    if value.translation.height > 120 {
                        onClose()
                    }
                    withAnimation(.timingCurve(0.32, 0.72, 0, 1, duration: 0.3)) {
                        dragOffset = 0
                    }
                }
        )
    }
}

// MARK: - Nagłówek sheetu (kicker + tytuł + ✕)

struct GlassSheetHeader: View {
    let kicker: String
    let title: String
    let onClose: () -> Void

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 3) {
                Text(kicker.uppercased())
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(1.5)
                    .foregroundStyle(.white.opacity(0.65))
                Text(title)
                    .font(.system(size: 19, weight: .bold))
                    .tracking(-0.4)
                    .foregroundStyle(.white)
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background {
                        Circle().fill(Color.white.opacity(0.10))
                    }
                    .overlay {
                        Circle().strokeBorder(Color.white.opacity(0.16), lineWidth: 1)
                    }
            }
            .buttonStyle(.plain)
        }
        .padding(.bottom, 14)
    }
}

// MARK: - Wiersz akcji (.acc-row): orb + tytuł/podtytuł + opcjonalne CTA

struct GlassActionRow<Trailing: View, Extra: View>: View {
    let orbGradient: [Color]
    let orbIcon: String
    let title: String
    let subtitle: String
    var dimmed = false
    @ViewBuilder var trailing: Trailing
    @ViewBuilder var extra: Extra

    var body: some View {
        HStack(alignment: .center, spacing: 13) {
            GlassOrb(gradient: orbGradient, systemName: orbIcon, size: 42, iconSize: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14.5, weight: .semibold))
                    .tracking(-0.2)
                    .foregroundStyle(.white)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.white.opacity(0.6))
                }
                extra
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.08))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
        .opacity(dimmed ? 0.6 : 1)
    }
}

extension GlassActionRow where Trailing == EmptyView, Extra == EmptyView {
    init(orbGradient: [Color], orbIcon: String, title: String, subtitle: String, dimmed: Bool = false) {
        self.init(
            orbGradient: orbGradient, orbIcon: orbIcon, title: title,
            subtitle: subtitle, dimmed: dimmed,
            trailing: { EmptyView() }, extra: { EmptyView() }
        )
    }
}

extension GlassActionRow where Extra == EmptyView {
    init(
        orbGradient: [Color], orbIcon: String, title: String, subtitle: String,
        dimmed: Bool = false, @ViewBuilder trailing: () -> Trailing
    ) {
        self.init(
            orbGradient: orbGradient, orbIcon: orbIcon, title: title,
            subtitle: subtitle, dimmed: dimmed,
            trailing: trailing, extra: { EmptyView() }
        )
    }
}

// MARK: - CTA otwarcia (idle → busy "Otwieram" → ok "Otwarte ✓")

enum GlassCTAPhase: Equatable { case idle, busy, ok }

struct GlassOpenCTA: View {
    let phase: GlassCTAPhase
    var idleText = "Otwórz"
    var busyText = "Otwieram"
    var okText = "Otwarte ✓"
    var danger = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if phase == .busy {
                    ProgressView().tint(.white).scaleEffect(0.6)
                }
                Text(label)
                    .font(.system(size: 12, weight: .bold))
            }
            .foregroundStyle(phase == .ok ? GlassColor.successLight : .white)
            .padding(.horizontal, 13)
            .padding(.vertical, 7)
            .background { background }
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(phase != .idle)
        .animation(.easeInOut(duration: 0.2), value: phase)
    }

    private var label: String {
        switch phase {
        case .idle: return idleText
        case .busy: return busyText
        case .ok:   return okText
        }
    }

    @ViewBuilder
    private var background: some View {
        switch phase {
        case .idle:
            Capsule()
                .fill(danger ? GlassColor.dangerGradient : GlassColor.accentGradient)
                .shadow(color: (danger ? GlassColor.dangerDeep : GlassColor.accentBlue).opacity(0.45), radius: 7, y: 3)
        case .busy:
            Capsule().fill(Color.white.opacity(0.14))
        case .ok:
            Capsule().fill(GlassColor.success.opacity(0.2))
        }
    }
}

// MARK: - Pusty stan / loading w sheetach

struct GlassSheetEmptyState: View {
    let icon: String
    let text: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 30))
                .foregroundStyle(.white.opacity(0.4))
            Text(text)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.6))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 34)
    }
}

struct GlassSheetLoading: View {
    var body: some View {
        ProgressView()
            .tint(.white.opacity(0.7))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
    }
}

// MARK: - Swipe-to-delete (2026-07-13/15, wzorzec natywnego iOS — Zegar/Mail)
//
// Przeciągnięcie wiersza w lewo odsłania okrągłe przyciski akcji: opcjonalny
// zielony (np. „Zaproś ponownie" / „Edytuj") + czerwony kosz. Tap w kosz albo
// GŁĘBOKI swipe usuwa od razu — optymistycznie: wiersz wyjeżdża w lewo
// i zapada się, a przy błędzie backendu wraca sprężynką (`onDelete` → Bool).
//
// Hit-testing (fix 2026-07-15): przyciski pod wierszem służą tylko jako
// podgląd podczas przeciągania; po puszczeniu w stanie otwartym renderujemy
// ich INTERAKTYWNĄ kopię NAD wierszem (wiersz jest odsunięty dokładnie
// o szerokość strefy, więc nic się nie nakłada) — dzięki temu tap zawsze
// trafia w przycisk, niezależnie od kaprysów hit-testu po `.offset`.
// Używane w sheetach Goście / Pojazdy / Zgłoszenia.

/// Dodatkowa (nie-destrukcyjna) akcja swipe — okrągły kolorowy przycisk
/// obok kosza.
struct GlassSwipeAction {
    let icon: String
    let color: Color
    let action: () -> Void
}

struct GlassSwipeToDelete<Content: View>: View {
    let id: Int
    @Binding var openId: Int?
    var secondary: GlassSwipeAction? = nil
    /// Gdy ustawione — przed usunięciem pytamy „Czy na pewno…" (dialog
    /// z destrukcyjnym „Usuń"). nil = usuwanie bez potwierdzenia.
    var confirmTitle: String? = nil
    var confirmMessage: String? = nil
    /// Usuwa rekord (razem z reloadem listy). `false` = błąd → wiersz wraca.
    let onDelete: () async -> Bool
    let onTap: () -> Void
    @ViewBuilder let content: () -> Content

    @State private var dragging = false
    @State private var dragX: CGFloat = 0
    /// Wiersz „w drodze na śmietnik" — offset poza ekran + wysokość → 0.
    @State private var removing = false
    @State private var deleting = false
    @State private var confirming = false

    private static var spring: Animation { .spring(response: 0.32, dampingFraction: 0.85) }

    /// Szerokość odsłoniętej strefy: 1 przycisk (46) lub 2 (46+9+46) + marginesy.
    private var revealWidth: CGFloat { secondary == nil ? 62 : 117 }
    /// Głębokość pełnego swipe'a — puszczenie za nią = natychmiastowe usunięcie.
    private var commitDepth: CGFloat { revealWidth + 110 }

    private var baseOffset: CGFloat { openId == id ? -revealWidth : 0 }

    /// Offset wiersza: gumowy opór w prawo, w lewo bez oporu (pełny swipe);
    /// przy usuwaniu — poza lewą krawędź ekranu.
    private var offset: CGFloat {
        if removing { return -UIScreen.main.bounds.width }
        guard dragging else { return baseOffset }
        let raw = baseOffset + dragX
        return raw > 0 ? raw / 6 : raw
    }

    private var isOpen: Bool { openId == id && !dragging && !removing }

    var body: some View {
        ZStack(alignment: .trailing) {
            // Warstwa-podgląd pod wierszem — widoczna podczas przeciągania.
            actionButtons(interactive: false)
                .opacity(offset < -12 ? 1 : 0)
                .scaleEffect(offset < -12 ? 1 : 0.5)
                .animation(Self.spring, value: offset < -12)

            // Wiersz NIE jest Buttonem — po swipe Button odpalał akcję tapu
            // przy puszczeniu palca (touch-up wewnątrz) i natychmiast
            // zamykał odsłonięte przyciski. TapGesture ma tolerancję ruchu,
            // więc nie odpala się po przeciągnięciu.
            content()
                .contentShape(Rectangle())
                .onTapGesture {
                    if openId != nil {
                        withAnimation(Self.spring) { openId = nil }
                    } else {
                        onTap()
                    }
                }
                .offset(x: offset)
                // minimumDistance 25 — nie kradnie pionowego scrolla ani
                // tapów; reagujemy tylko na przeważająco poziomy ruch.
                .simultaneousGesture(
                    DragGesture(minimumDistance: 25)
                        .onChanged { v in
                            guard !removing else { return }
                            guard abs(v.translation.width) > abs(v.translation.height) else { return }
                            dragging = true
                            dragX = v.translation.width
                        }
                        .onEnded { _ in
                            guard dragging else { return }
                            let ended = offset
                            if ended < -commitDepth {
                                // Pełny swipe: przy potwierdzaniu wiersz
                                // zostaje otwarty pod dialogiem.
                                withAnimation(Self.spring) {
                                    openId = id
                                    dragging = false
                                    dragX = 0
                                }
                                requestDelete()
                            } else {
                                withAnimation(Self.spring) {
                                    openId = ended < -revealWidth * 0.5 ? id : nil
                                    dragging = false
                                    dragX = 0
                                }
                            }
                        }
                )

            // Interaktywna kopia przycisków NAD wierszem — tylko w stanie
            // otwartym (wiersz odsunięty o revealWidth, brak nakładania).
            if isOpen {
                actionButtons(interactive: true)
            }
        }
        // Zapadnięcie wysokości przy usuwaniu — lista płynnie domyka lukę.
        .frame(height: removing ? 0 : nil)
        .clipped()
        .opacity(removing ? 0 : 1)
        .confirmationDialog(
            confirmTitle ?? "Czy na pewno chcesz usunąć?",
            isPresented: $confirming,
            titleVisibility: .visible
        ) {
            Button("Usuń", role: .destructive) { commitDelete() }
            Button("Anuluj", role: .cancel) {}
        } message: {
            if let confirmMessage { Text(confirmMessage) }
        }
    }

    /// Kosz: pyta o potwierdzenie gdy `confirmTitle` ustawione,
    /// inaczej usuwa od razu.
    private func requestDelete() {
        guard !deleting, !removing else { return }
        if confirmTitle != nil {
            confirming = true
        } else {
            commitDelete()
        }
    }

    /// Rząd okrągłych przycisków: [zielona akcja] + czerwony kosz.
    private func actionButtons(interactive: Bool) -> some View {
        HStack(spacing: 9) {
            if let secondary {
                Button {
                    withAnimation(Self.spring) { openId = nil }
                    secondary.action()
                } label: {
                    ZStack {
                        Circle().fill(secondary.color)
                        Image(systemName: secondary.icon)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .frame(width: 46, height: 46)
                }
                .buttonStyle(.plain)
            }

            Button(action: requestDelete) {
                ZStack {
                    Circle().fill(GlassColor.danger)
                    if deleting {
                        ProgressView().tint(.white).scaleEffect(0.8)
                    } else {
                        Image(systemName: "trash.fill")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 46, height: 46)
            }
            .buttonStyle(.plain)
            .disabled(deleting)
        }
        .padding(.trailing, 7)
        .allowsHitTesting(interactive)
    }

    /// Optymistyczne usunięcie: animuj wyjazd + collapse, potem strzał do
    /// API; błąd → wiersz wraca. Jeśli rekord po sukcesie ZOSTAJE na liście
    /// w innym stanie (np. gość aktywny → „Anulowane"), pokazujemy go
    /// z powrotem — dane po reloadzie mają już nowy status.
    private func commitDelete() {
        guard !deleting, !removing else { return }
        deleting = true
        withAnimation(.easeInOut(duration: 0.3)) { removing = true }
        Task {
            let ok = await onDelete()
            withAnimation(Self.spring) {
                openId = nil
                if !ok { removing = false }
            }
            if ok {
                // Rekord zwykle znika z danych (widok się odmontowuje).
                // Gdy zostaje (cancel gościa), przywróć widoczność.
                try? await Task.sleep(nanoseconds: 350_000_000)
                withAnimation(Self.spring) { removing = false }
            }
            deleting = false
        }
    }
}

// MARK: - Chrome natywnych .sheet (2026-07-15)

/// Marginesy + tło + zaokrąglenie dla widoków prezentowanych natywnym
/// `.sheet(item:)` (np. edycja pojazdu). Główne sheety Glass przechodzą
/// przez GlassSheetContainer (horizontal 18 + grabber + tło), ale natywne
/// sheety go omijają — bez tego chrome'u treść klei się do krawędzi okna.
/// Użycie: `.sheet(item:) { Widok().glassNestedSheet() }`.
struct GlassNestedSheetChrome: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 20)
            .padding(.top, 30)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(GlassColor.sheetBg.ignoresSafeArea())
            .presentationDragIndicator(.hidden)
            .presentationCornerRadius(GlassRadius.sheet)
    }
}

extension View {
    func glassNestedSheet() -> some View { modifier(GlassNestedSheetChrome()) }
}
