import SwiftUI

// MARK: - GLCard
//
// Standardowy card wrapper. Domyślne padding=16, radius=lg (16),
// background=bg2, border=subtle, shadow=sm. Większość ekranów używa tej
// kombinacji — wystarczy `GLCard { ... }`.

struct GLCard<Content: View>: View {
    var padding: CGFloat = 16
    var radius: CGFloat = GLRadius.lg
    @ViewBuilder let content: Content

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(GLColor.bg2(scheme))
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
            )
            .glShadow(.sm)
    }
}

// MARK: - GLPill
//
// Mały badge/pill — np. „Online", „Bateria 87%". Default outlined.
// Filled wariant gdy `filled = true` (np. status counter).

struct GLPill: View {
    enum Style { case neutral, success, warning, danger, info, accent }

    let text: String
    var style: Style = .neutral
    var filled: Bool = false

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(background)
            .foregroundStyle(foreground)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(borderColor, lineWidth: filled ? 0 : 1))
    }

    private var foreground: Color {
        if filled { return .white }
        switch style {
        case .neutral: return GLColor.textSecondary(scheme)
        case .success: return GLColor.success(scheme)
        case .warning: return GLColor.warning(scheme)
        case .danger:  return GLColor.danger(scheme)
        case .info:    return GLColor.info(scheme)
        case .accent:  return GLColor.accent300(scheme)
        }
    }
    private var background: Color {
        if filled {
            switch style {
            case .neutral: return GLColor.bg3(scheme)
            case .success: return GLColor.success(scheme)
            case .warning: return GLColor.warning(scheme)
            case .danger:  return GLColor.danger(scheme)
            case .info:    return GLColor.info(scheme)
            case .accent:  return GLColor.accent300(scheme)
            }
        }
        switch style {
        case .neutral: return GLColor.bg3(scheme).opacity(0.5)
        case .success: return GLColor.success(scheme).opacity(0.12)
        case .warning: return GLColor.warning(scheme).opacity(0.14)
        case .danger:  return GLColor.danger(scheme).opacity(0.14)
        case .info:    return GLColor.info(scheme).opacity(0.14)
        case .accent:  return GLColor.accent300(scheme).opacity(0.16)
        }
    }
    private var borderColor: Color {
        switch style {
        case .neutral: return GLColor.borderSubtle(scheme)
        case .success: return GLColor.success(scheme).opacity(0.30)
        case .warning: return GLColor.warning(scheme).opacity(0.30)
        case .danger:  return GLColor.danger(scheme).opacity(0.30)
        case .info:    return GLColor.info(scheme).opacity(0.30)
        case .accent:  return GLColor.accent300(scheme).opacity(0.30)
        }
    }
}

// MARK: - GLSectionHeader
//
// Uppercase + tracking 0.12em. Używane przed sekcjami:
// „MÓJ DOM", „OSTATNIA AKTYWNOŚĆ" w designie.

struct GLSectionHeader: View {
    let title: String
    var trailing: (() -> AnyView)?

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.5) // ~ letter-spacing 0.12em na ~11px
                .foregroundStyle(GLColor.textTertiary(scheme))
            Spacer()
            if let trailing { trailing() }
        }
        .padding(.horizontal, 4)
    }
}

// MARK: - GLIconBadge
//
// Okrągły container na ikonę, jak ikony w „Ostatnia aktywność" lub avatar
// quick-tile-u. Default 30×30, customowy size + tint.

struct GLIconBadge: View {
    let systemName: String
    var size: CGFloat = 30
    var tint: Color
    var background: Color?

    var body: some View {
        ZStack {
            Circle().fill(background ?? tint.opacity(0.18))
            Image(systemName: systemName)
                .font(.system(size: size * 0.50, weight: .semibold))
                .foregroundStyle(tint)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - GLPrimaryButton
//
// Główny CTA na ekranie — accent gradient, glow shadow, biały tekst.
// Designerska wersja „Otwórz" w Home v3. Dla mniejszych akcji użyj
// `GLSecondaryButton` (zostanie dodane w secondary screens).

struct GLPrimaryButton: View {
    let title: String
    var subtitle: String? = nil
    var systemIcon: String? = nil
    var action: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                if let systemIcon {
                    ZStack {
                        Circle().fill(Color.white.opacity(0.20))
                        Image(systemName: systemIcon)
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .frame(width: 54, height: 54)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(.white)
                    if let subtitle {
                        HStack(spacing: 6) {
                            Circle().fill(Color(hex: 0x7BE2A3)).frame(width: 6, height: 6)
                            Text(subtitle)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(Color.white.opacity(0.78))
                        }
                    }
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.white.opacity(0.85))
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 18)
            .frame(maxWidth: .infinity)
            .background(GLColor.accentGradient(scheme))
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .buttonStyle(.plain)
        .glShadow(.glow)
    }
}

// MARK: - GLQuickTile
//
// Mały tile w sekcji „Pojazdy / Goście / Płatności" pod Otwórz. Ikona + label.
// Opcjonalne `badge` (np. „!") pokazane w prawym górnym rogu.

struct GLQuickTile: View {
    let title: String
    let systemIcon: String
    var iconSize: CGFloat = 22
    var badge: String? = nil
    var badgeStyle: GLPill.Style = .danger
    var action: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                VStack(spacing: 8) {
                    Image(systemName: systemIcon)
                        .font(.system(size: iconSize, weight: .regular))
                        .foregroundStyle(
                            badgeStyle == .danger && badge != nil
                                ? GLColor.danger(scheme)
                                : GLColor.accent300(scheme),
                        )
                        .frame(height: 30)
                    Text(title)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(GLColor.textSecondary(scheme))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(GLColor.bg2(scheme))
                .clipShape(RoundedRectangle(cornerRadius: GLRadius.lg, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: GLRadius.lg, style: .continuous)
                        .stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
                )

                if let badge {
                    Text(badge)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(minWidth: 16, minHeight: 16)
                        .padding(.horizontal, 5)
                        .background(
                            badgeStyle == .danger
                                ? GLColor.danger(scheme)
                                : GLColor.accent400(scheme),
                        )
                        .clipShape(Capsule())
                        .padding(.top, 8)
                        .padding(.trailing, 10)
                }
            }
        }
        .buttonStyle(.plain)
        .glShadow(.sm)
    }
}

