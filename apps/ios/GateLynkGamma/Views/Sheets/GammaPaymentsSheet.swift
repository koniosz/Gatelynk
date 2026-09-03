import SwiftUI

// MARK: - Sheet Płatności
//
// GET /resident/payments → PaymentSummary (balance + entries). Zaległość
// (balance < 0) = czerwona karta jak w designie. Backend nie ma jeszcze
// inicjowania płatności BLIK — pokazujemy historię + notkę "wkrótce"
// (przycisk "Zapłać BLIK" z prototypu czeka na integrację płatności).

struct GammaPaymentsSheet: View {
    let summary: PaymentSummary?
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 9) {
            GammaSheetHeader(kicker: "Płatności", title: "Czynsz", onClose: onClose)

            if let summary {
                balanceCard(summary)

                if !summary.entries.isEmpty {
                    historyHeader
                    ScrollView(showsIndicators: false) {
                        VStack(spacing: 7) {
                            ForEach(summary.entries.prefix(10)) { e in
                                entryRow(e)
                            }
                        }
                    }
                    .scrollBounceBehavior(.basedOnSize)
                }

                Text("Płatności online (BLIK) — wkrótce")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.55))
                    .padding(.top, 6)
            } else {
                GammaSheetEmptyState(
                    icon: "creditcard",
                    text: "Brak skonfigurowanych płatności\ndla Twojego lokalu."
                )
            }
        }
    }

    // MARK: Karta salda

    private func balanceCard(_ s: PaymentSummary) -> some View {
        let overdue = s.balance < 0
        return VStack(spacing: 6) {
            Text(overdue ? "ZALEGŁOŚĆ" : "SALDO ROZLICZONE")
                .font(.system(size: 11, weight: .bold))
                .tracking(1.6)
                .foregroundStyle(overdue ? Color(red: 1, green: 154/255, blue: 165/255) : GammaColor.successLight)

            Text(GammaFormat.zl(abs(s.balance)))
                .font(.system(size: 36, weight: .heavy))
                .tracking(-1.1)
                .foregroundStyle(.white)

            if let unit = s.unitNumber {
                Text("Lokal \(unit)" + (s.config.map { " · czynsz \(GammaFormat.zl($0.monthlyRent)) do \($0.dueDay). dnia mies." } ?? ""))
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(18)
        .background {
            RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                .fill((overdue ? GammaColor.dangerSoft : GammaColor.success).opacity(0.12))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                .strokeBorder((overdue ? GammaColor.dangerSoft : GammaColor.success).opacity(0.35), lineWidth: 1)
        }
        .padding(.bottom, 5)
    }

    private var historyHeader: some View {
        Text("OSTATNIE OPERACJE")
            .font(.system(size: 10.5, weight: .semibold))
            .tracking(1.5)
            .foregroundStyle(.white.opacity(0.55))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
    }

    private func entryRow(_ e: PaymentEntry) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(e.description ?? e.typeLabel)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(1)
                Text(e.date)
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.5))
            }
            Spacer()
            Text((e.amount >= 0 ? "+" : "") + GammaFormat.zl(e.amount))
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(e.amount >= 0 ? GammaColor.successLight : .white.opacity(0.85))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.06))
        }
    }
}
