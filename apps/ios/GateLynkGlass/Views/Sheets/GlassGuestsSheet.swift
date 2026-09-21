import SwiftUI
import UIKit

// MARK: - Sheet Goście
//
// Audyt UX 2026-09-21: lista odpowiada najpierw na pytanie „kto MA TERAZ
// dostęp" — zakładki Aktywne (domyślna) / Zaplanowane / Historia wg
// `GuestPassPhase` (termin + cofnięcie + wyczerpany limit, nie sam status).
// Wiersz: kto → do kiedy → dokąd → stan; PIN, link, limit i historia są
// w szczegółach. Akcje są NAZWANE (menu ⋯ i podpisane przyciski swipe):
// Udostępnij / Przedłuż / Edytuj / Cofnij dostęp / Zaproś ponownie / Usuń
// wpis. „Cofnij dostęp" (aktywna przepustka) i „Usuń wpis z historii"
// (zakończona) to RÓŻNE działania tego samego endpointu DELETE — UI je
// rozdziela i mówi prawdę o propagacji cofnięcia do bram.
//
// Kompaktowy kreator zaproszenia w tym samym sheecie.
// POST /resident/guests zwraca Guest z 6-cyfrowym PIN-em — pokazujemy go
// od razu w toaście i na liście.
//
// 2026-07-07 (parity MVP): historia aktywności gościa — feed
// GET /resident/access-events?guestsOnly=true (fail-silent na starym
// backendzie; lokalny filtr po guestId). „Ostatnia aktywność: X temu"
// + tap rozwija listę zdarzeń gościa (PIN / wjazd LPR / portal).

struct GlassGuestsSheet: View {
    let guests: [Guest]
    /// Wejście wprost w szczegóły przepustki (pozycja „Wymaga uwagi" na Domu:
    /// „przepustka wygasa wkrótce" → od razu właściwy obiekt i „Przedłuż").
    var initialGuestId: Int? = nil
    let onReload: () async -> Void
    let onClose: () -> Void

    @Environment(GlassToastCenter.self) private var toast

    // Redesign 2026-08-14 (v2): lista zostaje w dolnym sheecie, ale
    // SZCZEGÓŁY i FORMULARZ prezentują się PEŁNOEKRANOWO (fullScreenCover).
    // W 80-procentowym sheecie bogatsza karta musiała się przewijać w ciasnym
    // oknie — dokładnie to zgłosił właściciel („trzeba przewijać, nieczytelne").
    @State private var showForm = false
    /// nil = kreator nowego zaproszenia; gość = edycja (formularz prefill).
    @State private var formEditing: Guest?
    @State private var guestEvents: [AccessEvent] = []

    // Szczegóły / edycja gościa (2026-07-12) — tap na wiersz otwiera widok
    // z wysyłką zaproszenia (ShareLink), edycją pól, anulowaniem i
    // „Zaproś ponownie" dla wygasłych/anulowanych.
    @State private var editingGuest: Guest?
    @State private var editName = ""
    @State private var editPlate = ""
    @State private var editFrom = Date()
    @State private var editTo = Date()
    @State private var editBusy = false
    @State private var confirmCancelInvite = false
    @State private var editError: String?
    /// Toggle powiadomień o aktywności gościa w szczegółach (2026-08-14) —
    /// optimistic PATCH notifyOnUse z rollbackiem przy błędzie.
    @State private var editNotify = true

    // Swipe-to-delete (2026-07-13, wspólny GlassSwipeToDelete) — przesunięcie
    // w lewo odsłania kosz, pełny swipe usuwa od razu. Aktywny gość →
    // anulowanie, zakończony → twarde usunięcie z historii (ten sam endpoint
    // DELETE, patrz ResidentService.cancelGuest).
    @State private var swipedGuestId: Int?

    /// Zakładka listy — domyślnie „kto ma teraz dostęp".
    private enum ListTab: String, CaseIterable { case active = "Aktywne", scheduled = "Zaplanowane", history = "Historia" }
    @State private var listTab: ListTab = .active
    /// Przepustka, dla której pytamy o przedłużenie (lista i szczegóły).
    @State private var extendTarget: Guest?
    @State private var extendBusy = false
    /// Usunięcie WPISU z historii (osobne od cofnięcia dostępu).
    @State private var confirmDeleteEntry = false

    // Formularz
    @State private var name = ""
    @State private var plate = ""
    @State private var validFrom = Date()
    @State private var validTo = Date().addingTimeInterval(4 * 3600)
    /// Pushe o aktywności gościa (2026-08-14) — domyślnie WŁĄCZONE,
    /// wysyłane jako `notifyOnUse` w POST.
    @State private var notifyOnUse = true
    @State private var submitting = false
    @State private var formError: String?

