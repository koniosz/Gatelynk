import SwiftUI

// MARK: - Tryb administratora osiedla w Glass (2026-09-06)
//
// Zgłoszenie: administrator (konto building-admin) logujący się do apki musi
// dostać INNY / bogatszy zestaw kafelków niż mieszkaniec. Dotąd Glass witał go
// notką „obsługuje tylko konto mieszkańca". Ten plik: modele odpowiedzi BA API
// (istniejące endpointy `/building-admin/buildings/:id/*`) + arkusze kafelków
// administratora. Ekran główny — GlassAdminHomeView.swift.
//
// Zasada: zero nowych endpointów — wszystko, co panel webowy BA już pokazuje,
// tu dostaje mobilną, glassową formę. Fail-silent na starszym backendzie.

// MARK: Modele BA API

struct BAOverview: Decodable {
    struct Admin: Decodable { let firstName: String }
    struct Property: Decodable, Identifiable {
        let id: Int
        let name: String
        let address: String?
        let district: String?
        let units: Int?
        let residents: Int?
        let tickets: Int?
        let inProgress: Int?
        let overdueAmount: Double?
        let unitsInArrears: Int?
        let activeGuests: Int?
        let pendingVehicles: Int?
    }
    struct Totals: Decodable {
        let tickets: Int
        let inProgress: Int
        let overdueAmount: Double
    }
    let admin: Admin
    let properties: [Property]
    let totals: Totals
}

struct BASituationEvent: Decodable, Identifiable {
    let id: Int
    let type: String
    let startedTs: Double
    let endedTs: Double?
    let confidence: String?
    let title: String
    let vlmNote: String?
    let evidenceImages: [String]?
}

struct BASituationsResponse: Decodable { let events: [BASituationEvent] }

struct BAChronicle: Decodable {
    let date: String?
    let lines: [String]
    let narrative: String?
}

struct BATicketResident: Decodable {
    let firstName: String?
    let lastName: String?
}

struct BATicket: Decodable, Identifiable {
    let id: Int
    let title: String
    let body: String
    let status: String
    let category: String?
    let createdAt: Date
    let resident: BATicketResident?
}

struct BAOverdue: Decodable {
    let amount: Double
    let daysOverdue: Int?
}

struct BAPaymentUnit: Decodable, Identifiable {
    var id: Int { unitId }
    let unitId: Int
    let number: String
    let balance: Double?
    let overdue: BAOverdue?
}

struct BAEdgeDevice: Decodable, Identifiable {
    let id: String
    let name: String?
    let online: Bool?
    let ipAddress: String?
    let lastSeenAt: Date?
}

struct BANamedDevice: Decodable, Identifiable {
    let id: Int
    let name: String
    let model: String?
    let ipAddress: String?
    let online: Bool?
}

struct BADevicesResponse: Decodable {
    let edges: [BAEdgeDevice]
    let intercoms: [BANamedDevice]?
    let cameras: [BANamedDevice]?
}

struct BALprRead: Decodable, Identifiable {
    let id: Int
    let plate: String
    let matched: Bool
    let owner: String?
    let gateOpened: Bool
    let direction: String?
    let ts: Date
    let hasImage: Bool?
    let vehicleBrand: String?
    let vehicleColor: String?
}

struct BALprReadsResponse: Decodable {
    let reads: [BALprRead]
    let total: Int?
}

// MARK: Wspólne

/// Czas osiedla, nie telefonu — administrator bywa w innej strefie (feedback
/// 2026-08-27 przy panelu Zdarzeń: godziny „rozjeżdżały się" z treścią).
enum BAFormat {
    static let estateTZ = TimeZone(identifier: "Europe/Warsaw") ?? .current

    static func time(_ date: Date) -> String {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.timeZone = estateTZ
        df.dateFormat = "HH:mm"
        return df.string(from: date)
    }

