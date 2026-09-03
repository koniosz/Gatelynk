import SwiftUI

// MARK: - CalendarView (Faza 8.h.28 — 2026-06-15)
//
// 7-dniowy widok tygodnia z listą wydarzeń per dzień. Każdy dzień to karta —
// w środku eventy: zaplanowane odbiory śmieci (i docelowo planowane przerwy,
// wizyty kurierów).
//
// Data source (8.h.28): STRUKTURALNY endpoint
// `GET /api/resident/assistant/calendar?days=7` — zwraca
// `events: [{date, type, category, title, icon}]` wyciągnięte
// DETERMINISTYCZNIE z KB harmonogramu (Edge regex-parsuje daty per frakcja,
// bez LLM). Grupujemy po dacie i renderujemy na właściwych kartach dni.
// To naprawia bug: AI znał harmonogram (day-summary tekst), ale Kalendarz
// pokazywał „Brak danych z harmonogramu" dla dni 16/19/25.
//
// Karta „dziś" dodatkowo pokazuje tekstowe day-summary (Bielik streszcza co
// dziś planowane) — zachowane jako kontekst obok strukturalnych eventów.

struct CalendarView: View {
    @Environment(\.colorScheme) private var scheme

    /// Eventy zgrupowane po dacie ("YYYY-MM-DD" → lista eventów).
    @State private var eventsByDate: [String: [CalendarEvent]] = [:]
    @State private var loading = true
    @State private var range: CalRange = .week

    private let calendar = Calendar(identifier: .gregorian)

    /// Zakresy widoku (segmented na górze). Dane i tak pobieramy na 31 dni —
    /// zakres steruje TYLKO ile dni-kart renderujemy (przełączanie bez refetcha).
    private enum CalRange: String, CaseIterable, Identifiable {
        case today, threeDays, week, month
        var id: String { rawValue }
        var label: String {
            switch self {
            case .today:     return "Dziś"
            case .threeDays: return "3 dni"
            case .week:      return "Tydzień"
            case .month:     return "Miesiąc"
            }
        }
        var days: Int {
            switch self {
            case .today:     return 1
            case .threeDays: return 3
            case .week:      return 7
            case .month:     return 31
            }
        }
    }

