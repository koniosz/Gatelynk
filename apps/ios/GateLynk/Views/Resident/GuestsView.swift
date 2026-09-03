import SwiftUI

// MARK: - GuestsView
//
// Faza 2 bety Villa Natura — mieszkaniec zaprasza gościa na okno czasowe,
// gość dostaje 6-cyfrowy PIN do domofonu (Akuvox — Faza 2D), opcjonalnie
// tablica idzie do allowlist LPR na czas pobytu.
//
// Lista pokazuje aktywnych i historycznych gości; aktywni mają przycisk
// "Anuluj" (status → CANCELLED, tablica usuwana z allowlisty LPR).

struct GuestsView: View {
    @State private var guests: [Guest] = []
    @State private var loading = true
    @State private var error: String?
    @State private var showNew = false
    /// Karta „Szczegóły zaproszenia" (2026-08-14) — tap na aktywnego gościa
    /// otwiera Wallet-style detail (duże imię + status, kopiowalny PIN,
    /// toggle powiadomień, akcje). Edycja pól (NewGuestView) prezentowana
    /// z wnętrza tej karty.
    @State private var viewing: Guest?
    @State private var cancellingId: Int?
    /// Gość wybrany do udostępnienia przez iMessage. nil = sheet zamknięty.
    /// Trzymamy `Guest` zamiast bool-a żeby przekazać token + imię do composer-a.
    @State private var sharing: Guest?
    /// "Zaproś ponownie" (2026-05-22) — open NewGuestView z prefilled name/email/
    /// phone/plate z wybranego (zwykle expired) gościa, ale jako NEW invitation
    /// z aktualnymi datami validFrom/validTo.
    @State private var reinviting: Guest?
    /// Który expired guest jest swipe-revealed (ujawnione akcje pod kartą).
    /// nil = wszyscy w "rest position".
    @State private var swipedGuestId: Int?
    /// W trakcie DELETE network call (visual feedback + disable buttons).
    @State private var deletingId: Int?
    /// Zdarzenia access_events WSZYSTKICH moich gości (2026-07-04) —
    /// endpoint `/resident/access-events?guestsOnly=true`. Fail-silent na
    /// starszym backendzie (brak parametru → i tak przyjdą tylko moje eventy,
    /// filtrujemy po guestId lokalnie).
    @State private var guestEvents: [AccessEvent] = []
    /// Gość z rozwiniętą sekcją historii zdarzeń. nil = wszystkie zwinięte.
    @State private var expandedHistoryGuestId: Int?
    /// Lista wejść budynku (2026-07-08) — do mapowania apId → nazwa
    /// w wierszu ograniczeń gościa. Fail-silent: gdy fetch nie wyjdzie,
    /// pokazujemy „Wejście #id".
    @State private var accessPoints: [AccessPoint] = []

