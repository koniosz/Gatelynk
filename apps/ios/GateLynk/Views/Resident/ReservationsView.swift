import SwiftUI

struct ReservationsView: View {
    @State private var reservations: [Reservation] = []
    @State private var loading = true
    @State private var error: String?
    @State private var showNew = false
    @State private var editReservation: Reservation?
    @State private var cancellingId: Int?

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
                } else if reservations.isEmpty {
                    ContentUnavailableView("Brak rezerwacji", systemImage: "calendar.badge.exclamationmark")
                } else {
                    List(reservations) { r in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(r.unit?.unitType?.name ?? "Lokal")
                                    .fontWeight(.semibold)
                                if let num = r.unit?.number {
                                    Text(num).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(statusLabel(r.status))
                                    .font(.caption2)
                                    .padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(statusColor(r.status).opacity(0.15))
                                    .foregroundStyle(statusColor(r.status))
                                    .cornerRadius(8)
                            }
                            Text("Od: \(Self.dateFmt.string(from: r.startAt))")
                                .font(.caption).foregroundStyle(.secondary)
                            Text("Do: \(Self.dateFmt.string(from: r.endAt))")
                                .font(.caption).foregroundStyle(.secondary)
                            if let note = r.note, !note.isEmpty {
                                Text(note).font(.caption2).foregroundStyle(.tertiary)
                            }
                            if r.status == "CONFIRMED" {
                                HStack(spacing: 16) {
                                    Button {
                                        editReservation = r
                                    } label: {
                                        Label("Edytuj", systemImage: "pencil")
                                            .font(.caption)
                                            .foregroundStyle(.blue)
                                    }
                                    Spacer()
                                    Button {
                                        Task { await cancel(r) }
                                    } label: {
                                        if cancellingId == r.id {
                                            ProgressView()
                                        } else {
                                            Label("Anuluj", systemImage: "xmark.circle")
                                                .font(.caption)
                                                .foregroundStyle(.red)
                                        }
                                    }
                                    .disabled(cancellingId != nil)
                                }
                                .padding(.top, 2)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Rezerwacje")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $showNew) {
                NewReservationView(existing: nil) { await load() }
            }
            .sheet(item: $editReservation) { r in
                NewReservationView(existing: r) { await load() }
            }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true; error = nil
        do { reservations = try await APIClient.shared.get("/resident/reservations") }
        catch { self.error = error.localizedDescription }
        loading = false
    }

    private func cancel(_ r: Reservation) async {
        cancellingId = r.id
        do {
            let _: Reservation = try await APIClient.shared.delete("/resident/reservations/\(r.id)")
            reservations = reservations.map {
                $0.id == r.id ? Reservation(id: $0.id, startAt: $0.startAt, endAt: $0.endAt, status: "CANCELLED", note: $0.note, unit: $0.unit) : $0
            }
        } catch {}
        cancellingId = nil
    }

    private func statusLabel(_ s: String) -> String {
        switch s {
        case "CONFIRMED": return "Potwierdzona"
        case "CANCELLED": return "Anulowana"
        default: return s
        }
    }
    private func statusColor(_ s: String) -> Color {
        s == "CONFIRMED" ? .green : .red
    }
}

struct NewReservationView: View {
    var existing: Reservation?
    var onSave: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var units: [Unit] = []
    @State private var selectedUnitId: Int?
    @State private var startDate = Date()
    @State private var endDate = Date().addingTimeInterval(3600)
    @State private var note = ""
    @State private var saving = false
    @State private var error: String?

    var isEdit: Bool { existing != nil }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    var body: some View {
        NavigationStack {
            Form {
                Section("Przestrzeń") {
                    if units.isEmpty {
                        Text("Brak dostępnych przestrzeni wspólnych")
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Wybierz", selection: $selectedUnitId) {
                            Text("Wybierz...").tag(Optional<Int>.none)
                            ForEach(units) { u in
                                Text("\(u.unitType?.name ?? "Lokal") \(u.number)").tag(Optional(u.id))
                            }
                        }
                    }
                }
                Section("Termin") {
                    DatePicker("Od", selection: $startDate)
                    DatePicker("Do", selection: $endDate)
                }
                Section("Notatka (opcjonalnie)") {
                    TextField("Notatka", text: $note, axis: .vertical)
                        .lineLimit(3)
                }
                if let error { Text(error).foregroundStyle(.red).font(.caption) }
            }
            .navigationTitle(isEdit ? "Edytuj rezerwację" : "Nowa rezerwacja")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Anuluj") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Zapisz") { Task { await save() } }
                        .disabled(selectedUnitId == nil || saving)
                }
            }
            .task {
                units = (try? await APIClient.shared.get("/resident/reservations/units")) ?? []
                if let r = existing {
                    selectedUnitId = r.unit?.id
                    startDate = r.startAt
                    endDate = r.endAt
                    note = r.note ?? ""
                }
            }
        }
    }

    private func save() async {
        guard let unitId = selectedUnitId else { return }
        saving = true; error = nil
        let startStr = Self.iso.string(from: startDate)
        let endStr = Self.iso.string(from: endDate)
        do {
            if let r = existing {
                struct PatchBody: Encodable { let unitId: Int; let startAt: String; let endAt: String; let note: String? }
                let _: Reservation = try await APIClient.shared.patch(
                    "/resident/reservations/\(r.id)",
                    body: PatchBody(unitId: unitId, startAt: startStr, endAt: endStr, note: note.isEmpty ? nil : note)
                )
            } else {
                let _: Reservation = try await APIClient.shared.post(
                    "/resident/reservations",
                    body: CreateReservationBody(unitId: unitId, startAt: startStr, endAt: endStr, note: note.isEmpty ? nil : note)
                )
            }
            await onSave()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}
