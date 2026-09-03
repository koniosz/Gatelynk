import SwiftUI

// MARK: - Sheet "Więcej"
//
// Minimalny profil wersji β: kto jest zalogowany, gdzie, wylogowanie.
// Pełne ustawienia (motyw, PIN do bramy, avatar itd.) zostają w głównej
// apce GateLynk — tu tylko to, co potrzebne do testu porównawczego UX.

struct GammaMoreSheet: View {
    let building: Building?
    let onClose: () -> Void

    @Environment(AuthManager.self) private var auth

    var body: some View {
        VStack(spacing: 12) {
            GammaSheetHeader(kicker: "Więcej", title: "Twoje konto", onClose: onClose)

            if case .resident(let user) = auth.role {
                profileCard(user)
            }

            infoRow(icon: "building.2.fill", label: "Osiedle", value: building?.name ?? "—")
            infoRow(icon: "sparkles", label: "Wersja", value: "Gamma Depth Premium β")

            Text("To porównawcza wersja designu. Pełne funkcje\n(ustawienia, PIN, rezerwacje) — w głównej aplikacji.")
                .font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.55))
                .multilineTextAlignment(.center)
                .padding(.vertical, 4)

            GammaButton(title: "Wyloguj się", style: .ghost) {
                auth.logout()
            }
        }
    }

    private func profileCard(_ user: ResidentUser) -> some View {
        HStack(spacing: 13) {
            ZStack {
                Circle().fill(GammaColor.accentGradient)
                Text(initials(user))
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 48, height: 48)

            VStack(alignment: .leading, spacing: 2) {
                Text("\(user.firstName) \(user.lastName)")
                    .font(.system(size: 15.5, weight: .bold))
                    .foregroundStyle(.white)
                Text(user.email)
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.6))
            }
            Spacer()
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.08))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
    }

    private func initials(_ user: ResidentUser) -> String {
        let f = user.firstName.prefix(1)
        let l = user.lastName.prefix(1)
        return "\(f)\(l)".uppercased()
    }

    private func infoRow(icon: String, label: String, value: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(GammaColor.accentLight)
                .frame(width: 24)
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.7))
            Spacer()
            Text(value)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.06))
        }
    }
}