    // Ograniczenia dostępu (2026-07-08) — parity z NewGuestView głównej apki.
    @State private var accessPoints: [AccessPoint] = []
    @State private var allEntrances = true
    @State private var selectedApIds: Set<Int> = []
    /// Limit otwarć per wejście. Brak klucza = bez limitu.
    @State private var apLimits: [Int: Int] = [:]
    /// „Wymagaj mojego zatwierdzenia" per wejście (2026-07-08) — sensowne
    /// tylko dla UNIT_DOOR (drzwi mieszkania); default ON przy zaznaczeniu.
    @State private var apApprovals: [Int: Bool] = [:]
    @State private var recurring = false
    /// Dni tygodnia ISO 1=pn..7=nd. Pusty zbiór = codziennie.
    @State private var selectedDays: Set<Int> = []
    @State private var scheduleFrom = Calendar.current.date(bySettingHour: 6, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var scheduleTo = Calendar.current.date(bySettingHour: 22, minute: 0, second: 0, of: Date()) ?? Date()

    var body: some View {
        listContent
            .task {
                await loadGuestEvents()
                await loadAccessPoints()
            }
            .task(id: initialGuestId) {
                guard let id = initialGuestId, editingGuest?.id != id,
                      let g = guests.first(where: { $0.id == id }) else { return }
                openEdit(g)
            }
            .fullScreenCover(item: $editingGuest) { g in
                detailScreen(g)
            }
            .fullScreenCover(isPresented: $showForm) {
                formScreen(editing: nil)
            }
    }

    /// Historia aktywności gości — fail-silent (bonus, nie blokuje listy).
    private func loadGuestEvents() async {
        if let resp: AccessEventsResponse = try? await APIClient.shared.get(
            "/resident/access-events?guestsOnly=true&limit=200"
        ) {
            guestEvents = resp.events.filter { $0.guestId != nil }
        }
    }

    /// Lista wejść do sekcji ograniczeń — fail-silent (stary backend /
    /// offline → sekcja pokazuje komunikat, zapis dalej działa).
    private func loadAccessPoints() async {
        if let aps: [AccessPoint] = try? await APIClient.shared.get("/resident/access-points") {
            accessPoints = aps.sorted { $0.sortOrder < $1.sortOrder }
        }
    }

    // MARK: Lista

    private var listContent: some View {
        VStack(spacing: 9) {
            GlassSheetHeader(kicker: "Goście", title: "Przepustki gości", onClose: onClose)

            tabPicker

            if visibleGuests.isEmpty {
                GlassSheetEmptyState(icon: "person.2", text: emptyText)
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(visibleGuests) { g in
                            let live = phase(g).isLive
                            GlassSwipeToDelete(
                                id: g.id,
                                openId: $swipedGuestId,
                                secondary: live
                                    ? GlassSwipeAction(icon: "clock.badge.checkmark", color: GlassColor.accentBlue,
                                                       label: "Przedłuż", action: { extendTarget = g })
                                    : GlassSwipeAction(icon: "arrow.clockwise", color: GlassColor.success,
                                                       label: "Zaproś ponownie", action: { reinvite(g) }),
                                confirmTitle: live ? revokeTitle(g) : "Usunąć wpis z historii?",
                                confirmMessage: live ? revokeMessage(g) : deleteEntryMessage(g),
                                destructiveLabel: live ? "Cofnij dostęp" : "Usuń wpis",
                                destructiveIcon: live ? "xmark.seal.fill" : "trash.fill",
                                onDelete: { await revokeOrDelete(g) },
                                onTap: { openEdit(g) }
                            ) { row(g) }
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }

            GlassButton(title: "+ Zaproś gościa") {
                resetFormForCreate()
                showForm = true
            }
            .padding(.top, 6)
        }
        .confirmationDialog(
            extendTarget.map { "Przedłużyć dostęp: \($0.name)?" } ?? "Przedłużyć dostęp?",
            isPresented: Binding(get: { extendTarget != nil && editingGuest == nil }, set: { if !$0 { extendTarget = nil } }),
            titleVisibility: .visible
        ) {
            extendOptions
        } message: {
            if let g = extendTarget { Text("Teraz ważna do \(Self.fullDate.string(from: g.validTo)).") }
        }
    }

    /// Zakładki z licznikami liczonymi z TEJ SAMEJ klasyfikacji co lista.
    private var tabPicker: some View {
        HStack(spacing: 6) {
            ForEach(ListTab.allCases, id: \.self) { tab in
                let count = guests(in: tab).count
                let selected = tab == listTab
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { listTab = tab; swipedGuestId = nil }
                } label: {
                    Text(count > 0 ? "\(tab.rawValue) (\(count))" : tab.rawValue)
                        .font(.system(size: 13, weight: selected ? .bold : .semibold))
                        .foregroundStyle(.white.opacity(selected ? 1 : 0.75))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background {
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .fill(Color.white.opacity(selected ? 0.18 : 0.06))
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .strokeBorder(Color.white.opacity(selected ? 0.4 : 0.12), lineWidth: 1)
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? [.isSelected] : [])
            }
        }
    }

    private var emptyText: String {
        switch listTab {
        case .active:    return "Nikt nie ma teraz aktywnej przepustki.\nZaproś gościa — dostanie PIN i link do bramy."
        case .scheduled: return "Brak zaplanowanych przepustek."
        case .history:   return "Historia przepustek jest pusta."
        }
    }

    // MARK: Swipe-to-delete (2026-07-13)

    /// Odpowiedź DELETE: `status` po operacji, `deleted` przy usunięciu wpisu,
    /// `revocation.edgeOnline` = czy sterownik osiedla był połączony w chwili
    /// cofnięcia (API 2026-09-21; starszy backend nie zwraca → nil).
    private struct RevokeResult: Decodable {
        struct Revocation: Decodable { let edgeOnline: Bool }
        let status: String?
        let deleted: Bool?
        let revocation: Revocation?
    }

    /// DELETE /resident/guests/:id — dwa RÓŻNE skutki tego samego endpointu:
    ///   • przepustka żywa → status CANCELLED + usunięcie PIN-u i tablicy
    ///     z bram przez trwałą kolejkę Edge (egzekwowane przez backend),
    ///   • przepustka zakończona → usunięcie wpisu z listy (zdarzenia
    ///     w historii osiedla zostają).
    /// Zwraca sukces — komponent swipe cofa animację przy błędzie.
    private func revokeOrDelete(_ g: Guest) async -> Bool {
        let wasLive = phase(g).isLive
        do {
            let result: RevokeResult = try await APIClient.shared.delete("/resident/guests/\(g.id)")
            await onReload()
            toast.show(Self.resultMessage(wasLive: wasLive, name: g.name, result: result))
            return true
        } catch {
            // Błąd = stan BEZ ZMIAN: przepustka nadal działa / wpis nadal jest.
            toast.show(wasLive
                       ? "Nie potwierdzono cofnięcia — \(g.name) nadal ma dostęp. Spróbuj ponownie."
                       : "Nie udało się usunąć wpisu.", error: true)
            return false
        }
    }

    private static func resultMessage(wasLive: Bool, name: String, result: RevokeResult) -> String {
        guard wasLive else { return "Wpis usunięty z historii" }
        switch result.revocation?.edgeOnline {
        case .some(true):
            return "Cofnięto dostęp: \(name). Usunięcie PIN-u i tablicy wysłane do bram."
        case .some(false):
            return "Cofnięto w systemie. Sterownik osiedla jest offline — PIN na klawiaturze może działać do ponownego połączenia."
        case .none:
            return "Cofnięto dostęp: \(name). Bramy otrzymują zmianę po synchronizacji."
        }
    }

    private func revokeTitle(_ g: Guest) -> String { "Cofnąć dostęp: \(g.name)?" }

    /// Konkretna przepustka, zakres i skutek — nie ogólne „usunąć?".
    private func revokeMessage(_ g: Guest) -> String {
        var parts = ["Przepustka ważna \(GlassFormat.guestWindow(g)) · \(scopeText(g))."]
        var lose = ["PIN \(g.pin)", "link"]
        if let p = g.vehiclePlate, !p.isEmpty { lose.append("tablica \(p)") }
        parts.append("Przestaną działać: \(lose.joined(separator: ", ")). Inne przepustki tej osoby pozostają bez zmian. Wpis zostanie w Historii.")
        return parts.joined(separator: "\n")
    }

    private func deleteEntryMessage(_ g: Guest) -> String {
        "Wpis „\(g.name)\" (\(phase(g).label.lowercased())) zniknie z tej listy. Nie zmienia to niczyjego dostępu; zdarzenia w historii osiedla zostają."
    }

    // MARK: Przedłużenie (PATCH validTo — obsługiwane dla aktywnych przepustek)

    @ViewBuilder
    private var extendOptions: some View {
        if let g = extendTarget {
            let base = max(g.validTo, Date())
            Button("+2 godziny") { Task { await extend(g, to: base.addingTimeInterval(2 * 3600)) } }
            Button("Do końca dnia") {
                let end = Calendar.current.date(bySettingHour: 23, minute: 59, second: 0, of: base) ?? base
                Task { await extend(g, to: end) }
            }
            Button("+1 dzień") { Task { await extend(g, to: base.addingTimeInterval(24 * 3600)) } }
            Button("+7 dni") { Task { await extend(g, to: base.addingTimeInterval(7 * 24 * 3600)) } }
            Button("Anuluj", role: .cancel) { extendTarget = nil }
        }
    }

    private func extend(_ g: Guest, to newEnd: Date) async {
        guard !extendBusy, newEnd > g.validTo else { extendTarget = nil; return }
        extendBusy = true
        defer { extendBusy = false; extendTarget = nil }
        struct Body: Encodable { let validTo: String }
        do {
            let updated: Guest = try await APIClient.shared.patch(
                "/resident/guests/\(g.id)", body: Body(validTo: GlassFormat.iso8601.string(from: newEnd)))
            await onReload()
            if editingGuest?.id == g.id { editingGuest = updated; editTo = updated.validTo }
            toast.show("Przedłużono do \(Self.fullDate.string(from: updated.validTo))")
        } catch {
            toast.show("Nie udało się przedłużyć — termin bez zmian.", error: true)
        }
    }

    private static let fullDate: DateFormatter = {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "d MMM yyyy, HH:mm"
        return df
    }()

    /// Otwiera widok szczegółów/edycji — kopiuje pola gościa do stanu.
    private func openEdit(_ g: Guest) {
        editName = g.name
        editPlate = g.vehiclePlate ?? ""
        editFrom = g.validFrom
        editTo = g.validTo
        editNotify = g.notifyOnUse ?? true
        editError = nil
        editingGuest = g
    }

    // MARK: Klasyfikacja przepustek (GuestPassPhase — testowana w LogicTests)

    /// Jedna definicja z licznikami na Domu — `Guest.passPhase` (GlassHubViews).
    private func phase(_ g: Guest, now: Date = Date()) -> GuestPassPhase {
        g.passPhase(now: now)
    }

    private func guests(in tab: ListTab) -> [Guest] {
        switch tab {
        case .active:    return guests.filter { phase($0) == .active }.sorted { $0.validTo < $1.validTo }
        case .scheduled: return guests.filter { phase($0) == .scheduled }.sorted { $0.validFrom < $1.validFrom }
        case .history:   return guests.filter { !phase($0).isLive }.sorted { $0.validTo > $1.validTo }
        }
    }

    /// Każda przepustka to osobny wiersz — nie scalamy historycznych wpisów
    /// tej samej osoby (mają niezależne zakresy i terminy).
    private var visibleGuests: [Guest] { guests(in: listTab) }

    /// Zakres dostępu słowami: „Wszystkie wejścia" albo nazwy wybranych.
    /// („Tylko 3 wejścia" czytało się jak limit użyć — to liczba PUNKTÓW.)
    private func scopeText(_ g: Guest) -> String {
        guard let allowed = g.allowedAccessPoints, !allowed.isEmpty else { return "Wszystkie wejścia" }
        let names = allowed.compactMap { entry in accessPoints.first(where: { $0.id == entry.apId })?.label }
        if names.isEmpty { return "Wybrane wejścia: \(allowed.count)" }
        let head = names.prefix(3).joined(separator: ", ")
        return names.count > 3 ? "\(head) +\(names.count - 3)" : head
    }

    /// „Pozostały 2 z 3 wejść" — tylko gdy dane o limicie istnieją.
    private func limitText(_ g: Guest) -> String? {
        let limited = (g.allowedAccessPoints ?? []).filter { $0.maxUses != nil }
        guard !limited.isEmpty, let left = g.totalRemainingUses else { return nil }
        let total = limited.reduce(0) { $0 + ($1.maxUses ?? 0) }
        return "Pozostało \(left) z \(total) otwarć"
    }

    private func validityText(_ g: Guest, phase p: GuestPassPhase) -> String {
        switch p {
        case .active:    return "Ważna do \(Self.fullDate.string(from: g.validTo))"
        case .scheduled: return "Od \(Self.fullDate.string(from: g.validFrom)) do \(Self.fullDate.string(from: g.validTo))"
        case .expired:   return "Wygasła \(Self.fullDate.string(from: g.validTo))"
        case .cancelled: return "Cofnięta · była ważna do \(Self.fullDate.string(from: g.validTo))"
        case .exhausted: return "Limit wykorzystany · termin do \(Self.fullDate.string(from: g.validTo))"
        }
    }

    private func phaseColor(_ p: GuestPassPhase) -> Color {
        switch p {
        case .active:    return GlassColor.successLight
        case .scheduled: return GlassColor.accentLight
        case .exhausted: return GlassColor.orbAmber1
        case .expired, .cancelled: return Color.white.opacity(0.6)
        }
    }

    /// Wiersz: KTO → DO KIEDY → DOKĄD → STAN. PIN, link, limit i historia
    /// są w szczegółach (dotknięcie) — nie konkurują z tym, co najważniejsze.
    private func row(_ g: Guest) -> some View {
        let p = phase(g)

        return GlassActionRow(
            orbGradient: p == .active
                ? [GlassColor.success, GlassColor.accentBlue]
                : (p == .scheduled
                    ? [GlassColor.accentLight, GlassColor.accentBlue]
                    : [Color.white.opacity(0.2), Color.white.opacity(0.1)]),
            orbIcon: "person.fill",
            title: g.name,
            subtitle: validityText(g, phase: p),
            dimmed: !p.isLive,
            trailing: { rowMenu(g, phase: p) },
            extra: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 5) {
                        Image(systemName: "door.left.hand.open")
                            .font(.system(size: 10.5, weight: .semibold))
                        Text(scopeText(g))
                            .font(.system(size: 12, weight: .medium))
                            .lineLimit(1)
                    }
                    .foregroundStyle(.white.opacity(0.78))

                    Text(p.label)
                        .font(.system(size: 11.5, weight: .bold))
                        .foregroundStyle(phaseColor(p))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background { Capsule().fill(phaseColor(p).opacity(0.14)) }
                }
                .padding(.top, 3)
            }
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(g.name). \(validityText(g, phase: p)). \(scopeText(g)). \(p.label).")
        .accessibilityHint("Otwiera szczegóły przepustki")
    }

