import SwiftUI

// MARK: - VehicleFormView
//
// Forma dodawania / edycji pojazdu rezydenta. Plik został odtworzony 2026-05-11
// — Xcode projekt miał referencję do `VehicleFormView` w `ProfileView.swift`
// ale fizyczny plik brakował (prawdopodobnie usunięty przy refactor). Bez tego
// cały `ProfileView` nie kompiluje się.
//
// Resident może:
//   • Dodać własny pojazd (POST /resident/vehicles) — backend ustawia
//     status='PENDING', admin osiedla zatwierdza.
//   • Edytować własny pojazd (PATCH /resident/vehicles/:id). Zmiana tablicy
//     na zatwierdzonym aucie cofa je do PENDING (admin akceptuje na nowo);
//     zmiany kosmetyczne (kolor/model) zostawiają status.
//   • Usunąć własny pojazd (DELETE /resident/vehicles/:id).

struct VehicleFormView: View {
    let vehicle: Vehicle?
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var make: String = ""
    @State private var model: String = ""
    @State private var color: String = ""
    @State private var licensePlate: String = ""
    @State private var saving = false
    @State private var deleting = false
    @State private var error: String?
    /// 2026-09-25 — czy rozpoznanie tablicy ma otwierać bramę (PATCH `autoOpen`).
    @State private var autoOpen = true

    var body: some View {
        NavigationStack {
            Form {
                if vehicle == nil {
                    Section {
                        Text("Nowy pojazd po dodaniu wymaga zatwierdzenia przez administratora osiedla.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    TextField("Marka (np. Toyota)", text: $make)
                    TextField("Model (opcjonalnie)", text: $model)
                    TextField("Kolor", text: $color)
                    TextField("Tablica rejestracyjna", text: $licensePlate)
                        .textInputAutocapitalization(.characters)
                        .disableAutocorrection(true)
                } header: {
                    Text("Dane pojazdu")
                } footer: {
                    if let v = vehicle, v.effectiveStatus == .approved {
                        Text("Zmiana tablicy wymaga ponownego zatwierdzenia przez administratora.")
                            .font(.caption)
                    }
                }

                if let v = vehicle {
                    Section("Status") {
                        HStack {
                            Image(systemName: v.effectiveStatus.icon)
                            Text(v.effectiveStatus.label)
                            Spacer()
                        }
                        .foregroundStyle(statusColor(v.effectiveStatus))
                        if v.effectiveStatus == .rejected, let r = v.rejectionReason {
                            Text("Powód: \(r)")
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                    Section {
                        Toggle("Otwieraj bramę po rozpoznaniu tablicy", isOn: $autoOpen)
                            .disabled(v.effectiveStatus != .approved)
                    } header: {
                        Text("Automatyczny wjazd")
                    } footer: {
                        Text(v.effectiveStatus == .approved
                             ? (autoOpen
                                ? "Po rozpoznaniu tablicy kamera wysyła polecenie otwarcia bramy. Zapisz, aby zmiana trafiła na sterownik osiedla."
                                : "Przejazdy będą rozpoznawane i zapisywane, ale brama nie otworzy się sama. Zapisz, aby zmiana trafiła na sterownik osiedla.")
                             : "Dostępne po zatwierdzeniu pojazdu przez administratora.")
                            .font(.caption)
                    }
                    Section {
                        Button(role: .destructive) {
                            Task { await delete(v) }
                        } label: {
                            if deleting {
                                ProgressView()
                            } else {
                                Text("Usuń pojazd")
                                    .frame(maxWidth: .infinity)
                            }
                        }
                    } footer: {
                        Text("Usunięcie skasuje wpis w rejestrze. Aby tylko poprawić dane — skontaktuj się z administratorem osiedla.")
                            .font(.caption)
                    }
                }

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red).font(.caption)
                    }
                }
            }
            .navigationTitle(vehicle == nil ? "Dodaj pojazd" : "Pojazd")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if vehicle == nil {
                        Button("Dodaj") { Task { await create() } }
                            .disabled(saving || make.isEmpty || color.isEmpty || licensePlate.isEmpty)
                    } else {
                        Button("Zapisz") { Task { await update() } }
                            .disabled(saving || deleting || make.isEmpty || licensePlate.isEmpty)
                    }
                }
            }
            .onAppear {
                if let v = vehicle {
                    make = v.make
                    model = v.model ?? ""
                    color = v.color
                    licensePlate = v.licensePlate
                    autoOpen = v.autoOpenEnabled
                }
            }
        }
    }

    private func statusColor(_ s: VehicleStatus) -> Color {
        switch s {
        case .approved: return .green
        case .pending:  return .orange
        case .rejected: return .red
        case .blocked:  return .gray
        case .expired:  return .secondary
        }
    }

    // MARK: - API

    private struct CreateBody: Encodable {
        let make: String
        let model: String?
        let color: String
        let licensePlate: String
    }

    private func create() async {
        saving = true; error = nil
        do {
            let _: Vehicle = try await APIClient.shared.post(
                "/resident/vehicles",
                body: CreateBody(
                    make: make.trimmingCharacters(in: .whitespaces),
                    model: model.isEmpty ? nil : model,
                    color: color.trimmingCharacters(in: .whitespaces),
                    licensePlate: licensePlate.trimmingCharacters(in: .whitespaces).uppercased(),
                ),
            )
            await onChange()
            dismiss()
        } catch {
            self.error = (error as? URLError)?.localizedDescription ?? String(describing: error)
        }
        saving = false
    }

    private struct PatchBody: Encodable {
        let make: String
        let model: String?
        let color: String
        let licensePlate: String
        let autoOpen: Bool
    }

    private func update() async {
        guard let v = vehicle else { return }
        saving = true; error = nil
        do {
            let _: Vehicle = try await APIClient.shared.patch(
                "/resident/vehicles/\(v.id)",
                body: PatchBody(
                    make: make.trimmingCharacters(in: .whitespaces),
                    model: model.trimmingCharacters(in: .whitespaces).isEmpty ? nil : model.trimmingCharacters(in: .whitespaces),
                    color: color.trimmingCharacters(in: .whitespaces),
                    licensePlate: licensePlate.trimmingCharacters(in: .whitespaces).uppercased(),
                    autoOpen: autoOpen,
                ),
            )
            await onChange()
            dismiss()
        } catch {
            self.error = (error as? URLError)?.localizedDescription ?? String(describing: error)
        }
        saving = false
    }

    private func delete(_ v: Vehicle) async {
        deleting = true; error = nil
        do {
            // `EmptyResponse` jest zdefiniowane w Models.swift — dla endpointów
            // które zwracają puste body. Bez explicit type kompilator nie umie
            // wybrać generic-a dla `delete<T: Decodable>`.
            let _: EmptyResponse = try await APIClient.shared.delete("/resident/vehicles/\(v.id)")
            await onChange()
            dismiss()
        } catch {
            self.error = (error as? URLError)?.localizedDescription ?? String(describing: error)
        }
        deleting = false
    }
}
