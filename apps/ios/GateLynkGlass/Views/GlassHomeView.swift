import SwiftUI

// MARK: - Ekran główny Glass Depth Premium
//
// Struktura po audycie UX 2026-09-21 (§7–8):
//   górny pasek (safe area): nieruchomość/lokal · asystent AI · konto (avatar)
//   zakładki: Dom / Dostęp / Sprawy / Osiedle (stały dolny pasek w safe area)
//   Dom: powitanie → pilne prośby gości → ulubione wejście + CTA →
//        „Wymaga uwagi" (realne dane) → skróty z podsumowaniami → najnowsze.
// Wszystkie huby i skróty otwierają TE SAME sheety co linki z powiadomień
// (`activeSheet`) — jedno źródło danych i szczegółów obiektu.
//
// Dynamic Island ("Zbliżasz się · Wjazd 12 m") wymaga Live Activities +
// geofencing — poza zakresem MVP, do osobnej iteracji.

struct GlassHomeView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(GlassToastCenter.self) private var toast

    // Dane
    @State private var building: Building?
    @State private var residentFull: Resident?
    @State private var accessPoints: [AccessPoint] = []
    /// Live stan zamków Nuki lokalu (GET /resident/smart-lock) — keyed by apId
    /// dla kafla UNIT_DOOR w decku + lista w „Więcej". Fail-silent (2026-07-10).
    @State private var nukiLocks: [NukiLockStatus] = []
    @State private var parcels: [Parcel] = []
    @State private var payments: PaymentSummary?
    @State private var guests: [Guest] = []
    @State private var tickets: [Ticket] = []
    /// true gdy WSZYSTKIE kluczowe fetch-e zawiodły (brak sieci / 500) —
    /// pokazujemy banner offline z retry zamiast wiecznego „Łączenie…".
    @State private var loadFailed = false
    /// Stan pobrania każdego źródła „Wymaga uwagi" i podsumowań (audyt §8):
    /// pusta tablica po błędzie ≠ „brak spraw". `unavailable` = moduł
    /// wyłączony dla osiedla (403 FEATURE_DISABLED) — wtedy go nie pokazujemy.
    @State private var srcProfile: DashboardSourceState = .loading
    @State private var srcParcels: DashboardSourceState = .loading
    @State private var srcPayments: DashboardSourceState = .loading
    @State private var srcGuests: DashboardSourceState = .loading
    @State private var srcTickets: DashboardSourceState = .loading

    // Domofon — obserwacja błędów wychodzącego połączenia (STATION_BUSY itp.)
    // musi żyć na poziomie Home (sheet bramy zamyka się przy inicjacji rozmowy).
    @State private var call = CallManager.shared

    // UI
    @State private var tab: GlassHomeTab = .home
    @State private var activeSheet: GlassSheetKind?
    /// Wejście z „Wymaga uwagi" wprost w szczegóły przepustki (czyszczone,
    /// gdy sheet gości znika — jak `pushTicketId`).
    @State private var focusGuestId: Int?
    /// Deep-link z pusha `ticket_reply` (2026-08-13) — sheet zgłoszeń otwiera
    /// się od razu na wątku tego ticketa. Czyszczone gdy sheet zgłoszeń znika
    /// (dowolną drogą: ✕, scrim, drag) — ręczne wejście z kafla startuje
    /// wtedy normalnie od listy.
    @State private var pushTicketId: Int?
    /// Push z ogłoszeniem (2026-08-15): id do auto-otwarcia w sheecie
    /// ogłoszeń (wysyłka imienna) albo flaga „otwórz najnowsze" (broadcast).
    @State private var pushAnnouncementId: Int?
    @State private var pushAnnouncementNewest = false
    /// Multi-station (PROMPT 2): stacje załadowane przed wyborem (>1).
    @State private var stations: [IntercomStation] = []
    /// Ikona słuchawki w decku — spinner podczas GET /stations.
    @State private var intercomBusy = false
    /// Punkt dostępu wybrany dla sheetu „Podgląd" (kamera aktywnej sekcji).
    @State private var cameraAP: AccessPoint?
    @State private var weather: GlassWeatherNow?
    @State private var tod: GlassTimeOfDay = .fromClock()
    @Environment(\.scenePhase) private var scenePhase

    // 2026-07-08 — prośby gości o otwarcie drzwi mieszkania (UNIT_DOOR z
    // approvalRequired). Karty na górze, tylko gdy pending niepuste.
    // Fail-silent na starym backendzie (404 → pusta lista).
    @State private var pendingApprovals: [GuestApprovalRequest] = []
    /// Moment fetch-u pending — lokalne odliczanie `secondsLeft - elapsed`
    /// + throttling odświeżania (~10 s przy widocznej karcie).
    @State private var approvalsFetchedAt = Date()
    /// Tyka co sekundę gdy karta widoczna — napędza odliczanie.
    @State private var approvalNow = Date()
    /// Request w trakcie approve/deny (spinner + disable przycisków).
    @State private var approvalBusyId: String?

    var body: some View {
        GeometryReader { geo in
            ZStack {
                GlassBackground(tod: tod, calm: isResident ? (tab == .home ? 0.16 : 0.42) : 0)

                if isResident {
                    residentRoot
                    sheetHost(maxHeight: geo.size.height * 0.8)
                } else if case .buildingAdmin(let admin) = auth.role {
                    // 2026-09-06: administrator osiedla dostaje własny zestaw
                    // kafelków (Zdarzenia / Zgłoszenia / Zaległości / Tablice /
                    // Urządzenia / Kronika) — wspólny host sheetów i toastów.
                    GlassAdminHomeView(admin: admin) { activeSheet = $0 }
                    sheetHost(maxHeight: geo.size.height * 0.85)
                } else {
                    wrongRoleNotice
                }

                toastHost
            }
        }
        .task {
            // Ładowanie /resident/* tylko dla mieszkańca — administrator ma
            // własne dane w GlassAdminHomeView (token BA nie przejdzie
            // przez jwt-resident).
            guard isResident else { return }
            await loadAll()
            // Zimny start z pusha ticket_reply — didReceive poleciał zanim
            // GlassHomeView istniał (a przy wylogowaniu: zanim user się
            // zalogował). Route czekał w AppDelegate — konsumujemy po
            // załadowaniu i otwieramy wątek.
            if let id = AppDelegate.consumePendingTicketRoute() {
                pushTicketId = id
                activeSheet = .tickets
            }
            // Zimny start z pusha „Gość wjechał/wyjechał" — ten sam wzorzec.
            if let route = AppDelegate.consumePendingGuestEventRoute() {
                activeSheet = .guestEvent(route)
            }
            // Zimny start z pusha z ogłoszeniem — otwórz sheet ogłoszeń
            // z auto-rozwiniętą pełną treścią.
            if let route = AppDelegate.consumePendingAnnouncementRoute() {
                pushAnnouncementId = route.notificationId
                pushAnnouncementNewest = route.notificationId == nil
                activeSheet = .announcements
            }
            // Zimny start z pusha treściowego (Kronika / brief / kubły) —
            // karta do spokojnego czytania (2026-08-28).
            if let route = AppDelegate.consumePendingContentPushRoute() {
                activeSheet = .pushContent(route)
            }
        }
        // Ciepły start — push ticket_reply tapnięty gdy apka żyje. Pending
        // też konsumujemy (AppDelegate ustawia oba), żeby nie odpalił się
        // ponownie przy kolejnym zimnym starcie.
        .onReceive(NotificationCenter.default.publisher(for: .ticketReplyPushTapped)) { note in
            _ = AppDelegate.consumePendingTicketRoute()
            guard let id = note.userInfo?["ticketId"] as? Int else { return }
            pushTicketId = id
            activeSheet = .tickets
        }
        // Ciepły start — push „Gość wjechał/wyjechał" (2026-08-13): otwórz
        // sheet zdarzenia (kadr LPR + szczegóły gościa).
        .onReceive(NotificationCenter.default.publisher(for: .guestEventPushTapped)) { note in
            _ = AppDelegate.consumePendingGuestEventRoute()
            guard let route = note.userInfo?["route"] as? GuestEventPushRoute else { return }
            activeSheet = .guestEvent(route)
        }
        // Ciepły start — push z ogłoszeniem (2026-08-15): sheet ogłoszeń
        // z auto-rozwiniętą pełną treścią.
        .onReceive(NotificationCenter.default.publisher(for: .announcementPushTapped)) { note in
            _ = AppDelegate.consumePendingAnnouncementRoute()
            guard let route = note.userInfo?["route"] as? AnnouncementPushRoute else { return }
            pushAnnouncementId = route.notificationId
            pushAnnouncementNewest = route.notificationId == nil
            activeSheet = .announcements
        }
        // Ciepły start — push treściowy (2026-08-28): karta do czytania.
        .onReceive(NotificationCenter.default.publisher(for: .contentPushTapped)) { note in
            _ = AppDelegate.consumePendingContentPushRoute()
            guard let route = note.userInfo?["route"] as? ContentPushRoute else { return }
            activeSheet = .pushContent(route)
        }
        // Sheet zgłoszeń zniknął (✕ / scrim / drag / inny sheet) → route
        // przestaje obowiązywać.
        .onChange(of: activeSheet) { _, newSheet in
            if newSheet != .tickets { pushTicketId = nil }
            if newSheet != .guests { focusGuestId = nil }
            if newSheet != .announcements {
                pushAnnouncementId = nil
                pushAnnouncementNewest = false
            }
        }
        .onReceive(
            Timer.publish(every: 60, on: .main, in: .common).autoconnect()
        ) { _ in
            let clock = GlassTimeOfDay.fromClock()
            if clock != tod { tod = clock }
        }
        .onChange(of: call.outboundError) { _, newValue in
            if let msg = newValue {
                toast.show(msg, error: true)
            }
        }
        // Powrót do foreground → PEŁNE odświeżenie danych (2026-07-16).
        // Wcześniej odświeżały się tylko prośby gości — statusy zmienione
        // po stronie admina (np. zatwierdzenie pojazdu) wisiały nieaktualne
        // aż do zabicia aplikacji.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    await loadAll()
                    await loadPendingApprovals()
                }
            }
        }
        // Push „gość prosi o otwarcie" (kind=GUEST_APPROVAL) → refresh kart.
        .onReceive(NotificationCenter.default.publisher(for: .pushNotificationTapped)) { note in
            guard let payload = note.userInfo?["payload"] as? [AnyHashable: Any],
                  let kind = payload["kind"] as? String, kind == "GUEST_APPROVAL"
            else { return }
            Task { await loadPendingApprovals() }
        }
        // Lokalny zegar odliczania + odświeżanie listy co ~10 s — tylko
        // gdy karta zatwierdzania jest widoczna (pending niepuste).
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { _ in
            guard !pendingApprovals.isEmpty else { return }
            approvalNow = Date()
            if approvalNow.timeIntervalSince(approvalsFetchedAt) >= 10 {
                Task { await loadPendingApprovals() }
            }
        }
    }

    // MARK: Banner offline (brak danych po starcie)

    private var offlineBanner: some View {
            HStack(spacing: 10) {
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(GlassColor.dangerSoft)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Brak połączenia z serwerem")
                        .font(.system(size: 12.5, weight: .bold))
                        .foregroundStyle(.white)
                    Text("Sprawdź internet i spróbuj ponownie.")
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.65))
                }
                Spacer()
                Button {
                    Task { await loadAll() }
                } label: {
                    Text("Odśwież")
                        .font(.system(size: 11.5, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background { Capsule().fill(GlassColor.accentGradient) }
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(GlassColor.dangerDeep.opacity(0.25))
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(GlassColor.dangerSoft.opacity(0.4), lineWidth: 1)
            }
        .transition(.opacity)
    }

    private var isResident: Bool {
        if case .resident = auth.role { return true }
        return false
    }

    private var firstName: String {
        if case .resident(let u) = auth.role { return u.firstName }
        return ""
    }

    // MARK: - Korzeń widoku mieszkańca: pasek górny + zakładka + pasek dolny

    /// Paski siedzą w `safeAreaInset` — treść nigdy nie wchodzi pod zegar /
    /// Dynamic Island ani pod dolną nawigację (audyt H04/H06), a ScrollView
    /// sam rezerwuje na nie miejsce (także przy większym tekście).
    private var residentRoot: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 14) {
                if loadFailed { offlineBanner }
                switch tab {
                case .home:    homeTab
                case .access:  accessTab
                case .matters: mattersTab
                case .estate:  estateTab
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 18)
        }
        // Każda zakładka zaczyna od góry — pozycja przewinięcia nie
        // „przecieka" między zakładkami.
        .id(tab)
        .refreshable { await loadAll() }
        .safeAreaInset(edge: .top, spacing: 0) {
            GlassTopBar(
                propertyName: building?.name ?? "Twoje osiedle",
                unitLabel: unitLabel,
                initials: initials,
                onProperty: { activeSheet = .properties },
                onAssistant: { activeSheet = .chat },
                onAccount: { activeSheet = .more }
            )
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            GlassTabBar(selection: $tab, flagged: flaggedTabs)
        }
    }

    private var initials: String {
        let first = firstName.first.map(String.init) ?? ""
        let last = residentFull?.lastName.first.map(String.init) ?? ""
        return (first + last).uppercased()
    }

    /// Lokal z aktywnego przypisania mieszkańca (`unitResidents` bez daty końca).
    private var unitLabel: String? {
        let active = residentFull?.unitResidents?.first { $0.untilDate == nil && $0.unit != nil }
            ?? residentFull?.unitResidents?.first { $0.unit != nil }
        guard let unit = active?.unit else { return nil }
        if let stairwell = unit.stairwell?.name, !stairwell.isEmpty {
            return "Lokal \(unit.number) · \(stairwell)"
        }
        return "Lokal \(unit.number)"
    }

    // MARK: - Zakładka Dom

    @ViewBuilder
    private var homeTab: some View {
        greeting

        // Pilne: gość czeka pod drzwiami — nad wszystkim innym.
        if !pendingApprovals.isEmpty {
            guestApprovalsSection
        }

        accessDeckCard
            .glassShimmer(delay: 0, radius: GlassRadius.primary)

        GlassAttentionSection(
            verdict: attentionVerdict,
            items: attentionItems,
            onRetry: { Task { await loadAll() } }
        )

        shortcutsGrid

        GlassAssistantCard(cacheKey: favoriteEntranceKey) {
            tab = .estate
            activeSheet = .announcements
        }
    }

    // MARK: Powitanie (zwarte — nazwa osiedla jest już w górnym pasku)

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Cześć, \(firstName)")
                .font(.title2.weight(.bold))
                .foregroundStyle(.white)
            Text(greetingMeta)
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.8))
        }
        .shadow(color: .black.opacity(0.55), radius: 8, y: 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 6)
        .padding(.top, 2)
        .accessibilityElement(children: .combine)
    }

    /// Data + realna pogoda (Open-Meteo po adresie budynku). Bez zgadywania
    /// co robi użytkownik („wracasz do domu") — tylko fakty.
    private var greetingMeta: String {
        guard let w = weather else { return GlassFormat.dayLabel() }
        return "\(GlassFormat.dayLabel()) · \(w.temp)°C, \(w.desc)"
    }

    // MARK: Karta „Dostęp" — paged deck (PROMPT 1)
    //
    // Pełnoszerokościowy carousel realnych punktów dostępu (sortOrder z API).
    // Kicker „DOSTĘP" → pełne menu (GlassGateSheet), kamera → sheet Podgląd,
    // słuchawka → flow rozmowy (picker stacji przy >1).

    /// Zamki Nuki keyed by apId — kafel UNIT_DOOR w decku pokazuje live stan.
    private var nukiLockMap: [Int: NukiLockStatus] {
        Dictionary(nukiLocks.map { ($0.apId, $0) }, uniquingKeysWith: { a, _ in a })
    }

    private var accessDeckCard: some View {
        GlassAccessDeck(
            accessPoints: accessPoints,
            loadFailed: loadFailed,
            onOpen: { ap in await openAccessPoint(ap) },
            onFireConfirm: { ap in activeSheet = .fireConfirm(ap.id) },
            onOpenMenu: { activeSheet = .gate },
            onCamera: { ap in cameraAP = ap; activeSheet = .camera },
            onIntercom: { ap in Task { await startIntercomFlow(preferred: ap) } },
            intercomBusy: intercomBusy,
            onComingSoon: { activeSheet = .comingSoon($0) },
            lockStatuses: nukiLockMap,
            favoriteKey: favoriteEntranceKey
        )
    }

    /// Ulubione wejście pamiętamy w kontekście użytkownika I nieruchomości —
    /// po przełączeniu osiedla nie zostaje cel z poprzedniego.
    private var favoriteEntranceKey: String? {
        guard let rid = auth.currentResidentId, let bid = building?.id else { return nil }
        return "glass.favoriteEntrance.r\(rid).b\(bid)"
    }

    /// Słuchawka / „Połącz z domofonem": GET /stations → >1 stacja = wybór
    /// (sheet .stationPick), 0/1 = dzwonimy od razu (istniejący
    /// CallManager.startOutboundCall; IntercomCallView pojawia się jako
    /// overlay w GlassApp).
    @MainActor
    private func startIntercomFlow(preferred: AccessPoint? = nil) async {
        guard !intercomBusy else { return }
        intercomBusy = true
        let loaded = await CallManager.shared.loadStations()
        intercomBusy = false
        // Pre-wybór stacji aktywnej sekcji: dopasowanie po nazwie (AP „Wyjazd"
        // → stacja „Wyjazd"). Gdy trafi jednoznacznie — dzwonimy od razu do
        // właściwego domofonu; inaczej picker (>1) / pierwsza (0-1).
        if let ap = preferred,
           let match = matchStation(loaded, to: ap) {
            activeSheet = nil
            CallManager.shared.startOutboundCall(intercomId: match.id)
        } else if loaded.count > 1 {
            stations = loaded
            activeSheet = .stationPick
        } else {
            activeSheet = nil
            CallManager.shared.startOutboundCall(intercomId: loaded.first?.id)
        }
    }

    /// Dopasowanie stacji domofonu do punktu dostępu po nazwie (bez
    /// diakrytyków/wielkości liter). Zwraca match tylko gdy JEDNOZNACZNY.
    private func matchStation(_ stations: [IntercomStation], to ap: AccessPoint) -> IntercomStation? {
        let target = ap.label.folding(options: .diacriticInsensitive, locale: .current).lowercased()
        let hits = stations.filter {
            let n = $0.name.folding(options: .diacriticInsensitive, locale: .current).lowercased()
            return n == target || n.contains(target) || target.contains(n)
        }
        return hits.count == 1 ? hits.first : nil
    }

    // MARK: Prośby gości o otwarcie drzwi mieszkania (2026-07-08)

    /// Bursztynowy akcent UNIT_DOOR — spójny z deckiem i kreatorem gościa.
    private static let approvalAmber = Color(hex: 0xFFB020)

    private var guestApprovalsSection: some View {
        VStack(spacing: 9) {
            ForEach(pendingApprovals) { req in
                guestApprovalCard(req)
            }
        }
    }

    /// Pozostałe sekundy — `secondsLeft` z fetch-u minus lokalny upływ czasu.
    private func approvalSecondsLeft(_ req: GuestApprovalRequest) -> Int {
        max(0, req.secondsLeft - Int(approvalNow.timeIntervalSince(approvalsFetchedAt)))
    }

    private func guestApprovalCard(_ req: GuestApprovalRequest) -> some View {
        let busy = approvalBusyId == req.id
        let left = approvalSecondsLeft(req)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "bell.badge.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Self.approvalAmber)
                Text("\(req.guestName) prosi o otwarcie: \(req.accessPointLabel)")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Text("\(left) s")
                    .font(.system(size: 12.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(left <= 10 ? GlassColor.dangerSoft : Self.approvalAmber)
                    .monospacedDigit()
            }

            HStack(spacing: 9) {
                approvalActionButton(
                    title: "Zatwierdź", icon: "checkmark",
                    tint: GlassColor.success, busy: busy
                ) {
                    Task { await approveGuestRequest(req) }
                }
                approvalActionButton(
                    title: "Odrzuć", icon: "xmark",
                    tint: GlassColor.danger, busy: false, disabled: busy
                ) {
                    Task { await denyGuestRequest(req) }
                }
            }
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Self.approvalAmber.opacity(0.10))
                }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Self.approvalAmber.opacity(0.45), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.35), radius: 16, y: 8)
    }

    private func approvalActionButton(
        title: String, icon: String, tint: Color,
        busy: Bool, disabled: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy {
                    ProgressView().tint(.white).scaleEffect(0.7)
                } else {
                    Image(systemName: icon)
                        .font(.system(size: 11, weight: .bold))
                }
                Text(title)
                    .font(.system(size: 12.5, weight: .bold))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(tint.opacity(0.55))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .strokeBorder(tint.opacity(0.7), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .disabled(busy || disabled)
    }

    /// GET pending — fail-silent: stary backend (404) / offline → pusta lista.
    private func loadPendingApprovals() async {
        let fetchedAt = Date()
        if let list: [GuestApprovalRequest] = try? await APIClient.shared.get(
            "/resident/guest-approvals/pending"
        ) {
            pendingApprovals = list
            approvalsFetchedAt = fetchedAt
            approvalNow = Date()
        } else {
            pendingApprovals = []
        }
    }

    private func approveGuestRequest(_ req: GuestApprovalRequest) async {
        guard approvalBusyId == nil else { return }
        approvalBusyId = req.id
        do {
            let resp: GuestApprovalApproveResponse = try await APIClient.shared.post(
                "/resident/guest-approvals/\(req.id)/approve",
                body: GlassEmptyBody()
            )
            if resp.gateOpened {
                toast.show("\(resp.label) — polecenie otwarcia przyjęte")
            } else {
                toast.show("Zatwierdzono, ale nie udało się otworzyć: \(resp.label)", error: true)
            }
        } catch {
            // 409 = prośba wygasła / już obsłużona — po prostu odświeżamy listę.
        }
        approvalBusyId = nil
        await loadPendingApprovals()
    }

    private func denyGuestRequest(_ req: GuestApprovalRequest) async {
        guard approvalBusyId == nil else { return }
        approvalBusyId = req.id
        let _: GuestApprovalDenyResponse? = try? await APIClient.shared.post(
            "/resident/guest-approvals/\(req.id)/deny",
            body: GlassEmptyBody()
        )
        approvalBusyId = nil
        await loadPendingApprovals()
    }

    // MARK: - Funkcje nieruchomości i roli

    /// Moduł widoczny, gdy uprawnienia mieszkańca go nie wyłączają ORAZ API
    /// nie odpowiedziało 403 FEATURE_DISABLED. Brak pustych modułów (§7).
    private func isAvailable(_ feature: String, _ state: DashboardSourceState? = nil) -> Bool {
        if state == .unavailable { return false }
        return residentFull?.hasFeature(feature) ?? true
    }

    // MARK: - Podsumowania z realnych danych (te same tablice co listy)

    /// Tekst stanu źródła, gdy nie ma danych do policzenia. nil = policz.
    private func sourceNote(_ state: DashboardSourceState) -> String? {
        switch state {
        case .loading:     return "Ładowanie…"
        case .failed:      return "Nie udało się pobrać"
        case .unavailable: return nil
        case .loaded:      return nil
        }
    }

    private var guestsSummary: String? {
        if let note = sourceNote(srcGuests) { return note }
        let active = guests.filter { $0.passPhase() == .active }.count
        let scheduled = guests.filter { $0.passPhase() == .scheduled }.count
        if active == 0 && scheduled == 0 { return "Brak aktywnych przepustek" }
        var parts: [String] = []
        if active > 0 { parts.append(GlassPlural.pl(active, "aktywna", "aktywne", "aktywnych")) }
        if scheduled > 0 { parts.append(GlassPlural.pl(scheduled, "zaplanowana", "zaplanowane", "zaplanowanych")) }
        return parts.joined(separator: " · ")
    }

    private var myVehicles: [Vehicle] { residentFull?.vehicles ?? [] }

    private var vehiclesSummary: (text: String?, tint: Color?) {
        if let note = sourceNote(srcProfile) { return (note, nil) }
        if myVehicles.isEmpty { return ("Brak pojazdów", nil) }
        let pending = myVehicles.filter { $0.effectiveStatus == .pending }.count
        let rejected = myVehicles.filter { $0.effectiveStatus == .rejected }.count
        var parts = [GlassPlural.pl(myVehicles.count, "pojazd", "pojazdy", "pojazdów")]
        if pending > 0 { parts.append("\(pending) czeka na akceptację") }
        if rejected > 0 { parts.append("\(rejected) odrzucony") }
        return (parts.joined(separator: " · "), pending + rejected > 0 ? GlassColor.orbAmber1 : nil)
    }

    private var paymentAttention: AttentionRules.PaymentAttention {
        guard srcPayments == .loaded, let charge = payments?.currentCharge else { return .none }
        return AttentionRules.payment(
            chargeStatus: charge.status,
            dueDate: GlassFormat.iso8601.date(from: charge.dueDate)
                ?? ISO8601DateFormatter().date(from: charge.dueDate),
            now: Date()
        )
    }

    private var paymentsSummary: (text: String?, tint: Color?) {
        if let note = sourceNote(srcPayments) { return (note, nil) }
        guard let p = payments else { return (nil, nil) }
        if let charge = p.currentCharge {
            let left = max(0, charge.totalAmount - charge.paidAmount)
            switch charge.status {
            case "OVERDUE":
                return ("Po terminie · \(Self.money(left))", GlassColor.dangerSoft)
            case "UNPAID", "PARTIAL":
                return ("\(charge.statusLabel) · \(Self.money(left))", nil)
            default:
                return (charge.statusLabel, nil)
            }
        }
        // Brak naliczenia w odpowiedzi → tylko saldo z API (ujemne = do zapłaty).
        if p.balance < 0 { return ("Do zapłaty: \(Self.money(-p.balance))", GlassColor.dangerSoft) }
        return ("Brak zaległości", nil)
    }

    private static func money(_ v: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        f.locale = Locale(identifier: "pl_PL")
        return (f.string(from: NSNumber(value: v)) ?? String(format: "%.2f", v)) + " zł"
    }

    private var waitingParcels: [Parcel] {
        parcels.filter { $0.status == "RECEIVED" }
    }

    private var parcelsSummary: String? {
        if let note = sourceNote(srcParcels) { return note }
        let n = waitingParcels.count
        return n == 0 ? "Brak paczek do odbioru" : "\(n) do odbioru"
    }

    private var openTickets: [Ticket] { tickets.filter { $0.status != "DONE" } }

    /// Otwarte zgłoszenia, w których ostatnia odpowiedź jest od obsługi
    /// i mieszkaniec jeszcze jej nie otworzył (GlassTicketSeenStore).
    private var ticketsAwaitingMe: [Ticket] {
        openTickets.filter { t in
            guard let last = t.replies?.last,
                  AttentionRules.ticketAwaitsResident(status: t.status, lastReplyAuthorType: last.authorType)
            else { return false }
            return (GlassTicketSeenStore.seenReplyId(ticketId: t.id) ?? 0) < last.id
        }
    }

    private var ticketsSummary: String? {
        if let note = sourceNote(srcTickets) { return note }
        if openTickets.isEmpty { return "Brak otwartych zgłoszeń" }
        var text = GlassPlural.pl(openTickets.count, "otwarte", "otwarte", "otwartych")
        let replies = ticketsAwaitingMe.count
        if replies > 0 { text += " · " + GlassPlural.pl(replies, "nowa odpowiedź", "nowe odpowiedzi", "nowych odpowiedzi") }
        return text
    }

    // MARK: - „Wymaga uwagi"

    private var expiringGuests: [Guest] {
        let now = Date()
        return guests
            .filter { AttentionRules.guestPassExpiresSoon(phase: $0.passPhase(now: now), validTo: $0.validTo, now: now) }
            .sorted { $0.validTo < $1.validTo }
    }

    /// Pozycje wyłącznie z pobranych danych; każda prowadzi do właściwego
    /// obiektu. Jedno zdarzenie = jedna pozycja (płatność: po terminie ALBO
    /// zbliżający się termin, nigdy obie).
    private var attentionItems: [GlassAttentionItem] {
        var items: [GlassAttentionItem] = []

        if isAvailable("payments", srcPayments), let charge = payments?.currentCharge {
            switch paymentAttention {
            case .overdue:
                let days = charge.daysOverdue.map { $0 > 0 ? " · \(GlassPlural.pl($0, "dzień", "dni", "dni")) po terminie" : "" } ?? ""
                items.append(GlassAttentionItem(
                    id: "payment-overdue", icon: "creditcard.trianglebadge.exclamationmark",
                    tint: GlassColor.dangerSoft,
                    title: "Płatność po terminie",
                    detail: "Naliczenie \(charge.period): \(Self.money(max(0, charge.totalAmount - charge.paidAmount)))\(days)",
                    action: { activeSheet = .payments }
                ))
            case .dueSoon(let days):
                let when = days == 0 ? "dziś" : (days == 1 ? "jutro" : "za \(days) dni")
                items.append(GlassAttentionItem(
                    id: "payment-due", icon: "creditcard",
                    tint: GlassColor.orbAmber1,
                    title: "Termin płatności \(when)",
                    detail: "Naliczenie \(charge.period): \(Self.money(max(0, charge.totalAmount - charge.paidAmount)))",
                    action: { activeSheet = .payments }
                ))
            case .none:
                break
            }
        }

        if isAvailable("tickets", srcTickets) {
            for t in ticketsAwaitingMe.prefix(3) {
                let who = t.replies?.last?.authorName ?? "Administracja"
                items.append(GlassAttentionItem(
                    id: "ticket-\(t.id)", icon: "bubble.left.and.text.bubble.right",
                    tint: GlassColor.accentLight,
                    title: "Nowa odpowiedź w zgłoszeniu",
                    detail: "\(t.title) · \(who)",
                    action: {
                        pushTicketId = t.id
                        activeSheet = .tickets
                    }
                ))
            }
        }

        if isAvailable("parcels", srcParcels), !waitingParcels.isEmpty {
            let n = waitingParcels.count
            let couriers = Array(Set(waitingParcels.map(\.courier))).sorted().prefix(3).joined(separator: ", ")
            items.append(GlassAttentionItem(
                id: "parcels", icon: "shippingbox",
                tint: GlassColor.orbBlue1,
                title: n == 1 ? "Paczka do odebrania" : "\(GlassPlural.pl(n, "paczka", "paczki", "paczek")) do odebrania",
                detail: couriers.isEmpty ? "Czeka w punkcie odbioru" : couriers,
                action: { activeSheet = .parcels }
            ))
        }

        if isAvailable("guests", srcGuests) {
            for g in expiringGuests.prefix(3) {
                items.append(GlassAttentionItem(
                    id: "guest-\(g.id)", icon: "person.badge.clock",
                    tint: GlassColor.success,
                    title: "Przepustka wygasa: \(g.name)",
                    detail: "Ważna do \(GlassFormat.shortDateTime.string(from: g.validTo)) · możesz przedłużyć",
                    action: {
                        focusGuestId = g.id
                        activeSheet = .guests
                    }
                ))
            }
        }
        return items
    }

    private var attentionVerdict: AttentionVerdict {
        AttentionVerdict.resolve(
            sources: [srcParcels, srcPayments, srcGuests, srcTickets],
            itemCount: attentionItems.count
        )
    }

    /// Kropka na zakładce = są tam pozycje „Wymaga uwagi" (te same dane).
    private var flaggedTabs: Set<GlassHomeTab> {
        var out: Set<GlassHomeTab> = []
        let ids = attentionItems.map(\.id)
        if ids.contains(where: { $0.hasPrefix("payment") || $0.hasPrefix("ticket") || $0 == "parcels" }) {
            out.insert(.matters)
        }
        if ids.contains(where: { $0.hasPrefix("guest-") }) || !pendingApprovals.isEmpty {
            out.insert(.access)
        }
        return out
    }

    // MARK: - Skróty na Domu (2×2, tylko dostępne moduły)

    private var shortcutsGrid: some View {
        let columns = [GridItem(.flexible(), spacing: 9), GridItem(.flexible(), spacing: 9)]
        return VStack(alignment: .leading, spacing: 7) {
            Text("SKRÓTY")
                .font(.caption2.weight(.semibold))
                .tracking(1.4)
                .foregroundStyle(.white.opacity(0.7))
                .padding(.horizontal, 8)
                .accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: columns, spacing: 9) {
                if isAvailable("guests", srcGuests) {
                    GlassShortcutTile(
                        gradient: [GlassColor.success, GlassColor.accentBlue],
                        icon: "person.2", title: "Goście", summary: guestsSummary
                    ) { activeSheet = .guests }
                }
                if isAvailable("vehicles") {
                    GlassShortcutTile(
                        gradient: [GlassColor.accentBlue, GlassColor.orbViolet],
                        icon: "car.fill", title: "Pojazdy",
                        summary: vehiclesSummary.text, summaryTint: vehiclesSummary.tint
                    ) { activeSheet = .vehicles }
                }
                if isAvailable("payments", srcPayments) {
                    GlassShortcutTile(
                        gradient: [GlassColor.dangerSoft, GlassColor.dangerDeep],
                        icon: "creditcard", title: "Płatności",
                        summary: paymentsSummary.text, summaryTint: paymentsSummary.tint
                    ) { activeSheet = .payments }
                }
                if isAvailable("parcels", srcParcels) {
                    GlassShortcutTile(
                        gradient: [GlassColor.orbBlue1, GlassColor.orbBlue2],
                        icon: "cube", title: "Przesyłki", summary: parcelsSummary
                    ) { activeSheet = .parcels }
                }
            }
        }
    }

    // MARK: - Zakładka Dostęp

    @ViewBuilder
    private var accessTab: some View {
        GlassHubHeader(title: "Dostęp", subtitle: "Wejścia, goście, pojazdy, domownicy i zamki")

        if !pendingApprovals.isEmpty {
            guestApprovalsSection
        }

        GlassHubSection(title: "Wejścia") {
            GlassHubRow(
                gradient: [GlassColor.accentBlue, GlassColor.orbViolet],
                icon: "door.left.hand.open", title: "Wszystkie wejścia",
                summary: entrancesSummary
            ) { activeSheet = .gate }
            GlassHubRow(
                gradient: [GlassColor.success, GlassColor.accentBlue],
                icon: "phone.fill", title: "Domofon",
                summary: "Połącz ze stacją przy wejściu",
                busy: intercomBusy
            ) { Task { await startIntercomFlow() } }
            GlassHubRow(
                gradient: [GlassColor.accentLight, GlassColor.orbPurple],
                icon: "clock.arrow.circlepath", title: "Historia zdarzeń",
                summary: "Wjazdy, wejścia gości, otwarcia zdalne, domofon",
                showDivider: false
            ) { activeSheet = .history }
        }

        GlassHubSection(title: "Osoby i pojazdy") {
            if isAvailable("guests", srcGuests) {
                GlassHubRow(
                    gradient: [GlassColor.success, GlassColor.accentBlue],
                    icon: "person.2", title: "Goście",
                    summary: guestsSummary
                ) { activeSheet = .guests }
            }
            if isAvailable("vehicles") {
                GlassHubRow(
                    gradient: [GlassColor.accentBlue, GlassColor.orbViolet],
                    icon: "car.fill", title: "Pojazdy",
                    summary: vehiclesSummary.text, summaryTint: vehiclesSummary.tint
                ) { activeSheet = .vehicles }
            }
            GlassHubRow(
                gradient: [GlassColor.orbAmber1, GlassColor.orbAmber2],
                icon: "person.3", title: "Domownicy",
                summary: "Osoby z dostępem do Twojego lokalu",
                showDivider: false
            ) { activeSheet = .household }
        }

        GlassHubSection(title: "Zamki") {
            ForEach(nukiLocks) { lock in
                GlassNukiLockHubRow(lock: lock) { activeSheet = .nukiOnboarding }
            }
            GlassHubRow(
                gradient: [GlassColor.orbAmber1, GlassColor.orbAmber2],
                icon: "lock.badge.plus",
                title: nukiLocks.isEmpty ? "Dodaj zamek Nuki" : "Zarządzaj zamkami Nuki",
                summary: nukiLocks.isEmpty ? "Połącz zamek drzwi swojego lokalu" : nil,
                showDivider: false
            ) { activeSheet = .nukiOnboarding }
        }
    }

    private var entrancesSummary: String {
        if accessPoints.isEmpty {
            return loadFailed ? "Nie udało się pobrać" : "Brak przypisanych wejść"
        }
        return GlassPlural.pl(accessPoints.count, "wejście", "wejścia", "wejść")
    }

    // MARK: - Zakładka Sprawy

    @ViewBuilder
    private var mattersTab: some View {
        GlassHubHeader(title: "Sprawy", subtitle: "Zgłoszenia, płatności i przesyłki")

        let showTickets = isAvailable("tickets", srcTickets)
        let showPayments = isAvailable("payments", srcPayments)
        let showParcels = isAvailable("parcels", srcParcels)

        if showTickets || showPayments || showParcels {
            GlassHubSection(title: "Twoje sprawy") {
                if showTickets {
                    GlassHubRow(
                        gradient: [GlassColor.orbAmber1, GlassColor.orbAmber2],
                        icon: "wrench.and.screwdriver", title: "Zgłoszenia",
                        summary: ticketsSummary,
                        badge: ticketsAwaitingMe.count,
                        showDivider: showPayments || showParcels
                    ) { activeSheet = .tickets }
                }
                if showPayments {
                    GlassHubRow(
                        gradient: [GlassColor.dangerSoft, GlassColor.dangerDeep],
                        icon: "creditcard", title: "Płatności",
                        summary: paymentsSummary.text, summaryTint: paymentsSummary.tint,
                        showDivider: showParcels
                    ) { activeSheet = .payments }
                }
                if showParcels {
                    GlassHubRow(
                        gradient: [GlassColor.orbBlue1, GlassColor.orbBlue2],
                        icon: "cube", title: "Przesyłki",
                        summary: parcelsSummary,
                        badge: waitingParcels.count,
                        showDivider: false
                    ) { activeSheet = .parcels }
                }
            }
        } else {
            Text("Ta nieruchomość nie ma włączonych zgłoszeń, płatności ani przesyłek.")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.8))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .hubPanel()
        }
    }

    // MARK: - Zakładka Osiedle

    @ViewBuilder
    private var estateTab: some View {
        GlassHubHeader(title: "Osiedle", subtitle: building?.name ?? "Informacje i wydarzenia")

        GlassHubSection(title: "Informacje") {
            if isAvailable("notifications") {
                GlassHubRow(
                    gradient: [GlassColor.accentLight, GlassColor.orbPurple],
                    icon: "speaker.wave.1", title: "Ogłoszenia",
                    summary: "Komunikaty administracji i archiwum"
                ) { activeSheet = .announcements }
            }
            GlassHubRow(
                gradient: [GlassColor.orbBlue1, GlassColor.orbBlue2],
                icon: "calendar", title: "Kalendarz",
                summary: "Wydarzenia i terminy osiedla",
                showDivider: false
            ) { activeSheet = .calendar }
        }

        GlassHubSection(title: "Pomoc") {
            GlassHubRow(
                gradient: [GlassColor.accentBlue, GlassColor.orbViolet],
                icon: "sparkles", title: "Asystent AI",
                summary: "Zapytaj o sprawy osiedla",
                showDivider: false
            ) { activeSheet = .chat }
        }
    }

    // MARK: Sheet host

    @ViewBuilder
    private func sheetHost(maxHeight: CGFloat) -> some View {
        ZStack(alignment: .bottom) {
            if activeSheet != nil {
                Color(red: 5/255, green: 8/255, blue: 16/255)
                    .opacity(0.45)
                    .ignoresSafeArea()
                    .transition(.opacity)
                    .onTapGesture { activeSheet = nil }
            }

            if let sheet = activeSheet {
                GlassSheetContainer(onClose: { activeSheet = nil }) {
                    sheetContent(sheet)
                }
                .frame(maxHeight: maxHeight, alignment: .bottom)
                .fixedSize(horizontal: false, vertical: true)
                .transition(.move(edge: .bottom))
            }
        }
        .animation(.timingCurve(0.32, 0.72, 0, 1, duration: 0.38), value: activeSheet)
    }

    @ViewBuilder
    private func sheetContent(_ sheet: GlassSheetKind) -> some View {
        switch sheet {
        case .gate:
            GlassGateSheet(
                accessPoints: accessPoints,
                onOpen: { ap in await openAccessPoint(ap) },
                onComingSoon: { activeSheet = .comingSoon($0) },
                onClose: { activeSheet = nil }
            )
        case .camera:
            if let ap = cameraAP ?? accessPoints.first(where: { !GlassGateSheet.isFireGate($0) }) ?? accessPoints.first {
                GlassCameraSheet(
                    accessPoint: ap,
                    onConnectIntercom: { Task { await startIntercomFlow(preferred: ap) } },
                    // Otwarcie wprost z podglądu — ta sama ścieżka co kafle
                    // decka (audyt REMOTE_OPEN, odświeżenie stanu Nuki itd.).
                    onOpen: { await openAccessPoint($0) },
                    onClose: { activeSheet = nil }
                )
            }
        case .stationPick:
            stationPickSheet
        case .fireConfirm(let apId):
            GlassGateSheet(
                accessPoints: accessPoints,
                fireConfirmApId: apId,
                onOpen: { ap in await openAccessPoint(ap) },
                onComingSoon: { activeSheet = .comingSoon($0) },
                onClose: { activeSheet = nil }
            )
        case .vehicles:
            GlassVehiclesSheet(
                vehicles: residentFull?.vehicles ?? [],
                onComingSoon: { activeSheet = .comingSoon($0) },
                onReload: { await loadAll() },
                onClose: { activeSheet = nil }
            )
        case .guests:
            GlassGuestsSheet(
                guests: guests,
                initialGuestId: focusGuestId,
                onReload: { await reloadGuests() },
                onClose: { activeSheet = nil }
            )
        case .payments:
            GlassPaymentsSheet(
                initialSummary: payments,
                onComingSoon: { activeSheet = .comingSoon($0) },
                onClose: { activeSheet = nil }
            )
        case .tickets:
            GlassTicketsSheet(
                tickets: tickets,
                initialTicketId: pushTicketId,
                onReload: { await reloadTickets() },
                onClose: { activeSheet = nil }
            )
        case .parcels:
            GlassParcelsSheet(
                parcels: parcels,
                onComingSoon: { activeSheet = .comingSoon($0) },
                onClose: { activeSheet = nil }
            )
        case .announcements:
            GlassAnnouncementsSheet(
                initialNotificationId: pushAnnouncementId,
                autoOpenNewest: pushAnnouncementNewest,
                onClose: { activeSheet = nil }
            )
        case .chat:
            GlassChatSheet(onClose: { activeSheet = nil })
        case .more:
            GlassMoreSheet(
                building: building,
                onOpenProperties: { activeSheet = .properties },
                onComingSoon: { activeSheet = .comingSoon($0) },
                onClose: { activeSheet = nil }
            )
        case .household:
            // Ten sam widok domowników co dawniej w „Więcej" — teraz z zakładki
            // Dostęp, otwarty od razu na liście.
            GlassMoreSheet(
                building: building,
                onOpenProperties: { activeSheet = .properties },
                onComingSoon: { activeSheet = .comingSoon($0) },
                onClose: { activeSheet = nil },
                startInHousehold: true
            )
        case .history:
            GlassHistorySheet(onClose: { activeSheet = nil })
        case .calendar:
            GlassCalendarSheet(onClose: { activeSheet = nil })
        case .nukiOnboarding:
            GlassNukiOnboardingSheet(
                onClose: { activeSheet = nil },
                existingLocks: nukiLocks,
                onChanged: { Task { await loadSmartLocks(fresh: true) } },
            )
        case .comingSoon(let feature):
            GlassComingSoonSheet(feature: feature, onClose: { activeSheet = nil })
        case .properties:
            GlassPropertiesSheet(onClose: { activeSheet = nil })
        case .guestEvent(let route):
            GlassGuestEventSheet(route: route, onClose: { activeSheet = nil })
        case .pushContent(let route):
            GlassPushContentSheet(route: route, onClose: { activeSheet = nil })
        case .adminSituations(let b):
            GlassAdminSituationsSheet(buildingId: b, onClose: { activeSheet = nil })
        case .adminTickets(let b):
            GlassAdminTicketsSheet(buildingId: b, onClose: { activeSheet = nil })
        case .adminArrears(let b):
            GlassAdminArrearsSheet(buildingId: b, onClose: { activeSheet = nil })
        case .adminPlates(let b):
            GlassAdminPlatesSheet(buildingId: b, onClose: { activeSheet = nil })
        case .adminDevices(let b):
            GlassAdminDevicesSheet(buildingId: b, onClose: { activeSheet = nil })
        case .adminChronicle(let b):
            GlassAdminChronicleSheet(buildingId: b, onClose: { activeSheet = nil })
        }
    }

    // MARK: Wybór stacji domofonowej (>1 stacja z aktywnym mostem)

    private var stationPickSheet: some View {
        VStack(spacing: 9) {
            GlassSheetHeader(kicker: "Domofon", title: "Z którą stacją?", onClose: { activeSheet = nil })

            ForEach(stations) { station in
                GlassActionRow(
                    orbGradient: [GlassColor.accentBlue, GlassColor.orbViolet],
                    orbIcon: "phone.fill",
                    title: station.name,
                    subtitle: "Stacja domofonowa"
                ) {
                    GlassOpenCTA(phase: .idle, idleText: "Połącz") {
                        activeSheet = nil
                        CallManager.shared.startOutboundCall(intercomId: station.id)
                    }
                }
            }

            GlassButton(title: "Anuluj", style: .ghost) {
                activeSheet = nil
            }
            .padding(.top, 4)
        }
    }

    // MARK: Toast host

    private var toastHost: some View {
        VStack {
            Spacer()
            if let msg = toast.message {
                GlassToastView(message: msg, isError: toast.isError)
                    .padding(.bottom, 80)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: toast.message)
        .allowsHitTesting(false)
        .zIndex(200)
    }

    // MARK: Zła rola (Glass β jest resident-only)

    private var wrongRoleNotice: some View {
        VStack(spacing: 14) {
            Image(systemName: "person.crop.circle.badge.exclamationmark")
                .font(.system(size: 40))
                .foregroundStyle(.white.opacity(0.6))
            Text("GateLynk β obsługuje tylko konto mieszkańca.")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
            GlassButton(title: "Wyloguj", style: .ghost) { auth.logout() }
                .frame(width: 180)
        }
        .padding(30)
    }

    // MARK: - Dane

    /// Jedno źródło → (dane, stan). 403 = moduł wyłączony dla osiedla/roli
    /// (FEATURE_DISABLED) — to nie awaria. Poprzednie dane zostają przy
    /// błędzie sieci (nie zerujemy list na chwilowym timeoucie).
    private func fetchSource<T: Decodable>(_ path: String) async -> (T?, DashboardSourceState) {
        do {
            let value: T = try await APIClient.shared.get(path)
            return (value, .loaded)
        } catch APIError.httpError(let code, _) where code == 403 {
            return (nil, .unavailable)
        } catch {
            return (nil, .failed)
        }
    }

    private func loadAll() async {
        async let bld: Building? = try? APIClient.shared.get("/resident/building")
        async let res: (Resident?, DashboardSourceState) = fetchSource("/resident/me")
        async let aps: [AccessPoint] = (try? APIClient.shared.get("/resident/access-points")) ?? []
        async let parc: ([Parcel]?, DashboardSourceState) = fetchSource("/resident/parcels")
        async let pay: (PaymentSummary?, DashboardSourceState) = fetchSource("/resident/payments")
        async let gst: ([Guest]?, DashboardSourceState) = fetchSource("/resident/guests")
        async let tck: ([Ticket]?, DashboardSourceState) = fetchSource("/resident/tickets")

        building = await bld
        let (me, meState) = await res
        if let me { residentFull = me }
        srcProfile = meState
        accessPoints = (await aps).sorted { $0.sortOrder < $1.sortOrder }
        // Sync cache Siri/App Intents (2026-07-16) — frazy typu „Otwórz wjazd w GateLynk".
        GlassEntranceStore.save(accessPoints)

        let (p, pState) = await parc
        if let p { parcels = p } else if pState == .unavailable { parcels = [] }
        srcParcels = pState
        let (pm, pmState) = await pay
        if let pm { payments = pm } else if pmState == .unavailable { payments = nil }
        srcPayments = pmState
        let (g, gState) = await gst
        if let g { guests = g } else if gState == .unavailable { guests = [] }
        srcGuests = gState
        let (t, tState) = await tck
        if let t { tickets = t } else if tState == .unavailable { tickets = [] }
        srcTickets = tState

        // Offline detection: wszystkie kluczowe fetch-e puste → pokaż banner
        // z retry (zamiast wiecznego „Łączenie z osiedlem…").
        withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) {
            loadFailed = building == nil && me == nil && accessPoints.isEmpty
        }

        // Pogoda w tle — nie blokuje pull-to-refresh, brak sieci = zostaje data
        if let address = building?.address {
            Task { weather = await GlassWeather.fetch(address: address) }
        }

        // 2026-07-08 — prośby gości o otwarcie drzwi mieszkania (fail-silent).
        await loadPendingApprovals()

        // 2026-07-10 — live stan zamków Nuki (fail-silent na starym backendzie).
        await loadSmartLocks()
    }

    /// GET /resident/smart-lock → live stan zamków lokalu. `fresh` omija 12 s
    /// cache Cloud (używane po otwarciu zamka, żeby user zobaczył zmianę).
    /// Fail-silent: stary/brak backendu → zostaje poprzedni stan (pusta lista).
    private func loadSmartLocks(fresh: Bool = false) async {
        let path = fresh ? "/resident/smart-lock?fresh=1" : "/resident/smart-lock"
        if let resp: NukiStatusResponse = try? await APIClient.shared.get(path) {
            nukiLocks = resp.locks
        }
    }

    private func reloadGuests() async {
        if let g: [Guest] = try? await APIClient.shared.get("/resident/guests") {
            guests = g
            srcGuests = .loaded
        }
    }

    private func reloadTickets() async {
        if let t: [Ticket] = try? await APIClient.shared.get("/resident/tickets") {
            tickets = t
            srcTickets = .loaded
        }
    }

    // MARK: - Otwieranie

    /// Jedno żądanie = jedno polecenie; BEZ automatycznych powtórek.
    /// Wynik zgodny z kontraktem API (audyt UX 2026-09-21, P0 3.1):
    /// `success` = Edge/urządzenie PRZYJĘŁO polecenie przekaźnika — to nie jest
    /// potwierdzenie fizycznego otwarcia (bramy nie raportują stanu). Timeout
    /// lub zerwane połączenie → `.unknown`, nie błąd i nie sukces.
    private func openAccessPoint(_ ap: AccessPoint) async -> AccessOpenOutcome {
        do {
            let r: OpenAccessPointResponse = try await APIClient.shared.post(
                "/resident/access-points/\(ap.id)/open",
                body: GlassEmptyBody()
            )
            // Zamek Nuki MA telemetrię: po ~2.5 s odśwież realny stan rygla,
            // żeby linia stanu pokazała faktyczną zmianę.
            if r.success, ap.isUnitDoor {
                Task {
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    await loadSmartLocks(fresh: true)
                }
            }
            return r.success ? .accepted : .failed(nil)
        } catch {
            return AccessOpenOutcome.from(error: error)
        }
    }
}