    /// Jawne, NAZWANE akcje zależne od stanu (bez znajomości gestów).
    private func rowMenu(_ g: Guest, phase p: GuestPassPhase) -> some View {
        Menu {
            if p.isLive {
                if let url = g.portalUrl() {
                    ShareLink(item: url, message: Text(shareMessage(g))) {
                        Label("Udostępnij", systemImage: "square.and.arrow.up")
                    }
                } else {
                    ShareLink(item: shareMessage(g)) { Label("Udostępnij", systemImage: "square.and.arrow.up") }
                }
                Button { extendTarget = g } label: { Label("Przedłuż", systemImage: "clock.badge.checkmark") }
                Button { openEdit(g) } label: { Label("Szczegóły i edycja", systemImage: "pencil") }
                Button(role: .destructive) {
                    swipedGuestId = nil
                    openEdit(g)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { confirmCancelInvite = true }
                } label: { Label("Cofnij dostęp", systemImage: "xmark.seal") }
            } else {
                Button { reinvite(g) } label: { Label("Zaproś ponownie", systemImage: "arrow.clockwise") }
                Button { openEdit(g) } label: { Label("Szczegóły", systemImage: "info.circle") }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(.white.opacity(0.75))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Akcje: \(g.name)")
    }

    private func shareMessage(_ g: Guest) -> String {
        g.portalUrl() != nil
            ? "Cześć \(g.name)! Zapraszam Cię — otwórz link i naciśnij przycisk przy bramie. PIN do domofonu: \(g.pin)"
            : "Cześć \(g.name)! Twój PIN do domofonu: \(g.pin) (ważny \(GlassFormat.guestWindow(g)))."
    }

    // MARK: Historia aktywności gościa (2026-07-07)

    private func events(for g: Guest) -> [AccessEvent] {
        guestEvents.filter { $0.guestId == g.id }
    }

    /// Krótki polski opis zdarzenia gościa (bez imienia — jesteśmy w wierszu
    /// tego gościa, kontekst oczywisty). Spójne z GuestsView głównej apki.
    private func guestEventTitle(_ ev: AccessEvent) -> String {
        switch ev.type {
        case "PIN_USED":      return ev.gateOpened ? "PIN na domofonie" : "Odrzucony PIN"
        case "LPR_MATCH":     return "Wjazd autem \(ev.plate ?? "")"
        case "LPR_NO_MATCH":  return "Tablica odrzucona \(ev.plate ?? "")"
        case "REMOTE_OPEN":   return "Otwarcie przez portal"
        case "MANUAL_OPEN":   return "Otwarcie ręczne"
        case "INTERCOM_CALL": return "Wezwanie domofonu"
        default:              return ev.typeLabel
        }
    }

    // MARK: Szczegóły zaproszenia — PEŁNY EKRAN (redesign v2, 2026-08-14)
    //
    // Read-first jak karta w Apple Wallet: PIN i wysyłka od razu widoczne,
    // edycja pól przeniesiona do formularza (przycisk „Edytuj"). Dzięki
    // pełnemu ekranowi kluczowa treść mieści się bez przewijania.

    private func detailScreen(_ g: Guest) -> some View {
        let p = phase(g)
        return fullScreenScaffold(kicker: "Gość", title: "Szczegóły przepustki", onClose: { editingGuest = nil }) {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 14) {
                    guestHeaderCard(g)

                    if p.isLive {
                        pinHero(g)
                        shareInviteButton(g)

                        sectionLabel("Ważność i zakres")
                        readonlyRow("Od", Self.fullDate.string(from: g.validFrom))
                        readonlyRow("Do", Self.fullDate.string(from: g.validTo))
                        readonlyRow("Zakres dostępu", scopeText(g))
                        if let sched = g.recurringSchedule {
                            readonlyRow("Harmonogram", sched.summary)
                        }
                        if let limit = limitText(g) {
                            readonlyRow("Limit", limit)
                        }
                        if let plate = g.vehiclePlate, !plate.isEmpty {
                            readonlyRow("Tablica", plate)
                        }
                        if let phone = g.phone, !phone.isEmpty {
                            readonlyRow("Telefon", phone)
                        }

                        sectionLabel("Powiadomienia")
                        toggleRow("Powiadamiaj o aktywności gościa", isOn: notifyBinding(g))
                        sectionCaption("Powiadomienie przy każdym wjeździe, wyjeździe i użyciu PIN-u.")

                        detailHistory(g)
                    } else {
                        Text(historyExplanation(p))
                            .font(.system(size: 13.5))
                            .foregroundStyle(.white.opacity(0.75))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background {
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .fill(Color.white.opacity(0.07))
                            }
                    }

                    if let editError {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "xmark.octagon.fill")
                                .font(.system(size: 14))
                                .foregroundStyle(GlassColor.dangerSoft)
                            Text(editError)
                                .font(.system(size: 12.5))
                                .foregroundStyle(.white.opacity(0.85))
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(13)
                        .background {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(GlassColor.danger.opacity(0.12))
                        }
                    }
                }
                .padding(.bottom, 8)
            }
            .scrollBounceBehavior(.basedOnSize)

            VStack(spacing: 10) {
                if p.isLive {
                    HStack(spacing: 10) {
                        GlassButton(title: "Przedłuż", style: .ghost) { extendTarget = g }
                            .disabled(editBusy || extendBusy)
                        GlassButton(title: "Edytuj", style: .ghost) {
                        name = g.name
                        plate = g.vehiclePlate ?? ""
                        validFrom = g.validFrom
                        validTo = g.validTo
                        notifyOnUse = g.notifyOnUse ?? true
                        formError = nil
                        // Cover edycji jest przypięty DO TEGO ekranu (nie do
                        // listy pod spodem) — prezentacja z zakrytego widoku
                        // po cichu nie działa (pułapka fullScreenCover).
                        formEditing = g
                        }
                        .disabled(editBusy)
                    }

                    Button {
                        confirmCancelInvite = true
                    } label: {
                        HStack(spacing: 8) {
                            if editBusy {
                                ProgressView().tint(GlassColor.dangerSoft).scaleEffect(0.8)
                            } else {
                                Image(systemName: "xmark.seal.fill").font(.system(size: 14, weight: .semibold))
                            }
                            Text(editBusy ? "Trwa cofanie dostępu…" : "Cofnij dostęp")
                                .font(.system(size: 15, weight: .semibold))
                        }
                        .foregroundStyle(GlassColor.dangerSoft)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background {
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(GlassColor.danger.opacity(0.12))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                                        .strokeBorder(GlassColor.dangerSoft.opacity(0.45), lineWidth: 1)
                                }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(editBusy)
                } else {
                    GlassButton(title: "Zaproś ponownie") {
                        reinvite(g)
                    }
                    GlassButton(title: "Usuń wpis z historii", style: .ghost) {
                        confirmDeleteEntry = true
                    }
                    .disabled(editBusy)
                }
            }
        }
        .confirmationDialog(revokeTitle(g), isPresented: $confirmCancelInvite, titleVisibility: .visible) {
            Button("Cofnij dostęp", role: .destructive) { Task { await cancelInvite(g) } }
            Button("Wróć", role: .cancel) {}
        } message: {
            Text(revokeMessage(g))
        }
        .confirmationDialog("Usunąć wpis z historii?", isPresented: $confirmDeleteEntry, titleVisibility: .visible) {
            Button("Usuń wpis", role: .destructive) { Task { await cancelInvite(g) } }
            Button("Wróć", role: .cancel) {}
        } message: {
            Text(deleteEntryMessage(g))
        }
        .confirmationDialog(
            "Przedłużyć dostęp: \(g.name)?",
            isPresented: Binding(get: { extendTarget?.id == g.id }, set: { if !$0 { extendTarget = nil } }),
            titleVisibility: .visible
        ) {
            extendOptions
        } message: {
            Text("Teraz ważna do \(Self.fullDate.string(from: g.validTo)).")
        }
        .fullScreenCover(item: $formEditing) { g in
            // UŻYWAMY parametru closure'a, nie stanu — pierwsza klatka covera
            // potrafi renderować się ze STARYM snapshotem stanu (klasyczny
            // stale-capture .fullScreenCover/item), przez co formularz
            // otwierał się w trybie „Utwórz" mimo ustawionego formEditing.
            formScreen(editing: g)
        }
    }

