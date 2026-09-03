import UserNotifications

// Notification Service Extension — zdjęcie pojazdu w pushach „Gość wjechał/
// wyjechał" (2026-08-12).
//
// APNs nie przenosi obrazów: Cloud wysyła push z `mutable-content: 1` oraz
// `imageUrl` (publiczny, podpisany, 2-godzinny link do kadru z odczytu LPR —
// serwowany przez /api/push-media/lpr/<token>, obraz płynie tunelem z Edge).
// iOS budzi to rozszerzenie PRZED pokazaniem powiadomienia; mamy ~30 s na
// pobranie obrazu i doklejenie go jako attachment. Każdy błąd = pokazujemy
// powiadomienie bez zdjęcia (nigdy nie blokujemy samego pusha).

final class NotificationService: UNNotificationServiceExtension {

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        let content = request.content.mutableCopy() as? UNMutableNotificationContent
        self.bestAttempt = content

        guard
            let content,
            let urlString = request.content.userInfo["imageUrl"] as? String,
            let url = URL(string: urlString),
            url.scheme == "https"
        else {
            contentHandler(request.content)
            return
        }

        URLSession.shared.downloadTask(with: url) { tmpUrl, response, _ in
            defer { contentHandler(content) }
            guard
                let tmpUrl,
                (response as? HTTPURLResponse)?.statusCode == 200
            else { return }

            // Attachment musi mieć rozszerzenie pliku — iOS po nim wybiera
            // dekoder obrazu.
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString + ".jpg")
            do {
                try FileManager.default.moveItem(at: tmpUrl, to: dest)
                let attachment = try UNNotificationAttachment(identifier: "vehicle", url: dest)
                content.attachments = [attachment]
            } catch {
                // Zdjęcia nie będzie — powiadomienie i tak wychodzi.
            }
        }.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        // iOS ubija nas po ~30 s — oddajemy co mamy (push bez zdjęcia).
        if let contentHandler, let bestAttempt {
            contentHandler(bestAttempt)
        }
    }
}
