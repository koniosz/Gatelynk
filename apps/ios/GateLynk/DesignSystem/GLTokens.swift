import SwiftUI

/// GateLynk design tokens — port z `docs/design/resident-2026-05-11/source/styles/tokens.css`.
///
/// Dark-first, premium residential, fioletowy akcent. Trzy poziomy:
///   • `GLColor`   — kolory (auto dark/light przez SwiftUI environment)
///   • `GLRadius`  — corner radii (sm 8 → 3xl 32 → full 999)
///   • `GLShadow`  — system cieni (`.shadow(GLShadow.md)`)
///   • `GLSpacing` — common values (4, 8, 12, 16, 20, 24)
///
/// Konwencja: każdy widget używa GLColor.* zamiast hardcoded hex-ów. Theme
/// toggle dziedziczy przez `colorScheme` env — designer ma równolegle
/// `[data-theme="dark"]` i `[data-theme="light"]` w CSS, tu używamy
/// `@Environment(\.colorScheme)` żeby pasowało do iOS Dark Mode.
enum GLColor {

    // MARK: - Surfaces (layered)
    //
    // 2026-06-09 — kolory tła odczytywane z AppTheme (UserDefaults key
    // `appTheme`). Domyślny preset to .darkClassic (legacy paleta). Każdy
    // preset definiuje własne 5 odcieni bg0–bg4 plus border + text overrides.
    // Color scheme (dark/light) wciąż steruje którym wariantem koloru
    // ma być border / text — większość presetów jest "dark-only" i ignoruje
    // colorScheme, ale `.lightClassic` korzysta z jasnej palety.

    /// Najgłębsze tło (poza ramką ekranu).
    static func bg0(_ scheme: ColorScheme) -> Color {
        Color(hex: AppTheme.current.bg0(scheme))
    }

    /// App background — tła ScrollView.
    static func bg1(_ scheme: ColorScheme) -> Color {
        Color(hex: AppTheme.current.bg1(scheme))
    }

    /// Card / sheet base.
    static func bg2(_ scheme: ColorScheme) -> Color {
        Color(hex: AppTheme.current.bg2(scheme))
    }

    /// Elevated card (lifted).
    static func bg3(_ scheme: ColorScheme) -> Color {
        Color(hex: AppTheme.current.bg3(scheme))
    }

    /// Hover / pressed.
    static func bg4(_ scheme: ColorScheme) -> Color {
        Color(hex: AppTheme.current.bg4(scheme))
    }

    // MARK: - Borders & dividers

    static func borderSubtle(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color.white.opacity(0.06)
            : Color(hex: 0x0F172A).opacity(0.06)
    }

    static func borderDefault(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color.white.opacity(0.10)
            : Color(hex: 0x0F172A).opacity(0.10)
    }

    static func borderStrong(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color.white.opacity(0.18)
            : Color(hex: 0x0F172A).opacity(0.18)
    }

    // MARK: - Text

