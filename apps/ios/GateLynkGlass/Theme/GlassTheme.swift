import SwiftUI
import Observation

// MARK: - Glass Depth Premium — design tokens
//
// Port tokenów z `docs/design/glass-depth-2026-06-10/handoff_glass_depth/README.md`.
// Design jest dark-only (scena #0a0d16) — app root wymusza .preferredColorScheme(.dark).
// Font: Geist niedostępny natywnie → systemowy SF z ujemnym trackingiem na
// nagłówkach (README dopuszcza "fallback systemowy").

enum GlassColor {
    /// Scena — tło całego ekranu (#0a0d16).
    static let scene = Color(red: 10/255, green: 13/255, blue: 22/255)
    /// Tło sheetów rgba(16,20,34,.85).
    static let sheetBg = Color(red: 16/255, green: 20/255, blue: 34/255)
    /// Akcent jasny #C5B0FF.
    static let accentLight = Color(red: 197/255, green: 176/255, blue: 255/255)
    /// Akcent niebieski #5B7CFA.
    static let accentBlue = Color(red: 91/255, green: 124/255, blue: 250/255)
    /// Success #34D399 / jaśniejszy #7BE2A3.
    static let success = Color(red: 52/255, green: 211/255, blue: 153/255)
    static let successLight = Color(red: 123/255, green: 226/255, blue: 163/255)
    /// Danger #FF453A + miękki gradient FF7A89→C03A4A.
    static let danger = Color(red: 255/255, green: 69/255, blue: 58/255)
    static let dangerSoft = Color(red: 255/255, green: 122/255, blue: 137/255)
    static let dangerDeep = Color(red: 192/255, green: 58/255, blue: 74/255)
    /// Tablica rejestracyjna #FBC02D na #10141f.
    static let plateYellow = Color(red: 251/255, green: 192/255, blue: 45/255)
    static let plateBg = Color(red: 16/255, green: 20/255, blue: 31/255)
    /// Orby kafelków (README → Design tokens → Kolory).
    static let orbViolet = Color(red: 192/255, green: 103/255, blue: 240/255)   // C067F0
    static let orbAmber1 = Color(red: 251/255, green: 191/255, blue: 36/255)    // FBBF24
    static let orbAmber2 = Color(red: 217/255, green: 119/255, blue: 6/255)     // D97706
    static let orbBlue1 = Color(red: 91/255, green: 156/255, blue: 250/255)     // 5B9CFA
    static let orbBlue2 = Color(red: 48/255, green: 112/255, blue: 208/255)     // 3070D0
    static let orbPurple = Color(red: 139/255, green: 107/255, blue: 240/255)   // 8B6BF0

    /// Główny gradient akcentu (CTA, pille, user-bubble).
    static var accentGradient: LinearGradient {
        LinearGradient(colors: [accentLight, accentBlue], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    static var dangerGradient: LinearGradient {
        LinearGradient(colors: [dangerSoft, dangerDeep], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

// MARK: - Promienie (README: karta główna 32 · kafelki 24 · sheet 34)

enum GlassRadius {
    static let primary: CGFloat = 32
    static let tile: CGFloat = 24
    static let sheet: CGFloat = 34
    static let row: CGFloat = 20
}

// MARK: - Glass card modifier
//
// CSS przepis: rgba(255,255,255,.15) + blur(40px) saturate(180%) + border
// rgba(255,255,255,.26) + inset highlight. Natywnie: .ultraThinMaterial
// (UIVisualEffectView pod spodem) + white tint + stroke.

struct GlassCardStyle: ViewModifier {
    var radius: CGFloat = GlassRadius.tile

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay {
                        RoundedRectangle(cornerRadius: radius, style: .continuous)
                            .fill(Color.white.opacity(0.10))
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Color.white.opacity(0.40), Color.white.opacity(0.16)],
                            startPoint: .top, endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
            }
            .shadow(color: .black.opacity(0.38), radius: 25, x: 0, y: 14)
    }
}

extension View {
    func glassCard(radius: CGFloat = GlassRadius.tile) -> some View {
        modifier(GlassCardStyle(radius: radius))
    }

    /// Wejście karty wg README: 800ms cubic-bezier(.22,.9,.3,1), from
    /// translateY(26px)+blur(6px), stagger przez `delay`.
    func glassRiseIn(delay: Double) -> some View {
        modifier(GlassRiseIn(delay: delay))
    }
}

struct GlassRiseIn: ViewModifier {
    let delay: Double
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 26)
            .blur(radius: shown ? 0 : 6)
            .onAppear {
                if reduceMotion {
                    shown = true
                } else {
                    withAnimation(.timingCurve(0.22, 0.9, 0.3, 1, duration: 0.8).delay(delay)) {
                        shown = true
                    }
                }
            }
    }
}

// MARK: - Pora dnia (adaptacyjne tło)
//
// README: tod-day (7–17) / tod-evening (17–21) / tod-night (reszta), przejścia 1.2s.

enum GlassTimeOfDay: CaseIterable {
    case day, evening, night

    static func fromClock(_ date: Date = Date()) -> GlassTimeOfDay {
        let h = Calendar.current.component(.hour, from: date)
        if h >= 7 && h < 17 { return .day }
        if h >= 17 && h < 21 { return .evening }
        return .night
    }

    var badgeLabel: String {
        switch self {
        case .day:     return "☀︎ Dzień"
        case .evening: return "◖ Wieczór"
        case .night:   return "☾ Noc"
        }
    }

    var next: GlassTimeOfDay {
        switch self {
        case .day: return .evening
        case .evening: return .night
        case .night: return .day
        }
    }
}

// MARK: - Toast center
//
// Globalny toast (design: pill nad tab barem, 250ms in / 2.4s hold).

@Observable
final class GlassToastCenter {
    var message: String? = nil
    var isError = false
    private var hideTask: Task<Void, Never>? = nil

