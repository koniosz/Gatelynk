import SwiftUI
import UIKit

// MARK: - Sheet Goście
//
// Lista zaproszeń (aktywne ● zielone / nadchodzące ○ fiolet / wygasłe
// przygaszone) + kompaktowy kreator zaproszenia w tym samym sheecie.
// POST /resident/guests zwraca Guest z 6-cyfrowym PIN-em — pokazujemy go
// od razu w toaście i na liście.
//
// 2026-07-07 (parity MVP): historia aktywności gościa — feed
// GET /resident/access-events?guestsOnly=true (fail-silent na starym
// backendzie; lokalny filtr po guestId). „Ostatnia aktywność: X temu"
// + tap rozwija listę zdarzeń gościa (PIN / wjazd LPR / portal).

struct GlassGuestsSheet: View {
    let guests: [Guest]
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
    @State private var expandedHistoryGuestId: Int?

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
            GlassSheetHeader(kicker: "Goście", title: "Zaproszenia", onClose: onClose)

            if visibleGuests.isEmpty {
                GlassSheetEmptyState(
                    icon: "person.2",
                    text: "Brak aktywnych zaproszeń.\nZaproś gościa — dostanie PIN do bramy."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(visibleGuests) { g in
                            GlassSwipeToDelete(
                                id: g.id,
                                openId: $swipedGuestId,
                                secondary: GlassSwipeAction(
                                    icon: "arrow.clockwise",
                                    color: GlassColor.success,
                                    action: { reinvite(g) }
                                ),
                                confirmTitle: "Czy na pewno chcesz usunąć zaproszenie dla \(g.name)?",
                                confirmMessage: g.status == .active
                                    ? "PIN i link przestaną działać, a tablica zniknie z białej listy przy bramie."
                                    : "Wpis zniknie z historii zaproszeń.",
                                onDelete: { await deleteGuest(g) },
                                onTap: { openEdit(g) }
                            ) { row(g) }
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)

                Text("Dotknij gościa, aby wysłać zaproszenie, edytować lub zaprosić ponownie. Przesuń w lewo, aby usunąć.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .padding(.vertical, 4)
            }

            GlassButton(title: "+ Zaproś gościa") {
                resetFormForCreate()
                showForm = true
            }
            .padding(.top, 6)
        }
    }

    // MARK: Swipe-to-delete (2026-07-13)

    /// DELETE /resident/guests/:id — aktywny → CANCELLED (PIN/link/tablica
    /// przestają działać), wygasły/anulowany → twarde usunięcie z historii.
    /// Zwraca sukces — komponent swipe cofa animację przy błędzie.
    private func deleteGuest(_ g: Guest) async -> Bool {
        do {
            let _: Guest = try await APIClient.shared.delete("/resident/guests/\(g.id)")
            await onReload()
            toast.show(g.status == .active ? "Zaproszenie anulowane" : "Zaproszenie usunięte")
            return true
        } catch {
            toast.show("Nie udało się usunąć zaproszenia", error: true)
            return false
        }
    }

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

    /// Aktywne i nadchodzące na górze, ostatnie wygasłe na końcu (max 3).
    private var visibleGuests: [Guest] {
        let active = guests.filter { $0.status == .active }
        let inactive = guests.filter { $0.status != .active }.prefix(3)
        return active + Array(inactive)
    }

