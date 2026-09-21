import SwiftUI

// MARK: - Nawigacja Glass: zakładki + komponenty hubów (audyt UX 2026-09-21, §7–8)
//
// Podział ekranów mieszkańca:
//   Dom     — najczęstsze czynności + „Wymaga uwagi"
//   Dostęp  — wejścia, domofon, goście, pojazdy, domownicy, zamki, historia wejść
//   Sprawy  — zgłoszenia, płatności, przesyłki
//   Osiedle — ogłoszenia, kalendarz, asystent
//   Konto   — przez avatar w górnym pasku (GlassMoreSheet)
//
// Huby NIE mają własnych danych: każdy wiersz otwiera ten sam sheet co skrót
// z Domu i push (jedno źródło danych i szczegółów obiektu). Podsumowania
// w wierszach liczone są z tych samych tablic, które zasila `loadAll()`.
//
// Typografia: style Dynamic Type (.subheadline/.footnote/.caption) zamiast
// sztywnych rozmiarów — nowe komponenty skalują się z „Większym tekstem".

enum GlassHomeTab: String, CaseIterable, Identifiable {
    case home, access, matters, estate

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home:    return "Dom"
        case .access:  return "Dostęp"
        case .matters: return "Sprawy"
        case .estate:  return "Osiedle"
        }
    }

    var icon: String {
        switch self {
        case .home:    return "house.fill"
        case .access:  return "key.fill"
        case .matters: return "tray.full.fill"
        case .estate:  return "building.2.fill"
        }
    }
}

// MARK: - Faza przepustki z modelu (JEDNA definicja dla listy i liczników)

extension Guest {
    /// Ta sama klasyfikacja zasila listę „Przepustki gości", licznik na
    /// skrócie i pozycję „wygasa wkrótce" — liczniki nie mogą się rozjechać.
    func passPhase(now: Date = Date()) -> GuestPassPhase {
        let limited = (allowedAccessPoints ?? []).filter { $0.maxUses != nil }
        let hasUnlimited = allowedAccessPoints == nil
            || (allowedAccessPoints ?? []).contains { $0.maxUses == nil }
        return GuestPassPhase.classify(
            status: status.rawValue,
            validFrom: validFrom, validTo: validTo,
            remainingPerLimitedEntrance: limited.map { remainingUses(apId: $0.apId) ?? 0 },
            hasUnlimitedEntrance: hasUnlimited,
            now: now
        )
    }
}

// MARK: - Górny pasek: nieruchomość (lewa) · AI + konto (prawa)

struct GlassTopBar: View {
    let propertyName: String
    let unitLabel: String?
    let initials: String
    let onProperty: () -> Void
    let onAssistant: () -> Void
    let onAccount: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onProperty) {
                HStack(spacing: 8) {
                    Image(systemName: "house.fill")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(GlassColor.accentLight)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(propertyName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        if let unitLabel {
                            Text(unitLabel)
                                .font(.caption)
                                .foregroundStyle(.white.opacity(0.72))
                                .lineLimit(1)
                        }
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white.opacity(0.6))
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background { Capsule().fill(Color.black.opacity(0.28)) }
                .overlay { Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 1) }
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Nieruchomość: \(propertyName)\(unitLabel.map { ", \($0)" } ?? "")")
            .accessibilityHint("Zmień nieruchomość")

            Spacer(minLength: 4)

            Button(action: onAssistant) {
                Image(systemName: "sparkles")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background { Circle().fill(Color.black.opacity(0.28)) }
                    .overlay { Circle().strokeBorder(Color.white.opacity(0.16), lineWidth: 1) }
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Asystent AI")

            Button(action: onAccount) {
                Text(initials.isEmpty ? "?" : initials)
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background { Circle().fill(GlassColor.accentGradient) }
                    .overlay { Circle().strokeBorder(Color.white.opacity(0.3), lineWidth: 1) }
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Konto i ustawienia")
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 8)
        // Spokojne, ciemne tło pod paskiem — tekst nie zależy od zdjęcia (H06).
        .background {
            LinearGradient(
                colors: [GlassColor.scene.opacity(0.85), GlassColor.scene.opacity(0.55), .clear],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
        }
    }
}

// MARK: - Dolny pasek: 4 zakładki (stały, z zarezerwowanym miejscem)

struct GlassTabBar: View {
    @Binding var selection: GlassHomeTab
    /// Zakładki z kropką „coś czeka" — liczone z realnych danych w Home.
    var flagged: Set<GlassHomeTab> = []

    var body: some View {
        HStack(spacing: 2) {
            ForEach(GlassHomeTab.allCases) { tab in
                let active = tab == selection
                Button {
                    selection = tab
                } label: {
                    VStack(spacing: 3) {
                        ZStack(alignment: .topTrailing) {
                            Image(systemName: tab.icon)
                                .font(.system(size: 17, weight: .semibold))
                            if flagged.contains(tab) {
                                Circle()
                                    .fill(GlassColor.orbAmber1)
                                    .frame(width: 8, height: 8)
                                    .offset(x: 6, y: -3)
                            }
                        }
                        Text(tab.title)
                            .font(.caption2.weight(active ? .bold : .medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(active ? .white : .white.opacity(0.62))
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background {
                        if active {
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .fill(
                                    LinearGradient(
                                        colors: [GlassColor.accentLight.opacity(0.34), GlassColor.accentBlue.opacity(0.34)],
                                        startPoint: .topLeading, endPoint: .bottomTrailing
                                    )
                                )
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title + (flagged.contains(tab) ? ", są sprawy wymagające uwagi" : ""))
                .accessibilityAddTraits(active ? [.isSelected] : [])
            }
        }
        .padding(5)
        .background {
            RoundedRectangle(cornerRadius: 23, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: 23, style: .continuous)
                        .fill(Color(red: 18/255, green: 18/255, blue: 28/255).opacity(0.62))
                }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 23, style: .continuous)
                .strokeBorder(Color.white.opacity(0.16), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.45), radius: 16, y: 8)
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 4)
    }
}

// MARK: - Nagłówek zakładki (Dostęp / Sprawy / Osiedle)

struct GlassHubHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.title2.weight(.bold))
                .foregroundStyle(.white)
            Text(subtitle)
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.74))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
        .padding(.top, 6)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Sekcja hubu: kicker + karta z wierszami

