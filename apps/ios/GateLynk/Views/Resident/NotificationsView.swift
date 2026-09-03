import SwiftUI

struct NotificationsView: View {
    @State private var notifications: [AppNotification] = []
    @State private var loading = true
    @State private var error: String?

    private static let dateFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        f.locale = Locale(identifier: "pl_PL")
        return f
    }()

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView(error, systemImage: "wifi.exclamationmark")
                } else if notifications.isEmpty {
                    ContentUnavailableView("Brak powiadomień", systemImage: "bell.slash.fill")
                } else {
                    List(notifications) { n in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(n.residentId != nil ? "🔔" : "📢")
                                Text(n.title).fontWeight(.semibold)
                                Spacer()
                                if n.residentId != nil {
                                    Text("Osobiste")
                                        .font(.caption2)
                                        .padding(.horizontal, 7).padding(.vertical, 2)
                                        .background(Color.blue.opacity(0.1))
                                        .foregroundStyle(.blue)
                                        .cornerRadius(8)
                                }
                            }
                            Text(n.body)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                            Text(Self.dateFmt.string(from: n.sentAt))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 4)
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Powiadomienia")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true; error = nil
        do { notifications = try await APIClient.shared.get("/resident/notifications") }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}