struct GlassEmptyBody: Encodable {}

// MARK: - Sfera 3D (radial-gradient biały→fiolet→indygo, float 7s)

struct GlassSphere: View {
    @State private var floating = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            Circle()
                .fill(
                    RadialGradient(
                        stops: [
                            .init(color: .white, location: 0),
                            .init(color: GlassColor.accentLight, location: 0.35),
                            .init(color: GlassColor.accentBlue, location: 0.7),
                            .init(color: Color(red: 42/255, green: 26/255, blue: 140/255), location: 1),
                        ],
                        center: UnitPoint(x: 0.3, y: 0.3),
                        startRadius: 4, endRadius: 110
                    )
                )
                .shadow(color: GlassColor.accentBlue.opacity(0.45), radius: 25, y: 12)

            // Blik światła
            Ellipse()
                .fill(
                    RadialGradient(
                        colors: [.white.opacity(0.95), .clear],
                        center: .center, startRadius: 0, endRadius: 26
                    )
                )
                .frame(width: 54, height: 34)
                .blur(radius: 2)
                .offset(x: 25, y: 22)
        }
        .frame(width: 158, height: 158)
        .rotationEffect(.degrees(floating ? 4 : 0))
        .offset(y: floating ? -12 : 0)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 3.5).repeatForever(autoreverses: true)) {
                floating = true
            }
        }
    }
}