    private static let dateFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        f.locale = Locale(identifier: "pl_PL")
        return f
    }()

    @Environment(\.colorScheme) private var scheme

    // Designerska wersja ma 3 sekcje (Teraz aktywne / Nadchodzące / Historia).
    // Dziś backend nie rozróżnia future-active od now-active (status='ACTIVE'
    // dla obu), rozróżniamy po `validFrom > now`.
    private var nowActiveGuests: [Guest] {
        let now = Date()
        return guests.filter { $0.status == .active && $0.validFrom <= now && $0.validTo > now }
    }

    private var upcomingGuests: [Guest] {
        let now = Date()
        return guests.filter { $0.status == .active && $0.validFrom > now }
    }

    private var historyGuests: [Guest] {
        let now = Date()
        return guests.filter { $0.status != .active || $0.validTo <= now }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                GLColor.bg1(scheme).ignoresSafeArea()

                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView(error, systemImage: "wifi.exclamationmark")
                } else {
                    ScrollView(showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 12) {
                            // Primary CTA „Zaproś gościa" — fioletowy gradient na górze
                            inviteButton

                            if !nowActiveGuests.isEmpty {
                                sectionHeader("Teraz aktywne")
                                guestList(nowActiveGuests, muted: false)
                            }
                            if !upcomingGuests.isEmpty {
                                sectionHeader("Nadchodzące")
                                guestList(upcomingGuests, muted: false)
                            }
                            if !historyGuests.isEmpty {
                                sectionHeader("Historia")
                                guestList(historyGuests, muted: true)
                            }

                            if guests.isEmpty {
                                emptyState
                            }
                            Spacer(minLength: 40)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                    }
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Goście")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(GLColor.bg1(scheme), for: .navigationBar)
            .sheet(isPresented: $showNew) {
                NewGuestView(existing: nil) { await load() }
            }
            // „Zaproś ponownie" — pre-fill name/phone/email/plate z wybranego
            // expired gościa, ale POST jako new (nowe daty, nowy PIN, nowy URL).
            .sheet(item: $reinviting) { g in
                NewGuestView(existing: nil, template: g) { await load() }
            }
            .sheet(item: $sharing) { g in
                GuestShareSheet(guest: g) { sharing = nil }
            }
            // Karta „Szczegóły zaproszenia" (2026-08-14) — Wallet-style.
            .sheet(item: $viewing) { g in
                GuestDetailView(guest: g) { await load() }
            }
            .task { await load() }
        }
    }

    // MARK: - Glass v3 helpers

    /// Hero CTA na samej górze — fioletowy gradient zamiast plus w toolbarze.
    private var inviteButton: some View {
        Button { showNew = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .bold))
                Text("Zaproś gościa")
                    .font(.system(size: 15, weight: .bold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(GLColor.accentGradient(scheme))
            .clipShape(RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous))
        }
        .buttonStyle(.plain)
        .glShadow(.glow)
    }

    private func sectionHeader(_ title: String) -> some View {
        GLSectionHeader(title: title)
            .padding(.top, 6)
    }

    private func guestList(_ list: [Guest], muted: Bool) -> some View {
        VStack(spacing: 8) {
            ForEach(list) { g in
                if muted {
                    // Historia — swipe-to-delete + invite-again button.
                    historyGuestRow(g)
                } else {
                    guestCard(g, muted: muted)
                }
            }
        }
    }

    /// Wiersz historii — swipe-to-reveal ze 2 akcjami (Zaproś ponownie + Usuń)
    /// na kanwie ZStack. Mail-style: użytkownik ciągnie kartę w lewo,
    /// odsłania kolorowe action buttons. Tap na akcję wykonuje + close swipe.
    ///
    /// Dodatkowo na samej karcie widoczny inline button "Zaproś ponownie"
    /// żeby user nie musiał odgadywać że trzeba swipe-ować.
    private func historyGuestRow(_ g: Guest) -> some View {
        let isRevealed = swipedGuestId == g.id
        let revealedOffset: CGFloat = -160
        return ZStack(alignment: .trailing) {
            // ── Akcje w tle (widoczne po swipe-left) ─────────────────
            HStack(spacing: 8) {
                Button {
                    swipedGuestId = nil
                    reinviting = g
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: "arrow.clockwise.circle.fill")
                            .font(.system(size: 22, weight: .semibold))
                        Text("Zaproś\nponownie")
                            .font(.system(size: 10, weight: .semibold))
                            .multilineTextAlignment(.center)
                    }
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(GLColor.accent400(scheme))
                    .clipShape(RoundedRectangle(cornerRadius: GLRadius.lg, style: .continuous))
                }
                .buttonStyle(.plain)

                Button {
                    Task { await deleteGuest(g) }
                } label: {
                    VStack(spacing: 3) {
                        if deletingId == g.id {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "trash.fill")
                                .font(.system(size: 22, weight: .semibold))
                        }
                        Text("Usuń")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(GLColor.danger(scheme))
                    .clipShape(RoundedRectangle(cornerRadius: GLRadius.lg, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(deletingId != nil)
            }
            .padding(.trailing, 4)

            // ── Karta główna (przesuwana) ──────────────────────────────
            guestCardWithReinvite(g)
                .background(GLColor.bg1(scheme))
                .clipShape(RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous))
                .offset(x: isRevealed ? revealedOffset : 0)
                .animation(.spring(response: 0.32, dampingFraction: 0.85), value: isRevealed)
                .gesture(
                    DragGesture(minimumDistance: 20)
                        .onEnded { value in
                            // Threshold: 60 pikseli w lewo otwiera, w prawo zamyka.
                            if value.translation.width < -60 {
                                swipedGuestId = g.id
                            } else if value.translation.width > 40 {
                                swipedGuestId = nil
                            }
                        }
                )
                // Tap kontener bez przycisków — close swipe.
                .onTapGesture {
                    if isRevealed { swipedGuestId = nil }
                }
        }
    }

    /// Karta gościa z historii — muted styling + inline „Zaproś ponownie" button
    /// na dole. Bez PIN (expired/cancelled go nie potrzebują).
    private func guestCardWithReinvite(_ g: Guest) -> some View {
        GLCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: GLRadius.md, style: .continuous)
                            .fill(GLColor.bg3(scheme))
                        Image(systemName: g.isPedestrian ? "figure.walk" : "car.fill")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(GLColor.textSecondary(scheme))
                    }
                    .frame(width: 44, height: 44)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(g.name)
                            .font(.system(size: 14.5, weight: .semibold))
                            .foregroundStyle(GLColor.textPrimary(scheme))
                        HStack(spacing: 5) {
                            if let plate = g.vehiclePlate, !plate.isEmpty {
                                Text(plate)
                                    .font(.system(size: 11.5, design: .monospaced).weight(.medium))
                                    .foregroundStyle(GLColor.textTertiary(scheme))
                                Text("·")
                                    .foregroundStyle(GLColor.textTertiary(scheme))
                            }
                            Text(timeRange(g))
                                .font(.system(size: 11.5))
                                .foregroundStyle(GLColor.textTertiary(scheme))
                        }
                        HStack(spacing: 5) {
                            Circle()
                                .fill(statusDotColor(g))
                                .frame(width: 6, height: 6)
                            Text(statusLabel(g))
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(statusDotColor(g))
                        }
                    }
                    Spacer()
                }

                // Historia zdarzeń gościa — także dla wygasłych/anulowanych
                // (audit pozostaje po zakończeniu wizyty). 2026-07-04.
                activitySection(for: g)

                // Inline akcja: „Zaproś ponownie" — duplikuje funkcję
                // ze swipe-revealed, dostępna bez konieczności gestu.
                Button {
                    reinviting = g
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 12, weight: .bold))
                        Text("Zaproś ponownie")
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(GLColor.accent300(scheme))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(GLColor.accent300(scheme).opacity(0.14))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .opacity(0.85)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle().fill(GLColor.bg3(scheme))
                Image(systemName: "person.2")
                    .font(.system(size: 26))
                    .foregroundStyle(GLColor.textSecondary(scheme))
            }
            .frame(width: 56, height: 56)
            Text("Brak zaproszeń")
                .font(.system(size: 14.5, weight: .semibold))
                .foregroundStyle(GLColor.textPrimary(scheme))
            Text("Zaproś pierwszego gościa — dostanie 6-cyfrowy PIN.")
                .font(.system(size: 12))
                .foregroundStyle(GLColor.textTertiary(scheme))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous)
                .strokeBorder(GLColor.borderDefault(scheme), style: StrokeStyle(lineWidth: 1, dash: [6])),
        )
    }

    /// Guest card — pojazd ikona + name + plate · time + status dot + label.
    /// Tap → karta „Szczegóły zaproszenia" (2026-08-14; edycja z jej środka).
    /// Akcje (Share / Cancel) jako secondary buttons w karcie.
    private func guestCard(_ g: Guest, muted: Bool) -> some View {
        Button { if g.status == .active && g.validTo > Date() { viewing = g } } label: {
            GLCard {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: GLRadius.md, style: .continuous)
                                .fill(g.isPedestrian
                                      ? GLColor.bg3(scheme)
                                      : GLColor.accent300(scheme).opacity(0.20))
                            Image(systemName: g.isPedestrian ? "figure.walk" : "car.fill")
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(GLColor.accent300(scheme))
                        }
                        .frame(width: 44, height: 44)

                        VStack(alignment: .leading, spacing: 3) {
                            Text(g.name)
                                .font(.system(size: 14.5, weight: .semibold))
                                .foregroundStyle(GLColor.textPrimary(scheme))
                            HStack(spacing: 5) {
                                if let plate = g.vehiclePlate, !plate.isEmpty {
                                    Text(plate)
                                        .font(.system(size: 11.5, design: .monospaced).weight(.medium))
                                        .foregroundStyle(GLColor.textTertiary(scheme))
                                    Text("·")
                                        .foregroundStyle(GLColor.textTertiary(scheme))
                                }
                                Text(timeRange(g))
                                    .font(.system(size: 11.5))
                                    .foregroundStyle(GLColor.textTertiary(scheme))
                            }
                            HStack(spacing: 5) {
                                Circle()
                                    .fill(statusDotColor(g))
                                    .frame(width: 6, height: 6)
                                Text(statusLabel(g))
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(statusDotColor(g))
                            }
                        }
                        Spacer()
                        if g.status == .active && g.validTo > Date() {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(GLColor.textTertiary(scheme))
                        }
                    }

                    // PIN — tylko dla aktywnych
                    if g.status == .active && g.validTo > Date() {
                        HStack(spacing: 8) {
                            Image(systemName: "number")
                                .font(.caption)
                                .foregroundStyle(GLColor.textTertiary(scheme))
                            Text(g.pin)
                                .font(.system(.callout, design: .monospaced).weight(.bold))
                                .foregroundStyle(GLColor.accent300(scheme))
                                .tracking(1.5)
                            Spacer()
                            if g.urlToken != nil {
                                Button {
                                    sharing = g
                                } label: {
                                    Image(systemName: "paperplane.fill")
                                        .font(.system(size: 14))
                                        .foregroundStyle(GLColor.accent300(scheme))
                                        .padding(8)
                                        .background(GLColor.accent300(scheme).opacity(0.15))
                                        .clipShape(Circle())
                                }
                                .buttonStyle(.plain)
                                .disabled(cancellingId != nil)
                            }
                            Button {
                                Task { await cancel(g) }
                            } label: {
                                if cancellingId == g.id {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: "xmark")
                                        .font(.system(size: 14))
                                        .foregroundStyle(GLColor.danger(scheme))
                                        .padding(8)
                                        .background(GLColor.danger(scheme).opacity(0.15))
                                        .clipShape(Circle())
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(cancellingId != nil)
                        }
                    }

                    // Ograniczenia dostępu (wejścia + harmonogram) — 2026-07-08.
                    restrictionsSection(for: g)

                    // Historia zdarzeń gościa (PIN / LPR / portal) — 2026-07-04.
                    activitySection(for: g)
                }
            }
            .opacity(muted ? 0.55 : 1.0)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Ograniczenia dostępu gościa (2026-07-08)

    /// Nazwa wejścia z listy /resident/access-points; fallback gdy fetch
    /// nie wyszedł albo AP został skasowany po utworzeniu zaproszenia.
    private func apName(_ id: Int) -> String {
        accessPoints.first { $0.id == id }?.label ?? "Wejście #\(id)"
    }

    /// Wiersze ograniczeń na karcie gościa — renderują się tylko gdy gość
    /// MA ograniczenia (stary backend / gość bez ograniczeń → nic).
    /// Format: „Tylko: Brama główna (zostały 2) · Furtka" + osobny wiersz
    /// harmonogramu „Codziennie 6:00–7:00".
    @ViewBuilder
    private func restrictionsSection(for g: Guest) -> some View {
        if let aps = g.allowedAccessPoints, !aps.isEmpty {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "door.left.hand.closed")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(GLColor.textTertiary(scheme))
                Text("Tylko: " + aps.map { entry -> String in
                    var s = apName(entry.apId)
                    if let remaining = g.remainingUses(apId: entry.apId) {
                        s += " (zostały \(remaining))"
                    }
                    return s
                }.joined(separator: " · "))
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(GLColor.textSecondary(scheme))
            }
        }
        if let sched = g.recurringSchedule {
            HStack(spacing: 6) {
                Image(systemName: "clock.arrow.2.circlepath")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(GLColor.textTertiary(scheme))
                Text(sched.summary)
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(GLColor.textSecondary(scheme))
            }
        }
    }

    private func timeRange(_ g: Guest) -> String {
        let cal = Calendar(identifier: .gregorian)
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        // Jeśli te same dni — pokazujemy „14 maj, 14:00–18:00".
        // Różne — „14–15 maj 14:00–18:00" (sklejone, ale czytelne).
        if cal.isDate(g.validFrom, inSameDayAs: g.validTo) {
            f.dateFormat = "d MMM, HH:mm"
            let from = f.string(from: g.validFrom)
            f.dateFormat = "HH:mm"
            return "\(from)–\(f.string(from: g.validTo))"
        }
        f.dateFormat = "d MMM HH:mm"
        return "\(f.string(from: g.validFrom)) → \(f.string(from: g.validTo))"
    }

    private func statusDotColor(_ g: Guest) -> Color {
        let now = Date()
        if g.status == .active && g.validFrom <= now && g.validTo > now {
            return GLColor.success(scheme)
        }
        if g.status == .active && g.validFrom > now {
            return GLColor.accent300(scheme)
        }
        if g.status == .cancelled { return GLColor.danger(scheme) }
        return GLColor.textTertiary(scheme)
    }

    private func statusLabel(_ g: Guest) -> String {
        let now = Date()
        if g.status == .active && g.validFrom <= now && g.validTo > now { return "Aktywny teraz" }
        if g.status == .active && g.validFrom > now { return "Nadchodzący" }
        if g.status == .cancelled { return "Anulowany" }
        return "Wygasł"
    }

    // Legacy `row()` / `statusBadge()` / `statusColor()` zostały zastąpione
    // przez `guestCard()` w sekcji „Glass v3 helpers" powyżej. Funkcjonalność
    // (PIN display, share button, cancel, edit on tap) zachowana.

    // MARK: - Historia aktywności gościa (2026-07-04)

    /// Ostatnie zdarzenie danego gościa — feed z API jest DESC po ts,
    /// więc pierwszy match to najnowszy wpis.
    private func lastEvent(for g: Guest) -> AccessEvent? {
        guestEvents.first { $0.guestId == g.id }
    }

    private func events(for g: Guest) -> [AccessEvent] {
        guestEvents.filter { $0.guestId == g.id }
    }

    /// Krótki polski opis zdarzenia gościa (bez imienia — jesteśmy w karcie
    /// tego gościa, kontekst jest oczywisty).
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

    /// Relative time po polsku — jak w HistoryView (celowo zduplikowane,
    /// oba widoki mają własne prywatne helpery zamiast wspólnego extension
    /// — unika redeklaracji przy dwóch targetach GateLynk/Glass).
    private func relativeTime(_ d: Date) -> String {
        let interval = Date().timeIntervalSince(d)
        if interval < 60 { return "przed chwilą" }
        if interval < 3600 { return "\(Int(interval / 60)) min temu" }
        if interval < 86400 { return "\(Int(interval / 3600)) godz. temu" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        f.dateFormat = "d MMM, HH:mm"
        return f.string(from: d)
    }

    /// Sekcja „Ostatnia aktywność" w karcie gościa — relative time + chevron;
    /// tap rozwija inline listę zdarzeń tego gościa (ikona typu, opis PL, czas).
    /// Nie renderuje się gdy brak zdarzeń (świeży gość / stary backend).
    @ViewBuilder
    private func activitySection(for g: Guest) -> some View {
        if let last = lastEvent(for: g) {
            let isExpanded = expandedHistoryGuestId == g.id
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) {
                        expandedHistoryGuestId = isExpanded ? nil : g.id
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "clock")
                            .font(.system(size: 11, weight: .semibold))
                        Text("Ostatnia aktywność: \(relativeTime(last.date))")
                            .font(.system(size: 11.5, weight: .medium))
                        Spacer()
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(GLColor.textTertiary(scheme))
                }
                .buttonStyle(.plain)

                if isExpanded {
                    ForEach(Array(events(for: g).prefix(10))) { ev in
                        HStack(spacing: 8) {
                            Image(systemName: ev.icon)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(ev.gateOpened
                                                 ? GLColor.success(scheme)
                                                 : GLColor.danger(scheme))
                                .frame(width: 22, height: 22)
                                .background(
                                    (ev.gateOpened
                                     ? GLColor.success(scheme)
                                     : GLColor.danger(scheme)).opacity(0.13)
                                )
                                .clipShape(Circle())
                            VStack(alignment: .leading, spacing: 1) {
                                Text(guestEventTitle(ev))
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(GLColor.textPrimary(scheme))
                                HStack(spacing: 4) {
                                    if let label = ev.accessPointLabel {
                                        Text(label)
                                        Text("·")
                                    }
                                    Text(relativeTime(ev.date))
                                }
                                .font(.system(size: 10.5))
                                .foregroundStyle(GLColor.textTertiary(scheme))
                            }
                            Spacer()
                        }
                    }
                }
            }
            .padding(.top, 2)
        }
    }

    // MARK: - Network

    private func load() async {
        loading = true; error = nil
        do { guests = try await APIClient.shared.get("/resident/guests") }
        catch { self.error = error.localizedDescription }
        // Historia aktywności gości — bonus, fail-silent (try?): starszy
        // backend bez guestsOnly zwróci pełen feed rezydenta, a lokalny
        // filtr po guestId i tak pokaże tylko zdarzenia gości.
        if let resp: AccessEventsResponse = try? await APIClient.shared.get(
            "/resident/access-events?guestsOnly=true&limit=200"
        ) {
            guestEvents = resp.events.filter { $0.guestId != nil }
        }
        // Nazwy wejść do wiersza ograniczeń — fail-silent (stary backend /
        // brak sieci → „Wejście #id" jako fallback w restrictionsSection).
        if let aps: [AccessPoint] = try? await APIClient.shared.get("/resident/access-points") {
            accessPoints = aps.sorted { $0.sortOrder < $1.sortOrder }
        }
        loading = false
    }

    private func cancel(_ g: Guest) async {
        cancellingId = g.id
        do {
            let _: Guest = try await APIClient.shared.delete("/resident/guests/\(g.id)")
            await load()
        } catch {
            self.error = error.localizedDescription
        }
        cancellingId = nil
    }

    /// Hard delete dla expired/cancelled gości. Backend (cancelGuest) dla
    /// already-finished statusów robi DELETE FROM zamiast UPDATE status —
    /// czyli ten sam endpoint, inna semantyka per status. Idiomatic Mail-style.
    /// Optimistic UI: usuwamy z `guests` array PRZED czekaniem na response,
    /// żeby swipe-delete poczuł się instant. Rollback przez full reload przy err.
    private func deleteGuest(_ g: Guest) async {
        deletingId = g.id
        let snapshot = guests
        guests.removeAll { $0.id == g.id }
        swipedGuestId = nil
        do {
            let _: Guest = try await APIClient.shared.delete("/resident/guests/\(g.id)")
        } catch {
            // Rollback i pokaż błąd
            guests = snapshot
            self.error = error.localizedDescription
        }
        deletingId = nil
    }
}

