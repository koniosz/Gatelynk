import SwiftUI

// MARK: - Karta "Asystent osiedla" — AI brief
//
// README pkt 7: najpierw 3 kropki typing (~0.9s), potem max 4 linie
// pojawiają się kolejno (opacity+translateY, stagger 260ms). Format linii:
// kolorowa kropka 6px + tekst 12.5px. "↻ Odśwież" regeneruje brief,
// tap w kartę → sheet Ogłoszenia.
//
// Dane: GET /resident/assistant/day-summary (predictions + recap, cache
// 30 min server-side; ?refresh=1 wymusza regenerację). Bielik zwraca dwa
// akapity — tniemy je na max 4 linie po zdaniach/nowych liniach.

//
// Audyt UX 2026-09-21 (§8): karta jest OSTATNIĄ sekcją Domu („najnowsze
// informacje"), a zbiorczy ruch wszystkich pojazdów osiedla nie jest treścią
// dashboardu mieszkańca — linia „Ruch przy bramie" z day-summary jest tu
// odfiltrowana (generator w ai-prototype zasila też inne widoki, więc filtr
// jest po stronie tej karty). Brief trzymamy w pamięci per mieszkaniec, żeby
// powrót na zakładkę Dom nie odpalał ponownie pobierania i animacji.

struct GlassAssistantCard: View {
    /// Klucz pamięci podręcznej (mieszkaniec + nieruchomość). nil = bez cache.
    var cacheKey: String? = nil
    let onTap: () -> Void

    private static var cache: (key: String, lines: [String], at: Date)?
    private static let cacheTTL: TimeInterval = 15 * 60

    private enum Phase: Equatable { case typing, lines, empty, error }

    private struct BriefLine: Identifiable {
        let id: Int
        let text: String
        let color: Color
    }

    @State private var phase: Phase = .typing
    @State private var lines: [BriefLine] = []
    @State private var visibleCount = 0
    @State private var loadTask: Task<Void, Never>?