// MARK: - Kafelek (glass radius 24, orb 38, spring press)

struct GlassTile: View {
    let gradient: [Color]
    let icon: String
    let label: String
    var iconWeight: Font.Weight = .semibold
    var iconRotation: Double = 0
    var showAlertDot = false
    var badgeCount = 0
    /// Rozfazowany start przejazdu światła (PROMPT 3) — nil = bez shimmeru.
    var shimmerDelay: Double? = nil
    let action: () -> Void

    @State private var pressed = false

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                VStack(alignment: .leading, spacing: 9) {
                    GlassOrb(
                        gradient: gradient, systemName: icon,
                        iconWeight: iconWeight, iconRotation: iconRotation
                    )
                    Text(label)
                        .font(.system(size: 12, weight: .semibold))
                        .tracking(-0.1)
                        .foregroundStyle(.white)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)

                if showAlertDot {
                    GlassPulsingDot()
                        .padding(.top, 10)
                        .padding(.trailing, 12)
                }

                if badgeCount > 0 {
                    Text("\(badgeCount)")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 17, minHeight: 17)
                        .background {
                            Capsule()
                                .fill(GlassColor.accentGradient)
                                .shadow(color: GlassColor.accentBlue.opacity(0.55), radius: 5, y: 2)
                        }
                        .padding(.top, 9)
                        .padding(.trailing, 11)
                }
            }
            .glassCard(radius: GlassRadius.tile)
            .glassShimmer(optionalDelay: shimmerDelay, radius: GlassRadius.tile)
            .scaleEffect(pressed ? 0.96 : 1)
        }
        .buttonStyle(.plain)
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    withAnimation(.timingCurve(0.34, 1.56, 0.64, 1, duration: 0.2)) { pressed = true }
                }
                .onEnded { _ in
                    withAnimation(.timingCurve(0.34, 1.56, 0.64, 1, duration: 0.2)) { pressed = false }
                }
        )
    }
}

