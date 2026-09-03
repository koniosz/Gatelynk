import SwiftUI

// MARK: - Sheet Pojazdy
//
// Lista pojazdów mieszkańca (z GET /resident/me → Resident.vehicles).
// Polskie tablice w stylu .plate (czarne tło, żółta ramka, mono).
// Dodawanie pojazdu (formularz + approval flow) zostaje na razie
// w głównej apce — przycisk informuje toastem.

struct GammaVehiclesSheet: View {
    let vehicles: [Vehicle]
    let onClose: () -> Void

    @Environment(GammaToastCenter.self) private var toast

    var body: some View {
        VStack(spacing: 9) {
            GammaSheetHeader(kicker: "Pojazdy", title: "Twoje samochody", onClose: onClose)

            if vehicles.isEmpty {
                GammaSheetEmptyState(
                    icon: "car",
                    text: "Nie masz jeszcze zarejestrowanych pojazdów."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(vehicles) { v in
                            row(v)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }

            Text("Tablice rozpoznawane automatycznie przy bramie (ANPR)")
                .font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.6))
                .padding(.vertical, 4)

            GammaButton(title: "+ Dodaj pojazd", style: .ghost) {
                toast.show("Dodawanie pojazdu — w głównej aplikacji GateLynk")
            }
        }
    }

    private func row(_ v: Vehicle) -> some View {
        GammaActionRow(
            orbGradient: [GammaColor.accentBlue, GammaColor.orbViolet],
            orbIcon: "car.fill",
            title: v.displayName,
            subtitle: subtitle(v),
            dimmed: v.effectiveStatus != .approved,
            trailing: { EmptyView() },
            extra: {
                HStack(spacing: 8) {
                    GammaPlateBadge(plate: v.licensePlate)
                    if v.effectiveStatus != .approved {
                        Text(v.effectiveStatus.label)
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(statusColor(v.effectiveStatus))
                    }
                }
                .padding(.top, 5)
            }
        )
    }

    private func subtitle(_ v: Vehicle) -> String {
        var parts: [String] = []
        if !v.color.isEmpty { parts.append(v.color) }
        if let kind = v.kind, kind != .resident { parts.append(kind.label) }
        return parts.joined(separator: " · ")
    }

    private func statusColor(_ s: VehicleStatus) -> Color {
        switch s {
        case .approved: return GammaColor.successLight
        case .pending:  return GammaColor.orbAmber1
        default:        return GammaColor.dangerSoft
        }
    }
}
