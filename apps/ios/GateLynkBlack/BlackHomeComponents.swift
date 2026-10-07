import SwiftUI

struct BlackHomeHeader: View {
    let propertyName: String
    let title: String?
    let compact: Bool
    let onProperty: () -> Void
    let onAccount: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onProperty) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(propertyName.uppercased())
                            .font(.system(size: 11, weight: .medium))
                            .tracking(1.7)
                            .lineLimit(1)
                        BlackIcon(name: "chevron-down", size: 13)
                    }
                    .foregroundStyle(Color(hex: 0xB4B0C0))
                    if let title {
                        Text(title)
                            .font(BlackTheme.heading(29))
                            .foregroundStyle(BlackTheme.text)
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Nieruchomość: \(propertyName)")
            .accessibilityHint("Zmień nieruchomość")

            Button(action: onAccount) {
                BlackIcon(name: "user-round", size: 19)
                    .foregroundStyle(BlackTheme.accent)
                    .frame(width: 44, height: 44)
                    .background(BlackTheme.accent.opacity(0.05), in: Circle())
                    .overlay(Circle().strokeBorder(BlackTheme.accent.opacity(0.17), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Konto i ustawienia")
        }
        .padding(.horizontal, 20)
        .padding(.top, 3)
        .padding(.bottom, 10)
        .frame(minHeight: title == nil ? 58 : compact ? 72 : 78)
        .background(BlackTheme.background.opacity(0.96))
    }
}

enum BlackModule: String, CaseIterable, Identifiable {
    case vehicles, guests, payments, tickets, parcels, announcements
    var id: Self { self }
    var title: String {
        switch self {
        case .vehicles: "Pojazdy"
        case .guests: "Goście"
        case .payments: "Płatności"
        case .tickets: "Zgłoszenia"
        case .parcels: "Przesyłki"
        case .announcements: "Ogłoszenia"
        }
    }
    var icon: String {
        switch self {
        case .vehicles: "car-front"
        case .guests: "users-round"
        case .payments: "credit-card"
        case .tickets: "wrench"
        case .parcels: "package"
        case .announcements: "megaphone"
        }
    }
    var color: Color {
        switch self {
        case .vehicles, .announcements: Color(hex: 0xC2A0FF)
        case .guests: Color(hex: 0x70E1DD)
        case .payments: BlackTheme.coral
        case .tickets: BlackTheme.amber
        case .parcels: BlackTheme.blue
        }
    }
    var tint: Color {
        switch self {
        case .vehicles, .announcements: Color(hex: 0x3D2E59)
        case .guests: Color(hex: 0x1B454C)
        case .payments: Color(hex: 0x592C3B)
        case .tickets: Color(hex: 0x4B381F)
        case .parcels: Color(hex: 0x253B5B)
        }
    }
    var sheet: GlassSheetKind {
        switch self {
        case .vehicles: .vehicles
        case .guests: .guests
        case .payments: .payments
        case .tickets: .tickets
        case .parcels: .parcels
        case .announcements: .announcements
        }
    }
}

struct BlackShortcutGrid: View {
    let modules: [BlackModule]
    var summaries: [BlackModule: String] = [:]
    let onSelect: (BlackModule) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption) private var labelSize = 11.0

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: dynamicTypeSize.isAccessibilitySize ? 2 : 3), spacing: 8) {
            ForEach(modules) { module in
                Button { onSelect(module) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        BlackIcon(name: module.icon, size: 17)
                            .foregroundStyle(module.color)
                            .frame(width: 28, height: 28)
                            .background(module.tint, in: Circle())
                            .overlay(Circle().strokeBorder(.white.opacity(0.08), lineWidth: 1))
                        Text(module.title)
                            .font(.system(size: labelSize))
                            .foregroundStyle(Color(hex: 0xE8E7EE))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, minHeight: 51, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Color(hex: 0x1B1C23), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.055), lineWidth: 1))
                    .contentShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(module.title)
                .accessibilityValue(summaries[module] ?? "")
            }
        }
    }
}

