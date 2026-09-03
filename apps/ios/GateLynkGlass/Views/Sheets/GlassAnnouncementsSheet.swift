import SwiftUI

// MARK: - Sheet Ogłoszenia
//
// GET /resident/notifications → [AppNotification]. Wiersze z orbami
// w kolorach cyklicznych (jak prototyp: woda, śmieci, zebranie, nasadzenia).
//
// 2026-07-16: ogłoszenia starsze niż 14 dni przenoszą się automatycznie
// do HISTORII — główna lista pokazuje tylko świeże, przycisk „Historia"
// otwiera starszą listę (podział po sentAt, client-side).

struct GlassAnnouncementsSheet: View {
    /// Deep-link z pusha (2026-08-15): auto-otwarcie pełnej treści tego
    /// ogłoszenia (wysyłka imienna) albo najnowszego (broadcast bez id).
    var initialNotificationId: Int? = nil
    var autoOpenNewest: Bool = false
    let onClose: () -> Void

    @State private var notifications: [AppNotification] = []
    @State private var loading = true
    /// false = bieżące (≤14 dni), true = historia (starsze).
    @State private var showHistory = false
    /// Pełna treść ogłoszenia (2026-08-15) — tap w wiersz podmienia listę
    /// na widok detalu (wcześniej treść była ucięta do 3 linii).
    @State private var detail: AppNotification?

    /// Po tylu dniach ogłoszenie spada z głównej listy do historii.
    private static let historyAfterDays = 14

    private var cutoff: Date {
        Calendar.current.date(byAdding: .day, value: -Self.historyAfterDays, to: Date()) ?? .distantPast
    }
    private var current: [AppNotification] { notifications.filter { $0.sentAt >= cutoff } }
    private var history: [AppNotification] { notifications.filter { $0.sentAt < cutoff } }

    private static let orbPalette: [[Color]] = [
        [GlassColor.orbBlue1, GlassColor.orbBlue2],
        [Color(red: 139/255, green: 154/255, blue: 107/255), Color(red: 90/255, green: 107/255, blue: 69/255)],
        [GlassColor.accentLight, GlassColor.accentBlue],
        [GlassColor.orbAmber1, GlassColor.orbAmber2],
    ]

    var body: some View {
        if let n = detail {
            detailView(n)
        } else {
            listView
        }
    }

    /// Pełna treść ogłoszenia — tytuł, data i CAŁY tekst (przewijalny).
    private func detailView(_ n: AppNotification) -> some View {
        VStack(spacing: 9) {
            GlassSheetHeader(
                kicker: n.residentId != nil ? "Powiadomienie osobiste" : "Ogłoszenie",
                title: n.title,
                onClose: onClose
            )
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(GlassFormat.shortDateTime.string(from: n.sentAt))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.55))
                    Text(n.body)
                        .font(.system(size: 15))
                        .foregroundStyle(.white.opacity(0.92))
                        .lineSpacing(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.top, 2)
            }
            .scrollBounceBehavior(.basedOnSize)
            GlassButton(title: "Wróć do listy", style: .ghost) {
                withAnimation(.easeInOut(duration: 0.2)) { detail = nil }
            }
        }
        .task { await loadIfNeeded() }
    }

    private var listView: some View {
        VStack(spacing: 9) {
            GlassSheetHeader(
                kicker: "Ogłoszenia",
                title: showHistory ? "Historia ogłoszeń" : "Z życia osiedla",
                onClose: onClose
            )

            let visible = showHistory ? history : current

            if loading {
                GlassSheetLoading()
            } else if visible.isEmpty {
                GlassSheetEmptyState(
                    icon: showHistory ? "clock.arrow.circlepath" : "megaphone",
                    text: showHistory
                        ? "Historia jest pusta — nic nie zdążyło się zestarzeć."
                        : "Brak bieżących ogłoszeń — cisza na osiedlu."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(Array(visible.prefix(showHistory ? 50 : 20).enumerated()), id: \.element.id) { idx, n in
                            row(n, index: idx, dimAll: showHistory)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }

            if showHistory {
                GlassButton(title: "Wróć do bieżących", style: .ghost) {
                    withAnimation(.easeInOut(duration: 0.2)) { showHistory = false }
                }
            } else if !history.isEmpty {
                GlassButton(title: "Historia (\(history.count))", style: .ghost) {
                    withAnimation(.easeInOut(duration: 0.2)) { showHistory = true }
                }
            }
        }
        .task { await load() }
    }

    private func row(_ n: AppNotification, index: Int, dimAll: Bool = false) -> some View {
        // Tap = pełna treść (detailView). Wcześniej wiersz był statyczny,
        // a treść ucięta do 3 linii — nie dało się przeczytać całości.
        Button {
            withAnimation(.easeInOut(duration: 0.2)) { detail = n }
        } label: {
            GlassActionRow(
                orbGradient: Self.orbPalette[index % Self.orbPalette.count],
                orbIcon: "megaphone.fill",
                title: n.title,
                subtitle: GlassFormat.relative.localizedString(for: n.sentAt, relativeTo: Date()),
                dimmed: dimAll || index > 4,
                trailing: {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.35))
                },
                extra: {
                    if !n.body.isEmpty {
                        Text(n.body)
                            .font(.system(size: 11.5))
                            .foregroundStyle(.white.opacity(0.7))
                            .lineLimit(3)
                            .padding(.top, 3)
                    }
                }
            )
        }
        .buttonStyle(.plain)
    }

    /// Auto-otwarcie z pusha tylko przy pierwszym załadowaniu.
    @State private var didAutoOpen = false

    private func loadIfNeeded() async {
        if notifications.isEmpty && loading { await load() }
    }

    private func load() async {
        if let n: [AppNotification] = try? await APIClient.shared.get("/resident/notifications") {
            notifications = n
        }
        loading = false

        // Deep-link z pusha: pokaż pełną treść wskazanego ogłoszenia
        // (wysyłka imienna) albo najnowszego (broadcast bez id w payloadzie).
        if !didAutoOpen {
            didAutoOpen = true
            if let target = initialNotificationId,
               let match = notifications.first(where: { $0.id == target }) {
                detail = match
            } else if autoOpenNewest,
                      let newest = notifications.max(by: { $0.sentAt < $1.sentAt }) {
                detail = newest
            }
        }
    }
}
