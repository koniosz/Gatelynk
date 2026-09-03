import SwiftUI

// NukiOnboardingView.swift — onboarding zamka Nuki PRZEZ MIESZKAŃCA (2026-07-09).
//
// Świadoma zgoda mieszkańca: sam podaje token API Nuki i podpina zamek do
// SWOJEGO lokalu (bez integratora). Przepływ 4 krokowy:
//   1) Zgoda   — wyjaśnienie co się stanie + gdzie trafia token
//   2) Token   — pole na token + instrukcja jak go wygenerować na web.nuki.io
//   3) Wybór   — po weryfikacji apka listuje zamki konta, mieszkaniec wybiera
//   4) Gotowe  — potwierdzenie rejestracji
//
// BEZPIECZEŃSTWO: token idzie tylko do backendu → urządzenie budynku (Edge),
// NIGDY nie jest zapisywany w chmurze GateLynk. Backend wymusza że unitId
// pochodzi z pivotu mieszkańca (nie da się podpiąć cudzego lokalu).

struct NukiOnboardingView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    /// Wywoływane po sukcesie (rejestracja/usunięcie) — parent odświeża status.
    var onDone: () async -> Void

    private enum Step { case consent, token, selectLock, done }
    @State private var step: Step = .consent

    @State private var consentChecked = false
    @State private var apiToken = ""
    @State private var options: [NukiSmartlockOption] = []
    @State private var chosen: NukiSmartlockOption?
    @State private var lockName = "Drzwi mieszkania"

    @State private var busy = false
    @State private var formError: String?
    @State private var showReplaceConfirm = false
    @State private var doneLabel = ""

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .consent:    consentStep
                case .token:      tokenStep
                case .selectLock: selectStep
                case .done:       doneStep
                }
            }
            .navigationTitle("Zamek Nuki")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(step == .done ? "Zamknij" : "Anuluj") { dismiss() }
                }
            }
            .alert("Zastąpić istniejący zamek?", isPresented: $showReplaceConfirm) {
                Button("Zastąp", role: .destructive) { Task { await register(replace: true) } }
                Button("Anuluj", role: .cancel) {}
            } message: {
                Text("Ten lokal ma już przypisany zamek. Dodanie nowego usunie poprzedni.")
            }
        }
    }

    // MARK: – Krok 1: zgoda

    private var consentStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header(icon: "lock.badge.plus", title: "Dodaj swój zamek Nuki",
                       subtitle: "Otwieraj drzwi mieszkania z aplikacji.")

                infoRow("key.horizontal.fill",
                        "Podasz token API Nuki, który pozwala aplikacji otwierać ten zamek.")
                infoRow("externaldrive.connected.to.line.below",
                        "Token przechowywany jest lokalnie na urządzeniu budynku (Edge) — NIE w chmurze GateLynk.")
                infoRow("person.fill.checkmark",
                        "Zamek zostanie przypisany wyłącznie do Twojego lokalu. Nikt inny go nie zobaczy.")
                infoRow("trash.fill",
                        "W każdej chwili możesz usunąć zamek — token zniknie z urządzenia budynku.")

                Toggle(isOn: $consentChecked) {
                    Text("Rozumiem i świadomie chcę podłączyć zamek do swojego mieszkania.")
                        .font(.callout)
                }
                .tint(GLColor.accent300(scheme))
                .padding(.top, 4)

                Button {
                    formError = nil
                    step = .token
                } label: {
                    Text("Kontynuuj").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(GLColor.accent300(scheme))
                .disabled(!consentChecked)
                .padding(.top, 8)
            }
            .padding(20)
        }
    }

    // MARK: – Krok 2: token + instrukcja

    private var tokenStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(icon: "key.fill", title: "Token API Nuki",
                       subtitle: "Wklej token wygenerowany w Nuki Web.")

                SecureField("Token API Nuki", text: $apiToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(12)
                    .background(GLColor.bg2(scheme))
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                DisclosureGroup("Jak wygenerować token?") {
                    VStack(alignment: .leading, spacing: 8) {
                        instr(1, "Wejdź na web.nuki.io i zaloguj się na swoje konto Nuki.")
                        instr(2, "Otwórz Menu konta → API.")
                        instr(3, "Wygeneruj nowy token API (Generate API token).")
                        instr(4, "Zaznacz uprawnienie do akcji na zamkach (Smartlock actions).")
                        instr(5, "Skopiuj token i wklej powyżej.")
                    }
                    .padding(.top, 6)
                }
                .tint(GLColor.accent300(scheme))

                if let formError { errorLabel(formError) }

                Button {
                    Task { await verify() }
                } label: {
                    HStack {
                        if busy { ProgressView().tint(.white) }
                        Text(busy ? "Sprawdzam…" : "Sprawdź token").frame(maxWidth: .infinity)
                    }.frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(GLColor.accent300(scheme))
                .disabled(busy || apiToken.trimmingCharacters(in: .whitespaces).count < 10)
            }
            .padding(20)
        }
    }

    // MARK: – Krok 3: wybór zamka

    private var selectStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(icon: "checklist", title: "Wybierz swój zamek",
                       subtitle: "Który zamek jest w Twoim mieszkaniu?")

                VStack(spacing: 0) {
                    ForEach(options) { opt in
                        Button {
                            chosen = opt
                            if lockName == "Drzwi mieszkania" { lockName = opt.name }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: chosen == opt ? "largecircle.fill.circle" : "circle")
                                    .foregroundStyle(chosen == opt ? GLColor.accent300(scheme) : Color.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(opt.name).fontWeight(.semibold).foregroundStyle(.primary)
                                    Text("ID: \(opt.smartlockId)")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .padding(.vertical, 10)
                        }
                        .buttonStyle(.plain)
                        if opt.id != options.last?.id { Divider() }
                    }
                }
                .padding(.horizontal, 14)
                .background(GLColor.bg2(scheme))
                .clipShape(RoundedRectangle(cornerRadius: 12))

                VStack(alignment: .leading, spacing: 6) {
                    Text("Nazwa (jak ma się wyświetlać)").font(.caption).foregroundStyle(.secondary)
                    TextField("Drzwi mieszkania", text: $lockName)
                        .padding(12)
                        .background(GLColor.bg2(scheme))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                if let formError { errorLabel(formError) }

                Button {
                    Task { await register(replace: false) }
                } label: {
                    HStack {
                        if busy { ProgressView().tint(.white) }
                        Text(busy ? "Dodaję…" : "Dodaj zamek").frame(maxWidth: .infinity)
                    }.frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(GLColor.accent300(scheme))
                .disabled(busy || chosen == nil)
            }
            .padding(20)
        }
    }

    // MARK: – Krok 4: gotowe

    private var doneStep: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 54))
                .foregroundStyle(.green)
            Text("Zamek dodany").font(.title2).fontWeight(.bold)
            Text("„\(doneLabel)” jest teraz dostępny w Twoim mieszkaniu. Możesz otwierać drzwi z aplikacji.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
            Button {
                dismiss()
            } label: {
                Text("Gotowe").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(GLColor.accent300(scheme))
            .padding(.horizontal, 40)
        }
        .padding(24)
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
                formError = "Token poprawny, ale nie znaleziono żadnych zamków na tym koncie Nuki."
                return
            }
            options = resp.smartlocks
            chosen = resp.smartlocks.count == 1 ? resp.smartlocks.first : nil
            step = .selectLock
        } catch let APIError.httpError(_, message) {
            formError = message
        } catch {
            formError = "Nie udało się zweryfikować tokenu. Spróbuj ponownie."
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
            apiToken = ""              // nie trzymaj tokenu w pamięci widoku
            step = .done
            await onDone()
        } catch let APIError.httpError(code, message) {
            if code == 409 { showReplaceConfirm = true } else { formError = message }
        } catch {
            formError = "Nie udało się dodać zamka. Spróbuj ponownie."
        }
    }

    // MARK: – Small UI helpers

    private func header(icon: String, title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 34))
                .foregroundStyle(GLColor.accent300(scheme))
            Text(title).font(.title2).fontWeight(.bold)
            Text(subtitle).foregroundStyle(.secondary)
        }
    }

    private func infoRow(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(GLColor.accent300(scheme))
                .frame(width: 24)
            Text(text).font(.callout).foregroundStyle(.primary)
            Spacer(minLength: 0)
        }
    }

    private func instr(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(n).").fontWeight(.semibold).foregroundStyle(GLColor.accent300(scheme))
            Text(text).font(.callout)
            Spacer(minLength: 0)
        }
    }

    private func errorLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
