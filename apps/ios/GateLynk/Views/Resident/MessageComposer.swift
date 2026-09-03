import SwiftUI
import MessageUI

// MARK: - MessageComposer
//
// Wrapper wokół `MFMessageComposeViewController` — natywny iOS Messages
// composer, używany przy zapraszaniu gościa: mieszkaniec klika "Wyślij SMS",
// pojawia się systemowy ekran iMessage z preselected numerem (jeśli gość ma
// `phone`) i pre-fillowaną treścią (greeting + link do portalu).
//
// Dlaczego nie wysyłamy SMS-a po stronie Cloud (Twilio):
//   1. Koszt — Twilio PL ~0.05 USD/SMS, a goście są zapraszani regularnie.
//   2. iMessage > SMS dla iOS-iOS. Wysłany lokalnie ląduje jako iMessage
//      (zielono/niebiesko), nie jako SMS od „GateLynk" przez SMSC.
//   3. Spam-detection: SMS od mieszkańca z jego numeru = whitelist; SMS
//      od Twilio-owskich SID-ów = czasem ląduje w Junk-u na Androidzie.
//   4. Privacy — gość widzi numer mieszkańca, nie anonimowy serwis.
//
// Caveat: nie zadziała w symulatorze (brak Messages.app). `canSendText()`
// zwraca false — zwijamy fallback do `UIActivityViewController` (Share Sheet).

struct MessageComposer: UIViewControllerRepresentable {
    let recipients: [String]
    let body: String
    /// Wynik = systemowy `MessageComposeResult` z frameworka MessageUI
    /// (cases: `.sent`, `.cancelled`, `.failed`). Nie definiujemy własnego
    /// — protokół delegata wymaga dokładnie tego typu, własny enum
    /// shadowowałby go i łamał zgodność z `MFMessageComposeViewControllerDelegate`.
    var onFinish: (MessageComposeResult) -> Void

    func makeUIViewController(context: Context) -> MFMessageComposeViewController {
        let vc = MFMessageComposeViewController()
        vc.messageComposeDelegate = context.coordinator
        // Pre-fill: jeśli mamy numer (np. z `Guest.phone`), wpisujemy go;
        // jeśli nie — gość będzie wybrany przez kontakt picker w iMessage UI.
        if !recipients.isEmpty { vc.recipients = recipients }
        vc.body = body
        return vc
    }

    func updateUIViewController(_ uiViewController: MFMessageComposeViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
        let onFinish: (MessageComposeResult) -> Void
        init(onFinish: @escaping (MessageComposeResult) -> Void) {
            self.onFinish = onFinish
        }
        func messageComposeViewController(
            _ controller: MFMessageComposeViewController,
            didFinishWith result: MessageComposeResult
        ) {
            controller.dismiss(animated: true) { [self] in
                onFinish(result)
            }
        }
    }

    /// Czy urządzenie może wysłać iMessage/SMS. False na symulatorze i na
    /// kontach bez aktywnego Messages (rzadkie). Caller pokazuje wtedy
    /// `ShareLink`/`UIActivityViewController` jako alternatywę.
    static var canSend: Bool { MFMessageComposeViewController.canSendText() }
}