    static func dayTime(_ date: Date) -> String {
        let cal = Calendar(identifier: .gregorian)
        var c = cal
        c.timeZone = estateTZ
        let prefix: String
        if c.isDateInToday(date) { prefix = "dziś" }
        else if c.isDateInYesterday(date) { prefix = "wczoraj" }
        else {
            let df = DateFormatter()
            df.locale = Locale(identifier: "pl_PL")
            df.timeZone = estateTZ
            df.dateFormat = "d MMM"
            prefix = df.string(from: date)
        }
        return "\(prefix) \(time(date))"
    }

    static func zl(_ amount: Double) -> String {
        let nf = NumberFormatter()
        nf.locale = Locale(identifier: "pl_PL")
        nf.numberStyle = .decimal
        nf.maximumFractionDigits = 0
        return (nf.string(from: NSNumber(value: amount)) ?? "\(Int(amount))") + " zł"
    }
}

/// Obraz z endpointu wymagającego Bearer (kadry dowodowe, snapshoty LPR) —
/// AsyncImage nie doda nagłówka, więc pobieramy bajty przez APIClient
/// i trzymamy w małym cache per ścieżka.
struct BAAuthImage: View {
    let path: String
    var height: CGFloat = 64
    var width: CGFloat? = 96

    @State private var image: UIImage?
    @State private var failed = false

    private static let cache = NSCache<NSString, UIImage>()

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.white.opacity(0.08))
                    .overlay {
                        if failed {
                            Image(systemName: "photo").foregroundStyle(.white.opacity(0.35))
                        } else {
                            ProgressView().tint(.white.opacity(0.6))
                        }
                    }
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .task(id: path) { await load() }
    }

    private func load() async {
        if let cached = Self.cache.object(forKey: path as NSString) {
            image = cached
            return
        }
        guard let data = try? await APIClient.shared.getRawData(path),
              let img = UIImage(data: data) else {
            failed = true
            return
        }
        Self.cache.setObject(img, forKey: path as NSString)
        image = img
    }
}

private struct BAChipRow<T: Hashable>: View {
    let items: [(T, String)]
    @Binding var selected: T

    var body: some View {
        HStack(spacing: 6) {
            ForEach(items, id: \.0) { item in
                let active = item.0 == selected
                Button { selected = item.0 } label: {
                    Text(item.1)
                        .font(.system(size: 12, weight: active ? .bold : .semibold))
                        .foregroundStyle(active ? .white : .white.opacity(0.7))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background {
                            Capsule().fill(active ? GlassColor.accentBlue.opacity(0.45) : Color.white.opacity(0.08))
                        }
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
    }
}

private func baRowCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    content()
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.07))
        }
}

// MARK: - Zdarzenia sytuacyjne (korelator Edge + VLM)

struct GlassAdminSituationsSheet: View {
    let buildingId: Int
    let onClose: () -> Void

    @State private var events: [BASituationEvent] = []
    @State private var loading = true
    @State private var hours = 24
    @State private var zoomPath: String?

    private static let typeMeta: [String: (String, String)] = [
        "FALL_CONFIRMED": ("⚠️", "Upadek"),
        "TAILGATING": ("🚧", "Na ogonie"),
        "VEHICLE_LOITERING": ("🕵️", "Krążący pojazd"),
        "NIGHT_PERSON": ("🌙", "Osoba w nocy"),
        "VEHICLE_WAITING": ("⏳", "Pojazd czeka"),
        "COURIER_VISIT": ("📦", "Kurier / dostawa"),
    ]

    var body: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Administrator", title: "Zdarzenia sytuacyjne", onClose: onClose)
            BAChipRow(items: [(24, "24 h"), (72, "3 dni"), (168, "7 dni")], selected: $hours)
                .onChange(of: hours) { _, _ in Task { await load() } }