struct BlackContextNotice: View {
    let title: String
    let detail: String
    var icon: String = "package-check"
    var tint: Color = BlackTheme.blue
    let action: () -> Void
    @ScaledMetric(relativeTo: .caption) private var titleSize = 12.0
    @ScaledMetric(relativeTo: .caption) private var detailSize = 11.0

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                BlackIcon(name: icon, size: 21).foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: titleSize, weight: .medium)).foregroundStyle(BlackTheme.text)
                    Text(detail).font(.system(size: detailSize)).foregroundStyle(BlackTheme.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                BlackIcon(name: "chevron-right", size: 15).foregroundStyle(BlackTheme.muted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(minHeight: 57)
            .background(LinearGradient(colors: [Color(hex: 0x1D2939), Color(hex: 0x1C2029)], startPoint: .leading, endPoint: .trailing), in: RoundedRectangle(cornerRadius: 11))
            .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(tint.opacity(0.14), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// „Zapytaj GateLynk AI" (2026-10-08, Konrad: „bardziej widoczny i chwytliwy
/// button") — pełnej szerokości, z gradientem akcji i rotującym przykładem
/// pytania, żeby było jasne, o co można zapytać.
struct BlackAskButton: View {
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var titleSize = 15.0
    @ScaledMetric(relativeTo: .caption) private var hintSize = 12.0

    static let prompts = [
        "„Czy był dziś kurier InPost?”",
        "„Kiedy najbliższy odbiór szkła?”",
        "„Kiedy była dziś śmieciarka?”",
        "„Co działo się dziś na osiedlu?”",
    ]

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                BlackIcon(name: "sparkles", size: 19)
                    .foregroundStyle(Color(hex: 0x151222))
                    .frame(width: 40, height: 40)
                    .background(BlackTheme.actionGradient, in: Circle())
                VStack(alignment: .leading, spacing: 3) {
                    Text("Zapytaj GateLynk AI")
                        .font(.system(size: titleSize, weight: .semibold))
                        .foregroundStyle(BlackTheme.text)
                    TimelineView(.periodic(from: .now, by: 3.5)) { context in
                        let index = reduceMotion ? 0
                            : Int(context.date.timeIntervalSinceReferenceDate / 3.5) % Self.prompts.count
                        Text("np. \(Self.prompts[index])")
                            .font(.system(size: hintSize))
                            .foregroundStyle(Color(hex: 0xC9BCEB))
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                            .id(index)
                            .transition(.opacity)
                            .animation(.easeInOut(duration: 0.35), value: index)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                BlackIcon(name: "arrow-up-right", size: 15)
                    .foregroundStyle(BlackTheme.text)
                    .frame(width: 32, height: 32)
                    .background(.white.opacity(0.08), in: Circle())
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 64)
            .background(
                LinearGradient(colors: BlackTheme.actionColors.map { $0.opacity(0.16) },
                               startPoint: .leading, endPoint: .trailing),
                in: RoundedRectangle(cornerRadius: 14)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(LinearGradient(colors: BlackTheme.actionColors.map { $0.opacity(0.5) },
                                                 startPoint: .leading, endPoint: .trailing), lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Zapytaj GateLynk AI")
        .accessibilityHint("Otwiera czat z asystentem osiedla")
    }
}

// MARK: - „Najnowsze na osiedlu" (2026-10-08)
//
// Fakty zamiast akapitów z LLM, w kolejności Konrada: aktualne ogłoszenie
// administracji → przejazdy MOICH aut → kurierzy (i taksówki) → odpady.
// Okno kroczące (24 h) — tuż po północy „dziś" było puste; godziny mają
// dopisek dziś/wczoraj. Dane: GET /resident/assistant/estate-today.

struct EstateToday: Decodable, Equatable {
    struct Announcement: Decodable, Equatable { let id: Int; let title: String; let body: String; let sentAt: Date }
    struct MyVehicles: Decodable, Equatable { let vehicles: Int; let entries: Int; let exits: Int; let lastAt: Date? }
    struct Courier: Decodable, Equatable { let label: String; let visits: Int; let lastAt: Date }
    struct WasteTruck: Decodable, Equatable { let visits: Int; let lastAt: Date }
    struct Estate: Decodable, Equatable { let couriers: [Courier]; let taxis: Int; let wasteTruck: WasteTruck? }
    struct WastePickup: Decodable, Equatable { let today: String?; let tomorrow: String? }
    /// Długość okna faktów w godzinach (starsze API: brak → 24).
    var windowHours: Int? = 24
    let announcement: Announcement?
    let myVehicles: MyVehicles?
    let estate: Estate?
    let wastePickup: WastePickup?
}

struct BlackEstateTodayCard: View {
    /// Pamięć per mieszkaniec + nieruchomość — powrót na Dom nie przeładowuje.
    let cacheKey: String?
    let load: (_ refresh: Bool) async throws -> EstateToday
    let onOpenAnnouncement: (Int) -> Void

    private enum Phase: Equatable { case loading, loaded(EstateToday), failed }
    @State private var phase: Phase = .loading
    @State private var refreshing = false
    @Environment(\.scenePhase) private var scenePhase
    @ScaledMetric(relativeTo: .caption) private var labelSize = 11.0
    @ScaledMetric(relativeTo: .body) private var valueSize = 13.5

    private static var cache: (key: String, data: EstateToday, at: Date)?
    private static let ttl: TimeInterval = 5 * 60

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            switch phase {
            case .loading:
                ProgressView().tint(BlackTheme.accent)
                    .frame(maxWidth: .infinity, minHeight: 90)
            case .failed:
                Text("Nie udało się pobrać informacji — spróbuj odświeżyć.")
                    .font(.system(size: valueSize))
                    .foregroundStyle(BlackTheme.muted)
                    .padding(.vertical, 12)
            case .loaded(let data):
                rows(data)
            }
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 6)
        .background(Color(hex: 0x1B1C23), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.055), lineWidth: 1))
        .task(id: cacheKey) { await initialLoad() }
        .onChange(of: scenePhase) { _, value in
            // Powrót do apki po dłuższej przerwie = świeże fakty dnia.
            if value == .active, let c = Self.cache, Date().timeIntervalSince(c.at) > Self.ttl {
                Task { await reload(refresh: false) }
            }
        }
    }

    private var header: some View {
        HStack {
            HStack(spacing: 6) {
                BlackIcon(name: "sparkles", size: 13).foregroundStyle(BlackTheme.accent)
                Text("NAJNOWSZE NA OSIEDLU")
                    .font(.system(size: 11, weight: .medium))
                    .tracking(1.4)
                    .foregroundStyle(Color(hex: 0xB4B0C0))
            }
            .accessibilityAddTraits(.isHeader)
            Spacer()
            Button { Task { await reload(refresh: true) } } label: {
                BlackIcon(name: "refresh-cw", size: 15)
                    .foregroundStyle(BlackTheme.muted)
                    .rotationEffect(.degrees(refreshing ? 360 : 0))
                    .animation(refreshing ? .linear(duration: 0.9).repeatForever(autoreverses: false) : .default,
                               value: refreshing)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(refreshing)
            .accessibilityLabel("Odśwież najnowsze na osiedlu")
        }
    }

    @ViewBuilder
    private func rows(_ d: EstateToday) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let a = d.announcement {
                Button { onOpenAnnouncement(a.id) } label: { announcementRow(a) }
                    .buttonStyle(.plain)
                    .accessibilityHint("Otwiera pełną treść ogłoszenia")
            }
            if let v = d.myVehicles {
                divider
                factRow(icon: "car-front", color: Color(hex: 0xC2A0FF), tint: Color(hex: 0x3D2E59),
                        label: "Twoje auta · \(Self.window(d))", value: Self.vehiclesText(v, hours: d.windowHours ?? 24),
                        detail: nil)
            }
            divider
            factRow(icon: "package", color: BlackTheme.blue, tint: Color(hex: 0x253B5B),
                    label: "Kurierzy i dostawy · \(Self.window(d))",
                    value: d.estate.map { Self.couriersText($0, hours: d.windowHours ?? 24) } ?? "Brak danych z kamer osiedla",
                    detail: d.estate.flatMap { $0.taxis > 0 ? "oraz \(Self.taxis($0.taxis))" : nil })
            if let waste = Self.wasteText(d) {
                divider
                factRow(icon: "trash-2", color: BlackTheme.green, tint: Color(hex: 0x1B454C),
                        label: "Odpady", value: waste.value, detail: waste.detail)
            }
        }
    }

    private var divider: some View {
        Rectangle().fill(.white.opacity(0.06)).frame(height: 1).padding(.leading, 44)
    }

    private func announcementRow(_ a: EstateToday.Announcement) -> some View {
        HStack(alignment: .top, spacing: 12) {
            iconBadge("megaphone", color: BlackTheme.amber, tint: Color(hex: 0x4B381F))
            VStack(alignment: .leading, spacing: 3) {
                Text("OGŁOSZENIE ADMINISTRACJI · \(Self.relative(a.sentAt))")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(0.6)
                    .foregroundStyle(BlackTheme.amber)
                Text(a.title)
                    .font(.system(size: valueSize + 0.5, weight: .semibold))
                    .foregroundStyle(BlackTheme.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text(a.body)
                    .font(.system(size: labelSize + 1))
                    .foregroundStyle(BlackTheme.muted)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            BlackIcon(name: "chevron-right", size: 14).foregroundStyle(BlackTheme.muted).padding(.top, 10)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func factRow(icon: String, color: Color, tint: Color, label: String, value: String, detail: String?) -> some View {
        HStack(alignment: .top, spacing: 12) {
            iconBadge(icon, color: color, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: labelSize))
                    .foregroundStyle(BlackTheme.muted)
                Text(value)
                    .font(.system(size: valueSize, weight: .medium))
                    .foregroundStyle(BlackTheme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail {
                    Text(detail)
                        .font(.system(size: labelSize))
                        .foregroundStyle(BlackTheme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    private func iconBadge(_ name: String, color: Color, tint: Color) -> some View {
        BlackIcon(name: name, size: 16)
            .foregroundStyle(color)
            .frame(width: 32, height: 32)
            .background(tint, in: Circle())
            .overlay(Circle().strokeBorder(.white.opacity(0.08), lineWidth: 1))
    }

    // MARK: Ładowanie

    private func initialLoad() async {
        if let key = cacheKey, let c = Self.cache, c.key == key, Date().timeIntervalSince(c.at) < Self.ttl {
            phase = .loaded(c.data)
            return
        }
        await reload(refresh: false)
    }

    private func reload(refresh: Bool) async {
        refreshing = true
        defer { refreshing = false }
        do {
            let data = try await load(refresh)
            if let key = cacheKey { Self.cache = (key, data, Date()) }
            phase = .loaded(data)
        } catch {
            // Odświeżenie, które się nie udało, nie kasuje widocznych faktów.
            if case .loaded = phase { return }
            phase = .failed
        }
    }

    // MARK: Teksty (czyste — testowalne)

    static func window(_ d: EstateToday) -> String { "ostatnie \(d.windowHours ?? 24) h" }

    static func vehiclesText(_ v: EstateToday.MyVehicles, hours: Int = 24, now: Date = Date()) -> String {
        if v.entries == 0 && v.exits == 0 { return "Bez przejazdów przez bramy" }
        var parts: [String] = []
        if v.entries > 0 { parts.append(plural(v.entries, "wjazd", "wjazdy", "wjazdów")) }
        if v.exits > 0 { parts.append(plural(v.exits, "wyjazd", "wyjazdy", "wyjazdów")) }
        if let last = v.lastAt { parts.append("ostatnio \(at(last, now: now))") }
        return parts.joined(separator: " · ")
    }

    static func couriersText(_ e: EstateToday.Estate, hours: Int = 24) -> String {
        guard !e.couriers.isEmpty else { return "Nikogo nie było" }
        return e.couriers.prefix(4)
            .map { $0.visits > 1 ? "\($0.label) ×\($0.visits)" : $0.label }
            .joined(separator: " · ")
    }

    static func taxis(_ n: Int) -> String { plural(n, "taksówka", "taksówki", "taksówek") }

    static func wasteText(_ d: EstateToday, now: Date = Date()) -> (value: String, detail: String?)? {
        let tomorrow = d.wastePickup?.tomorrow.map { "Jutro odbiór: \($0) — wystaw pojemniki wieczorem" }
        let today = d.wastePickup?.today
        if let truck = d.estate?.wasteTruck {
            let times = truck.visits > 1 ? " (\(truck.visits)×)" : ""
            // Dziś jest odbiór, a ostatnia śmieciarka była wczoraj → dzisiejsza
            // jeszcze nie przyjechała (okno 24 h obejmuje poprzednią dobę).
            if let today, !Calendar.current.isDate(truck.lastAt, inSameDayAs: now) {
                return ("Dziś odbiór: \(today) — śmieciarki jeszcze nie było",
                        "Ostatnio: \(at(truck.lastAt, now: now))")
            }
            return ("Śmieciarka była \(at(truck.lastAt, now: now))\(times)", tomorrow)
        }
        if let today { return ("Dziś odbiór: \(today) — śmieciarki jeszcze nie było", tomorrow) }
        if let tomorrow { return (tomorrow, nil) }
        return nil
    }

    /// „dziś o 09:49" / „wczoraj o 09:49" / „6 paź o 09:49".
    static func at(_ date: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        if cal.isDate(date, inSameDayAs: now) { return "dziś o \(hm(date))" }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(date, inSameDayAs: y) {
            return "wczoraj o \(hm(date))"
        }
        return "\(relative(date, now: now)) o \(hm(date))"
    }

    static func plural(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        let last = n % 10, lastTwo = n % 100
        if n == 1 { return "1 \(one)" }
        if (2...4).contains(last) && !(12...14).contains(lastTwo) { return "\(n) \(few)" }
        return "\(n) \(many)"
    }

    private static let hmFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        f.dateFormat = "HH:mm"
        return f
    }()

    static func hm(_ date: Date) -> String { hmFormatter.string(from: date) }

    /// „dziś 18:20" / „wczoraj 18:20" / „6 paź".
    static func relative(_ date: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        if cal.isDate(date, inSameDayAs: now) { return "dziś \(hm(date))" }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(date, inSameDayAs: y) {
            return "wczoraj \(hm(date))"
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        f.dateFormat = "d MMM"
        return f.string(from: date)
    }
}

struct BlackTabBar: View {
    @Binding var selection: GlassHomeTab
    var flagged: Set<GlassHomeTab> = []
    private func icon(_ tab: GlassHomeTab) -> String {
        switch tab {
        case .home: "house"
        case .access: "key-round"
        case .matters: "layers"
        case .estate: "building-2"
        }
    }
    var body: some View {
        HStack(spacing: 0) {
            ForEach(GlassHomeTab.allCases) { tab in
                Button { selection = tab } label: {
                    VStack(spacing: 5) {
                        BlackIcon(name: icon(tab), size: 21)
                            .overlay(alignment: .topTrailing) {
                                if flagged.contains(tab) {
                                    Circle().fill(BlackTheme.amber).frame(width: 6, height: 6).offset(x: 5, y: -2)
                                }
                            }
                        Text(tab.title).font(.caption2)
                    }
                    .foregroundStyle(tab == selection ? Color(hex: 0xC5AEFF) : Color(hex: 0x9E9EAB))
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title + (flagged.contains(tab) ? ", są sprawy wymagające uwagi" : ""))
                .accessibilityAddTraits(tab == selection ? [.isSelected] : [])
            }
        }
        .padding(.horizontal, 13)
        .padding(.top, 7)
        .background(Color(hex: 0x111217).ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.05)).frame(height: 1) }
    }
}
