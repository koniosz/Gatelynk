import SwiftUI

// MARK: - Login w stylu Gamma Depth
//
// Reuse AuthManager.login (rola: mieszkaniec). Wersja β jest resident-only —
// konsjerż/admin logują się w głównej apce GateLynk.

struct GammaLoginView: View {
    @Environment(AuthManager.self) private var auth

    @State private var email = ""
    @State private var password = ""
    @State private var isBusy = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            GammaBackground(tod: .fromClock())

            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Spacer().frame(height: 110)

                    VStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 32, weight: .semibold))
                            .foregroundStyle(GammaColor.accentGradient)
                        Text("GateLynk")
                            .font(.system(size: 34, weight: .bold))
                            .tracking(-1)
                            .foregroundStyle(.white)
                        Text("GLASS DEPTH β")
                            .font(.system(size: 11, weight: .semibold))
                            .tracking(2.2)
                            .foregroundStyle(.white.opacity(0.62))
                    }
                    .glassRiseIn(delay: 0.1)

                    VStack(spacing: 12) {
                        field("Adres e-mail", text: $email, secure: false)
                        field("Hasło", text: $password, secure: true)

                        if let errorMessage {
                            Text(errorMessage)
                                .font(.system(size: 12.5, weight: .medium))
                                .foregroundStyle(GammaColor.dangerSoft)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 4)
                        }

                        GammaButton(
                            title: "Zaloguj się",
                            busyText: "Logowanie…",
                            isBusy: isBusy
                        ) {
                            Task { await login() }
                        }
                        .padding(.top, 4)

                        Text("Wersja porównawcza UX · konto mieszkańca")
                            .font(.system(size: 11))
                            .foregroundStyle(.white.opacity(0.5))
                            .padding(.top, 2)
                    }
                    .padding(20)
                    .glassCard(radius: GammaRadius.primary)
                    .padding(.horizontal, 18)
                    .padding(.top, 36)
                    .glassRiseIn(delay: 0.28)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    private func field(_ placeholder: String, text: Binding<String>, secure: Bool) -> some View {
        Group {
            if secure {
                SecureField("", text: text, prompt: Text(placeholder).foregroundStyle(.white.opacity(0.55)))
            } else {
                TextField("", text: text, prompt: Text(placeholder).foregroundStyle(.white.opacity(0.55)))
                    .keyboardType(.emailAddress)
                    .textContentType(.username)
            }
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .background {
            Capsule().fill(Color.white.opacity(0.08))
        }
        .overlay {
            Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 1)
        }
    }

    private func login() async {
        guard !email.isEmpty, !password.isEmpty else {
            errorMessage = "Podaj e-mail i hasło."
            return
        }
        isBusy = true
        errorMessage = nil
        do {
            try await auth.login(
                email: email.trimmingCharacters(in: .whitespaces),
                password: password,
                as: .resident
            )
        } catch {
            errorMessage = error.localizedDescription
        }
        isBusy = false
    }
}
