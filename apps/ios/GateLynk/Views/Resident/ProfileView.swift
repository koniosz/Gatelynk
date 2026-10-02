import SwiftUI

// ProfileView.swift — plik zachowany dla zgodności z projektem Xcode.
// Zawartość przeniesiona do SettingsView (patrz niżej).

struct SettingsView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(\.colorScheme) private var scheme
    @State private var resident: Resident?
    @State private var loading = true
    @State private var showAddVehicle = false
    @State private var selectedVehicle: Vehicle?

    // 2026-07-09 — zamek Nuki dodawany przez mieszkańca (świadoma zgoda).
    // `smartLockSupported == nil` dopóki nie sprawdzimy endpointu; false gdy
    // stary backend (404) → sekcja ukryta (fail-silent).
    @State private var showAddNukiLock = false
    @State private var nukiLocks: [NukiLockStatus] = []
    @State private var smartLockSupported: Bool? = nil
    @State private var nukiRemoving: Int? = nil

    // ── Ustawienia aplikacji ──────────────────────────────────────────────────
    @AppStorage("appTheme")             private var appTheme             = "dark"
    @AppStorage("appAccentColor")       private var appAccentColor       = "purple"
    @AppStorage("homeShowAccessPoints") private var homeShowAccessPoints = true
    @AppStorage("homeShowQuickActions") private var homeShowQuickActions = true
    @AppStorage("homeShowActivity")     private var homeShowActivity     = true
    @AppStorage("homeShowAccessEvents") private var homeShowAccessEvents = true

    // Sheets dostępne ze „Więcej" — Płatności / Powiadomienia / Punkty dostępu.
    // Designer migrował te ekrany z osobnych tabów do menu (port v3, 2026-05-11).
    @State private var showPayments = false
    @State private var showNotifications = false
    @State private var showAccessPoints = false
    // 2026-08-09 — przełącznik nieruchomości (multi-property).
    @State private var showProperties = false

    // 2026-08-09 — Domownicy: mieszkaniec zaprasza żonę/dziecko do SWOJEGO
    // lokalu (link ShareLink → domownik zakłada konto na /accept-household).
    // `householdSupported == nil` dopóki nie sprawdzimy endpointu; false gdy
    // stary backend (404) → sekcja ukryta (fail-silent, wzór smartLock).
    @State private var household: HouseholdOverview?
    @State private var householdSupported: Bool? = nil
    @State private var showInviteHousehold = false
    @State private var cancellingInviteId: Int? = nil

    // 2026-05-24 — opt-in dla powiadomień o zagrożeniach (FALL detection).
    // Wartość pochodzi z `/resident/me`; toggle PATCH-uje
    // `/resident/profile/notify-anomalies`. Disclaimer-sheet pokazujemy
    // tylko przy pierwszym włączeniu (track via `confirmedAnomalyOptIn`).
    @State private var notifyAnomalies = false
    /// 2026-10-02 — przyjazd śmieciarki (nil = starszy backend, sekcja ukryta).
    @State private var notifyWasteTruck: Bool?
    // 2026-06-02 — stały PIN do klawiatury bram/domofonu (offline-friendly).
    @State private var intercomPin: String = ""
    @State private var intercomPinSaved: String? = nil
    @State private var intercomPinEditing: Bool = false
    @State private var intercomPinError: String? = nil
    @State private var intercomPinSaving: Bool = false
    @State private var intercomPinReveal: Bool = false
    @State private var showAnomalyOptInSheet = false
    @AppStorage("confirmedAnomalyOptIn") private var confirmedAnomalyOptIn = false

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else {
                    profileContent
                }
            }
            .navigationTitle("Więcej")
            .task { await loadResident(); await loadSmartLock(); await loadHousehold() }
            .sheet(isPresented: $showAddVehicle) {
                VehicleFormView(vehicle: nil) { await loadResident() }
            }
            .sheet(isPresented: $showAddNukiLock) {
                NukiOnboardingView { await loadSmartLock() }
            }
            .sheet(item: $selectedVehicle) { v in
                VehicleFormView(vehicle: v) { await loadResident() }
            }
            .sheet(isPresented: $showPayments)      { PaymentsView() }
            .sheet(isPresented: $showNotifications) { NotificationsView() }
            .sheet(isPresented: $showAccessPoints)  { AccessPointsView() }
            .sheet(isPresented: $showProperties)    { PropertiesView() }
            .sheet(isPresented: $showInviteHousehold) {
                HouseholdInviteView { await loadHousehold() }
            }
        }
    }

    // MARK: – Main list

    private var profileContent: some View {
        List {
            quickActionsSection
            personalSection
            propertiesSection
            if let units = resident?.unitResidents?.filter({ $0.untilDate == nil }), !units.isEmpty {
                unitsSection(units)
            }
            // Domownicy (2026-08-09) — tylko gdy backend wspiera endpoint.
            if householdSupported == true {
                householdSection
            }
            // Zamek Nuki (2026-07-09) — sekcja tylko gdy backend wspiera endpoint.
            if smartLockSupported == true {
                nukiLockSection
            }
            // FAZA e (2026-06-02) — conditional rendering sekcji per
            // featurePermissions z `/resident/me`. Niezdefiniowane = widoczne
            // (defense: `hasFeature` zwraca true gdy nieskonfigurowane).
            if resident?.hasFeature("vehicles") ?? true {
                vehiclesSection
            }
            if resident?.hasFeature("resident_pin") ?? true {
                intercomPinSection
            }
            homeScreenSection
            if resident?.hasFeature("fall_detection") ?? true {
                safetySection
            }
            // Niezależne od wykrywania upadków — osobne źródło (kamery wizyjne).
            if notifyWasteTruck != nil { wasteTruckSection }
            themeSection
            logoutSection
            versionSection
        }
        .listStyle(.insetGrouped)
    }

    // MARK: – Mój PIN do klawiatury bram (2026-06-02)
    //
    // Mieszkaniec ustawia stały PIN (4-6 cyfr), który można wpisać na
    // klawiaturze Akuvox przy bramie/domofonie. Walidacja po stronie Cloud:
    //   • 4-6 cyfr
    //   • Nie sekwencja typu 1234 / 0000 / 6666 (blacklist trivial)
    //   • Unique per building (nie koliduje z innym mieszkańcem ani aktywnym gościem)
    // Po sukcesie Cloud pusha PIN do Edge przez tunnel — klawiatura zaczyna
    // akceptować w sekundach (offline-first, ale wymaga że Edge online żeby
    // dostać sync; po reconnect Edge dostaje pełny RESIDENT_PIN_SYNC_ALL).
    private var intercomPinSection: some View {
        Section {
            if !intercomPinEditing {
                // Status display + Edit/Remove buttons
                HStack {
                    Label {
                        if let pin = intercomPinSaved, !pin.isEmpty {
                            Text(intercomPinReveal ? pin : "••••••")
                                .font(.system(.body, design: .monospaced))
                        } else {
                            Text("Nie ustawiony").foregroundColor(.secondary)
                        }
                    } icon: {
                        Image(systemName: "key.fill")
                            .foregroundStyle(GLColor.accent300(scheme))
                    }
                    Spacer()
                    if intercomPinSaved != nil {
                        Button {
                            intercomPinReveal.toggle()
                        } label: {
                            Image(systemName: intercomPinReveal ? "eye.slash.fill" : "eye.fill")
                                .foregroundColor(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                Button(intercomPinSaved == nil ? "Ustaw PIN" : "Zmień PIN") {
                    intercomPin = ""
                    intercomPinError = nil
                    intercomPinEditing = true
                }
                if intercomPinSaved != nil {
                    Button("Usuń PIN", role: .destructive) {
                        Task { await saveIntercomPin(nil) }
                    }
                }
            } else {
                // Edit mode — secure input
                SecureField("4-6 cyfr", text: $intercomPin)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .onChange(of: intercomPin) { _, new in
                        // Filter na cyfry + cap 6 znaków
                        let digits = new.filter { $0.isNumber }
                        if digits != new || digits.count > 6 {
                            intercomPin = String(digits.prefix(6))
                        }
                    }
                if let err = intercomPinError {
                    Text(err).font(.caption).foregroundColor(.red)
                }
                HStack {
                    Button("Anuluj") {
                        intercomPinEditing = false
                        intercomPin = ""
                        intercomPinError = nil
                    }
                    .frame(maxWidth: .infinity)
                    .buttonStyle(.bordered)
                    Button(intercomPinSaving ? "Zapisuję…" : "Zapisz") {
                        Task { await saveIntercomPin(intercomPin) }
                    }
                    .frame(maxWidth: .infinity)
                    .buttonStyle(.borderedProminent)
                    .disabled(intercomPinSaving || intercomPin.count < 4)
                }
            }
        } header: {
            Label("Mój PIN do bramy", systemImage: "key.viewfinder")
        } footer: {
            Text("Wpisz na klawiaturze przy bramie lub domofonie żeby otworzyć — działa nawet gdy nie masz zasięgu telefonu (np. w garażu podziemnym).")
        }
    }

    private func saveIntercomPin(_ pin: String?) async {
        intercomPinSaving = true
        intercomPinError = nil
        defer { intercomPinSaving = false }
        struct Body: Encodable { let pin: String? }
        struct Resp: Decodable { let ok: Bool; let pin: String? }
        do {
            let resp: Resp = try await APIClient.shared.patch(
                "/resident/me/intercom-pin",
                body: Body(pin: pin),
            )
            intercomPinSaved = resp.pin
            intercomPinEditing = false
            intercomPin = ""
        } catch let APIError.httpError(_, message) {
            intercomPinError = message
        } catch {
            intercomPinError = "Nie udało się zapisać"
        }
    }

    // MARK: – Bezpieczeństwo (opt-in dla anomalii: upadek, …)
    //
    // 2026-05-24 — fall detection Etap 3. Mieszkaniec świadomie włącza push
    // alerty gdy kamera wykryje upadek osoby w częściach wspólnych jego
    // budynku. Domyślnie OFF — przy PIERWSZYM włączeniu pokazujemy sheet
    // z disclaimerem ("nie jest substytutem 112, system bywa fałszywie
    // pozytywny"). Po confirmie zapisujemy PATCH do backendu.
    private var safetySection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { notifyAnomalies },
                set: { newValue in
                    if newValue && !confirmedAnomalyOptIn {
                        // Pierwsze włączenie — pokaż disclaimer; toggle wróci
                        // do `notifyAnomalies` po decyzji ze sheet-a.
                        showAnomalyOptInSheet = true
                    } else {
                        Task { await setAnomalyOptIn(newValue) }
                    }
                },
            )) {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Powiadomienia o zagrożeniach", systemImage: "exclamationmark.shield.fill")
                    Text("Alert push gdy kamera wykryje upadek osoby w Twoim budynku")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        } header: {
            Label("Bezpieczeństwo", systemImage: "shield.lefthalf.filled")
        } footer: {
            Text("System wczesnego ostrzegania. Nie jest substytutem numeru alarmowego 112 — może generować fałszywe alarmy (np. dziecko leżące na podłodze).")
        }
        .sheet(isPresented: $showAnomalyOptInSheet) {
            anomalyOptInDisclaimer
        }
    }

    private var anomalyOptInDisclaimer: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        Image(systemName: "exclamationmark.shield.fill")
                            .font(.system(size: 36))
                            .foregroundColor(.orange)
                        Text("Powiadomienia o zagrożeniach")
                            .font(.title2.bold())
                    }
                    Text("Otrzymasz powiadomienie push, gdy kamera w częściach wspólnych Twojego budynku wykryje **możliwy upadek osoby**.")
                    Text("**Ważne ograniczenia:**")
                        .padding(.top, 4)
                    Label("To nie jest substytut numeru alarmowego 112.", systemImage: "phone.fill")
                    Label("System może generować fałszywe alarmy (np. dziecko leżące, schylająca się osoba, sprzątanie podłogi).", systemImage: "exclamationmark.triangle.fill")
                    Label("Decyzja o reakcji (sprawdzenie, zadzwonienie po pomoc) należy do Ciebie.", systemImage: "person.fill.checkmark")
                    Label("Powiadomienia obejmują wszystkie kamery wspólne — nie tylko Twoje piętro.", systemImage: "video.fill")

                    HStack {
                        Button("Anuluj") {
                            showAnomalyOptInSheet = false
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.gray.opacity(0.2), in: RoundedRectangle(cornerRadius: 10))
                        .foregroundColor(.primary)

                        Button("Włącz alerty") {
                            confirmedAnomalyOptIn = true
                            showAnomalyOptInSheet = false
                            Task { await setAnomalyOptIn(true) }
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.orange, in: RoundedRectangle(cornerRadius: 10))
                        .foregroundColor(.white)
                    }
                    .padding(.top, 12)
                }
                .padding()
            }
            .navigationTitle("Zgoda")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var wasteTruckSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { notifyWasteTruck ?? false },
                set: { value in Task { await setWasteTruck(value) } },
            )) {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Przyjazd śmieciarki", systemImage: "truck.box.fill")
                    Text("Powiadomienie, gdy kamery osiedla rozpoznają pojazd odbioru odpadów")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        } header: {
            Label("Powiadomienia", systemImage: "bell.badge")
        }
    }

    private func setWasteTruck(_ enabled: Bool) async {
        let previous = notifyWasteTruck
        notifyWasteTruck = enabled
        do {
            struct Body: Encodable { let enabled: Bool }
            struct Resp: Decodable { let notifyWasteTruck: Bool }
            let resp: Resp = try await APIClient.shared.patch(
                "/resident/profile/notify-waste-truck",
                body: Body(enabled: enabled),
            )
            notifyWasteTruck = resp.notifyWasteTruck
        } catch {
            notifyWasteTruck = previous
        }
    }

    private func setAnomalyOptIn(_ enabled: Bool) async {
        do {
            struct Body: Encodable { let enabled: Bool }
            struct Resp: Decodable { let ok: Bool; let notifyAnomalies: Bool }
            let resp: Resp = try await APIClient.shared.patch(
                "/resident/profile/notify-anomalies",
                body: Body(enabled: enabled),
            )
            notifyAnomalies = resp.notifyAnomalies
        } catch {
            // Rollback UI jeśli backend padł
            notifyAnomalies = !enabled
        }
    }

    // MARK: – Szybkie akcje
    //
    // Migrowane z osobnych tabów (poprzednio Płatności / Powiadomienia / Ustawienia
    // miały tabbar slot). W Home v3 te ekrany są tu dostępne plus część przez
    // ikony na Home (dzwonek dla powiadomień, tile Płatności).
    private var quickActionsSection: some View {
        Section {
            Button {
                showPayments = true
            } label: {
                Label {
                    Text("Płatności").foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "creditcard.fill").foregroundStyle(GLColor.accent300(scheme))
                }
            }
            Button {
                showNotifications = true
            } label: {
                Label {
                    Text("Powiadomienia").foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "bell.fill").foregroundStyle(GLColor.accent300(scheme))
                }
            }
            Button {
                showAccessPoints = true
            } label: {
                Label {
                    Text("Punkty dostępu").foregroundStyle(.primary)
                } icon: {
                    Image(systemName: "door.left.hand.open").foregroundStyle(GLColor.accent300(scheme))
                }
            }
        } header: {
            Text("Szybkie akcje")
        }
    }

    // MARK: – Dane osobowe

    private var personalSection: some View {
        Section("Dane osobowe") {
            if case .resident(let u) = auth.role {
                LabeledContent("Imię", value: u.firstName)
                LabeledContent("Nazwisko", value: u.lastName)
                LabeledContent("Email", value: u.email)
                if let phone = u.phone {
                    LabeledContent("Telefon", value: phone)
                }
            }
        }
    }

    // MARK: – Nieruchomości (multi-property, 2026-08-09)
    //
    // Jeden e-mail może mieć konta w wielu obiektach (osobny wiersz Resident
    // per budynek). Sekcja prowadzi do przełącznika: zmiana nieruchomości bez
    // wylogowania + instrukcja jak dodać kolejną.

    private var propertiesSection: some View {
        Section {
            Button {
                showProperties = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "building.2.fill")
                        .foregroundStyle(.blue)
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Moje nieruchomości")
                            .fontWeight(.semibold)
                            .foregroundStyle(.primary)
                        Text("Zmień lub dodaj nieruchomość")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    // MARK: – Moje lokale

    private func unitsSection(_ units: [UnitResident]) -> some View {
        Section("Moje lokale") {
            ForEach(units) { ur in
                if let unit = ur.unit {
                    HStack(spacing: 12) {
                        Image(systemName: "house.fill")
                            .foregroundStyle(.blue)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(unit.unitType?.name ?? "Lokal") \(unit.number)")
                                .fontWeight(.semibold)
                            if let floor = unit.floor {
                                Text("Piętro \(floor)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Text(ur.role == "OWNER" ? "Właściciel" : "Najemca")
                            .font(.caption2)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(ur.role == "OWNER" ? Color.blue.opacity(0.1) : Color.orange.opacity(0.1))
                            .foregroundStyle(ur.role == "OWNER" ? .blue : .orange)
                            .cornerRadius(8)
                    }
                }
            }
        }
    }

    // MARK: – Domownicy (2026-08-09)
    //
    // Mieszkaniec udostępnia aplikację pozostałym domownikom (żona, dzieci):
    // tworzy zaproszenie (imię + opcjonalna relacja), wysyła link ShareLink-iem
    // (iMessage/WhatsApp), domownik na stronie web podaje SWÓJ e-mail + hasło
    // → dostaje pełnoprawne konto mieszkańca przypięte do tego samego lokalu.
    // Zaproszenie: 7 dni ważności, jednorazowe, max 5 aktywnych na lokal,
    // anulowanie z listy poniżej. Administrator widzi domownika w panelu jak
    // każdego mieszkańca (audyt: invitedByResidentId).

    private var householdSection: some View {
        Section {
            // Aktywni współlokatorzy tego lokalu.
            if let members = household?.members {
                ForEach(members) { m in
                    HStack(spacing: 12) {
                        Image(systemName: "person.fill")
                            .foregroundStyle(GLColor.accent300(scheme))
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.fullName).fontWeight(.semibold)
                            Text(householdMemberCaption(m))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if m.hasAccount == false {
                            Text("Bez konta")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(Color.gray.opacity(0.12))
                                .foregroundStyle(.secondary)
                                .cornerRadius(8)
                        }
                    }
                }
            }
            // Aktywne zaproszenia — ShareLink do ponownego wysłania + anulowanie.
            if let invitations = household?.invitations {
                ForEach(invitations) { inv in
                    HStack(spacing: 12) {
                        Image(systemName: "hourglass")
                            .foregroundStyle(.orange)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(inv.inviteeName).fontWeight(.semibold)
                            Text(householdInviteCaption(inv))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let urlString = inv.inviteUrl, let url = URL(string: urlString) {
                            ShareLink(
                                item: url,
                                message: Text(Self.householdShareMessage(name: inv.inviteeName))
                            ) {
                                Image(systemName: "square.and.arrow.up")
                                    .foregroundStyle(.blue)
                            }
                            .buttonStyle(.plain)
                        }
                        if cancellingInviteId == inv.id {
                            ProgressView()
                        } else {
                            Button(role: .destructive) {
                                Task { await cancelHouseholdInvite(inv.id) }
                            } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.red)
                        }
                    }
                }
            }
            Button {
                showInviteHousehold = true
            } label: {
                Label("Zaproś domownika", systemImage: "person.badge.plus")
                    .foregroundStyle(.blue)
            }
        } header: {
            Text("Domownicy")
        } footer: {
            Text("Zaproszony domownik dostaje własne konto mieszkańca w Twoim lokalu — otwiera bramy, zaprasza gości i odbiera domofon. Link jest ważny 7 dni i działa jednorazowo.")
        }
    }

    private func householdMemberCaption(_ m: HouseholdMember) -> String {
        var parts: [String] = []
        if let rel = m.relationLabel, !rel.isEmpty {
            parts.append(rel)
        } else if let role = m.role {
            parts.append(role == "OWNER" ? "Właściciel" : "Domownik")
        }
        if m.invitedByMe == true { parts.append("zaproszony przez Ciebie") }
        return parts.isEmpty ? "Mieszkaniec lokalu" : parts.joined(separator: " · ")
    }

    private func householdInviteCaption(_ inv: HouseholdInvitation) -> String {
        var parts: [String] = ["Zaproszenie ważne do \(Self.plShortDate(inv.expiresAt))"]
        if let by = inv.invitedByName, !by.isEmpty { parts.append("od: \(by)") }
        return parts.joined(separator: " · ")
    }

    /// Wspólna treść wiadomości ShareLink (używa jej też sheet zapraszania).
    static func householdShareMessage(name: String) -> String {
        "Cześć \(name)! Zapraszam Cię do aplikacji GateLynk naszego osiedla. Otwórz link, podaj swój e-mail i ustaw hasło — będziesz otwierać bramę i furtkę z telefonu."
    }

    /// Formatter poza @ViewBuilder (pułapka #17 z CLAUDE.md — bez assignments
    /// w body). Krótka data PL: „16 sie 2026".
    static func plShortDate(_ date: Date) -> String {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateStyle = .medium
        df.timeStyle = .none
        return df.string(from: date)
    }

    private func loadHousehold() async {
        do {
            let resp: HouseholdOverview = try await APIClient.shared.get("/resident/household")
            household = resp
            householdSupported = true
        } catch let APIError.httpError(code, _) where code == 404 {
            householdSupported = false   // stary backend — ukryj sekcję
        } catch {
            // sieć/5xx — nie chowaj sekcji jeśli już była widoczna
            if householdSupported == nil { householdSupported = false }
        }
    }

    private func cancelHouseholdInvite(_ id: Int) async {
        cancellingInviteId = id
        defer { cancellingInviteId = nil }
        do {
            struct Resp: Decodable { let success: Bool }
            let _: Resp = try await APIClient.shared.delete("/resident/household/invitations/\(id)")
            await loadHousehold()
        } catch {
            // Lista i tak odświeży się przy następnym wejściu.
        }
    }

    // MARK: – Mój zamek (Nuki) — onboarding przez mieszkańca (2026-07-09)

    private var nukiLockSection: some View {
        Section {
            ForEach(nukiLocks) { lock in
                HStack(spacing: 12) {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(GLColor.accent300(scheme))
                        .frame(width: 24)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(lock.name).fontWeight(.semibold)
                        // Badge stanu rygla + (opcjonalnie) czujnik drzwi/bateria.
                        HStack(spacing: 6) {
                            if let ul = lock.unitLabel, !ul.isEmpty {
                                Text(ul).font(.caption).foregroundStyle(.secondary)
                            }
                            lockStateBadge(lock)
                            if let door = lock.doorLabel, lock.online {
                                Text(door)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            if lock.batteryCritical == true {
                                Text("🔋 niski")
                                    .font(.caption2).fontWeight(.semibold)
                                    .foregroundStyle(.orange)
                            }
                        }
                    }
                    Spacer()
                    if nukiRemoving == lock.apId {
                        ProgressView()
                    } else {
                        Button(role: .destructive) {
                            Task { await removeSmartLock(lock.apId) }
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.red)
                    }
                }
            }
            Button {
                showAddNukiLock = true
            } label: {
                Label("Dodaj zamek Nuki", systemImage: "lock.badge.plus")
                    .foregroundStyle(GLColor.accent300(scheme))
            }
        } header: {
            Text("Zamek mieszkania")
        } footer: {
            Text("Podłącz swój zamek Nuki, żeby otwierać drzwi z aplikacji. Token przechowywany jest na urządzeniu budynku, nie w chmurze GateLynk.")
        }
    }

    /// Kolorowy badge stanu zamka (zielony=zamknięty, bursztyn=otwarty,
    /// niebieski=w ruchu, szary=nieznany/offline). Fail-silent: gdy backend nie
    /// zwraca live stanu → „offline".
    @ViewBuilder
    private func lockStateBadge(_ lock: NukiLockStatus) -> some View {
        let (text, color): (String, Color) = {
            switch lock.badge {
            case .secure:     return (lock.effectiveStateLabel ?? "Zamknięty", .green)
            case .open:       return (lock.effectiveStateLabel ?? "Otwarty", .orange)
            case .transition: return (lock.effectiveStateLabel ?? "W ruchu", .blue)
            case .unknown:    return (lock.effectiveStateLabel ?? "Nieznany", .gray)
            case .offline:    return ("offline", .gray)
            }
        }()
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text)
                .font(.caption).fontWeight(.medium)
                .foregroundStyle(color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(color.opacity(0.14), in: Capsule())
    }

    private func loadSmartLock() async {
        do {
            let resp: NukiStatusResponse = try await APIClient.shared.get("/resident/smart-lock")
            nukiLocks = resp.locks
            smartLockSupported = true
        } catch let APIError.httpError(code, _) where code == 404 {
            smartLockSupported = false   // stary backend — ukryj sekcję
        } catch {
            // inny błąd (sieć/5xx) — zakładamy że feature istnieje, lista pusta
            if smartLockSupported == nil { smartLockSupported = true }
        }
    }

    private func removeSmartLock(_ apId: Int) async {
        nukiRemoving = apId
        defer { nukiRemoving = nil }
        do {
            let _: EmptyResponse = try await APIClient.shared.delete("/resident/smart-lock/\(apId)")
            await loadSmartLock()
        } catch {
            // ignore — status i tak odświeżymy przy następnym otwarciu ekranu
        }
    }

    // MARK: – Moje pojazdy

    private var vehiclesSection: some View {
        Section {
            if let vehicles = resident?.vehicles {
                ForEach(vehicles) { v in
                    Button { selectedVehicle = v } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 12) {
                                Image(systemName: "car.fill")
                                    .foregroundStyle(.blue)
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(v.licensePlate)
                                        .fontWeight(.semibold)
                                        .font(.system(.body, design: .monospaced))
                                    Text("\(v.displayName) · \(v.color)")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                vehicleStatusBadge(v.effectiveStatus)
                                Image(systemName: "chevron.right")
                                    .font(.caption).foregroundStyle(.tertiary)
                            }
                            // Powód odmowy widoczny przy pojeździe REJECTED — żeby
                            // mieszkaniec wiedział co poprawić bez pisania wiadomości.
                            if v.effectiveStatus == .rejected, let reason = v.rejectionReason, !reason.isEmpty {
                                Text("Powód odmowy: \(reason)")
                                    .font(.caption2)
                                    .foregroundStyle(.red)
                                    .padding(.leading, 36)
                            }
                            if v.effectiveStatus == .pending {
                                Text("Oczekuje na zatwierdzenie przez administratora")
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                                    .padding(.leading, 36)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            Button {
                showAddVehicle = true
            } label: {
                Label("Dodaj pojazd", systemImage: "plus.circle.fill")
                    .foregroundStyle(.blue)
            }
        } header: {
            Text("Moje pojazdy")
        } footer: {
            // Przypomnienie żeby mieszkaniec wiedział czemu nowy pojazd nie wjeżdża.
            Text("Nowo dodane pojazdy wymagają zatwierdzenia przez administratora budynku.")
        }
    }

    // Badge statusu pojazdu — kolor i ikona pochodzą z VehicleStatus.
    @ViewBuilder
    private func vehicleStatusBadge(_ status: VehicleStatus) -> some View {
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

    // MARK: – Główny ekran (toggles)

    private var homeScreenSection: some View {
        Section {
            Toggle(isOn: $homeShowAccessPoints) {
                Label("Bramki / Domofony", systemImage: "door.left.hand.open")
            }
            Toggle(isOn: $homeShowQuickActions) {
                Label("Szybkie akcje", systemImage: "square.grid.2x2.fill")
            }
            Toggle(isOn: $homeShowActivity) {
                Label("Ostatnia aktywność", systemImage: "clock.fill")
            }
            Toggle(isOn: $homeShowAccessEvents) {
                Label("Ostatnie wejścia", systemImage: "door.left.hand.open")
            }
        } header: {
            Text("Główny ekran")
        } footer: {
            Text("Wybierz, które sekcje mają być widoczne na ekranie głównym.")
        }
    }

    // MARK: – Wygląd (motyw)
    //
    // @ViewBuilder bo property zwraca dwie Sekcje (Wygląd + Kolor motywu) —
    // bez @ViewBuilder Swift nie potrafi wyinferowć jednego `some View` typu.
    // Form-Container splata je w jeden Settings layout automatycznie.

    @ViewBuilder
    private var themeSection: some View {
        // ── Motyw aplikacji (2026-06-09) ──────────────────────────────
        // 6 presetów: Klasyczny dark/light, Vibrant Dark, Professional,
        // Midnight Blue, Forest. Każdy ma własne tła + opcjonalnie wymuszony
        // accent (np. Forest wymusza żółć). Klasyczne dark/light NIE
        // wymuszają — user dalej wybiera swatch akcentu niżej.
        Section {
            ForEach(AppTheme.allCases) { theme in
                Button {
                    appTheme = theme.rawValue
                } label: {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle()
                                .fill(theme.previewColor)
                                .frame(width: 36, height: 36)
                                .overlay(
                                    Circle().stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
                                )
                            if let accent = theme.previewAccentColor {
                                Circle()
                                    .fill(accent)
                                    .frame(width: 14, height: 14)
                                    .overlay(
                                        Circle().stroke(theme.previewColor, lineWidth: 2),
                                    )
                                    .offset(x: 10, y: 10)
                            }
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(theme.displayName)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.primary)
                            Text(theme.description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        if appTheme == theme.rawValue {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 22))
                                .foregroundStyle(GLColor.accent300(scheme))
                        } else {
                            Image(systemName: "circle")
                                .font(.system(size: 22))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .contentShape(Rectangle())
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
        } header: {
            Label("Motyw aplikacji", systemImage: "paintbrush.fill")
        } footer: {
            Text("Wybór motywu wpływa na kolor tła, kart i akcentów. Niektóre motywy (Forest, Midnight Blue, Vibrant Dark, Professional) wymuszają własny kolor akcentu.")
        }

        // ── Kolor motywu (2026-05-22) ──────────────────────────────────
        // Picker z 7 kolorami akcentów. Wybór zapisuje "appAccentColor" do
        // UserDefaults; GLColor.accent* czyta klucz synchronicznie więc
        // wszystkie miejsca używające accent gradientu/sparkle/CTA aut.
        // przeładują się gdy SwiftUI re-renderuje (każde miejsce ma własny
        // @AppStorage("appAccentColor") albo dziedziczy przez parent).
        //
        // 2026-06-09 — dla presetów z `forcedAccent` (Forest/Midnight/Vibrant/
        // Professional) ten swatch jest disabled — user wybrał już accent
        // implicit przez wybór motywu wyżej. Pokazujemy info-text zamiast.
        Section {
            if let forced = AppTheme(rawValue: appTheme)?.forcedAccent {
                // Preset wymusza accent — pokazujemy info zamiast pickera.
                HStack(spacing: 12) {
                    Circle()
                        .fill(Color(hex: forced.dark300))
                        .frame(width: 28, height: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Akcent z motywu: \(forced.displayName)")
                            .font(.system(size: 14, weight: .medium))
                        Text("Zmień motyw na klasyczny, aby wybrać swój kolor akcentu.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            } else {
                // Grid 4 kolumny × 2 rzędy (7 elementów + 1 placeholder).
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4),
                    spacing: 12,
                ) {
                    ForEach(AccentTheme.allCases) { theme in
                        Button {
                            appAccentColor = theme.rawValue
                        } label: {
                            VStack(spacing: 4) {
                                ZStack {
                                    Circle()
                                        .fill(theme.previewColor)
                                        .frame(width: 36, height: 36)
                                        .overlay(
                                            Circle()
                                                .stroke(
                                                    appAccentColor == theme.rawValue
                                                        ? Color.primary
                                                        : Color.clear,
                                                    lineWidth: 2,
                                                )
                                                .padding(-3),
                                        )
                                    if appAccentColor == theme.rawValue {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 14, weight: .bold))
                                            .foregroundStyle(.white)
                                    }
                                }
                                Text(theme.displayName)
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            .frame(maxWidth: .infinity)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 4)
            }
        } header: {
            Label("Kolor motywu", systemImage: "paintpalette.fill")
        } footer: {
            Text("Akcent koloru używany dla przycisków, ikon i gradientu.")
        }
    }

    // MARK: – Wyloguj

    private var logoutSection: some View {
        Section {
            Button(role: .destructive) {
                auth.logout()
            } label: {
                HStack {
                    Spacer()
                    Text("Wyloguj się")
                    Spacer()
                }
            }
        }
    }

    // MARK: – Wersja

    private var versionSection: some View {
        Section {
            HStack {
                Spacer()
                VStack(spacing: 4) {
                    Text("GateLynk").fontWeight(.bold).foregroundStyle(.blue)
                    Text("v1.0").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
        }
    }

    // MARK: – Load

    private func loadResident() async {
        loading = true
        do {
            let r: Resident = try await APIClient.shared.get("/resident/me")
            resident = r
            notifyAnomalies = r.notifyAnomalies ?? false
            notifyWasteTruck = r.notifyWasteTruck
            intercomPinSaved = r.intercomPin
            // Jeśli flag jest ON to znaczy że user już kiedyś świadomie włączył
            // (backend ma true) — zaznacz lokalnie że disclaimer został zaakceptowany,
            // żeby toggling OFF→ON po wylogowaniu nie pokazywał już sheet-a.
            if r.notifyAnomalies == true { confirmedAnomalyOptIn = true }
        }
        catch {}
        loading = false
    }
}

// MARK: - Przełącznik nieruchomości (multi-property, 2026-08-09)
//
// Sheet z listą wszystkich obiektów, w których ten e-mail ma konto mieszkańca
// (GET /resident/my-buildings). Przełączenie = POST /resident/auth/switch-building
// z aktualnym tokenem (bez ponownego hasła), po czym MainTabView przebudowuje
// ResidentTabView przez `.id(residentId)` i wszystko ładuje się dla nowego
// budynku. „Dodanie" nieruchomości nie wymaga niczego w apce: gdy zarządca
// innego obiektu doda mieszkańca na TEN SAM e-mail, konto pojawia się na
// liście automatycznie — sekcja niżej tłumaczy dokładnie to.

struct PropertiesView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(\.dismiss) private var dismiss

    @State private var buildings: [ResidentBuildingChoice]? = nil
    @State private var loadError: String? = nil
    @State private var switchingId: Int? = nil
    @State private var switchError: String? = nil
    @State private var emailCopied = false

    var body: some View {
        NavigationStack {
            List {
                listSection
                addPropertySection
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Nieruchomości")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Zamknij") { dismiss() }
                }
            }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    // MARK: Lista

    @ViewBuilder
    private var listSection: some View {
        Section("Twoje nieruchomości") {
            if let buildings {
                ForEach(buildings) { b in
                    propertyRow(b)
                }
            } else if let loadError {
                Label(loadError, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.secondary)
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
            if let switchError {
                Text(switchError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private func propertyRow(_ b: ResidentBuildingChoice) -> some View {
        let isCurrent = b.residentId == auth.currentResidentId
        return Button {
            guard !isCurrent, switchingId == nil else { return }
            Task { await switchTo(b) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: isCurrent ? "building.2.fill" : "building.2")
                    .foregroundStyle(isCurrent ? .blue : .secondary)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(b.buildingName)
                        .fontWeight(.semibold)
                        .foregroundStyle(.primary)
                    Text([b.buildingAddress, b.unit.map { "lokal \($0)" }]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if switchingId == b.residentId {
                    ProgressView()
                } else if isCurrent {
                    Text("Obecna")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.blue.opacity(0.12))
                        .foregroundStyle(.blue)
                        .cornerRadius(8)
                } else {
                    Image(systemName: "arrow.right.circle")
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .disabled(switchingId != nil)
    }

    // MARK: Dodawanie nieruchomości

    private var addPropertySection: some View {
        Section {
            if let email = auth.currentResidentEmail {
                Button {
                    UIPasteboard.general.string = email
                    emailCopied = true
                    Task {
                        try? await Task.sleep(for: .seconds(2))
                        emailCopied = false
                    }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: emailCopied ? "checkmark.circle.fill" : "doc.on.doc")
                            .foregroundStyle(emailCopied ? .green : .blue)
                            .frame(width: 24)
                        Text(emailCopied ? "Skopiowano" : email)
                            .foregroundStyle(.primary)
                        Spacer()
                    }
                }
            }
        } header: {
            Text("Dodaj nieruchomość")
        } footer: {
            Text("Podaj zarządcy nowej nieruchomości swój adres e-mail (powyżej — dotknij, aby skopiować). Gdy doda Cię jako mieszkańca, nieruchomość pojawi się na tej liście automatycznie — bez zakładania nowego konta.")
        }
    }

    // MARK: Akcje

    private func load() async {
        loadError = nil
        do {
            buildings = try await auth.fetchMyBuildings()
        } catch {
            if buildings == nil { loadError = "Nie udało się pobrać listy nieruchomości" }
        }
    }

    private func switchTo(_ b: ResidentBuildingChoice) async {
        switchingId = b.residentId
        switchError = nil
        do {
            try await auth.switchBuilding(to: b.residentId)
            // Zmiana auth.role przebudowuje MainTabView (`.id`) — sheet
            // zniknie razem ze starym drzewem widoków. Dismiss dla porządku.
            dismiss()
        } catch {
            switchError = "Nie udało się przełączyć — spróbuj ponownie"
            switchingId = nil
        }
    }
}

// MARK: - Zaproszenie domownika (household, 2026-08-09)
//
// Dwustopniowy sheet: (1) formularz — imię domownika + opcjonalna relacja,
// „Utwórz zaproszenie" POST-uje do API; (2) ekran udostępniania — gotowy link
// wysyłamy ShareLink-iem (iMessage/WhatsApp/Mail), dokładnie jak PIN gościa
// w GuestsView. Link można też wysłać później z listy w sekcji „Domownicy".

struct HouseholdInviteView: View {
    @Environment(\.dismiss) private var dismiss
    /// Reload sekcji „Domownicy" po utworzeniu zaproszenia.
    let onDone: () async -> Void

    @State private var name = ""
    @State private var relationLabel = ""
    @State private var creating = false
    @State private var createError: String? = nil
    @State private var created: HouseholdInviteCreated? = nil

    var body: some View {
        NavigationStack {
            Group {
                if let created {
                    shareContent(created)
                } else {
                    formContent
                }
            }
            .navigationTitle("Zaproś domownika")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(created == nil ? "Anuluj" : "Gotowe") {
                        dismiss()
                    }
                }
            }
            .onDisappear {
                // Zaproszenie mogło powstać nawet gdy user zamknął sheet
                // swipe-em — odśwież listę zawsze.
                Task { await onDone() }
            }
        }
    }

    // MARK: Krok 1 — formularz

    private var formContent: some View {
        Form {
            Section {
                TextField("Imię i nazwisko", text: $name)
                    .textInputAutocapitalization(.words)
                TextField("Relacja (np. żona, syn) — opcjonalnie", text: $relationLabel)
                    .textInputAutocapitalization(.never)
            } header: {
                Text("Kogo zapraszasz?")
            } footer: {
                Text("Domownik otworzy link, poda swój adres e-mail i ustawi własne hasło. Dostanie te same funkcje co Ty: otwieranie bram, goście, domofon.")
            }

            if let createError {
                Section {
                    Text(createError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            Section {
                Button {
                    Task { await create() }
                } label: {
                    HStack {
                        Spacer()
                        if creating { ProgressView().padding(.trailing, 6) }
                        Text(creating ? "Tworzę zaproszenie…" : "Utwórz zaproszenie")
                            .fontWeight(.semibold)
                        Spacer()
                    }
                }
                .disabled(creating || name.trimmingCharacters(in: .whitespaces).count < 2)
            }
        }
    }

    // MARK: Krok 2 — udostępnienie linku

    private func shareContent(_ inv: HouseholdInviteCreated) -> some View {
        VStack(spacing: 18) {
            Spacer(minLength: 12)
            Image(systemName: "person.2.badge.plus")
                .font(.system(size: 44))
                .foregroundStyle(.blue)
            Text("Zaproszenie dla \(inv.inviteeName) gotowe")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("Wyślij link — po otwarciu domownik poda swój e-mail, ustawi hasło i zaloguje się w aplikacji GateLynk. Link jest ważny do \(SettingsView.plShortDate(inv.expiresAt)) i działa jednorazowo.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            if let url = URL(string: inv.inviteUrl) {
                ShareLink(
                    item: url,
                    message: Text(SettingsView.householdShareMessage(name: inv.inviteeName))
                ) {
                    Label("Wyślij zaproszenie", systemImage: "paperplane.fill")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal)
            }

            Button("Zamknij") { dismiss() }
                .buttonStyle(.borderless)
            Spacer()
        }
        .padding()
    }

    // MARK: Akcja

    private func create() async {
        creating = true
        createError = nil
        defer { creating = false }
        struct Body: Encodable { let name: String; let relationLabel: String? }
        do {
            let resp: HouseholdInviteCreated = try await APIClient.shared.post(
                "/resident/household/invitations",
                body: Body(
                    name: name.trimmingCharacters(in: .whitespaces),
                    relationLabel: relationLabel.trimmingCharacters(in: .whitespaces).isEmpty
                        ? nil
                        : relationLabel.trimmingCharacters(in: .whitespaces)
                )
            )
            created = resp
        } catch let APIError.httpError(_, message) {
            createError = message
        } catch {
            createError = "Nie udało się utworzyć zaproszenia — spróbuj ponownie"
        }
    }
}
