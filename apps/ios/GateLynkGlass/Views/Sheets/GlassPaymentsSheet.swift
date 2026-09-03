import SwiftUI

// MARK: - Sheet Płatności — pełny monitoring opłat (parity z PaymentsView)
//
// 2026-07-07 redesign do produkcji:
//   • karta salda (zaległość czerwono / rozliczone zielono),
//   • karta bieżącego miesiąca: kwota, termin (za X dni / po terminie),
//     status, PEŁNE rozbicie składowych, pasek „wpłacono X z Y", wpłaty,
//   • archiwum miesięcy (GET /resident/payments/charges?months=12) —
//     wiersze rozwijane tapnięciem,
//   • empty-states: configured=false → „zarządca nie skonfigurował opłat",
//     brak naliczenia bieżącego miesiąca → „pojawi się po wygenerowaniu",
//   • błąd sieci → komunikat + „Spróbuj ponownie" (bez wiecznego spinnera),
//   • „Zapłać BLIK" — zapowiedź WKRÓTCE (decyzja właściciela).
//
// Sheet jest self-loading: `initialSummary` z GlassHomeView pokazujemy od
// razu, w tle dociągamy świeże summary + archiwum.

struct GlassPaymentsSheet: View {
    let initialSummary: PaymentSummary?
    let onComingSoon: (GlassUpcomingFeature) -> Void
    let onClose: () -> Void

    @State private var summary: PaymentSummary?
    @State private var archive: PaymentChargesArchive?
    @State private var loading = false
    @State private var loadError: String?
    @State private var expandedPeriods: Set<String> = []
    @State private var didLoad = false
    @State private var showAllEntries = false

    var body: some View {
        VStack(spacing: 9) {
            GlassSheetHeader(kicker: "Płatności", title: "Czynsz", onClose: onClose)

            if let summary {
                content(summary)
            } else if loading || !didLoad {
                GlassSheetLoading()
            } else if let loadError {
                errorState(loadError)
            } else {
                GlassSheetEmptyState(
                    icon: "creditcard",
                    text: "Brak danych płatności\ndla Twojego lokalu."
                )
            }
        }
        .task {
            summary = initialSummary
            await load()
        }
    }

    // MARK: Treść

