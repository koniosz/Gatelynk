import SwiftUI

// MARK: - Login w stylu Glass Depth
//
// AuthManager.loginResident — obsługuje multi-building login (jeden e-mail
// z kontami w >1 budynku): API zwraca `requiresBuildingSelection: true` +
// listę budynków → pokazujemy picker w stylu Glass → POST select-building
// (server re-waliduje hasło). Apka jest resident-only — konsjerż/admin
// logują się w głównej apce GateLynk.

struct GlassLoginView: View {
    @Environment(AuthManager.self) private var auth

    @State private var email = ""
    @State private var password = ""
    @State private var isBusy = false
    @State private var errorMessage: String?
    /// Multi-building: lista do wyboru (nil = zwykły formularz logowania).
    @State private var buildingChoices: [ResidentBuildingChoice]?
    @State private var selectingId: Int?

    var body: some View {
        ZStack {
            GlassBackground(tod: .fromClock())

            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Spacer().frame(height: 110)

                    VStack(spacing: 6) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 32, weight: .semibold))
                            .foregroundStyle(GlassColor.accentGradient)
                        #if GATELYNK_BLACK
                        Text("GateLynk")
                            .font(BlackTheme.heading(36))
                            .foregroundStyle(BlackTheme.text)
                        #else
                        Text("GateLynk")
                            .font(.system(size: 34, weight: .bold))
                            .tracking(-1)
                            .foregroundStyle(.white)
                        Text("GLASS DEPTH β")
                            .font(.system(size: 11, weight: .semibold))
                            .tracking(2.2)
                            .foregroundStyle(.white.opacity(0.62))
                        #endif
                    }
                    .glassRiseIn(delay: 0.1)

                    Group {
                        if let choices = buildingChoices {
                            buildingPicker(choices)
                        } else {
                            loginForm
                        }
                    }
                    .padding(20)
                    .glassCard(radius: GlassRadius.primary)
                    .padding(.horizontal, 18)
                    .padding(.top, 36)
                    .glassRiseIn(delay: 0.28)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    // MARK: Formularz logowania

    private var loginForm: some View {
        VStack(spacing: 12) {
            field("Adres e-mail", text: $email, secure: false)
            field("Hasło", text: $password, secure: true)

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(GlassColor.dangerSoft)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            }

            GlassButton(
                title: "Zaloguj się",
                busyText: "Logowanie…",
                isBusy: isBusy
            ) {
                Task { await login() }
            }
            .padding(.top, 4)

            Text("Konto mieszkańca lub administratora osiedla")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.5))
                .padding(.top, 2)
        }
    }

    // MARK: Wybór budynku (multi-building login)

    private func buildingPicker(_ choices: [ResidentBuildingChoice]) -> some View {
        VStack(spacing: 10) {
            Text("WYBIERZ OSIEDLE")
                .font(.system(size: 10.5, weight: .semibold))
                .tracking(1.5)
                .foregroundStyle(.white.opacity(0.65))
                .frame(maxWidth: .infinity, alignment: .leading)

            Text("Twój e-mail ma konta w kilku budynkach.\nGdzie chcesz się zalogować?")
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.7))
                .frame(maxWidth: .infinity, alignment: .leading)

            ForEach(choices) { choice in
                Button {
                    Task { await select(choice) }
                } label: {
                    HStack(spacing: 12) {
                        GlassOrb(
                            gradient: [GlassColor.accentBlue, GlassColor.orbViolet],
                            systemName: "building.2.fill", size: 40, iconSize: 16
                        )
                        VStack(alignment: .leading, spacing: 2) {
                            Text(choice.buildingName)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                            Text(subtitle(choice))
                                .font(.system(size: 11.5))
                                .foregroundStyle(.white.opacity(0.6))
                                .lineLimit(1)
                        }
                        Spacer()
                        if selectingId == choice.residentId {
                            ProgressView().tint(.white.opacity(0.8)).scaleEffect(0.75)
                        } else {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.4))
                        }
                    }
                    .padding(.horizontal, 13)
                    .padding(.vertical, 12)
                    .background {
                        RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                            .fill(Color.white.opacity(0.08))
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(selectingId != nil)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(GlassColor.dangerSoft)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            GlassButton(title: "Wróć", style: .ghost) {
                buildingChoices = nil
                errorMessage = nil
            }
            .padding(.top, 2)
        }
    }

    private func subtitle(_ c: ResidentBuildingChoice) -> String {
        var parts: [String] = []
        if let addr = c.buildingAddress, !addr.isEmpty { parts.append(addr) }
        if let unit = c.unit, !unit.isEmpty { parts.append("lokal \(unit)") }
        return parts.isEmpty ? "Konto mieszkańca" : parts.joined(separator: " · ")
    }

    // MARK: Pola

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

    // MARK: Akcje

    private func login() async {
        guard !email.isEmpty, !password.isEmpty else {
            errorMessage = "Podaj e-mail i hasło."
            return
        }
        isBusy = true
        errorMessage = nil
        do {
            let result = try await auth.loginResident(
                email: email.trimmingCharacters(in: .whitespaces),
                password: password
            )
            if case .buildingChoice(let choices) = result {
                buildingChoices = choices
            }
        } catch let residentError {
            // 2026-09-06: jedno pole logowania dla mieszkańca I administratora
            // osiedla. Gdy konto mieszkańca odrzuci — próbujemy building-admin
            // (GlassHomeView pokaże wtedy kafelki administratora). Przy podwójnej
            // porażce pokazujemy pierwotny błąd, bo to najczęstszy przypadek.
            do {
                try await auth.login(
                    email: email.trimmingCharacters(in: .whitespaces),
                    password: password,
                    as: .buildingAdmin
                )
            } catch {
                errorMessage = residentError.localizedDescription
            }
        }
        isBusy = false
    }

    private func select(_ choice: ResidentBuildingChoice) async {
        selectingId = choice.residentId
        errorMessage = nil
        do {
            try await auth.selectBuilding(
                email: email.trimmingCharacters(in: .whitespaces),
                password: password,
                residentId: choice.residentId
            )
        } catch {
            errorMessage = error.localizedDescription
        }
        selectingId = nil
    }
}
