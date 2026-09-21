import SwiftUI
import UIKit

// MARK: - Wspólny model i przycisk otwierania wejścia (audyt UX 2026-09-21)
//
// JEDEN komponent dla Domu (deck „Dostęp"), listy wejść, podglądu z kamery
// i rozmowy domofonowej (A05: ta sama czynność wyglądała i działała inaczej
// w czterech miejscach — 2 s na kaflu, tap w liście, 2 s w podglądzie, ~1,1 s
// w rozmowie).
//
// PRAWDA O STANIE (P0 3.1): `POST …/open` zwraca sukces, gdy Edge/urządzenie
// PRZYJĘŁO polecenie przekaźnika. Bramy i szlabany nie raportują stanu
// fizycznego (Akuvox potwierdza nawet niepodłączony przekaźnik — pułapka #20
// w CLAUDE.md), więc komponent NIGDY nie mówi „otwarte" — mówi „Polecenie
// otwarcia przyjęte". Timeout / zerwane połączenie to „Wynik nieznany", nie
// błąd i nie sukces; nie ma automatycznego ponawiania komendy fizycznej.
//
// Plik jest współdzielony przez targety GateLynk i GateLynkGlass (używa go
// IntercomCallView) — dlatego nie zależy od motywu Glass.

/// Wynik polecenia otwarcia — zgodny z kontraktem API, bez zgadywania stanu bramy.
enum AccessOpenOutcome: Equatable {
    /// Urządzenie przyjęło polecenie (2xx). To NIE jest potwierdzenie otwarcia.
    case accepted
    /// Definitywna odmowa / błąd (np. brak uprawnień, błąd urządzenia).
    case failed(String?)
    /// Nie wiemy, czy polecenie dotarło (timeout, zerwana sieć w trakcie).
    case unknown

    /// Klasyfikacja błędu żądania: co na pewno się NIE udało, a co jest niewiadomą.
    static func from(error: Error) -> AccessOpenOutcome {
        if let api = error as? APIError {
            switch api {
            case .networkError(let underlying):
                return from(error: underlying)
            case .httpError(let code, let message):
                // Cloud → Edge timeout (502 „aborted due to timeout"): komenda
                // mogła dojść do urządzenia — wynik nieznany.
                let m = message.lowercased()
                if code == 502 || code == 504, m.contains("timeout") || m.contains("aborted") {
                    return .unknown
                }
                return .failed(Self.humanMessage(code: code, raw: message))
            case .unauthorized:
                return .failed("Sesja wygasła — zaloguj się ponownie.")
            case .invalidURL:
                return .failed(nil)
            case .decodingError:
                // 2xx z nieczytelną treścią — żądanie doszło, wyniku nie znamy.
                return .unknown
            }
        }
        if let url = error as? URLError {
            switch url.code {
            case .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                return .failed("Brak połączenia z internetem.")
            default:
                return .unknown // timedOut, networkConnectionLost… — mogło dojść
            }
        }
        return .unknown
    }

    private static func humanMessage(code: Int, raw: String) -> String? {
        switch code {
        case 403: return "To wejście jest wyłączone dla Twojego konta."
        case 404: return "To wejście nie jest już dostępne."
        case 502: return "Sterownik osiedla nie odpowiada lub urządzenie odrzuciło polecenie."
        default:  return raw.isEmpty ? nil : raw
        }
    }
}

/// Faza interakcji przycisku — jeden model stanu dla wszystkich ekranów.
enum AccessOpenPhase: Equatable {
    case idle
    case holding
    case sending
    case accepted
    case unknown
    case failed(String?)

    var isBusy: Bool { self == .holding || self == .sending }
}