struct GlassHubSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .tracking(1.4)
                .foregroundStyle(.white.opacity(0.7))
                .padding(.horizontal, 8)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) { content }
                .hubPanel()
        }
    }
}

extension View {
    /// Spokojny, ciemny panel pod tekst (bez zależności od zdjęcia w tle).
    func hubPanel(radius: CGFloat = 22) -> some View {
        self
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay {
                        RoundedRectangle(cornerRadius: radius, style: .continuous)
                            .fill(GlassColor.scene.opacity(0.5))
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.13), lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

// MARK: - Wiersz hubu

struct GlassHubRow: View {
    let gradient: [Color]
    let icon: String
    let title: String
    /// Podsumowanie z realnych danych; nil = brak danych do pokazania.
    var summary: String? = nil
    /// Kolor podsumowania, gdy niesie stan (np. zaległość) — domyślnie neutralny.
    var summaryTint: Color? = nil
    var badge: Int = 0
    var busy = false
    var showDivider = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    GlassOrb(gradient: gradient, systemName: icon, size: 36, iconSize: 15, iconWeight: .medium)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                        if let summary {
                            Text(summary)
                                .font(.footnote)
                                .foregroundStyle(summaryTint ?? .white.opacity(0.72))
                                .fixedSize(horizontal: false, vertical: true)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    Spacer(minLength: 6)
                    if busy {
                        ProgressView().tint(.white).scaleEffect(0.8)
                    } else if badge > 0 {
                        Text("\(badge)")
                            .font(.caption.weight(.heavy))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .frame(minWidth: 22, minHeight: 22)
                            .background { Capsule().fill(GlassColor.accentGradient) }
                    }
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.4))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(minHeight: 60)

                if showDivider {
                    Rectangle()
                        .fill(Color.white.opacity(0.08))
                        .frame(height: 1)
                        .padding(.leading, 62)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            [title, summary, badge > 0 ? "\(badge)" : nil].compactMap { $0 }.joined(separator: ", ")
        )
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - „Wymaga uwagi"

struct GlassAttentionItem: Identifiable {
    let id: String
    let icon: String
    let tint: Color
    let title: String
    let detail: String
    let action: () -> Void
}

/// Sekcja rozróżnia: ładowanie · pozycje · nie wiadomo (błąd części usług) ·
/// potwierdzony brak spraw. Nigdy „wszystko w porządku" bez kompletu danych.
struct GlassAttentionSection: View {
    let verdict: AttentionVerdict
    let items: [GlassAttentionItem]
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("WYMAGA UWAGI")
                .font(.caption2.weight(.semibold))
                .tracking(1.4)
                .foregroundStyle(.white.opacity(0.7))
                .padding(.horizontal, 8)
                .accessibilityAddTraits(.isHeader)

            VStack(spacing: 0) {
                switch verdict {
                case .loading:
                    statusRow(icon: nil, text: "Sprawdzam, czy coś na Ciebie czeka…", tint: .white.opacity(0.72))
                case .confirmedEmpty:
                    statusRow(
                        icon: "checkmark.circle",
                        text: "Brak spraw wymagających działania",
                        tint: GlassColor.successLight
                    )
                case .unknown:
                    incompleteRow(text: "Nie udało się sprawdzić wszystkich spraw — część usług nie odpowiada.")
                case .items(let incomplete):
                    ForEach(Array(items.enumerated()), id: \.element.id) { idx, item in
                        itemRow(item, showDivider: idx < items.count - 1 || incomplete)
                    }
                    if incomplete {
                        incompleteRow(text: "Lista może być niepełna — część usług nie odpowiada.")
                    }
                }
            }
            .hubPanel()
        }
    }

