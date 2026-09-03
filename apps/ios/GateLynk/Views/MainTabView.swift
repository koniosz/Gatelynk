import SwiftUI

struct MainTabView: View {
    @Environment(AuthManager.self) private var auth

    var body: some View {
        switch auth.role {
        case .resident:
            // `.id(residentId)` — po przełączeniu nieruchomości (inny wiersz
            // Resident = inne id) SwiftUI przebudowuje cały tab view i każdy
            // ekran ładuje dane nowego budynku od zera.
            ResidentTabView()
                .id(auth.currentResidentId)
        case .concierge:
            ConciergeTabView()
        case .buildingAdmin:
            BATabView()
        case nil:
            LoginView()
        }
    }
}

// Legacy `GLCard` / `GLStatCard` zostały zastąpione przez `DesignSystem/GLComponents.swift`
// (Glass Premium port — 2026-05-11). `GLStatCard` używany w BA/Concierge tabs
// trzymamy jako helper niżej, bo design system go nie ma (nie był w designie
// resident-side).

struct GLStatCard: View {
    let icon: String
    let value: String
    let label: String
    var body: some View {
        VStack(spacing: 4) {
            Text(icon).font(.title2)
            Text(value).font(.title3).fontWeight(.bold)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Color(.systemBackground))
        .cornerRadius(14)
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }
}

/// Deep-link z pusha `ticket_reply` — Identifiable wrapper na ticketId,
/// żeby `.sheet(item:)` re-prezentował się przy każdym nowym pushu.
private struct PushTicketRoute: Identifiable {
    let id: Int
}

struct ResidentTabView: View {
    @Environment(\.colorScheme) private var scheme
    @State private var openTickets = 0
    /// Push „Odpowiedź na zgłoszenie" → sheet ze zgłoszeniami otwarty od razu
    /// na wątku tego ticketa. Poziom TabView (nie HomeView) — działa
    /// niezależnie od aktywnej zakładki.
    @State private var pushTicketRoute: PushTicketRoute?
    /// Push „Gość wjechał/wyjechał" (2026-08-13) → sheet ze zdjęciem z LPR
    /// i szczegółami gościa. Ten sam wzorzec co pushTicketRoute.
    @State private var guestEventRoute: GuestEventPushRoute?
    /// Push z ogłoszeniem (2026-08-15) → sheet z ogłoszeniami: konkretne
    /// ogłoszenie przy wysyłce imiennej, najnowsze przy broadcaście.
    @State private var announcementRoute: AnnouncementPushRoute?
    @AppStorage("appTheme") private var appTheme = "dark"
    // Observuje wybór koloru — wystarczy deklaracja żeby SwiftUI re-renderował
    // cały tree gdy user zmieni accent w SettingsView. GLColor.accent* czyta
    // z UserDefaults synchronicznie więc będzie miało najnowszą wartość.
    @AppStorage("appAccentColor") private var appAccentColor = "purple"

    // 2026-06-09 (Faza 8.h.18) — restrukturyzacja TabBaru. Goście /
    // Zgłoszenia / Przesyłki są w kafelkach HomeView (LazyVGrid 6 tile),
    // więc tracimy ich dedykowane taby na rzecz:
    //   • Historia zdarzeń (`HistoryView`) — pełen audyt LPR + PIN + remote-open
    //   • Kalendarz (`CalendarView`) — widok tygodnia z planowanymi wydarzeniami
    //   • Inne (`MoreView`) — menu wierszy do pozostałych View
    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("Dom", systemImage: "house.fill") }

            HistoryView()
                .tabItem { Label("Historia", systemImage: "clock.fill") }

            CalendarView()
                .tabItem { Label("Kalendarz", systemImage: "calendar") }

            MoreView()
                .badge(openTickets > 0 ? openTickets : 0)
                .tabItem { Label("Inne", systemImage: "ellipsis.circle.fill") }
        }
        // 2026-06-09 — AppTheme może mieć colorScheme=nil (system) lub
        // explicit dark/light. Default darkClassic → .dark.
        .preferredColorScheme(AppTheme(rawValue: appTheme)?.colorScheme ?? .dark)
        // Accent tint — czyta z user-wybranego AccentTheme (2026-05-22).
        // Domyślnie fioletowy. GLColor.accent300 zwraca odpowiedni hex per
        // colorScheme (dark/light) + per appAccentColor preset.
        .tint(GLColor.accent300(scheme))
        // Deep-link z pusha ticket_reply — sheet na poziomie TabView otwiera
        // TicketsView z wątkiem konkretnego zgłoszenia (initialTicketId).
        .sheet(item: $pushTicketRoute, onDismiss: { Task { await loadBadges() } }) { route in
            TicketsView(initialTicketId: route.id)
        }
        // Ciepły start — apka żyje, user tapnął push. Konsumujemy też pending
        // (AppDelegate ustawia oba), żeby stale route nie odpalił się przy
        // następnym zimnym starcie.
        .onReceive(NotificationCenter.default.publisher(for: .ticketReplyPushTapped)) { note in
            _ = AppDelegate.consumePendingTicketRoute()
            guard let id = note.userInfo?["ticketId"] as? Int else { return }
            pushTicketRoute = PushTicketRoute(id: id)
        }
        // Deep-link z pusha „Gość wjechał/wyjechał" (2026-08-13) — ekran
        // zdarzenia: kadr z LPR + szczegóły gościa (GuestEventView).
        .sheet(item: $guestEventRoute) { route in
            GuestEventView(route: route)
        }
        .onReceive(NotificationCenter.default.publisher(for: .guestEventPushTapped)) { note in
            _ = AppDelegate.consumePendingGuestEventRoute()
            guard let route = note.userInfo?["route"] as? GuestEventPushRoute else { return }
            guestEventRoute = route
        }
        // Deep-link z pusha z ogłoszeniem (2026-08-15) — pełna treść w apce.
        .sheet(item: $announcementRoute) { route in
            AnnouncementsView(
                initialNotificationId: route.notificationId,
                autoOpenNewest: route.notificationId == nil,
            )
        }
        .onReceive(NotificationCenter.default.publisher(for: .announcementPushTapped)) { note in
            _ = AppDelegate.consumePendingAnnouncementRoute()
            guard let route = note.userInfo?["route"] as? AnnouncementPushRoute else { return }
            announcementRoute = route
        }
        .task {
            await loadBadges()
            // Zimny start — push tapnięty zanim UI istniało (didReceive leci
            // tuż po didFinishLaunching). Route czekał w AppDelegate; tu jest
            // konsumowany po zalogowaniu/zbudowaniu tabów.
            if let id = AppDelegate.consumePendingTicketRoute() {
                pushTicketRoute = PushTicketRoute(id: id)
            }
            if let route = AppDelegate.consumePendingGuestEventRoute() {
                guestEventRoute = route
            }
            if let route = AppDelegate.consumePendingAnnouncementRoute() {
                announcementRoute = route
            }
        }
    }

    private func loadBadges() async {
        do {
            let tickets: [Ticket] = try await APIClient.shared.get("/resident/tickets")
            openTickets = tickets.filter { $0.status == "OPEN" }.count
        } catch {}
    }
}
