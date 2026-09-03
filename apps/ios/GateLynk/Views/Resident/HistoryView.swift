import SwiftUI

// MARK: - HistoryView (Faza 8.h.18 — 2026-06-09)
//
// Pełen feed historii zdarzeń osiedla dla mieszkańca:
//   • Wjazdy LPR (rozpoznane / nieznane tablice)
//   • Otwarcia bramy (PIN / remote / manual)
//   • Wezwania domofonu
//
// Endpoint: GET /api/resident/access-events?limit=N — istnieje od fazy 3.
// W tej iteracji prosty paged list (load-more), bez filtrów per-typ — chcemy
// najpierw poznać user feedback co jest najczęściej szukane.

struct HistoryView: View {
    @Environment(\.colorScheme) private var scheme

    @State private var events: [AccessEvent] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var search = ""
    @State private var selectedType: String = "ALL"

    /// Typy do quick-filtra. Wartości wewnętrzne wpasowują się w
    /// `AccessEvent.type` z API. Wyjątek: "GUESTS" to pseudo-filtr
    /// (2026-07-04) — wszystkie zdarzenia z guestId (PIN + LPR autem gościa
    /// + otwarcie przez portal), nie pojedynczy typ.
    private let typeChips: [(label: String, value: String)] = [
        ("Wszystkie", "ALL"),
        ("Wjazd LPR", "LPR_MATCH"),
        ("Goście", "GUESTS"),
        ("Otwarcie zdalne", "REMOTE_OPEN"),
        ("Domofon", "INTERCOM_CALL"),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 8) {
                    if loading && events.isEmpty {
                        ProgressView()
                            .padding(40)
                    } else if let err = loadError, events.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.title2)
                                .foregroundStyle(.secondary)
                            Text(err)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 40)
                    } else if filteredEvents.isEmpty {
                        ContentUnavailableView(
                            "Brak zdarzeń",
                            systemImage: "clock",
                            description: Text("Spróbuj zmienić filtry lub odśwież."),
                        )
                        .padding(.top, 40)
                    } else {
                        ForEach(filteredEvents) { ev in
                            row(ev)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(GLColor.bg1(scheme).ignoresSafeArea())
            .searchable(text: $search, prompt: "Szukaj tablicy, gościa, lokalu")
            .navigationTitle("Historia zdarzeń")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        ForEach(typeChips, id: \.value) { chip in
                            Button {
                                selectedType = chip.value
                            } label: {
                                HStack {
                                    Text(chip.label)
                                    if selectedType == chip.value {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease.circle")
                    }
                }
            }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    // MARK: - Row

    @ViewBuilder
    private func row(_ ev: AccessEvent) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: ev.icon)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(rowTint(ev))
                .frame(width: 36, height: 36)
                .background(rowTint(ev).opacity(0.15))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(rowTitle(ev))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(GLColor.textPrimary(scheme))
                if let subtitle = rowSubtitle(ev) {
                    Text(subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                Text(relativeTime(ev.date))
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            if !ev.gateOpened && (ev.type == "PIN_USED" || ev.type == "LPR_NO_MATCH") {
                GLPill(text: "Odmowa", style: .danger)
            }
        }
        .padding(12)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
        )
    }

    private func rowTitle(_ ev: AccessEvent) -> String {
        switch ev.type {
        case "LPR_MATCH":
            // 2026-07-04 — wjazd LPR autem GOŚCIA ma teraz guestId/guestName
            // z backendu. Wyraźne oznaczenie „Gość: Jan — wjazd WA12345".
            if let g = ev.guestName {
                return "Gość: \(g) — wjazd \(ev.plate ?? "")"
            }
            return "Wjazd: \(ev.plate ?? "—")"
        case "LPR_NO_MATCH":
            if let g = ev.guestName {
                return "Gość: \(g) — tablica odrzucona \(ev.plate ?? "")"
            }
            return "Nieznana tablica: \(ev.plate ?? "—")"
        case "PIN_USED":
            return ev.gateOpened ? "Gość: \(ev.guestName ?? "—") — PIN" : "Błędny PIN"
        case "REMOTE_OPEN":
            // 2026-06-10: REMOTE_OPEN może być:
            //   • przez mieszkańca z app (openedByType=RESIDENT, openedByName)
            //   • przez gościa z portalu/linku (openedByType=SYSTEM, guestName)
            //   • przez BA/admina (openedByType=ADMIN/CONCIERGE, openedByName)
            // Gdy guestName istnieje — gość otworzył przez portal. To ważna
            // info dla mieszkańca ("widzę kto wszedł"), więc preferujemy
            // imię gościa przed generic "Otwarcie zdalne".
            if let g = ev.guestName {
                return "Gość — link: \(g)"
            }
            return ev.openedByName.map { "Otwarcie zdalne — \($0)" } ?? "Otwarcie zdalne"
        case "MANUAL_OPEN":
            return "Otwarcie ręczne"
        case "INTERCOM_CALL":
            return "Wezwanie domofonu"
        default:
            return ev.typeLabel
        }
    }

    private func rowSubtitle(_ ev: AccessEvent) -> String? {
        var parts: [String] = []
        if let label = ev.accessPointLabel { parts.append(label) }
        if let resident = ev.residentName, ev.type == "LPR_MATCH" {
            parts.append(resident)
        }
        if let unit = ev.residentUnitNumber {
            parts.append("lokal \(unit)")
        }
        if let brand = ev.vehicleBrand, ev.type == "LPR_MATCH" {
            parts.append(brand)
        }
        if let reason = ev.reason, ev.type == "LPR_NO_MATCH" || (ev.type == "PIN_USED" && !ev.gateOpened) {
            parts.append(reason)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func rowTint(_ ev: AccessEvent) -> Color {
        switch ev.type {
        case "LPR_MATCH":      return GLColor.success(scheme)
        case "LPR_NO_MATCH":   return GLColor.warning(scheme)
        case "PIN_USED":       return ev.gateOpened ? GLColor.accent300(scheme) : GLColor.danger(scheme)
        case "REMOTE_OPEN":    return GLColor.info(scheme)
        case "INTERCOM_CALL":  return GLColor.iconOrange(scheme)
        default:               return GLColor.textSecondary(scheme)
        }
    }

    private func relativeTime(_ d: Date) -> String {
        let interval = Date().timeIntervalSince(d)
        if interval < 60 { return "teraz" }
        if interval < 3600 { return "\(Int(interval/60)) min temu" }
        if interval < 86400 { return "\(Int(interval/3600))h temu" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        f.dateFormat = "d MMM, HH:mm"
        return f.string(from: d)
    }

    // MARK: - Filtering

    private var filteredEvents: [AccessEvent] {
        events.filter { ev in
            if selectedType == "GUESTS" {
                // Pseudo-filtr „Goście" — dowolny typ, byle z guestId.
                if ev.guestId == nil { return false }
            } else if selectedType != "ALL" && ev.type != selectedType {
                return false
            }
            if !search.isEmpty {
                let q = search.lowercased()
                let hay = [
                    ev.plate,
                    ev.residentName,
                    ev.residentUnitNumber,
                    ev.guestName,
                    ev.accessPointLabel,
                    ev.openedByName,
                    ev.vehicleBrand,
                    ev.vehicleModel,
                ].compactMap { $0?.lowercased() }
                if !hay.contains(where: { $0.contains(q) }) {
                    return false
                }
            }
            return true
        }
    }

    // MARK: - Load

    private func load() async {
        loading = true
        loadError = nil
        do {
            // Endpoint zwraca `AccessEventsResponse` (`{ events: [...] }`).
            // limit=200 wystarcza na podgląd, paginated load-more zostawiamy
            // do następnej iteracji gdy zobaczymy realny ruch w bazie.
            let resp: AccessEventsResponse = try await APIClient.shared.get(
                "/resident/access-events?limit=200",
            )
            self.events = resp.events
        } catch {
            self.loadError = "Nie udało się pobrać historii."
        }
        loading = false
    }
}
