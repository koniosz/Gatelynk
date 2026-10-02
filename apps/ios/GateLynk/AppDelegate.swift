import UIKit
import UserNotifications

// MARK: - Notification names (for internal routing)

extension Notification.Name {
    /// Posted when APNs successfully returns a device token.
    /// `object` is the hex-encoded token String.
    static let apnsTokenReceived = Notification.Name("apnsTokenReceived")

    /// Posted when the user taps a push notification.
    /// `userInfo["payload"]` contains the APNs payload dictionary.
    static let pushNotificationTapped = Notification.Name("pushNotificationTapped")

    /// Faza C — posted when PushKit returns a VoIP token (intercom calls).
    /// `object` is the hex-encoded token String. AuthManager re-sends it to Cloud.
    static let voipTokenReceived = Notification.Name("voipTokenReceived")

    /// 2026-08-13 — tap w push „Odpowiedź na zgłoszenie" (`type=ticket_reply`).
    /// `userInfo["ticketId"]` to Int. Ciepły start: aktywne widoki (ResidentTabView /
    /// GlassHomeView) łapią to od razu. Zimny start obsługuje
    /// `AppDelegate.pendingTicketRoute` (patrz niżej).
    static let ticketReplyPushTapped = Notification.Name("ticketReplyPushTapped")

    /// 2026-08-13 — tap w push o wjeździe/wyjeździe gościa
    /// (`kind=GUEST_FIRST_USE|GUEST_USE|GUEST_EXIT`). `userInfo["route"]`
    /// to `GuestEventPushRoute`. Zimny start: `AppDelegate.pendingGuestEventRoute`.
    static let guestEventPushTapped = Notification.Name("guestEventPushTapped")

    /// 2026-08-15 — tap w push z ogłoszeniem (`type=notification`).
    /// `userInfo["route"]` to `AnnouncementPushRoute`. Zimny start:
    /// `AppDelegate.pendingAnnouncementRoute`.
    static let announcementPushTapped = Notification.Name("announcementPushTapped")

    /// 2026-08-28 — tap w push „treściowy" (Kronika dnia 21:00 / poranny
    /// brief 7:30 / przypomnienie o kubłach 19:00). Dotąd prowadził donikąd —
    /// treść przepadała z bannera. `userInfo["route"]` to `ContentPushRoute`.
    /// Zimny start: `AppDelegate.pendingContentPushRoute`.
    static let contentPushTapped = Notification.Name("contentPushTapped")
}

// MARK: - ContentPushRoute (karta do czytania pusha, 2026-08-28)

/// Sparsowany push treściowy: `{ type: 'evening-chronicle' | 'morning-brief'
/// | 'waste-reminder', date?: 'YYYY-MM-DD' }`. Tytuł i treść bierzemy
/// wprost z powiadomienia (payload nie dubluje tekstu), więc karta ma co
/// pokazać NATYCHMIAST — Kronika dociąga potem pełną wersję z API.
struct ContentPushRoute: Identifiable, Equatable {
    let kind: String
    let title: String
    let body: String
    let dateKey: String?
    /// Każdy tap = świeża instancja — sheet odświeży się przy kolejnym pushu.
    let id = UUID()
}

// MARK: - AnnouncementPushRoute (deep-link „Ogłoszenie", 2026-08-15)

/// Sparsowany payload pusha z ogłoszeniem: `{ type: 'notification',
/// notificationId?: Int }`. Wysyłka do pojedynczego mieszkańca niesie id
/// (otwieramy DOKŁADNIE to ogłoszenie); broadcast do budynku id nie ma
/// (każdy mieszkaniec ma własny wiersz w bazie) — wtedy apka otwiera listę
/// ogłoszeń z automatycznie rozwiniętym najnowszym.
struct AnnouncementPushRoute: Identifiable, Equatable {
    let notificationId: Int?
    /// Każdy tap = świeża instancja — sheet odświeży się przy kolejnym pushu.
    let id = UUID()
}

