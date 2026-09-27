// Testy czystej logiki UX (audyt 2026-09-21). Projekt iOS nie ma targetu
// testowego, więc kompilujemy standalone:
//   cd apps/ios && swiftc GateLynkGlass/Logic/GlassAccessLogic.swift LogicTests/main.swift -o /tmp/glass-logic-tests && /tmp/glass-logic-tests
import Foundation

var failures = 0
func expect(_ cond: @autoclosure () -> Bool, _ name: String) {
    if cond() { print("✔ \(name)") } else { failures += 1; print("✖ \(name)") }
}

let now = Date(timeIntervalSince1970: 1_790_000_000)
let h: TimeInterval = 3600
func phase(_ status: String, from: TimeInterval, to: TimeInterval, remaining: [Int] = [], unlimited: Bool = true) -> GuestPassPhase {
    GuestPassPhase.classify(status: status, validFrom: now.addingTimeInterval(from), validTo: now.addingTimeInterval(to),
                            remainingPerLimitedEntrance: remaining, hasUnlimitedEntrance: unlimited, now: now)
}

// Przepustki
expect(phase("ACTIVE", from: -h, to: h) == .active, "ACTIVE w oknie → aktywna")
expect(phase("ACTIVE", from: h, to: 2 * h) == .scheduled, "ACTIVE z przyszłym startem → zaplanowana (przyszły koniec ≠ aktywny dostęp)")
expect(phase("ACTIVE", from: -2 * h, to: -h) == .expired, "ACTIVE po terminie (cron jeszcze nie oznaczył) → wygasła")
expect(phase("EXPIRED", from: -2 * h, to: h) == .expired, "EXPIRED z backendu → wygasła")
expect(phase("CANCELLED", from: -h, to: h) == .cancelled, "CANCELLED → cofnięta, nawet w oknie czasowym")
expect(phase("ACTIVE", from: -h, to: h, remaining: [0, 0], unlimited: false) == .exhausted, "wszystkie wejścia z limitem wyczerpane → limit wykorzystany")
expect(phase("ACTIVE", from: -h, to: h, remaining: [0, 2], unlimited: false) == .active, "zostały otwarcia na jednym wejściu → aktywna")
expect(phase("ACTIVE", from: -h, to: h, remaining: [0], unlimited: true) == .active, "jest wejście bez limitu → limit nie wyczerpuje przepustki")
expect(phase("CANCELLED", from: -h, to: h, remaining: [0], unlimited: false) == .cancelled, "cofnięcie ma pierwszeństwo przed limitem")
expect(GuestPassPhase.active.isLive && GuestPassPhase.scheduled.isLive, "aktywną i zaplanowaną można cofnąć/udostępnić")
expect(!GuestPassPhase.expired.isLive && !GuestPassPhase.cancelled.isLive && !GuestPassPhase.exhausted.isLive, "historia nie jest „żywa\"")

// Zdarzenia LPR
let ok = LprEventReading.read(type: "LPR_MATCH", gateOpened: true, reason: nil, direction: "IN")
expect(ok.tone == .positive && ok.title == "Rozpoznano przy wjeździe" && !ok.detail.lowercased().contains("otwart"), "sukces = wysłane polecenie, bez twierdzenia „otwarta\"")
let cd = LprEventReading.read(type: "LPR_MATCH", gateOpened: false, reason: "cooldown", direction: "OUT")
expect(cd.tone == .neutral && cd.title.contains("wyjeździe"), "cooldown nie jest odmową (neutralny)")
let pm = LprEventReading.read(type: "LPR_MATCH", gateOpened: false, reason: "probable_match", direction: "forward")
expect(pm.tone == .warning, "odczyt niepewny → ostrzeżenie, nie czerwony błąd")
let nw = LprEventReading.read(type: "LPR_NO_MATCH", gateOpened: false, reason: "not_whitelisted", direction: "IN")
expect(nw.tone == .negative && nw.title.hasPrefix("Odmowa"), "brak na liście → odmowa z powodem")
let un = LprEventReading.read(type: "LPR_MATCH", gateOpened: false, reason: nil, direction: nil)
expect(un.tone == .neutral && un.detail == "Wynik nieznany", "brak danych o wyniku → „Wynik nieznany\", nie sukces i nie błąd")
let ao = LprEventReading.read(type: "LPR_MATCH", gateOpened: false, reason: "auto_open_disabled", direction: "IN")
expect(ao.tone == .neutral && ao.title.hasPrefix("Rozpoznano") && ao.detail.contains("wyłączone"), "auto-open wyłączone → rozpoznano, bez otwarcia, neutralnie (nie błąd)")
let cl = LprEventReading.read(type: "LPR_MATCH", gateOpened: false, reason: "camera_not_linked", direction: "IN")
expect(cl.tone == .negative && cl.detail.contains("nie jest powiązana"), "kamera bez powiązania z bramą → problem do zgłoszenia, nie sukces")
let ge = LprEventReading.read(type: "LPR_MATCH", gateOpened: false, reason: "gate_error", direction: "IN")
expect(ge.tone == .negative, "błąd bramy → problem")
let odd = LprEventReading.read(type: "LPR_MATCH", gateOpened: false, reason: "guest_limit_reached", direction: "IN")
expect(odd.detail.contains("guest_limit_reached"), "nieznany kod powodu pokazany wprost, bez zgadywania")

