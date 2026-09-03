import SwiftUI

// MARK: - Sheet Przesyłki
//
// Backend ma recepcyjny model paczek (trackingNumber/courier/status
// RECEIVED→ISSUED), bez paczkomatu z kodami skrytek — duży kod "4823"
// z prototypu czeka na integrację paczkomatową. Pokazujemy: paczki
// czekające (highlight card) + wydane (przygaszone).

struct GammaParcelsSheet: View {
    let parcels: [Parcel]
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 9) {
            GammaSheetHeader(
                kicker: "Przesyłki",
                title: waitingTitle,
                onClose: onClose
            )

            if parcels.isEmpty {
                GammaSheetEmptyState(
                    icon: "shippingbox",
                    text: "Brak przesyłek. Gdy paczka dotrze\ndo recepcji, zobaczysz ją tutaj."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(waiting) { p in
                            waitingCard(p)
                        }
                        ForEach(issued.prefix(5)) { p in
                            issuedRow(p)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
    }

    private var waiting: [Parcel] { parcels.filter { $0.status == "RECEIVED" } }
    private var issued: [Parcel] { parcels.filter { $0.status != "RECEIVED" } }

    private var waitingTitle: String {
        switch waiting.count {
        case 0:  return "Wszystko odebrane"
        case 1:  return "1 czeka na odbiór"
        default: return "\(waiting.count) czekają na odbiór"
        }
    }

    // MARK: Karta paczki czekającej

    private func waitingCard(_ p: Parcel) -> some View {
        VStack(spacing: 6) {
            Text("CZEKA W RECEPCJI")
                .font(.system(size: 11, weight: .bold))
                .tracking(1.6)
                .foregroundStyle(.white.opacity(0.75))

            Text(p.courier)
                .font(.system(size: 26, weight: .heavy))
                .tracking(-0.6)
                .foregroundStyle(.white)

            Text(trackingLine(p))
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(.white.opacity(0.6))

            Text("Przyjęta: \(GammaFormat.shortDateTime.string(from: p.receivedAt))"
                 + (p.unit.map { " · lokal \($0.number)" } ?? ""))
                .font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.6))
        }
        .frame(maxWidth: .infinity)
        .padding(18)
        .background {
            RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            GammaColor.accentLight.opacity(0.25),
                            GammaColor.accentBlue.opacity(0.18),
                        ],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
        }
        .overlay {
            RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                .strokeBorder(GammaColor.accentLight.opacity(0.4), lineWidth: 1)
        }
    }

    private func trackingLine(_ p: Parcel) -> String {
        let t = p.trackingNumber
        guard t.count > 12 else { return t }
        return "\(t.prefix(4))…\(t.suffix(4))"
    }

    // MARK: Wydane

    private func issuedRow(_ p: Parcel) -> some View {
        GammaActionRow(
            orbGradient: [Color.white.opacity(0.2), Color.white.opacity(0.1)],
            orbIcon: "shippingbox.fill",
            title: "\(p.courier) · \(trackingLine(p))",
            subtitle: p.issuedAt.map { "Wydana: \(GammaFormat.shortDateTime.string(from: $0))" } ?? "Wydana",
            dimmed: true
        )
    }
}
