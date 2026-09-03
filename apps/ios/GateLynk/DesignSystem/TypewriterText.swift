import SwiftUI

// MARK: - TypewriterText (2026-06-09)
//
// Char-by-char animacja tekstu w stylu ChatGPT — wpisuje tekst znak po znaku
// w ustalonym tempie. Używane w `DaySummaryCard` żeby Bielikowe podsumowania
// wyglądały „żywo" (~40 znaków/sek).
//
// Optimizations (wbudowane):
//   • `animate=false` → instant render bez delay-a. Caller ustawia gdy ten
//     sam text widziano już wcześniej (load z cache) — typewriter był by
//     irytujący przy każdym otwarciu HomeView.
//   • `maxAnimatedLength` (default 500) — gdy text > 500 znaków, animacja
//     jest pomijana. Powolny typewriter na długim akapicie nudzi user-a.
//   • `onCompleted` callback — caller może sekwencyjnie odpalić animację
//     dla kolejnej sekcji (predictions → recap).
//
// Implementacja: `.task(id: fullText)` re-startuje animację gdy text się
// zmieni (np. po refresh). Pętla z `Task.sleep(nanoseconds:)` nie blokuje
// MainActor (SwiftUI re-renderuje po każdym `displayed.append`).

struct TypewriterText: View {
    let fullText: String
    var charsPerSecond: Double = 40
    var animate: Bool = true
    var maxAnimatedLength: Int = 500
    var font: Font = .system(size: 13)
    var foregroundStyle: Color? = nil
    var onCompleted: (() -> Void)? = nil

    @State private var displayed: String = ""

    var body: some View {
        Text(displayed)
            .font(font)
            .foregroundStyle(foregroundStyle ?? .primary)
            .fixedSize(horizontal: false, vertical: true)
            .task(id: fullText) {
                await runAnimation()
            }
    }

    private func runAnimation() async {
        // Edge case: pusty text. Wyzeruj i ogłoś completion żeby caller mógł
        // odpalić następną sekcję bez wisienia.
        guard !fullText.isEmpty else {
            displayed = ""
            onCompleted?()
            return
        }
        // Skip animacji: instant render gdy disabled albo bardzo krótki
        // (typewriter na 5 znakach wygląda jak glitch).
        if !animate || fullText.count < 8 {
            displayed = fullText
            onCompleted?()
            return
        }

        displayed = ""
        // FAZA 8.h.20 (2026-06-11) — dynamiczna prędkość zamiast skip-a dla
        // długich tekstów. Decyzja UX: animacja MA być zawsze (jak ChatGPT),
        // ale długi recap nie może pisać się 20 sekund. Cap całkowitego
        // czasu na ~8s: dla 320 znaków → 40 ch/s (bazowe), dla 800 znaków
        // → 100 ch/s (szybciej, ale wciąż widać "pisanie").
        // `maxAnimatedLength` zostaje w API dla wstecznej zgodności, ale
        // pełni teraz rolę progu od którego przyspieszamy.
        let maxDurationS = 8.0
        let effectiveCps = max(charsPerSecond, Double(fullText.count) / maxDurationS)
        let delayNs = UInt64(1_000_000_000.0 / max(effectiveCps, 1))
        var index = fullText.startIndex
        while index < fullText.endIndex {
            // Cancellation-aware — gdy SwiftUI ubije task (zmiana fullText
            // mid-animation), wyjdź zamiast walić błędem.
            if Task.isCancelled { return }
            displayed.append(fullText[index])
            index = fullText.index(after: index)
            try? await Task.sleep(nanoseconds: delayNs)
        }
        onCompleted?()
    }
}
