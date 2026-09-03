import SwiftUI

// MARK: - Sheet „Historia zdarzeń"
//
// Parity z HistoryView głównej apki (MVP: „historia gości w zdarzeniach"):
// feed GET /resident/access-events?limit=200 — wjazdy LPR, PIN-y gości,
// otwarcia zdalne, domofon. Etykiety „Gość: X" przy zdarzeniach z guestId
// (PIN, wjazd autem gościa, otwarcie przez portal). Filtry-chipsy w stylu
// Glass (Wszystkie / LPR / Goście / Zdalne / Domofon). Self-loading z
// pełnymi stanami: loading → error(retry) → empty → lista.

struct GlassHistorySheet: View {
    let onClose: () -> Void

    @State private var events: [AccessEvent] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var filter: String = "ALL"

    private static let chips: [(label: String, value: String)] = [
        ("Wszystkie", "ALL"),
        ("Wjazdy", "LPR_MATCH"),
        ("Goście", "GUESTS"),
        ("Zdalne", "REMOTE_OPEN"),
        ("Domofon", "INTERCOM_CALL"),
    ]

    var body: some View {
        VStack(spacing: 9) {
            GlassSheetHeader(kicker: "Osiedle", title: "Historia zdarzeń", onClose: onClose)

            chipsRow

            if loading {
                GlassSheetLoading()
            } else if let loadError, events.isEmpty {
                errorState(loadError)
            } else if filtered.isEmpty {
                GlassSheetEmptyState(
                    icon: "clock",
                    text: filter == "ALL"
                        ? "Brak zdarzeń — spokojnie na osiedlu."
                        : "Brak zdarzeń dla tego filtra."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 8) {
                        ForEach(filtered.prefix(60)) { ev in
                            row(ev)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .task { await load() }
    }

    // MARK: Filtry

    private var chipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Self.chips, id: \.value) { chip in
                    let selected = filter == chip.value
                    Button {
                        filter = chip.value
                    } label: {
                        Text(chip.label)
                            .font(.system(size: 11.5, weight: selected ? .bold : .medium))
                            .foregroundStyle(selected ? .white : .white.opacity(0.6))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background {
                                if selected {
                                    Capsule().fill(GlassColor.accentGradient)
                                } else {
                                    Capsule().fill(Color.white.opacity(0.08))
                                }
                            }
                            .overlay {
                                if !selected {
                                    Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.bottom, 2)
    }

    private var filtered: [AccessEvent] {
        events.filter { ev in
            if filter == "GUESTS" { return ev.guestId != nil }
            if filter != "ALL" && ev.type != filter { return false }
            return true
        }
    }

    // MARK: Wiersz

    private func row(_ ev: AccessEvent) -> some View {
        GlassActionRow(
            orbGradient: orbGradient(ev),
            orbIcon: ev.icon,
            title: title(ev),
            subtitle: subtitle(ev),
            dimmed: false,
            trailing: {
                if !ev.gateOpened && (ev.type == "PIN_USED" || ev.type == "LPR_NO_MATCH") {
                    Text("Odmowa")
                        .font(.system(size: 10.5, weight: .bold))
                        .foregroundStyle(GlassColor.dangerSoft)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background { Capsule().fill(GlassColor.dangerSoft.opacity(0.15)) }
                } else {
                    EmptyView()
                }
            },
            extra: {
                Text(GlassFormat.relative.localizedString(for: ev.date, relativeTo: Date()))
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.45))
                    .padding(.top, 2)
            }
        )
    }

    /// Tytuł zdarzenia — etykiety „Gość: X" spójne z HistoryView głównej apki.
    private func title(_ ev: AccessEvent) -> String {
        switch ev.type {
        case "LPR_MATCH":
            if let g = ev.guestName { return "Gość: \(g) — wjazd \(ev.plate ?? "")" }
            return "Wjazd: \(ev.plate ?? "—")"
        case "LPR_NO_MATCH":
            if let g = ev.guestName { return "Gość: \(g) — tablica odrzucona" }
            return "Nieznana tablica: \(ev.plate ?? "—")"
        case "PIN_USED":
            return ev.gateOpened ? "Gość: \(ev.guestName ?? "—") — PIN" : "Błędny PIN"
        case "REMOTE_OPEN":
            if let g = ev.guestName { return "Gość — link: \(g)" }
            return ev.openedByName.map { "Otwarcie zdalne — \($0)" } ?? "Otwarcie zdalne"
        case "MANUAL_OPEN":
            return "Otwarcie ręczne"
        case "INTERCOM_CALL":
            return "Wezwanie domofonu"
        default:
            return ev.typeLabel
        }
    }

    private func subtitle(_ ev: AccessEvent) -> String {
        var parts: [String] = []
        if let label = ev.accessPointLabel { parts.append(label) }
        if let resident = ev.residentName, ev.type == "LPR_MATCH", ev.guestName == nil {
            parts.append(resident)
        }
        if let brand = ev.vehicleBrand, ev.type == "LPR_MATCH" { parts.append(brand) }
        if let reason = ev.reason,
           ev.type == "LPR_NO_MATCH" || (ev.type == "PIN_USED" && !ev.gateOpened) {
            parts.append(reason)
        }
        return parts.joined(separator: " · ")
    }

    private func orbGradient(_ ev: AccessEvent) -> [Color] {
        if ev.guestId != nil { return [GlassColor.success, GlassColor.accentBlue] }
        switch ev.type {
        case "LPR_MATCH":     return [GlassColor.accentBlue, GlassColor.orbViolet]
        case "LPR_NO_MATCH":  return [GlassColor.orbAmber1, GlassColor.orbAmber2]
        case "PIN_USED":      return ev.gateOpened
            ? [GlassColor.success, GlassColor.accentBlue]
            : [GlassColor.dangerSoft, GlassColor.dangerDeep]
        case "REMOTE_OPEN":   return [GlassColor.orbBlue1, GlassColor.orbBlue2]
        case "INTERCOM_CALL": return [GlassColor.orbAmber1, GlassColor.orbAmber2]
        default:              return [Color.white.opacity(0.2), Color.white.opacity(0.1)]
        }
    }

    // MARK: Stany

    private func errorState(_ msg: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 30))
                .foregroundStyle(.white.opacity(0.4))
            Text("Nie udało się pobrać historii.\n\(msg)")
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

    // MARK: Load

    private func load() async {
        loading = true
        loadError = nil
        do {
            let resp: AccessEventsResponse = try await APIClient.shared.get(
                "/resident/access-events?limit=200")
            events = resp.events
        } catch {
            loadError = error.localizedDescription
        }
        loading = false
    }
}