    private func itemRow(_ item: GlassAttentionItem, showDivider: Bool) -> some View {
        Button(action: item.action) {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Image(systemName: item.icon)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(item.tint)
                        .frame(width: 34, height: 34)
                        .background { Circle().fill(item.tint.opacity(0.16)) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                        Text(item.detail)
                            .font(.footnote)
                            .foregroundStyle(.white.opacity(0.74))
                            .fixedSize(horizontal: false, vertical: true)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 6)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.4))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(minHeight: 60)

                if showDivider {
                    Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1).padding(.leading, 60)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.title). \(item.detail)")
        .accessibilityAddTraits(.isButton)
    }

    private func statusRow(icon: String?, text: String, tint: Color) -> some View {
        HStack(spacing: 10) {
            if let icon {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(tint)
            } else {
                ProgressView().tint(.white).scaleEffect(0.75)
            }
            Text(text)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white.opacity(0.86))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 52)
        .accessibilityElement(children: .combine)
    }

    private func incompleteRow(text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(GlassColor.orbAmber1)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.86))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button(action: onRetry) {
                Text("Odśwież")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .padding(.vertical, 4)
    }
}

// MARK: - Skrót na Domu: ikona + nazwa + podsumowanie z danych

struct GlassShortcutTile: View {
    let gradient: [Color]
    let icon: String
    let title: String
    /// nil = brak danych (np. źródło nie odpowiedziało) — nie pokazujemy zer.
    let summary: String?
    var summaryTint: Color? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                GlassOrb(gradient: gradient, systemName: icon, size: 34, iconSize: 15, iconWeight: .medium)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Text(summary ?? "Otwórz")
                        .font(.caption)
                        .foregroundStyle(summaryTint ?? .white.opacity(0.72))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
            .hubPanel(radius: 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel([title, summary].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Wiersz zamka Nuki (REALNY stan z telemetrii zamka)

struct GlassNukiLockHubRow: View {
    let lock: NukiLockStatus
    var showDivider = true
    let action: () -> Void

    private var state: (text: String, color: Color) {
        switch lock.badge {
        case .secure:     return (lock.effectiveStateLabel ?? "Zamknięty", GlassColor.success)
        case .open:       return (lock.effectiveStateLabel ?? "Otwarty", GlassColor.orbAmber1)
        case .transition: return (lock.effectiveStateLabel ?? "W ruchu", GlassColor.accentBlue)
        case .unknown:    return (lock.effectiveStateLabel ?? "Stan nieznany", Color.white.opacity(0.6))
        case .offline:    return ("Brak połączenia z zamkiem", Color.white.opacity(0.6))
        }
    }

    var body: some View {
        let s = state
        let door = lock.online ? lock.doorLabel : nil
        let battery = lock.batteryCritical == true ? "słaba bateria" : nil
        GlassHubRow(
            gradient: [GlassColor.orbAmber1, GlassColor.orbAmber2],
            icon: "lock.fill",
            title: lock.name,
            summary: [s.text, door, battery].compactMap { $0 }.joined(separator: " · "),
            summaryTint: s.color,
            showDivider: showDivider,
            action: action
        )
    }
}

// MARK: - Przeczytane odpowiedzi w zgłoszeniach (lokalnie, per urządzenie)
//
// API nie ma znacznika „przeczytane", więc pozycja „Nowa odpowiedź" znika
// z Domu po otwarciu wątku: pamiętamy id ostatniej odpowiedzi, którą
// mieszkaniec zobaczył. Klucz po id zgłoszenia — id są globalnie unikalne,
// więc przełączenie nieruchomości niczego nie miesza.

enum GlassTicketSeenStore {
    private static let key = "glass.ticketSeenReply"

    static func seenReplyId(ticketId: Int) -> Int? {
        let map = UserDefaults.standard.dictionary(forKey: key) as? [String: Int]
        return map?[String(ticketId)]
    }

    static func markSeen(_ ticket: Ticket) {
        guard let last = ticket.replies?.last else { return }
        var map = (UserDefaults.standard.dictionary(forKey: key) as? [String: Int]) ?? [:]
        guard (map[String(ticket.id)] ?? 0) < last.id else { return }
        map[String(ticket.id)] = last.id
        UserDefaults.standard.set(map, forKey: key)
    }
}

// MARK: - Polska odmiana liczebników

enum GlassPlural {
    /// 1 paczka · 2 paczki · 5 paczek
    static func pl(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
        if n == 1 { return "\(n) \(one)" }
        let mod10 = n % 10, mod100 = n % 100
        if (2...4).contains(mod10) && !(12...14).contains(mod100) { return "\(n) \(few)" }
        return "\(n) \(many)"
    }
}