    static func textPrimary(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0xF4F6FB) : Color(hex: 0x0B1020)
    }

    static func textSecondary(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0xB7C0D8) : Color(hex: 0x475069)
    }

    static func textTertiary(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x7C8AAA) : Color(hex: 0x6E7891)
    }

    static func textDisabled(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x4F5A77) : Color(hex: 0xB5BCCC)
    }

    // MARK: - Brand accent (user-selectable, 2026-05-22)
    //
    // Wcześniej był hardcoded violet (#A78BFA). Teraz user może wybrać kolor
    // motywu w SettingsView. Klucz `appAccentColor` w UserDefaults trzyma
    // raw value z `AccentTheme` enum (purple/blue/cyan/green/orange/pink/red).
    //
    // GLColor.* czyta klucz synchronicznie. SwiftUI rerenderuje gdy ANY widok
    // ma @AppStorage("appAccentColor") w body (MainTabView, ProfileView itp).

    /// Aktualny preset z UserDefaults (default = purple). Lookup tani — O(1).
    ///
    /// 2026-06-09 — AppTheme może wymuszać accent (np. Midnight Blue → gold,
    /// Forest → yellow, Vibrant Dark → fuchsia). Gdy preset ma `forcedAccent`,
    /// ten wpis wygrywa nad `appAccentColor`. Klasyczny dark/light/professional
    /// nie wymusza — user dalej może wybrać accent swatch w SettingsView.
    private static func currentTheme() -> AccentTheme {
        if let forced = AppTheme.current.forcedAccent { return forced }
        let raw = UserDefaults.standard.string(forKey: "appAccentColor") ?? "purple"
        return AccentTheme(rawValue: raw) ?? .purple
    }

    /// `--accent-300` — primary accent button color. W light mode deeper dla kontrastu.
    static func accent300(_ scheme: ColorScheme) -> Color {
        let t = currentTheme()
        return scheme == .dark ? Color(hex: t.dark300) : Color(hex: t.light300)
    }

    /// `--accent-400` — gradient bottom-right partner z accent300.
    static func accent400(_ scheme: ColorScheme) -> Color {
        let t = currentTheme()
        return scheme == .dark ? Color(hex: t.dark400) : Color(hex: t.light400)
    }

    /// `--accent-200` — softer accent dla ikon/badges.
    static func accent200(_ scheme: ColorScheme) -> Color {
        Color(hex: currentTheme().soft200)
    }

    /// Glow — boxShadow color (rgba z accent w odpowiedniej opacity).
    static func accentGlow(_ scheme: ColorScheme) -> Color {
        let glow = currentTheme().glowRGB
        return scheme == .dark
            ? Color(red: glow.r, green: glow.g, blue: glow.b, opacity: 0.35)
            : Color(red: glow.r, green: glow.g, blue: glow.b, opacity: 0.22)
    }

    /// Gradient primary „Otwórz" button — `linear-gradient(135deg, accent300, accent400)`.
    static func accentGradient(_ scheme: ColorScheme) -> LinearGradient {
        LinearGradient(
            colors: [accent300(scheme), accent400(scheme)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing,
        )
    }

    // MARK: - Semantic

    static func success(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x34D399) : Color(hex: 0x059669)
    }

    static func warning(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0xFBBF24) : Color(hex: 0xD97706)
    }

    static func danger(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0xF87171) : Color(hex: 0xDC2626)
    }

    static func info(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0x60A5FA) : Color(hex: 0x2563EB)
    }

    // MARK: - Activity icons

    static func iconOrange(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? Color(hex: 0xF59E0B) : Color(hex: 0xEA580C)
    }
}

// MARK: - Radius

enum GLRadius {
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xl2: CGFloat = 24
    static let xl3: CGFloat = 32
    /// Pill / full circle. SwiftUI nie ma „infinity" — używamy 999 jak CSS.
    static let full: CGFloat = 999
}

// MARK: - Shadow

/// Wstępnie zdefiniowane cienie. Używaj `.glShadow(.md)` na `View`.
enum GLShadow {
    case sm, md, lg, glow

    func params(_ scheme: ColorScheme) -> (color: Color, radius: CGFloat, x: CGFloat, y: CGFloat) {
        switch self {
        case .sm:
            // 0 1px 2px rgba(0,0,0,.30) dark | rgba(15,23,42,.06) light
            return (
                scheme == .dark
                    ? Color.black.opacity(0.30)
                    : Color(hex: 0x0F172A).opacity(0.06),
                radius: 2,
                x: 0, y: 1,
            )
        case .md:
            // 0 8px 24px rgba(0,0,0,.35) dark | rgba(15,23,42,.08) light
            return (
                scheme == .dark
                    ? Color.black.opacity(0.35)
                    : Color(hex: 0x0F172A).opacity(0.08),
                radius: 24,
                x: 0, y: 8,
            )
        case .lg:
            // 0 20px 50px rgba(0,0,0,.45) dark | rgba(15,23,42,.12) light
            return (
                scheme == .dark
                    ? Color.black.opacity(0.45)
                    : Color(hex: 0x0F172A).opacity(0.12),
                radius: 50,
                x: 0, y: 20,
            )
        case .glow:
            return (
                scheme == .dark
                    ? Color(red: 0.654, green: 0.545, blue: 0.980, opacity: 0.35)
                    : Color(red: 0.439, green: 0.314, blue: 0.878, opacity: 0.22),
                radius: 40,
                x: 0, y: 0,
            )
        }
    }
}