    func show(_ msg: String, error: Bool = false) {
        hideTask?.cancel()
        message = msg
        isError = error
        hideTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_400_000_000)
            guard !Task.isCancelled else { return }
            message = nil
        }
    }
}

struct GlassToastView: View {
    let message: String
    let isError: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle" : "checkmark")
                .font(.system(size: 12, weight: .bold))
            Text(message)
                .font(.system(size: 13, weight: .semibold))
        }
        .foregroundStyle(isError ? GlassColor.dangerSoft : GlassColor.successLight)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background {
            Capsule().fill(.ultraThinMaterial)
                .overlay { Capsule().fill(Color(red: 18/255, green: 24/255, blue: 18/255).opacity(0.65)) }
        }
        .overlay {
            Capsule().strokeBorder(
                (isError ? GlassColor.danger : GlassColor.success).opacity(0.4), lineWidth: 1
            )
        }
        .shadow(color: .black.opacity(0.4), radius: 16, y: 6)
    }
}

// MARK: - Formattery (poza ViewBuilder — pułapka CLAUDE.md #17)

enum GlassFormat {
    static let dayLong: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "EEEE, d MMMM"
        return df
    }()

    static let shortDateTime: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "d MMM, HH:mm"
        return df
    }()

    static let timeOnly: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "HH:mm"
        return df
    }()

    static let relative: RelativeDateTimeFormatter = {
        let rf = RelativeDateTimeFormatter()
        rf.locale = Locale(identifier: "pl_PL")
        rf.unitsStyle = .short
        return rf
    }()

    static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func zl(_ value: Double) -> String {
        let nf = NumberFormatter()
        nf.locale = Locale(identifier: "pl_PL")
        nf.numberStyle = .decimal
        nf.minimumFractionDigits = 2
        nf.maximumFractionDigits = 2
        let s = nf.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
        return "\(s) zł"
    }

    static func dayLabel(_ date: Date = Date()) -> String {
        dayLong.string(from: date).capitalized(with: Locale(identifier: "pl_PL"))
    }

    static func guestWindow(_ g: Guest) -> String {
        let cal = Calendar.current
        let from = g.validFrom, to = g.validTo
        if cal.isDateInToday(from) {
            return "Dziś \(timeOnly.string(from: from))–\(timeOnly.string(from: to))"
        }
        if cal.isDateInTomorrow(from) {
            return "Jutro \(timeOnly.string(from: from))–\(timeOnly.string(from: to))"
        }
        return "\(shortDateTime.string(from: from)) – \(shortDateTime.string(from: to))"
    }
}

// MARK: - Color hex helper (kopia z GLTokens głównego targetu)
//
// IntercomCallView (WSPÓŁDZIELONY plik ekranu rozmowy) używa `Color(hex:)`,
// który w głównym targecie mieszka w GLTokens.swift. Glass nie kompiluje
// DesignSystem/ — definiujemy identyczny helper tutaj (Glass-only, bez
// konfliktu redeklaracji między targetami).

extension Color {
    init(hex: Int, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8)  & 0xFF) / 255.0
        let b = Double( hex        & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b, opacity: opacity)
    }
}

// MARK: - Wspólne małe komponenty

/// Kolorowy orb 38-42px z ikoną — wzorzec kafelków i wierszy sheetów.
struct GlassOrb: View {
    let gradient: [Color]
    let systemName: String
    var size: CGFloat = 38
    var iconSize: CGFloat = 17
    /// Prototyp używa ikon konturowych (stroke 1.9) — .medium oddaje tę kreskę.
    var iconWeight: Font.Weight = .semibold
    var iconRotation: Double = 0

    var body: some View {
        ZStack {
            Circle()
                .fill(LinearGradient(colors: gradient, startPoint: .topLeading, endPoint: .bottomTrailing))
                .overlay {
                    Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: 0.8)
                        .blendMode(.plusLighter)
                }
                .shadow(color: .black.opacity(0.35), radius: 9, y: 5)
            Image(systemName: systemName)
                .font(.system(size: iconSize, weight: iconWeight))
                .rotationEffect(.degrees(iconRotation))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}

/// Polska tablica rejestracyjna — czarne tło, żółta ramka, mono (design: .plate).
struct GlassPlateBadge: View {
    let plate: String

    var body: some View {
        Text(plate)
            .font(.system(size: 12, weight: .bold, design: .monospaced))
            .tracking(1.0)
            .foregroundStyle(GlassColor.plateYellow)
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(GlassColor.plateBg)
            .overlay {
                RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(GlassColor.plateYellow, lineWidth: 2)
            }
            .clipShape(RoundedRectangle(cornerRadius: 5))
    }
}

/// Przycisk .btn-glass — pełna szerokość, gradient albo ghost/danger.
struct GlassButton: View {
    enum Style { case primary, ghost, danger }
    let title: String
    var style: Style = .primary
    var busyText: String? = nil
    var isBusy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isBusy { ProgressView().tint(.white).scaleEffect(0.8) }
                Text(isBusy ? (busyText ?? title) : title)
                    .font(.system(size: 15, weight: style == .ghost ? .semibold : .bold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background {
                switch style {
                case .primary:
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(GlassColor.accentGradient)
                        .shadow(color: GlassColor.accentBlue.opacity(0.45), radius: 13, y: 5)
                case .danger:
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(GlassColor.dangerGradient)
                        .shadow(color: GlassColor.dangerDeep.opacity(0.4), radius: 13, y: 5)
                case .ghost:
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color.white.opacity(0.10))
                        .overlay {
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.18), lineWidth: 1)
                        }
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }
}
