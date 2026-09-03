// PaymentsView.swift — pulpit opłat mieszkańca (saldo + naliczenia + archiwum).
//
// 2026-07-04 — redesign na pełny monitoring płatności:
//   • nagłówek salda (kolor: zaległość czerwono),
//   • karta bieżącego miesiąca: kwota, termin, status, PEŁNE rozbicie
//     składowych, pasek postępu „wpłacono X z Y", wpłaty miesiąca,
//   • archiwum miesięcy (GET /resident/payments/charges?months=12) —
//     karty per miesiąc, tap rozwija składowe + wpłaty,
//   • empty-states: (a) configured=false → „zarządca nie skonfigurował",
//     (b) brak naliczenia bieżącego miesiąca → „pojawi się po wygenerowaniu",
//   • historia ledger (dotychczasowa) zostaje jako sekcja — ZAWSZE widoczna.
//
// Fail-silent na starym backendzie: archiwum ładowane przez `try?` — gdy
// endpoint nie istnieje, widok działa jak dotychczas (summary.currentCharge).
//
// Endpointy:
//   GET /api/resident/payments          → PaymentSummary (saldo, ledger, currentCharge)
//   GET /api/resident/payments/charges  → PaymentChargesArchive (configured, charges[])
//
// Typy `PaymentSummary`, `PaymentConfig`, `PaymentEntry`, `CurrentPaymentCharge`,
// `PaymentChargeComponent`, `PaymentChargesArchive`, `ArchivedPaymentCharge`,
// `ChargePaymentItem` zdefiniowane w `Models/Models.swift` — NIE redeklarujemy
// (pułapka #12: redeclaration + ambiguous lookup).

import SwiftUI

struct PaymentsView: View {
    @State private var summary: PaymentSummary?
    @State private var archive: PaymentChargesArchive?
    @State private var loading = true
    @State private var error: String?
    @State private var expandedPeriods: Set<String> = []

    @Environment(\.colorScheme) private var scheme

    // MARK: - Formatters (static — pułapka #17: bez assignments w ViewBuilder)

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

