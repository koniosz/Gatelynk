import SwiftUI

// MARK: - Zapowiedzi funkcji („WKRÓTCE")
//
// Decyzja właściciela (2026-07-07): atrapy z prototypu Glass Depth (panel
// zamka Tedee, „Zapłać BLIK", kod skrytki paczkomatu, Dynamic Island
// geofencing) ZOSTAJĄ widoczne w UI jako zapowiedzi — z wyraźną plakietką
// „WKRÓTCE". Tap nie wchodzi w martwe flow, tylko pokazuje elegancki sheet
// „Ta funkcja pojawi się wkrótce". Jeden reużywalny komponent:
//   • GlassSoonBadge          — plakietka na elementach-zapowiedziach,
//   • GlassUpcomingFeature    — katalog zapowiedzi (tytuł/opis/ikona),
//   • GlassComingSoonSheet    — treść sheetu (host: GlassHomeView).

/// Katalog funkcji-zapowiedzi. Nowa atrapa = nowy case (jedno miejsce).
enum GlassUpcomingFeature: String, Identifiable, Equatable {
    case tedeeLock
    case blik
    case lockerCode
    case geofencing
    case addVehicle

    var id: String { rawValue }

    var title: String {
        switch self {
        case .tedeeLock:  return "Mój dom — zamek drzwi"
        case .blik:       return "Płatność BLIK"
        case .lockerCode: return "Kod skrytki paczkomatu"
        case .geofencing: return "Otwieranie przy zbliżaniu"
        case .addVehicle: return "Rejestracja pojazdu"
        }
    }

    var description: String {
        switch self {
        case .tedeeLock:
            return "Odblokujesz drzwi własnego mieszkania prosto z aplikacji — integracja z inteligentnymi zamkami (Tedee)."
        case .blik:
            return "Opłacisz czynsz jednym kodem BLIK bez wychodzenia z aplikacji."
        case .lockerCode:
            return "Kod odbioru paczki ze skrytki pojawi się tutaj automatycznie, gdy kurier ją zostawi."
        case .geofencing:
            return "Aplikacja wykryje, że zbliżasz się do osiedla, i zaproponuje otwarcie bramy na Dynamic Island."
        case .addVehicle:
            return "Zgłosisz nowy pojazd do listy rozpoznawanych tablic bez kontaktu z administracją."
        }
    }

    var icon: String {
        switch self {
        case .tedeeLock:  return "lock.circle"
        case .blik:       return "creditcard.circle"
        case .lockerCode: return "shippingbox.circle"
        case .geofencing: return "location.circle"
        case .addVehicle: return "car.circle"
        }
    }
}

// MARK: - Plakietka „WKRÓTCE"

struct GlassSoonBadge: View {
    var body: some View {
        Text("WKRÓTCE")
            .font(.system(size: 9, weight: .heavy))
            .tracking(1.2)
            .foregroundStyle(GlassColor.accentLight)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background {
                Capsule().fill(GlassColor.accentBlue.opacity(0.18))
            }
            .overlay {
                Capsule().strokeBorder(GlassColor.accentLight.opacity(0.45), lineWidth: 1)
            }
    }
}

// MARK: - Sheet „Ta funkcja pojawi się wkrótce"

struct GlassComingSoonSheet: View {
    let feature: GlassUpcomingFeature
    let onClose: () -> Void

    @State private var glow = false

    var body: some View {
        VStack(spacing: 14) {
            GlassSheetHeader(kicker: "Zapowiedź", title: feature.title, onClose: onClose)

            ZStack {
                Circle()
                    .fill(GlassColor.accentGradient)
                    .frame(width: 76, height: 76)
                    .opacity(0.22)
                    .blur(radius: glow ? 6 : 14)
                Image(systemName: feature.icon)
                    .font(.system(size: 44, weight: .regular))
                    .foregroundStyle(GlassColor.accentGradient)
            }
            .padding(.top, 4)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) {
                    glow = true
                }
            }

            GlassSoonBadge()

            Text("Ta funkcja pojawi się wkrótce.")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)

            Text(feature.description)
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.65))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 6)

            GlassButton(title: "OK, czekam", style: .ghost) { onClose() }
                .padding(.top, 4)
        }
    }
}
