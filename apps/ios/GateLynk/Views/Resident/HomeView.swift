import SwiftUI

// MARK: - HomeView (Glass Premium v3 — restructured 2026-06-09)
//
// Layout (nowa kolejność wg feedbacku mieszkańców):
//   1. Hero photo budynku (~340px) z greetingiem WYSOKO (estate + „Cześć Konrad"
//      blisko top-u — pierwszy plan).
//   2. Primary „Otwórz" gradient button NIŻEJ pod nagłówkami (z chwilą oddechu
//      do podtrzymania premium feelu).
//   3. Quick tiles 6 sztuk w grid 2×3:
//      Goście · Pojazdy · Płatności · Zgłoszenia · Przesyłki · Ogłoszenia.
//      „Ogłoszenia" jako jedyne otwiera AnnouncementsView który łączy push history
//      z anomalami bezpieczeństwa (FAZA 8.h.17). Anomaly banner standalone
//      USUNIĘTY — alerty są teraz wewnątrz Ogłoszenia jako pierwsze pozycje.
//   4. AI bar — „Zapytaj Gatelynk AI…".
//   5. DaySummaryCard — 2 sekcje od Bielika (predictions + recap).
//   6. Activity section — feed wydarzeń (notifications + parcels + access).
//
// Designerski tab-bar dalej 5 zakładek (Dom · Goście · Zgłoszenia · Przesyłki ·
// Asystent · Więcej).