    private static let plnFmt: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "PLN"
        f.locale = Locale(identifier: "pl_PL")
        return f
    }()

    // MARK: - Body

    var body: some View {
        NavigationStack {
            ZStack {
                GLColor.bg1(scheme).ignoresSafeArea()
                Group {
                    if loading {
                        ProgressView("Ładowanie…")
                    } else if let error, summary == nil {
                        ContentUnavailableView(error, systemImage: "wifi.exclamationmark")
                    } else if let summary {
                        content(for: summary)
                    } else {
                        ContentUnavailableView("Brak danych", systemImage: "tray")
                    }
                }
            }
            .navigationTitle("Opłaty")
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(for summary: PaymentSummary) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: GLSpacing.lg) {
                balanceHeader(summary)

                // ── Bieżący miesiąc ────────────────────────────────────────
                GLSectionHeader(title: "Bieżący miesiąc")
                if let archive, !archive.configured {
                    notConfiguredCard
                } else if let current = currentCharge(summary) {
                    currentChargeCard(current)
                } else if let archive, archive.configured {
                    noCurrentChargeCard
                }
                // (archive == nil && brak currentCharge → stary backend bez
                //  danych naliczeń; nie zgadujemy, sekcja tylko z nagłówkiem
                //  salda — ledger poniżej zawsze widoczny)

                // ── Archiwum miesięcy ──────────────────────────────────────
                if !archivedCharges.isEmpty {
                    GLSectionHeader(title: "Archiwum naliczeń")
                    VStack(spacing: GLSpacing.md) {
                        ForEach(archivedCharges) { charge in
                            archiveCard(charge)
                        }
                    }
                }

                // ── Historia ledger (zostaje ZAWSZE) ──────────────────────
                GLSectionHeader(title: "Historia transakcji")
                ledgerCard(summary)
            }
            .padding(.horizontal, GLSpacing.lg)
            .padding(.vertical, GLSpacing.md)
        }
        .refreshable { await load() }
    }

    // MARK: - Nagłówek salda

    @ViewBuilder
    private func balanceHeader(_ summary: PaymentSummary) -> some View {
        GLCard {
            VStack(alignment: .leading, spacing: GLSpacing.sm) {
                HStack {
                    Text("Saldo lokalu")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(GLColor.textSecondary(scheme))
                    Spacer()
                    if let unit = summary.unitNumber {
                        GLPill(text: "Lokal \(unit)", style: .neutral)
                    }
                }
                HStack(alignment: .firstTextBaseline) {
                    Text(formatPLN(summary.balance))
                        .font(.system(size: 32, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(
                            summary.balance < -0.005
                                ? GLColor.danger(scheme)
                                : GLColor.success(scheme),
                        )
                    Spacer()
                    if summary.balance < -0.005 {
                        GLPill(text: "Zaległość", style: .danger, filled: true)
                    }
                }
                if let cfg = summary.config {
                    GLDivider()
                    HStack {
                        Image(systemName: "calendar.badge.clock")
                            .font(.system(size: 12))
                            .foregroundStyle(GLColor.textTertiary(scheme))
                        Text("Termin płatności: do \(cfg.dueDay). dnia miesiąca")
                            .font(.system(size: 12))
                            .foregroundStyle(GLColor.textTertiary(scheme))
                    }
                }
            }
        }
    }

    // MARK: - Karta bieżącego miesiąca

    /// Bieżące naliczenie: preferuj archiwum (ma listę wpłat), fallback do
    /// `summary.currentCharge` (stary backend / archiwum niedostępne).
    private func currentCharge(_ summary: PaymentSummary) -> ArchivedPaymentCharge? {
        let period = Self.currentPeriod()
        if let fromArchive = archive?.charges.first(where: { $0.period == period }) {
            return fromArchive
        }
        guard let c = summary.currentCharge else { return nil }
        return ArchivedPaymentCharge(
            period: c.period,
            totalAmount: c.totalAmount,
            dueDate: c.dueDate,
            status: c.status,
            daysOverdue: c.daysOverdue,
            components: c.components,
            paidAmount: c.paidAmount,
            remainingAmount: max(c.totalAmount - c.paidAmount, 0),
            payments: nil,
        )
    }

    @ViewBuilder
    private func currentChargeCard(_ charge: ArchivedPaymentCharge) -> some View {
        GLCard {
            VStack(alignment: .leading, spacing: GLSpacing.md) {
                // Nagłówek: miesiąc + status
                HStack {
                    Text(Self.monthLabel(charge.period).capitalized)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(GLColor.textPrimary(scheme))
                    Spacer()
                    GLPill(text: charge.statusLabel, style: pillStyle(charge.status))
                }

                // Duża kwota + termin (dni do / po)
                Text(formatPLN(charge.totalAmount))
                    .font(.system(size: 30, weight: .bold))
                    .monospacedDigit()
                    .foregroundStyle(GLColor.textPrimary(scheme))

                HStack(spacing: 6) {
                    Image(systemName: "calendar")
                        .font(.system(size: 12))
                    Text(dueLabel(charge))
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundStyle(
                    charge.status == "OVERDUE"
                        ? GLColor.danger(scheme)
                        : GLColor.textSecondary(scheme),
                )

                // Pasek postępu „wpłacono X z Y"
                if charge.totalAmount > 0 {
                    VStack(alignment: .leading, spacing: 6) {
                        progressBar(paid: charge.paidAmount, total: charge.totalAmount)
                        HStack {
                            Text("Wpłacono \(formatPLN(charge.paidAmount)) z \(formatPLN(charge.totalAmount))")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(GLColor.textSecondary(scheme))
                            Spacer()
                            if let remaining = charge.remainingAmount, remaining > 0.005 {
                                Text("Pozostało \(formatPLN(remaining))")
                                    .font(.system(size: 12, weight: .semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(statusColor(charge.status))
                            }
                        }
                    }
                }

                // Pełne rozbicie składowych
                if let components = charge.components, !components.isEmpty {
                    GLDivider()
                    componentsBreakdown(components, total: charge.totalAmount)
                }

                // Wpłaty tego miesiąca
                if let payments = charge.payments, !payments.isEmpty {
                    GLDivider()
                    paymentsList(payments)
                }
            }
        }
    }

    /// Lista składowych: nazwa → kwota + suma na dole.
    @ViewBuilder
    private func componentsBreakdown(_ components: [PaymentChargeComponent], total: Double) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SKŁADOWE OPŁATY")
                .font(.system(size: 10, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(GLColor.textTertiary(scheme))
            ForEach(Array(components.enumerated()), id: \.offset) { _, comp in
                HStack {
                    Text(comp.name)
                        .font(.system(size: 13))
                        .foregroundStyle(GLColor.textSecondary(scheme))
                    Spacer()
                    Text(formatPLN(comp.amount))
                        .font(.system(size: 13))
                        .monospacedDigit()
                        .foregroundStyle(GLColor.textPrimary(scheme))
                }
            }
            HStack {
                Text("Razem")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(GLColor.textPrimary(scheme))
                Spacer()
                Text(formatPLN(total))
                    .font(.system(size: 13, weight: .semibold))
                    .monospacedDigit()
                    .foregroundStyle(GLColor.textPrimary(scheme))
            }
            .padding(.top, 2)
        }
    }

    /// Wpłaty przypisane do naliczenia (data, źródło, kwota).
    @ViewBuilder
    private func paymentsList(_ payments: [ChargePaymentItem]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("WPŁATY")
                .font(.system(size: 10, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(GLColor.textTertiary(scheme))
            ForEach(payments) { payment in
                HStack(spacing: 8) {
                    Image(systemName: payment.source == "MT940" ? "building.columns" : "person.crop.circle.badge.checkmark")
                        .font(.system(size: 12))
                        .foregroundStyle(GLColor.success(scheme))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(payment.sourceLabel)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(GLColor.textPrimary(scheme))
                        Text(formatDate(payment.date))
                            .font(.system(size: 11))
                            .foregroundStyle(GLColor.textTertiary(scheme))
                    }
                    Spacer()
                    Text("+\(formatPLN(payment.amount))")
                        .font(.system(size: 13, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(GLColor.success(scheme))
                }
            }
        }
    }

    // MARK: - Empty states (kluczowe — patrz zgłoszenie „nic się nie zmieniło")

    /// (a) Zarządca nie skonfigurował jeszcze składowych/naliczeń w budynku.
    @ViewBuilder
    private var notConfiguredCard: some View {
        GLCard {
            HStack(alignment: .top, spacing: GLSpacing.md) {
                GLIconBadge(systemName: "gearshape.2", size: 36, tint: GLColor.info(scheme))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Opłaty nie są jeszcze skonfigurowane")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(GLColor.textPrimary(scheme))
                    Text("Zarządca nie skonfigurował jeszcze opłat w GateLynk. Twoje saldo i historia wpłat są widoczne poniżej.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(GLColor.textSecondary(scheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// (b) Konfiguracja istnieje, ale naliczenie bieżącego miesiąca jeszcze
    /// nie zostało wygenerowane przez zarządcę.
    @ViewBuilder
    private var noCurrentChargeCard: some View {
        GLCard {
            HStack(alignment: .top, spacing: GLSpacing.md) {
                GLIconBadge(systemName: "clock.badge.questionmark", size: 36, tint: GLColor.warning(scheme))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Brak naliczenia za \(Self.monthLabel(Self.currentPeriod(), monthOnly: true))")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(GLColor.textPrimary(scheme))
                    Text("Naliczenie pojawi się po wygenerowaniu przez zarządcę.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(GLColor.textSecondary(scheme))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - Archiwum

    /// Naliczenia archiwalne — wszystko poza bieżącym miesiącem (ten ma
    /// własną dużą kartę wyżej). Backend zwraca DESC po period.
    private var archivedCharges: [ArchivedPaymentCharge] {
        let period = Self.currentPeriod()
        return archive?.charges.filter { $0.period != period } ?? []
    }

    @ViewBuilder
    private func archiveCard(_ charge: ArchivedPaymentCharge) -> some View {
        let expanded = expandedPeriods.contains(charge.period)
        GLCard(padding: 14) {
            VStack(alignment: .leading, spacing: GLSpacing.md) {
                // Nagłówek — tap rozwija szczegóły
                Button {
                    withAnimation(.snappy(duration: 0.22)) {
                        if expanded {
                            expandedPeriods.remove(charge.period)
                        } else {
                            expandedPeriods.insert(charge.period)
                        }
                    }
                } label: {
                    HStack(spacing: GLSpacing.md) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(Self.monthLabel(charge.period).capitalized)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(GLColor.textPrimary(scheme))
                            Text("Termin: \(formatDate(charge.dueDate))")
                                .font(.system(size: 11.5))
                                .foregroundStyle(GLColor.textTertiary(scheme))
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(formatPLN(charge.totalAmount))
                                .font(.system(size: 15, weight: .bold))
                                .monospacedDigit()
                                .foregroundStyle(GLColor.textPrimary(scheme))
                            GLPill(text: charge.statusLabel, style: pillStyle(charge.status))
                        }
                        Image(systemName: "chevron.down")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(GLColor.textTertiary(scheme))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if expanded {
                    if charge.paidAmount > 0 || charge.status != "PAID" {
                        HStack {
                            Text("Wpłacono \(formatPLN(charge.paidAmount)) z \(formatPLN(charge.totalAmount))")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(GLColor.textSecondary(scheme))
                            Spacer()
                            if let remaining = charge.remainingAmount, remaining > 0.005 {
                                Text("Pozostało \(formatPLN(remaining))")
                                    .font(.system(size: 12, weight: .semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(statusColor(charge.status))
                            }
                        }
                    }
                    if let components = charge.components, !components.isEmpty {
                        GLDivider()
                        componentsBreakdown(components, total: charge.totalAmount)
                    }
                    if let payments = charge.payments, !payments.isEmpty {
                        GLDivider()
                        paymentsList(payments)
                    }
                }
            }
        }
    }

    // MARK: - Ledger (dotychczasowa historia — zostaje zawsze)

    @ViewBuilder
    private func ledgerCard(_ summary: PaymentSummary) -> some View {
        GLCard {
            if summary.entries.isEmpty {
                HStack {
                    Spacer()
                    VStack(spacing: 6) {
                        Image(systemName: "list.bullet.rectangle")
                            .font(.system(size: 22))
                            .foregroundStyle(GLColor.textTertiary(scheme))
                        Text("Brak transakcji")
                            .font(.system(size: 13))
                            .foregroundStyle(GLColor.textSecondary(scheme))
                    }
                    Spacer()
                }
                .padding(.vertical, GLSpacing.md)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(summary.entries.enumerated()), id: \.element.id) { index, entry in
                        entryRow(entry)
                        if index < summary.entries.count - 1 {
                            GLDivider()
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func entryRow(_ entry: PaymentEntry) -> some View {
        HStack(alignment: .center, spacing: GLSpacing.md) {
            GLIconBadge(
                systemName: entryIcon(for: entry.type),
                size: 30,
                tint: badgeColor(for: entry.type),
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.description?.isEmpty == false ? entry.description! : entry.typeLabel)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(GLColor.textPrimary(scheme))
                    .lineLimit(1)
                Text(formatDate(entry.date))
                    .font(.system(size: 11))
                    .foregroundStyle(GLColor.textTertiary(scheme))
            }
            Spacer()
            Text(formatPLN(entry.amount))
                .font(.system(size: 13, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(entry.isPositive ? GLColor.success(scheme) : GLColor.danger(scheme))
        }
        .padding(.vertical, 10)
    }

    // MARK: - Pasek postępu

    private func progressBar(paid: Double, total: Double) -> some View {
        let fraction = total > 0 ? min(max(paid / total, 0), 1) : 0
        return GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(GLColor.bg4(scheme))
                Capsule()
                    .fill(fraction >= 0.999 ? GLColor.success(scheme) : GLColor.accent300(scheme))
                    .frame(width: max(geo.size.width * fraction, fraction > 0 ? 8 : 0))
            }
        }
        .frame(height: 8)
    }

    // MARK: - Helpers (poza ViewBuilder — pułapka #17)

    /// "2026-07" → "lipiec 2026" (monthOnly: "lipiec").
    private static func monthLabel(_ period: String, monthOnly: Bool = false) -> String {
        let parts = period.split(separator: "-")
        guard parts.count == 2, let y = Int(parts[0]), let m = Int(parts[1]), (1...12).contains(m) else {
            return period
        }
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        let name = df.standaloneMonthSymbols[m - 1]
        return monthOnly ? name : "\(name) \(y)"
    }

    /// Bieżący okres "YYYY-MM" (UTC — spójnie z backendem).
    private static func currentPeriod() -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC") ?? .current
        let comps = cal.dateComponents([.year, .month], from: Date())
        let y = comps.year ?? 2026
        let m = comps.month ?? 1
        return String(format: "%04d-%02d", y, m)
    }

    private static func parseISO(_ iso: String) -> Date? {
        isoFmt.date(from: iso) ?? isoFmtNoFrac.date(from: iso)
    }

    /// Termin z liczbą dni: "Termin: 10 lip 2026 (za 6 dni)" / "(3 dni po terminie)".
    private func dueLabel(_ charge: ArchivedPaymentCharge) -> String {
        let dateStr = formatDate(charge.dueDate)
        if charge.status == "PAID" { return "Termin: \(dateStr)" }
        if charge.status == "OVERDUE" {
            let days = charge.daysOverdue ?? 0
            return days > 0 ? "Termin: \(dateStr) — \(days) dni po terminie" : "Termin: \(dateStr) — po terminie"
        }
        guard let due = Self.parseISO(charge.dueDate) else { return "Termin: \(dateStr)" }
        let days = Calendar.current.dateComponents([.day], from: Calendar.current.startOfDay(for: Date()), to: Calendar.current.startOfDay(for: due)).day ?? 0
        switch days {
        case ..<0:  return "Termin: \(dateStr) — po terminie"
        case 0:     return "Termin: \(dateStr) — dzisiaj"
        case 1:     return "Termin: \(dateStr) — jutro"
        default:    return "Termin: \(dateStr) — za \(days) dni"
        }
    }

    private func pillStyle(_ status: String) -> GLPill.Style {
        switch status {
        case "PAID":    return .success
        case "PARTIAL": return .warning
        case "UNPAID":  return .info
        case "OVERDUE": return .danger
        default:        return .neutral
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "PAID":    return GLColor.success(scheme)
        case "PARTIAL": return GLColor.warning(scheme)
        case "UNPAID":  return GLColor.info(scheme)
        case "OVERDUE": return GLColor.danger(scheme)
        default:        return GLColor.textSecondary(scheme)
        }
    }

    private func badgeColor(for type: String) -> Color {
        switch type {
        case "PAYMENT":    return GLColor.success(scheme)
        case "CHARGE":     return GLColor.danger(scheme)
        case "CORRECTION": return GLColor.warning(scheme)
        default:           return GLColor.textSecondary(scheme)
        }
    }

    private func entryIcon(for type: String) -> String {
        switch type {
        case "PAYMENT":    return "arrow.down.circle"
        case "CHARGE":     return "doc.text"
        case "CORRECTION": return "arrow.triangle.2.circlepath"
        default:           return "circle"
        }
    }

    private func formatPLN(_ value: Double) -> String {
        Self.plnFmt.string(from: NSNumber(value: value)) ?? "\(value) zł"
    }

    private func formatDate(_ iso: String) -> String {
        if let d = Self.parseISO(iso) {
            return Self.dateFmt.string(from: d)
        }
        // fallback dla "YYYY-MM-DD" bez czasu
        return String(iso.prefix(10))
    }

    // MARK: - Load

    private func load() async {
        if summary == nil { loading = true }
        error = nil
        do {
            summary = try await APIClient.shared.get("/resident/payments")
        } catch {
            self.error = error.localizedDescription
        }
        // Archiwum: fail-silent — starszy backend bez endpointu nie może
        // zepsuć widoku (archive == nil → zachowanie jak dotychczas).
        archive = try? await APIClient.shared.get("/resident/payments/charges?months=12")
        loading = false
    }
}

#Preview {
    PaymentsView()
}
