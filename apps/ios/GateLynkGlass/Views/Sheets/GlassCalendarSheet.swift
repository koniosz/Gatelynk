import SwiftUI

// MARK: - Sheet Kalendarz (2026-07-16 — parity ze starą apką, 8.h.28)
//
// Widok dni z wydarzeniami osiedla (odbiory śmieci itd.) — dane ze
// STRUKTURALNEGO endpointu `GET /resident/assistant/calendar?days=31`
// (Edge deterministycznie parsuje harmonogram z KB, bez LLM). Zakres
// (Dziś / 3 dni / Tydzień / Miesiąc) steruje tylko liczbą renderowanych
// kart — dane i tak są na 31 dni (przełączanie bez refetcha).
// Karta „DZIŚ" pokazuje dodatkowo deterministyczne „Najbliżej: …".

struct GlassCalendarSheet: View {
    let onClose: () -> Void

    /// Eventy zgrupowane po dacie ISO ("YYYY-MM-DD").
    @State private var eventsByDate: [String: [CalendarEvent]] = [:]
    @State private var loading = true
    @State private var range: CalRange = .week

    private let calendar = Calendar(identifier: .gregorian)

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

    private static let isoFormatter: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "en_US_POSIX")
        df.calendar = Calendar(identifier: .gregorian)
        df.dateFormat = "yyyy-MM-dd"
        return df
    }()

    private var visibleDates: [Date] {
        let today = calendar.startOfDay(for: Date())
        return (0..<range.days).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
    }

    /// Deterministyczny tekst karty „DZIŚ" — 3 najbliższe nadchodzące eventy.
    private var todaySummaryText: String? {
        let todayKey = Self.isoFormatter.string(from: calendar.startOfDay(for: Date()))
        let todayEvents = eventsByDate[todayKey] ?? []
        let upcoming = eventsByDate
            .filter { $0.key > todayKey }
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

    private static func plDayMonth(_ iso: String) -> String {
        guard let d = isoFormatter.date(from: iso) else { return iso }
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "d MMMM"
        return df.string(from: d)
    }

    private static func dayLabel(for date: Date) -> String {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "EEEE, d MMMM"
        return df.string(from: date).capitalized
    }

    var body: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Kalendarz", title: "Wydarzenia osiedla", onClose: onClose)

            rangeChips

            if loading {
                GlassSheetLoading()
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 10) {
                        ForEach(Array(visibleDates.enumerated()), id: \.offset) { idx, date in
                            dayCard(date, isToday: idx == 0)
                        }
                    }
                    .padding(.bottom, 6)
                }
                .scrollBounceBehavior(.basedOnSize)
                .refreshable { await load(refresh: true) }
            }
        }
        .task { await load() }
    }

    // MARK: Zakres — chipy w stylu Glass (jak dni tygodnia u gości)

    private var rangeChips: some View {
        HStack(spacing: 6) {
            ForEach(CalRange.allCases) { r in
                let on = range == r
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { range = r }
                } label: {
                    Text(r.label)
                        .font(.system(size: 12, weight: on ? .bold : .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background {
                            if on {
                                Capsule().fill(GlassColor.accentGradient)
                            } else {
                                Capsule().fill(Color.white.opacity(0.08))
                            }
                        }
                        .overlay {
                            if !on {
                                Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                            }
                        }
                        .foregroundStyle(on ? .white : .white.opacity(0.6))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: Karta dnia

    @ViewBuilder
    private func dayCard(_ date: Date, isToday: Bool) -> some View {
        let label = Self.dayLabel(for: date)
        let key = Self.isoFormatter.string(from: date)
        let dayEvents = eventsByDate[key] ?? []

        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Text(label)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(.white)
                if isToday {
                    Text("DZIŚ")
                        .font(.system(size: 9.5, weight: .bold))
                        .tracking(0.8)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background { Capsule().fill(GlassColor.accentGradient) }
                        .foregroundStyle(.white)
                }
                Spacer()
            }

            if !dayEvents.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(dayEvents) { event in
                        eventRow(event)
                    }
                }
            }

            if isToday, let text = todaySummaryText {
                Text(text)
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.65))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if dayEvents.isEmpty && !(isToday && todaySummaryText != nil) {
                Text("Brak zaplanowanych wydarzeń.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.45))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(isToday ? 0.10 : 0.06))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .strokeBorder(
                    isToday ? GlassColor.accentLight.opacity(0.45) : Color.white.opacity(0.12),
                    lineWidth: isToday ? 1.5 : 1
                )
        }
    }

    private func eventRow(_ event: CalendarEvent) -> some View {
        HStack(spacing: 8) {
            Text(event.icon ?? "📌")
                .font(.system(size: 14))
            Text(event.title)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(.white.opacity(0.9))
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.07))
        }
    }

    // MARK: Dane

    private func load(refresh: Bool = false) async {
        loading = eventsByDate.isEmpty
        // Fail-silent — starszy backend bez endpointu → puste karty.
        if let cal: CalendarResponse = try? await APIClient.shared.get(
            "/resident/assistant/calendar?days=31" + (refresh ? "&refresh=1" : "")
        ) {
            eventsByDate = Dictionary(grouping: cal.events, by: { $0.date })
        }
        loading = false
    }
}
