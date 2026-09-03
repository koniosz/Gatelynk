import SwiftUI

// MARK: - Glass shimmer — przesuwający się refleks światła (PROMPT 3)
//
// Port `.glass::after` z `Glass Depth Premium.html`:
//   • skośny pas światła (gradient transparent → white .10/.22/.10 →
//     transparent, kąt ~120°, skewX(−12°) ≈ rotacja pasa ~18°),
//   • szerokość pasa 60% kafelka, przejazd raz na ~18 s
//     (keyframes: 0–92% w spoczynku, 92→97% przejazd ≈ 0.9 s),
//   • starty ROZFAZOWANE między kaflami (delay 0 / 5 / 10 s — klasy sh2/sh3),
//   • maskowany do promienia kafelka, pointer-events-free, blend screen,
//   • wyłączony przy accessibilityReduceMotion (stan końcowy = brak pasa).
//
// Użycie: `.glassShimmer(delay: 5, radius: GlassRadius.tile)` NA kafelku
// (po .glassCard) — jeden reużywalny modifier dla quick-actions, karty
// Dostęp i karty Asystent.

struct GlassShimmerModifier: ViewModifier {
    var delay: Double = 0
    var radius: CGFloat = GlassRadius.tile

    /// Pozycja pasa w szerokościach kafelka: −0.9 (poza lewą) → 1.5 (poza prawą).
    @State private var phase: CGFloat = -0.9
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.overlay {
            if !reduceMotion {
                GeometryReader { geo in
                    let w = geo.size.width
                    let h = geo.size.height
                    Rectangle()
                        .fill(
                            LinearGradient(
                                stops: [
                                    .init(color: .clear, location: 0),
                                    .init(color: .white.opacity(0.10), location: 0.45),
                                    .init(color: .white.opacity(0.22), location: 0.5),
                                    .init(color: .white.opacity(0.10), location: 0.55),
                                    .init(color: .clear, location: 1),
                                ],
                                startPoint: .leading, endPoint: .trailing
                            )
                        )
                        // Pas wyższy niż kafelek, obrócony ~18° (kąt ~120°
                        // gradientu z HTML + skewX(−12°)).
                        .frame(width: w * 0.6, height: h * 2.4)
                        .rotationEffect(.degrees(18))
                        .offset(x: phase * w, y: -h * 0.7)
                        .task { await sweepLoop() }
                }
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
                .blendMode(.screen)
                .allowsHitTesting(false)
            }
        }
    }

    /// 18-sekundowy cykl: delay startowy (rozfazowanie), przejazd 0.9 s
    /// ease-in-out, reset bez animacji, pauza do pełnych ~18 s.
    private func sweepLoop() async {
        if delay > 0 {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
        while !Task.isCancelled {
            withAnimation(.easeInOut(duration: 0.9)) { phase = 1.5 }
            try? await Task.sleep(nanoseconds: 950_000_000)
            guard !Task.isCancelled else { return }
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) { phase = -0.9 }
            try? await Task.sleep(nanoseconds: 17_050_000_000)
        }
    }
}

extension View {
    /// Subtelny przejazd światła po szklanej powierzchni raz na ~18 s.
    /// `delay` rozfazowuje starty między kaflami (0 / 5 / 10 s jak sh2/sh3
    /// w HTML), `radius` musi odpowiadać promieniowi kafelka.
    func glassShimmer(delay: Double = 0, radius: CGFloat = GlassRadius.tile) -> some View {
        modifier(GlassShimmerModifier(delay: delay, radius: radius))
    }

    /// Wariant opcjonalny — `delay == nil` wyłącza shimmer (kafelek bez efektu).
    @ViewBuilder
    func glassShimmer(optionalDelay delay: Double?, radius: CGFloat = GlassRadius.tile) -> some View {
        if let delay {
            glassShimmer(delay: delay, radius: radius)
        } else {
            self
        }
    }
}
