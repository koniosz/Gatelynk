import SwiftUI

// MARK: - ParcelsView (Glass Premium v3)
//
// Port designu z `docs/design/resident-2026-05-11/source/screens/secondary.jsx`
// → `ParcelsScreen`. Główne elementy:
//   • Gradient hero card „Oczekujące: X paczek" (fioletowy gradient + ikona)
//   • Lista paczek jako GLCard: kurier emoji + GLPill status + tracking +
//     locker info (gdy dostępne).
//
// Backend dziś nie zwraca pól `locker`/`code`/`title` z designu — pokazujemy
// to co mamy (trackingNumber, courier, unit, receivedAt/issuedAt). Locker/code
// można dorobić jeśli kiedyś dodamy InPost / Allegro pickup integration.

struct ParcelsView: View {
    @State private var parcels: [Parcel] = []
    @State private var loading = true
    @State private var error: String?

    @Environment(\.colorScheme) private var scheme

    private static let dateFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        f.locale = Locale(identifier: "pl_PL")
        return f
    }()

    var body: some View {
        NavigationStack {
            ZStack {
                GLColor.bg1(scheme).ignoresSafeArea()

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 12) {
                        if loading {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        } else if let error {
                            errorBanner(error)
                        } else {
                            heroCard

                            if parcels.isEmpty {
                                emptyState
                            } else {
                                ForEach(parcels) { p in
                                    parcelRow(p)
                                }
                            }
                        }
                        Spacer(minLength: 40)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                }
                .refreshable { await load() }
            }
            .navigationTitle("Przesyłki")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(GLColor.bg1(scheme), for: .navigationBar)
            .task { await load() }
        }
    }

    // MARK: Hero — „Oczekujące: X paczek"

    private var waitingCount: Int {
        parcels.filter { $0.status == "RECEIVED" }.count
    }

    private var heroCard: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(Color.white.opacity(0.20))
                Image(systemName: "shippingbox.fill")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .frame(width: 48, height: 48)

            VStack(alignment: .leading, spacing: 2) {
                Text("Oczekujące")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.white.opacity(0.80))
                Text(parcelsCountLabel)
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(.white)
                    .tracking(-0.5)
            }
            Spacer()
        }
        .padding(16)
        .background(GLColor.accentGradient(scheme))
        .clipShape(RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous))
        .glShadow(.glow)
    }

    private var parcelsCountLabel: String {
        let n = waitingCount
        if n == 0 { return "Brak paczek" }
        if n == 1 { return "1 paczka" }
        if (2...4).contains(n) { return "\(n) paczki" }
        return "\(n) paczek"
    }

    // MARK: Row

    private func parcelRow(_ p: Parcel) -> some View {
        GLCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    GLPill(text: statusLabel(p), style: statusStyle(p))
                    Spacer()
                    Text(Self.dateFmt.string(from: p.receivedAt))
                        .font(.system(size: 11))
                        .foregroundStyle(GLColor.textTertiary(scheme))
                }
                HStack(spacing: 8) {
                    Text(courierIcon(p.courier))
                        .font(.title3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.trackingNumber)
                            .font(.system(.body, design: .monospaced).weight(.semibold))
                            .foregroundStyle(GLColor.textPrimary(scheme))
                        Text(courierLabel(p.courier))
                            .font(.system(size: 12))
                            .foregroundStyle(GLColor.textTertiary(scheme))
                    }
                }
                if let unit = p.unit {
                    HStack(spacing: 6) {
                        Image(systemName: "house.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(GLColor.accent300(scheme))
                        Text("Lokal \(unit.number)")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(GLColor.textSecondary(scheme))
                    }
                    .padding(.top, 2)
                }
                if let issuedAt = p.issuedAt, p.status == "ISSUED" {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(GLColor.success(scheme))
                        Text("Wydana: \(Self.dateFmt.string(from: issuedAt))")
                            .font(.system(size: 11))
                            .foregroundStyle(GLColor.textTertiary(scheme))
                    }
                }
            }
        }
    }

    private func statusLabel(_ p: Parcel) -> String {
        switch p.status {
        case "RECEIVED": return "W depozycie"
        case "ISSUED":   return "Wydana"
        default:         return p.status
        }
    }

    private func statusStyle(_ p: Parcel) -> GLPill.Style {
        switch p.status {
        case "RECEIVED": return .warning
        case "ISSUED":   return .success
        default:         return .neutral
        }
    }

    private func courierIcon(_ courier: String) -> String {
        switch courier {
        case "DHL":     return "🟡"
        case "INPOST":  return "🟠"
        case "ALLEGRO": return "🔴"
        default:        return "📦"
        }
    }

    private func courierLabel(_ courier: String) -> String {
        switch courier {
        case "DHL":     return "DHL"
        case "INPOST":  return "InPost"
        case "ALLEGRO": return "Allegro"
        case "OTHER":   return "Inny kurier"
        default:        return courier
        }
    }

    // MARK: States

    private var emptyState: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle().fill(GLColor.bg3(scheme))
                Image(systemName: "shippingbox")
                    .font(.system(size: 26, weight: .regular))
                    .foregroundStyle(GLColor.textSecondary(scheme))
            }
            .frame(width: 56, height: 56)

            Text("Brak przesyłek")
                .font(.system(size: 14.5, weight: .semibold))
                .foregroundStyle(GLColor.textPrimary(scheme))
            Text("Kurierzy zostawiają paczki u konsjerża")
                .font(.system(size: 12))
                .foregroundStyle(GLColor.textTertiary(scheme))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .padding(.horizontal, 20)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous)
                .strokeBorder(GLColor.borderDefault(scheme), style: StrokeStyle(lineWidth: 1, dash: [6])),
        )
    }

    private func errorBanner(_ msg: String) -> some View {
        GLCard {
            HStack(spacing: 10) {
                Image(systemName: "wifi.exclamationmark")
                    .foregroundStyle(GLColor.danger(scheme))
                Text(msg)
                    .font(.system(size: 13))
                    .foregroundStyle(GLColor.textPrimary(scheme))
            }
        }
    }

    // MARK: Load

    private func load() async {
        loading = true; error = nil
        do { parcels = try await APIClient.shared.get("/resident/parcels") }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}