            if loading {
                GlassSheetLoading()
            } else if events.isEmpty {
                GlassSheetEmptyState(icon: "checkmark.shield", text: "Spokojnie — brak zdarzeń w wybranym oknie.")
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 8) {
                        ForEach(events) { ev in row(ev) }
                    }
                    .padding(.bottom, 8)
                }
                .scrollBounceBehavior(.basedOnSize)
                .refreshable { await load() }
            }
        }
        .task { await load() }
        .overlay {
            if let zoomPath {
                ZStack {
                    Color.black.opacity(0.85).ignoresSafeArea()
                    BAAuthImage(path: zoomPath, height: 280, width: nil)
                        .padding(16)
                }
                .onTapGesture { self.zoomPath = nil }
            }
        }
    }

    private func row(_ ev: BASituationEvent) -> some View {
        let meta = Self.typeMeta[ev.type] ?? ("•", ev.type)
        let start = Date(timeIntervalSince1970: ev.startedTs / 1000)
        return baRowCard {
            HStack(alignment: .top, spacing: 10) {
                Text(meta.0).font(.system(size: 22))
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(meta.1.uppercased())
                            .font(.system(size: 10.5, weight: .bold))
                            .tracking(0.6)
                            .foregroundStyle(.white.opacity(0.55))
                        Text(BAFormat.dayTime(start))
                            .font(.system(size: 11))
                            .foregroundStyle(.white.opacity(0.55))
                        if ev.confidence == "INFERRED" {
                            Text("interpretacja")
                                .font(.system(size: 10))
                                .foregroundStyle(.white.opacity(0.5))
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Capsule().stroke(Color.white.opacity(0.25)))
                        }
                    }
                    Text(ev.title)
                        .font(.system(size: 13.5))
                        .foregroundStyle(.white.opacity(0.92))
                    if let note = ev.vlmNote, !note.isEmpty {
                        Text("🔎 \(note)")
                            .font(.system(size: 12.5).italic())
                            .foregroundStyle(.white.opacity(0.65))
                    }
                    if let imgs = ev.evidenceImages, !imgs.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(imgs.prefix(3), id: \.self) { img in
                                let path = "/building-admin/buildings/\(buildingId)/vision/frame/\(img)"
                                BAAuthImage(path: path)
                                    .onTapGesture { zoomPath = path }
                            }
                        }
                        .padding(.top, 4)
                    }
                }
            }
        }
    }

    private func load() async {
        loading = events.isEmpty
        if let res: BASituationsResponse = try? await APIClient.shared.get(
            "/building-admin/buildings/\(buildingId)/situations?since_hours=\(hours)&limit=100"
        ) {
            events = res.events
        }
        loading = false
    }
}

// MARK: - Kronika dnia

struct GlassAdminChronicleSheet: View {
    let buildingId: Int
    let onClose: () -> Void

    @State private var chronicle: BAChronicle?
    @State private var narrativeLoading = false

    var body: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Administrator", title: "Kronika dnia", onClose: onClose)
            if let chronicle {
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 10) {
                        if let n = chronicle.narrative {
                            Text(n)
                                .font(.system(size: 14.5))
                                .lineSpacing(4)
                                .foregroundStyle(.white.opacity(0.92))
                                .padding(14)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background {
                                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                                        .fill(Color.white.opacity(0.08))
                                }
                        } else if narrativeLoading {
                            Label("AI układa narrację…", systemImage: "sparkles")
                                .font(.system(size: 12))
                                .foregroundStyle(.white.opacity(0.55))
                        }
                        if chronicle.lines.isEmpty {
                            GlassSheetEmptyState(icon: "book.closed", text: "Dziś jeszcze spokojnie — brak zdarzeń.")
                        } else {
                            ForEach(Array(chronicle.lines.enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(.system(size: 13))
                                    .lineSpacing(3)
                                    .foregroundStyle(.white.opacity(0.8))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .padding(.bottom, 8)
                }
                .scrollBounceBehavior(.basedOnSize)
            } else {
                GlassSheetLoading()
            }
        }
        .task { await load() }
    }

