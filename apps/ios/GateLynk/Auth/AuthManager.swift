import Foundation
import Observation

enum UserRole {
    case resident(ResidentUser)
    case concierge(ConciergeUser)
    case buildingAdmin(BuildingAdminUser)
}

@Observable
final class AuthManager {
    var role: UserRole? = nil
    var isLoggedIn: Bool { role != nil }
    var isRestoring = true   // true during session restore on launch

    private static let savedRoleKey = "gl_saved_role"

    init() {
        // Observe APNs token refreshes while already logged in
        // (iOS can refresh the token at any time — we re-send it to the API)
        NotificationCenter.default.addObserver(
            forName: .apnsTokenReceived,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self, let token = note.object as? String else { return }
            if case .resident = self.role {
                Task { await self.sendPushToken(token) }
            }
        }
        // Faza C — VoIP (PushKit) token dla połączeń domofonowych. PushKit może
        // odświeżyć token w dowolnym momencie; rejestrujemy go w Cloud (resident).
        NotificationCenter.default.addObserver(
            forName: .voipTokenReceived,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self, let token = note.object as? String else { return }
            if case .resident = self.role {
                Task { await self.sendVoipToken(token) }
            }
        }
    }

    // MARK: - Session restore

    /// Called once on app launch. Tries to restore session from saved JWT token.
    /// Sets isRestoring = false when done (success or failure).
    func restoreSession() async {
        defer { isRestoring = false }

        guard KeychainHelper.load(forKey: KeychainHelper.tokenKey) != nil else { return }
        let savedRole = UserDefaults.standard.string(forKey: Self.savedRoleKey) ?? "resident"

        do {
            switch savedRole {
            case "resident":
                let user: ResidentUser = try await APIClient.shared.get("/resident/me")
                role = .resident(user)
                Task { await registerPushToken() }
                Task { await registerVoipToken() }
            case "concierge":
                let user: ConciergeUser = try await APIClient.shared.get("/concierge/me")
                role = .concierge(user)
            case "buildingAdmin":
                let user: BuildingAdminUser = try await APIClient.shared.get("/building-admin/me")
                role = .buildingAdmin(user)
            default:
                break
            }
        } catch {
            // Token expired or invalid — clean up so login screen is shown
            KeychainHelper.delete(forKey: KeychainHelper.tokenKey)
            UserDefaults.standard.removeObject(forKey: Self.savedRoleKey)
        }
    }

    // MARK: - Login

    func login(email: String, password: String, as loginRole: LoginRole) async throws {
        let api = APIClient.shared
        let body = LoginBody(email: email, password: password)

        switch loginRole {
        case .resident:
            let res: LoginResponse = try await api.post("/resident/auth/login", body: body, authenticated: false)
            KeychainHelper.save(res.accessToken, forKey: KeychainHelper.tokenKey)
            UserDefaults.standard.set("resident", forKey: Self.savedRoleKey)
            if let u = res.resident {
                role = .resident(u)
                Task { await registerPushToken() }
                Task { await registerVoipToken() }
            }
        case .concierge:
            let res: LoginResponse = try await api.post("/concierge/auth/login", body: body, authenticated: false)
            KeychainHelper.save(res.accessToken, forKey: KeychainHelper.tokenKey)
            UserDefaults.standard.set("concierge", forKey: Self.savedRoleKey)
            if let u = res.concierge { role = .concierge(u) }
        case .buildingAdmin:
            let res: LoginResponse = try await api.post("/building-admin/auth/login", body: body, authenticated: false)
            KeychainHelper.save(res.accessToken, forKey: KeychainHelper.tokenKey)
            UserDefaults.standard.set("buildingAdmin", forKey: Self.savedRoleKey)
            if let u = res.buildingAdmin { role = .buildingAdmin(u) }
        }
    }

    // MARK: - Multi-building login (resident, 2026-07-07)

    /// Wynik elastycznego logowania mieszkańca: albo zalogowano, albo trzeba
    /// wybrać budynek (jeden e-mail ma konta w >1 budynku).
    enum ResidentLoginResult {
        case loggedIn
        case buildingChoice([ResidentBuildingChoice])
    }