    @ViewBuilder
    private func content(_ s: PaymentSummary) -> some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 9) {
                balanceCard(s)

                // ── Bieżący miesiąc ───────────────────────────────────
                if let archive, !archive.configured {
                    notConfiguredCard
                } else if let current = currentCharge(s) {
                    sectionHeader("BIEŻĄCY MIESIĄC")
                    chargeCard(current, isCurrent: true, expanded: true)
                } else if let archive, archive.configured {
                    noCurrentChargeCard
                }

                // ── Archiwum ──────────────────────────────────────────
                if !archivedCharges.isEmpty {
                    sectionHeader("ARCHIWUM NALICZEŃ")
                    ForEach(archivedCharges) { charge in
                        chargeCard(
                            charge,
                            isCurrent: false,
                            expanded: expandedPeriods.contains(charge.period)
                        )
                    }
                }

                // ── Historia płatności (ledger; backend zwraca do 200) ─
                if !s.entries.isEmpty {
                    sectionHeader("HISTORIA PŁATNOŚCI")
                    ForEach(showAllEntries ? s.entries : Array(s.entries.prefix(10))) { e in
                        entryRow(e)
                    }
                    if s.entries.count > 10 {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { showAllEntries.toggle() }
                        } label: {
                            Text(showAllEntries
                                 ? "Zwiń historię"
                                 : "Pokaż pełną historię (\(s.entries.count))")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.85))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 11)
                                .background {
                                    RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                                        .fill(Color.white.opacity(0.08))
                                }
                                .overlay {
                                    RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                                }
                        }
                        .buttonStyle(.plain)
                    }
                }

                blikButton
                    .padding(.top, 8)
            }
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10.5, weight: .semibold))
            .tracking(1.5)
            .foregroundStyle(.white.opacity(0.55))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
    }

    // MARK: Karta salda

    private func balanceCard(_ s: PaymentSummary) -> some View {
        let overdue = s.balance < -0.005
        // Wyeksponowana informacja „po terminie": bieżące naliczenie ze
        // statusem OVERDUE = mieszkaniec przekroczył wymagalność. Kwota
        // pozostała do zapłaty + liczba dni po terminie.
        let pastDue = currentCharge(s).flatMap { c -> (days: Int, amount: Double)? in
            guard c.status == "OVERDUE" else { return nil }
            return (c.daysOverdue ?? 0, c.remainingAmount ?? max(c.totalAmount - (c.paidAmount ?? 0), 0))
        }
        return VStack(spacing: 6) {
            Text(overdue ? "ZALEGŁOŚĆ" : "SALDO ROZLICZONE")
                .font(.system(size: 11, weight: .bold))
                .tracking(1.6)
                .foregroundStyle(overdue ? Color(red: 1, green: 154/255, blue: 165/255) : GlassColor.successLight)

            Text(GlassFormat.zl(abs(s.balance)))
                .font(.system(size: 36, weight: .heavy))
                .tracking(-1.1)
                .foregroundStyle(.white)

            if let pastDue {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 11, weight: .bold))
                    Text(pastDue.days > 0
                         ? "Po terminie od \(pastDue.days) dni · \(GlassFormat.zl(pastDue.amount)) do zapłaty"
                         : "Po terminie · \(GlassFormat.zl(pastDue.amount)) do zapłaty")
                        .font(.system(size: 12, weight: .bold))
                }
                .foregroundStyle(Color(red: 1, green: 154/255, blue: 165/255))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background { Capsule().fill(GlassColor.dangerSoft.opacity(0.18)) }
            }

            if let unit = s.unitNumber {
                Text("Lokal \(unit)" + (s.config.map { " · termin do \($0.dueDay). dnia mies." } ?? ""))
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(18)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill((overdue ? GlassColor.dangerSoft : GlassColor.success).opacity(0.12))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .strokeBorder((overdue ? GlassColor.dangerSoft : GlassColor.success).opacity(0.35), lineWidth: 1)
        }
    }

    // MARK: Karta naliczenia (bieżące — zawsze rozwinięte; archiwum — tap)

    @ViewBuilder
    private func chargeCard(_ charge: ArchivedPaymentCharge, isCurrent: Bool, expanded: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            // Nagłówek (archiwum: tap rozwija)
            Button {
                guard !isCurrent else { return }
                withAnimation(.snappy(duration: 0.22)) {
                    if expanded {
                        expandedPeriods.remove(charge.period)
                    } else {
                        expandedPeriods.insert(charge.period)
                    }
                }
            } label: {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Self.monthLabel(charge.period).capitalized)
                            .font(.system(size: 14.5, weight: .bold))
                            .foregroundStyle(.white)
                        Text(dueLabel(charge))
                            .font(.system(size: 11))
                            .foregroundStyle(
                                charge.status == "OVERDUE"
                                    ? GlassColor.dangerSoft
                                    : .white.opacity(0.55)
                            )
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(GlassFormat.zl(charge.totalAmount))
                            .font(.system(size: 15, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(.white)
                        statusPill(charge)
                    }
                    if !isCurrent {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.5))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(isCurrent)

            if expanded {
                // Pasek postępu „wpłacono X z Y"
                if charge.totalAmount > 0 {
                    VStack(alignment: .leading, spacing: 5) {
                        progressBar(paid: charge.paidAmount, total: charge.totalAmount)
                        HStack {
                            Text("Wpłacono \(GlassFormat.zl(charge.paidAmount)) z \(GlassFormat.zl(charge.totalAmount))")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.white.opacity(0.6))
                            Spacer()
                            if let remaining = charge.remainingAmount, remaining > 0.005 {
                                Text("Pozostało \(GlassFormat.zl(remaining))")
                                    .font(.system(size: 11, weight: .bold))
                                    .monospacedDigit()
                                    .foregroundStyle(statusColor(charge.status))
                            }
                        }
                    }
                }

                // Składowe naliczenia — donut + legenda z kwotami (legenda
                // zastępuje dawną listę; „Razem" siedzi w środku wykresu).
                if let components = charge.components, !components.isEmpty {
                    divider
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Z CZEGO SKŁADA SIĘ CZYNSZ")
                            .font(.system(size: 9.5, weight: .semibold))
                            .tracking(1.2)
                            .foregroundStyle(.white.opacity(0.45))
                        GlassRentDonutCard(
                            components: components,
                            total: charge.totalAmount,
                            embedded: true
                        )
                    }
                }

                // Wpłaty miesiąca
                if let payments = charge.payments, !payments.isEmpty {
                    divider
                    VStack(alignment: .leading, spacing: 5) {
                        Text("WPŁATY")
                            .font(.system(size: 9.5, weight: .semibold))
                            .tracking(1.2)
                            .foregroundStyle(.white.opacity(0.45))
                        ForEach(payments) { payment in
                            HStack(spacing: 7) {
                                Image(systemName: payment.source == "MT940" ? "building.columns" : "person.crop.circle.badge.checkmark")
                                    .font(.system(size: 11))
                                    .foregroundStyle(GlassColor.successLight)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(payment.sourceLabel)
                                        .font(.system(size: 11.5, weight: .medium))
                                        .foregroundStyle(.white.opacity(0.85))
                                    Text(Self.formatDate(payment.date))
                                        .font(.system(size: 10))
                                        .foregroundStyle(.white.opacity(0.45))
                                }
                                Spacer()
                                Text("+\(GlassFormat.zl(payment.amount))")
                                    .font(.system(size: 12, weight: .bold))
                                    .monospacedDigit()
                                    .foregroundStyle(GlassColor.successLight)
                            }
                        }
                    }
                }
            }
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.08))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
    }

    private var divider: some View {
        Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1)
    }

    private func statusPill(_ charge: ArchivedPaymentCharge) -> some View {
        Text(charge.statusLabel)
            .font(.system(size: 9.5, weight: .heavy))
            .tracking(0.6)
            .foregroundStyle(statusColor(charge.status))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background { Capsule().fill(statusColor(charge.status).opacity(0.15)) }
    }

    private func progressBar(paid: Double, total: Double) -> some View {
        let fraction = total > 0 ? min(max(paid / total, 0), 1) : 0
        return GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.10))
                Capsule()
                    .fill(fraction >= 0.999 ? GlassColor.success : GlassColor.accentBlue)
                    .frame(width: max(geo.size.width * fraction, fraction > 0 ? 8 : 0))
            }
        }
        .frame(height: 7)
    }

    // MARK: Empty-states naliczeń

    private var notConfiguredCard: some View {
        infoCard(
            icon: "gearshape.2",
            title: "Opłaty nie są jeszcze skonfigurowane",
            text: "Zarządca nie skonfigurował jeszcze opłat w GateLynk. Twoje saldo i historia wpłat są widoczne poniżej."
        )
    }

    private var noCurrentChargeCard: some View {
        infoCard(
            icon: "clock.badge.questionmark",
            title: "Brak naliczenia za ten miesiąc",
            text: "Naliczenie pojawi się po wygenerowaniu przez zarządcę."
        )
    }

    private func infoCard(icon: String, title: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            GlassOrb(gradient: [GlassColor.orbBlue1, GlassColor.orbBlue2], systemName: icon, size: 38, iconSize: 16)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(.white)
                Text(text)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.06))
        }
    }

    // MARK: Ledger

    private func entryRow(_ e: PaymentEntry) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(e.description?.isEmpty == false ? e.description! : e.typeLabel)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(1)
                Text(Self.formatDate(e.date))
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.5))
            }
            Spacer()
            Text((e.amount >= 0 ? "+" : "") + GlassFormat.zl(e.amount))
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(e.amount >= 0 ? GlassColor.successLight : .white.opacity(0.85))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.06))
        }
    }

    // MARK: BLIK — zapowiedź (decyzja właściciela: widoczna atrapa WKRÓTCE)

    private var blikButton: some View {
        Button {
            onComingSoon(.blik)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "wave.3.right.circle.fill")
                    .font(.system(size: 16, weight: .semibold))
                Text("Zapłać BLIK")
                    .font(.system(size: 15, weight: .bold))
                GlassSoonBadge()
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(GlassColor.accentGradient)
                    .opacity(0.55)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.2), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: Stan błędu

    private func errorState(_ msg: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 30))
                .foregroundStyle(.white.opacity(0.4))
            Text("Nie udało się pobrać płatności.\n\(msg)")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.6))
                .multilineTextAlignment(.center)
            GlassButton(title: "Spróbuj ponownie", style: .ghost) {
                Task { await load() }
            }
            .frame(width: 200)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }

    // MARK: Dane pomocnicze

    /// Bieżące naliczenie: preferuj archiwum (ma listę wpłat), fallback do
    /// `summary.currentCharge` — identycznie jak PaymentsView głównej apki.
    private func currentCharge(_ s: PaymentSummary) -> ArchivedPaymentCharge? {
        let period = Self.currentPeriod()
        if let fromArchive = archive?.charges.first(where: { $0.period == period }) {
            return fromArchive
        }
        guard let c = s.currentCharge else { return nil }
        return ArchivedPaymentCharge(
            period: c.period,
            totalAmount: c.totalAmount,
            dueDate: c.dueDate,
            status: c.status,
            daysOverdue: c.daysOverdue,
            components: c.components,
            paidAmount: c.paidAmount,
            remainingAmount: max(c.totalAmount - c.paidAmount, 0),
            payments: nil
        )
    }

    private var archivedCharges: [ArchivedPaymentCharge] {
        let period = Self.currentPeriod()
        return archive?.charges.filter { $0.period != period } ?? []
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "PAID":    return GlassColor.successLight
        case "PARTIAL": return GlassColor.orbAmber1
        case "UNPAID":  return GlassColor.accentLight
        case "OVERDUE": return GlassColor.dangerSoft
        default:        return .white.opacity(0.6)
        }
    }

    private func dueLabel(_ charge: ArchivedPaymentCharge) -> String {
        let dateStr = Self.formatDate(charge.dueDate)
        if charge.status == "PAID" { return "Termin: \(dateStr)" }
        if charge.status == "OVERDUE" {
            let days = charge.daysOverdue ?? 0
            return days > 0 ? "Termin: \(dateStr) — \(days) dni po terminie" : "Termin: \(dateStr) — po terminie"
        }
        guard let due = Self.parseISO(charge.dueDate) else { return "Termin: \(dateStr)" }
        let days = Calendar.current.dateComponents(
            [.day],
            from: Calendar.current.startOfDay(for: Date()),
            to: Calendar.current.startOfDay(for: due)
        ).day ?? 0
        switch days {
        case ..<0:  return "Termin: \(dateStr) — po terminie"
        case 0:     return "Termin: \(dateStr) — dzisiaj"
        case 1:     return "Termin: \(dateStr) — jutro"
        default:    return "Termin: \(dateStr) — za \(days) dni"
        }
    }

    // MARK: Formattery / parsery (static — poza ViewBuilder)

    private static let isoFmt: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoFmtNoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let dateFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        f.locale = Locale(identifier: "pl_PL")
        return f
    }()

    private static func parseISO(_ iso: String) -> Date? {
        isoFmt.date(from: iso) ?? isoFmtNoFrac.date(from: iso)
    }

    static func formatDate(_ iso: String) -> String {
        if let d = parseISO(iso) { return dateFmt.string(from: d) }
        return String(iso.prefix(10))
    }

    /// "2026-07" → "lipiec 2026".
    private static func monthLabel(_ period: String) -> String {
        let parts = period.split(separator: "-")
        guard parts.count == 2, let y = Int(parts[0]), let m = Int(parts[1]), (1...12).contains(m) else {
            return period
        }
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        return "\(df.standaloneMonthSymbols[m - 1]) \(y)"
    }

    /// Bieżący okres "YYYY-MM" (UTC — spójnie z backendem).
    private static func currentPeriod() -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC") ?? .current
        let comps = cal.dateComponents([.year, .month], from: Date())
        return String(format: "%04d-%02d", comps.year ?? 2026, comps.month ?? 1)
    }

    // MARK: Load

    private func load() async {
        loading = true
        loadError = nil
        do {
            summary = try await APIClient.shared.get("/resident/payments")
        } catch {
            // Zostaw initialSummary jeśli był — świeży błąd nie kasuje danych.
            if summary == nil { loadError = error.localizedDescription }
        }
        // Archiwum fail-silent (starszy backend bez endpointu nie psuje widoku).
        archive = try? await APIClient.shared.get("/resident/payments/charges?months=12")
        loading = false
        didLoad = true
    }
}