extension View {
    /// Stosuje GLShadow respektując bieżący colorScheme.
    func glShadow(_ shadow: GLShadow) -> some View {
        modifier(GLShadowModifier(shadow: shadow))
    }
}

private struct GLShadowModifier: ViewModifier {
    let shadow: GLShadow
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        let p = shadow.params(scheme)
        return content.shadow(color: p.color, radius: p.radius, x: p.x, y: p.y)
    }
}

// MARK: - Spacing

/// W CSS-ie nie ma formal scale — używamy common values: 4, 8, 12, 16, 20, 24.
/// W Swift wystarczy do tego CGFloat literał, ale aliasy ułatwiają review-iarstwo.
enum GLSpacing {
    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 20
    static let xl2: CGFloat = 24
}

// MARK: - Color hex helper

extension Color {
    /// Tworzy kolor z 6-cyfrowego hex int (np. 0xA78BFA). Bez alpha (opacity z `.opacity()`).
    /// Trzymamy to internal — nie ma sensu eksportować jako publicznej extension.
    init(hex: Int, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8)  & 0xFF) / 255.0
        let b = Double( hex        & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b, opacity: opacity)
    }
}


// MARK: - AccentTheme (2026-05-22)
//
// User-wybieralny preset koloru motywu. Każdy preset ma 4 odcienie:
//   • dark300  / light300  — primary accent (button bg, sparkle icon)
//   • dark400  / light400  — gradient partner z 300 (linear-gradient corner)
//   • soft200  — pastelowa wersja (icon backgrounds, accent200)
//   • glowRGB  — base RGB do glow shadow (z opacity 35%/22%)
//
// Default: violet (legacy starting palette). Klucz UserDefaults: appAccentColor.
//
// Żeby dodać nowy preset:
//   1. case w enum
//   2. wpis w switch w `palette` static map (4 hex-y + 1 RGB triple)
//   3. wpis w `displayName` switch (PL nazwa do UI)
//   4. wpis w `previewColor` (kolor swatcha w UI ProfileView)

enum AccentTheme: String, CaseIterable, Identifiable {
    case purple   // legacy default
    case blue
    case cyan
    case green
    case orange
    case pink
    case red

    var id: String { rawValue }

    /// PL nazwa wyświetlana w UI ustawień.
    var displayName: String {
        switch self {
        case .purple: return "Fioletowy"
        case .blue:   return "Niebieski"
        case .cyan:   return "Cyjanowy"
        case .green:  return "Zielony"
        case .orange: return "Pomarańczowy"
        case .pink:   return "Różowy"
        case .red:    return "Czerwony"
        }
    }

    var dark300: Int {
        switch self {
        case .purple: return 0xA78BFA
        case .blue:   return 0x60A5FA
        case .cyan:   return 0x22D3EE
        case .green:  return 0x4ADE80
        case .orange: return 0xFB923C
        case .pink:   return 0xF472B6
        case .red:    return 0xF87171
        }
    }

    var light300: Int {
        switch self {
        case .purple: return 0x7050E0
        case .blue:   return 0x2563EB
        case .cyan:   return 0x0891B2
        case .green:  return 0x16A34A
        case .orange: return 0xEA580C
        case .pink:   return 0xDB2777
        case .red:    return 0xDC2626
        }
    }

    var dark400: Int {
        switch self {
        case .purple: return 0x8B6BF0
        case .blue:   return 0x3B82F6
        case .cyan:   return 0x06B6D4
        case .green:  return 0x22C55E
        case .orange: return 0xF97316
        case .pink:   return 0xEC4899
        case .red:    return 0xEF4444
        }
    }