    /// Login mieszkańca obsługujący `requiresBuildingSelection` z API.
    /// (Stare `login(email:password:as:)` zostaje bez zmian — używa go główny
    /// LoginView; multi-building dostaje najpierw GateLynk β.)
    func loginResident(email: String, password: String) async throws -> ResidentLoginResult {
        let res: ResidentLoginRaw = try await APIClient.shared.post(
            "/resident/auth/login",
            body: LoginBody(email: email, password: password),
            authenticated: false
        )
        if res.requiresBuildingSelection == true, let buildings = res.buildings, !buildings.isEmpty {
            return .buildingChoice(buildings)
        }
        guard let token = res.accessToken, let user = res.resident else {
            throw APIError.decodingError(URLError(.cannotParseResponse))
        }
        completeResidentLogin(token: token, user: user)
        return .loggedIn
    }

    /// Krok 2 multi-building: użytkownik wybrał budynek. Server re-waliduje
    /// hasło (bezpieczeństwo) i zwraca token dla wybranego konta.
    func selectBuilding(email: String, password: String, residentId: Int) async throws {
        struct Body: Encodable { let email: String; let password: String; let residentId: Int }
        let res: ResidentLoginRaw = try await APIClient.shared.post(
            "/resident/auth/select-building",
            body: Body(email: email, password: password, residentId: residentId),
            authenticated: false
        )
        guard let token = res.accessToken, let user = res.resident else {
            throw APIError.decodingError(URLError(.cannotParseResponse))
        }
        completeResidentLogin(token: token, user: user)
    }

    private func completeResidentLogin(token: String, user: ResidentUser) {
        KeychainHelper.save(token, forKey: KeychainHelper.tokenKey)
        UserDefaults.standard.set("resident", forKey: Self.savedRoleKey)
        role = .resident(user)
        Task { await registerPushToken() }
        Task { await registerVoipToken() }
    }

    // MARK: - Nieruchomości (multi-property, 2026-08-09)

    /// Id AKTUALNEGO konta mieszkańca. `Resident` jest wierszem per budynek,
    /// więc po przełączeniu nieruchomości zmienia się też id — root widoki
    /// (GlassHomeView / ResidentTabView) używają go jako `.id(...)`, żeby
    /// przełączenie przebudowało ekran i przeładowało dane nowego budynku.
    var currentResidentId: Int? {
        if case .resident(let u) = role { return u.id }
        return nil
    }

    /// E-mail zalogowanego mieszkańca — pokazywany w „Dodaj nieruchomość"
    /// (zarządca nowego obiektu musi dodać mieszkańca na dokładnie ten adres).
    var currentResidentEmail: String? {
        if case .resident(let u) = role { return u.email }
        return nil
    }

    /// Wszystkie nieruchomości, w których ten e-mail ma konto mieszkańca.
    func fetchMyBuildings() async throws -> [ResidentBuildingChoice] {
        try await APIClient.shared.get("/resident/my-buildings")
    }

    /// Przełączenie nieruchomości BEZ ponownego hasła — autoryzacją jest ważny
    /// token obecnego konta; backend weryfikuje, że docelowe konto ma ten sam
    /// e-mail. Po sukcesie stan jak po zwykłym loginie (push rejestruje się
    /// dla nowego budynku; rejestracja w starym zostaje — powiadomienia mają
    /// przychodzić z OBU nieruchomości).
    func switchBuilding(to residentId: Int) async throws {
        struct Body: Encodable { let residentId: Int }
        let res: ResidentLoginRaw = try await APIClient.shared.post(
            "/resident/auth/switch-building",
            body: Body(residentId: residentId)
        )
        guard let token = res.accessToken, let user = res.resident else {
            throw APIError.decodingError(URLError(.cannotParseResponse))
        }
        completeResidentLogin(token: token, user: user)
    }

    // MARK: - Usunięcie konta (wymóg App Store — resident only)

