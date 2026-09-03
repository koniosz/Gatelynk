import Foundation
import PushKit

// MARK: - VoIPManager — PushKit (VoIP push) dla połączeń domofonowych
//
// Projekt: docs/intercom-akuvox-call.md. Za flagą INTERCOM_CALL_ENABLED na
// Cloud — gdy off, push nigdy nie przychodzi i ten manager jest no-op.
//
// VoIP push to OSOBNY kanał od zwykłego APNs (AppDelegate):
//   • osobny token (PKPushRegistry typ .voip) — rejestrowany przez
//     POST /api/resident/intercom/voip-token
//   • osobny topic APNs <bundleId>.voip
//   • iOS MUSI po odebraniu VoIP push NATYCHMIAST zgłosić CallKit
//     (CallManager.reportIncomingCall) — inaczej system ubije apkę (iOS 13+).
//
// Wymaga (KROKI MANUALNE w docs sekcja 8.6/8.7):
//   • Background Modes → Voice over IP (UIBackgroundModes: voip)
//   • Push Notifications capability + provisioning z PushKit
//
// Wzorzec @Observable jak reszta managerów (CLAUDE.md). Token trzymany w
// UserDefaults — AuthManager wysyła go do Cloud po zalogowaniu (analogicznie
// do apnsDeviceToken w AppDelegate).

@Observable
final class VoIPManager: NSObject, PKPushRegistryDelegate {

    static let shared = VoIPManager()

    /// Ostatni VoIP token (hex). Pusty dopóki PushKit go nie wyda.
    private(set) var voipToken: String = ""

    private let registry = PKPushRegistry(queue: .main)

    /// Wstrzykiwane przez warstwę app (GateLynkApp) — manager nie zna CallManager
    /// bezpośrednio, żeby uniknąć cyklu i ułatwić testy.
    var onIncomingCall: ((IntercomVoipPayload) -> Void)?
    /// Wywoływane gdy mamy świeży token — AuthManager rejestruje go w Cloud.
    var onTokenUpdate: ((String) -> Void)?

    /// Klucz UserDefaults (analogicznie do "apnsDeviceToken").
    static let tokenDefaultsKey = "voipDeviceToken"

    private override init() {
        super.init()
    }

    /// Start rejestracji PushKit. Wołane raz przy starcie apki (GateLynkApp).
    func start() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        // Token przyjdzie asynchronicznie w didUpdate. Jeśli mamy zachowany —
        // od razu przekaż (AuthManager może zarejestrować przed świeżym tokenem).
        let saved = UserDefaults.standard.string(forKey: Self.tokenDefaultsKey) ?? ""
        if !saved.isEmpty {
            voipToken = saved
        }
    }

    // MARK: - PKPushRegistryDelegate

    func pushRegistry(
        _ registry: PKPushRegistry,
        didUpdate pushCredentials: PKPushCredentials,
        for type: PKPushType
    ) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        print("[VoIP] token: \(token)")
        voipToken = token
        UserDefaults.standard.set(token, forKey: Self.tokenDefaultsKey)
        onTokenUpdate?(token)
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didInvalidatePushTokenFor type: PKPushType
    ) {
        guard type == .voIP else { return }
        print("[VoIP] token invalidated")
        voipToken = ""
        UserDefaults.standard.removeObject(forKey: Self.tokenDefaultsKey)
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else { completion(); return }
        print("[VoIP] incoming push: \(payload.dictionaryPayload)")

        // KRYTYCZNE: zgłoś CallKit NATYCHMIAST. Jeśli payload jest niepoprawny,
        // i tak musimy zgłosić "puste" połączenie i je zakończyć, inaczej iOS
        // ukarze apkę blokadą VoIP push. CallManager (reportIncomingCall)
        // robi defensywny fallback gdy onIncomingCall nie ustawione.
        if let parsed = IntercomVoipPayload(payload.dictionaryPayload) {
            onIncomingCall?(parsed)
        } else {
            // Fallback: zgłoś i zakończ, żeby spełnić wymóg systemu.
            CallManager.shared.reportAndEndInvalidCall()
        }
        completion()
    }
}