    /// Pełnoekranowy szkielet dla szczegółów i formularza: tło Glass,
    /// nagłówek z kickerem i ✕, treść, akcje przypięte na dole.
    private func fullScreenScaffold<Content: View>(
        kicker: String,
        title: String,
        onClose: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) -> some View {
        ZStack {
            GlassBackground(tod: .fromClock())
                .ignoresSafeArea()

            // Czytelność (2026-08-19, feedback Konrada): pełnoekranowy
            // formularz leżał wprost na tle pory dnia — w wariancie DZIENNYM
            // (jasne niebo, brightness ~1.0) pola white 0.08 i podpowiedzi
            // white 0.5 znikały. Ciemny scrim daje STAŁY kontrast o każdej
            // porze; tło zostaje jako delikatna poświata przy krawędziach.
            Color(hex: 0x0A0E1E).opacity(0.82)
                .ignoresSafeArea()

            VStack(spacing: 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(kicker.uppercased())
                            .font(.system(size: 11, weight: .bold))
                            .tracking(1.4)
                            .foregroundStyle(GlassColor.accentLight.opacity(0.9))
                        Text(title)
                            .font(.system(size: 24, weight: .bold))
                            .foregroundStyle(.white)
                    }
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(.white.opacity(0.8))
                            .frame(width: 34, height: 34)
                            .background { Circle().fill(Color.white.opacity(0.1)) }
                            .overlay { Circle().strokeBorder(Color.white.opacity(0.16), lineWidth: 1) }
                    }
                    .buttonStyle(.plain)
                }

