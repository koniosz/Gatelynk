import SwiftUI

// MARK: - Ekran główny administratora osiedla (2026-09-06)
//
// Konto building-admin zalogowane do Glass widzi INNY zestaw kafelków niż
// mieszkaniec: zamiast bramy/gości/paczek — Zdarzenia, Zgłoszenia, Zaległości,
// Odczyty tablic, Urządzenia i Kronika dnia. Dane z `my-buildings-overview`
// (ten sam endpoint co home panelu BA w web). Przy >1 obiekcie — chipy wyboru.
//
// Arkusze kafelków: Views/Sheets/GlassAdminSheets.swift. Hostem sheetów jest
// GlassHomeView (wspólny sheetHost/toast) — tu tylko `onOpenSheet`.

struct GlassAdminHomeView: View {
    let admin: BuildingAdminUser
    let onOpenSheet: (GlassSheetKind) -> Void

    @Environment(AuthManager.self) private var auth

    @State private var overview: BAOverview?
    @State private var loadFailed = false
    @State private var selectedBuildingId: Int?
    @State private var recentSituations = 0

    private var properties: [BAOverview.Property] { overview?.properties ?? [] }

    private var current: BAOverview.Property? {
        properties.first { $0.id == selectedBuildingId } ?? properties.first
    }

    private var buildingId: Int? { current?.id ?? admin.buildingIds.first }