    private func row(_ g: Guest) -> some View {
        let upcoming = g.status == .active && g.validFrom > Date()
        let initial = String(g.name.prefix(1)).uppercased()

        return GlassActionRow(
            orbGradient: g.status == .active
                ? (upcoming
                    ? [GlassColor.accentLight, GlassColor.accentBlue]
                    : [GlassColor.success, GlassColor.accentBlue])
                : [Color.white.opacity(0.2), Color.white.opacity(0.1)],
            orbIcon: "person.fill",
            title: g.name,
            subtitle: subtitle(g),
            dimmed: g.status != .active,
            trailing: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.35))
            },
            extra: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        if g.status == .active {
                            Text(upcoming ? "○ Nadchodzące" : "● Aktywne teraz")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(upcoming ? GlassColor.accentLight : GlassColor.successLight)
                            Text("PIN \(g.pin)")
                                .font(.system(size: 11, weight: .bold, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.75))
                        } else {
                            Text(g.status.label)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.5))
                        }
                    }
                    restrictionsLine(for: g)
                    activitySection(for: g)
                }
                .padding(.top, 3)
            }
        )
        // używamy initial w orbie? GlassOrb przyjmuje SF Symbol — initial pomijamy
        .accessibilityLabel("\(initial) — \(g.name)")
    }

    private func subtitle(_ g: Guest) -> String {
        var s = GlassFormat.guestWindow(g)
        if let p = g.vehiclePlate, !p.isEmpty {
            s += " · \(p)"
        }
        return s
    }

    /// Krótka linijka ograniczeń w wierszu gościa (2026-07-08) — np.
    /// „Tylko 2 wejścia · Codziennie 6:00–7:00 · zostały 3". Nie renderuje
    /// się gdy gość bez ograniczeń (stary backend → nic).
    @ViewBuilder
    private func restrictionsLine(for g: Guest) -> some View {
        if let summary = g.restrictionsSummary {
            // „zostały X" — suma pozostałych otwarć dla wejść z limitem.
            let text = g.totalRemainingUses.map { "\(summary) · zostały \($0)" } ?? summary
            HStack(spacing: 5) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 10, weight: .semibold))
                Text(text)
                    .font(.system(size: 10.5, weight: .medium))
                    .lineLimit(2)
            }
            .foregroundStyle(.white.opacity(0.6))
        }
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

    /// „Ostatnia aktywność: X temu" + tap rozwija zdarzenia tego gościa.
    /// Nie renderuje się gdy brak zdarzeń (świeży gość / stary backend).
    @ViewBuilder
    private func activitySection(for g: Guest) -> some View {
        let evs = events(for: g)
        if let last = evs.first {
            let isExpanded = expandedHistoryGuestId == g.id
            VStack(alignment: .leading, spacing: 6) {
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) {
                        expandedHistoryGuestId = isExpanded ? nil : g.id
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "clock")
                            .font(.system(size: 10, weight: .semibold))
                        Text("Ostatnia aktywność: \(GlassFormat.relative.localizedString(for: last.date, relativeTo: Date()))")
                            .font(.system(size: 10.5, weight: .medium))
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                    }
                    .foregroundStyle(GlassColor.accentLight.opacity(0.85))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if isExpanded {
                    ForEach(Array(evs.prefix(8))) { ev in
                        HStack(spacing: 7) {
                            Image(systemName: ev.icon)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(ev.gateOpened ? GlassColor.successLight : GlassColor.dangerSoft)
                                .frame(width: 20, height: 20)
                                .background {
                                    Circle().fill(
                                        (ev.gateOpened ? GlassColor.success : GlassColor.danger).opacity(0.14)
                                    )
                                }
                            VStack(alignment: .leading, spacing: 1) {
                                Text(guestEventTitle(ev))
                                    .font(.system(size: 11.5, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.9))
                                HStack(spacing: 4) {
                                    if let label = ev.accessPointLabel {
                                        Text(label)
                                        Text("·")
                                    }
                                    Text(GlassFormat.relative.localizedString(for: ev.date, relativeTo: Date()))
                                }
                                .font(.system(size: 10))
                                .foregroundStyle(.white.opacity(0.45))
                            }
                            Spacer()
                        }
                    }
                }
            }
        }
    }

    // MARK: Szczegóły zaproszenia — PEŁNY EKRAN (redesign v2, 2026-08-14)
    //
    // Read-first jak karta w Apple Wallet: PIN i wysyłka od razu widoczne,
    // edycja pól przeniesiona do formularza (przycisk „Edytuj"). Dzięki
    // pełnemu ekranowi kluczowa treść mieści się bez przewijania.

    private func detailScreen(_ g: Guest) -> some View {
        fullScreenScaffold(kicker: "Gość", title: "Szczegóły zaproszenia", onClose: { editingGuest = nil }) {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 14) {
                    guestHeaderCard(g)

                    if g.status == .active {
                        pinHero(g)
                        shareInviteButton(g)

                        sectionLabel("Szczegóły")
                        readonlyRow("Okres ważności", GlassFormat.guestWindow(g))
                        if let p = g.vehiclePlate, !p.isEmpty {
                            readonlyRow("Tablica", p)
                        }
                        if let phone = g.phone, !phone.isEmpty {
                            readonlyRow("Telefon", phone)
                        }
                        if let summary = g.restrictionsSummary {
                            readonlyRow("Ograniczenia", summary)
                        }

                        sectionLabel("Powiadomienia")
                        toggleRow("Powiadamiaj o aktywności gościa", isOn: notifyBinding(g))
                        sectionCaption("Push przy każdym wjeździe, wyjeździe i użyciu PIN-u.")
                    } else {
                        Text("Zaproszenie \(g.status == .expired ? "wygasło" : "zostało anulowane"). Możesz zaprosić tę osobę ponownie — dostanie nowy PIN i nowy link.")
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
                if g.status == .active {
                    GlassButton(title: "Edytuj zaproszenie", style: .ghost) {
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

                    Button {
                        confirmCancelInvite = true
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "xmark.seal.fill").font(.system(size: 14, weight: .semibold))
                            Text("Anuluj zaproszenie")
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
                }
            }
        }
        .confirmationDialog("Anulować zaproszenie dla \(g.name)?", isPresented: $confirmCancelInvite, titleVisibility: .visible) {
            Button("Anuluj zaproszenie", role: .destructive) { Task { await cancelInvite(g) } }
            Button("Wróć", role: .cancel) {}
        } message: {
            Text("PIN i link przestaną działać, a tablica zniknie z białej listy przy bramie.")
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
                gradient: g.status == .active
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
        let upcoming = g.status == .active && g.validFrom > Date()
        let (text, color): (String, Color) = {
            if g.status == .active {
                return upcoming
                    ? ("NADCHODZĄCE", GlassColor.accentLight)
                    : ("AKTYWNE TERAZ", GlassColor.successLight)
            }
            if g.status == .cancelled { return ("ANULOWANE", GlassColor.dangerSoft) }
            return ("WYGASŁE", Color.white.opacity(0.55))
        }()
        return Text(text)
            .font(.system(size: 10.5, weight: .bold))
            .tracking(0.6)
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background { Capsule().fill(color.opacity(0.16)) }
            .overlay { Capsule().strokeBorder(color.opacity(0.4), lineWidth: 1) }
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
            Text("Wyślij zaproszenie")
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

    private func cancelInvite(_ g: Guest) async {
        editBusy = true
        editError = nil
        do {
            let _: Guest = try await APIClient.shared.delete("/resident/guests/\(g.id)")
            await onReload()
            toast.show("Zaproszenie anulowane")
            editingGuest = nil
        } catch {
            editError = error.localizedDescription
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