// MARK: - NewGuestView (form)

struct NewGuestView: View {
    let existing: Guest?
    /// Template do pre-fill przy "Zaproś ponownie" (2026-05-22) — gdy podany
    /// I `existing` jest nil, pre-fillujemy name/phone/email/vehicle z template,
    /// ale traktujemy zaproszenie jako NEW (POST nie PATCH) z aktualnymi datami.
    /// Use case: user widzi expired gościa i chce zaprosić tę samą osobę
    /// ponownie bez przepisywania danych ręcznie.
    let template: Guest?
    var onSave: () async -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var phone: String
    /// Opcjonalny email gościa. Gdy podany — Cloud automatycznie wyśle
    /// Resend-em link do portalu (ucina krok „mieszkaniec musi sam wysłać
    /// SMS-a"). Niezależne od `phone` — gość może mieć tylko email, tylko
    /// telefon, oba lub żadne (wtedy mieszkaniec ręcznie udostępni link).
    @State private var email: String
    @State private var hasVehicle: Bool
    @State private var vehiclePlate: String
    @State private var validFrom: Date
    @State private var validTo: Date
    /// 2026-08-14 — pushe o aktywności gościa (wjazd/wyjazd/PIN). Domyślnie
    /// WŁĄCZONE; wysyłane jako `notifyOnUse` w POST/PATCH.
    @State private var notifyOnUse: Bool
    @State private var saving = false
    @State private var error: String?