// MARK: - GuestEventPushRoute (deep-link „Gość wjechał/wyjechał", 2026-08-13)

/// Sparsowany payload pusha o zdarzeniu gościa:
/// `{ kind: 'GUEST_FIRST_USE'|'GUEST_USE'|'GUEST_EXIT', guestId: Int,
///    via: 'PIN'|'PLATE', ts: <epoch ms>?, imageUrl?: String }`.
/// `imageUrl` to publiczny podpisany link (ważny ~2 h) do kadru LPR —
/// po wygaśnięciu 404, ekran degraduje się do szczegółów bez zdjęcia.
struct GuestEventPushRoute: Identifiable, Equatable {
    let guestId: Int
    let kind: String
    let via: String?
    let ts: Date?
    let imageUrl: String?

    /// Wyjazd (GUEST_EXIT) vs wjazd/użycie (GUEST_FIRST_USE / GUEST_USE).
    var isExit: Bool { kind == "GUEST_EXIT" }

    /// Identity dla `.sheet(item:)` / GlassSheetKind — kolejny push o tym
    /// samym gościu (np. wjazd → wyjazd) ma inne id, więc sheet się odświeży.
    var id: String { "\(kind)-\(guestId)-\(ts?.timeIntervalSince1970 ?? 0)" }
}