// MARK: Dashboard „Wymaga uwagi"

print("\nDashboard — werdykt sekcji „Wymaga uwagi\"")
expect(AttentionVerdict.resolve(sources: [.loaded, .loaded, .unavailable], itemCount: 0) == .confirmedEmpty,
       "wszystko pobrane (moduł wyłączony nie blokuje) → potwierdzony brak spraw")
expect(AttentionVerdict.resolve(sources: [.loaded, .failed], itemCount: 0) == .unknown,
       "jedno źródło nie odpowiedziało → NIE mówimy „brak spraw\"")
expect(AttentionVerdict.resolve(sources: [.loading, .loaded], itemCount: 0) == .loading,
       "trwa pobieranie → stan ładowania, nie „brak spraw\"")
expect(AttentionVerdict.resolve(sources: [.loaded, .failed], itemCount: 2) == .items(incomplete: true),
       "są pozycje + błąd źródła → lista z adnotacją o niepełnych danych")
expect(AttentionVerdict.resolve(sources: [.loaded, .loaded], itemCount: 1) == .items(incomplete: false),
       "są pozycje, komplet danych")

print("\nDashboard — reguły pozycji")
expect(AttentionRules.ticketAwaitsResident(status: "IN_PROGRESS", lastReplyAuthorType: "ADMIN"),
       "ostatnia odpowiedź od administracji → czeka na mieszkańca")
expect(AttentionRules.ticketAwaitsResident(status: "OPEN", lastReplyAuthorType: "CONCIERGE"),
       "odpowiedź konsjerża też się liczy")
expect(!AttentionRules.ticketAwaitsResident(status: "OPEN", lastReplyAuthorType: "RESIDENT"),
       "ostatni pisał mieszkaniec → nie wymaga uwagi")
expect(!AttentionRules.ticketAwaitsResident(status: "OPEN", lastReplyAuthorType: nil),
       "brak odpowiedzi → nie wymaga uwagi")
expect(!AttentionRules.ticketAwaitsResident(status: "DONE", lastReplyAuthorType: "ADMIN"),
       "zamknięte zgłoszenie nie wraca na dashboard")

let t0 = Date(timeIntervalSince1970: 1_800_000_000)
expect(AttentionRules.guestPassExpiresSoon(phase: .active, validTo: t0.addingTimeInterval(3 * 3600), now: t0),
       "aktywna przepustka kończy się za 3 h → wygasa wkrótce")
expect(!AttentionRules.guestPassExpiresSoon(phase: .active, validTo: t0.addingTimeInterval(3 * 86_400), now: t0),
       "koniec za 3 dni → nie alarmujemy")
expect(!AttentionRules.guestPassExpiresSoon(phase: .scheduled, validTo: t0.addingTimeInterval(3600), now: t0),
       "zaplanowana (jeszcze nie działa) → nie „wygasa\"")
expect(!AttentionRules.guestPassExpiresSoon(phase: .expired, validTo: t0.addingTimeInterval(-60), now: t0),
       "już wygasła → nie dublujemy alarmu")

expect(AttentionRules.payment(chargeStatus: "OVERDUE", dueDate: nil, now: t0) == .overdue,
       "status OVERDUE z API → po terminie")
expect(AttentionRules.payment(chargeStatus: "UNPAID", dueDate: t0.addingTimeInterval(2 * 86_400 + 60), now: t0) == .dueSoon(days: 2),
       "nieopłacone, termin za 2 dni → wkrótce")
expect(AttentionRules.payment(chargeStatus: "UNPAID", dueDate: t0.addingTimeInterval(20 * 86_400), now: t0) == .none,
       "termin odległy → brak pozycji")
expect(AttentionRules.payment(chargeStatus: "PAID", dueDate: t0.addingTimeInterval(86_400), now: t0) == .none,
       "opłacone → brak pozycji")
expect(AttentionRules.payment(chargeStatus: nil, dueDate: nil, now: t0) == .none,
       "brak naliczenia w odpowiedzi → niczego nie zgadujemy")

print(failures == 0 ? "\nALL PASSED" : "\nFAILED: \(failures)")
exit(failures == 0 ? 0 : 1)
