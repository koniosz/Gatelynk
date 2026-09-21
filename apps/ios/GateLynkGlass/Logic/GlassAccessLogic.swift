import Foundation

// MARK: - Czysta logika statusów dostępu (audyt UX 2026-09-21)
//
// Foundation-only, bez SwiftUI i bez modeli API — dzięki temu te reguły da
// się testować poza Xcode (`apps/ios/LogicTests/main.swift`, kompilowane
// `swiftc`; projekt nie ma targetu testowego). Widoki mapują swoje modele na
// te proste wejścia.

// MARK: Przepustka gościa

/// Faza przepustki. „Aktywna" = gość MOŻE teraz wejść — nie wystarcza status
/// ACTIVE ani przyszła data końca (zaplanowana jeszcze nie działa, wyczerpany
/// limit już nie działa, a cron oznacza wygaśnięcie z opóźnieniem do 5 min).
enum GuestPassPhase: String, CaseIterable {
    case active, scheduled, exhausted, expired, cancelled

    var label: String {
        switch self {
        case .active:    return "Aktywna teraz"
        case .scheduled: return "Zaplanowana"
        case .exhausted: return "Limit wejść wykorzystany"
        case .expired:   return "Wygasła"
        case .cancelled: return "Dostęp cofnięty"
        }
    }

    /// Czy przepustka daje (lub da) dostęp — można ją cofnąć / udostępnić.
    var isLive: Bool { self == .active || self == .scheduled }

    static func classify(
        status: String,
        validFrom: Date,
        validTo: Date,
        /// Pozostałe otwarcia per wejście Z limitem (puste = brak limitów).
        remainingPerLimitedEntrance: [Int],
        /// Czy istnieje choć jedno dozwolone wejście BEZ limitu (albo brak
        /// ograniczeń wejść w ogóle) — wtedy limit nie może wyczerpać przepustki.
        hasUnlimitedEntrance: Bool,
        now: Date
    ) -> GuestPassPhase {
        switch status.uppercased() {
        case "CANCELLED": return .cancelled
        case "EXPIRED":   return .expired
        default: break
        }
        if validTo <= now { return .expired }
        if !hasUnlimitedEntrance,
           !remainingPerLimitedEntrance.isEmpty,
           remainingPerLimitedEntrance.allSatisfy({ $0 <= 0 }) {
            return .exhausted
        }
        if validFrom > now { return .scheduled }
        return .active
    }
}

// MARK: Zdarzenie LPR pojazdu

/// Ton semantyczny: zieleń/neutral/bursztyn/czerwień — NIE kolor wejścia.
enum AccessEventTone: String { case positive, neutral, warning, negative }

/// Odczyt zdarzenia kamery. Rozdziela: rozpoznanie tablicy, decyzję (uprawnienie),
/// wysłanie polecenia do bramy. Żadne z nich nie dowodzi, że auto przejechało.
struct LprEventReading: Equatable {
    let title: String
    let detail: String
    let tone: AccessEventTone

    static func read(type: String, gateOpened: Bool, reason: String?, direction: String?) -> LprEventReading {
        let place: String
        switch (direction ?? "").lowercased() {
        case "in", "forward":  place = "przy wjeździe"
        case "out", "reverse": place = "przy wyjeździe"
        default:               place = "przy bramie"
        }
        let r = (reason ?? "").lowercased()

        if gateOpened {
            if r == "exit_pass" || r == "overstay" {
                return .init(title: "Rozpoznano \(place)",
                             detail: "Wysłano polecenie otwarcia (przepustka wyjazdowa)", tone: .positive)
            }
            return .init(title: "Rozpoznano \(place)", detail: "Wysłano polecenie otwarcia bramy", tone: .positive)
        }

        switch r {
        case "cooldown":
            return .init(title: "Rozpoznano \(place)",
                         detail: "Bez ponownego otwierania — brama dostała polecenie chwilę wcześniej", tone: .neutral)
        case "probable_match":
            return .init(title: "Odczyt niepewny \(place)",
                         detail: "Tablica odczytana niewyraźnie — bez automatycznego otwarcia", tone: .warning)
        case "unconfirmed", "edge-ocr-uncertain":
            return .init(title: "Odczyt niepotwierdzony \(place)",
                         detail: "Kamera nie potwierdziła tablicy — bez otwarcia", tone: .warning)
        case "not_whitelisted":
            return .init(title: "Odmowa \(place)",
                         detail: "Tablicy nie było wtedy na liście uprawnionych", tone: .negative)
        case "gate_error":
            return .init(title: "Błąd bramy \(place)",
                         detail: "Tablica rozpoznana, ale nie udało się wysłać polecenia otwarcia", tone: .negative)
        case "no_linked_intercom", "no_vehicle_detect_trigger":
            return .init(title: "Rozpoznano \(place)",
                         detail: "Ta kamera nie steruje bramą — tylko odczyt", tone: .neutral)
        case "overstay_denied":
            return .init(title: "Odmowa \(place)",
                         detail: "Przekroczony czas pobytu dla przepustki wyjazdowej", tone: .negative)
        case "":
            if type == "LPR_NO_MATCH" {
                return .init(title: "Odmowa \(place)",
                             detail: "Tablica nie została dopasowana do uprawnionego pojazdu", tone: .negative)
            }
            return .init(title: "Rozpoznano \(place)", detail: "Wynik nieznany", tone: .neutral)
        default:
            // Nieznany kod powodu — pokazujemy go wprost zamiast zgadywać.
            return .init(title: type == "LPR_NO_MATCH" ? "Odmowa \(place)" : "Rozpoznano \(place)",
                         detail: "Bez otwarcia — powód: \(reason ?? "")",
                         tone: type == "LPR_NO_MATCH" ? .negative : .neutral)
        }
    }
}
