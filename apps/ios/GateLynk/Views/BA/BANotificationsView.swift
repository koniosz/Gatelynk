import SwiftUI

struct BANotificationsView: View {
    let buildingId: Int
    @State private var residents: [Resident] = []
    @State private var selectedResidentId: Int?
    @State private var title = ""
    @State private var body_ = ""
    @State private var sending = false
    @State private var result: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Odbiorca") {
                    Picker("Wyślij do", selection: $selectedResidentId) {
                        Text("Wszyscy mieszkańcy").tag(Optional<Int>.none)
                        ForEach(residents) { r in
                            Text(r.fullName).tag(Optional(r.id))
                        }
                    }
                }

                Section("Treść") {
                    TextField("Tytuł *", text: $title)
                    TextField("Treść powiadomienia *", text: $body_, axis: .vertical)
                        .lineLimit(4...8)
                }

                if let result {
                    Section {
                        Text(result)
                            .foregroundStyle(result.contains("Błąd") ? .red : .green)
                    }
                }

                Section {
                    Button(action: send) {
                        if sending {
                            HStack { Spacer(); ProgressView(); Spacer() }
                        } else {
                            HStack { Spacer(); Text("🔔 Wyślij powiadomienie"); Spacer() }
                        }
                    }
                    .disabled(title.isEmpty || body_.isEmpty || sending)
                }
            }
            .navigationTitle("Powiadomienia")
            .task {
                residents = (try? await APIClient.shared.get("/building-admin/buildings/\(buildingId)/residents")) ?? []
            }
        }
    }

    private func send() {
        sending = true; result = nil
        Task {
            struct Body: Encodable {
                let title: String
                let body: String
                let residentId: Int?
            }
            do {
                let _: EmptyResponse = try await APIClient.shared.post(
                    "/building-admin/buildings/\(buildingId)/notifications",
                    body: Body(title: title, body: body_, residentId: selectedResidentId)
                )
                result = "✓ Wysłano!"
                title = ""
                body_ = ""
            } catch {
                result = "Błąd: \(error.localizedDescription)"
            }
            sending = false
        }
    }
}
