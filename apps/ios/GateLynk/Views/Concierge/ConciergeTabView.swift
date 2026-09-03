import SwiftUI

struct ConciergeTabView: View {
    var body: some View {
        TabView {
            ConciergeResidentsView()
                .tabItem { Label("Mieszkańcy", systemImage: "person.3.fill") }
            ConciergeUnitsView()
                .tabItem { Label("Lokale", systemImage: "door.left.hand.open") }
            ConciergeParcelsView()
                .tabItem { Label("Przesyłki", systemImage: "shippingbox.fill") }
            ConciergeVehiclesView()
                .tabItem { Label("Pojazdy", systemImage: "car.fill") }
            ConciergeProfileView()
                .tabItem { Label("Profil", systemImage: "person.fill") }
        }
    }
}

struct ConciergeProfileView: View {
    @Environment(AuthManager.self) private var auth
    var body: some View {
        NavigationStack {
            List {
                if case .concierge(let u) = auth.role {
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