    #if GATELYNK_BLACK
    private static let dotPalette: [Color] = [
        BlackTheme.amber, BlackTheme.blue, BlackTheme.green, BlackTheme.accent,
    ]
    #else
    private static let dotPalette: [Color] = [
        GlassColor.orbAmber1,   // FBBF24
        GlassColor.orbBlue1,    // 5B9CFA
        GlassColor.success,     // 34D399
        GlassColor.accentLight, // C5B0FF
    ]
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            briefBody
            footer
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 2)
        .modifier(CardSurface())
        .onAppear {
            guard lines.isEmpty else { return }
            if let key = cacheKey, let c = Self.cache, c.key == key,
               Date().timeIntervalSince(c.at) < Self.cacheTTL, !c.lines.isEmpty {
                lines = Self.briefLines(c.lines)
                visibleCount = lines.count
                phase = .lines
            } else {
                reload(refresh: false)
            }
        }
        .onDisappear { loadTask?.cancel() }
    }

    /// Glass: szklany panel hubu. Black (2026-10-07, „zniknęła kronika ze
    /// strony głównej"): płaska karta w stylu kafelków Black.
    private struct CardSurface: ViewModifier {
        func body(content: Content) -> some View {
            #if GATELYNK_BLACK
            content
                .background(Color(hex: 0x1B1C23), in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.055), lineWidth: 1))
            #else
            content.hubPanel(radius: 22)
            #endif
        }
    }

    // MARK: Header

    private var header: some View {
        HStack {
            HStack(spacing: 6) {
                Image(systemName: "sparkle")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(GlassColor.accentLight)
                Text("NAJNOWSZE NA OSIEDLU")
                    .font(.caption2.weight(.semibold))
                    .tracking(1.4)
            }
            .foregroundStyle(.white.opacity(0.75))
            .accessibilityAddTraits(.isHeader)

            Spacer()

            Button {
                reload(refresh: true)
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption2.weight(.semibold))
                    Text("Odśwież")
                        .font(.caption.weight(.medium))
                }
                .foregroundStyle(.white.opacity(0.75))
                .padding(.horizontal, 8)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Odśwież podsumowanie")
        }
    }

    // MARK: Stopka — nazwane przejście (zamiast „tap w całą kartę")

    private var footer: some View {
        Button(action: onTap) {
            HStack(spacing: 5) {
                Text("Ogłoszenia osiedla")
                    .font(.footnote.weight(.semibold))
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(GlassColor.accentLight)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Body

    @ViewBuilder
    private var briefBody: some View {
        switch phase {
        case .typing:
            GlassTypingDots()
                .padding(.vertical, 8)
        case .error:
            Text("Nie udało się pobrać podsumowania — spróbuj odświeżyć.")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.75))
                .padding(.vertical, 6)
        case .empty:
            Text("Brak nowych informacji z osiedla.")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.75))
                .padding(.vertical, 6)
        case .lines:
            VStack(alignment: .leading, spacing: 9) {
                ForEach(lines) { line in
                    let visible = line.id < visibleCount
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Circle()
                            .fill(line.color)
                            .frame(width: 6, height: 6)
                        Text(Self.attributed(line.text))
                            .font(.footnote)
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                            .foregroundStyle(.white.opacity(0.94))
                    }
                    .opacity(visible ? 1 : 0)
                    .offset(y: visible ? 0 : 7)
                    .animation(.easeOut(duration: 0.5), value: visibleCount)
                }
            }
            .padding(.bottom, 2)
        }
    }

    // MARK: Loading

    private func reload(refresh: Bool) {
        loadTask?.cancel()
        loadTask = Task { await load(refresh: refresh) }
    }

    @MainActor
    private func load(refresh: Bool) async {
        phase = .typing
        visibleCount = 0
        let started = Date()

        let path = refresh
            ? "/resident/assistant/day-summary?refresh=1"
            : "/resident/assistant/day-summary"

        var newLines: [BriefLine] = []
        do {
            let resp: DaySummaryResponse = try await APIClient.shared.get(path)
            let raw = Self.splitIntoLines(
                predictions: resp.predictions.text,
                recap: resp.recap.text
            )
            newLines = Self.briefLines(raw)
            if let key = cacheKey, !raw.isEmpty {
                Self.cache = (key, raw, Date())
            }
        } catch {
            if Task.isCancelled { return }
            // typing min 0.9s nawet przy błędzie — bez "mrugnięcia"
            await Self.padTyping(since: started)
            phase = .error
            return
        }
        if Task.isCancelled { return }

        // typing dots widoczne minimum ~0.9s (design)
        await Self.padTyping(since: started)
        guard !Task.isCancelled else { return }

        lines = newLines
        // Pusta odpowiedź ≠ awaria — nie mówimy „niedostępny", gdy asystent
        // po prostu nie ma nic do przekazania.
        phase = newLines.isEmpty ? .empty : .lines

        // stagger 260ms per linia
        for i in newLines.indices {
            try? await Task.sleep(nanoseconds: i == 0 ? 80_000_000 : 260_000_000)
            guard !Task.isCancelled else { return }
            visibleCount = i + 1
        }
    }

    private static func briefLines(_ raw: [String]) -> [BriefLine] {
        raw.enumerated().map { idx, text in
            BriefLine(id: idx, text: text, color: dotPalette[idx % dotPalette.count])
        }
    }

    /// Zbiorczy ruch WSZYSTKICH pojazdów osiedla — nie dla dashboardu
    /// mieszkańca (audyt §8). Własne przejazdy są w Pojazdy › historia.
    static func isEstateTrafficLine(_ text: String) -> Bool {
        text.localizedCaseInsensitiveContains("Ruch przy bramie")
    }

    private static func padTyping(since started: Date) async {
        let elapsed = Date().timeIntervalSince(started)
        if elapsed < 0.9 {
            try? await Task.sleep(nanoseconds: UInt64((0.9 - elapsed) * 1_000_000_000))
        }
    }

    /// Tnie predictions + recap na max 4 zwięzłe linie.
    static func splitIntoLines(predictions: String, recap: String) -> [String] {
        func sentences(_ text: String) -> [String] {
            text
                .replacingOccurrences(of: "\r", with: "")
                .components(separatedBy: CharacterSet.newlines)
                .flatMap { para -> [String] in
                    para.components(separatedBy: ". ").map { s in
                        var t = s.trimmingCharacters(in: .whitespaces)
                        if !t.isEmpty && !t.hasSuffix(".") && !t.hasSuffix("!") && !t.hasSuffix("?") {
                            t += "."
                        }
                        return t
                    }
                }
                .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "-•– ")) }
                .filter { $0.count > 3 && !isEstateTrafficLine($0) }
        }
        let pred = sentences(predictions)
        let rec = sentences(recap)
        // 2 linie z predictions ("co dziś / co nadchodzi") + 2 z recap ("co się działo")
        var out = Array(pred.prefix(2))
        out.append(contentsOf: rec.prefix(4 - out.count))
        if out.count < 4 {
            out.append(contentsOf: pred.dropFirst(2).prefix(4 - out.count))
        }
        return Array(out.prefix(4))
    }

    /// Bielik czasem zwraca **pogrubienia** markdown — renderujemy je.
    static func attributed(_ text: String) -> AttributedString {
        if var parsed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            // pogrubienia w akcencie (design: .bl b { color:#C5B0FF })
            for run in parsed.runs {
                if let intent = run.inlinePresentationIntent, intent.contains(.stronglyEmphasized) {
                    parsed[run.range].foregroundColor = GlassColor.accentLight
                }
            }
            return parsed
        }
        return AttributedString(text)
    }
}

// MARK: - Typing dots (3 kropki, fala)

struct GlassTypingDots: View {
    @State private var animating = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Color.white.opacity(0.55))
                    .frame(width: 6, height: 6)
                    .scaleEffect(animating ? 1.0 : 0.8)
                    .opacity(animating ? 1.0 : 0.25)
                    .animation(
                        .easeInOut(duration: 0.5)
                            .repeatForever(autoreverses: true)
                            .delay(Double(i) * 0.15),
                        value: animating
                    )
            }
        }
        .onAppear { animating = true }
    }
}
