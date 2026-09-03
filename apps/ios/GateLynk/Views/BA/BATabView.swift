import SwiftUI

struct BATabView: View {
    @Environment(AuthManager.self) private var auth

    var buildingId: Int {
        if case .buildingAdmin(let u) = auth.role { return u.buildingIds.first ?? 0 }
        return 0
    }

    var body: some View {
        TabView {
            BAResidentsView(buildingId: buildingId)
                .tabItem { Label("Mieszkańcy", systemImage: "person.3.fill") }
            BAUnitsView(buildingId: buildingId)
                .tabItem { Label("Lokale", systemImage: "door.left.hand.open") }
            BAVehiclesView(buildingId: buildingId)
                .tabItem { Label("Pojazdy", systemImage: "car.fill") }
            BANotificationsView(buildingId: buildingId)
                .tabItem { Label("Powiadomienia", systemImage: "bell.fill") }
            BAProfileView()
                .tabItem { Label("Profil", systemImage: "person.fill") }
        }
    }
}

struct BAProfileView: View {
    @Environment(AuthManager.self) private var auth
    var body: some View {
        NavigationStack {
            List {
                if case .buildingAdmin(let u) = auth.role {
                    Section("Konto") {
                        LabeledContent("Imię", value: u.name)
                        LabeledContent("Email", value: u.email)
                    }
                }
                Section {
                    Button(role: .destructive) { auth.logout() } label: {
                        HStack { Spacer(); Text("Wyloguj się"); Spacer() }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Profil")
        }
    }
}