    private func load() async {
        // Fakty od razu (smart=0), narracja Bielika dociąga się w tle.
        if let fast: BAChronicle = try? await APIClient.shared.get(
            "/building-admin/buildings/\(buildingId)/chronicle?smart=0"
        ) {
            chronicle = fast
        }
        narrativeLoading = true
        if let smart: BAChronicle = try? await APIClient.shared.get(
            "/building-admin/buildings/\(buildingId)/chronicle?smart=1"
        ), smart.narrative != nil {
            chronicle = smart
        }
        narrativeLoading = false
    }
}

// MARK: - Zgłoszenia mieszkańców (lista + zmiana statusu)

struct GlassAdminTicketsSheet: View {
    let buildingId: Int
    let onClose: () -> Void

    @State private var tickets: [BATicket] = []
    @State private var loading = true
    @State private var filter = "ALL"
    @State private var expanded: Int?
    @State private var busyId: Int?

    private struct StatusBody: Encodable { let status: String }

    var body: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Administrator", title: "Zgłoszenia mieszkańców", onClose: onClose)
            BAChipRow(
                items: [("ALL", "Wszystkie"), ("OPEN", "Otwarte"), ("IN_PROGRESS", "W toku"), ("DONE", "Zamknięte")],
                selected: $filter
            )
            if loading {
                GlassSheetLoading()
            } else if visible.isEmpty {
                GlassSheetEmptyState(icon: "tray", text: "Brak zgłoszeń w tym filtrze.")
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 8) {
                        ForEach(visible) { t in row(t) }
                    }
                    .padding(.bottom, 8)
                }
                .scrollBounceBehavior(.basedOnSize)
                .refreshable { await load() }
            }
        }
        .task { await load() }
    }

    private var visible: [BATicket] {
        filter == "ALL" ? tickets : tickets.filter { $0.status == filter }
    }

    private func statusLabel(_ s: String) -> (String, Color) {
        switch s {
        case "OPEN": return ("Otwarte", GlassColor.dangerSoft)
        case "IN_PROGRESS": return ("W toku", GlassColor.orbAmber1)
        case "DONE": return ("Zamknięte", GlassColor.success)
        default: return (s, .white)
        }
    }

    private func row(_ t: BATicket) -> some View {
        let (label, color) = statusLabel(t.status)
        let who = [t.resident?.firstName, t.resident?.lastName].compactMap { $0 }.joined(separator: " ")
        return baRowCard {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(t.title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                    Spacer()
                    Text(label)
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(color)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(color.opacity(0.18)))
                }
                Text("\(who.isEmpty ? "Mieszkaniec" : who) · \(BAFormat.dayTime(t.createdAt))")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.55))
                if expanded == t.id {
                    Text(t.body)
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(.top, 2)
                    HStack(spacing: 8) {
                        if t.status != "IN_PROGRESS" {
                            actionButton("W toku", tint: GlassColor.orbAmber1) { await setStatus(t, "IN_PROGRESS") }
                        }
                        if t.status != "DONE" {
                            actionButton("Zamknij", tint: GlassColor.success) { await setStatus(t, "DONE") }
                        }
                        if t.status == "DONE" {
                            actionButton("Otwórz ponownie", tint: GlassColor.dangerSoft) { await setStatus(t, "OPEN") }
                        }
                    }
                    .padding(.top, 4)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.easeInOut(duration: 0.2)) {
                    expanded = expanded == t.id ? nil : t.id
                }
            }
        }
    }

    private func actionButton(_ title: String, tint: Color, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            Text(title)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Capsule().fill(tint.opacity(0.5)))
        }
        .buttonStyle(.plain)
        .disabled(busyId != nil)
    }

    private func setStatus(_ t: BATicket, _ status: String) async {
        busyId = t.id
        defer { busyId = nil }
        struct Any_: Decodable {}
        let _: Any_? = try? await APIClient.shared.patch(
            "/building-admin/buildings/\(buildingId)/tickets/\(t.id)/status",
            body: StatusBody(status: status)
        )
        await load()
    }

    private func load() async {
        loading = tickets.isEmpty
        if let list: [BATicket] = try? await APIClient.shared.get(
            "/building-admin/buildings/\(buildingId)/tickets"
        ) {
            tickets = list
        }
        loading = false
    }
}

