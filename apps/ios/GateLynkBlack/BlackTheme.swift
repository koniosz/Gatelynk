import SwiftUI

/// Presentation tokens from the approved compact GateLynk mockup (2026-09-29).
/// Registered only in GateLynk_black; the existing applications keep their themes.
enum BlackTheme {
    static let background = Color(hex: 0x0D0E12)
    static let surface = Color(hex: 0x1B1D23)
    static let card = Color(hex: 0x1C1D25)
    static let text = Color(hex: 0xF4F3F7)
    static let muted = Color(hex: 0xA9ABB7)
    static let accent = Color(hex: 0xBFACFF)
    static let green = Color(hex: 0x64DDB0)
    static let blue = Color(hex: 0xA0C8FF)
    static let coral = Color(hex: 0xFFABB7)
    static let amber = Color(hex: 0xFFCA76)
    static let actionColors = [Color(hex: 0xC2ADFF), Color(hex: 0x9E9DFF), Color(hex: 0x7698FF)]
    static var actionGradient: LinearGradient {
        LinearGradient(colors: actionColors, startPoint: .leading, endPoint: .trailing)
    }
    static func heading(_ size: CGFloat, weight: Font.Weight = .medium) -> Font {
        let name = weight == .semibold || weight == .bold ? "BarlowSemiCondensed-SemiBold" : weight == .regular ? "BarlowSemiCondensed-Regular" : "BarlowSemiCondensed-Medium"
        return .custom(name, size: size, relativeTo: .title2)
    }
    static func cameraHeight(for availableHeight: CGFloat) -> CGFloat {
        availableHeight < 700 ? 138 : availableHeight < 750 ? 154 : 174
    }
}

struct BlackBackground: View {
    var body: some View {
        BlackTheme.background
            .overlay {
                RadialGradient(colors: [Color(hex: 0x282137).opacity(0.33), .clear], center: .topLeading, startRadius: 0, endRadius: 370)
            }
            .ignoresSafeArea()
    }
}

/// Exact Lucide artwork used in the approved mockup, bundled as vector templates.
struct BlackIcon: View {
    let name: String
    var size: CGFloat = 20
    var body: some View {
        Image("Black-" + name)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