                content()
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 10)
        }
        .preferredColorScheme(.dark)
    }

    /// Karta nagłówka (redesign 2026-08-14, hierarchia jak Wallet): duże
    /// imię + kolorowa plakietka statusu. PIN przeniesiony do własnego
    /// wyróżnionego bloku `pinHero` pod spodem.
    private func guestHeaderCard(_ g: Guest) -> some View {
        HStack(spacing: 14) {
            GlassOrb(
                gradient: phase(g).isLive
                    ? [GlassColor.success, GlassColor.accentBlue]
                    : [Color.white.opacity(0.25), Color.white.opacity(0.12)],
                systemName: "person.fill",
                size: 52
            )
            VStack(alignment: .leading, spacing: 7) {
                Text(g.name)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                statusBadge(g)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .glassCard()
    }

    /// Kolorowa plakietka statusu (kapsuła z tintowanym tłem).
    private func statusBadge(_ g: Guest) -> some View {
        let p = phase(g)
        let color = phaseColor(p)
        return Text(p.label.uppercased())
            .font(.system(size: 11, weight: .bold))
            .tracking(0.6)
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background { Capsule().fill(color.opacity(0.16)) }
            .overlay { Capsule().strokeBorder(color.opacity(0.4), lineWidth: 1) }
    }

    private func historyExplanation(_ p: GuestPassPhase) -> String {
        switch p {
        case .cancelled: return "Dostęp został cofnięty — PIN, link i tablica tej przepustki nie działają. Możesz zaprosić tę osobę ponownie: dostanie nowy PIN i nowy link."
        case .exhausted: return "Limit otwarć tej przepustki został wykorzystany, więc nie daje już dostępu. Możesz zaprosić tę osobę ponownie."
        default:         return "Przepustka wygasła. Możesz zaprosić tę osobę ponownie — dostanie nowy PIN i nowy link."
        }
    }

    /// Historia użycia TEJ przepustki (przeniesiona z wiersza listy).
    @ViewBuilder
    private func detailHistory(_ g: Guest) -> some View {
        let evs = events(for: g)
        sectionLabel("Historia użycia")
        if evs.isEmpty {
            sectionCaption("Brak zarejestrowanych zdarzeń tej przepustki.")
        } else {
            VStack(spacing: 6) {
                ForEach(Array(evs.prefix(12))) { ev in
                    HStack(spacing: 9) {
                        Image(systemName: ev.icon)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(ev.gateOpened ? GlassColor.successLight : GlassColor.dangerSoft)
                            .frame(width: 26, height: 26)
                            .background {
                                Circle().fill((ev.gateOpened ? GlassColor.success : GlassColor.danger).opacity(0.14))
                            }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(guestEventTitle(ev))
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(.white.opacity(0.92))
                            Text([ev.accessPointLabel, Self.fullDate.string(from: ev.date)].compactMap { $0 }.joined(separator: " · "))
                                .font(.system(size: 11.5))
                                .foregroundStyle(.white.opacity(0.6))
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// PIN — duży, monospaced, kopiowalny tapem (toast „PIN skopiowany").
    private func pinHero(_ g: Guest) -> some View {
        Button {
            UIPasteboard.general.string = g.pin
            toast.show("PIN skopiowany")
        } label: {
            VStack(spacing: 5) {
                Text("PIN DO DOMOFONU")
                    .font(.system(size: 10.5, weight: .bold))
                    .tracking(1.2)
                    .foregroundStyle(.white.opacity(0.55))
                Text(g.pin)
                    .font(.system(size: 34, weight: .bold, design: .monospaced))
                    .tracking(7)
                    .foregroundStyle(.white)
                HStack(spacing: 5) {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 10, weight: .semibold))
                    Text("Dotknij, aby skopiować")
                        .font(.system(size: 11, weight: .medium))
                }
                .foregroundStyle(GlassColor.accentLight.opacity(0.85))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background {
                RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                    .fill(GlassColor.accentBlue.opacity(0.16))
            }
            .overlay {
                RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                    .strokeBorder(GlassColor.accentLight.opacity(0.4), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
    }

    /// Etykieta sekcji (jak w GlassMoreSheet) — uppercase z trackingiem.
    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .bold))
            .tracking(0.8)
            .foregroundStyle(.white.opacity(0.72))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
    }

    /// Drobny podpis pod wierszem sekcji.
    private func sectionCaption(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(.white.opacity(0.62))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Wiersz read-only (np. telefon z zaproszenia utworzonego w głównej apce).
    private func readonlyRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
            Spacer()
            Text(value)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.9))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.08))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
    }

    /// Optimistic toggle notifyOnUse: UI od razu, PATCH w tle, rollback
    /// + toast przy błędzie.
    private func notifyBinding(_ g: Guest) -> Binding<Bool> {
        Binding(
            get: { editNotify },
            set: { newValue in
                let previous = editNotify
                editNotify = newValue
                Task {
                    struct Body: Encodable { let notifyOnUse: Bool }
                    do {
                        let _: Guest = try await APIClient.shared.patch(
                            "/resident/guests/\(g.id)",
                            body: Body(notifyOnUse: newValue)
                        )
                        await onReload()
                    } catch {
                        editNotify = previous
                        toast.show("Nie udało się zapisać ustawienia powiadomień", error: true)
                    }
                }
            }
        )
    }

    /// „Wyślij zaproszenie" — link Guest Pass jako OSOBNY item URL (iMessage
    /// renderuje wtedy elegancką kartę podglądu „Zaproszenie · GateLynk"
    /// zamiast surowego linku w tekście), wiadomość bez URL-a w treści.
    /// Legacy gość bez urlToken → sama wiadomość z PIN-em.
    @ViewBuilder
    private func shareInviteButton(_ g: Guest) -> some View {
        if let url = g.portalUrl() {
            ShareLink(
                item: url,
                message: Text("Cześć \(g.name)! Zapraszam Cię — otwórz link i naciśnij przycisk przy bramie. PIN do domofonu: \(g.pin)")
            ) {
                shareInviteLabel
            }
            .buttonStyle(.plain)
        } else {
            ShareLink(
                item: "Cześć \(g.name)! Twój PIN do domofonu: \(g.pin) (ważny \(GlassFormat.guestWindow(g)))."
            ) {
                shareInviteLabel
            }
            .buttonStyle(.plain)
        }
    }

    private var shareInviteLabel: some View {
        HStack(spacing: 8) {
            Image(systemName: "paperplane.fill").font(.system(size: 14, weight: .semibold))
            Text("Udostępnij przepustkę")
                .font(.system(size: 15, weight: .semibold))
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(GlassColor.accentBlue.opacity(0.30))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(GlassColor.accentLight.opacity(0.5), lineWidth: 1)
                }
        }
    }

    /// Etykieta + pole — czytelniejsze niż sam placeholder przy prefill-u.
    private func labeledField(_ label: String, text: Binding<String>, autocapitalize: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label.uppercased())
                .font(.system(size: 11, weight: .bold))
                .tracking(0.8)
                .foregroundStyle(.white.opacity(0.6))
            formField(label, text: text, autocapitalize: autocapitalize)
        }
    }

    private struct PatchGuestBody: Encodable {
        let name: String
        let vehiclePlate: String?
        let validFrom: String
        let validTo: String
        let notifyOnUse: Bool

        enum CodingKeys: String, CodingKey { case name, vehiclePlate, validFrom, validTo, notifyOnUse }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(name, forKey: .name)
            // Jawny null czyści tablicę (pominięcie klucza = „bez zmian" w API).
            try c.encode(vehiclePlate, forKey: .vehiclePlate)
            try c.encode(validFrom, forKey: .validFrom)
            try c.encode(validTo, forKey: .validTo)
            try c.encode(notifyOnUse, forKey: .notifyOnUse)
        }
    }

    /// Zapis EDYCJI z formularza (redesign v2): wspólne pola z kreatorem.
    /// Po sukcesie zamykamy formularz i szczegóły — lista pokaże świeży stan.
    private func saveEditFromForm(_ g: Guest) async {
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty else {
            formError = "Podaj imię gościa."
            return
        }
        guard validTo > validFrom else {
            formError = "Koniec okna czasowego musi być po początku."
            return
        }
        submitting = true
        formError = nil
        let trimmedPlate = plate.trimmingCharacters(in: .whitespaces).uppercased()
        do {
            let _: Guest = try await APIClient.shared.patch(
                "/resident/guests/\(g.id)",
                body: PatchGuestBody(
                    name: trimmedName,
                    vehiclePlate: trimmedPlate.isEmpty ? nil : trimmedPlate,
                    validFrom: GlassFormat.iso8601.string(from: validFrom),
                    validTo: GlassFormat.iso8601.string(from: validTo),
                    notifyOnUse: notifyOnUse
                )
            )
            await onReload()
            toast.show("Zapisano zmiany zaproszenia")
            formEditing = nil
            editingGuest = nil
        } catch {
            formError = error.localizedDescription
        }
        submitting = false
    }

    /// Cofnięcie dostępu / usunięcie wpisu ze szczegółów. „Trwa cofanie…"
    /// widać do odpowiedzi serwera; sukces ogłaszamy dopiero po niej,
    /// a przy błędzie mówimy wprost, że dostęp NIE został cofnięty.
    private func cancelInvite(_ g: Guest) async {
        guard !editBusy else { return }
        let wasLive = phase(g).isLive
        editBusy = true
        editError = nil
        do {
            let result: RevokeResult = try await APIClient.shared.delete("/resident/guests/\(g.id)")
            await onReload()
            toast.show(Self.resultMessage(wasLive: wasLive, name: g.name, result: result))
            editingGuest = nil
        } catch {
            editError = wasLive
                ? "Nie potwierdzono cofnięcia — \(g.name) NADAL ma dostęp. Sprawdź połączenie i spróbuj ponownie. (\(error.localizedDescription))"
                : "Nie udało się usunąć wpisu. (\(error.localizedDescription))"
        }
        editBusy = false
    }

    /// „Zaproś ponownie" — prefill kreatora danymi gościa; POST tworzy nowe
    /// zaproszenie (nowy PIN, nowy link), stare zostaje w historii.
    private func reinvite(_ g: Guest) {
        name = g.name
        plate = g.vehiclePlate ?? ""
        validFrom = Date()
        validTo = Date().addingTimeInterval(4 * 3600)
        notifyOnUse = g.notifyOnUse ?? true
        formError = nil
        formEditing = nil
        editingGuest = nil
        // Kreator startuje po zamknięciu covera szczegółów — równoczesny
        // dismiss + present gubi prezentację (ta sama pułapka co „Edytuj").
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            showForm = true
        }
    }

    /// Czysty kreator — reset pól po poprzednim użyciu (create/edit/reinvite).
    private func resetFormForCreate() {
        name = ""
        plate = ""
        validFrom = Date()
        validTo = Date().addingTimeInterval(4 * 3600)
        notifyOnUse = true
        allEntrances = true
        selectedApIds = []
        apLimits = [:]
        apApprovals = [:]
        recurring = false
        formError = nil
        formEditing = nil
    }

    // MARK: Formularz — PEŁNY EKRAN (redesign v2, 2026-08-14)

    private func formScreen(editing: Guest?) -> some View {
        fullScreenScaffold(
            kicker: editing == nil ? "Goście" : "Gość",
            title: editing == nil ? "Zaproś gościa" : "Edytuj zaproszenie",
            onClose: { if editing != nil { formEditing = nil } else { showForm = false } }
        ) {
            // ScrollView — po dodaniu sekcji ograniczeń (2026-07-08) formularz
            // bywa wyższy niż sheet; przyciski akcji zostają przypięte na dole.
            // Redesign 2026-08-14: sekcje z etykietami (jak GlassMoreSheet) —
            // Gość / Pojazd / Okres ważności / Powiadomienia / Ograniczenia.
            ScrollView(showsIndicators: false) {
                VStack(spacing: 11) {
                    sectionLabel("Gość")
                    formField("Imię i nazwisko gościa", text: $name)

                    sectionLabel("Pojazd")
                    formField("Tablica rejestracyjna (opcjonalnie)", text: $plate, autocapitalize: true)

                    sectionLabel("Okres ważności")
                    datePickerRow("Od", selection: $validFrom)
                    datePickerRow("Do", selection: $validTo)

                    // Powiadomienia o aktywności gościa (2026-08-14).
                    sectionLabel("Powiadomienia")
                    toggleRow("Powiadamiaj o aktywności gościa", isOn: $notifyOnUse)
                    sectionCaption("Push przy każdym wjeździe, wyjeździe i użyciu PIN-u.")

                    // Ograniczenia tylko przy TWORZENIU (edycja nie wysyła ich
                    // w PATCH — jak dotąd; bez sekcji nie sugerujemy inaczej).
                    if editing == nil {
                        sectionLabel("Ograniczenia dostępu")
                        entrancesSection
                        scheduleSection
                    }

                    if let formError {
                        Text(formError)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(GlassColor.dangerSoft)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)

            GlassButton(
                title: editing == nil ? "Utwórz zaproszenie" : "Zapisz zmiany",
                busyText: editing == nil ? "Tworzę…" : "Zapisuję…",
                isBusy: submitting
            ) {
                if let g = editing {
                    Task { await saveEditFromForm(g) }
                } else {
                    Task { await submit() }
                }
            }

            GlassButton(title: "Wróć", style: .ghost) {
                if editing != nil { formEditing = nil } else { showForm = false }
            }
        }
    }

    // MARK: Ograniczenia dostępu — sekcje formularza (2026-07-08)

    /// Sekcja „Wejścia dla gościa": toggle „Wszystkie wejścia" (default ON),
    /// po wyłączeniu lista wejść z checkboxami + limit otwarć per wejście.
    @ViewBuilder
    private var entrancesSection: some View {
        toggleRow("Wszystkie wejścia", isOn: $allEntrances.animation())
        if !allEntrances {
            if accessPoints.isEmpty {
                Text("Nie udało się pobrać listy wejść.")
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.5))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(accessPoints) { ap in
                apRow(ap)
            }
        }
    }

    /// Sekcja „Kiedy dostęp działa": toggle „Cyklicznie" (default OFF =
    /// przez cały okres ważności), po włączeniu chipy dni + okno godzinowe.
    @ViewBuilder
    private var scheduleSection: some View {
        toggleRow("Cyklicznie", isOn: $recurring.animation())
        if recurring {
            dayChips
            datePickerRow("Od godz.", selection: $scheduleFrom, components: .hourAndMinute)
            datePickerRow("Do godz.", selection: $scheduleTo, components: .hourAndMinute)
            HStack(spacing: 5) {
                Image(systemName: "clock.arrow.2.circlepath")
                    .font(.system(size: 10, weight: .semibold))
                Text(draftSchedule.summary)
                    .font(.system(size: 11.5, weight: .medium))
            }
            .foregroundStyle(GlassColor.accentLight.opacity(0.85))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Wiersz toggle w stylu datePickerRow (kapsuła glass + label po lewej).
    private func toggleRow(_ label: String, isOn: Binding<Bool>) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.88))
            Spacer()
            Toggle("", isOn: isOn)
                .labelsHidden()
                .tint(GlassColor.accentBlue)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.08))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
    }

    /// Bursztynowy akcent UNIT_DOOR — spójny z deckiem i GlassGateSheet.
    private static let amber = Color(hex: 0xFFB020)

    /// Wiersz wejścia: checkbox z nazwą, po zaznaczeniu kompaktowy stepper
    /// limitu otwarć (− / +, 0 = bez limitu).
    /// UNIT_DOOR (2026-07-08): klucz + bursztyn + podpis „Drzwi mieszkania";
    /// zaznaczenie ustawia domyślny limit 1 (edytowalny) i toggle
    /// „Wymagaj mojego zatwierdzenia" (default ON).
    private func apRow(_ ap: AccessPoint) -> some View {
        let selected = selectedApIds.contains(ap.id)
        return VStack(spacing: 7) {
            Button {
                withAnimation {
                    if selected {
                        selectedApIds.remove(ap.id)
                        apLimits[ap.id] = nil
                        apApprovals[ap.id] = nil
                    } else {
                        selectedApIds.insert(ap.id)
                        if ap.isUnitDoor {
                            if apLimits[ap.id] == nil { apLimits[ap.id] = 1 }
                            apApprovals[ap.id] = true
                        }
                    }
                }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(selected
                                         ? (ap.isUnitDoor ? Self.amber : GlassColor.accentLight)
                                         : .white.opacity(0.35))
                    if ap.isUnitDoor {
                        Image(systemName: "key.fill")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Self.amber)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(ap.label)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(.white.opacity(selected ? 0.95 : 0.7))
                            Text("Drzwi mieszkania")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(Self.amber.opacity(0.9))
                        }
                    } else {
                        Text(ap.label)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.white.opacity(selected ? 0.95 : 0.7))
                    }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if selected {
                HStack {
                    let limit = apLimits[ap.id] ?? 0
                    Text(limit == 0 ? "Bez limitu otwarć" : "Limit: \(limit) otw.")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(.white.opacity(0.55))
                    Spacer()
                    limitButton("minus") {
                        let v = max(0, (apLimits[ap.id] ?? 0) - 1)
                        apLimits[ap.id] = v == 0 ? nil : v
                    }
                    limitButton("plus") {
                        apLimits[ap.id] = min(99, (apLimits[ap.id] ?? 0) + 1)
                    }
                }

                if ap.isUnitDoor {
                    HStack {
                        Text("Wymagaj mojego zatwierdzenia")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(.white.opacity(0.7))
                        Spacer()
                        Toggle("", isOn: Binding(
                            get: { apApprovals[ap.id] ?? false },
                            set: { apApprovals[ap.id] = $0 ? true : nil }
                        ))
                        .labelsHidden()
                        .tint(Self.amber)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(ap.isUnitDoor ? Self.amber.opacity(0.10) : Color.white.opacity(0.08))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .strokeBorder(
                    ap.isUnitDoor ? Self.amber.opacity(0.4) : Color.white.opacity(0.14),
                    lineWidth: 1
                )
        }
    }

    /// Okrągły przycisk −/+ dla limitu otwarć.
    private func limitButton(_ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 26, height: 26)
                .background { Circle().fill(Color.white.opacity(0.12)) }
                .overlay { Circle().strokeBorder(Color.white.opacity(0.18), lineWidth: 1) }
        }
        .buttonStyle(.plain)
    }

    private static let dayChipLabels = ["Pn", "Wt", "Śr", "Czw", "Pt", "Sb", "Nd"]

    /// Chipy dni tygodnia (multi-select, ISO 1=pn..7=nd). Puste = codziennie.
    private var dayChips: some View {
        HStack(spacing: 5) {
            ForEach(1...7, id: \.self) { day in
                let on = selectedDays.contains(day)
                Button {
                    if on { selectedDays.remove(day) } else { selectedDays.insert(day) }
                } label: {
                    Text(Self.dayChipLabels[day - 1])
                        .font(.system(size: 11, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background {
                            Capsule().fill(on ? GlassColor.accentBlue.opacity(0.55) : Color.white.opacity(0.08))
                        }
                        .overlay {
                            Capsule().strokeBorder(
                                on ? GlassColor.accentLight.opacity(0.6) : Color.white.opacity(0.14),
                                lineWidth: 1
                            )
                        }
                        .foregroundStyle(on ? .white : .white.opacity(0.6))
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Harmonogram z aktualnego stanu formularza — preview + wysyłka.
    private var draftSchedule: GuestRecurringSchedule {
        GuestRecurringSchedule(
            days: selectedDays.isEmpty ? nil : selectedDays.sorted(),
            startTime: Self.hhmm(scheduleFrom),
            endTime: Self.hhmm(scheduleTo),
            tz: TimeZone.current.identifier
        )
    }

    /// Ograniczenie wejść z formularza. nil = bez ograniczeń (toggle ON
    /// albo nic nie zaznaczono) — pola nie idą wtedy do JSON-a.
    private var draftAllowedAccessPoints: [AllowedAccessPointEntry]? {
        guard !allEntrances, !selectedApIds.isEmpty else { return nil }
        let known = accessPoints.map(\.id).filter { selectedApIds.contains($0) }
        let unknown = selectedApIds.subtracting(known).sorted()
        return (known + unknown).map {
            AllowedAccessPointEntry(
                apId: $0,
                maxUses: apLimits[$0],
                // Encodowane tylko gdy true (nil pomijany w JSON-ie).
                approvalRequired: apApprovals[$0] == true ? true : nil
            )
        }
    }

    /// Date → „HH:mm" (format kontraktu API).
    private static func hhmm(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    private func formField(_ placeholder: String, text: Binding<String>, autocapitalize: Bool = false) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundStyle(.white.opacity(0.62)))
            .textInputAutocapitalization(autocapitalize ? .characters : .words)
            .autocorrectionDisabled()
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background { Capsule().fill(Color(hex: 0x151C33).opacity(0.92)) }
            .overlay { Capsule().strokeBorder(Color.white.opacity(0.22), lineWidth: 1) }
    }

    private func datePickerRow(_ label: String, selection: Binding<Date>, components: DatePickerComponents = [.date, .hourAndMinute]) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.88))
            Spacer()
            DatePicker("", selection: selection, displayedComponents: components)
                .labelsHidden()
                .environment(\.locale, Locale(identifier: "pl_PL"))
                .tint(GlassColor.accentLight)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.08))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
    }

    private func submit() async {
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty else {
            formError = "Podaj imię gościa."
            return
        }
        guard validTo > validFrom else {
            formError = "Koniec okna czasowego musi być po początku."
            return
        }
        submitting = true
        formError = nil

        let trimmedPlate = plate.trimmingCharacters(in: .whitespaces).uppercased()
        let body = CreateGuestBody(
            name: trimmedName,
            phone: nil,
            email: nil,
            vehiclePlate: trimmedPlate.isEmpty ? nil : trimmedPlate,
            validFrom: GlassFormat.iso8601.string(from: validFrom),
            validTo: GlassFormat.iso8601.string(from: validTo),
            // Ograniczenia (2026-07-08) — nil = pola pominięte w JSON-ie,
            // body identyczne jak dotąd (stary backend OK).
            allowedAccessPoints: draftAllowedAccessPoints,
            recurringSchedule: recurring ? draftSchedule : nil,
            notifyOnUse: notifyOnUse
        )
        do {
            let created: Guest = try await APIClient.shared.post("/resident/guests", body: body)
            await onReload()
            toast.show("Zaproszenie gotowe · PIN \(created.pin)")
            name = ""; plate = ""
            // Reset sekcji ograniczeń — kolejne zaproszenie startuje czyste.
            allEntrances = true
            selectedApIds = []
            apLimits = [:]
            apApprovals = [:]
            recurring = false
            selectedDays = []
            notifyOnUse = true
            showForm = false
        } catch {
            formError = error.localizedDescription
        }
        submitting = false
    }
}

