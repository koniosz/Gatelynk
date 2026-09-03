import SwiftUI

// MARK: - AnnouncementsView (2026-06-09)
//
// Połączony widok ogłoszeń + alertów bezpieczeństwa.
// Wcześniej anomaly banner pokazywał się standalone na HomeView; user
// poprosił żeby zintegrować z listą ogłoszeń tak żeby było 1 miejsce
// do sprawdzania komunikatów z osiedla.
//
// Sources:
//   • /resident/notifications  — push history (BA / Cloud broadcasts)
//   • /resident/anomaly-events?since_hours=72 — fall/intrusion detections
//
// Sortowanie: descending po dacie. Anomalie unresolved są wizualnie
// wybijane (czerwony banner badge), resolved są normalnym wpisem.

struct AnnouncementsView: View {
    /// Deep-link z pusha (2026-08-15): id ogłoszenia do automatycznego
    /// otwarcia po załadowaniu (wysyłka imienna niesie id w payloadzie).
    var initialNotificationId: Int? = nil
    /// Broadcast do budynku nie niesie id — otwieramy najnowsze ogłoszenie.
    var autoOpenNewest: Bool = false

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    @State private var notifications: [AppNotification] = []
    @State private var anomalies: [AnomalyEvent] = []
    @State private var loading = true
    @State private var loadError: String?
    @State private var selectedAnomaly: AnomalyEvent?
    @State private var selectedNotification: AppNotification?
    /// Auto-otwarcie tylko raz — pull-to-refresh nie ma ponownie wyskakiwać.
    @State private var didAutoOpen = false

