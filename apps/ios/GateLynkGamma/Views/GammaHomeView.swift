import SwiftUI

// MARK: - Ekran główny Gamma Depth Premium
//
// Struktura (README): powitanie → karta "Otwórz" ze sliderem → 2 rzędy
// kafelków → karta "Asystent osiedla" → floating tab bar (Dom / ✦ Zapytaj AI /
// Więcej). Tło adaptacyjne wg pory dnia, badge w prawym górnym rogu
// przełącza porę ręcznie (demo, jak w prototypie).
//
// Dynamic Island ("Zbliżasz się · Wjazd 12 m") wymaga Live Activities +
// geofencing — poza zakresem MVP, do osobnej iteracji.

struct GammaHomeView: View {
    @Environment(AuthManager.self) private var auth
    @Environment(GammaToastCenter.self) private var toast

    // Dane
    @State private var building: Building?
    @State private var residentFull: Resident?
    @State private var accessPoints: [AccessPoint] = []
    @State private var parcels: [Parcel] = []
    @State private var payments: PaymentSummary?
    @State private var guests: [Guest] = []
    @State private var tickets: [Ticket] = []

    // UI
    @State private var activeSheet: GammaSheetKind?
    @State private var weather: GammaWeatherNow?
    @State private var tod: GammaTimeOfDay = .fromClock()
    @State private var todOverride = false
    @State private var tabBarShown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            ZStack {
                GammaBackground(tod: tod)

                if isResident {
                    mainContent
                    todBadge
                    tabBar
                    sheetHost(maxHeight: geo.size.height * 0.8)
                } else {
                    wrongRoleNotice
                }

                toastHost
            }
        }
        .task { await loadAll() }
        .onReceive(
            Timer.publish(every: 60, on: .main, in: .common).autoconnect()
        ) { _ in
            guard !todOverride else { return }
            let clock = GammaTimeOfDay.fromClock()
            if clock != tod { tod = clock }
        }
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

                primaryCard
                    .glassRiseIn(delay: 0.3)

                tilesRow1
                    .glassRiseIn(delay: 0.45)

                tilesRow2
                    .glassRiseIn(delay: 0.6)

                GammaAssistantCard {
                    activeSheet = .announcements
                }
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
        guard let w = weather else { return GammaFormat.dayLabel() }
        return "\(w.temp)°C · \(w.desc) · \(todPhrase)"
    }

    private var todPhrase: String {
        switch tod {
        case .day:     return "miłego dnia"
        case .evening: return "wracasz do domu"
        case .night:   return "dobranoc"
        }
    }

    // MARK: Karta "Otwórz"

    private var primaryCard: some View {
        ZStack(alignment: .topTrailing) {
            // v5: grafika drzwi 3D w prawym górnym rogu — statyczna (świadomie
            // NIE animowana), symbol otwierania. Zastępuje szklaną sferę z β.
            Image("DoorOpen")
                .resizable()
                .scaledToFit()
                .frame(width: 124, height: 124)
                .offset(x: 20, y: -12)
                .opacity(0.95)
                .allowsHitTesting(false)

            VStack(alignment: .leading, spacing: 0) {
                Text("DOSTĘP")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.3)
                    .foregroundStyle(.white.opacity(0.78))

                Text("Otwórz")
                    .font(.system(size: 36, weight: .semibold))
                    .tracking(-1.1)
                    .foregroundStyle(.white)
                    .padding(.top, 4)

                HStack(spacing: 6) {
                    Circle()
                        .fill(GammaColor.success)
                        .frame(width: 6, height: 6)
                        .shadow(color: GammaColor.success, radius: 4)
                    Text(accessStatusLine)
                        .font(.system(size: 12))
                        .foregroundStyle(.white.opacity(0.76))
                }
                .padding(.top, 6)

                SlideToOpen {
                    await openPrimaryAccessPoint()
                }
                .padding(.top, 18)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 20)
        // Prototyp: .primary ma overflow:hidden — sfera nie wychodzi poza kartę
        .clipShape(RoundedRectangle(cornerRadius: GammaRadius.primary, style: .continuous))
        .glassCard(radius: GammaRadius.primary)
        .contentShape(RoundedRectangle(cornerRadius: GammaRadius.primary, style: .continuous))
        .onTapGesture { activeSheet = .gate }
    }

    private var accessStatusLine: String {
        if accessPoints.isEmpty { return "Łączenie z osiedlem…" }
        return accessPoints.prefix(3).map(\.label).joined(separator: " · ")
    }

    // MARK: Kafelki

    // Ikony 1:1 z prototypu: Pojazdy wypełnione auto, reszta konturowa
    // (stroke 1.9 → SF outline + .medium), Zgłoszenia = klucz pod kątem,
    // Przesyłki = sześcian 3D, Ogłoszenia = głośnik z falą.

    private var tilesRow1: some View {
        HStack(spacing: 9) {
            GammaTile(
                gradient: [GammaColor.accentBlue, GammaColor.orbViolet],
                icon: "car.fill", label: "Pojazdy"
            ) { activeSheet = .vehicles }

            GammaTile(
                gradient: [GammaColor.success, GammaColor.accentBlue],
                icon: "person.2", label: "Goście",
                iconWeight: .medium
            ) { activeSheet = .guests }

            GammaTile(
                gradient: [GammaColor.dangerSoft, GammaColor.dangerDeep],
                icon: "creditcard", label: "Płatność",
                iconWeight: .medium,
                showAlertDot: hasOverduePayment
            ) { activeSheet = .payments }
        }
    }

    private var tilesRow2: some View {
        HStack(spacing: 9) {
            GammaTile(
                gradient: [GammaColor.orbAmber1, GammaColor.orbAmber2],
                icon: "key", label: "Zgłoszenia",
                iconWeight: .medium, iconRotation: 45
            ) { activeSheet = .tickets }

            GammaTile(
                gradient: [GammaColor.orbBlue1, GammaColor.orbBlue2],
                icon: "cube", label: "Przesyłki",
                iconWeight: .medium,
                badgeCount: waitingParcelsCount
            ) { activeSheet = .parcels }

            GammaTile(
                gradient: [GammaColor.accentLight, GammaColor.orbPurple],
                icon: "speaker.wave.1", label: "Ogłoszenia",
                iconWeight: .medium
            ) { activeSheet = .announcements }
        }
    }

    private var hasOverduePayment: Bool {
        (payments?.balance ?? 0) < 0
    }

    private var waitingParcelsCount: Int {
        parcels.filter { $0.status == "RECEIVED" }.count
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
                                colors: [GammaColor.accentLight.opacity(0.4), GammaColor.accentBlue.opacity(0.4)],
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
                            .fill(GammaColor.accentGradient)
                            .shadow(color: GammaColor.accentBlue.opacity(0.5), radius: 9, y: 4)
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
                GammaSheetContainer(onClose: { activeSheet = nil }) {
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
    private func sheetContent(_ sheet: GammaSheetKind) -> some View {
        switch sheet {
        case .gate:
            GammaGateSheet(
                accessPoints: accessPoints,
                onOpen: { ap in await openAccessPoint(ap) },
                onClose: { activeSheet = nil }
            )
        case .vehicles:
            GammaVehiclesSheet(
                vehicles: residentFull?.vehicles ?? [],
                onClose: { activeSheet = nil }
            )
        case .guests:
            GammaGuestsSheet(
                guests: guests,
                onReload: { await reloadGuests() },
                onClose: { activeSheet = nil }
            )
        case .payments:
            GammaPaymentsSheet(
                summary: payments,
                onClose: { activeSheet = nil }
            )
        case .tickets:
            GammaTicketsSheet(
                tickets: tickets,
                onReload: { await reloadTickets() },
                onClose: { activeSheet = nil }
            )
        case .parcels:
            GammaParcelsSheet(
                parcels: parcels,
                onClose: { activeSheet = nil }
            )
        case .announcements:
            GammaAnnouncementsSheet(onClose: { activeSheet = nil })
        case .chat:
            GammaChatSheet(onClose: { activeSheet = nil })
        case .more:
            GammaMoreSheet(
                building: building,
                onClose: { activeSheet = nil }
            )
        }
    }

    // MARK: Toast host

    private var toastHost: some View {
        VStack {
            Spacer()
            if let msg = toast.message {
                GammaToastView(message: msg, isError: toast.isError)
                    .padding(.bottom, 80)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: toast.message)
        .allowsHitTesting(false)
        .zIndex(200)
    }

    // MARK: Zła rola (Gamma β jest resident-only)

    private var wrongRoleNotice: some View {
        VStack(spacing: 14) {
            Image(systemName: "person.crop.circle.badge.exclamationmark")
                .font(.system(size: 40))
                .foregroundStyle(.white.opacity(0.6))
            Text("GateLynk β obsługuje tylko konto mieszkańca.")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
            GammaButton(title: "Wyloguj", style: .ghost) { auth.logout() }
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
        parcels = await parc
        payments = await pay
        guests = await gst
        tickets = await tck

        // Pogoda w tle — nie blokuje pull-to-refresh, brak sieci = zostaje data
        if let address = building?.address {
            Task { weather = await GammaWeather.fetch(address: address) }
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

    /// Slider otwiera pierwszy (główny) access point.
    private func openPrimaryAccessPoint() async -> Bool {
        guard let ap = accessPoints.first else {
            toast.show("Brak skonfigurowanych przejść", error: true)
            return false
        }
        let ok = await openAccessPoint(ap)
        toast.show(ok ? "\(ap.label) — otwarto" : "Nie udało się otworzyć", error: !ok)
        return ok
    }

    private func openAccessPoint(_ ap: AccessPoint) async -> Bool {
        do {
            let r: OpenAccessPointResponse = try await APIClient.shared.post(
                "/resident/access-points/\(ap.id)/open",
                body: GammaEmptyBody()
            )
            return r.success
        } catch {
            return false
        }
    }
}

struct GammaEmptyBody: Encodable {}

// MARK: - Sfera 3D (radial-gradient biały→fiolet→indygo, float 7s)

struct GammaSphere: View {
    @State private var floating = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            Circle()
                .fill(
                    RadialGradient(
                        stops: [
                            .init(color: .white, location: 0),
                            .init(color: GammaColor.accentLight, location: 0.35),
                            .init(color: GammaColor.accentBlue, location: 0.7),
                            .init(color: Color(red: 42/255, green: 26/255, blue: 140/255), location: 1),
                        ],
                        center: UnitPoint(x: 0.3, y: 0.3),
                        startRadius: 4, endRadius: 110
                    )
                )
                .shadow(color: GammaColor.accentBlue.opacity(0.45), radius: 25, y: 12)

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

struct GammaTile: View {
    let gradient: [Color]
    let icon: String
    let label: String
    var iconWeight: Font.Weight = .semibold
    var iconRotation: Double = 0
    var showAlertDot = false
    var badgeCount = 0
    let action: () -> Void

    @State private var pressed = false

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                VStack(alignment: .leading, spacing: 9) {
                    GammaOrb(
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
                    GammaPulsingDot()
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
                                .fill(GammaColor.accentGradient)
                                .shadow(color: GammaColor.accentBlue.opacity(0.55), radius: 5, y: 2)
                        }
                        .padding(.top, 9)
                        .padding(.trailing, 11)
                }
            }
            .glassCard(radius: GammaRadius.tile)
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

struct GammaWeatherNow: Equatable {
    let temp: Int
    let desc: String
}

enum GammaWeather {
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

    static func fetch(address: String) async -> GammaWeatherNow? {
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

    private static func current(lat: Double, lon: Double) async -> GammaWeatherNow? {
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
        return GammaWeatherNow(
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

struct GammaPulsingDot: View {
    @State private var pulsing = false

    var body: some View {
        Circle()
            .fill(GammaColor.danger)
            .frame(width: 8, height: 8)
            .shadow(color: GammaColor.danger.opacity(pulsing ? 0.9 : 0.4), radius: pulsing ? 7 : 3)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                    pulsing = true
                }
            }
    }
}