// MARK: - GlassGuestEventSheet (deep-link z pusha „Gość wjechał/wyjechał", 2026-08-13)
//
// Cel deep-linku z pusha GUEST_FIRST_USE / GUEST_USE / GUEST_EXIT — routing
// przez GlassHomeView (`activeSheet = .guestEvent(route)`, wzorzec jak
// pushTicketId). Kadr z odczytu LPR z podpisanego linku `imageUrl` (ważny
// ~2 h — po wygaśnięciu 404, AsyncImage degraduje się do placeholdera bez
// błędu na twarz), nagłówek wg kind, czas z `ts` („dziś o HH:MM") oraz
// szczegóły gościa dociągnięte z GET /resident/guests (model Guest z Models).

struct GlassGuestEventSheet: View {
    let route: GuestEventPushRoute
    let onClose: () -> Void

    @State private var guest: Guest?
    /// true po zakończeniu fetch-u (odróżnia „wczytuję" od „nie znaleziono").
    @State private var guestLoaded = false

    var body: some View {
        VStack(spacing: 12) {
            GlassSheetHeader(
                kicker: "Goście",
                title: route.isExit ? "Gość wyjechał" : "Gość wjechał",
                onClose: onClose
            )

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 12) {
                    eventPhoto
                    eventHeader
                    detailsCard
                }
                .padding(.bottom, 6)
            }
            .scrollBounceBehavior(.basedOnSize)