// MARK: - GLHeroPhoto
//
// Full-bleed building photo z dwoma gradientami:
//   • top — readability dla status bar / greeting (czarny→przezroczysty)
//   • bottom — fade to bg color (przezroczysty→bg1)
//
// `imageBase64` może być nilem — wtedy gradient solid color fallback.
// Wysokość 360 (z designu — `HERO_H`).

struct GLHeroPhoto: View {
    let imageBase64: String?
    var height: CGFloat = 360

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack(alignment: .top) {
            // Image lub fallback gradient (gdy budynek nie ma ustawionego zdjęcia).
            // KRYTYCZNE: `frame(maxWidth: .infinity)` + `.clipped()` — bez tego
            // Image z `aspectRatio(.fill)` rozszerza się do swojej naturalnej
            // szerokości (np. 1024pt), a ZStack łapie tę szerokość i pcha całość
            // poza screen (bug 2026-05-11: greeting / quick tiles przesunięte
            // w lewo o ~30pt).
            Group {
                if let img = decodedImage {
                    Image(uiImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    LinearGradient(
                        colors: [
                            GLColor.bg3(scheme),
                            GLColor.bg2(scheme),
                        ],
                        startPoint: .top,
                        endPoint: .bottom,
                    )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: height)
            .clipped()

            // Top gradient — czytelność dla status bar + greeting
            LinearGradient(
                stops: [
                    .init(color: Color.black.opacity(0.55), location: 0),
                    .init(color: Color.black.opacity(0.20), location: 0.60),
                    .init(color: Color.black.opacity(0.00), location: 1.0),
                ],
                startPoint: .top,
                endPoint: .bottom,
            )
            .frame(maxWidth: .infinity, maxHeight: 180)

            // Bottom gradient — fade to bg color
            VStack {
                Spacer()
                LinearGradient(
                    stops: [
                        .init(color: GLColor.bg1(scheme).opacity(0), location: 0),
                        .init(color: GLColor.bg1(scheme).opacity(0.55), location: 0.55),
                        .init(color: GLColor.bg1(scheme), location: 1.0),
                    ],
                    startPoint: .top,
                    endPoint: .bottom,
                )
                .frame(maxWidth: .infinity, maxHeight: 200)
            }
            .frame(maxWidth: .infinity, maxHeight: height)
        }
        .frame(maxWidth: .infinity, maxHeight: height)
        .clipped()
        .allowsHitTesting(false)
    }

    private var decodedImage: UIImage? {
        guard let s = imageBase64, !s.isEmpty else { return nil }
        // Może być z prefixem `data:image/...;base64,` — strip jak w HomeView.
        let payload = s.contains(",") ? String(s.split(separator: ",", maxSplits: 1).last ?? "") : s
        guard let data = Data(base64Encoded: payload, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }
}

// MARK: - GLActivityRow
//
// Wiersz w „Ostatnia aktywność" — ikona + tytuł + czas.

struct GLActivityRow: View {
    let systemIcon: String
    let iconTint: Color
    let title: String
    let time: String

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 12) {
            GLIconBadge(systemName: systemIcon, size: 30, tint: iconTint)
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(GLColor.textPrimary(scheme))
                .lineLimit(1)
            Spacer()
            Text(time)
                .font(.system(size: 11.5, weight: .regular))
                .foregroundStyle(GLColor.textTertiary(scheme))
                .monospacedDigit()
        }
        .padding(.vertical, 12)
    }
}

// MARK: - GLDivider
//
// Cienka linia separator między wierszami, używana w GLActivityRow grupie.

struct GLDivider: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Rectangle()
            .fill(GLColor.borderSubtle(scheme))
            .frame(height: 1)
    }
}