    private static let dateFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        f.locale = Locale(identifier: "pl_PL")
        return f
    }()

    // MARK: - Merged feed

    /// Wspólny typ dla 2 źródeł — anomaly + notification — sortowalny po dacie.
    private enum FeedItem: Identifiable {
        case anomaly(AnomalyEvent)
        case notification(AppNotification)

        var id: String {
            switch self {
            case .anomaly(let a):       return "a-\(a.id)"
            case .notification(let n):  return "n-\(n.id)"
            }
        }

        var date: Date {
            switch self {
            case .anomaly(let a):       return a.tsDate
            case .notification(let n):  return n.sentAt
            }
        }
    }

    private var feed: [FeedItem] {
        let a = anomalies.map(FeedItem.anomaly)
        let n = notifications.map(FeedItem.notification)
        return (a + n).sorted { $0.date > $1.date }
    }

    private var unresolvedCount: Int {
        anomalies.filter { !$0.isResolved && !$0.falsePositive }.count
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            ZStack {
                GLColor.bg1(scheme).ignoresSafeArea()
                content
            }
            .navigationTitle("Ogłoszenia i alerty")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zamknij") { dismiss() }
                }
            }
            .task { await load() }
            .refreshable { await load() }
            .sheet(item: $selectedAnomaly) { ev in
                AnomalyDetailView(event: ev)
            }
            .sheet(item: $selectedNotification) { n in
                notificationDetailSheet(n)
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if loading && feed.isEmpty {
            ProgressView()
        } else if let err = loadError, feed.isEmpty {
            ContentUnavailableView(err, systemImage: "wifi.exclamationmark")
        } else if feed.isEmpty {
            ContentUnavailableView(
                "Brak ogłoszeń",
                systemImage: "bell.slash.fill",
                description: Text("Pojawią się tutaj alerty bezpieczeństwa oraz komunikaty od zarządcy."),
            )
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if unresolvedCount > 0 {
                        unresolvedBanner
                            .padding(.horizontal, 16)
                            .padding(.top, 4)
                    }

                    LazyVStack(spacing: 10) {
                        ForEach(feed) { item in
                            row(for: item)
                                .padding(.horizontal, 16)
                        }
                    }
                    .padding(.bottom, 32)
                }
            }
        }
    }

    private var unresolvedBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.shield.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Color.red.gradient, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(unresolvedCount == 1
                     ? "1 nieobsłużony alert bezpieczeństwa"
                     : "\(unresolvedCount) nieobsłużonych alertów bezpieczeństwa")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                Text("Sprawdź wpisy poniżej, oznacz jako rozwiązane lub zgłoś.")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.85))
            }
            Spacer()
        }
        .padding(12)
        .background(
            LinearGradient(
                colors: [Color.red.opacity(0.95), Color.orange.opacity(0.88)],
                startPoint: .leading, endPoint: .trailing,
            ),
            in: RoundedRectangle(cornerRadius: 14),
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.white.opacity(0.15), lineWidth: 1),
        )
    }

    @ViewBuilder
    private func row(for item: FeedItem) -> some View {
        switch item {
        case .anomaly(let a):
            Button { selectedAnomaly = a } label: {
                anomalyRow(a)
            }
            .buttonStyle(.plain)
        case .notification(let n):
            Button { selectedNotification = n } label: {
                notificationRow(n)
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func anomalyRow(_ a: AnomalyEvent) -> some View {
        let unresolved = !a.isResolved && !a.falsePositive
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(unresolved ? Color.red.opacity(0.20) : GLColor.bg3(scheme))
                Image(systemName: a.typeIcon)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(unresolved ? Color.red : GLColor.textSecondary(scheme))
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(a.typeLabel)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(GLColor.textPrimary(scheme))
                    GLPill(
                        text: unresolved ? "Alert" : (a.falsePositive ? "Fałszywy" : "Rozwiązane"),
                        style: unresolved ? .danger : (a.falsePositive ? .neutral : .success),
                    )
                }
                Text("Wykryto z prawdopodobieństwem \(a.likelihoodPercent)%")
                    .font(.system(size: 12))
                    .foregroundStyle(GLColor.textSecondary(scheme))
                    .lineLimit(2)
                Text(Self.dateFmt.string(from: a.tsDate))
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(
                    unresolved ? Color.red.opacity(0.35) : GLColor.borderSubtle(scheme),
                    lineWidth: 1,
                ),
        )
    }

    @ViewBuilder
    private func notificationRow(_ n: AppNotification) -> some View {
        let isPersonal = n.residentId != nil
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(GLColor.iconOrange(scheme).opacity(0.18))
                Image(systemName: isPersonal ? "person.crop.circle.fill.badge.exclamationmark" : "megaphone.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(GLColor.iconOrange(scheme))
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(n.title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(GLColor.textPrimary(scheme))
                        .lineLimit(1)
                    GLPill(
                        text: isPersonal ? "Osobiste" : "Ogłoszenie",
                        style: isPersonal ? .info : .neutral,
                    )
                }
                Text(n.body)
                    .font(.system(size: 12))
                    .foregroundStyle(GLColor.textSecondary(scheme))
                    .lineLimit(2)
                Text(Self.dateFmt.string(from: n.sentAt))
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
        )
    }

    @ViewBuilder
    private func notificationDetailSheet(_ n: AppNotification) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 8) {
                        Image(systemName: n.residentId != nil ? "person.crop.circle.fill.badge.exclamationmark" : "megaphone.fill")
                            .foregroundStyle(GLColor.iconOrange(scheme))
                        Text(n.residentId != nil ? "Powiadomienie osobiste" : "Ogłoszenie ogólne")
                            .font(.system(size: 11, weight: .semibold))
                            .tracking(1.0)
                            .foregroundStyle(.secondary)
                    }
                    Text(n.title)
                        .font(.system(size: 22, weight: .bold))
                    Text(Self.dateFmt.string(from: n.sentAt))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                    Text(n.body)
                        .font(.system(size: 15))
                        .padding(.top, 6)
                    Spacer(minLength: 40)
                }
                .padding()
            }
            .navigationTitle("Treść ogłoszenia")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zamknij") { selectedNotification = nil }
                }
            }
        }
    }

    // MARK: - Load

    private func load() async {
        loading = true; loadError = nil

        async let notifs: [AppNotification] = (try? APIClient.shared.get("/resident/notifications")) ?? []
        async let anom: AnomalyEventsResponse? = try? APIClient.shared.get("/resident/anomaly-events?since_hours=72&limit=50")

        let n = await notifs
        let a = await anom

        self.notifications = n
        self.anomalies = a?.events ?? []
        self.loading = false

        // Deep-link z pusha: otwórz wskazane ogłoszenie (wysyłka imienna)
        // albo najnowsze (broadcast). Tylko przy pierwszym załadowaniu.
        if !didAutoOpen {
            didAutoOpen = true
            if let target = initialNotificationId,
               let match = n.first(where: { $0.id == target }) {
                selectedNotification = match
            } else if autoOpenNewest,
                      let newest = n.max(by: { $0.sentAt < $1.sentAt }) {
                selectedNotification = newest
            }
        }
    }
}
