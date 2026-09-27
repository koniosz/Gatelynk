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
        case "camera_not_linked":
            return .init(title: "Rozpoznano \(place)",
                         detail: "Kamera nie jest powiązana z bramą — brama nie została otwarta; zgłoś to administracji",
                         tone: .negative)
        case "auto_open_disabled":
            return .init(title: "Rozpoznano \(place)",
                         detail: "Automatyczne otwieranie było wyłączone dla tego pojazdu — brama nie została otwarta",
                         tone: .neutral)
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

// MARK: - Dashboard „Wymaga uwagi" (audyt UX 2026-09-21, §8)

/// Stan pobrania JEDNEGO źródła danych dashboardu. `unavailable` = moduł
/// wyłączony dla osiedla/roli (403 FEATURE_DISABLED) — to nie jest błąd
/// i nie blokuje werdyktu „brak spraw".
enum DashboardSourceState: Equatable {
    case loading, loaded, failed, unavailable
}

/// Co wolno powiedzieć w sekcji „Wymaga uwagi". „Brak spraw" pokazujemy
/// WYŁĄCZNIE, gdy każde źródło odpowiedziało (albo jest wyłączone) — nigdy
/// na podstawie pustych tablic po nieudanym pobraniu.
enum AttentionVerdict: Equatable {
    /// Są pozycje; `incomplete` = część źródeł nie odpowiedziała.
    case items(incomplete: Bool)
    case loading
    /// Brak pozycji, ale nie wszystkie źródła odpowiedziały — nie wiemy.
    case unknown
    /// Wszystkie źródła odpowiedziały i nie ma nic do zrobienia.
    case confirmedEmpty

    static func resolve(sources: [DashboardSourceState], itemCount: Int) -> AttentionVerdict {
        let anyFailed = sources.contains(.failed)
        let anyLoading = sources.contains(.loading)
        if itemCount > 0 { return .items(incomplete: anyFailed) }
        if anyLoading { return .loading }
        if anyFailed { return .unknown }
        return .confirmedEmpty
    }
}

enum AttentionRules {
    /// Zgłoszenie czeka na mieszkańca, gdy jest otwarte, a OSTATNIA odpowiedź
    /// w wątku pochodzi od obsługi (administracja / konsjerż).
    static func ticketAwaitsResident(status: String, lastReplyAuthorType: String?) -> Bool {
        guard status != "DONE", let author = lastReplyAuthorType else { return false }
        return author != "RESIDENT"
    }

    /// Przepustka „wygasa wkrótce": działa TERAZ i kończy się w ciągu `window`.
    static func guestPassExpiresSoon(
        phase: GuestPassPhase, validTo: Date, now: Date, window: TimeInterval = 24 * 3600
    ) -> Bool {
        guard phase == .active else { return false }
        let left = validTo.timeIntervalSince(now)
        return left > 0 && left <= window
    }

    enum PaymentAttention: Equatable { case none, overdue, dueSoon(days: Int) }

    /// Należność wymagalna: po terminie (status API) albo nieopłacona z terminem
    /// w ciągu `soonDays`. Status liczy backend — klient go nie zgaduje.
    static func payment(
        chargeStatus: String?, dueDate: Date?, now: Date, soonDays: Int = 5
    ) -> PaymentAttention {
        guard let status = chargeStatus else { return .none }
        if status == "OVERDUE" { return .overdue }
        guard status == "UNPAID" || status == "PARTIAL", let due = dueDate else { return .none }
        let days = Int((due.timeIntervalSince(now) / 86_400).rounded(.down))
        if days < 0 { return .overdue }
        return days <= soonDays ? .dueSoon(days: days) : .none
    }
}