    // ── Ograniczenia dostępu (2026-07-08) ────────────────────────────────
    /// Lista wejść budynku — fetch w .task, fail-silent (stary backend /
    /// offline → sekcja pokazuje komunikat, zapis dalej działa).
    @State private var accessPoints: [AccessPoint] = []
    /// Toggle „Wszystkie wejścia" — domyślnie ON (bez ograniczeń).
    @State private var allEntrances: Bool
    /// Zaznaczone wejścia (gdy allEntrances = false).
    @State private var selectedApIds: Set<Int>
    /// Limit otwarć per wejście. Brak klucza = bez limitu.
    @State private var apLimits: [Int: Int]
    /// „Wymagaj mojego zatwierdzenia" per wejście (2026-07-08) — sensowne
    /// tylko dla UNIT_DOOR (drzwi mieszkania); default ON przy zaznaczeniu.
    @State private var apApprovals: [Int: Bool]
    /// Toggle „Cyklicznie" — domyślnie OFF (dostęp przez cały okres ważności).
    @State private var recurring: Bool
    /// Dni tygodnia ISO 1=pn..7=nd. Pusty zbiór = codziennie.
    @State private var selectedDays: Set<Int>
    /// Okno godzinowe harmonogramu (liczy się tylko hour+minute).
    @State private var scheduleFrom: Date
    @State private var scheduleTo: Date

    private var isEdit: Bool { existing != nil }

    init(existing: Guest?, template: Guest? = nil, onSave: @escaping () async -> Void) {
        self.existing = existing
        self.template = template
        self.onSave = onSave
        // Priority: existing (edit) → template (re-invite) → blank (fresh).
        // Dates: existing zachowuje swoje; template/blank zaczynają od now/+24h.
        if let g = existing {
            _name = State(initialValue: g.name)
            _phone = State(initialValue: g.phone ?? "")
            _email = State(initialValue: g.email ?? "")
            let plate = g.vehiclePlate ?? ""
            _hasVehicle = State(initialValue: !plate.isEmpty)
            _vehiclePlate = State(initialValue: plate)
            _validFrom = State(initialValue: g.validFrom)
            _validTo = State(initialValue: g.validTo)
        } else if let t = template {
            _name = State(initialValue: t.name)
            _phone = State(initialValue: t.phone ?? "")
            _email = State(initialValue: t.email ?? "")
            let plate = t.vehiclePlate ?? ""
            _hasVehicle = State(initialValue: !plate.isEmpty)
            _vehiclePlate = State(initialValue: plate)
            _validFrom = State(initialValue: Date())
            _validTo = State(initialValue: Date().addingTimeInterval(24 * 3600))
        } else {
            _name = State(initialValue: "")
            _phone = State(initialValue: "")
            _email = State(initialValue: "")
            _hasVehicle = State(initialValue: false)
            _vehiclePlate = State(initialValue: "")
            _validFrom = State(initialValue: Date())
            _validTo = State(initialValue: Date().addingTimeInterval(24 * 3600))
        }

        // Powiadomienia o aktywności — pre-fill z gościa (edycja / re-invite),
        // nil (stary backend) = domyślnie włączone.
        _notifyOnUse = State(
            initialValue: existing?.notifyOnUse ?? template?.notifyOnUse ?? true
        )

        // Ograniczenia dostępu — pre-fill tylko przy edycji (existing);
        // „Zaproś ponownie" (template) startuje bez ograniczeń.
        if let aps = existing?.allowedAccessPoints, !aps.isEmpty {
            _allEntrances = State(initialValue: false)
            _selectedApIds = State(initialValue: Set(aps.map(\.apId)))
            var limits: [Int: Int] = [:]
            var approvals: [Int: Bool] = [:]
            for entry in aps {
                if let maxUses = entry.maxUses { limits[entry.apId] = maxUses }
                if entry.approvalRequired == true { approvals[entry.apId] = true }
            }
            _apLimits = State(initialValue: limits)
            _apApprovals = State(initialValue: approvals)
        } else {
            _allEntrances = State(initialValue: true)
            _selectedApIds = State(initialValue: [])
            _apLimits = State(initialValue: [:])
            _apApprovals = State(initialValue: [:])
        }
        if let sched = existing?.recurringSchedule {
            _recurring = State(initialValue: true)
            _selectedDays = State(initialValue: Set((sched.days ?? []).filter { (1...7).contains($0) }))
            _scheduleFrom = State(initialValue: Self.timeDate(from: sched.startTime))
            _scheduleTo = State(initialValue: Self.timeDate(from: sched.endTime))
        } else {
            _recurring = State(initialValue: false)
            _selectedDays = State(initialValue: [])
            _scheduleFrom = State(initialValue: Self.timeDate(from: "06:00"))
            _scheduleTo = State(initialValue: Self.timeDate(from: "22:00"))
        }
    }

    /// „HH:mm" → Date z dzisiejszą datą (DatePicker .hourAndMinute i tak
    /// używa tylko komponentów godzinowych).
    private static func timeDate(from hhmm: String) -> Date {
        let minutes = GuestRecurringSchedule.minutes(hhmm)
        return Calendar.current.date(
            bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: Date()
        ) ?? Date()
    }