// MARK: - Pogoda (Open-Meteo, bez klucza API)
//
// Linia powitania z prototypu: "21°C · jasno · wracasz do domu".
// Miasto wyciągamy z adresu budynku (geocoding-api.open-meteo.com),
// potem current weather. Każdy błąd → nil → UI pokazuje datę.

struct GlassWeatherNow: Equatable {
    let temp: Int
    let desc: String
}

enum GlassWeather {
    private struct GeoResponse: Decodable {
        struct Place: Decodable {
            let latitude: Double
            let longitude: Double
        }
        let results: [Place]?
    }

    private struct ForecastResponse: Decodable {
        struct Current: Decodable {
            let temperature2m: Double
            let weatherCode: Int
            enum CodingKeys: String, CodingKey {
                case temperature2m = "temperature_2m"
                case weatherCode = "weather_code"
            }
        }
        let current: Current
    }

    static func fetch(address: String) async -> GlassWeatherNow? {
        for candidate in cityCandidates(address) {
            guard let place = await geocode(candidate) else { continue }
            if let now = await current(lat: place.latitude, lon: place.longitude) {
                return now
            }
        }
        return nil
    }

    /// "ul. Bałtycka 12, 81-742 Sopot" → ["Sopot", "Bałtycka"] — kandydaci
    /// od końca adresu (miasto zwykle ostatnie), bez numerów i kodów.
    private static func cityCandidates(_ address: String) -> [String] {
        address
            .components(separatedBy: ",")
            .map { part in
                part.components(separatedBy: " ")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { token in
                        !token.isEmpty
                            && token.rangeOfCharacter(from: .decimalDigits) == nil
                            && !["ul.", "ul", "al.", "al", "os.", "pl."].contains(token.lowercased())
                    }
                    .joined(separator: " ")
            }
            .filter { $0.count >= 3 }
            .reversed()
    }