    private var firstName: String {
        if let n = overview?.admin.firstName, !n.isEmpty { return n }
        return admin.name.split(separator: " ").first.map(String.init) ?? admin.name
    }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 10) {
                greeting
                    .glassRiseIn(delay: 0.15)

                if properties.count > 1 {
                    buildingPicker
                        .glassRiseIn(delay: 0.25)
                }

                statsCard
                    .glassShimmer(delay: 0, radius: GlassRadius.primary)
                    .glassRiseIn(delay: 0.3)

                tilesRow1
                    .glassRiseIn(delay: 0.45)

                tilesRow2
                    .glassRiseIn(delay: 0.6)

                footer
                    .glassRiseIn(delay: 0.75)
            }
            .padding(.horizontal, 16)
            .padding(.top, 64)
            .padding(.bottom, 40)
        }
        .refreshable { await load() }
        .task { await load() }
        .task(id: buildingId) { await loadSituationsBadge() }
    }

    // MARK: Powitanie

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text((current?.name ?? "Panel administratora").uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(2.0)
                .foregroundStyle(.white.opacity(0.78))
                .shadow(color: .black.opacity(0.5), radius: 6, y: 2)

            (Text("Cześć, ").fontWeight(.medium) + Text(firstName).fontWeight(.bold))
                .font(.system(size: 34))
                .tracking(-1)
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.5), radius: 15, y: 2)

            Text(greetingMeta)
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.62))
                .shadow(color: .black.opacity(0.4), radius: 6, y: 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.top, 14)
        .padding(.bottom, 20)
    }

    private var greetingMeta: String {
        var parts = [GlassFormat.dayLabel()]
        parts.append("administrator osiedla")
        if loadFailed { parts.append("brak połączenia") }
        return parts.joined(separator: " · ")
    }

    // MARK: Wybór obiektu (>1 property)

    private var buildingPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(properties) { p in
                    let active = p.id == current?.id
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { selectedBuildingId = p.id }
                    } label: {
                        Text(p.name)
                            .font(.system(size: 12.5, weight: active ? .bold : .semibold))
                            .foregroundStyle(active ? .white : .white.opacity(0.7))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background {
                                Capsule().fill(active ? GlassColor.accentBlue.opacity(0.5) : Color.white.opacity(0.10))
                            }
                            .overlay {
                                Capsule().strokeBorder(Color.white.opacity(active ? 0.35 : 0.15), lineWidth: 1)
                            }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    // MARK: Karta statystyk

    private var statsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("OSIEDLE DZIŚ")
                    .font(.system(size: 10.5, weight: .semibold))
                    .tracking(1.5)
                    .foregroundStyle(.white.opacity(0.65))
                Spacer()
                if let addr = current?.address, !addr.isEmpty {
                    Text(addr)
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.5))
                        .lineLimit(1)
                }
            }

            HStack(spacing: 0) {
                stat(value: current?.units, label: "lokale", icon: "building.2")
                stat(value: current?.residents, label: "mieszkańcy", icon: "person.2")
                stat(value: current?.activeGuests, label: "goście", icon: "person.badge.clock")
                stat(value: current?.pendingVehicles, label: "do akceptacji", icon: "car.badge.gearshape",
                     highlight: (current?.pendingVehicles ?? 0) > 0)
            }

            if let c = current {
                let overdue = c.overdueAmount ?? 0
                let open = c.tickets ?? 0
                HStack(spacing: 10) {
                    summaryPill(
                        icon: overdue > 0 ? "exclamationmark.triangle.fill" : "checkmark.seal.fill",
                        text: overdue > 0
                            ? "Zaległości \(BAFormat.zl(overdue)) · \(c.unitsInArrears ?? 0) lok."
                            : "Płatności na bieżąco",
                        tint: overdue > 0 ? GlassColor.dangerSoft : GlassColor.success
                    )
                    summaryPill(
                        icon: "wrench.and.screwdriver",
                        text: open > 0 ? "\(open) otwartych zgłoszeń" : "Brak otwartych zgłoszeń",
                        tint: open > 0 ? GlassColor.orbAmber1 : .white.opacity(0.7)
                    )
                }
            } else if overview == nil && !loadFailed {
                ProgressView().tint(.white.opacity(0.7)).frame(maxWidth: .infinity)
            }
        }
        .padding(18)
        .glassCard(radius: GlassRadius.primary)
    }

    private func stat(value: Int?, label: String, icon: String, highlight: Bool = false) -> some View {
        VStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(highlight ? GlassColor.orbAmber1 : .white.opacity(0.6))
            Text(value.map(String.init) ?? "–")
                .font(.system(size: 22, weight: .bold))
                .tracking(-0.5)
                .foregroundStyle(highlight ? GlassColor.orbAmber1 : .white)
                .contentTransition(.numericText())
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(.white.opacity(0.55))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
    }

    private func summaryPill(icon: String, text: String, tint: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(tint)
            Text(text)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            Capsule().fill(Color.white.opacity(0.08))
        }
    }

    // MARK: Kafelki

    private var tilesRow1: some View {
        HStack(spacing: 9) {
            GlassTile(
                gradient: [GlassColor.accentBlue, GlassColor.orbViolet],
                icon: "waveform.path.ecg", label: "Zdarzenia",
                iconWeight: .medium,
                badgeCount: recentSituations,
                shimmerDelay: 5
            ) { if let id = buildingId { onOpenSheet(.adminSituations(id)) } }

            GlassTile(
                gradient: [GlassColor.orbAmber1, GlassColor.orbAmber2],
                icon: "wrench.and.screwdriver", label: "Zgłoszenia",
                iconWeight: .medium,
                badgeCount: current?.tickets ?? 0,
                shimmerDelay: 5
            ) { if let id = buildingId { onOpenSheet(.adminTickets(id)) } }

            GlassTile(
                gradient: [GlassColor.dangerSoft, GlassColor.dangerDeep],
                icon: "creditcard", label: "Zaległości",
                iconWeight: .medium,
                showAlertDot: (current?.overdueAmount ?? 0) > 0,
                shimmerDelay: 10
            ) { if let id = buildingId { onOpenSheet(.adminArrears(id)) } }
        }
    }

    private var tilesRow2: some View {
        HStack(spacing: 9) {
            GlassTile(
                gradient: [GlassColor.plateYellow, GlassColor.orbAmber2],
                icon: "car.fill", label: "Tablice",
                shimmerDelay: 10
            ) { if let id = buildingId { onOpenSheet(.adminPlates(id)) } }

            GlassTile(
                gradient: [GlassColor.orbBlue1, GlassColor.orbBlue2],
                icon: "cpu", label: "Urządzenia",
                iconWeight: .medium,
                shimmerDelay: 5
            ) { if let id = buildingId { onOpenSheet(.adminDevices(id)) } }

            GlassTile(
                gradient: [GlassColor.success, GlassColor.accentBlue],
                icon: "book.closed", label: "Kronika",
                iconWeight: .medium,
                shimmerDelay: 5
            ) { if let id = buildingId { onOpenSheet(.adminChronicle(id)) } }
        }
    }

    // MARK: Stopka

    private var footer: some View {
        VStack(spacing: 10) {
            if properties.count > 1 {
                Text("\(properties.count) obiekty · łącznie \(overview?.totals.tickets ?? 0) zgłoszeń, zaległości \(BAFormat.zl(overview?.totals.overdueAmount ?? 0))")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.55))
                    .multilineTextAlignment(.center)
            }
            Text(admin.email)
                .font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.45))
            GlassButton(title: "Wyloguj", style: .ghost) { auth.logout() }
                .frame(width: 180)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 14)
    }

    // MARK: Dane

    private func load() async {
        do {
            let ov: BAOverview = try await APIClient.shared.get("/building-admin/my-buildings-overview")
            overview = ov
            loadFailed = false
            if selectedBuildingId == nil { selectedBuildingId = ov.properties.first?.id }
        } catch {
            loadFailed = overview == nil
        }
    }

    /// Licznik na kafelku Zdarzenia: ile zdarzeń sytuacyjnych w ostatnich 24 h.
    private func loadSituationsBadge() async {
        guard let id = buildingId else { return }
        if let res: BASituationsResponse = try? await APIClient.shared.get(
            "/building-admin/buildings/\(id)/situations?since_hours=24&limit=50"
        ) {
            recentSituations = res.events.count
        }
    }
}