// MARK: - Wykres kołowy składowych czynszu

/// Donut składowych bieżącego naliczenia + legenda z kwotami i procentami.
/// Paleta = kroki dark-mode z systemu dataviz panelu (te same odcienie co
/// wykres w panelu administratora — spójny mentalny model dla mieszkańca
/// i zarządcy). Kwoty w legendzie niosą odczyt niezależnie od koloru.
struct GlassRentDonutCard: View {
    let components: [PaymentChargeComponent]
    let total: Double
    /// true = bez własnego tła/ramki (osadzony wewnątrz karty naliczenia).
    var embedded: Bool = false

    private static let palette: [Color] = [
        Color(red: 57/255,  green: 135/255, blue: 229/255), // blue
        Color(red: 0,       green: 131/255, blue: 0),       // green
        Color(red: 213/255, green: 81/255,  blue: 129/255), // magenta
        Color(red: 201/255, green: 133/255, blue: 0),       // yellow
        Color(red: 25/255,  green: 158/255, blue: 112/255), // aqua
        Color(red: 217/255, green: 89/255,  blue: 38/255),  // orange
    ]

    private struct Segment: Identifiable {
        let id: Int
        let name: String
        let amount: Double
        let start: Double // 0..1
        let end: Double   // 0..1
        let color: Color
    }

