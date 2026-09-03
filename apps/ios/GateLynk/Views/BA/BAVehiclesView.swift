import SwiftUI

struct BAVehiclesView: View {
    let buildingId: Int
    @State private var vehicles: [Vehicle] = []
    @State private var search = ""
    @State private var loading = true
    @State private var error: String?
    @State private var rejectingVehicle: Vehicle?
    @State private var rejectionReason: String = ""
    @State private var actionInFlight = false
    @State private var actionError: String?

    var filtered: [Vehicle] {
        let base: [Vehicle]
        if search.isEmpty {
            base = vehicles
        } else {
            let q = search.lowercased()
            base = vehicles.filter {
                $0.licensePlate.lowercased().contains(q) ||
                $0.make.lowercased().contains(q) ||
                ($0.model ?? "").lowercased().contains(q) ||
                $0.color.lowercased().contains(q) ||
                ($0.serviceName ?? "").lowercased().contains(q) ||
                ($0.resident?.fullName ?? "").lowercased().contains(q)
            }
        }
        // PENDING zawsze na górze — admin widzi do zatwierdzenia bez scrollowania.
        return base.sorted { lhs, rhs in
            sortRank(lhs.effectiveStatus) < sortRank(rhs.effectiveStatus)
        }
    }

    private func sortRank(_ s: VehicleStatus) -> Int {
        switch s {
        case .pending:  return 0
        case .blocked:  return 1
        case .approved: return 2
        case .rejected: return 3
        case .expired:  return 4
        }
    }

    var pendingCount: Int { vehicles.filter { $0.effectiveStatus == .pending }.count }

    var body: some View {
        NavigationStack {
            Group {
                if loading { ProgressView() }
                else if let error { ContentUnavailableView(error, systemImage: "wifi.exclamationmark") }
                else {
                    List {
                        // Banner „X do zatwierdzenia" zawsze gdy są jakieś PENDING.
                        if pendingCount > 0 {
                            Section {
                                HStack {
                                    Image(systemName: "exclamationmark.circle.fill")
                                        .foregroundStyle(.orange)
                                    Text("\(pendingCount) \(pendingCount == 1 ? "pojazd oczekuje" : "pojazdów oczekuje") na zatwierdzenie")
                                        .font(.subheadline.weight(.semibold))
                                }
                            }
                        }
                        ForEach(filtered) { v in
                            vehicleRow(v)
                        }
                    }
                    .listStyle(.insetGrouped)
                    .searchable(text: $search, prompt: "Szukaj pojazdu...")
                }
            }
            .navigationTitle("Pojazdy (\(vehicles.count))")
            .task { await load() }
            .refreshable { await load() }
            .sheet(item: $rejectingVehicle) { v in
                rejectSheet(v)
            }
            .alert("Błąd", isPresented: .constant(actionError != nil)) {
                Button("OK", role: .cancel) { actionError = nil }
            } message: {
                Text(actionError ?? "")
            }
        }
    }

    // MARK: – Wiersz pojazdu

    @ViewBuilder
    private func vehicleRow(_ v: Vehicle) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(v.licensePlate)
                    .font(.system(.body, design: .monospaced))
                    .fontWeight(.bold)
                Spacer()
                statusBadge(v.effectiveStatus)
            }
            HStack {
                Text(v.displayName).font(.subheadline)
                Text("·").foregroundStyle(.secondary)
                Text(v.color).font(.caption).foregroundStyle(.secondary)
            }
            // Kategoria + serviceName / mieszkaniec — bez zmian z poprzedniej wersji.
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
            // Powód odrzucenia (jeśli REJECTED).
            if v.effectiveStatus == .rejected, let reason = v.rejectionReason, !reason.isEmpty {
                Text("Powód: \(reason)")
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
            // Akcje admina — zależnie od bieżącego statusu.
            actionButtons(for: v)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func actionButtons(for v: Vehicle) -> some View {
        switch v.effectiveStatus {
        case .pending:
            HStack(spacing: 8) {
                Button {
                    Task { await act(v, .approve) }
                } label: {
                    Label("Zatwierdź", systemImage: "checkmark.circle.fill")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                .disabled(actionInFlight)

                Button(role: .destructive) {
                    rejectionReason = ""
                    rejectingVehicle = v
                } label: {
                    Label("Odrzuć", systemImage: "xmark.circle.fill")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .disabled(actionInFlight)
            }
        case .approved:
            Button {
                Task { await act(v, .block) }
            } label: {
                Label("Zablokuj", systemImage: "lock.fill")
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .tint(.gray)
            .disabled(actionInFlight)
        case .blocked:
            Button {
                Task { await act(v, .unblock) }
            } label: {
                Label("Odblokuj", systemImage: "lock.open.fill")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
            .disabled(actionInFlight)
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private func rejectSheet(_ v: Vehicle) -> some View {
        NavigationStack {
            Form {
                Section("Pojazd") {
                    Text(v.licensePlate)
                        .font(.system(.body, design: .monospaced))
                    Text(v.displayName).font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    TextField("Powód odmowy (widoczny dla mieszkańca)", text: $rejectionReason, axis: .vertical)
                        .lineLimit(3...6)
                } header: {
                    Text("Powód")
                } footer: {
                    Text("Mieszkaniec zobaczy ten tekst w aplikacji.")
                }
            }
            .navigationTitle("Odrzuć pojazd")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { rejectingVehicle = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Odrzuć", role: .destructive) {
                        Task {
                            let trimmed = rejectionReason.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !trimmed.isEmpty {
                                await act(v, .reject, reason: trimmed)
                                rejectingVehicle = nil
                            }
                        }
                    }
                    .disabled(rejectionReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    // MARK: – Badge statusu

    @ViewBuilder
    private func statusBadge(_ status: VehicleStatus) -> some View {
        let color: Color = {
            switch status {
            case .approved: return .green
            case .pending:  return .orange
            case .rejected: return .red
            case .blocked:  return .gray
            case .expired:  return .secondary
            }
        }()
        HStack(spacing: 4) {
            Image(systemName: status.icon)
            Text(status.label)
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(color)
        .background(color.opacity(0.15), in: Capsule())
    }

    // MARK: – Akcje

    enum Action: String { case approve, reject, block, unblock }

    /// Body PATCH .../status — ten sam shape co BaUpdateVehicleStatusDto na backendzie.
    private struct StatusActionBody: Encodable {
        let action: String
        let reason: String?
    }

    private func act(_ v: Vehicle, _ action: Action, reason: String? = nil) async {
        actionInFlight = true
        defer { actionInFlight = false }
        do {
            let body = StatusActionBody(action: action.rawValue, reason: reason)
            let _: Vehicle = try await APIClient.shared.patch(
                "/building-admin/buildings/\(buildingId)/vehicles/\(v.id)/status",
                body: body
            )
            await load()
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func load() async {
        loading = true; error = nil
        do { vehicles = try await APIClient.shared.get("/building-admin/buildings/\(buildingId)/vehicles") }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}
