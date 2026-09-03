import SwiftUI

struct LoginView: View {
    @Environment(AuthManager.self) private var auth
    @State private var email = ""
    @State private var password = ""
    @State private var selectedRole: LoginRole = .resident
    @State private var loading = false
    @State private var errorMessage: String?
    // Multi-building (2026-08-09): jeden e-mail z kontami w >1 obiekcie —
    // API zwraca listę zamiast tokenu, pokazujemy wybór nieruchomości.
    // (Wcześniej obsługiwał to tylko Glass; tu login cicho utykał.)
    @State private var buildingChoices: [ResidentBuildingChoice]? = nil

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Logo + slogan (2026-05-22)
            //
            // Brand z dostarczonego designu:
            //   • Niebieskie „G" letterform (royal blue #2E47E5 / #3B5BFF)
            //   • „GateLynk" wordmark — bold dark navy
            //   • Slogan „Building Operating System" — gray subdued
            //
            // Preferujemy oficjalny PNG z Assets (gdy wrzucony jako
            // `GateLynkLogo.imageset`) — fallback do SwiftUI rendering
            // czyli scalable wektor odwzorowujący kształt G + tekst.
            // Jednolity brand-lockup (2026-07-04): znak = `GateLynkMark`
            // (przezroczyste G wycięte z oficjalnego logo — TEN SAM asset co
            // splash i baza ikony aplikacji), nazwa + kicker tekstem SwiftUI.
            // Stara bitmapa `GateLynkLogo` (lockup z granatowym taglinem)
            // wycofana — powodowała rozjazd brandu login vs splash vs ikona.
            VStack(spacing: 16) {
                Image("GateLynkMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 108, height: 108)
                VStack(spacing: 6) {
                    Text("GateLynk")
                        .font(.system(size: 34, weight: .heavy))
                        .tracking(-0.8)
                        .foregroundStyle(Color(red: 0.07, green: 0.13, blue: 0.22))
                    Text("BUILDING OPERATING SYSTEM")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(3.2)
                        .foregroundStyle(Color(red: 0.42, green: 0.46, blue: 0.55))
                }
            }
            .padding(.bottom, 40)

            // Form
            VStack(spacing: 14) {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .autocapitalization(.none)
                    .padding()
                    .background(Color(.systemGray6))
                    .cornerRadius(12)

                SecureField("Hasło", text: $password)
                    .textContentType(.password)
                    .padding()
                    .background(Color(.systemGray6))
                    .cornerRadius(12)

                // Role picker
                VStack(alignment: .leading, spacing: 8) {
                    Text("Rola")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                    Picker("Rola", selection: $selectedRole) {
                        ForEach(LoginRole.allCases) { role in
                            Text(role.rawValue).tag(role)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                if let error = errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                Button(action: doLogin) {
                    if loading {
                        ProgressView()
                            .tint(.white)
                            .frame(maxWidth: .infinity)
                            .padding()
                    } else {
                        Text("Zaloguj się")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding()
                    }
                }
                .background(Color.blue)
                .foregroundStyle(.white)
                .cornerRadius(12)
                .disabled(loading || email.isEmpty || password.isEmpty)
                .opacity(loading || email.isEmpty || password.isEmpty ? 0.6 : 1)
            }
            .padding(.horizontal, 28)

            Spacer()
            Spacer()
        }
        .background(Color(.systemBackground))
        // Logo GateLynk ma ciemny granatowy tekst który zniknąłby na pure-black
        // tle (dark mode). Brand-controlled entrance: zawsze light scheme przed
        // login. User wybiera dark/light dopiero po zalogowaniu (SettingsView).
        .preferredColorScheme(.light)
        // Wybór nieruchomości przy loginie (konta w >1 obiekcie).
        .confirmationDialog(
            "Wybierz nieruchomość",
            isPresented: Binding(
                get: { buildingChoices != nil },
                set: { if !$0 { buildingChoices = nil } }
            ),
            titleVisibility: .visible
        ) {
            ForEach(buildingChoices ?? []) { b in
                Button(buildingChoiceLabel(b)) {
                    finishBuildingLogin(b)
                }
            }
            Button("Anuluj", role: .cancel) { buildingChoices = nil }
        }
    }

    private func buildingChoiceLabel(_ b: ResidentBuildingChoice) -> String {
        b.unit.map { "\(b.buildingName) — lokal \($0)" } ?? b.buildingName
    }

    private func doLogin() {
        loading = true
        errorMessage = nil
        Task {
            do {
                if selectedRole == .resident {
                    // Elastyczny login: pojedynczy budynek loguje od razu,
                    // multi-building zwraca listę do wyboru.
                    switch try await auth.loginResident(email: email, password: password) {
                    case .loggedIn:
                        break
                    case .buildingChoice(let choices):
                        buildingChoices = choices
                    }
                } else {
                    try await auth.login(email: email, password: password, as: selectedRole)
                }
            } catch let error as APIError {
                errorMessage = error.errorDescription
            } catch {
                errorMessage = error.localizedDescription
            }
            loading = false
        }
    }

    /// Krok 2 multi-building: server re-waliduje hasło i zwraca token
    /// dla wybranego konta.
    private func finishBuildingLogin(_ b: ResidentBuildingChoice) {
        loading = true
        Task {
            do {
                try await auth.selectBuilding(email: email, password: password, residentId: b.residentId)
            } catch let error as APIError {
                errorMessage = error.errorDescription
            } catch {
                errorMessage = error.localizedDescription
            }
            loading = false
            buildingChoices = nil
        }
    }
}


// MARK: - GateLynk Brand G (2026-05-22)
//
// Wektorowa litera "G" zgodna z brand identity z designu:
//   • Niebieski royal blue (#2E47E5 / #3B5BFF)
//   • Thick stroke (~22% of canvas)
//   • Rounded outer corners
//   • Otwór po prawej w górnej połowie (jaw)
//   • Mały horizontal „tongue" w środku/dnie otworu (the G's tail)
//
// Rendering: SwiftUI Path z rectangles + rounded corners. Scaluje się
// idealnie na każdym DPI bez potrzeby PNG assetów.

struct GateLynkBrandG: View {
    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            // Centered square canvas. Even-odd fill rule jest KRYTYCZNY —
            // bez niego overlapping rects sumują się zamiast subtractować,
            // i nie powstaje "donut" G. SwiftUI Shape default to non-zero.
            ZStack {
                GateLynkBrandGShape()
                    .fill(
                        Color(red: 0.18, green: 0.28, blue: 0.95),
                        style: FillStyle(eoFill: true, antialiased: true),
                    )
            }
            .frame(width: s, height: s)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct GateLynkBrandGShape: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height)
        let outerR: CGFloat = s * 0.14   // outer corner radius
        let innerR: CGFloat = s * 0.06   // inner cutout corner radius
        let stroke: CGFloat = s * 0.22   // ring thickness
        // Inner cutout bounds
        let iL = stroke
        let iT = stroke
        let iR = s - stroke
        let iB = s - stroke
        // Right opening (the G's jaw) — upper portion of letter
        let opT = s * 0.22
        let opB = s * 0.52
        // Tongue inside (at the bottom of the opening)
        let tH = stroke * 0.55
        let tW = stroke * 1.25
        let tL = iR - tW
        let tT = opB - tH

        var path = Path()
        // 1) Outer rounded rect
        path.addRoundedRect(
            in: CGRect(x: 0, y: 0, width: s, height: s),
            cornerSize: CGSize(width: outerR, height: outerR),
        )
        // 2) Subtract inner rounded rect (using even-odd fill rule)
        path.addRoundedRect(
            in: CGRect(x: iL, y: iT, width: iR - iL, height: iB - iT),
            cornerSize: CGSize(width: innerR, height: innerR),
        )
        // 3) Subtract right opening
        path.addRect(CGRect(x: iR - 4, y: opT, width: s - (iR - 4) + 8, height: opB - opT))
        // 4) Add back the tongue (drugie "wycinanie" — wraca jako fill
        //    bo eoFill XOR-uje overlap z opening cutoutem powyżej).
        path.addRect(CGRect(x: tL, y: tT, width: (iR + 2) - tL, height: opB - tT + 2))
        return path
    }
}