    private var segments: [Segment] {
        let sorted = components.sorted { $0.amount > $1.amount }
        let sum = sorted.reduce(0) { $0 + $1.amount }
        guard sum > 0 else { return [] }
        var acc = 0.0
        return sorted.enumerated().map { idx, comp in
            let start = acc
            acc += comp.amount / sum
            return Segment(
                id: idx,
                name: comp.name,
                amount: comp.amount,
                start: start,
                end: acc,
                color: Self.palette[idx % Self.palette.count]
            )
        }
    }

    var body: some View {
        let segs = segments
        HStack(spacing: 16) {
            ZStack {
                ForEach(segs) { seg in
                    // 0.006 luzu po obu stronach = przerwa między wycinkami
                    // (spacer rule — segmenty nie zlewają się na ciemnym tle).
                    Circle()
                        .trim(from: seg.start + 0.006, to: max(seg.start + 0.006, seg.end - 0.006))
                        .stroke(seg.color, style: StrokeStyle(lineWidth: 22, lineCap: .butt))
                        .rotationEffect(.degrees(-90))
                }
                VStack(spacing: 1) {
                    Text(GlassFormat.zl(total))
                        .font(.system(size: 14, weight: .heavy))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                    Text("/ mies.")
                        .font(.system(size: 9.5))
                        .foregroundStyle(.white.opacity(0.5))
                }
                .padding(.horizontal, 26)
            }
            .frame(width: 118, height: 118)

            VStack(alignment: .leading, spacing: 7) {
                ForEach(segs) { seg in
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(seg.color)
                            .frame(width: 11, height: 11)
                        Text(seg.name)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.white.opacity(0.85))
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text(GlassFormat.zl(seg.amount))
                            .font(.system(size: 11.5, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(.white.opacity(0.9))
                        Text("\(Int(((seg.end - seg.start) * 100).rounded()))%")
                            .font(.system(size: 10.5))
                            .monospacedDigit()
                            .foregroundStyle(.white.opacity(0.5))
                            .frame(width: 32, alignment: .trailing)
                    }
                }
            }
        }
        .padding(embedded ? 0 : 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            if !embedded {
                RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                    .fill(Color.white.opacity(0.08))
            }
        }
        .overlay {
            if !embedded {
                RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
            }
        }
    }
}