    private static func geocode(_ name: String) async -> GeoResponse.Place? {
        var comps = URLComponents(string: "https://geocoding-api.open-meteo.com/v1/search")!
        comps.queryItems = [
            URLQueryItem(name: "name", value: name),
            URLQueryItem(name: "count", value: "1"),
            URLQueryItem(name: "language", value: "pl"),
        ]
        guard let url = comps.url,
              let (data, _) = try? await URLSession.shared.data(from: url),
              let resp = try? JSONDecoder().decode(GeoResponse.self, from: data)
        else { return nil }
        return resp.results?.first
    }

    private static func current(lat: Double, lon: Double) async -> GlassWeatherNow? {
        var comps = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        comps.queryItems = [
            URLQueryItem(name: "latitude", value: String(lat)),
            URLQueryItem(name: "longitude", value: String(lon)),
            URLQueryItem(name: "current", value: "temperature_2m,weather_code"),
        ]
        guard let url = comps.url,
              let (data, _) = try? await URLSession.shared.data(from: url),
              let resp = try? JSONDecoder().decode(ForecastResponse.self, from: data)
        else { return nil }
        return GlassWeatherNow(
            temp: Int(resp.current.temperature2m.rounded()),
            desc: describe(resp.current.weatherCode)
        )
    }

    /// Kody pogodowe WMO → krótki polski opis (konwencja prototypu: "jasno").
    private static func describe(_ code: Int) -> String {
        switch code {
        case 0:        return "bezchmurnie"
        case 1, 2:     return "jasno"
        case 3:        return "pochmurno"
        case 45, 48:   return "mgła"
        case 51...57:  return "mżawka"
        case 61...67:  return "deszcz"
        case 71...77:  return "śnieg"
        case 80...82:  return "przelotny deszcz"
        case 85, 86:   return "śnieg"
        case 95...99:  return "burza"
        default:       return "jasno"
        }
    }
}

// MARK: - Pulsująca czerwona kropka (zaległość)

struct GlassPulsingDot: View {
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(GlassColor.danger)
            .frame(width: 8, height: 8)
            .shadow(color: GlassColor.danger.opacity(pulsing ? 0.9 : 0.4), radius: pulsing ? 7 : 3)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                    pulsing = true
                }
            }
    }
}
