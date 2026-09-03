import SwiftUI

struct ConciergeVehiclesView: View {
    @State private var vehicles: [Vehicle] = []
    @State private var search = ""
    @State private var loading = true
    @State private var error: String?

    var filtered: [Vehicle] {
        guard !search.isEmpty else { return vehicles }
        let q = search.lowercased()
        return vehicles.filter {
            $0.licensePlate.lowercased().contains(q) ||
            $0.make.lowercased().contains(q) ||
            ($0.model ?? "").lowercased().contains(q) ||
            $0.color.lowercased().contains(q) ||
            ($0.serviceName ?? "").lowercased().contains(q) ||
            ($0.resident?.fullName ?? "").lowercased().contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading { ProgressView() }
                else if let error { ContentUnavailableView(error, systemImage: "wifi.exclamationmark") }
                else {
                    List(filtered) { v in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(v.licensePlate)
                                    .font(.system(.body, design: .monospaced))
                                    .fontWeight(.bold)
                                Spacer()
                                Text(v.color)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Text(v.displayName).font(.subheadline).foregroundStyle(.secondary)
                            // Pokaż kategorię + nazwę firmy dla pojazdów serwisowych/dostaw,
                            // a dla RESIDENT po prostu imię mieszkańca.
                            if let kind = v.kind, kind != .resident {
                                HStack(spacing: 4) {
                                    Text("\(kind.icon) \(v.serviceName ?? kind.label)")
                                        .font(.caption)
                                        .foregroundStyle(.orange)
                                    if let r = v.resident {
                                        Text("· \(r.fullName)").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            } else if let r = v.resident {
                                Text(r.fullName).font(.caption).foregroundStyle(.blue)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .listStyle(.insetGrouped)
                    .searchable(text: $search, prompt: "Szukaj pojazdu...")
                }
            }
            .navigationTitle("Pojazdy")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true; error = nil
        do { vehicles = try await APIClient.shared.get("/concierge/building/vehicles") }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}
