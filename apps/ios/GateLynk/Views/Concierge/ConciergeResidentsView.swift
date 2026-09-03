import SwiftUI

struct ConciergeResidentsView: View {
    @State private var residents: [Resident] = []
    @State private var search = ""
    @State private var loading = true
    @State private var error: String?

    var filtered: [Resident] {
        guard !search.isEmpty else { return residents }
        let q = search.lowercased()
        return residents.filter {
            $0.fullName.lowercased().contains(q) ||
            $0.email.lowercased().contains(q) ||
            ($0.phone ?? "").contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading { ProgressView() }
                else if let error { ContentUnavailableView(error, systemImage: "wifi.exclamationmark") }
                else {
                    List(filtered) { r in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(r.fullName).fontWeight(.semibold)
                            Text(r.email).font(.caption).foregroundStyle(.secondary)
                            if let phone = r.phone {
                                Text(phone).font(.caption).foregroundStyle(.secondary)
                            }
                            let activeUnits = r.unitResidents?.filter { $0.untilDate == nil } ?? []
                            if !activeUnits.isEmpty {
                                HStack(spacing: 6) {
                                    ForEach(activeUnits) { ur in
                                        if let u = ur.unit {
                                            Text("\(u.unitType?.icon ?? "🏠") \(u.number)")
                                                .font(.caption2)
                                                .padding(.horizontal, 6).padding(.vertical, 2)
                                                .background(Color.blue.opacity(0.1))
                                                .foregroundStyle(.blue)
                                                .cornerRadius(8)
                                        }
                                    }
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .listStyle(.insetGrouped)
                    .searchable(text: $search, prompt: "Szukaj mieszkańca...")
                }
            }
            .navigationTitle("Mieszkańcy")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true; error = nil
        do { residents = try await APIClient.shared.get("/concierge/building/residents") }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}