// MARK: - AppDelegate

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    // MARK: - Pending push route (deep-link, 2026-08-13)
    //
    // Zimny start: iOS woła `didReceive` tuż po `didFinishLaunching`, ZANIM
    // SwiftUI zbuduje widoki (a przy wylogowaniu — zanim user się zaloguje).
    // NotificationCenter.post poszedłby wtedy w próżnię, więc route trzymamy
    // dodatkowo w statycznej właściwości; ResidentTabView / GlassHomeView
    // konsumują ją w `.task` po załadowaniu (jednorazowo — consume czyści).
    // Ciepły start: widok łapie `.ticketReplyPushTapped` przez onReceive
    // i też woła consume (żeby stale route nie odpalił się przy kolejnym
    // zimnym starcie).

    /// Id zgłoszenia z ostatniego tapniętego pusha `type=ticket_reply`,
    /// jeszcze nie skonsumowane przez UI.
    static var pendingTicketRoute: Int?

    /// Zwraca i czyści pending route (idempotentne — drugi call daje nil).
    static func consumePendingTicketRoute() -> Int? {
        defer { pendingTicketRoute = nil }
        return pendingTicketRoute
    }

    /// Route z ostatniego tapniętego pusha o zdarzeniu gościa
    /// (GUEST_FIRST_USE / GUEST_USE / GUEST_EXIT), jeszcze nie skonsumowane.
    static var pendingGuestEventRoute: GuestEventPushRoute?

    /// Zwraca i czyści pending route gościa (idempotentne).
    static func consumePendingGuestEventRoute() -> GuestEventPushRoute? {
        defer { pendingGuestEventRoute = nil }
        return pendingGuestEventRoute
    }

    /// Route z ostatniego tapniętego pusha z ogłoszeniem (`type=notification`),
    /// jeszcze nie skonsumowane przez UI.
    static var pendingAnnouncementRoute: AnnouncementPushRoute?

    /// Zwraca i czyści pending route ogłoszenia (idempotentne).
    static func consumePendingAnnouncementRoute() -> AnnouncementPushRoute? {
        defer { pendingAnnouncementRoute = nil }
        return pendingAnnouncementRoute
    }

    /// Route z ostatniego tapniętego pusha treściowego (Kronika / brief /
    /// kubły), jeszcze nie skonsumowane przez UI.
    static var pendingContentPushRoute: ContentPushRoute?

    /// Zwraca i czyści pending route treściowy (idempotentne).
    static func consumePendingContentPushRoute() -> ContentPushRoute? {
        defer { pendingContentPushRoute = nil }
        return pendingContentPushRoute
    }

    /// Liczby w userInfo APNs bywają NSNumber albo String zależnie od
    /// serializacji — łapiemy oba warianty.
    private static func intValue(_ raw: Any?) -> Int? {
        if let n = raw as? Int { return n }
        if let n = raw as? NSNumber { return n.intValue }
        if let s = raw as? String { return Int(s) }
        return nil
    }

    /// Epoch w MILISEKUNDACH → Date (payloady gościa mają `ts` w ms).
    private static func msDate(_ raw: Any?) -> Date? {
        if let n = raw as? NSNumber { return Date(timeIntervalSince1970: n.doubleValue / 1000) }
        if let s = raw as? String, let d = Double(s) { return Date(timeIntervalSince1970: d / 1000) }
        return nil
    }

    /// Parsuje payload APNs pusha o odpowiedzi na zgłoszenie:
    /// `{ type: 'ticket_reply', ticketId: <Int> }` (PushService w Cloud).
    private static func ticketRouteId(from payload: [AnyHashable: Any]) -> Int? {
        guard let type = payload["type"] as? String, type == "ticket_reply" else { return nil }
        return intValue(payload["ticketId"])
    }

    /// Parsuje payload pusha z ogłoszeniem: `{ type: 'notification',
    /// notificationId?: Int }`. Brak id = broadcast do całego budynku.
    private static func announcementRoute(from payload: [AnyHashable: Any]) -> AnnouncementPushRoute? {
        guard let type = payload["type"] as? String, type == "notification" else { return nil }
        return AnnouncementPushRoute(notificationId: intValue(payload["notificationId"]))
    }

    /// Parsuje push treściowy (2026-08-28): typy z whitelisty — pushe
    /// akcyjne (VoIP / GUEST_APPROVAL / ANOMALY) NIE mogą otwierać karty
    /// do czytania. Tytuł/treść z UNNotificationContent, nie z payloadu.
    private static func contentPushRoute(from content: UNNotificationContent) -> ContentPushRoute? {
        guard let type = content.userInfo["type"] as? String,
              ["evening-chronicle", "morning-brief", "waste-reminder"].contains(type)
        else { return nil }
        return ContentPushRoute(
            kind: type,
            title: content.title,
            body: content.body,
            dateKey: content.userInfo["date"] as? String
        )
    }

    /// Parsuje payload pusha o zdarzeniu gościa. UWAGA: te pushe używają
    /// klucza `kind` (NIE `type` jak ticket_reply). `ts` i `imageUrl`
    /// opcjonalne (starsze pushe bez ts; imageUrl tylko dla odczytów LPR).
    private static func guestEventRoute(from payload: [AnyHashable: Any]) -> GuestEventPushRoute? {
        guard let kind = payload["kind"] as? String,
              ["GUEST_FIRST_USE", "GUEST_USE", "GUEST_EXIT"].contains(kind),
              let guestId = intValue(payload["guestId"]) else { return nil }
        return GuestEventPushRoute(
            guestId: guestId,
            kind: kind,
            via: payload["via"] as? String,
            ts: msDate(payload["ts"]),
            imageUrl: payload["imageUrl"] as? String
        )
    }

    // MARK: - Launch

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        #if GATELYNK_BLACK && DEBUG
        // The visual review fixture is isolated from auth, APNs and real devices.
        if BlackPreviewMode.enabled { return true }
        #endif
        UNUserNotificationCenter.current().delegate = self
        requestPushPermission()
        setupVoIP()
        return true
    }

    // MARK: - VoIP (PushKit) — Faza C: domofon audio/wideo
    //
    // PushKit rejestruje osobny token (typ .voIP). VoIP push budzi apkę i MUSI
    // natychmiast zgłosić CallKit (CallManager.reportIncomingCall) — inaczej iOS
    // ukarze apkę. CallKit działa bez frameworka WebRTC; realne media włącza się
    // po dodaniu pakietu SPM `stasel/WebRTC` (docs sekcja 8.5).
    //
    // AppDelegate jest WSPÓŁDZIELONY z targetami GateLynkGlass (β) i
    // GateLynkGamma (γ), które NIE kompilują VoIPManager/CallManager ani nie
    // linkują pakietu WebRTC (nie mają też push). `canImport(WebRTC)` jest
    // prawdziwe tylko w głównym targecie → tam VoIP działa, w β/γ ten blok
    // znika w preprocessingu i target buduje się czysto.

    private func setupVoIP() {
        #if canImport(WebRTC)
        // Push przychodzący → natychmiast CallKit (wymóg iOS 13+).
        VoIPManager.shared.onIncomingCall = { payload in
            CallManager.shared.reportIncomingCall(payload)
        }
        // Świeży token VoIP → rozgłoś; AuthManager zarejestruje go w Cloud
        // (gdy zalogowany mieszkaniec), analogicznie do apnsTokenReceived.
        VoIPManager.shared.onTokenUpdate = { token in
            NotificationCenter.default.post(name: .voipTokenReceived, object: token)
        }
        VoIPManager.shared.start()
        #endif
    }

    // MARK: - Permission request

    private func requestPushPermission() {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, error in
            if let error {
                print("[APNs] Permission error: \(error.localizedDescription)")
                return
            }
            guard granted else {
                print("[APNs] Permission denied by user")
                return
            }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    // MARK: - Token registration

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        // Convert binary token to hex string
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[APNs] Device token: \(token)")

        // Persist locally — AuthManager picks this up after login
        UserDefaults.standard.set(token, forKey: "apnsDeviceToken")

        // Notify the rest of the app (e.g. if already logged in, re-send)
        NotificationCenter.default.post(name: .apnsTokenReceived, object: token)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[APNs] Registration failed: \(error.localizedDescription)")
    }

    // MARK: - Foreground presentation

    // Show banner + sound + badge even when the app is in the foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    // MARK: - Notification tap

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let payload = response.notification.request.content.userInfo

        // Deep-link: push „Odpowiedź na zgłoszenie" → otwórz wątek zgłoszenia.
        // Pending dla zimnego startu + dedykowana notyfikacja dla ciepłego.
        // Generyczny broadcast niżej idzie ZAWSZE (VoIP / GUEST_APPROVAL /
        // ANOMALY konsumują go po staremu — nic nie psujemy).
        if let ticketId = Self.ticketRouteId(from: payload) {
            AppDelegate.pendingTicketRoute = ticketId
            NotificationCenter.default.post(
                name: .ticketReplyPushTapped,
                object: nil,
                userInfo: ["ticketId": ticketId]
            )
        }

        // Deep-link: push „Gość wjechał/wyjechał" → ekran zdarzenia gościa
        // (zdjęcie z LPR + szczegóły). Ten sam wzorzec pending+notyfikacja.
        if let route = Self.guestEventRoute(from: payload) {
            AppDelegate.pendingGuestEventRoute = route
            NotificationCenter.default.post(
                name: .guestEventPushTapped,
                object: nil,
                userInfo: ["route": route]
            )
        }

        // Karta do czytania (2026-08-28): Kronika dnia / poranny brief /
        // przypomnienie o kubłach — pełna treść pusha w spokojnym widoku.
        if let route = Self.contentPushRoute(from: response.notification.request.content) {
            AppDelegate.pendingContentPushRoute = route
            NotificationCenter.default.post(
                name: .contentPushTapped,
                object: nil,
                userInfo: ["route": route]
            )
        }

        // Deep-link: push z ogłoszeniem → pełna treść ogłoszenia w apce
        // (konkretne przy wysyłce imiennej, najnowsze przy broadcaście).
        if let route = Self.announcementRoute(from: payload) {
            AppDelegate.pendingAnnouncementRoute = route
            NotificationCenter.default.post(
                name: .announcementPushTapped,
                object: nil,
                userInfo: ["route": route]
            )
        }

        NotificationCenter.default.post(
            name: .pushNotificationTapped,
            object: nil,
            userInfo: ["payload": payload]
        )
        completionHandler()
    }
}