            GlassButton(title: "Zamknij", style: .ghost) { onClose() }
        }
        .task { await loadGuest() }
    }

    // MARK: Kadr z LPR

    @ViewBuilder
    private var eventPhoto: some View {
        if let urlString = route.imageUrl, let url = URL(string: urlString) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: .infinity)
                        .frame(height: 200)
                        .clipShape(RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous))
                case .failure:
                    // Podpisany link wygasł (~2 h → 404) albo brak sieci —
                    // placeholder, szczegóły niżej dalej działają.
                    photoPlaceholder
                default:
                    ZStack {
                        RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                            .fill(Color.white.opacity(0.07))
                        ProgressView().tint(.white)
                    }
                    .frame(height: 200)
                }
            }
        } else {
            photoPlaceholder
        }
    }

    private var photoPlaceholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.07))
            VStack(spacing: 7) {
                Image(systemName: "car.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.white.opacity(0.35))
                Text("Zdjęcie niedostępne")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
        .frame(height: 130)
    }

    // MARK: Nagłówek

    private var eventHeader: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(guest?.name ?? "Gość")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.white)
            HStack(spacing: 8) {
                if let ts = route.ts {
                    Text(Self.eventTimeLabel(ts))
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.6))
                }
                if let via = route.via {
                    Text(via == "PIN" ? "Kod PIN" : "Rozpoznana tablica")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(GlassColor.accentLight)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background { Capsule().fill(Color.white.opacity(0.08)) }
                        .overlay { Capsule().strokeBorder(GlassColor.accentLight.opacity(0.35), lineWidth: 1) }
                }
            }
        }
    }

    // MARK: Szczegóły gościa

    @ViewBuilder
    private var detailsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let g = guest {
                detailRow(label: "Imię i nazwisko", value: g.name)
                detailRow(
                    label: "Tablica",
                    value: (g.vehiclePlate?.isEmpty == false) ? g.vehiclePlate! : "—",
                    monospaced: true
                )
                detailRow(label: "Ważność zaproszenia", value: GlassFormat.guestWindow(g))
                detailRow(label: "PIN do domofonu", value: g.pin, monospaced: true)
            } else if guestLoaded {
                // Gość usunięty / inna nieruchomość — zdarzenie (zdjęcie
                // + czas) i tak jest wartościowe.
                Text("Nie udało się pobrać szczegółów gościa.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.white.opacity(0.55))
            } else {
                HStack(spacing: 8) {
                    ProgressView().tint(.white).scaleEffect(0.8)
                    Text("Wczytuję szczegóły gościa…")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.white.opacity(0.55))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.07))
        }
    }

    private func detailRow(label: String, value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.55))
            Spacer(minLength: 12)
            Text(value)
                .font(.system(size: 13, weight: .semibold, design: monospaced ? .monospaced : .default))
                .foregroundStyle(.white)
                .multilineTextAlignment(.trailing)
        }
    }

    // MARK: Helpers (statyczne — mutacje DateFormatter poza ViewBuilder,
    // pułapka #17 w CLAUDE.md)

    /// „dziś o 14:32" / „wczoraj o 9:05" / „11 sierpnia o 14:32".
    private static func eventTimeLabel(_ date: Date) -> String {
        let t = GlassFormat.timeOnly.string(from: date)
        if Calendar.current.isDateInToday(date) { return "dziś o \(t)" }
        if Calendar.current.isDateInYesterday(date) { return "wczoraj o \(t)" }
        let day = DateFormatter()
        day.locale = Locale(identifier: "pl_PL")
        day.dateFormat = "d MMMM"
        return "\(day.string(from: date)) o \(t)"
    }

    private func loadGuest() async {
        if let guests: [Guest] = try? await APIClient.shared.get("/resident/guests") {
            guest = guests.first(where: { $0.id == route.guestId })
        }
        guestLoaded = true
    }
}
