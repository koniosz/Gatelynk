import SwiftUI

struct BAUnitsView: View {
    let buildingId: Int
    @State private var units: [Unit] = []
    @State private var search = ""
    @State private var loading = true
    @State private var error: String?

    var filtered: [Unit] {
        guard !search.isEmpty else { return units }
        let q = search.lowercased()
        return units.filter {
            $0.number.lowercased().contains(q) ||
            ($0.unitType?.name ?? "").lowercased().contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading { ProgressView() }
                else if let error { ContentUnavailableView(error, systemImage: "wifi.exclamationmark") }
                else {
                    List(filtered) { u in
                        HStack(spacing: 12) {
                            Text(u.unitType?.icon ?? "🏠").font(.title3)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(u.unitType?.name ?? "Lokal") \(u.number)").fontWeight(.semibold)
                                if let floor = u.floor {
                                    Text("Piętro \(floor)").font(.caption).foregroundStyle(.secondary)
                                }
                                if let sw = u.stairwell {
                                    Text("Klatka \(sw.name)").font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .listStyle(.insetGrouped)
                    .searchable(text: $search, prompt: "Szukaj lokalu...")
                }
            }
            .navigationTitle("Lokale (\(units.count))")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true; error = nil
        do { units = try await APIClient.shared.get("/building-admin/buildings/\(buildingId)/units") }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}