    /// Date → „HH:mm" (format kontraktu API).
    private static func hhmm(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// Polska odmiana: 1 otwarcie / 2 otwarcia / 5 otwarć.
    private static func openingsLabel(_ n: Int) -> String {
        if n == 1 { return "1 otwarcie" }
        let mod10 = n % 10, mod100 = n % 100
        if (2...4).contains(mod10) && !(12...14).contains(mod100) { return "\(n) otwarcia" }
        return "\(n) otwarć"
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedPlate: String {
        vehiclePlate.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }
    private var canSave: Bool {
        !trimmedName.isEmpty
            && validTo > validFrom
            && validTo.timeIntervalSince(validFrom) <= 30 * 24 * 3600
            && (!hasVehicle || !trimmedPlate.isEmpty)
            && !saving
    }

    var body: some View {
        NavigationStack {
            // Redesign 2026-08-14 (wzorce Apple HIG / Reminders): insetGrouped
            // Form z jasną hierarchią sekcji, ikony-kafelki jak w Ustawieniach
            // przy toggle'ach/pickerach, primary button wyraźny na dole.
            Form {
                Section {
                    TextField("Imię i nazwisko", text: $name)
                        .textInputAutocapitalization(.words)
                        .textContentType(.name)
                    TextField("Telefon (opcjonalnie)", text: $phone)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                    TextField("E-mail (opcjonalnie)", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Gość")
                } footer: {
                    Text("Gdy podasz e-mail, gość od razu dostanie link do portalu otwierającego bramę. Bez e-maila — wyślesz mu link sam (przyciskiem „Wyślij link” na liście).")
                        .font(.caption2)
                }

                Section {
                    Toggle(isOn: $hasVehicle) {
                        settingsRowLabel("car.fill", .blue, "Przyjedzie samochodem")
                    }
                    if hasVehicle {
                        TextField("Tablica rejestracyjna", text: $vehiclePlate)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .font(.body.monospaced())
                    }
                } header: {
                    Text("Pojazd")
                } footer: {
                    Text(hasVehicle
                         ? "Tablica zostanie dodana do listy LPR na czas pobytu."
                         : "Pieszy gość — wystarczy PIN do domofonu.")
                }

                Section {
                    DatePicker(selection: $validFrom) {
                        settingsRowLabel("calendar", .green, "Od")
                    }
                    DatePicker(selection: $validTo) {
                        settingsRowLabel("calendar.badge.checkmark", .orange, "Do")
                    }
                } header: {
                    Text("Okres ważności")
                } footer: {
                    Text("Maksymalny okres zaproszenia to 30 dni.")
                        .font(.caption2)
                }

                // ── Powiadomienia o aktywności gościa (2026-08-14) ────────
                Section {
                    Toggle(isOn: $notifyOnUse) {
                        settingsRowLabel("bell.badge.fill", .red, "Powiadamiaj o aktywności gościa")
                    }
                } header: {
                    Text("Powiadomienia")
                } footer: {
                    Text("Push przy każdym wjeździe, wyjeździe i użyciu PIN-u.")
                        .font(.caption2)
                }

                // ── Wybór wejść + limity otwarć (2026-07-08) ──────────────
                Section {
                    Toggle(isOn: $allEntrances.animation()) {
                        settingsRowLabel("door.left.hand.open", .teal, "Wszystkie wejścia")
                    }
                    if !allEntrances {
                        if accessPoints.isEmpty {
                            Text("Nie udało się pobrać listy wejść — spróbuj ponownie później.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(accessPoints) { ap in
                            apPickerRow(ap)
                        }
                    }
                } header: {
                    Text("Wejścia dla gościa")
                } footer: {
                    Text(allEntrances
                         ? "Gość może korzystać z każdego wejścia."
                         : "Zaznacz wejścia dostępne dla gościa. Dla każdego możesz ustawić limit otwarć (0 = bez limitu).")
                        .font(.caption2)
                }

                // ── Harmonogram cykliczny (2026-07-08) ────────────────────
                Section {
                    Toggle(isOn: $recurring.animation()) {
                        settingsRowLabel("clock.arrow.2.circlepath", .purple, "Cyklicznie")
                    }
                    if recurring {
                        dayChips
                        DatePicker("Od godziny", selection: $scheduleFrom, displayedComponents: .hourAndMinute)
                        DatePicker("Do godziny", selection: $scheduleTo, displayedComponents: .hourAndMinute)
                        Label(draftSchedule.summary, systemImage: "clock.arrow.2.circlepath")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Kiedy dostęp działa")
                } footer: {
                    Text(recurring
                         ? "Dostęp działa tylko w wybrane dni i godziny (brak zaznaczonych dni = codziennie). Godzina „do” wcześniejsza niż „od” oznacza okno przez północ."
                         : "Dostęp działa przez cały okres ważności zaproszenia.")
                        .font(.caption2)
                }

                if isEdit, let pin = existing?.pin {
                    Section("PIN do domofonu") {
                        Text(pin)
                            .font(.system(.title2, design: .monospaced).weight(.bold))
                            .tracking(4)
                            .foregroundStyle(Color.accentColor)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }

                // ── Primary button na dole (HIG: wyraźna główna akcja) ────
                Section {
                    Button { Task { await save() } } label: {
                        HStack(spacing: 8) {
                            if saving {
                                ProgressView().tint(.white)
                            }
                            Text(isEdit ? "Zapisz zmiany" : "Zaproś gościa")
                                .font(.system(size: 16, weight: .semibold))
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(canSave ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Color.gray.opacity(0.45)))
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSave)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    Text(isEdit
                         ? "Zmiana tablicy lub okresu ważności od razu aktualizuje listę LPR."
                         : "Po zapisaniu gość otrzyma 6-cyfrowy PIN do domofonu.")
                        .font(.caption2)
                }
            }
            .navigationTitle(isEdit ? "Edytuj gościa" : "Nowy gość")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { dismiss() }
                }
            }
            .task {
                // Lista wejść do sekcji ograniczeń — fail-silent (stary
                // backend / offline → komunikat w sekcji, zapis dalej działa).
                if let aps: [AccessPoint] = try? await APIClient.shared.get("/resident/access-points") {
                    accessPoints = aps.sorted { $0.sortOrder < $1.sortOrder }
                }
            }
        }
    }

    // MARK: - Ograniczenia dostępu — UI helpers (2026-07-08)

    /// Wiersz w stylu aplikacji Ustawienia: kolorowy kafelek ikony +
    /// etykieta (redesign HIG 2026-08-14).
    private func settingsRowLabel(_ symbol: String, _ color: Color, _ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(RoundedRectangle(cornerRadius: 6.5, style: .continuous).fill(color))
            Text(text)
        }
    }

    /// Bursztynowy akcent dla wejść UNIT_DOOR (drzwi mieszkania, np. Nuki).
    private static let amber = Color(red: 1.0, green: 0.69, blue: 0.125)

    /// Wiersz wejścia: checkbox z nazwą + (po zaznaczeniu) Stepper limitu
    /// otwarć. Stepper od 0, gdzie 0 = „bez limitu" — czytelniejsze w Form
    /// niż osobny toggle per wejście.
    /// UNIT_DOOR (2026-07-08): ikona klucza + bursztyn + podpis „Drzwi
    /// mieszkania"; zaznaczenie ustawia domyślny limit 1 otwarcia oraz
    /// toggle „Wymagaj mojego zatwierdzenia" (default ON).
    @ViewBuilder
    private func apPickerRow(_ ap: AccessPoint) -> some View {
        let selected = selectedApIds.contains(ap.id)
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation {
                    if selected {
                        selectedApIds.remove(ap.id)
                        apLimits[ap.id] = nil
                        apApprovals[ap.id] = nil
                    } else {
                        selectedApIds.insert(ap.id)
                        if ap.isUnitDoor {
                            // Drzwi mieszkania: default 1 otwarcie (edytowalne)
                            // + zatwierdzanie przez hosta domyślnie WŁĄCZONE.
                            if apLimits[ap.id] == nil { apLimits[ap.id] = 1 }
                            apApprovals[ap.id] = true
                        }
                    }
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected
                                         ? (ap.isUnitDoor ? Self.amber : Color.accentColor)
                                         : Color.secondary)
                    if ap.isUnitDoor {
                        Image(systemName: "key.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Self.amber)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(ap.label)
                                .foregroundStyle(.primary)
                            Text("Drzwi mieszkania")
                                .font(.caption2)
                                .foregroundStyle(Self.amber)
                        }
                    } else {
                        Text(ap.label)
                            .foregroundStyle(.primary)
                    }
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if selected {
                Stepper(value: limitBinding(ap.id), in: 0...99) {
                    let v = apLimits[ap.id] ?? 0
                    Text(v == 0 ? "Bez limitu otwarć" : "Limit: \(Self.openingsLabel(v))")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if ap.isUnitDoor {
                    Toggle(isOn: approvalBinding(ap.id)) {
                        Text("Wymagaj mojego zatwierdzenia")
                            .font(.subheadline)
                    }
                    .tint(Self.amber)
                }
            }
        }
    }

    /// Binding toggle „Wymagaj mojego zatwierdzenia" per wejście UNIT_DOOR.
    private func approvalBinding(_ apId: Int) -> Binding<Bool> {
        Binding(
            get: { apApprovals[apId] ?? false },
            set: { apApprovals[apId] = $0 ? true : nil }
        )
    }

    /// Binding limitu per wejście — 0 w Stepperze = brak klucza w słowniku
    /// (czyli „bez limitu", maxUses nie idzie do API).
    private func limitBinding(_ apId: Int) -> Binding<Int> {
        Binding(
            get: { apLimits[apId] ?? 0 },
            set: { apLimits[apId] = $0 == 0 ? nil : $0 }
        )
    }

    private static let dayChipLabels = ["Pn", "Wt", "Śr", "Czw", "Pt", "Sb", "Nd"]

    /// Chipy dni tygodnia (multi-select). Puste = codziennie.
    private var dayChips: some View {
        HStack(spacing: 5) {
            ForEach(1...7, id: \.self) { day in
                let on = selectedDays.contains(day)
                Button {
                    if on { selectedDays.remove(day) } else { selectedDays.insert(day) }
                } label: {
                    Text(Self.dayChipLabels[day - 1])
                        .font(.system(size: 12, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(on ? Color.accentColor : Color(.tertiarySystemFill))
                        .foregroundStyle(on ? Color.white : Color.primary)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Harmonogram budowany z aktualnego stanu formularza — do preview
    /// („Codziennie 6:00–7:00") i do wysyłki w save().
    private var draftSchedule: GuestRecurringSchedule {
        GuestRecurringSchedule(
            days: selectedDays.isEmpty ? nil : selectedDays.sorted(),
            startTime: Self.hhmm(scheduleFrom),
            endTime: Self.hhmm(scheduleTo),
            tz: TimeZone.current.identifier
        )
    }

    /// Ograniczenie wejść z formularza. nil = user nie ograniczył (toggle
    /// „Wszystkie wejścia" ON albo nic nie zaznaczył). Kolejność wg sortOrder;
    /// wejścia spoza pobranej listy (edycja przy padniętym fetchu) na końcu —
    /// dzięki temu edycja NIE gubi ograniczeń gdy lista się nie załadowała.
    private var draftAllowedAccessPoints: [AllowedAccessPointEntry]? {
        guard !allEntrances, !selectedApIds.isEmpty else { return nil }
        let known = accessPoints.map(\.id).filter { selectedApIds.contains($0) }
        let unknown = selectedApIds.subtracting(known).sorted()
        return (known + unknown).map {
            AllowedAccessPointEntry(
                apId: $0,
                maxUses: apLimits[$0],
                // Encodowane tylko gdy true (nil pomijany w JSON-ie) —
                // backend toleruje brak pola / null.
                approvalRequired: apApprovals[$0] == true ? true : nil
            )
        }
    }

    private func save() async {
        saving = true; error = nil
        // Ograniczenia dostępu — nil gdy user ich nie ustawił.
        let apsBody = draftAllowedAccessPoints
        let scheduleBody: GuestRecurringSchedule? = recurring ? draftSchedule : nil
        do {
            if let g = existing {
                // encodeRestrictions: pola idą do JSON-a (wartość albo jawny
                // null) tylko gdy user COŚ ustawił ALBO gość miał wcześniej
                // ograniczenia (null czyści). Inaczej pomijamy — body jak
                // dotąd, stary backend nie widzi różnicy.
                let body = UpdateGuestBody(
                    name: trimmedName,
                    phone: phone.isEmpty ? nil : phone,
                    vehiclePlate: hasVehicle ? trimmedPlate : nil,
                    validFrom: Self.iso.string(from: validFrom),
                    validTo: Self.iso.string(from: validTo),
                    allowedAccessPoints: apsBody,
                    recurringSchedule: scheduleBody,
                    encodeRestrictions: apsBody != nil || scheduleBody != nil
                        || g.hasAccessRestrictions,
                    notifyOnUse: notifyOnUse
                )
                let _: Guest = try await APIClient.shared.patch("/resident/guests/\(g.id)", body: body)
            } else {
                // Email — przycinamy whitespace; pusty string → nil (Cloud
                // wymaga albo poprawnego maila albo nil, walidacja regexem
                // po stronie API). Nie waliduemy tu lokalnie żeby nie
                // duplikować logiki — Cloud zwróci 400 z treścią błędu jeśli
                // format jest zły.
                let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
                let body = CreateGuestBody(
                    name: trimmedName,
                    phone: phone.isEmpty ? nil : phone,
                    email: trimmedEmail.isEmpty ? nil : trimmedEmail,
                    vehiclePlate: hasVehicle ? trimmedPlate : nil,
                    validFrom: Self.iso.string(from: validFrom),
                    validTo: Self.iso.string(from: validTo),
                    // Nil = pola pominięte w JSON-ie (backward compat).
                    allowedAccessPoints: apsBody,
                    recurringSchedule: scheduleBody,
                    notifyOnUse: notifyOnUse
                )
                let _: Guest = try await APIClient.shared.post("/resident/guests", body: body)
            }
            await onSave()
            dismiss()
        } catch {
            self.error = error.localizedDescription
            // Stale lista (np. gość już anulowany lub wygasł na innym urządzeniu)
            // → odświeżamy listę w tle, żeby wpis zniknął z „Aktywnych" gdy
            // user zamknie sheet. Sheet zostawiamy otwarty z error message,
            // żeby user wiedział że zapis się NIE udał.
            await onSave()
        }
        saving = false
    }
}

// MARK: - GuestEventView (deep-link z pusha „Gość wjechał/wyjechał", 2026-08-13)
//
// Ekran zdarzenia gościa — tap w push GUEST_FIRST_USE / GUEST_USE / GUEST_EXIT
// (sheet z poziomu ResidentTabView, wzorzec jak PushTicketRoute). Duże zdjęcie
// kadru LPR z podpisanego linku `imageUrl` (ważny ~2 h — po wygaśnięciu 404,
// AsyncImage degraduje się do placeholdera bez komunikatu błędu), nagłówek wg
// kind, czas z `ts` („dziś o HH:MM") i szczegóły gościa z GET /resident/guests.

struct GuestEventView: View {
    let route: GuestEventPushRoute

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var guest: Guest?
    /// true po zakończeniu fetch-u (odróżnia „wczytuję" od „nie znaleziono").
    @State private var guestLoaded = false
    @State private var showGuests = false

    var body: some View {
        NavigationStack {
            ZStack {
                GLColor.bg1(scheme).ignoresSafeArea()
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 14) {
                        eventPhoto
                        eventHeader
                        guestDetails
                        allGuestsButton
                        Spacer(minLength: 30)
                    }
                    .padding(16)
                }
            }
            .navigationTitle(route.isExit ? "Gość wyjechał" : "Gość wjechał")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zamknij") { dismiss() }
                }
            }
            .sheet(isPresented: $showGuests) { GuestsView() }
            .task { await loadGuest() }
        }
    }

    // MARK: Zdjęcie kadru LPR

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
                        .frame(height: 230)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                case .failure:
                    // Link podpisany wygasł (~2 h → 404) albo brak sieci —
                    // pokazujemy placeholder, szczegóły niżej dalej działają.
                    photoPlaceholder
                default:
                    ZStack {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(GLColor.bg3(scheme))
                        ProgressView()
                    }
                    .frame(height: 230)
                }
            }
        } else {
            photoPlaceholder
        }
    }

    private var photoPlaceholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(GLColor.bg3(scheme))
            VStack(spacing: 8) {
                Image(systemName: "car.fill")
                    .font(.system(size: 34))
                    .foregroundStyle(GLColor.textTertiary(scheme))
                Text("Zdjęcie niedostępne")
                    .font(.system(size: 12))
                    .foregroundStyle(GLColor.textTertiary(scheme))
            }
        }
        .frame(height: 150)
    }

    // MARK: Nagłówek

    private var eventHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(guest?.name ?? "Gość")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(GLColor.textPrimary(scheme))
            HStack(spacing: 8) {
                if let ts = route.ts {
                    Text(Self.eventTimeLabel(ts))
                        .font(.system(size: 13))
                        .foregroundStyle(GLColor.textSecondary(scheme))
                }
                if let via = route.via {
                    Text(via == "PIN" ? "Kod PIN" : "Rozpoznana tablica")
                        .font(.system(size: 11, weight: .semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(GLColor.bg3(scheme)))
                        .foregroundStyle(GLColor.textSecondary(scheme))
                }
            }
        }
    }

    // MARK: Szczegóły gościa

    @ViewBuilder
    private var guestDetails: some View {
        GLCard {
            VStack(alignment: .leading, spacing: 10) {
                if let g = guest {
                    detailRow(label: "Imię i nazwisko", value: g.name)
                    detailRow(
                        label: "Tablica",
                        value: (g.vehiclePlate?.isEmpty == false) ? g.vehiclePlate! : "—",
                        monospaced: true
                    )
                    detailRow(label: "Ważność zaproszenia", value: Self.validityLabel(g))
                    detailRow(label: "PIN do domofonu", value: g.pin, monospaced: true)
                } else if guestLoaded {
                    // Gość mógł zostać usunięty / należeć do innej nieruchomości
                    // — zdarzenie (zdjęcie + czas) i tak jest wartościowe.
                    Text("Nie udało się pobrać szczegółów gościa.")
                        .font(.system(size: 13))
                        .foregroundStyle(GLColor.textTertiary(scheme))
                } else {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Wczytuję szczegóły gościa…")
                            .font(.system(size: 13))
                            .foregroundStyle(GLColor.textTertiary(scheme))
                    }
                }
            }
        }
    }

    private func detailRow(label: String, value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(GLColor.textTertiary(scheme))
            Spacer(minLength: 12)
            Text(value)
                .font(.system(size: 14, weight: .semibold, design: monospaced ? .monospaced : .default))
                .foregroundStyle(GLColor.textPrimary(scheme))
                .multilineTextAlignment(.trailing)
        }
    }

    private var allGuestsButton: some View {
        Button { showGuests = true } label: {
            HStack {
                Image(systemName: "person.2.fill")
                Text("Wszyscy goście")
                    .font(.system(size: 14, weight: .semibold))
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(GLColor.accent300(scheme))
            .padding(14)
            .background(GLColor.bg2(scheme))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: Helpers (statyczne — mutacje DateFormatter poza ViewBuilder,
    // patrz pułapka #17 w CLAUDE.md)

    /// „dziś o 14:32" / „wczoraj o 9:05" / „11 sierpnia o 14:32".
    private static func eventTimeLabel(_ date: Date) -> String {
        let time = DateFormatter()
        time.locale = Locale(identifier: "pl_PL")
        time.dateFormat = "H:mm"
        let t = time.string(from: date)
        if Calendar.current.isDateInToday(date) { return "dziś o \(t)" }
        if Calendar.current.isDateInYesterday(date) { return "wczoraj o \(t)" }
        let day = DateFormatter()
        day.locale = Locale(identifier: "pl_PL")
        day.dateFormat = "d MMMM"
        return "\(day.string(from: date)) o \(t)"
    }

    /// Okno ważności zaproszenia — ten sam styl co `timeRange` w GuestsView.
    private static func validityLabel(_ g: Guest) -> String {
        let cal = Calendar(identifier: .gregorian)
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        if cal.isDate(g.validFrom, inSameDayAs: g.validTo) {
            f.dateFormat = "d MMM, HH:mm"
            let from = f.string(from: g.validFrom)
            f.dateFormat = "HH:mm"
            return "\(from)–\(f.string(from: g.validTo))"
        }
        f.dateFormat = "d MMM HH:mm"
        return "\(f.string(from: g.validFrom)) → \(f.string(from: g.validTo))"
    }

    private func loadGuest() async {
        if let guests: [Guest] = try? await APIClient.shared.get("/resident/guests") {
            guest = guests.first(where: { $0.id == route.guestId })
        }
        guestLoaded = true
    }
}

// MARK: - GuestShareSheet (wyodrębnione 2026-08-14)
//
// Wspólna treść sheetu „Wyślij link" — używana z listy gości (paperplane
// na karcie) i z karty „Szczegóły zaproszenia". Wcześniej inline
// w GuestsView.body; przeniesione 1:1.

private struct GuestShareSheet: View {
    let guest: Guest
    let onDone: () -> Void

    /// Treść SMS-a / iMessage-a wysyłanego do gościa. Krótka, z imieniem,
    /// żeby gość od razu wiedział od kogo i o co chodzi (bez tego ludzie
    /// klikają „Spam — Junk" zanim przeczytają).
    private var shareMessage: String? {
        guest.portalUrl().map {
            "Cześć \(guest.name)! Zapraszam Cię — otwórz link i naciśnij przycisk przy bramie: \($0.absoluteString)"
        }
    }

    var body: some View {
        if MessageComposer.canSend, guest.portalUrl() != nil, let msg = shareMessage {
            MessageComposer(
                recipients: guest.phone.map { [$0] } ?? [],
                body: msg
            ) { _ in
                onDone()
            }
        } else if let url = guest.portalUrl(), let msg = shareMessage {
            // Symulator / brak Messages — generyczny Share Sheet jako
            // fallback (WhatsApp / Mail / cokolwiek).
            VStack(spacing: 16) {
                Image(systemName: "square.and.arrow.up.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(.blue)
                Text("Udostępnij link gościowi")
                    .font(.headline)
                ShareLink(item: url, message: Text(msg)) {
                    Label("Wybierz aplikację", systemImage: "paperplane.fill")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal)
                Button("Gotowe") { onDone() }
                    .buttonStyle(.borderless)
            }
            .padding()
            .presentationDetents([.medium])
        } else {
            // Legacy guest bez tokenu (urlToken=nil).
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(.orange)
                Text("Ten gość nie ma jeszcze portalu — utwórz nowe zaproszenie.")
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                Button("OK") { onDone() }
                    .buttonStyle(.borderedProminent)
            }
            .padding()
        }
    }
}

// MARK: - GuestDetailView — „Szczegóły zaproszenia" (redesign 2026-08-14)
//
// Wallet-style hierarchia (wzorce Apple Wallet / Znajdź): na górze duży
// awatar + imię + kolorowa plakietka statusu, potem PIN jako wyróżniony,
// duży, KOPIOWALNY element (najważniejsza rzecz dla gościa), sekcja
// szczegółów, sekcja Powiadomienia z toggle notifyOnUse (optimistic PATCH
// z rollbackiem), akcje: wyślij zaproszenie / edytuj / anuluj (destructive).

struct GuestDetailView: View {
    @State private var guest: Guest
    let onChanged: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    /// Toggle powiadomień — optimistic; rollback przy błędzie PATCH.
    @State private var notifyOn: Bool
    @State private var notifyError: String?
    /// „Skopiowano" feedback po tapnięciu PIN-u (1.5 s).
    @State private var pinCopied = false
    @State private var showEdit = false
    @State private var showShare = false
    @State private var confirmCancel = false
    @State private var cancelling = false
    @State private var cancelError: String?

    init(guest: Guest, onChanged: @escaping () async -> Void) {
        _guest = State(initialValue: guest)
        _notifyOn = State(initialValue: guest.notifyOnUse ?? true)
        self.onChanged = onChanged
    }

    var body: some View {
        NavigationStack {
            ZStack {
                GLColor.bg1(scheme).ignoresSafeArea()
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 16) {
                        headerBlock
                        pinBlock
                        detailsCard
                        notificationsCard
                        actionsBlock
                        Spacer(minLength: 24)
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Szczegóły zaproszenia")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zamknij") { dismiss() }
                }
            }
            .sheet(isPresented: $showEdit) {
                NewGuestView(existing: guest) {
                    await refreshGuest()
                    await onChanged()
                }
            }
            .sheet(isPresented: $showShare) {
                GuestShareSheet(guest: guest) { showShare = false }
            }
            .confirmationDialog(
                "Anulować zaproszenie dla \(guest.name)?",
                isPresented: $confirmCancel,
                titleVisibility: .visible
            ) {
                Button("Anuluj zaproszenie", role: .destructive) {
                    Task { await cancelInvite() }
                }
                Button("Wróć", role: .cancel) {}
            } message: {
                Text("PIN i link przestaną działać, a tablica zniknie z białej listy przy bramie.")
            }
        }
    }

    // MARK: Nagłówek — duże imię + plakietka statusu

    private var headerBlock: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle().fill(GLColor.accentGradient(scheme))
                Text(String(guest.name.prefix(1)).uppercased())
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 72, height: 72)
            .glShadow(.glow)

            Text(guest.name)
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(GLColor.textPrimary(scheme))
                .multilineTextAlignment(.center)

            Text(statusText)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(statusColor)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(Capsule().fill(statusColor.opacity(0.15)))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }

    // MARK: PIN — duży, kopiowalny (najważniejszy element dla gościa)

    private var pinBlock: some View {
        Button {
            UIPasteboard.general.string = guest.pin
            withAnimation { pinCopied = true }
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                withAnimation { pinCopied = false }
            }
        } label: {
            VStack(spacing: 6) {
                Text("PIN DO DOMOFONU")
                    .font(.system(size: 11, weight: .bold))
                    .tracking(1.2)
                    .foregroundStyle(GLColor.textTertiary(scheme))
                Text(guest.pin)
                    .font(.system(size: 36, weight: .bold, design: .monospaced))
                    .tracking(8)
                    .foregroundStyle(GLColor.accent300(scheme))
                HStack(spacing: 5) {
                    Image(systemName: pinCopied ? "checkmark.circle.fill" : "doc.on.doc")
                        .font(.system(size: 11, weight: .semibold))
                    Text(pinCopied ? "Skopiowano" : "Dotknij, aby skopiować")
                        .font(.system(size: 11.5, weight: .medium))
                }
                .foregroundStyle(pinCopied ? GLColor.success(scheme) : GLColor.textTertiary(scheme))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 18)
            .background(GLColor.bg2(scheme))
            .clipShape(RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous)
                    .strokeBorder(GLColor.accent300(scheme).opacity(0.35), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: Szczegóły

    private var detailsCard: some View {
        GLCard {
            VStack(alignment: .leading, spacing: 12) {
                if let plate = guest.vehiclePlate, !plate.isEmpty {
                    detailRow("Tablica", plate, monospaced: true)
                } else {
                    detailRow("Gość", "Pieszy (bez pojazdu)")
                }
                detailRow("Okres ważności", Self.validityLabel(guest))
                if let phone = guest.phone, !phone.isEmpty {
                    detailRow("Telefon", phone)
                }
                if let email = guest.email, !email.isEmpty {
                    detailRow("E-mail", email)
                }
                if let summary = guest.restrictionsSummary {
                    detailRow("Ograniczenia", summary)
                }
                if let sched = guest.recurringSchedule {
                    detailRow("Harmonogram", sched.summary)
                }
            }
        }
    }

    private func detailRow(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(GLColor.textTertiary(scheme))
            Spacer(minLength: 12)
            Text(value)
                .font(.system(size: 14, weight: .semibold, design: monospaced ? .monospaced : .default))
                .foregroundStyle(GLColor.textPrimary(scheme))
                .multilineTextAlignment(.trailing)
        }
    }

    // MARK: Powiadomienia (notifyOnUse, 2026-08-14)

    private var notificationsCard: some View {
        GLCard {
            VStack(alignment: .leading, spacing: 8) {
                Toggle(isOn: notifyBinding) {
                    HStack(spacing: 10) {
                        Image(systemName: "bell.badge.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 28, height: 28)
                            .background(RoundedRectangle(cornerRadius: 6.5, style: .continuous).fill(Color.red))
                        Text("Powiadamiaj o aktywności gościa")
                            .font(.system(size: 14.5, weight: .medium))
                            .foregroundStyle(GLColor.textPrimary(scheme))
                    }
                }
                .tint(GLColor.accent300(scheme))
                Text("Push przy każdym wjeździe, wyjeździe i użyciu PIN-u.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(GLColor.textTertiary(scheme))
                if let notifyError {
                    Text(notifyError)
                        .font(.system(size: 11.5))
                        .foregroundStyle(GLColor.danger(scheme))
                }
            }
        }
    }

    /// Optimistic toggle: UI przełącza się od razu, PATCH w tle; przy
    /// błędzie rollback do poprzedniej wartości + komunikat.
    private var notifyBinding: Binding<Bool> {
        Binding(
            get: { notifyOn },
            set: { newValue in
                let previous = notifyOn
                notifyOn = newValue
                notifyError = nil
                Task {
                    struct Body: Encodable { let notifyOnUse: Bool }
                    do {
                        let _: Guest = try await APIClient.shared.patch(
                            "/resident/guests/\(guest.id)",
                            body: Body(notifyOnUse: newValue)
                        )
                        await onChanged()
                    } catch {
                        notifyOn = previous
                        notifyError = "Nie udało się zapisać ustawienia — spróbuj ponownie."
                    }
                }
            }
        )
    }

    // MARK: Akcje

    private var actionsBlock: some View {
        VStack(spacing: 10) {
            Button { showShare = true } label: {
                HStack(spacing: 8) {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 14, weight: .semibold))
                    Text("Wyślij zaproszenie")
                        .font(.system(size: 15, weight: .bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(GLColor.accentGradient(scheme))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)

            Button { showEdit = true } label: {
                HStack(spacing: 8) {
                    Image(systemName: "pencil")
                        .font(.system(size: 14, weight: .semibold))
                    Text("Edytuj zaproszenie")
                        .font(.system(size: 15, weight: .semibold))
                }
                .foregroundStyle(GLColor.accent300(scheme))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(GLColor.accent300(scheme).opacity(0.13))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)

            if let cancelError {
                Text(cancelError)
                    .font(.system(size: 12))
                    .foregroundStyle(GLColor.danger(scheme))
            }

            Button { confirmCancel = true } label: {
                HStack(spacing: 8) {
                    if cancelling {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "xmark.seal.fill")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    Text("Anuluj zaproszenie")
                        .font(.system(size: 15, weight: .semibold))
                }
                .foregroundStyle(GLColor.danger(scheme))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(GLColor.danger(scheme).opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(cancelling)
            .padding(.top, 6)
        }
    }

    // MARK: Status / helpers

    private var statusText: String {
        let now = Date()
        if guest.status == .active && guest.validFrom <= now && guest.validTo > now { return "AKTYWNE TERAZ" }
        if guest.status == .active && guest.validFrom > now { return "NADCHODZĄCE" }
        if guest.status == .cancelled { return "ANULOWANE" }
        return "WYGASŁE"
    }

    private var statusColor: Color {
        let now = Date()
        if guest.status == .active && guest.validFrom <= now && guest.validTo > now {
            return GLColor.success(scheme)
        }
        if guest.status == .active && guest.validFrom > now { return GLColor.accent300(scheme) }
        if guest.status == .cancelled { return GLColor.danger(scheme) }
        return GLColor.textTertiary(scheme)
    }

    /// Okres ważności — ten sam styl co `timeRange` w liście gości.
    private static func validityLabel(_ g: Guest) -> String {
        let cal = Calendar(identifier: .gregorian)
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        if cal.isDate(g.validFrom, inSameDayAs: g.validTo) {
            f.dateFormat = "d MMM, HH:mm"
            let from = f.string(from: g.validFrom)
            f.dateFormat = "HH:mm"
            return "\(from)–\(f.string(from: g.validTo))"
        }
        f.dateFormat = "d MMM HH:mm"
        return "\(f.string(from: g.validFrom)) → \(f.string(from: g.validTo))"
    }

    /// Po edycji (NewGuestView onSave) dociągamy świeże dane gościa —
    /// lokalna karta pokazuje nowe wartości bez zamykania.
    private func refreshGuest() async {
        if let guests: [Guest] = try? await APIClient.shared.get("/resident/guests"),
           let fresh = guests.first(where: { $0.id == guest.id }) {
            guest = fresh
            notifyOn = fresh.notifyOnUse ?? true
        }
    }

    private func cancelInvite() async {
        cancelling = true
        cancelError = nil
        do {
            let _: Guest = try await APIClient.shared.delete("/resident/guests/\(guest.id)")
            await onChanged()
            dismiss()
        } catch {
            cancelError = error.localizedDescription
        }
        cancelling = false
    }
}
