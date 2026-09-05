import SwiftUI

// MARK: - Ekran główny Glass Depth Premium
//
// Struktura (README): powitanie → karta "Otwórz" ze sliderem → 2 rzędy
// kafelków → karta "Asystent osiedla" → floating tab bar (Dom / ✦ Zapytaj AI /
// Więcej). Tło adaptacyjne wg pory dnia, badge w prawym górnym rogu
// przełącza porę ręcznie (demo, jak w prototypie).
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

    // Domofon — obserwacja błędów wychodzącego połączenia (STATION_BUSY itp.)
    // musi żyć na poziomie Home (sheet bramy zamyka się przy inicjacji rozmowy).
    @State private var call = CallManager.shared

    // UI
    @State private var activeSheet: GlassSheetKind?
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
    @State private var todOverride = false
    @State private var tabBarShown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
                GlassBackground(tod: tod)

                if isResident {
                    mainContent
                    todBadge
                    propertyBadge
                    if loadFailed { offlineBanner }
                    tabBar
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
            if newSheet != .announcements {
                pushAnnouncementId = nil
                pushAnnouncementNewest = false
            }
        }
        .onReceive(
            Timer.publish(every: 60, on: .main, in: .common).autoconnect()
        ) { _ in
            guard !todOverride else { return }
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
        VStack {
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
            .padding(.horizontal, 16)
            .padding(.top, 52)
            Spacer()
        }
        .transition(.move(edge: .top).combined(with: .opacity))
        .zIndex(50)
    }

    private var isResident: Bool {
        if case .resident = auth.role { return true }
        return false
    }

    private var firstName: String {
        if case .resident(let u) = auth.role { return u.firstName }
        return ""
    }

    // MARK: - Treść główna

    private var mainContent: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 10) {
                greeting
                    .glassRiseIn(delay: 0.15)

                // 2026-07-08 — prośby gości o otwarcie drzwi mieszkania,
                // na górze i tylko gdy są oczekujące.
                if !pendingApprovals.isEmpty {
                    guestApprovalsSection
                }

                accessDeckCard
                    .glassShimmer(delay: 0, radius: GlassRadius.primary)
                    .glassRiseIn(delay: 0.3)

                tilesRow1
                    .glassRiseIn(delay: 0.45)

                tilesRow2
                    .glassRiseIn(delay: 0.6)

                GlassAssistantCard {
                    activeSheet = .announcements
                }
                .glassShimmer(delay: 0, radius: 22)
                .glassRiseIn(delay: 0.75)
            }
            .padding(.horizontal, 16)
            .padding(.top, 64)
            .padding(.bottom, 110)
        }
        .refreshable { await loadAll() }
    }

    // MARK: Powitanie

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text((building?.name ?? "Twoje osiedle").uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(2.0)
                .foregroundStyle(.white.opacity(0.78))
                .shadow(color: .black.opacity(0.5), radius: 6, y: 2)

            (Text("Cześć, ").fontWeight(.medium) + Text(firstName).fontWeight(.bold))
                .font(.system(size: 34))
                .tracking(-1)
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.5), radius: 15, y: 2)

            Text(greetingMeta)
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.62))
                .shadow(color: .black.opacity(0.4), radius: 6, y: 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.top, 14)
        .padding(.bottom, 26)
    }

    /// Prototyp: "21°C · jasno · wracasz do domu". Pogoda realna (Open-Meteo
    /// po adresie budynku); zanim się załaduje — data jak dotychczas.
    private var greetingMeta: String {
        guard let w = weather else { return GlassFormat.dayLabel() }
        return "\(w.temp)°C · \(w.desc) · \(todPhrase)"
    }

    private var todPhrase: String {
        switch tod {
        case .day:     return "miłego dnia"
        case .evening: return "wracasz do domu"
        case .night:   return "dobranoc"
        }
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
            lockStatuses: nukiLockMap
        )
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
                toast.show("\(resp.label) — otwarto dla gościa")
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

    // MARK: Kafelki

    // Ikony 1:1 z prototypu: Pojazdy wypełnione auto, reszta konturowa
    // (stroke 1.9 → SF outline + .medium), Zgłoszenia = klucz+śrubokręt
    // (serwis; klucz pod kątem mylił się z dostępem — feedback 2026-08-19),
    // Przesyłki = sześcian 3D, Ogłoszenia = głośnik z falą.

    // Shimmer: delaye 5/10 s per kafelek jak klasy sh2/sh3 w HTML
    // (row1: sh2 sh2 sh3, row2: sh3 sh2 sh2) — refleks „wędruje" po siatce.

    private var tilesRow1: some View {
        HStack(spacing: 9) {
            GlassTile(
                gradient: [GlassColor.accentBlue, GlassColor.orbViolet],
                icon: "car.fill", label: "Pojazdy",
                shimmerDelay: 5
            ) { activeSheet = .vehicles }

            GlassTile(
                gradient: [GlassColor.success, GlassColor.accentBlue],
                icon: "person.2", label: "Goście",
                iconWeight: .medium,
                shimmerDelay: 5
            ) { activeSheet = .guests }

            GlassTile(
                gradient: [GlassColor.dangerSoft, GlassColor.dangerDeep],
                icon: "creditcard", label: "Płatność",
                iconWeight: .medium,
                showAlertDot: hasOverduePayment,
                shimmerDelay: 10
            ) { activeSheet = .payments }
        }
    }

    private var tilesRow2: some View {
        HStack(spacing: 9) {
            GlassTile(
                // 2026-08-19 (feedback Konrada): klucz z prototypu sugerował
                // DOSTĘP, nie zgłoszenie usterki. Klucz+śrubokręt = naprawa /
                // serwis — czytelne dla „zgłoś problem administracji".
                gradient: [GlassColor.orbAmber1, GlassColor.orbAmber2],
                icon: "wrench.and.screwdriver", label: "Zgłoszenia",
                iconWeight: .medium,
                shimmerDelay: 10
            ) { activeSheet = .tickets }

            GlassTile(
                gradient: [GlassColor.orbBlue1, GlassColor.orbBlue2],
                icon: "cube", label: "Przesyłki",
                iconWeight: .medium,
                badgeCount: waitingParcelsCount,
                shimmerDelay: 5
            ) { activeSheet = .parcels }

            GlassTile(
                gradient: [GlassColor.accentLight, GlassColor.orbPurple],
                icon: "speaker.wave.1", label: "Ogłoszenia",
                iconWeight: .medium,
                shimmerDelay: 5
            ) { activeSheet = .announcements }
        }
    }

    private var hasOverduePayment: Bool {
        (payments?.balance ?? 0) < 0
    }

    private var waitingParcelsCount: Int {
        parcels.filter { $0.status == "RECEIVED" }.count
    }

    // MARK: Ikonka domku (lewy górny róg) — menu nieruchomości

    // Decyzja właściciela 2026-08-11: zmiana nieruchomości ma być NA WIERZCHU,
    // nie schowana w „Więcej". Domek otwiera GlassPropertiesSheet (zmień /
    // dodaj nieruchomość); wiersz „Osiedle" w „Więcej" prowadzi w to samo
    // miejsce. Styl = lustrzane odbicie badge'a pory dnia po prawej.
    private var propertyBadge: some View {
        VStack {
            HStack {
                Button {
                    activeSheet = .properties
                } label: {
                    Image(systemName: "house.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 30, height: 26)
                        .background {
                            Capsule().fill(.ultraThinMaterial)
                                .overlay { Capsule().fill(Color.white.opacity(0.08)) }
                        }
                        .overlay { Capsule().strokeBorder(Color.white.opacity(0.2), lineWidth: 1) }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                Spacer()
            }
            .padding(.leading, 24)
            .padding(.top, 8)
            Spacer()
        }
    }

    // MARK: Badge pory dnia

    private var todBadge: some View {
        VStack {
            HStack {
                Spacer()
                Button {
                    todOverride = true
                    withAnimation(.easeInOut(duration: 1.2)) { tod = tod.next }
                } label: {
                    Text(tod.badgeLabel)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 5)
                        .background {
                            Capsule().fill(.ultraThinMaterial)
                                .overlay { Capsule().fill(Color.white.opacity(0.08)) }
                        }
                        .overlay { Capsule().strokeBorder(Color.white.opacity(0.2), lineWidth: 1) }
                }
                .buttonStyle(.plain)
            }
            .padding(.trailing, 24)
            .padding(.top, 8)
            Spacer()
        }
    }

    // MARK: Tab bar (floating pill — 3 elementy)

    private var tabBar: some View {
        VStack {
            Spacer()
            HStack(spacing: 4) {
                // Dom — aktywny
                HStack(spacing: 5) {
                    Image(systemName: "house.fill")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Dom")
                        .font(.system(size: 11, weight: .bold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background {
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [GlassColor.accentLight.opacity(0.4), GlassColor.accentBlue.opacity(0.4)],
                                startPoint: .topLeading, endPoint: .bottomTrailing
                            )
                        )
                }

                // Zapytaj AI — wyróżniony
                Button {
                    activeSheet = .chat
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "sparkle")
                            .font(.system(size: 11, weight: .bold))
                        Text("Zapytaj AI")
                            .font(.system(size: 12, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 9)
                    .background {
                        Capsule()
                            .fill(GlassColor.accentGradient)
                            .shadow(color: GlassColor.accentBlue.opacity(0.5), radius: 9, y: 4)
                    }
                }
                .buttonStyle(.plain)

                // Więcej
                Button {
                    activeSheet = .more
                } label: {
                    Text("Więcej")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.white.opacity(0.6))
                        .padding(.horizontal, 13)
                        .padding(.vertical, 9)
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
            .background {
                Capsule().fill(.ultraThinMaterial)
                    .overlay { Capsule().fill(Color(red: 18/255, green: 18/255, blue: 28/255).opacity(0.45)) }
            }
            .overlay { Capsule().strokeBorder(Color.white.opacity(0.18), lineWidth: 1) }
            .shadow(color: .black.opacity(0.5), radius: 20, y: 10)
            .opacity(tabBarShown ? 1 : 0)
            .offset(y: tabBarShown ? 0 : 26)
            .onAppear {
                if reduceMotion {
                    tabBarShown = true
                } else {
                    withAnimation(.timingCurve(0.22, 0.9, 0.3, 1, duration: 0.8).delay(0.9)) {
                        tabBarShown = true
                    }
                }
            }
            .padding(.bottom, 6)
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
                nukiLocks: nukiLocks,
                onOpenHistory: { activeSheet = .history },
                onOpenCalendar: { activeSheet = .calendar },
                onOpenNukiLock: { activeSheet = .nukiOnboarding },
                onOpenProperties: { activeSheet = .properties },
                onComingSoon: { activeSheet = .comingSoon($0) },
                onClose: { activeSheet = nil }
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

    private func loadAll() async {
        async let bld: Building? = try? APIClient.shared.get("/resident/building")
        async let res: Resident? = try? APIClient.shared.get("/resident/me")
        async let aps: [AccessPoint] = (try? APIClient.shared.get("/resident/access-points")) ?? []
        async let parc: [Parcel] = (try? APIClient.shared.get("/resident/parcels")) ?? []
        async let pay: PaymentSummary? = try? APIClient.shared.get("/resident/payments")
        async let gst: [Guest] = (try? APIClient.shared.get("/resident/guests")) ?? []
        async let tck: [Ticket] = (try? APIClient.shared.get("/resident/tickets")) ?? []

        building = await bld
        residentFull = await res
        accessPoints = (await aps).sorted { $0.sortOrder < $1.sortOrder }
        // Sync cache Siri/App Intents (2026-07-16) — frazy typu „Otwórz wjazd w GateLynk".
        GlassEntranceStore.save(accessPoints)
        parcels = await parc
        payments = await pay
        guests = await gst
        tickets = await tck

        // Offline detection: wszystkie kluczowe fetch-e puste → pokaż banner
        // z retry (zamiast wiecznego „Łączenie z osiedlem…").
        withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) {
            loadFailed = building == nil && residentFull == nil && accessPoints.isEmpty
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
        }
    }

    private func reloadTickets() async {
        if let t: [Ticket] = try? await APIClient.shared.get("/resident/tickets") {
            tickets = t
        }
    }

    // MARK: - Otwieranie

    private func openAccessPoint(_ ap: AccessPoint) async -> Bool {
        do {
            let r: OpenAccessPointResponse = try await APIClient.shared.post(
                "/resident/access-points/\(ap.id)/open",
                body: GlassEmptyBody()
            )
            // Po otwarciu zamka Nuki odśwież stan (~2.5 s na raport rygla do
            // chmury Nuki), żeby kafel pokazał realną zmianę „Zamknięty→Otwarty".
            if r.success, ap.isUnitDoor {
                Task {
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    await loadSmartLocks(fresh: true)
                }
            }
            return r.success
        } catch {
            return false
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
