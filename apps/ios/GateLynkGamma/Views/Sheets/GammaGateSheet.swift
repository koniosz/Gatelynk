import SwiftUI

// MARK: - Sheet "Co chcesz otworzyć?"
//
// Lista realnych access pointów z /resident/access-points. CTA "Otwórz" →
// spinner "Otwieram" → "Otwarte ✓" (3s) → reset. Brama pożarowa (heurystyka
// label jak w GateActionSheet starej apki) → ekran potwierdzenia w tym
// samym sheecie (jak w prototypu HTML).
//
// Panel zamka Tedee ("Mój dom") z designu wymaga integracji Tedee/Nuki,
// której backend nie ma — pominięty w MVP.

struct GammaGateSheet: View {
    let accessPoints: [AccessPoint]
    let onOpen: (AccessPoint) async -> Bool
    let onClose: () -> Void

    @Environment(GammaToastCenter.self) private var toast

    private enum Mode: Equatable {
        case list
        case fireConfirm(Int)   // AccessPoint.id
    }

    @State private var mode: Mode = .list
    @State private var ctaPhases: [Int: GammaCTAPhase] = [:]
    @State private var fireBusy = false
    @State private var fireDone = false

    var body: some View {
        switch mode {
        case .list:
            listContent
        case .fireConfirm(let apId):
            if let ap = accessPoints.first(where: { $0.id == apId }) {
                fireConfirmContent(ap)
            }
        }
    }

    // MARK: Lista przejść

    private var listContent: some View {
        VStack(spacing: 9) {
            GammaSheetHeader(kicker: "Dostęp", title: "Co chcesz otworzyć?", onClose: onClose)

            if accessPoints.isEmpty {
                GammaSheetEmptyState(
                    icon: "lock.slash",
                    text: "Brak skonfigurowanych przejść.\nSkontaktuj się z administratorem osiedla."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(accessPoints) { ap in
                            row(ap)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
    }

    @ViewBuilder
    private func row(_ ap: AccessPoint) -> some View {
        let fire = Self.isFireGate(ap)
        GammaActionRow(
            orbGradient: fire
                ? [GammaColor.dangerSoft, GammaColor.dangerDeep]
                : Self.orbGradient(for: ap),
            orbIcon: Self.icon(for: ap),
            title: ap.label,
            subtitle: fire ? "Wymaga potwierdzenia" : Self.subtitle(for: ap)
        ) {
            if fire {
                GammaOpenCTA(phase: .idle, idleText: "Awaryjnie", danger: true) {
                    mode = .fireConfirm(ap.id)
                }
            } else {
                GammaOpenCTA(phase: ctaPhases[ap.id] ?? .idle) {
                    Task { await runOpen(ap) }
                }
            }
        }
    }

    private func runOpen(_ ap: AccessPoint) async {
        guard (ctaPhases[ap.id] ?? .idle) == .idle else { return }
        ctaPhases[ap.id] = .busy
        let ok = await onOpen(ap)
        if ok {
            ctaPhases[ap.id] = .ok
            toast.show("\(ap.label) — otwarto")
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } else {
            ctaPhases[ap.id] = .idle
            toast.show("Nie udało się otworzyć", error: true)
            return
        }
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        ctaPhases[ap.id] = .idle
    }

    // MARK: Potwierdzenie bramy pożarowej

    private func fireConfirmContent(_ ap: AccessPoint) -> some View {
        VStack(spacing: 0) {
            GammaSheetHeader(kicker: "Brama pożarowa", title: "Czy na pewno?", onClose: onClose)

            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(GammaColor.dangerSoft)
                Text("Otwarcie zostanie zarejestrowane\ni zgłoszone do administracji.")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                Text("Używaj wyłącznie w sytuacji awaryjnej.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
            }
            .frame(maxWidth: .infinity)
            .padding(16)
            .background {
                RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                    .fill(GammaColor.dangerSoft.opacity(0.12))
            }
            .overlay {
                RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                    .strokeBorder(GammaColor.dangerSoft.opacity(0.35), lineWidth: 1)
            }
            .padding(.bottom, 14)

            if fireDone {
                GammaButton(title: "Brama pożarowa otwarta ✓", style: .ghost) {}
                    .disabled(true)
            } else {
                GammaButton(
                    title: "Tak, otwórz bramę",
                    style: .danger,
                    busyText: "Otwieram…",
                    isBusy: fireBusy
                ) {
                    Task { await runFireOpen(ap) }
                }
            }

            Spacer().frame(height: 9)

            GammaButton(title: "Anuluj", style: .ghost) {
                mode = .list
            }
        }
    }

    private func runFireOpen(_ ap: AccessPoint) async {
        fireBusy = true
        let ok = await onOpen(ap)
        fireBusy = false
        if ok {
            fireDone = true
            toast.show("Powiadomiono administrację")
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            onClose()
        } else {
            toast.show("Nie udało się otworzyć", error: true)
        }
    }

    // MARK: Mapowanie (spójne z GateActionSheet głównej apki)

    static func isFireGate(_ ap: AccessPoint) -> Bool {
        let l = ap.label.lowercased()
        return l.contains("poż") || l.contains("fire") || l.contains("awar")
    }

    static func icon(for ap: AccessPoint) -> String {
        switch ap.icon {
        case "door":     return "door.left.hand.open"
        case "garage":   return "car.fill"
        case "gate":     return "rectangle.portrait.split.2x1"
        case "elevator": return "arrow.up.arrow.down"
        case "barrier":  return "minus.square.fill"
        default:         return "lock.fill"
        }
    }

    static func subtitle(for ap: AccessPoint) -> String {
        switch ap.icon {
        case "barrier":  return "Brama LPR"
        case "garage":   return "Wjazd do garażu"
        case "elevator": return "Wezwij windę"
        case "door":     return "Wejście pieszo"
        case "gate":     return "Furtka"
        default:         return "Przejście"
        }
    }

    static func orbGradient(for ap: AccessPoint) -> [Color] {
        switch ap.icon {
        case "barrier": return [GammaColor.accentBlue, GammaColor.orbViolet]
        case "door":    return [GammaColor.success, GammaColor.accentBlue]
        case "gate":    return [GammaColor.accentLight, GammaColor.accentBlue]
        default:        return [GammaColor.accentBlue, GammaColor.orbViolet]
        }
    }
}
