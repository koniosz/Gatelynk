import SwiftUI

// GlassNukiOnboardingSheet.swift — onboarding zamka Nuki PRZEZ MIESZKAŃCA
// (2026-07-09), wariant Glass Depth (parity z NukiOnboardingView głównej apki).
//
// Świadoma zgoda: mieszkaniec sam podaje token API Nuki i podpina zamek do
// SWOJEGO lokalu. Token idzie tylko do urządzenia budynku (Edge), NIGDY do
// chmury GateLynk. Renderowany wewnątrz GlassSheetContainer (grip + chrome).

struct GlassNukiOnboardingSheet: View {
    let onClose: () -> Void
    var existingLocks: [NukiLockStatus] = []
    var onChanged: (() -> Void)? = nil

    @Environment(GlassToastCenter.self) private var toast

    private enum Step { case manage, consent, token, selectLock, done }
    @State private var step: Step

    @State private var consentChecked = false
    @State private var apiToken = ""
    @State private var options: [NukiSmartlockOption] = []
    @State private var chosen: NukiSmartlockOption?
    @State private var lockName = "Drzwi mieszkania"

    @State private var busy = false
    @State private var formError: String?
    @State private var replacePrompt = false
    @State private var doneLabel = ""
    @State private var confirmingRemove = false

    init(
        onClose: @escaping () -> Void,
        existingLocks: [NukiLockStatus] = [],
        onChanged: (() -> Void)? = nil,
    ) {
        self.onClose = onClose
        self.existingLocks = existingLocks
        self.onChanged = onChanged
        _step = State(initialValue: existingLocks.isEmpty ? .consent : .manage)
    }