// MARK: - Zaległości (płatności per lokal + przypomnienie)

struct GlassAdminArrearsSheet: View {
    let buildingId: Int
    let onClose: () -> Void

    @State private var units: [BAPaymentUnit] = []
    @State private var loading = true
    @State private var remindedIds: Set<Int> = []
    @State private var busyId: Int?

    var body: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Administrator", title: "Zaległości", onClose: onClose)
            if loading {
                GlassSheetLoading()
            } else if overdue.isEmpty {
                GlassSheetEmptyState(
                    icon: "checkmark.seal",
                    text: units.isEmpty
                        ? "Moduł płatności nie ma jeszcze naliczeń dla tego osiedla."
                        : "Brak zaległości — wszystkie lokale na bieżąco."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 8) {
                        baRowCard {
                            HStack {
                                Text("Łącznie \(overdue.count) lokali")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(.white.opacity(0.85))
                                Spacer()
                                Text(BAFormat.zl(overdue.reduce(0) { $0 + ($1.overdue?.amount ?? 0) }))
                                    .font(.system(size: 15, weight: .bold))
                                    .foregroundStyle(GlassColor.dangerSoft)
                            }
                        }
                        ForEach(overdue) { u in row(u) }
                    }
                    .padding(.bottom, 8)
                }
                .scrollBounceBehavior(.basedOnSize)
                .refreshable { await load() }
            }
        }
        .task { await load() }
    }

    private var overdue: [BAPaymentUnit] {
        units
            .filter { ($0.overdue?.amount ?? 0) > 0.01 }
            .sorted { ($0.overdue?.amount ?? 0) > ($1.overdue?.amount ?? 0) }
    }

    private func row(_ u: BAPaymentUnit) -> some View {
        baRowCard {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(u.number)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                    if let d = u.overdue?.daysOverdue, d > 0 {
                        Text("najstarsza \(d) dni po terminie")
                            .font(.system(size: 11.5))
                            .foregroundStyle(.white.opacity(0.55))
                    }
                }
                Spacer()
                Text(BAFormat.zl(u.overdue?.amount ?? 0))
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(GlassColor.dangerSoft)
                Button {
                    Task { await remind(u) }
                } label: {
                    Image(systemName: remindedIds.contains(u.unitId) ? "checkmark" : "bell")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(Color.white.opacity(remindedIds.contains(u.unitId) ? 0.12 : 0.18)))
                }
                .buttonStyle(.plain)
                .disabled(busyId != nil || remindedIds.contains(u.unitId))
            }
        }
    }

    private func remind(_ u: BAPaymentUnit) async {
        busyId = u.unitId
        defer { busyId = nil }
        struct Empty: Encodable {}
        struct Any_: Decodable {}
        let ok: Any_? = try? await APIClient.shared.post(
            "/building-admin/buildings/\(buildingId)/payments/\(u.unitId)/remind",
            body: Empty()
        )
        if ok != nil { remindedIds.insert(u.unitId) }
    }

    private func load() async {
        loading = units.isEmpty
        if let list: [BAPaymentUnit] = try? await APIClient.shared.get(
            "/building-admin/buildings/\(buildingId)/payments"
        ) {
            units = list
        }
        loading = false
    }
}

// MARK: - Odczyty tablic

struct GlassAdminPlatesSheet: View {
    let buildingId: Int
    let onClose: () -> Void

    @State private var reads: [BALprRead] = []
    @State private var loading = true
    @State private var filter = "all"