    var light400: Int {
        switch self {
        case .purple: return 0x5A3EBF
        case .blue:   return 0x1D4ED8
        case .cyan:   return 0x0E7490
        case .green:  return 0x15803D
        case .orange: return 0xC2410C
        case .pink:   return 0xBE185D
        case .red:    return 0xB91C1C
        }
    }

    var soft200: Int {
        switch self {
        case .purple: return 0xC5B0FF
        case .blue:   return 0xBFDBFE
        case .cyan:   return 0xA5F3FC
        case .green:  return 0xBBF7D0
        case .orange: return 0xFED7AA
        case .pink:   return 0xFBCFE8
        case .red:    return 0xFECACA
        }
    }

    /// Base RGB (0..1) do tworzenia glow Color z opacity. Wyciągnięte
    /// z `dark300` żeby glow pasował do primary accent w dark mode.
    var glowRGB: (r: Double, g: Double, b: Double) {
        let hex = dark300
        return (
            r: Double((hex >> 16) & 0xFF) / 255.0,
            g: Double((hex >> 8)  & 0xFF) / 255.0,
            b: Double( hex        & 0xFF) / 255.0,
        )
    }

    /// Pojedynczy reprezentatywny kolor do swatcha w UI (preset preview).
    var previewColor: Color {
        Color(hex: dark300)
    }
}


// MARK: - AppTheme (2026-06-09)
//
// Cały preset wyglądu aplikacji (tło + akcent + colorScheme) wybierany w
// SettingsView. Wcześniej `appTheme` był tylko "dark"/"light". Teraz 6 opcji:
//
//   • darkClassic    — dotychczasowy ciemny granatowy (#0B1020) z fioletowym
//                      domyślnym akcentem; respektuje wybór `appAccentColor`.
//   • lightClassic   — dotychczasowy jasny (#F6F8FC, biały); akcent też
//                      pochodzi z `appAccentColor`.
//   • vibrantDark    — ciemne tło (#0E0F1B) z wymuszonym fuchsia/pink akcentem
//                      dla "živych" kolorów (mniej pastelu).
//   • professional   — czarno-białe minimalistyczne dark (#0A0A0D) z wymuszonym
//                      royal-blue akcentem, mocno nasycony zamiast pastelu.
//   • midnightBlue   — głęboki granat (#0A1929) z accent gold/orange.
//   • forest         — ciemna zieleń (#0E1F12) z accent jasnej żółci.
//
// Klucz UserDefaults: `appTheme`. Wartość = rawValue. Backwards-compat:
// "dark" mapuje na .darkClassic, "light" mapuje na .lightClassic.
//
// GLColor.bg* / accent* czytają preset synchronicznie. SwiftUI re-renderuje
// gdy widoki mają @AppStorage("appTheme") w body (MainTabView, HomeView).

enum AppTheme: String, CaseIterable, Identifiable {
    case darkClassic = "dark"
    case lightClassic = "light"
    case vibrantDark = "vibrant_dark"
    case professional = "professional"
    case midnightBlue = "midnight_blue"
    case forest = "forest"

    var id: String { rawValue }

    /// PL nazwa wyświetlana w SettingsView.
    var displayName: String {
        switch self {
        case .darkClassic:  return "Klasyczny ciemny"
        case .lightClassic: return "Klasyczny jasny"
        case .vibrantDark:  return "Vibrant Dark"
        case .professional: return "Professional"
        case .midnightBlue: return "Midnight Blue"
        case .forest:       return "Forest"
        }
    }

    /// Krótki opis (zdanie pod nazwą w pickerze).
    var description: String {
        switch self {
        case .darkClassic:  return "Granat z fioletowym akcentem"
        case .lightClassic: return "Biała baza, akcent kolorowy"
        case .vibrantDark:  return "Ciemny z żywą fuksją"
        case .professional: return "Minimalistyczna czerń z royal blue"
        case .midnightBlue: return "Głęboki granat z złotym akcentem"
        case .forest:       return "Ciemna zieleń z żółtym akcentem"
        }
    }

