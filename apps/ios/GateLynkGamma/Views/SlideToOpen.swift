import SwiftUI

// MARK: - Slider "Przesuń, aby otworzyć →"
//
// Stany (README): idle → dragging → success (3.2s) → idle.
// Fill podąża za kciukiem, sukces = zielony stan + ripple + haptic.
// Napis ma animowany połysk (w CSS background-clip:text → tu maska
// z przesuwającym się gradientem).

struct SlideToOpen: View {
    /// Wywoływane po dociągnięciu do końca. Zwraca czy otwarcie się udało.
    let action: () async -> Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum SlideState: Equatable { case idle, dragging, success, failed }

    @State private var slideState: SlideState = .idle
    @State private var dragX: CGFloat = 0
    @State private var rippleTrigger = 0
    @State private var shimmerPhase: CGFloat = -1

    private let height: CGFloat = 58
    private let thumbSize: CGFloat = 50
    private let inset: CGFloat = 4

    var body: some View {
        GeometryReader { geo in
            let maxDrag = geo.size.width - thumbSize - inset * 2

            ZStack(alignment: .leading) {
                // Track
                Capsule()
                    .fill(Color.black.opacity(0.30))
                    .overlay { Capsule().strokeBorder(Color.white.opacity(0.18), lineWidth: 1) }

                // Fill podążający za kciukiem
                Capsule()
                    .fill(fillGradient)
                    .frame(width: inset + thumbSize + dragX)

                // Hint / status
                hintLabel
                    .frame(maxWidth: .infinity)

                // Ripple przy sukcesie
                if slideState == .success {
                    Circle()
                        .strokeBorder(GammaColor.success.opacity(0.8), lineWidth: 2)
                        .frame(width: 10, height: 10)
                        .scaleEffect(rippleScale)
                        .opacity(rippleOpacity)
                        .frame(maxWidth: .infinity)
                        .id(rippleTrigger)
                        .onAppear {
                            withAnimation(.easeOut(duration: 1.0)) {
                                rippleScale = 30
                                rippleOpacity = 0
                            }
                        }
                }

                // Thumb
                thumb
                    .offset(x: inset + dragX)
                    .gesture(dragGesture(maxDrag: maxDrag))
            }
        }
        .frame(height: height)
        .onAppear { startShimmer() }
    }

    @State private var rippleScale: CGFloat = 1
    @State private var rippleOpacity: Double = 1

    // MARK: Pieces

    private var fillGradient: LinearGradient {
        if slideState == .success {
            return LinearGradient(
                colors: [GammaColor.success.opacity(0.6), GammaColor.success.opacity(0.35)],
                startPoint: .leading, endPoint: .trailing
            )
        }
        return LinearGradient(
            colors: [GammaColor.accentLight.opacity(0.5), GammaColor.accentBlue.opacity(0.55)],
            startPoint: .leading, endPoint: .trailing
        )
    }

    private var hintText: String {
        switch slideState {
        case .success: return "Otwarta ✓"
        case .failed:  return "Nie udało się"
        default:       return "Przesuń, aby otworzyć →"
        }
    }

    @ViewBuilder
    private var hintLabel: some View {
        let base = Text(hintText)
            .font(.system(size: 13, weight: .semibold))

        if slideState == .success {
            base.foregroundStyle(.white.opacity(0.95))
        } else if slideState == .failed {
            base.foregroundStyle(GammaColor.dangerSoft)
        } else {
            base
                .foregroundStyle(.white.opacity(0.66))
                .overlay {
                    GeometryReader { g in
                        LinearGradient(
                            colors: [.clear, .white, .clear],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: 90)
                        .offset(x: shimmerPhase * (g.size.width + 90) - 90)
                    }
                    .mask(base)
                }
                .allowsHitTesting(false)
        }
    }

    private var thumb: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [.white, Color(red: 229/255, green: 222/255, blue: 1)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
                .shadow(color: .black.opacity(0.4), radius: 9, y: 4)
            Image(systemName: slideState == .success ? "checkmark" : "lock.open")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(
                    slideState == .success
                        ? Color(red: 5/255, green: 150/255, blue: 105/255)
                        : Color(red: 91/255, green: 62/255, blue: 191/255)
                )
        }
        .frame(width: thumbSize, height: thumbSize)
    }

    // MARK: Gesture

    private func dragGesture(maxDrag: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard slideState == .idle || slideState == .dragging else { return }
                slideState = .dragging
                dragX = min(max(0, value.translation.width), maxDrag)
                if dragX >= maxDrag - 3 {
                    complete(maxDrag: maxDrag)
                }
            }
            .onEnded { _ in
                guard slideState == .dragging else { return }
                slideState = .idle
                withAnimation(.timingCurve(0.22, 0.9, 0.3, 1, duration: 0.35)) {
                    dragX = 0
                }
            }
    }

    private func complete(maxDrag: CGFloat) {
        slideState = .success
        dragX = maxDrag
        rippleTrigger += 1
        rippleScale = 1
        rippleOpacity = 1
        UINotificationFeedbackGenerator().notificationOccurred(.success)

        Task {
            let ok = await action()
            if !ok {
                slideState = .failed
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            // auto-reset po 3.2s (design)
            try? await Task.sleep(nanoseconds: 3_200_000_000)
            withAnimation(.timingCurve(0.22, 0.9, 0.3, 1, duration: 0.45)) {
                dragX = 0
            }
            slideState = .idle
        }
    }

    private func startShimmer() {
        guard !reduceMotion else { return }
        shimmerPhase = -1
        withAnimation(.linear(duration: 2.6).repeatForever(autoreverses: false)) {
            shimmerPhase = 1.6
        }
    }
}
