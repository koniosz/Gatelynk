import SwiftUI

// MARK: - MoreView (Faza 8.h.18 — 2026-06-09)
//
// Tab "Inne" — proste menu wierszy nawigacyjnych do widoków, które straciły
// dedykowany tab po refaktorze TabBaru:
//   • Profil i ustawienia (SettingsView — pełna lista z pojazdami, motywem,
//     logowaniem itd.)
//   • Pojazdy (skrót do `ResidentVehiclesSheet`)
//   • Płatności (`PaymentsView`)
//   • Zgłoszenia (`TicketsView` — wcześniej osobny tab)
//   • Przesyłki (`ParcelsView`)
//   • Goście (`GuestsView`)
//   • Asystent (`AssistantView`)
//   • Powiadomienia (`NotificationsView`)
//
// Większość ekranów ma własny `NavigationStack` w środku → otwieramy je
// jako `sheet(...)` żeby nie tworzyć nested-stacka. Dla `SettingsView` użyjemy
// fullScreenCover, bo to logicznie strona-w-stronie a nie modal.

struct MoreView: View {
    @Environment(\.colorScheme) private var scheme

    @State private var showSettings = false
    @State private var showVehicles = false
    @State private var showPayments = false
    @State private var showTickets = false
    @State private var showParcels = false
    @State private var showGuests = false
    @State private var showAssistant = false
    @State private var showNotifications = false

    var body: some View {
        NavigationStack {
            List {
                Section("Konto") {
                    row(icon: "person.crop.circle.fill", tint: .blue, title: "Profil i ustawienia") {
                        showSettings = true
                    }
                    row(icon: "car.fill", tint: .indigo, title: "Moje pojazdy") {
                        showVehicles = true
                    }
                    row(icon: "creditcard.fill", tint: .green, title: "Płatności") {
                        showPayments = true
                    }
                }

                Section("Codzienne") {
                    row(icon: "person.2.fill", tint: .pink, title: "Goście") {
                        showGuests = true
                    }
                    row(icon: "shippingbox.fill", tint: .orange, title: "Przesyłki") {
                        showParcels = true
                    }
                    row(icon: "bubble.left.fill", tint: .teal, title: "Zgłoszenia") {
                        showTickets = true
                    }
                }

                Section("Wsparcie") {
                    row(icon: "sparkles", tint: .purple, title: "Asystent GateLynk") {
                        showAssistant = true
                    }
                    row(icon: "bell.fill", tint: .red, title: "Powiadomienia") {
                        showNotifications = true
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Inne")
        }
        .sheet(isPresented: $showSettings)      { SettingsView() }
        .sheet(isPresented: $showVehicles)      { ResidentVehiclesSheet() }
        .sheet(isPresented: $showPayments)      { PaymentsView() }
        .sheet(isPresented: $showTickets)       { TicketsView() }
        .sheet(isPresented: $showParcels)       { ParcelsView() }
        .sheet(isPresented: $showGuests)        { GuestsView() }
        .sheet(isPresented: $showAssistant)     { AssistantView() }
        .sheet(isPresented: $showNotifications) { NotificationsView() }
    }

    @ViewBuilder
    private func row(icon: String, tint: Color, title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(tint)
                    .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                Text(title)
                    .font(.system(size: 15))
                    .foregroundStyle(GLColor.textPrimary(scheme))
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