    /// DELETE /resident/me — soft-delete/anonimizacja po stronie API.
    /// Po sukcesie lokalny logout (token unieważniony przez wyzerowanie hasła).
    func deleteAccount() async throws {
        let _: EmptyResponse = try await APIClient.shared.delete("/resident/me")
        logout()
    }

    // MARK: - Logout

    func logout() {
        if case .resident = role {
            Task { await unregisterPushToken() }
        }
        KeychainHelper.delete(forKey: KeychainHelper.tokenKey)
        UserDefaults.standard.removeObject(forKey: Self.savedRoleKey)
        role = nil
    }

    // MARK: - Avatar update (resident only)

    func updateAvatar(_ avatarBase64: String?) {
        if case .resident(let u) = role {
            role = .resident(ResidentUser(
                id: u.id,
                firstName: u.firstName,
                lastName: u.lastName,
                email: u.email,
                phone: u.phone,
                buildingId: u.buildingId,
                avatarBase64: avatarBase64
            ))
        }
    }

    // MARK: - Push token helpers (resident only)

    private func registerPushToken() async {
        guard let token = UserDefaults.standard.string(forKey: "apnsDeviceToken") else { return }
        await sendPushToken(token)
    }

    private func sendPushToken(_ token: String) async {
        // APNs wystawia 2 typy tokenów: sandbox (Xcode debug build z entitlement
        // `aps-environment=development`) i production (App Store / TestFlight z
        // `aps-environment=production`). Cloud trzyma osobnych providerów dla
        // każdego endpointu i routuje per-token, więc musimy go poinformować
        // którego typu jest ten token. `#if DEBUG` mapuje 1:1 na entitlement
        // bo Xcode automatycznie ustawia entitlement na podstawie configuracji
        // buildu (Debug → development, Release → production).
        // bundleId (2026-07-15): GateLynk / Glass / Gamma mają różne bundle,
        // a topic APNs musi się zgadzać z bundlem tokenu — bez tego push
        // dochodził tylko do apki zgodnej z APN_BUNDLE_ID na serwerze.
        struct Body: Encodable { let token: String; let environment: String; let bundleId: String? }
        #if DEBUG
        let env = "development"
        #else
        let env = "production"
        #endif
        _ = try? await APIClient.shared.post(
            "/resident/push-token",
            body: Body(token: token, environment: env, bundleId: Bundle.main.bundleIdentifier)
        ) as PushTokenResponse
    }

    private func unregisterPushToken() async {
        // Sprawdzamy tylko że token istnieje (DELETE nie wymaga body z tokenem —
        // server identyfikuje device po JWT). Token sam nie jest tu używany.
        guard UserDefaults.standard.string(forKey: "apnsDeviceToken") != nil else { return }
        _ = try? await APIClient.shared.delete("/resident/push-token") as PushTokenResponse
    }

    // MARK: - VoIP token helpers (Faza C — domofon, resident only)

    /// Rejestruje zachowany token VoIP (PushKit) w Cloud. Wołane po
    /// login/restore — token mógł przyjść z PushKit zanim się zalogowano.
    /// Klucz literalny = VoIPManager.tokenDefaultsKey ("voipDeviceToken").
    private func registerVoipToken() async {
        guard let token = UserDefaults.standard.string(forKey: "voipDeviceToken"),
              !token.isEmpty else { return }
        await sendVoipToken(token)
    }

    private func sendVoipToken(_ token: String) async {
        // Osobny kanał od zwykłego push: endpoint /resident/intercom/voip-token,
        // topic APNs <bundleId>.voip. environment jak przy apns (#if DEBUG).
        struct Body: Encodable { let token: String; let environment: String; let bundleId: String? }
        #if DEBUG
        let env = "development"
        #else
        let env = "production"
        #endif
        _ = try? await APIClient.shared.post(
            "/resident/intercom/voip-token",
            body: Body(token: token, environment: env, bundleId: Bundle.main.bundleIdentifier)
        ) as PushTokenResponse
    }
}

enum LoginRole: String, CaseIterable, Identifiable {
    case resident = "Mieszkaniec"
    case concierge = "Konsjerż"
    case buildingAdmin = "Admin budynku"
    var id: String { rawValue }
}
