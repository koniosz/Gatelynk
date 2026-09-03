import SwiftUI

struct BAResidentsView: View {
    let buildingId: Int
    @State private var residents: [Resident] = []
    @State private var search = ""
    @State private var loading = true
    @State private var error: String?
    @State private var selectedResident: Resident?
    @State private var showSetPassword = false
    @State private var newPassword = ""
    @State private var pwSaving = false
    @State private var pwResult: String?

    var filtered: [Resident] {
        guard !search.isEmpty else { return residents }
        let q = search.lowercased()
        return residents.filter {
            $0.fullName.lowercased().contains(q) || $0.email.lowercased().contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading { ProgressView() }
                else if let error { ContentUnavailableView(error, systemImage: "wifi.exclamationmark") }
                else {
                    List(filtered) { r in
                        Button {
                            selectedResident = r
                            newPassword = ""
                            pwResult = nil
                            showSetPassword = true
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(r.fullName).fontWeight(.semibold).foregroundStyle(.primary)
                                Text(r.email).font(.caption).foregroundStyle(.secondary)
                                if let phone = r.phone {
                                    Text(phone).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                    .listStyle(.insetGrouped)
                    .searchable(text: $search, prompt: "Szukaj mieszkańca...")
                }
            }
            .navigationTitle("Mieszkańcy (\(residents.count))")
            .task { await load() }
            .refreshable { await load() }
            .sheet(isPresented: $showSetPassword) {
                if let r = selectedResident {
                    setPasswordSheet(resident: r)
                }
            }
        }
    }

    @ViewBuilder
    private func setPasswordSheet(resident: Resident) -> some View {
        NavigationStack {
            Form {
                Section("\(resident.fullName)") {
                    SecureField("Nowe hasło", text: $newPassword)
                }
                if let res = pwResult {
                    Section { Text(res).foregroundStyle(res.contains("Błąd") ? .red : .green) }
                }
            }
            .navigationTitle("Ustaw hasło")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Zamknij") { showSetPassword = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Zapisz") { Task { await savePassword(resident: resident) } }
                        .disabled(newPassword.count < 6 || pwSaving)
                }
            }
        }
    }

    private func load() async {
        loading = true; error = nil
        do { residents = try await APIClient.shared.get("/building-admin/buildings/\(buildingId)/residents") }
        catch { self.error = error.localizedDescription }
        loading = false
    }

    private func savePassword(resident: Resident) async {
        pwSaving = true; pwResult = nil
        struct Body: Encodable { let password: String }
        do {
            let _: EmptyResponse = try await APIClient.shared.post(
                "/building-admin/buildings/\(buildingId)/residents/\(resident.id)/set-password",
                body: Body(password: newPassword)
            )
            pwResult = "✓ Hasło ustawione"
            newPassword = ""
        } catch { pwResult = "Błąd: \(error.localizedDescription)" }
        pwSaving = false
    }
}