struct HomeView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase

    @AppStorage("appTheme") private var appTheme = "dark"

    @State private var building: Building?
    @State private var parcels: [Parcel] = []
    @State private var tickets: [Ticket] = []
    @State private var notifications: [AppNotification] = []
    @State private var accessPoints: [AccessPoint] = []
    @State private var accessEvents: [AccessEvent] = []
    @State private var payments: PaymentSummary? = nil
    // 2026-05-24 — Etap 4 fall detection feed. Pokazujemy banner gdy są
    // nieobsłużone anomalia (z ostatnich 24h). Wyłączamy go gdy user odznaczył
    // opt-in (notifyAnomalies=false) — wtedy nie chcemy go zaskakiwać.
    @State private var anomalies: [AnomalyEvent] = []
    @State private var selectedAnomaly: AnomalyEvent?
    // 2026-06-09 — DaySummaryCard zarządza swoim stanem sam (predictions+recap
    // z `/resident/assistant/day-summary`). Trzymamy referencję żeby triggerowac
    // refresh przy pull-to-refresh całego HomeView.
    @State private var daySummaryRefreshToken = UUID()

    // 2026-07-08 — prośby gości o otwarcie drzwi mieszkania (UNIT_DOOR z
    // approvalRequired). Sekcja kart na górze Home, widoczna tylko gdy
    // pending nie jest puste. Fail-silent na starym backendzie (404 → []).
    @State private var pendingApprovals: [GuestApprovalRequest] = []
    /// Moment ostatniego fetch-u pending — do lokalnego odliczania
    /// `secondsLeft - elapsed` oraz do throttlingu odświeżania (~10 s).
    @State private var approvalsFetchedAt = Date()
    /// Tyka co sekundę gdy karta widoczna — napędza odliczanie.
    @State private var approvalNow = Date()
    /// Request w trakcie approve/deny (spinner + disable przycisków).
    @State private var approvalBusyId: String?
    /// Komunikat błędu otwarcia (approve OK, ale gateOpened == false).
    @State private var approvalErrorMessage: String?

    @State private var loading = true
    @State private var loadError: String?

    @State private var showGateSheet = false
    @State private var showVehicles = false
    @State private var showGuests = false
    @State private var showPayments = false
    @State private var showAnnouncements = false
    // 2026-08-11 — menu nieruchomości pod ikonką domku w lewym górnym rogu
    // (decyzja właściciela: zmiana/dodanie nieruchomości ma być na wierzchu).
    @State private var showProperties = false
    @State private var showTickets = false
    @State private var showParcels = false

    /// Focus dla aiBar TextField — bez tego SwiftUI nie wie kiedy zamknąć
    /// klawiaturę (2026-05-22 bug: po pierwszym tapnięciu w pole, kursor
    /// zostawał aktywny i klawiatura zasłaniała tabbar — user nie mógł
    /// klikać dolnych ikon). Fix: explicit FocusState + tap-to-dismiss +
    /// scrollDismissesKeyboard.
    @FocusState private var aiBarFocused: Bool

    // 2026-06-09 — hero nieco niższy (340 zamiast 360) bo greeting przesunięty
    // wyżej i button też niżej; potrzebujemy mniej oddechu nad button.
    private let heroHeight: CGFloat = 340

    // MARK: - Body

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                // Tło aplikacji — pod hero
                GLColor.bg1(scheme).ignoresSafeArea()

                // Hero photo absolute top, ograniczona do szerokości screen-a
                // żeby nie pchała ZStack w bok.
                GLHeroPhoto(imageBase64: building?.backgroundImageBase64, height: heroHeight)
                    .frame(width: geo.size.width)
                    .ignoresSafeArea(.container, edges: .top)

                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        // 2026-06-09 — topBar WYŻEJ (mniejszy padding-top 8 zamiast
                        // 18) żeby blok "OSIEDLE / Cześć Konrad" był bliżej top-u
                        // i mocniej czytelny przy pierwszym scanie wzrokiem.
                        topBar.padding(.top, 8)
                            .contentShape(Rectangle())
                            // Tap w obszarze topBar = dismiss klawiatury
                            .onTapGesture { aiBarFocused = false }

                        // 2026-07-08 — prośby gości o otwarcie drzwi
                        // mieszkania (approvalRequired). Na samej górze,
                        // tylko gdy są oczekujące.
                        if !pendingApprovals.isEmpty {
                            guestApprovalsSection
                                .padding(.top, 12)
                                .padding(.horizontal, 20)
                        }

                        // 2026-06-09 — Primary Otwórz button NIŻEJ pod greetingiem.
                        // Wcześniej był na samym dole hero (HERO_H - 280). Teraz
                        // zostawiamy oddech ~190pt od top-u (greeting + estate label
                        // ~110pt + 80pt oddechu) — button "wyłania się" z dolnej
                        // części hero ale nie wisi na samym brzegu.
                        primaryAction
                            .padding(.top, max(heroHeight - 220, 140))
                            .padding(.horizontal, 20)

                        quickTiles
                            .padding(.top, 18)
                            .padding(.horizontal, 20)

                        aiBar
                            .padding(.top, 16)
                            .padding(.horizontal, 20)

                        // 2026-06-09 — DaySummaryCard z dwiema sekcjami (Bielik):
                        //   • „Co dziś się wydarzy" — KB harmonogram + planowane przerwy
                        //   • „Podsumowanie dnia" — recent_activity_summary 24h
                        DaySummaryCard()
                            .padding(.top, 22)
                            .padding(.horizontal, 20)
                            .id(daySummaryRefreshToken)

                        // 2026-06-09 (8.h.18) — sekcja "Ostatnia aktywność"
                        // PRZENIESIONA do AnnouncementsView (merged feed
                        // notifications + access_events + parcels). HomeView
                        // skupia się na "co planujesz / co aktualne" — feed
                        // historyczny jest w nowej zakładce „Historia zdarzeń"
                        // w TabBar. `accessEvents` / `notifications` dalej
                        // fetchujemy w `load()` żeby badge na dzwonku i tile
                        // „Ogłoszenia" pokazały counts.

                        Spacer(minLength: 120)
                    }
                    .frame(width: geo.size.width, alignment: .leading)
                }
                .frame(width: geo.size.width)
                .refreshable {
                    await load()
                    // Wymuś remount DaySummaryCard żeby załadował refresh=1.
                    daySummaryRefreshToken = UUID()
                }
                // Pociągnięcie palcem podczas scrolla zwija klawiaturę
                // (iOS native pattern — jak w Mail/Messages).
                .scrollDismissesKeyboard(.interactively)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .preferredColorScheme(AppTheme(rawValue: appTheme)?.colorScheme ?? .dark)
        .task { await load() }
        .sheet(isPresented: $showGateSheet) {
            GateActionSheet(accessPoints: accessPoints, onTrigger: { ap in await triggerAP(ap) })
        }
        .sheet(isPresented: $showAnnouncements) { AnnouncementsView() }
        .sheet(isPresented: $showProperties) { PropertiesView() }
        .sheet(isPresented: $showVehicles)      { ResidentVehiclesSheet() }
        .sheet(isPresented: $showGuests)        { GuestsView() }
        .sheet(isPresented: $showPayments)      { PaymentsView() }
        .sheet(isPresented: $showTickets)       { TicketsView() }
        .sheet(isPresented: $showParcels)       { ParcelsView() }
        .sheet(item: $selectedAnomaly) { ev in
            AnomalyDetailView(event: ev)
        }
        // Push tap → otwórz odpowiednią anomalię. AppDelegate broadcastuje
        // `pushNotificationTapped` z `userInfo["payload"]` zawierającym data
        // z APN (PushService wkleja `{ type: 'ANOMALY', anomalyId, ... }`).
        .onReceive(NotificationCenter.default.publisher(for: .pushNotificationTapped)) { note in
            handlePushTap(note: note)
        }
        // Powrót do foreground → odśwież prośby gości (host mógł dostać
        // push gdy apka była w tle i otworzyć ją z ikony zamiast z push-a).
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await loadPendingApprovals() }
            }
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
        // Approve przeszło, ale zamek NIE otworzył się (gateOpened=false).
        .alert(
            "Nie udało się otworzyć",
            isPresented: Binding(
                get: { approvalErrorMessage != nil },
                set: { if !$0 { approvalErrorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(approvalErrorMessage ?? "")
        }
        // Defense-in-depth: gdy ANY sheet się otwiera, zwolnij keyboard focus.
        // Inaczej iOS może trzymać aktywny TextField pod sheetem.
        .onChange(of: showAssistant)      { _, new in if new { aiBarFocused = false } }
        .onChange(of: showGateSheet)      { _, new in if new { aiBarFocused = false } }
        .onChange(of: showAnnouncements)  { _, new in if new { aiBarFocused = false } }
        .onChange(of: showVehicles)       { _, new in if new { aiBarFocused = false } }
        .onChange(of: showGuests)         { _, new in if new { aiBarFocused = false } }
        .onChange(of: showPayments)       { _, new in if new { aiBarFocused = false } }
        .onChange(of: showTickets)        { _, new in if new { aiBarFocused = false } }
        .onChange(of: showParcels)        { _, new in if new { aiBarFocused = false } }
        // Globalny "Gotowe" w toolbar nad klawiaturą — iOS standard pattern.
        // User w każdej chwili może zamknąć keyboard bez wpisywania.
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Gotowe") { aiBarFocused = false }
                    .font(.system(size: 15, weight: .semibold))
            }
        }
    }

    // MARK: - Prośby gości o otwarcie drzwi mieszkania (2026-07-08)

    /// Bursztynowy akcent UNIT_DOOR — spójny z kreatorem gościa.
    private static let amber = Color(red: 1.0, green: 0.69, blue: 0.125)

    private var guestApprovalsSection: some View {
        VStack(spacing: 10) {
            ForEach(pendingApprovals) { req in
                guestApprovalCard(req)
            }
        }
    }

    /// Pozostałe sekundy — `secondsLeft` z fetch-u minus czas lokalny.
    private func approvalSecondsLeft(_ req: GuestApprovalRequest) -> Int {
        max(0, req.secondsLeft - Int(approvalNow.timeIntervalSince(approvalsFetchedAt)))
    }

    private func guestApprovalCard(_ req: GuestApprovalRequest) -> some View {
        let busy = approvalBusyId == req.id
        let left = approvalSecondsLeft(req)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "bell.badge.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Self.amber)
                Text("\(req.guestName) prosi o otwarcie: \(req.accessPointLabel)")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(GLColor.textPrimary(scheme))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                // Odliczanie — po zejściu do 0 refresh (co ~10 s) usunie kartę.
                Text("\(left) s")
                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                    .foregroundStyle(left <= 10 ? GLColor.danger(scheme) : Self.amber)
                    .monospacedDigit()
            }

            HStack(spacing: 10) {
                Button {
                    Task { await approveGuestRequest(req) }
                } label: {
                    HStack(spacing: 6) {
                        if busy {
                            ProgressView().controlSize(.small).tint(.white)
                        } else {
                            Image(systemName: "checkmark")
                                .font(.system(size: 12, weight: .bold))
                        }
                        Text("Zatwierdź")
                            .font(.system(size: 13.5, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(GLColor.success(scheme))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(busy)

                Button {
                    Task { await denyGuestRequest(req) }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .bold))
                        Text("Odrzuć")
                            .font(.system(size: 13.5, weight: .bold))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(GLColor.danger(scheme))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(busy)
            }
        }
        .padding(14)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous)
                .stroke(Self.amber.opacity(0.55), lineWidth: 1),
        )
        .glShadow(.sm)
    }

    /// GET pending — fail-silent: stary backend (404) / brak sieci → pusta
    /// lista, Home działa jak dotąd.
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
                body: EmptyBody()
            )
            if !resp.gateOpened {
                approvalErrorMessage =
                    "Zatwierdzono prośbę, ale nie udało się otworzyć: \(resp.label). Spróbuj otworzyć ręcznie."
            }
        } catch {
            // 409 = prośba wygasła / już obsłużona — po prostu odświeżamy.
            // Inne błędy też kończą się refetch-em (karta zniknie albo wróci).
        }
        approvalBusyId = nil
        await loadPendingApprovals()
    }

    private func denyGuestRequest(_ req: GuestApprovalRequest) async {
        guard approvalBusyId == nil else { return }
        approvalBusyId = req.id
        let _: GuestApprovalDenyResponse? = try? await APIClient.shared.post(
            "/resident/guest-approvals/\(req.id)/deny",
            body: EmptyBody()
        )
        approvalBusyId = nil
        await loadPendingApprovals()
    }

    // MARK: - Sections

    /// Top bar nad hero: estate uppercase label + greeting + bell (glass blur).
    /// White text — wpisany na zdjęciu / gradient overlay.
    ///
    /// 2026-06-09 — większy greeting (30pt, bold) i wyraźniejszy estate label
    /// (12pt z większym tracking) dla pierwszego planu. Tap na dzwonek otwiera
    /// AnnouncementsView (merged push + anomaly).
    private var topBar: some View {
        HStack(alignment: .top) {
            // Domek — menu nieruchomości (zmień / dodaj). Lustrzany styl
            // dzwonka po prawej, żeby topBar był symetryczny.
            Button { showProperties = true } label: {
                Image(systemName: "house.fill")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.18), lineWidth: 1))
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 6) {
                Text((building?.name ?? "Twoje osiedle").uppercased())
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(2.0)
                    .foregroundStyle(Color.white.opacity(0.82))
                    .shadow(color: .black.opacity(0.4), radius: 8, y: 1)

                if case .resident(let u) = auth.role {
                    Text("Cześć, \(u.firstName)")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(.white)
                        .shadow(color: .black.opacity(0.4), radius: 14, y: 2)
                }
            }
            Spacer()

            // Bell — glass blur, otwiera AnnouncementsView (merged push + anomalia).
            // Dot pojawia się gdy są nieprzeczytane PUSH-e LUB nieobsłużone alerty.
            Button { showAnnouncements = true } label: {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "bell.fill")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(.ultraThinMaterial)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(Color.white.opacity(0.18), lineWidth: 1))

                    if !notifications.isEmpty || !unresolvedAnomalies.isEmpty {
                        Circle()
                            .fill(
                                unresolvedAnomalies.isEmpty
                                    ? GLColor.iconOrange(scheme)
                                    : Color.red,
                            )
                            .frame(width: 9, height: 9)
                            .overlay(Circle().stroke(Color.black.opacity(0.6), lineWidth: 2))
                            .offset(x: -8, y: 8)
                    }
                }
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
    }

    private var primaryAction: some View {
        GLPrimaryButton(
            title: "Otwórz",
            subtitle: gateSubtitle,
            systemIcon: "lock.open.fill",
        ) {
            showGateSheet = true
        }
    }

    /// Status access pointów: ile jest dostępnych. Pokazuje user-owi że są gotowe.
    private var gateSubtitle: String {
        guard !accessPoints.isEmpty else { return "Ładowanie…" }
        let names = ["Brama", "Drzwi", "Mój dom"]
        return names.joined(separator: " · ")
    }

    /// 2026-06-09 — 6 tile w grid 2×3 (poprzednio 3 tile w rzędzie).
    /// Kolejność wg user request: Goście → Pojazdy → Płatności
    ///                            Zgłoszenia → Przesyłki → Ogłoszenia.
    /// "Ogłoszenia" otwiera merged AnnouncementsView z anomalami bezpieczeństwa
    /// (banner anomaly USUNIĘTY z standalone — jest tu jako badge).
    private var quickTiles: some View {
        LazyVGrid(
            columns: [
                GridItem(.flexible(), spacing: 10),
                GridItem(.flexible(), spacing: 10),
                GridItem(.flexible(), spacing: 10),
            ],
            spacing: 10,
        ) {
            GLQuickTile(
                title: "Goście",
                systemIcon: "person.2.fill",
                iconSize: 22,
            ) { showGuests = true }

            GLQuickTile(
                title: "Pojazdy",
                systemIcon: "car.fill",
                iconSize: 24,
            ) { showVehicles = true }

            GLQuickTile(
                title: "Płatności",
                systemIcon: "creditcard.fill",
                iconSize: 22,
                badge: paymentsBadge,
                badgeStyle: .danger,
            ) { showPayments = true }

            GLQuickTile(
                title: "Zgłoszenia",
                systemIcon: "bubble.left.fill",
                iconSize: 22,
                badge: ticketsBadge,
                badgeStyle: .accent,
            ) { showTickets = true }

            GLQuickTile(
                title: "Przesyłki",
                systemIcon: "shippingbox.fill",
                iconSize: 22,
                badge: parcelsBadge,
                badgeStyle: .accent,
            ) { showParcels = true }

            GLQuickTile(
                title: "Ogłoszenia",
                systemIcon: "megaphone.fill",
                iconSize: 22,
                badge: announcementsBadge,
                badgeStyle: announcementsBadgeStyle,
            ) { showAnnouncements = true }
        }
    }

    /// `!` jeśli saldo < 0 (zaległość). Inaczej nil.
    private var paymentsBadge: String? {
        if let p = payments, p.balance < 0 { return "!" }
        return nil
    }

    /// Liczba otwartych ticketów (lub nil gdy 0).
    private var ticketsBadge: String? {
        let open = tickets.filter { $0.status == "OPEN" }.count
        return open > 0 ? "\(open)" : nil
    }

    /// Liczba paczek czekających do odbioru.
    private var parcelsBadge: String? {
        let pending = parcels.filter { $0.status == "RECEIVED" }.count
        return pending > 0 ? "\(pending)" : nil
    }

    /// Badge dla ogłoszeń: priorytet — alerty bezpieczeństwa > nieprzeczytane push.
    private var announcementsBadge: String? {
        let alerts = unresolvedAnomalies.count
        if alerts > 0 { return "!" }
        if !notifications.isEmpty { return "\(notifications.count)" }
        return nil
    }

    private var announcementsBadgeStyle: GLPill.Style {
        unresolvedAnomalies.isEmpty ? .accent : .danger
    }

    /// AI bar — wpinka do AssistantView. Po tap "Zapytaj" / Send / submitu
    /// otwieramy sheet z AssistantView z pre-wypełnionym pytaniem które się
    /// auto-wyśle. User widzi HomeView w tle, może swipe-dismiss żeby wrócić.
    @State private var aiDraft = ""
    @State private var showAssistant = false
    @State private var assistantInitial: String? = nil

    private func openAssistant() {
        // Zwolnij focus PRZED openem sheet — inaczej iOS trzyma klawiaturę
        // aktywną pod sheetem, co zostawia kursor na aiBar po dismissie sheeta.
        aiBarFocused = false
        let q = aiDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else {
            // Pusty draft → otwórz AssistantView bez pre-fill (user napisze sam)
            assistantInitial = nil
            showAssistant = true
            return
        }
        assistantInitial = q
        showAssistant = true
        // Wyczyść po fire — gdy user zamknie sheet i wróci, pole jest świeże.
        aiDraft = ""
    }

    private var aiBar: some View {
        HStack(spacing: 10) {
            aiSparkleIcon
                .frame(width: 28, height: 28)

            TextField("Zapytaj Gatelynk AI…", text: $aiDraft)
                .font(.system(size: 14))
                .foregroundStyle(GLColor.textPrimary(scheme))
                .submitLabel(.send)
                .focused($aiBarFocused)
                .onSubmit { openAssistant() }

            if !aiDraft.trimmingCharacters(in: .whitespaces).isEmpty {
                Button(action: openAssistant) {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(GLColor.accentGradient(scheme))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            } else {
                Button(action: openAssistant) {
                    Text("Zapytaj")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(GLColor.textTertiary(scheme))
                        .padding(.horizontal, 11)
                        .padding(.vertical, 5)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 7)
        .padding(.vertical, 7)
        .background(GLColor.bg2(scheme))
        .clipShape(Capsule())
        .overlay(Capsule().stroke(GLColor.borderSubtle(scheme), lineWidth: 1))
        .glShadow(.sm)
        .sheet(isPresented: $showAssistant) {
            AssistantView(initialQuestion: assistantInitial)
        }
    }

    private var aiSparkleIcon: some View {
        Image(systemName: "sparkles")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(
                LinearGradient(
                    colors: [GLColor.accent300(scheme), GLColor.accent400(scheme)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing,
                ),
            )
    }

    // MARK: – Bezpieczeństwo (anomalies — badge na Ogłoszeniach)
    //
    // 2026-06-09 — standalone anomaly banner USUNIĘTY. Alerty są teraz wewnątrz
    // AnnouncementsView (Ogłoszenia tile) jako wyróżnione wpisy z czerwonym
    // bannerem na górze. HomeView trzyma tylko `unresolvedAnomalies` żeby
    // pokazać badge "!" na tile Ogłoszenia + czerwony dot przy dzwonku.

    private var unresolvedAnomalies: [AnomalyEvent] {
        anomalies.filter { !$0.isResolved && !$0.falsePositive }
    }

    private func handlePushTap(note: Foundation.Notification) {
        guard let payload = note.userInfo?["payload"] as? [AnyHashable: Any] else { return }
        // 2026-07-08 — push „gość prosi o otwarcie drzwi mieszkania"
        // (kind=GUEST_APPROVAL) → odśwież karty zatwierdzania na górze Home.
        // GUEST_UNIT_DOOR_OPEN jest czysto informacyjny — nic nie robimy.
        if let kind = payload["kind"] as? String {
            if kind == "GUEST_APPROVAL" {
                Task { await loadPendingApprovals() }
                return
            }
            if kind == "GUEST_UNIT_DOOR_OPEN" { return }
        }
        guard let type = payload["type"] as? String, type == "ANOMALY" else { return }
        guard let id = payload["anomalyId"] as? String else { return }
        // Jeśli mamy już lokalnie ten event w `anomalies` — otwórz; inaczej
        // re-fetch i odpal. Refetch też pełną listę żeby banner się odświeżył.
        Task {
            if let existing = anomalies.first(where: { $0.id == id }) {
                selectedAnomaly = existing
            } else {
                await loadAnomalies()
                selectedAnomaly = anomalies.first(where: { $0.id == id })
            }
        }
    }

    private func loadAnomalies() async {
        // Defensywnie — backend może być starszy lub user może nie mieć dostępu;
        // failure cicho ignorujemy żeby Home nie wybuchało.
        let resp: AnomalyEventsResponse? = try? await APIClient.shared.get(
            "/resident/anomaly-events?since_hours=24&limit=50",
        )
        if let resp { self.anomalies = resp.events }
    }

    // MARK: - Load (zachowane z poprzedniego HomeView)

    private func load() async {
        loading = true; loadError = nil
        async let bld: Building? = try? APIClient.shared.get("/resident/building")
        async let parc: [Parcel] = (try? APIClient.shared.get("/resident/parcels")) ?? []
        async let tic: [Ticket] = (try? APIClient.shared.get("/resident/tickets")) ?? []
        async let notif: [AppNotification] = (try? APIClient.shared.get("/resident/notifications")) ?? []
        async let aps: [AccessPoint] = (try? APIClient.shared.get("/resident/access-points")) ?? []
        async let evt: [AccessEvent] = (try? APIClient.shared.get("/resident/access-events?limit=20")) ?? []
        async let pay: PaymentSummary? = try? APIClient.shared.get("/resident/payments")

        self.building = await bld
        self.parcels = await parc
        self.tickets = await tic
        self.notifications = await notif
        self.accessPoints = await aps
        self.accessEvents = await evt
        self.payments = await pay
        self.loading = false

        // 2026-05-24 — async load anomalii nie blokuje pierwszego paint-u
        // (fall detection feed). Badge na tile Ogłoszenia + dot przy dzwonku
        // pokażą się gdy fetch wróci.
        await loadAnomalies()
        // 2026-07-08 — prośby gości o otwarcie drzwi mieszkania (fail-silent).
        await loadPendingApprovals()
        // 2026-06-09 — DaySummaryCard sam wywołuje `/day-summary` z task
        // w swoim `.task` modifier. Tutaj nic nie robimy — Card jest osobny
        // komponent z własnym lifecycle. Pull-to-refresh całego HomeView
        // remount-uje Card przez `.id(daySummaryRefreshToken)`.
    }

    /// Triggered z GateActionSheet — wywołuje endpoint otwarcia bramy.
    /// Cast wymagany żeby kompilator wybrał właściwy overload generic `post<T>`.
    private func triggerAP(_ ap: AccessPoint) async {
        let _: OpenAccessPointResponse? = try? await APIClient.shared.post(
            "/resident/access-points/\(ap.id)/open",
            body: EmptyBody(),
        )
        // Po otwarciu odśwież access events
        if let evt: [AccessEvent] = try? await APIClient.shared.get("/resident/access-events?limit=20") {
            self.accessEvents = evt
        }
    }

    /// Legacy helper — zachowany dla kompatybilności z innymi widokami
    /// (`ProfileView`, `SettingsView`) które dekodują avatar z base64 string-a
    /// z `data:image/...;base64,` prefixem. Nie usuwam żeby nie złamać tych
    /// widoków zanim przejdziemy do nich w kroku 7.
    static func decodeBase64Image(_ s: String) -> UIImage? {
        let payload = s.contains(",") ? String(s.split(separator: ",", maxSplits: 1).last ?? "") : s
        guard let data = Data(base64Encoded: payload, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }
}

private struct EmptyBody: Encodable {}

// MARK: - ResidentVehiclesSheet
//
// Minimalny widok pojazdów dla resident-a — lista własnych aut ze statusami
// (APPROVED/PENDING/REJECTED/BLOCKED) + przycisk dodaj. Pełna edycja jest
// w „Więcej" tab → sekcja Moje pojazdy (ProfileView). To jest tylko quick
// glance po wciśnięciu tile „Pojazdy" na Home.
struct ResidentVehiclesSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    @State private var resident: Resident?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let vehicles = resident?.vehicles, !vehicles.isEmpty {
                    List(vehicles) { v in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 12) {
                                Image(systemName: "car.fill")
                                    .foregroundStyle(GLColor.accent300(scheme))
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(v.licensePlate)
                                        .font(.system(.body, design: .monospaced))
                                        .fontWeight(.semibold)
                                    Text("\(v.displayName) · \(v.color)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                statusBadge(v.effectiveStatus)
                            }
                            if v.effectiveStatus == .pending {
                                Text("Oczekuje na zatwierdzenie")
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                                    .padding(.leading, 36)
                            } else if v.effectiveStatus == .rejected, let r = v.rejectionReason {
                                Text("Powód: \(r)")
                                    .font(.caption2)
                                    .foregroundStyle(.red)
                                    .padding(.leading, 36)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                } else {
                    ContentUnavailableView(
                        "Brak pojazdów",
                        systemImage: "car",
                        description: Text("Dodawanie pojazdów dostępne w zakładce Więcej"),
                    )
                }
            }
            .navigationTitle("Moje pojazdy")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zamknij") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    @ViewBuilder
    private func statusBadge(_ status: VehicleStatus) -> some View {
        let color: Color = {
            switch status {
            case .approved: return .green
            case .pending:  return .orange
            case .rejected: return .red
            case .blocked:  return .gray
            case .expired:  return .secondary
            }
        }()
        HStack(spacing: 4) {
            Image(systemName: status.icon)
            Text(status.label)
        }
        .font(.caption2.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(color)
        .background(color.opacity(0.15), in: Capsule())
    }

    private func load() async {
        loading = true
        resident = try? await APIClient.shared.get("/resident/me")
        loading = false
    }
}