    /// Formatter ISO ("YYYY-MM-DD") — klucz do `eventsByDate`. Stały kalendarz
    /// gregoriański + POSIX locale, żeby pasował do formatu z backendu.
    private static let isoFormatter: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.calendar = Calendar(identifier: .gregorian)
        df.dateFormat = "yyyy-MM-dd"
        return df
    }()

    /// Dni do wyświetlenia wg wybranego zakresu (Dziś / 3 dni / Tydzień / Miesiąc).
    private var visibleDates: [Date] {
        let today = calendar.startOfDay(for: Date())
        return (0..<range.days).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
    }

    /// Deterministyczny tekst karty „DZIŚ" — z TYCH SAMYCH eventów co pinezki
    /// (parser harmonogramu), bez LLM → zero rozjazdu „brak na dziś" vs pinezka.
    /// „Najbliżej" = 3 najbliższe nadchodzące odbiory.
    private var todaySummaryText: String? {
        let todayKey = Self.isoFormatter.string(from: calendar.startOfDay(for: Date()))
        let todayEvents = eventsByDate[todayKey] ?? []
        let upcoming = eventsByDate
            .filter { $0.key > todayKey }                 // ISO daty = porównanie chronologiczne
            .sorted { $0.key < $1.key }
            .flatMap { entry in entry.value.map { (entry.key, $0) } }
            .prefix(3)
        var parts: [String] = []
        if todayEvents.isEmpty { parts.append("Na dziś brak wydarzeń.") }
        if !upcoming.isEmpty {
            let list = upcoming
                .map { "\(Self.plDayMonth($0.0)) \($0.1.title.lowercased())" }
                .joined(separator: ", ")
            parts.append("Najbliżej: \(list).")
        }
        let text = parts.joined(separator: " ")
        return text.isEmpty ? nil : text
    }

    /// ISO „2026-06-19" → „19 czerwca" (pl).
    private static func plDayMonth(_ iso: String) -> String {
        guard let d = isoFormatter.date(from: iso) else { return iso }
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "d MMMM"
        return df.string(from: d)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Zakres", selection: $range) {
                    ForEach(CalRange.allCases) { r in Text(r.label).tag(r) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 4)

                ScrollView {
                    VStack(spacing: 12) {
                        if loading {
                            ProgressView()
                                .padding(40)
                        } else {
                            ForEach(Array(visibleDates.enumerated()), id: \.offset) { idx, date in
                                dayCard(date, isToday: idx == 0)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .refreshable { await load(refresh: true) }
            }
            .background(GLColor.bg1(scheme).ignoresSafeArea())
            .navigationTitle("Kalendarz")
            .task { await load() }
        }
    }

    /// Helper bez side effects — w @ViewBuilder body assignments na
    /// `df.locale`/`df.dateFormat` zwracają `()`, co kompilator próbuje
    /// conform do View. Extract poza ViewBuilder rozwiązuje błąd
    /// "Type '()' cannot conform to 'View'".
    private static func dayLabel(for date: Date) -> String {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "EEEE, d MMMM"
        return df.string(from: date).capitalized
    }

    @ViewBuilder
    private func dayCard(_ date: Date, isToday: Bool) -> some View {
        let label = Self.dayLabel(for: date)
        let key = Self.isoFormatter.string(from: date)
        let dayEvents = eventsByDate[key] ?? []

        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(label)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(GLColor.textPrimary(scheme))
                if isToday {
                    Text("DZIŚ")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.8)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(GLColor.accent300(scheme))
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }
                Spacer()
            }

            // Strukturalne eventy z harmonogramu (8.h.28) — pinezki per dzień.
            // Renderowane na WSZYSTKICH dniach (w tym 16/19/25), zastępuje
            // dawne „Brak danych z harmonogramu".
            if !dayEvents.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(dayEvents) { event in
                        eventRow(event)
                    }
                }
            }

            // Karta DZIŚ: deterministyczny tekst (dzisiejsze + „Najbliżej")
            // z tych samych eventów co pinezki — spójny, bez LLM.
            if isToday, let text = todaySummaryText {
                Text(text)
                    .font(.system(size: 13))
                    .foregroundStyle(GLColor.textSecondary(scheme))
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Pusty dzień — krótki placeholder (nie „Brak danych", bo dane SĄ,
            // tylko nic na ten konkretny dzień nie przypada).
            if dayEvents.isEmpty && !(isToday && todaySummaryText != nil) {
                Text("Brak zaplanowanych wydarzeń.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: GLRadius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: GLRadius.lg, style: .continuous)
                .stroke(
                    isToday ? GLColor.accent300(scheme).opacity(0.4) : GLColor.borderSubtle(scheme),
                    lineWidth: isToday ? 1.5 : 1,
                ),
        )
    }

    /// Pojedynczy event w karcie dnia — ikona kategorii + tytuł.
    @ViewBuilder
    private func eventRow(_ event: CalendarEvent) -> some View {
        HStack(spacing: 8) {
            Text(event.icon ?? "📌")
                .font(.system(size: 14))
            Text(event.title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(GLColor.textPrimary(scheme))
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GLColor.bg1(scheme))
        .clipShape(RoundedRectangle(cornerRadius: GLRadius.md, style: .continuous))
    }

    private func load(refresh: Bool = false) async {
        loading = true

        // Strukturalny kalendarz (8.h.28) — eventy per dzień. Grupujemy po
        // dacie ISO. Fail-silent przy starszym backendzie (brak endpointu →
        // pusty słownik → karty pokażą „brak wydarzeń"). Pull-to-refresh
        // (`refresh=1`) pomija 15-min cache Cloud → świeży harmonogram.
        do {
            let cal: CalendarResponse = try await APIClient.shared.get(
                "/resident/assistant/calendar?days=31" + (refresh ? "&refresh=1" : ""),
            )
            eventsByDate = Dictionary(grouping: cal.events, by: { $0.date })
        } catch {
            eventsByDate = [:]
        }

        loading = false
    }
}
