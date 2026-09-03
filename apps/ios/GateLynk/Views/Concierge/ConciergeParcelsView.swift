import SwiftUI

struct ConciergeParcelsView: View {
    @State private var parcels: [Parcel] = []
    @State private var filter: ParcelFilter = .received
    @State private var loading = true
    @State private var error: String?

    enum ParcelFilter: String, CaseIterable {
        case received = "W depozycie"
        case issued = "Wydane"
        case all = "Wszystkie"
    }

    var filtered: [Parcel] {
        switch filter {
        case .received: return parcels.filter { $0.status == "RECEIVED" }
        case .issued: return parcels.filter { $0.status == "ISSUED" }
        case .all: return parcels
        }
    }

    private static let dateFmt: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .short; f.timeStyle = .short; f.locale = Locale(identifier: "pl_PL"); return f
    }()

    var body: some View {
        NavigationStack {
            Group {
                if loading { ProgressView() }
                else if let error { ContentUnavailableView(error, systemImage: "wifi.exclamationmark") }
                else {
                    VStack(spacing: 0) {
                        Picker("Filtr", selection: $filter) {
                            ForEach(ParcelFilter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .padding()

                        if filtered.isEmpty {
                            ContentUnavailableView("Brak przesyłek", systemImage: "shippingbox")
                        } else {
                            List(filtered) { p in
                                HStack(alignment: .top, spacing: 12) {
                                    Text(p.status == "RECEIVED" ? "📦" : "✅").font(.title2)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(p.trackingNumber)
                                            .font(.system(.body, design: .monospaced))
                                            .fontWeight(.semibold)
                                        Text(p.courier).font(.caption).foregroundStyle(.secondary)
                                        if let unit = p.unit {
                                            Text("Lokal \(unit.number)").font(.caption).foregroundStyle(.blue)
                                        }
                                        Text(Self.dateFmt.string(from: p.receivedAt))
                                            .font(.caption2).foregroundStyle(.tertiary)
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                            .listStyle(.plain)
                        }
                    }
                }
            }
            .navigationTitle("Przesyłki")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true; error = nil
        do { parcels = try await APIClient.shared.get("/concierge/building/parcels") }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}
