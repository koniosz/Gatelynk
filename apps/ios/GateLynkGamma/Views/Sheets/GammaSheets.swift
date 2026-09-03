import SwiftUI

// MARK: - Bottom sheets — wspólny wzorzec
//
// README: scrim rgba(5,8,16,.45)+blur, sheet rgba(16,20,34,.85)+blur(40)
// saturate(180%), radius górny 34, grip 40×5, wejście translateY(105%)→0
// 380ms cubic-bezier(.32,.72,0,1), max-height 80%, nagłówek kicker+tytuł+✕.
//
// Implementacja: własny overlay w GammaHomeView (nie systemowy .sheet) —
// daje dokładny timing, chained sheets (Otwórz → potwierdzenie pożarowej)
// i glass look bez walki z UIKit.

enum GammaSheetKind: Identifiable, Equatable {
    case gate
    case vehicles
    case guests
    case payments
    case tickets
    case parcels
    case announcements
    case chat
    case more

    var id: String {
        switch self {
        case .gate: return "gate"
        case .vehicles: return "vehicles"
        case .guests: return "guests"
        case .payments: return "payments"
        case .tickets: return "tickets"
        case .parcels: return "parcels"
        case .announcements: return "announcements"
        case .chat: return "chat"
        case .more: return "more"
        }
    }
}

// MARK: - Kontener sheetu

struct GammaSheetContainer<Content: View>: View {
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
                topLeadingRadius: GammaRadius.sheet,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: GammaRadius.sheet,
                style: .continuous
            )
            .fill(.ultraThinMaterial)
            .overlay {
                UnevenRoundedRectangle(
                    topLeadingRadius: GammaRadius.sheet,
                    bottomLeadingRadius: 0,
                    bottomTrailingRadius: 0,
                    topTrailingRadius: GammaRadius.sheet,
                    style: .continuous
                )
                .fill(GammaColor.sheetBg.opacity(0.72))
            }
            .ignoresSafeArea(edges: .bottom)
        }
        .overlay(alignment: .top) {
            UnevenRoundedRectangle(
                topLeadingRadius: GammaRadius.sheet,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: GammaRadius.sheet,
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

struct GammaSheetHeader: View {
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

struct GammaActionRow<Trailing: View, Extra: View>: View {
    let orbGradient: [Color]
    let orbIcon: String
    let title: String
    let subtitle: String
    var dimmed = false
    @ViewBuilder var trailing: Trailing
    @ViewBuilder var extra: Extra

    var body: some View {
        HStack(alignment: .center, spacing: 13) {
            GammaOrb(gradient: orbGradient, systemName: orbIcon, size: 42, iconSize: 18)
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
            RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.08))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
        .opacity(dimmed ? 0.6 : 1)
    }
}

extension GammaActionRow where Trailing == EmptyView, Extra == EmptyView {
    init(orbGradient: [Color], orbIcon: String, title: String, subtitle: String, dimmed: Bool = false) {
        self.init(
            orbGradient: orbGradient, orbIcon: orbIcon, title: title,
            subtitle: subtitle, dimmed: dimmed,
            trailing: { EmptyView() }, extra: { EmptyView() }
        )
    }
}

extension GammaActionRow where Extra == EmptyView {
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

enum GammaCTAPhase: Equatable { case idle, busy, ok }

struct GammaOpenCTA: View {
    let phase: GammaCTAPhase
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
            .foregroundStyle(phase == .ok ? GammaColor.successLight : .white)
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
                .fill(danger ? GammaColor.dangerGradient : GammaColor.accentGradient)
                .shadow(color: (danger ? GammaColor.dangerDeep : GammaColor.accentBlue).opacity(0.45), radius: 7, y: 3)
        case .busy:
            Capsule().fill(Color.white.opacity(0.14))
        case .ok:
            Capsule().fill(GammaColor.success.opacity(0.2))
        }
    }
}

// MARK: - Pusty stan / loading w sheetach

struct GammaSheetEmptyState: View {
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

struct GammaSheetLoading: View {
    var body: some View {
        ProgressView()
            .tint(.white.opacity(0.7))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
    }
}