struct AccessHoldButton: View {
    /// Nazwa KONKRETNEGO wejścia — zawsze widoczna na przycisku.
    let targetName: String
    /// Istniejący czas przytrzymania (2 s) — wspólny dla wszystkich ekranów.
    var holdDuration: Double = 2.0
    var tint: [Color] = [Color(hex: 0xC5B0FF), Color(hex: 0x5B7CFA)]
    /// Informacja dla rodzica (np. deck podbija częstotliwość kadrów kamery).
    var onPhaseChange: ((AccessOpenPhase) -> Void)? = nil
    /// Jedna zakończona interakcja = jedno wywołanie.
    let onCommit: () async -> AccessOpenOutcome

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var phase: AccessOpenPhase = .idle
    @State private var progress: CGFloat = 0
    @State private var countdown: Int?
    @State private var countdownTask: Task<Void, Never>?
    @State private var resetTask: Task<Void, Never>?
    @State private var nudge = false
    /// Unieważnia odpowiedź, która wróciła po zmianie celu / zniknięciu widoku.
    @State private var commitToken = UUID()
    /// Równoważna akcja dla VoiceOver / Switch Control — świadome potwierdzenie
    /// zamiast gestu przytrzymania.
    @State private var confirmAccessible = false

    private static let green = Color(hex: 0x34D399)
    private static let amber = Color(hex: 0xF0A93E)
    private static let red = Color(hex: 0xFF6B6B)

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)

        ZStack(alignment: .leading) {
            shape.fill(Color.white.opacity(0.10))

            // Postęp przytrzymania — W OBRĘBIE przycisku (nie na całej karcie).
            GeometryReader { geo in
                LinearGradient(colors: tint, startPoint: .leading, endPoint: .trailing)
                    .frame(width: geo.size.width * progress)
                    .opacity(phase == .holding || phase == .sending ? 0.95 : 0)
            }
            .clipShape(shape)
            .allowsHitTesting(false)

            HStack(spacing: 12) {
                leadingGlyph
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(.headline, design: .default).weight(.bold))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                    Text(subtitle)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.white.opacity(0.78))
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                }
                Spacer(minLength: 6)
                if let countdown, phase == .holding {
                    Text("\(countdown)")
                        .font(.system(size: 30, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                        .monospacedDigit()
                        .id(countdown)
                        .transition(.scale(scale: 1.5).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .frame(maxWidth: .infinity, minHeight: 60)
        .fixedSize(horizontal: false, vertical: true)
        .overlay { shape.strokeBorder(borderColor, lineWidth: phase == .idle ? 1 : 1.5) }
        .contentShape(shape)
        .scaleEffect(phase == .holding ? 0.985 : 1)
        .animation(.spring(response: 0.3, dampingFraction: 0.75), value: countdown)
        .animation(.easeInOut(duration: 0.2), value: phase)
        .onTapGesture { showNudge() }
        .onLongPressGesture(minimumDuration: holdDuration, maximumDistance: 60) {
            commit()
        } onPressingChanged: { pressing in
            handlePressing(pressing)
        }
        // Zmiana celu / wyjście z ekranu czyści niedokończone przytrzymanie
        // i unieważnia odpowiedź poprzedniego wejścia.
        .onChange(of: targetName) { _, _ in hardReset() }
        .onDisappear { hardReset() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Otwórz: \(targetName)")
        .accessibilityValue(accessibilityState)
        .accessibilityHint("Aktywuj i potwierdź, aby wysłać polecenie otwarcia.")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { if phase == .idle { confirmAccessible = true } }
        .confirmationDialog("Otworzyć: \(targetName)?", isPresented: $confirmAccessible, titleVisibility: .visible) {
            Button("Otwórz") { commit() }
            Button("Anuluj", role: .cancel) {}
        }
    }

    // MARK: Treść zależna od fazy

    private var title: String {
        switch phase {
        case .idle:     return nudge ? "Przytrzymaj przez \(Int(holdDuration)) sekundy" : "Przytrzymaj, aby otworzyć"
        case .holding:  return "Trzymaj…"
        case .sending:  return "Wysyłanie polecenia…"
        case .accepted: return "Polecenie otwarcia przyjęte"
        case .unknown:  return "Wynik nieznany"
        case .failed:   return "Nie udało się otworzyć"
        }
    }

    private var subtitle: String {
        switch phase {
        case .unknown:
            return "\(targetName) — sprawdź wejście. Nie ponawiam automatycznie."
        case .failed(let reason):
            return reason.map { "\(targetName) — \($0)" } ?? targetName
        default:
            return targetName
        }
    }

    @ViewBuilder
    private var leadingGlyph: some View {
        switch phase {
        case .sending:
            ProgressView().tint(.white)
        case .accepted:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 20, weight: .bold)).foregroundStyle(Self.green)
        case .unknown:
            Image(systemName: "questionmark.circle.fill").font(.system(size: 20, weight: .bold)).foregroundStyle(Self.amber)
        case .failed:
            Image(systemName: "xmark.circle.fill").font(.system(size: 20, weight: .bold)).foregroundStyle(Self.red)
        default:
            Image(systemName: "lock.open.fill").font(.system(size: 18, weight: .semibold)).foregroundStyle(.white)
        }
    }

    private var borderColor: Color {
        switch phase {
        case .accepted: return Self.green.opacity(0.75)
        case .unknown:  return Self.amber.opacity(0.8)
        case .failed:   return Self.red.opacity(0.8)
        default:        return Color.white.opacity(0.24)
        }
    }

    private var accessibilityState: String {
        switch phase {
        case .idle:     return "Gotowe"
        case .holding:  return "Przytrzymywanie"
        case .sending:  return "Wysyłanie polecenia"
        case .accepted: return "Polecenie otwarcia przyjęte"
        case .unknown:  return "Wynik nieznany, sprawdź wejście"
        case .failed(let r): return "Nie udało się otworzyć. \(r ?? "")"
        }
    }

    // MARK: Interakcja

    private func setPhase(_ p: AccessOpenPhase) {
        phase = p
        onPhaseChange?(p)
    }

    private func showNudge() {
        guard phase == .idle else { return }
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        nudge = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            nudge = false
        }
    }

    private func handlePressing(_ pressing: Bool) {
        if pressing {
            guard phase == .idle else { return }
            resetTask?.cancel()
            setPhase(.holding)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            if reduceMotion { progress = 1 } else {
                withAnimation(.linear(duration: holdDuration)) { progress = 1 }
            }
            let seconds = max(1, Int(holdDuration.rounded()))
            countdown = seconds
            countdownTask?.cancel()
            countdownTask = Task { @MainActor in
                var left = seconds
                while left > 1 {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    guard !Task.isCancelled else { return }
                    left -= 1
                    countdown = left
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                }
            }
        } else if phase == .holding {
            // Puszczono przed czasem → zamiar anulowany, ŻADNA komenda nie idzie.
            countdownTask?.cancel()
            countdown = nil
            withAnimation(.easeOut(duration: 0.25)) { progress = 0 }
            setPhase(.idle)
        }
    }

    private func commit() {
        // Dubel (drugi palec, VoiceOver + gest) nie wysyła drugiej komendy.
        guard phase == .idle || phase == .holding else { return }
        countdownTask?.cancel()
        countdown = nil
        progress = 1
        setPhase(.sending)
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        let token = UUID()
        commitToken = token
        Task { @MainActor in
            let outcome = await onCommit()
            // Odpowiedź poprzedniego celu nie zmienia widoku nowego.
            guard commitToken == token else { return }
            withAnimation(.easeOut(duration: 0.25)) { progress = 0 }
            switch outcome {
            case .accepted:
                setPhase(.accepted)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            case .unknown:
                setPhase(.unknown)
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
            case .failed(let reason):
                setPhase(.failed(reason))
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
            scheduleReset(after: outcome == .accepted ? 4 : 7)
        }
    }

    private func scheduleReset(after seconds: Double) {
        resetTask?.cancel()
        resetTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            setPhase(.idle)
        }
    }

    private func hardReset() {
        commitToken = UUID()
        countdownTask?.cancel()
        resetTask?.cancel()
        countdown = nil
        nudge = false
        progress = 0
        if phase != .idle { setPhase(.idle) }
    }
}