    var body: some View {
        VStack(spacing: 0) {
            GlassSheetHeader(kicker: headerKicker, title: headerTitle, onClose: onClose)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch step {
                    case .manage:     manageBody
                    case .consent:    consentBody
                    case .token:      tokenBody
                    case .selectLock: selectBody
                    case .done:       doneBody
                    }
                }
                .padding(.bottom, 6)
            }
            .frame(maxHeight: 460)
        }
    }

    private var headerKicker: String {
        step == .manage ? "Twój zamek" : "Zamek Nuki"
    }

    private var headerTitle: String {
        switch step {
        case .manage:     return "Zarządzaj zamkiem"
        case .consent:    return "Twój zamek"
        case .token:      return "Token API"
        case .selectLock: return "Wybierz zamek"
        case .done:       return "Gotowe"
        }
    }

    // MARK: – Zarządzanie istniejącym zamkiem

    private var manageBody: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(existingLocks) { lock in
                manageLockCard(lock)
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Ponowna konfiguracja (nowy token, inny zamek lub zmiana nazwy) przechodzi jeszcze raz przez proces dodawania i zastępuje obecny zamek.")
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)

                GlassButton(title: "Edycja ustawień", style: .ghost) {
                    formError = nil
                    step = .consent
                }

                if let formError { errorLabel(formError) }

                GlassButton(title: "Usuń zamek", style: .danger, busyText: "Usuwam…", isBusy: busy) {
                    confirmingRemove = true
                }
            }
        }
        .confirmationDialog(
            "Czy na pewno chcesz usunąć zamek?",
            isPresented: $confirmingRemove,
            titleVisibility: .visible,
        ) {
            Button("Usuń zamek", role: .destructive) {
                Task { await removeLock() }
            }
            Button("Anuluj", role: .cancel) {}
        } message: {
            Text("Token zniknie z urządzenia budynku, a drzwi mieszkania przestaną być dostępne w aplikacji.")
        }
    }

    private func manageLockCard(_ lock: NukiLockStatus) -> some View {
        HStack(spacing: 12) {
            GlassOrb(
                gradient: [GlassColor.accentBlue, GlassColor.accentLight],
                systemName: "lock.fill",
                size: 42,
                iconSize: 17,
            )
            VStack(alignment: .leading, spacing: 3) {
                Text(lock.name)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(.white)
                HStack(spacing: 6) {
                    Circle()
                        .fill(lock.online ? GlassColor.success : GlassColor.danger)
                        .frame(width: 6, height: 6)
                    Text(lock.effectiveStateLabel ?? (lock.online ? "Połączony" : "Offline"))
                        .font(.system(size: 11.5))
                        .foregroundStyle(.white.opacity(0.65))
                    if lock.batteryCritical == true {
                        Image(systemName: "battery.25percent")
                            .font(.system(size: 11))
                            .foregroundStyle(GlassColor.dangerSoft)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(13)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.07))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
        }
    }

    private func removeLock() async {
        guard let lock = existingLocks.first else { return }
        busy = true; formError = nil
        defer { busy = false }
        do {
            let _: EmptyResponse = try await APIClient.shared.delete("/resident/smart-lock/\(lock.apId)")
            toast.show("Zamek usunięty")
            onChanged?()
            onClose()
        } catch let APIError.httpError(_, message) {
            formError = message
        } catch {
            formError = "Nie udało się usunąć zamka."
        }
    }

    // MARK: – Krok 1: zgoda

    private var consentBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            bullet("key.horizontal.fill", "Podasz token API Nuki, który pozwala otwierać ten zamek z aplikacji.")
            bullet("externaldrive.connected.to.line.below", "Token przechowywany jest lokalnie na urządzeniu budynku (Edge) — NIE w chmurze GateLynk.")
            bullet("person.fill.checkmark", "Zamek zostanie przypisany wyłącznie do Twojego lokalu.")
            bullet("trash.fill", "Możesz go usunąć w każdej chwili — token zniknie z urządzenia budynku.")

            Button {
                consentChecked.toggle()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: consentChecked ? "checkmark.square.fill" : "square")
                        .foregroundStyle(consentChecked ? GlassColor.accentLight : .white.opacity(0.5))
                    Text("Rozumiem i świadomie chcę podłączyć zamek do swojego mieszkania.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.white.opacity(0.85))
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            .padding(.top, 2)

            GlassButton(title: "Kontynuuj") {
                formError = nil
                if consentChecked { step = .token }
            }
            .opacity(consentChecked ? 1 : 0.5)
            .disabled(!consentChecked)
        }
    }

    // MARK: – Krok 2: token

    private var tokenBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Wklej token wygenerowany w Nuki Web.")
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.7))

            SecureField("", text: $apiToken, prompt: Text("Token API Nuki").foregroundColor(.white.opacity(0.4)))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(.white)
                .padding(13)
                .background {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.white.opacity(0.08))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                }

            DisclosureGroup {
                VStack(alignment: .leading, spacing: 7) {
                    instr(1, "Wejdź na web.nuki.io i zaloguj się na konto Nuki.")
                    instr(2, "Otwórz Menu konta → API.")
                    instr(3, "Wygeneruj nowy token API (Generate API token).")
                    instr(4, "Zaznacz uprawnienie do akcji na zamkach (Smartlock actions).")
                    instr(5, "Skopiuj token i wklej powyżej.")
                }
                .padding(.top, 6)
            } label: {
                Text("Jak wygenerować token?")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(GlassColor.accentLight)
            }
            .tint(GlassColor.accentLight)

            if let formError { errorLabel(formError) }

            GlassButton(title: "Sprawdź token", busyText: "Sprawdzam…", isBusy: busy) {
                Task { await verify() }
            }
            .opacity(canVerify ? 1 : 0.5)
            .disabled(!canVerify)
        }
    }

    private var canVerify: Bool {
        !busy && apiToken.trimmingCharacters(in: .whitespaces).count >= 10
    }

    // MARK: – Krok 3: wybór

    private var selectBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Który zamek jest w Twoim mieszkaniu?")
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.7))

            ForEach(options) { opt in
                Button {
                    chosen = opt
                    if lockName == "Drzwi mieszkania" { lockName = opt.name }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: chosen == opt ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(chosen == opt ? GlassColor.accentLight : .white.opacity(0.4))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(opt.name)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(.white)
                            Text("ID: \(opt.smartlockId)")
                                .font(.system(size: 11))
                                .foregroundStyle(.white.opacity(0.55))
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 13)
                    .padding(.vertical, 12)
                    .background {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(Color.white.opacity(chosen == opt ? 0.12 : 0.06))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            if let formError { errorLabel(formError) }

            if replacePrompt {
                Text("Ten lokal ma już zamek. Zastąpić go nowym?")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(GlassColor.dangerSoft)
                GlassButton(title: "Zastąp istniejący", style: .danger, busyText: "Dodaję…", isBusy: busy) {
                    Task { await register(replace: true) }
                }
                GlassButton(title: "Anuluj", style: .ghost) { replacePrompt = false }
            } else {
                GlassButton(title: "Dodaj zamek", busyText: "Dodaję…", isBusy: busy) {
                    Task { await register(replace: false) }
                }
                .opacity(chosen == nil ? 0.5 : 1)
                .disabled(chosen == nil || busy)
            }
        }
    }

    // MARK: – Krok 4: gotowe

    private var doneBody: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 46))
                .foregroundStyle(GlassColor.successLight)
            Text("„\(doneLabel)” dodany")
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(.white)
            Text("Zamek jest teraz dostępny w Twoim mieszkaniu. Możesz otwierać drzwi z aplikacji.")
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.7))
                .multilineTextAlignment(.center)
            GlassButton(title: "Gotowe") { onClose() }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }

    // MARK: – Actions

    private func verify() async {
        busy = true; formError = nil
        defer { busy = false }
        struct Body: Encodable { let apiToken: String }
        do {
            let resp: NukiVerifyResponse = try await APIClient.shared.post(
                "/resident/smart-lock/verify",
                body: Body(apiToken: apiToken.trimmingCharacters(in: .whitespaces)),
            )
            if resp.smartlocks.isEmpty {
                formError = "Token poprawny, ale nie znaleziono zamków na tym koncie Nuki."
                return
            }
            options = resp.smartlocks
            chosen = resp.smartlocks.count == 1 ? resp.smartlocks.first : nil
            step = .selectLock
        } catch let APIError.httpError(_, message) {
            formError = message
        } catch {
            formError = "Nie udało się zweryfikować tokenu."
        }
    }

    private func register(replace: Bool) async {
        guard let chosen else { return }
        busy = true; formError = nil
        defer { busy = false }
        struct Body: Encodable {
            let apiToken: String; let smartlockId: String; let name: String; let replace: Bool
        }
        do {
            let resp: NukiCreateResponse = try await APIClient.shared.post(
                "/resident/smart-lock",
                body: Body(
                    apiToken: apiToken.trimmingCharacters(in: .whitespaces),
                    smartlockId: chosen.smartlockId,
                    name: lockName.trimmingCharacters(in: .whitespaces),
                    replace: replace,
                ),
            )
            doneLabel = resp.label
            apiToken = ""
            replacePrompt = false
            step = .done
            toast.show("Zamek dodany")
            onChanged?()
        } catch let APIError.httpError(code, message) {
            if code == 409 { replacePrompt = true } else { formError = message }
        } catch {
            formError = "Nie udało się dodać zamka."
        }
    }

    // MARK: – Helpers

    private func bullet(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(GlassColor.accentLight)
                .frame(width: 22)
            Text(text)
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.85))
            Spacer(minLength: 0)
        }
    }

    private func instr(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(n).")
                .font(.system(size: 12.5, weight: .bold))
                .foregroundStyle(GlassColor.accentLight)
            Text(text)
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.8))
            Spacer(minLength: 0)
        }
    }

    private func errorLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(GlassColor.dangerSoft)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