    var body: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Administrator", title: "Odczyty tablic", onClose: onClose)
            BAChipRow(items: [("all", "Wszystkie"), ("matched", "Rozpoznane"), ("unknown", "Nieznane")], selected: $filter)
                .onChange(of: filter) { _, _ in Task { await load() } }
            if loading {
                GlassSheetLoading()
            } else if reads.isEmpty {
                GlassSheetEmptyState(icon: "camera", text: "Brak odczytów.")
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 8) {
                        ForEach(reads) { r in row(r) }
                    }
                    .padding(.bottom, 8)
                }
                .scrollBounceBehavior(.basedOnSize)
                .refreshable { await load() }
            }
        }
        .task { await load() }
    }

    private func row(_ r: BALprRead) -> some View {
        let isOut = ["out", "OUT", "reverse"].contains(r.direction ?? "")
        return baRowCard {
            HStack(spacing: 10) {
                if r.hasImage == true {
                    BAAuthImage(path: "/building-admin/buildings/\(buildingId)/lpr-reads/\(r.id)/image", height: 52, width: 78)
                }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(r.plate)
                            .font(.system(size: 14, weight: .heavy, design: .monospaced))
                            .foregroundStyle(GlassColor.plateBg)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(RoundedRectangle(cornerRadius: 5).fill(GlassColor.plateYellow))
                        Image(systemName: isOut ? "arrow.up.right" : "arrow.down.left")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white.opacity(0.6))
                        if r.gateOpened {
                            Image(systemName: "door.left.hand.open")
                                .font(.system(size: 11))
                                .foregroundStyle(GlassColor.success)
                        }
                    }
                    Text([r.matched ? (r.owner ?? "z rejestru") : "nieznany", BAFormat.dayTime(r.ts)].joined(separator: " · "))
                        .font(.system(size: 11.5))
                        .foregroundStyle(.white.opacity(0.6))
                }
                Spacer(minLength: 0)
            }
        }
    }

    private func load() async {
        loading = reads.isEmpty
        var q = "?limit=60&offset=0"
        if filter == "matched" { q += "&matched=true" }
        if filter == "unknown" { q += "&matched=false" }
        if let res: BALprReadsResponse = try? await APIClient.shared.get(
            "/building-admin/buildings/\(buildingId)/lpr-reads\(q)"
        ) {
            reads = res.reads
        }
        loading = false
    }
}

// MARK: - Urządzenia (status online)

struct GlassAdminDevicesSheet: View {
    let buildingId: Int
    let onClose: () -> Void

    @State private var devices: BADevicesResponse?
    @State private var loading = true

    var body: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Administrator", title: "Urządzenia", onClose: onClose)
            if loading {
                GlassSheetLoading()
            } else if let d = devices {
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 10) {
                        section("Edge", d.edges.map { ($0.name ?? "Edge \($0.id.prefix(6))", $0.ipAddress, $0.online ?? false) })
                        section("Domofony", (d.intercoms ?? []).map { ($0.name, $0.ipAddress, $0.online ?? edgeOnline(d)) })
                        section("Kamery", (d.cameras ?? []).map { ($0.name, $0.ipAddress, $0.online ?? edgeOnline(d)) })
                    }
                    .padding(.bottom, 8)
                }
                .scrollBounceBehavior(.basedOnSize)
                .refreshable { await load() }
            } else {
                GlassSheetEmptyState(icon: "cpu", text: "Nie udało się pobrać listy urządzeń.")
            }
        }
        .task { await load() }
    }

    private func edgeOnline(_ d: BADevicesResponse) -> Bool {
        d.edges.contains { $0.online == true }
    }

    private func section(_ title: String, _ items: [(String, String?, Bool)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.system(size: 10.5, weight: .bold))
                .tracking(1.0)
                .foregroundStyle(.white.opacity(0.5))
            if items.isEmpty {
                Text("—").font(.system(size: 12)).foregroundStyle(.white.opacity(0.4))
            }
            ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                baRowCard {
                    HStack(spacing: 10) {
                        Circle()
                            .fill(it.2 ? GlassColor.success : GlassColor.dangerSoft)
                            .frame(width: 9, height: 9)
                        Text(it.0)
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(.white)
                        Spacer()
                        Text(it.1 ?? "")
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.5))
                    }
                }
            }
        }
    }

    private func load() async {
        loading = devices == nil
        devices = try? await APIClient.shared.get("/building-admin/buildings/\(buildingId)/devices")
        loading = false
    }
}