    /// Aktualny preset z UserDefaults. Backwards-compat dla "dark"/"light".
    static var current: AppTheme {
        let raw = UserDefaults.standard.string(forKey: "appTheme") ?? "dark"
        return AppTheme(rawValue: raw) ?? .darkClassic
    }

    /// preferredColorScheme dla SwiftUI .preferredColorScheme modifier.
    /// nil = follow system; lightClassic = light, reszta = dark.
    var colorScheme: ColorScheme? {
        switch self {
        case .lightClassic: return .light
        default:            return .dark
        }
    }

    /// Wymuszony AccentTheme dla presetów które chcą konkretny kolor accent
    /// (Midnight Blue → gold, Forest → yellow, Vibrant Dark → pink).
    /// nil = user wybór z `appAccentColor` swatcha.
    var forcedAccent: AccentTheme? {
        switch self {
        case .vibrantDark:  return .pink     // fuchsia (mocno nasycona)
        case .professional: return .blue     // royal blue
        case .midnightBlue: return .orange   // gold/amber feeling
        case .forest:       return .green    // a paleta soft też pasuje
        default:            return nil
        }
    }

    // ─── Background palette ─────────────────────────────────────────────
    //
    // Każdy preset ma 5 odcieni bg0..bg4. Dla dark-first presetów ignorujemy
    // colorScheme (zawsze dark hex). Dla lightClassic dzielimy na dark/light.
    // Klasyczne presety zachowują dotychczasowe hex-y żeby istniejące widoki
    // nie zmieniły wizualnie wyglądu po default appTheme.

    func bg0(_ scheme: ColorScheme) -> Int {
        switch self {
        case .darkClassic:  return 0x06080F
        case .lightClassic: return scheme == .dark ? 0x06080F : 0xEEF1F8
        case .vibrantDark:  return 0x05060D
        case .professional: return 0x000000
        case .midnightBlue: return 0x05101D
        case .forest:       return 0x06120A
        }
    }

    func bg1(_ scheme: ColorScheme) -> Int {
        switch self {
        case .darkClassic:  return 0x0B1020
        case .lightClassic: return scheme == .dark ? 0x0B1020 : 0xF6F8FC
        case .vibrantDark:  return 0x0E0F1B
        case .professional: return 0x0A0A0D
        case .midnightBlue: return 0x0A1929
        case .forest:       return 0x0E1F12
        }
    }

    func bg2(_ scheme: ColorScheme) -> Int {
        switch self {
        case .darkClassic:  return 0x131A2E
        case .lightClassic: return scheme == .dark ? 0x131A2E : 0xFFFFFF
        case .vibrantDark:  return 0x171829
        case .professional: return 0x131318
        case .midnightBlue: return 0x132A41
        case .forest:       return 0x172E1C
        }
    }

    func bg3(_ scheme: ColorScheme) -> Int {
        switch self {
        case .darkClassic:  return 0x1B2440
        case .lightClassic: return scheme == .dark ? 0x1B2440 : 0xFFFFFF
        case .vibrantDark:  return 0x21223A
        case .professional: return 0x1B1B23
        case .midnightBlue: return 0x1B3551
        case .forest:       return 0x213A27
        }
    }

    func bg4(_ scheme: ColorScheme) -> Int {
        switch self {
        case .darkClassic:  return 0x232E55
        case .lightClassic: return scheme == .dark ? 0x232E55 : 0xF0F2F8
        case .vibrantDark:  return 0x2C2D4A
        case .professional: return 0x252530
        case .midnightBlue: return 0x244367
        case .forest:       return 0x2A4831
        }
    }

    /// Reprezentatywny preview color do swatcha w UI (kolory tła).
    var previewColor: Color {
        Color(hex: bg1(.dark))
    }

    /// Drugi swatch (accent dot) — pokazuje kolor akcentu jeśli wymuszony.
    var previewAccentColor: Color? {
        guard let acc = forcedAccent else { return nil }
        return Color(hex: acc.dark300)
    }
}
