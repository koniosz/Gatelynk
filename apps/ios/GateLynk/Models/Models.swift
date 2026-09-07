import Foundation

// MARK: - Push

/// Generic decodable used when we only care that the call succeeded.
struct PushTokenResponse: Decodable {
    let id: Int?
    let token: String?
}

// MARK: - Auth

struct LoginResponse: Decodable {
    let accessToken: String
    let resident: ResidentUser?
    let concierge: ConciergeUser?
    let buildingAdmin: BuildingAdminUser?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case resident, concierge, buildingAdmin = "buildingAdmin"
    }
}

/// Multi-building login (2026-07-07): `POST /resident/auth/login` może zwrócić
/// zamiast tokenu `{ requiresBuildingSelection: true, buildings: [...] }` gdy
/// ten sam e-mail ma konta w >1 budynku. Klient pokazuje picker i domyka
/// logowanie przez `POST /resident/auth/select-building`.
struct ResidentLoginRaw: Decodable {
    let accessToken: String?
    let resident: ResidentUser?
    let requiresBuildingSelection: Bool?
    let buildings: [ResidentBuildingChoice]?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case resident, requiresBuildingSelection, buildings
    }
}

/// Jedna pozycja pickera budynku przy multi-building loginie.
struct ResidentBuildingChoice: Decodable, Identifiable, Equatable {
    let residentId: Int
    let buildingId: Int
    let buildingName: String
    let buildingAddress: String?
    let unit: String?

    var id: Int { residentId }
}

struct ResidentUser: Decodable {
    let id: Int
    let firstName: String
    let lastName: String
    let email: String
    let phone: String?
    let buildingId: Int
    let avatarBase64: String?
}

struct ConciergeUser: Decodable {
    let id: Int
    let name: String
    let email: String
    let buildingId: Int
}

struct BuildingAdminUser: Decodable {
    let id: Int
    let name: String
    let email: String
    let buildingIds: [Int]
}

// MARK: - Building

struct Building: Decodable, Identifiable {
    let id: Int
    let name: String
    let address: String
    let objectType: String?
    let backgroundImageBase64: String?
    let logoBase64: String?
    let count: BuildingCount?

    enum CodingKeys: String, CodingKey {
        case id, name, address, objectType
        case backgroundImageBase64, logoBase64
        case count = "_count"
    }
}

struct BuildingCount: Decodable {
    let residents: Int?
    let units: Int?
}

// MARK: - Resident

struct Resident: Decodable, Identifiable {
    let id: Int
    let firstName: String
    let lastName: String
    let email: String
    let phone: String?
    let buildingId: Int
    let unitResidents: [UnitResident]?
    let vehicles: [Vehicle]?
    // 2026-05-24: opt-in dla pushy o zagrożeniach (FALL, w przyszłości FIRE/INTRUSION).
    // Optional bo starszy backend może nie zwracać tego pola — wtedy domyślnie OFF.
    let notifyAnomalies: Bool?
    // 2026-06-02: stały PIN mieszkańca do klawiatury przy bramie.
    // 4-6 cyfr, ustawiany w iOS Profile. Null = brak ustawionego PIN-u.
    let intercomPin: String?
    // FAZA e (2026-06-02): spłaszczone permissions per feature/AP dla
    // resident-roli. Klucze: `feat_<system_feature>` lub `ap_<accessPointId>`.
    // Niezdefiniowany klucz = backend zwraca true, więc iOS też powinien
    // pokazać feature jako dostępną (defense via `hasFeature(...)`).
    // Optional bo starszy backend może nie zwracać tego pola — wtedy
    // wszystkie features są domyślnie widoczne.
    let featurePermissions: [String: Bool]?

    var fullName: String { "\(firstName) \(lastName)" }

    /// Helper — czy feature (klucz bez prefiksu, np. "fall_detection") jest dostępna.
    /// Default true gdy nieskonfigurowane (synced z backend `hasPermission`).
    func hasFeature(_ feature: String) -> Bool {
        guard let perms = featurePermissions else { return true }
        let key = feature.hasPrefix("feat_") || feature.hasPrefix("ap_")
            ? feature
            : "feat_\(feature)"
        if let v = perms[key] { return v }
        return true
    }
}

// MARK: - Unit

struct Unit: Decodable, Identifiable {
    let id: Int
    let number: String
    let floor: Int?
    let unitType: UnitType?
    let stairwell: Stairwell?
}

struct UnitType: Decodable {
    let id: Int
    let name: String
    let icon: String?
    let isCommonArea: Bool?
}

struct Stairwell: Decodable {
    let id: Int
    let name: String
}

struct UnitResident: Decodable, Identifiable {
    let id: Int
    let role: String
    let sinceDate: Date
    let untilDate: Date?
    let unit: Unit?
    let resident: Resident?
}

// MARK: - Vehicle

/// Kategoria pojazdu — dopasowana do Postgres enum `VehicleKind` w API.
/// RESIDENT to zwykłe auto mieszkańca; pozostałe to usługi/dostawy/służby/instytucje
/// zarejestrowane na whiteliście (np. Glovo, śmieciarka, ambulans).
enum VehicleKind: String, Decodable, CaseIterable, Identifiable {
    case resident  = "RESIDENT"
    case delivery  = "DELIVERY"
    case service   = "SERVICE"
    case emergency = "EMERGENCY"
    case publicInst = "PUBLIC"

    var id: String { rawValue }

    /// Etykieta PL do pokazania w UI (np. w Pickerze lub badge).
    var label: String {
        switch self {
        case .resident:   return "Mieszkaniec"
        case .delivery:   return "Dostawa / Kurier"
        case .service:    return "Usługa / Serwis"
        case .emergency:  return "Służby ratunkowe"
        case .publicInst: return "Instytucja publiczna"
        }
    }

    /// Emoji / ikona kategorii (spójne z panelem webowym).
    var icon: String {
        switch self {
        case .resident:   return "👤"
        case .delivery:   return "📦"
        case .service:    return "🔧"
        case .emergency:  return "🚑"
        case .publicInst: return "🏛️"
        }
    }
}

/// Cykl życia pojazdu — odpowiada Postgres enum `VehicleStatus` (Faza 1 bety).
/// PENDING  → mieszkaniec zarejestrował, czeka na decyzję admina
/// APPROVED → aktywny, w allowliście LPR
/// REJECTED → admin odmówił (powód w `rejectionReason`)
/// BLOCKED  → admin tymczasowo zablokował aktywny pojazd
/// EXPIRED  → guest car po terminie (Faza 2)
enum VehicleStatus: String, Decodable, CaseIterable {
    case pending  = "PENDING"
    case approved = "APPROVED"
    case rejected = "REJECTED"
    case blocked  = "BLOCKED"
    case expired  = "EXPIRED"

    var label: String {
        switch self {
        case .pending:  return "Oczekuje"
        case .approved: return "Aktywny"
        case .rejected: return "Odrzucony"
        case .blocked:  return "Zablokowany"
        case .expired:  return "Wygasł"
        }
    }

    var icon: String {
        switch self {
        case .pending:  return "clock.fill"
        case .approved: return "checkmark.seal.fill"
        case .rejected: return "xmark.seal.fill"
        case .blocked:  return "lock.fill"
        case .expired:  return "hourglass.bottomhalf.filled"
        }
    }
}

struct Vehicle: Decodable, Identifiable {
    let id: Int
    let make: String
    let model: String?
    let color: String
    let licensePlate: String
    /// Opcjonalne od chwili, gdy dodano pojazdy „ogólne" (serwisy, dostawy bez
    /// przypisanego mieszkańca). Dla typowych aut mieszkańców zawsze wypełnione.
    let residentId: Int?
    let resident: SimpleResident?
    /// 2026-09-07 — lokal przypisany WPROST do pojazdu (obok lub zamiast
    /// mieszkańca). Starsze backendy nie zwracają → nil.
    let unitId: Int?
    let unit: VehicleUnitRef?

    /// Nowe pola — mogą być puste w odpowiedziach ze starszego backendu.
    let kind: VehicleKind?
    let serviceName: String?
    let notes: String?
    /// Opcjonalne zdjęcie pojazdu (2026-07-16) — base64 data URI.
    let photo: String?
    /// Push o przejeździe pojazdu (2026-08-21) — opt-in z karty pojazdu.
    let notifyOnUse: Bool?

    /// Faza 1 bety Villa Natura — vehicle approval flow.
    /// `status` jest opcjonalny, bo starsze odpowiedzi go nie zwracają;
    /// na froncie traktujemy nil jak `.approved` (back-compat).
    let status: VehicleStatus?
    let validFrom: Date?
    let validTo: Date?
    let rejectionReason: String?

    var displayName: String {
        "\(make)\(model.map { " \($0)" } ?? "")"
    }

    /// Status używany w UI — nil → APPROVED (zgodnie z domyślnym wartością DB).
    var effectiveStatus: VehicleStatus { status ?? .approved }
}

struct SimpleResident: Decodable {
    let id: Int
    let firstName: String
    let lastName: String
    var fullName: String { "\(firstName) \(lastName)" }
}

/// Lokal przypisany do pojazdu (2026-09-07). `label` z API — „B/15A",
/// „Kwiatowa 5", „Niewinna 4/2" (wspólny format common/unit-label.ts).
struct VehicleUnitRef: Decodable {
    let id: Int
    let number: String
    let label: String?
    var displayLabel: String { label ?? number }
}

// MARK: - Guest (Faza 2 bety Villa Natura)
//
// Mieszkaniec zaprasza gościa na okno czasowe (`validFrom..validTo`).
// Gość dostaje 6-cyfrowy PIN do domofonu Akuvox + opcjonalnie tablicę
// w allowliście LPR. Status zmienia cron lub sam mieszkaniec (CANCELLED).

enum GuestStatus: String, Decodable, CaseIterable {
    case active    = "ACTIVE"
    case expired   = "EXPIRED"
    case cancelled = "CANCELLED"

    var label: String {
        switch self {
        case .active:    return "Aktywne"
        case .expired:   return "Wygasło"
        case .cancelled: return "Anulowane"
        }
    }

    var icon: String {
        switch self {
        case .active:    return "checkmark.seal.fill"
        case .expired:   return "hourglass.bottomhalf.filled"
        case .cancelled: return "xmark.seal.fill"
        }
    }
}

struct Guest: Decodable, Identifiable {
    let id: Int
    let buildingId: Int
    let residentId: Int
    let name: String
    let phone: String?
    let vehiclePlate: String?
    let pin: String
    let validFrom: Date
    let validTo: Date
    let status: GuestStatus
    let usedAt: Date?
    let createdAt: Date
    // Guest Portal (pivot bezkontaktowy). Goście stworzeni przed migracją
    // 20260430140000 mogą mieć urlToken=nil → fallback na PIN.
    let urlToken: String?
    let email: String?
    let emailSentAt: Date?
    /// 2026-08-14 — czy aktywności tego gościa (wjazd/wyjazd/PIN) wysyłają
    /// mieszkańcowi pushe. Optional — starszy backend nie zwraca pola;
    /// nil traktujemy jako true (domyślnie włączone). Prośby o otwarcie
    /// drzwi (GUEST_APPROVAL) dochodzą ZAWSZE — to inna ścieżka.
    let notifyOnUse: Bool?
    // Ograniczenia dostępu (2026-07-08) — pola ADDYTYWNE i opcjonalne,
    // stary backend ich nie zwraca (dekodowanie nie może failować).
    /// Dozwolone wejścia z opcjonalnym limitem otwarć. nil = bez ograniczeń
    /// (gość może korzystać ze wszystkich wejść).
    let allowedAccessPoints: [AllowedAccessPointEntry]?
    /// Harmonogram cykliczny (dni tygodnia + okno godzinowe). nil = dostęp
    /// przez cały okres ważności zaproszenia.
    let recurringSchedule: GuestRecurringSchedule?
    /// Zużyte otwarcia per wejście — do liczenia „zostały X" przy limicie.
    let accessUses: [GuestAccessUseCount]?

    /// Pieszy gość (bez tablicy) → tylko PIN do domofonu.
    var isPedestrian: Bool { (vehiclePlate ?? "").isEmpty }

    /// Czy gość ma jakiekolwiek ograniczenia dostępu (wejścia/harmonogram).
    var hasAccessRestrictions: Bool {
        allowedAccessPoints != nil || recurringSchedule != nil
    }

    /// Ile otwarć zostało dla danego wejścia. nil = bez limitu (albo wejście
    /// nie jest na liście ograniczeń). Liczone jako maxUses - zużyte, min 0.
    func remainingUses(apId: Int) -> Int? {
        guard let entry = allowedAccessPoints?.first(where: { $0.apId == apId }),
              let maxUses = entry.maxUses else { return nil }
        let used = accessUses?.first(where: { $0.accessPointId == apId })?.count ?? 0
        return Swift.max(0, maxUses - used)
    }

    /// Suma pozostałych otwarć dla wejść Z limitem. nil = żadne wejście nie
    /// ma limitu (albo brak ograniczeń wejść).
    var totalRemainingUses: Int? {
        guard let aps = allowedAccessPoints else { return nil }
        let limited = aps.filter { $0.maxUses != nil }
        guard !limited.isEmpty else { return nil }
        return limited.reduce(0) { $0 + (remainingUses(apId: $1.apId) ?? 0) }
    }

    /// Krótkie podsumowanie ograniczeń do UI (np. wiersz `extra` w Glass):
    /// „Tylko 2 wejścia · Codziennie 6:00–7:00". nil = brak ograniczeń.
    var restrictionsSummary: String? {
        var parts: [String] = []
        if let aps = allowedAccessPoints, !aps.isEmpty {
            parts.append("Tylko \(Self.entranceCountLabel(aps.count))")
        }
        if let sched = recurringSchedule {
            parts.append(sched.summary)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Polska odmiana: 1 wejście / 2 wejścia / 5 wejść.
    static func entranceCountLabel(_ n: Int) -> String {
        if n == 1 { return "1 wejście" }
        let mod10 = n % 10, mod100 = n % 100
        if (2...4).contains(mod10) && !(12...14).contains(mod100) { return "\(n) wejścia" }
        return "\(n) wejść"
    }

    /// Pełen URL portalu gościa — używany w MFMessageComposeViewController
    /// (deep-link do iMessage, mieszkaniec wysyła do gościa). Jeśli token
    /// jest nil (legacy guest), zwracamy nil — caller pokazuje fallback bez
    /// przycisku Share.
    ///
    /// Domena `app.gatelynk.com` to subdomena na fly.io (apps/web), gdzie
    /// renderowana jest strona `/g/[token]`. Główna `gatelynk.com` jest
    /// sparkowana w home.pl (firmowy landing) — NIE wskazuje na fly,
    /// nie używaj jej tutaj. Cloud Resend-em też wysyła linki na
    /// `app.gatelynk.com` (env `GUEST_PORTAL_BASE_URL` w API).
    func portalUrl(baseUrl: String = "https://app.gatelynk.com") -> URL? {
        guard let token = urlToken, !token.isEmpty else { return nil }
        return URL(string: "\(baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/g/\(token)")
    }
}

/// Jedno dozwolone wejście gościa — z opcjonalnym limitem otwarć.
/// `maxUses == nil` = bez limitu na tym wejściu.
/// `approvalRequired == true` (2026-07-08) — gość PROSI o otwarcie, host
/// zatwierdza push-em (sensowne tylko dla wejść category == UNIT_DOOR).
/// Optional: stary backend nie zwraca pola (decode OK), a syntezowany
/// encode pomija nil (body bajt-w-bajt jak dotąd).
struct AllowedAccessPointEntry: Codable {
    let apId: Int
    let maxUses: Int?
    let approvalRequired: Bool?

    /// Default `approvalRequired = nil` — istniejące call-sites
    /// (`AllowedAccessPointEntry(apId:maxUses:)`, także w targecie Gamma)
    /// kompilują się bez zmian.
    init(apId: Int, maxUses: Int?, approvalRequired: Bool? = nil) {
        self.apId = apId
        self.maxUses = maxUses
        self.approvalRequired = approvalRequired
    }
}

/// Harmonogram cykliczny gościa: dni tygodnia (ISO 1=pn..7=nd, nil/pusta
/// lista = codziennie) + okno godzinowe „HH:mm". `endTime <= startTime`
/// oznacza okno przez północ (np. 22:00–6:00).
struct GuestRecurringSchedule: Codable {
    let days: [Int]?
    let startTime: String
    let endTime: String
    let tz: String?

    static let dayShortLabels = ["pn", "wt", "śr", "czw", "pt", "sb", "nd"]

    /// Czytelne podsumowanie: „Codziennie 6:00–7:00", „pn, śr 6:00–7:00",
    /// „Codziennie 22:00–6:00 (przez noc)".
    var summary: String {
        let daysPart: String
        if let days, !days.isEmpty {
            daysPart = days.sorted()
                .compactMap { (1...7).contains($0) ? Self.dayShortLabels[$0 - 1] : nil }
                .joined(separator: ", ")
        } else {
            daysPart = "Codziennie"
        }
        let overnight = Self.minutes(endTime) <= Self.minutes(startTime)
        var hours = "\(Self.prettyTime(startTime))–\(Self.prettyTime(endTime))"
        if overnight { hours += " (przez noc)" }
        return "\(daysPart) \(hours)"
    }

    /// „06:00" → „6:00" — bez wiodącego zera, jak w polskim UI.
    static func prettyTime(_ hhmm: String) -> String {
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]) else { return hhmm }
        return "\(h):\(parts[1])"
    }

    /// Minuty od północy — do detekcji okna przez północ i parsowania.
    static func minutes(_ hhmm: String) -> Int {
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return 0 }
        return h * 60 + m
    }
}

/// Zużyte otwarcia per wejście (`accessPointId == nil` = zdarzenia bez
/// przypisanego wejścia — nie wliczamy ich do żadnego limitu per-AP).
struct GuestAccessUseCount: Decodable {
    let accessPointId: Int?
    let count: Int
}

struct CreateGuestBody: Encodable {
    let name: String
    let phone: String?
    /// Opcjonalny email — gdy podany, Cloud wyśle Resend z linkiem do portalu.
    /// Bez tego mieszkaniec sam udostępnia link przyciskiem „Wyślij link".
    let email: String?
    let vehiclePlate: String?
    let validFrom: String?
    let validTo: String
    // Ograniczenia dostępu (2026-07-08). Domyślnie nil = pola w ogóle nie
    // idą w JSON-ie (syntezowany encode robi encodeIfPresent) — body bez
    // ograniczeń jest bajt-w-bajt takie jak dotąd (stary backend OK).
    // `var` + default, żeby istniejące call-sites (Glass/Gamma) kompilowały
    // się bez zmian.
    var allowedAccessPoints: [AllowedAccessPointEntry]? = nil
    var recurringSchedule: GuestRecurringSchedule? = nil
    /// 2026-08-14 — pushe o aktywności gościa (wjazd/wyjazd/PIN). nil =
    /// pole pominięte w JSON-ie (backend default true, stary backend OK).
    var notifyOnUse: Bool? = nil
}

/// PATCH /resident/guests/:id — pełny payload edycji gościa. Wszystkie
/// 5 pól wysyłamy zawsze (server bierze diff-a z DB), więc unikamy
/// gimnastyki z double-optional przy „phone=null" / „plate=null".
/// `phone == nil` (po stronie iOS) → wysyłamy JSON `null` → backend
/// czyści pole w bazie. To samo dla `vehiclePlate`.
struct UpdateGuestBody: Encodable {
    let name: String
    let phone: String?
    let vehiclePlate: String?
    let validFrom: String
    let validTo: String
    // Ograniczenia dostępu (2026-07-08). Sterowane flagą `encodeRestrictions`:
    // - false → oba pola POMINIĘTE w JSON-ie (gość nigdy nie miał ograniczeń
    //   i user ich nie ustawił — body identyczne jak dotąd, stary backend OK),
    // - true  → wysyłamy ZAWSZE oba pola: wartość albo jawny null (encodeNil,
    //   jak phone/vehiclePlate) — jawny null czyści ograniczenie w bazie.
    var allowedAccessPoints: [AllowedAccessPointEntry]? = nil
    var recurringSchedule: GuestRecurringSchedule? = nil
    var encodeRestrictions: Bool = false
    /// 2026-08-14 — pushe o aktywności gościa. nil = pole POMINIĘTE
    /// w JSON-ie (backend: undefined = bez zmian).
    var notifyOnUse: Bool? = nil

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        // Jawnie null-ujemy phone i plate — Encodable domyślnie pomija nil-e
        // i serwer by ich nie ruszył; tutaj chcemy „wyczyścić" przy zmianie
        // pieszy/samochodowy.
        if let phone { try c.encode(phone, forKey: .phone) } else { try c.encodeNil(forKey: .phone) }
        if let vehiclePlate { try c.encode(vehiclePlate, forKey: .vehiclePlate) } else { try c.encodeNil(forKey: .vehiclePlate) }
        try c.encode(validFrom, forKey: .validFrom)
        try c.encode(validTo, forKey: .validTo)
        if encodeRestrictions {
            if let allowedAccessPoints {
                try c.encode(allowedAccessPoints, forKey: .allowedAccessPoints)
            } else {
                try c.encodeNil(forKey: .allowedAccessPoints)
            }
            if let recurringSchedule {
                try c.encode(recurringSchedule, forKey: .recurringSchedule)
            } else {
                try c.encodeNil(forKey: .recurringSchedule)
            }
        }
        if let notifyOnUse {
            try c.encode(notifyOnUse, forKey: .notifyOnUse)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case name, phone, vehiclePlate, validFrom, validTo
        case allowedAccessPoints, recurringSchedule, notifyOnUse
    }
}

// MARK: - Notification

struct AppNotification: Decodable, Identifiable {
    let id: Int
    let title: String
    let body: String
    let sentAt: Date
    let residentId: Int?
}

// MARK: - Parcel

struct Parcel: Decodable, Identifiable {
    let id: Int
    let trackingNumber: String
    let courier: String
    let status: String
    let receivedAt: Date
    let issuedAt: Date?
    let unit: Unit?
}

// MARK: - Reservation

struct Reservation: Decodable, Identifiable {
    let id: Int
    let startAt: Date
    let endAt: Date
    let status: String
    let note: String?
    let unit: Unit?
}

// MARK: - Ticket

struct Ticket: Decodable, Identifiable {
    let id: Int
    let category: String
    // Faza 4 — adresat: "ADMIN" (administrator osiedla) lub "CONCIERGE"
    // (konsjerż budynku). Pole opcjonalne dla backwards-compat — starsze
    // ticket-y w bazie nie mają go zwróconego z resident endpoint-u, ale
    // domyślnie zachowują się jak "ADMIN" (default kolumny w schema).
    let type: String?
    let title: String
    let body: String
    let photo: String?
    let status: String
    let createdAt: Date
    let replies: [TicketReply]?
}

struct TicketReply: Decodable, Identifiable {
    let id: Int
    // "ADMIN" | "RESIDENT" | "CONCIERGE" — patrz `TicketReply.authorType` w
    // backend schema.prisma. CONCIERGE dodany w Fazie 4.
    let authorType: String
    // Faza 4 — id konkretnego admina/konsjerża (NULL dla resident-replies).
    // Backend join-uje po tym i zwraca `authorName` osobnym polem.
    let authorId: Int?
    let authorName: String?
    let body: String
    /// 2026-08-13 — załącznik zdjęciowy odpowiedzi (`data:image/jpeg;base64,…`,
    /// ta sama konwencja co `Ticket.photo`). Optional — starsze odpowiedzi
    /// i starszy backend nie zwracają pola.
    let photo: String?
    let createdAt: Date
}

// MARK: - Request bodies

struct LoginBody: Encodable {
    let email: String
    let password: String
}

struct CreateReservationBody: Encodable {
    let unitId: Int
    let startAt: String
    let endAt: String
    let note: String?
}

struct CreateTicketBody: Encodable {
    let category: String
    let title: String
    let body: String
    let photo: String?
    // Faza 4 — adresat zgłoszenia. "ADMIN" (default, do administracji osiedla)
    // lub "CONCIERGE" (do konsjerża budynku — paczki, kurierzy). Pomijane
    // gdy nil — backend ustawia 'ADMIN' jako default.
    let type: String?
}

struct EmptyResponse: Decodable {}

struct AccessPoint: Decodable, Identifiable {
    let id: Int
    let label: String
    let icon: String
    let deviceId: String
    let relayIndex: Int
    let sortOrder: Int
    /// Kategoria semantyczna AP (2026-07-08), np. "MAIN_ENTRY" / "UNIT_DOOR".
    /// Optional — stary backend nie zwraca pola, dekodowanie nie failuje.
    let category: String?
    /// Lokal do którego przypisany jest AP kategorii UNIT_DOOR (zamek na
    /// drzwiach mieszkania, np. Nuki). Backend zwraca go tylko mieszkańcom
    /// tego lokalu.
    let unitId: Int?

    /// Zamek na drzwiach mieszkania — wyróżniany w UI kluczem i bursztynem.
    var isUnitDoor: Bool { category == "UNIT_DOOR" }
}

struct OpenAccessPointResponse: Decodable {
    let success: Bool
    let label: String?
}

// MARK: - Nuki smart lock — onboarding przez mieszkańca (2026-07-09)
//
// Mieszkaniec sam podaje token API Nuki (świadoma zgoda) i podpina zamek do
// SWOJEGO lokalu. Token płynie do urządzenia budynku (Edge), NIE do chmury
// GateLynk. Kontrakty do endpointów `/resident/smart-lock*` (shared oba targety).

/// Jedna pozycja z listy zamków konta Nuki (odpowiedź na verify).
struct NukiSmartlockOption: Decodable, Identifiable, Hashable {
    let smartlockId: String
    let name: String
    var id: String { smartlockId }
}

/// POST /resident/smart-lock/verify → lista zamków konta Nuki (bez tokenu).
struct NukiVerifyResponse: Decodable {
    let smartlocks: [NukiSmartlockOption]
}

/// Semantyczny „kubełek" stanu zamka do kolorowania badge w UI (bez SwiftUI
/// w Models — widok mapuje na Color). Kody rygla Nuki → kubełek:
///   1 → secure (zamknięty), 3/5/6 → open (otwarty/klamka),
///   2/4/7 → transition (w ruchu), 0/254/255 → unknown, brak → offline.
enum NukiLockBadge {
    case secure       // zielony — bezpiecznie zamknięty
    case open         // bursztyn — otwarty / klamka
    case transition   // niebieski — rygluje/otwiera
    case unknown      // szary — nieskalibrowany / silnik / niezdefiniowany
    case offline      // szary — brak live odczytu
}

/// Jeden zamek lokalu (status) — bez tokenu. Rozszerzony 2026-07-10 o live
/// stan rygla (`lockState`/`lockStateLabel`) i czujnika drzwi (`doorState`/
/// `doorStateLabel`). Nowe pola opcjonalne — starszy backend ich nie zwraca
/// (fail-silent: badge wtedy „offline"/ukryty).
struct NukiLockStatus: Decodable, Identifiable {
    let apId: Int
    let name: String
    let unitId: Int?
    let unitLabel: String?
    let isActive: Bool
    let online: Bool
    /// Alias `lockStateLabel` — zostaje dla zgodności ze starszym backendem.
    let stateLabel: String?
    let batteryCritical: Bool?
    // Nowe pola (2026-07-10) — mogą nie przyjść ze starego backendu.
    let lockState: Int?
    let lockStateLabel: String?
    let doorState: Int?
    let doorStateLabel: String?
    var id: Int { apId }

    /// Etykieta rygla do pokazania (preferuj nowe pole, fallback na stare).
    var effectiveStateLabel: String? { lockStateLabel ?? stateLabel }

    /// Etykieta czujnika drzwi (nil = zamek bez czujnika / wyłączony).
    var doorLabel: String? { doorStateLabel }

    /// Kubełek do kolorowania badge.
    var badge: NukiLockBadge {
        guard online else { return .offline }
        switch lockState {
        case 1:            return .secure
        case 3, 5, 6:      return .open
        case 2, 4, 7:      return .transition
        case 0, 254, 255:  return .unknown
        case .some:        return .unknown
        case .none:
            // Brak numeru, ale mamy tekstowy label ze starego backendu —
            // spróbuj po słowie kluczowym, inaczej „unknown".
            guard let l = effectiveStateLabel?.lowercased() else { return .offline }
            if l.contains("zamknięt") { return .secure }
            if l.contains("otwart") || l.contains("klamk") { return .open }
            if l.contains("rygl") || l.contains("otwiera") { return .transition }
            return .unknown
        }
    }
}

/// GET /resident/smart-lock → status zamków lokalu.
struct NukiStatusResponse: Decodable {
    let locks: [NukiLockStatus]
}

/// POST /resident/smart-lock → zarejestrowany zamek.
struct NukiCreateResponse: Decodable {
    let apId: Int
    let label: String
    let unitLabel: String?
    let replaced: Bool?
}

// MARK: - Guest approvals (2026-07-08)
//
// Gość z wpisem `approvalRequired` na wejściu UNIT_DOOR nie otwiera sam —
// wysyła prośbę, host dostaje push (kind=GUEST_APPROVAL) i zatwierdza:
//   GET  /resident/guest-approvals/pending
//   POST /resident/guest-approvals/{id}/approve  → { approved, gateOpened, label }
//   POST /resident/guest-approvals/{id}/deny     → { denied }
// 409 = prośba wygasła / już obsłużona (klient po prostu odświeża listę).

struct GuestApprovalRequest: Decodable, Identifiable {
    let id: String
    let guestName: String
    let accessPointLabel: String
    let createdAt: String
    let expiresAt: String
    /// Ile sekund zostało w chwili fetch-u — klient odlicza lokalnie.
    let secondsLeft: Int
}

struct GuestApprovalApproveResponse: Decodable {
    let approved: Bool
    /// false = zatwierdzono, ale otwarcie zamka NIE powiodło się — pokaż
    /// komunikat o błędzie otwarcia.
    let gateOpened: Bool
    let label: String
}

struct GuestApprovalDenyResponse: Decodable {
    let denied: Bool
}

// MARK: - Payments

struct PaymentSummary: Decodable {
    let unitNumber: String?
    let balance: Double
    let config: PaymentConfig?
    let entries: [PaymentEntry]
    // 2026-07-03 — naliczenie bieżącego miesiąca (składowe + termin + status).
    // Optional: starszy backend nie zwraca tego pola — dekodowanie nie failuje.
    let currentCharge: CurrentPaymentCharge?
}

/// Naliczenie miesięczne z rozbiciem na składowe (endpoint /resident/payments,
/// pole `currentCharge`). Status liczony po stronie API:
/// PAID / PARTIAL / UNPAID / OVERDUE.
struct CurrentPaymentCharge: Decodable {
    let period: String            // "YYYY-MM"
    let totalAmount: Double
    let dueDate: String           // ISO-8601
    let components: [PaymentChargeComponent]?
    let paidAmount: Double
    let status: String            // "PAID" | "PARTIAL" | "UNPAID" | "OVERDUE"
    let daysOverdue: Int?

    var statusLabel: String {
        switch status {
        case "PAID":    return "Opłacone"
        case "PARTIAL": return "Częściowo opłacone"
        case "UNPAID":  return "Do zapłaty"
        case "OVERDUE": return "Po terminie"
        default:        return status
        }
    }
}

/// Pojedyncza składowa naliczenia (snapshot z chwili generacji).
struct PaymentChargeComponent: Decodable, Identifiable {
    let name: String
    let amount: Double

    var id: String { name }
}

struct PaymentConfig: Decodable {
    let monthlyRent: Double
    let dueDay: Int
    let openingBalance: Double
    let openingDate: String
}

struct PaymentEntry: Decodable, Identifiable {
    let id: Int
    let amount: Double
    let type: String        // "CHARGE" | "PAYMENT" | "CORRECTION"
    let date: String
    let description: String?
    let source: String?

    var typeLabel: String {
        switch type {
        case "CHARGE":     return "Obciążenie"
        case "PAYMENT":    return "Wpłata"
        case "CORRECTION": return "Korekta"
        default:           return type
        }
    }

    var isPositive: Bool { amount >= 0 }
}

// MARK: - Payments archive (2026-07-04, GET /resident/payments/charges)

/// Response nowego endpointu archiwum naliczeń. `configured=false` gdy
/// zarządca nie skonfigurował jeszcze opłat (brak składowych I naliczeń)
/// — iOS pokazuje wtedy przyjazny empty-state zamiast pustej listy.
struct PaymentChargesArchive: Decodable {
    let configured: Bool
    let unitNumber: String?
    let charges: [ArchivedPaymentCharge]
}

/// Naliczenie z archiwum: składowe ze snapshotu, status wyliczony po stronie
/// API (PAID/PARTIAL/UNPAID/OVERDUE), suma wpłat + lista wpłat miesiąca.
struct ArchivedPaymentCharge: Decodable, Identifiable {
    let period: String            // "YYYY-MM"
    let totalAmount: Double
    let dueDate: String           // ISO-8601
    let status: String            // "PAID" | "PARTIAL" | "UNPAID" | "OVERDUE"
    let daysOverdue: Int?
    let components: [PaymentChargeComponent]?
    let paidAmount: Double
    let remainingAmount: Double?
    let payments: [ChargePaymentItem]?

    var id: String { period }

    var statusLabel: String {
        switch status {
        case "PAID":    return "Opłacone"
        case "PARTIAL": return "Częściowo"
        case "UNPAID":  return "Do zapłaty"
        case "OVERDUE": return "Po terminie"
        default:        return status
        }
    }
}

/// Pojedyncza wpłata przypisana do naliczenia (ręczna lub z importu MT940).
struct ChargePaymentItem: Decodable, Identifiable {
    let id: Int
    let amount: Double
    let date: String              // ISO-8601
    let source: String?           // "MANUAL" | "MT940"
    let description: String?

    var sourceLabel: String {
        switch source {
        case "MT940":  return "Przelew (wyciąg)"
        case "MANUAL": return "Wpłata ręczna"
        default:       return source ?? "Wpłata"
        }
    }
}

// MARK: - Access Events (Faza 3 Villa Natura)

/// Wpis z `access_events` — ujednolicony audyt wejść do budynku.
/// Rezydent w HomeView dostaje miks: REMOTE_OPEN przez niego, LPR_MATCH dla
/// jego pojazdów, PIN_USED dla jego gości.
struct AccessEvent: Decodable, Identifiable {
    let id: String                 // BigInt po stronie API → string (JSON-safe)
    let ts: String                 // ISO-8601
    let type: String               // 'LPR_MATCH' | 'LPR_NO_MATCH' | 'PIN_USED' | 'REMOTE_OPEN' | 'MANUAL_OPEN' | 'INTERCOM_CALL'
    let direction: String?
    let gateOpened: Bool
    let reason: String?
    let plate: String?
    let accessPointId: Int?
    let accessPointLabel: String?
    let residentId: Int?
    let residentName: String?
    let residentUnitNumber: String?
    let vehicleId: Int?
    let vehicleBrand: String?
    let vehicleModel: String?
    let guestId: Int?
    let guestName: String?
    let openedById: Int?
    let openedByType: String?      // 'RESIDENT' | 'ADMIN' | 'CONCIERGE' | 'EDGE' | 'SYSTEM'
    let openedByName: String?

    /// Próbujemy sparsować ts; iOS preferuje fractional seconds, fallback bez.
    var date: Date {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: ts) { return d }
        let iso2 = ISO8601DateFormatter()
        iso2.formatOptions = [.withInternetDateTime]
        return iso2.date(from: ts) ?? Date()
    }

    /// Krótki polski opis typu — używany w HomeView („Wjazd LPR" / „Otwarcie z aplikacji").
    var typeLabel: String {
        switch type {
        case "LPR_MATCH":     return "Wjazd LPR"
        case "LPR_NO_MATCH":  return "Nieznana tablica"
        case "PIN_USED":      return gateOpened ? "Gość — PIN" : "Błędny PIN"
        case "REMOTE_OPEN":   return "Otwarcie zdalne"
        case "MANUAL_OPEN":   return "Otwarcie ręczne"
        case "INTERCOM_CALL": return "Domofon"
        default:              return type
        }
    }

    /// SF Symbol pasujący do typu eventu.
    var icon: String {
        switch type {
        case "LPR_MATCH":     return "car.fill"
        case "LPR_NO_MATCH":  return "questionmark.diamond.fill"
        case "PIN_USED":      return gateOpened ? "key.fill" : "lock.slash.fill"
        case "REMOTE_OPEN":   return "iphone.gen3"
        case "MANUAL_OPEN":   return "hand.tap.fill"
        case "INTERCOM_CALL": return "bell.fill"
        default:              return "circle.fill"
        }
    }
}

struct AccessEventsResponse: Decodable {
    let events: [AccessEvent]
}

// MARK: - Anomaly Events (fall detection)
//
// 2026-05-24 Etap 4 — model dla `/api/resident/anomaly-events` feed.
// `id` jako String bo backend zwraca BigInt → JSON string. `ts`/`resolvedAt`
// jako String (ISO-8601) — UI parsuje do Date lokalnie kiedy potrzebuje.
struct AnomalyEvent: Decodable, Identifiable {
    let id: String
    let buildingId: Int
    let cameraDeviceId: String
    let ts: String                    // ISO-8601 timestamp
    let type: String                  // 'FALL' | (przyszłość: 'FIRE', 'INTRUSION')
    let likelihood: Double            // 0.0–1.0
    let indicators: [String]          // np. ["horizontal_bbox","head_below_hips"]
    let imageFilename: String?        // JPEG w Edge (proxy przez Cloud)
    let resolvedAt: String?
    let resolvedBy: String?
    let falsePositive: Bool

    // Helper: data jako Date (lub now() jeśli parsing zawiódł)
    var tsDate: Date {
        ISO8601DateFormatter().date(from: ts) ?? Date()
    }

    var likelihoodPercent: Int { Int(likelihood * 100) }
    var isResolved: Bool { resolvedAt != nil }
    var hasImage: Bool { imageFilename != nil }

    var typeLabel: String {
        switch type {
        case "FALL": return "Możliwy upadek"
        case "FIRE": return "Wykryto pożar"
        case "INTRUSION": return "Możliwa intruzja"
        default: return type
        }
    }

    var typeIcon: String {
        switch type {
        case "FALL": return "figure.fall"
        case "FIRE": return "flame.fill"
        case "INTRUSION": return "exclamationmark.shield"
        default: return "exclamationmark.triangle"
        }
    }
}

struct AnomalyEventsResponse: Decodable {
    let events: [AnomalyEvent]
    let total: Int?
    let sinceHours: Int?
}

// MARK: - DaySummary (Faza 8.h.17 — 2026-06-09)
//
// Zwracane przez GET /resident/assistant/day-summary. Dwie sekcje generowane
// przez Bielika z osobnych pytań do Edge AI:
//   • predictions = "Co dziś się wydarzy" (harmonogram + planowane przerwy z KB)
//   • recap       = "Co dziś się działo" (LPR + vision z 24h, existing
//                                          recent_activity_summary intent)
//
// `source` może być "edge" gdy Bielik zwrócił treść, lub "fallback" gdy Edge
// failował dla tej sekcji (drugiej mogło się udać). `stale=true` gdy klient
// dostał stary cache po failurze Edge.

struct DaySummarySection: Decodable {
    let text: String
    let intent: String?
    let source: String?
}

struct DaySummaryResponse: Decodable {
    let predictions: DaySummarySection
    let recap: DaySummarySection
    let generatedAt: String?
    let fromCache: Bool?
    let stale: Bool?
}

// MARK: - Calendar (FAZA 8.h.28, 2026-06-15)
//
// Strukturalny kalendarz wydarzeń na najbliższe N dni. Obecnie źródłem są
// odbiory śmieci z harmonogramu (KB doc, parsowane deterministycznie po stronie
// Edge — patrz waste_calendar.py). CalendarView grupuje `events` po `date`
// i renderuje na kartach dni. Endpoint: GET /resident/assistant/calendar?days=7.
struct CalendarEvent: Decodable, Identifiable {
    let date: String        // "YYYY-MM-DD"
    let type: String        // "waste" (miejsce na 'ticket' itp. w przyszłości)
    let category: String?   // np. "ZMIESZANE" / "BIO"
    let title: String       // np. "Odbiór zmieszanych"
    let icon: String?       // emoji kategorii, np. "🗑️"

    // Stabilne id dla ForEach — data+kategoria+tytuł jest unikalne per event.
    var id: String { "\(date)|\(category ?? "")|\(title)" }
}

struct CalendarResponse: Decodable {
    let days: Int
    let from: String?
    let to: String?
    let events: [CalendarEvent]
    let source: String?
    let fromCache: Bool?
    let stale: Bool?
}

// MARK: - Courier Visit (FAZA d, 2026-06-02)
//
// Wizyta kuriera przy bramie osiedla. Kurier wpisał 4-cyfrowy kod na
// klawiaturze Akuvox → Edge przesłał `COURIER_VISIT_NEW` → Cloud utworzył
// row PENDING + wysłał push do wszystkich mieszkańców (notification category
// 'COURIER_VISIT' z akcjami "Wpuść"/"Nie znam").
//
// Stan przeplywu: PENDING -> ACCEPTED (mieszkaniec wpuscil → szlaban otwarty)
//                          -> REJECTED (mieszkaniec odrzucil)
//                          -> EXPIRED  (cron po 30 min)
//
// Push notification payload data:
//   {
//     type: "COURIER_VISIT",
//     category: "COURIER_VISIT",
//     visitId: "123",
//     code: "1234",
//     buildingId: "9",
//     mac: "00:11:22:33:44:55"
//   }
//
// Akcje notification: POST /resident/courier-visits/accept/:id albo .../reject/:id
struct CourierVisit: Decodable, Identifiable {
    let id: Int
    let code: String
    let courierBrand: String?
    let targetUnitId: Int?
    let status: String              // PENDING | ACCEPTED | REJECTED | EXPIRED
    let createdAt: String           // ISO-8601
    let resolvedAt: String?
    let resolvedBy: Int?
    let expiresAt: String

    var isPending: Bool { status == "PENDING" }
    var isExpired: Bool {
        if status == "EXPIRED" { return true }
        let expiry = ISO8601DateFormatter().date(from: expiresAt) ?? Date.distantFuture
        return expiry < Date()
    }
    var statusLabel: String {
        switch status {
        case "PENDING": return "Oczekuje"
        case "ACCEPTED": return "Wpuszczony"
        case "REJECTED": return "Odrzucony"
        case "EXPIRED": return "Wygasł"
        default: return status
        }
    }
}

// MARK: - Domofon: połączenia (SIP↔WebRTC bridge, 2026-06-13)
//
// Patrz docs/intercom-akuvox-call.md. Wszystkie endpointy za flagą
// INTERCOM_CALL_ENABLED na Cloud — gdy off, zwracają 503.

/// Sesja połączenia domofonowego — kształt z GET /resident/intercom/calls/active.
struct IntercomCallSession: Decodable, Identifiable {
    let id: String                  // = sessionId (uuid) w push/SSE/WebRTC
    let buildingId: Int
    let intercomDeviceId: String?
    let intercomName: String?
    let unitLabel: String?
    let state: String               // INCOMING | RINGING | ACTIVE | ENDED | MISSED
    let startedAt: String?          // ISO-8601
    let answeredById: Int?
    let endReason: String?

    var isRinging: Bool { state == "INCOMING" || state == "RINGING" }
    var isActive: Bool { state == "ACTIVE" }
    var displayName: String { intercomName ?? "Domofon" }
}

/// WebRTC sygnał (offer/answer/ICE) — POST .../signal i odbiór przez SSE.
struct IntercomSignal: Codable {
    let sessionId: String
    let kind: String                // "offer" | "answer" | "ice"
    var sdp: String?
    var candidate: IntercomIceCandidate?
    var from: String?               // "edge" | "app" (Edge wypełnia przy SSE)
}

/// Pojedynczy kandydat ICE — minimalny shape zgodny z RTCIceCandidate.
///
/// Pole `candidate` jest opcjonalne, bo ten sam kształt niesie też sygnał
/// CANCEL (D5 first-answer-wins / timeout): Cloud wysyła
/// `{ cancel: true, reason }` zamiast realnego kandydata. iOS rozpoznaje cancel
/// po `cancel == true` i kończy CallKit na pozostałych urządzeniach.
struct IntercomIceCandidate: Codable {
    var candidate: String?
    var sdpMid: String?
    var sdpMLineIndex: Int32?
    /// Gdy true — to NIE kandydat ICE, lecz polecenie zakończenia połączenia
    /// (ktoś inny odebrał / timeout / koniec). `reason`: ALREADY_ANSWERED |
    /// TIMEOUT | NO_DEVICE | ENDED.
    var cancel: Bool?
    var reason: String?

    /// Czy to realny kandydat ICE (a nie sygnał cancel).
    var isRealCandidate: Bool { cancel != true && (candidate?.isEmpty == false) }
}

/// Batch sygnałów z SSE strumienia (GET .../signal/stream emituje { signals: [...] }).
struct IntercomSignalBatch: Decodable {
    let signals: [IntercomSignal]?
    let heartbeat: Double?
    let ready: Bool?
}

/// Pojedynczy ICE server (STUN/TURN) — kształt z
/// GET /resident/intercom/calls/:id/ice-servers. Mapuje się 1:1 na RTCIceServer
/// (urlStrings + username + credential). TURN creds są krótkożyciowe (HMAC
/// use-auth-secret), więc dociągamy je tuż przed zestawieniem WebRTC.
struct IntercomIceServer: Decodable {
    let urls: [String]
    let username: String?
    let credential: String?
}

/// Odpowiedź ice-servers — lista serwerów + TTL creds TURN.
struct IntercomIceServers: Decodable {
    let iceServers: [IntercomIceServer]
    /// TTL (s) creds TURN; 0 = brak TURN (tylko STUN, off-site nie zadziała).
    let ttl: Int?
    /// 'hmac' | 'static' | 'none' — diagnostyka skąd creds.
    let turnSource: String?
}

// MARK: - Domownicy (household, 2026-08-09)
//
// Mieszkaniec zaprasza domownika (żona/dziecko) ze swojej aplikacji: tworzy
// zaproszenie (imię + opcjonalna relacja), udostępnia link ShareLink-iem,
// domownik na /accept-household podaje własny e-mail + hasło → pełnoprawny
// Resident przypięty do TEGO SAMEGO lokalu. Modele wspólne dla GateLynk
// (SettingsView „Domownicy") i GateLynkGlass (GlassMoreSheet .household).

/// Aktywny współlokator — mieszkaniec z aktywnym pivotem do naszego lokalu.
struct HouseholdMember: Decodable, Identifiable {
    let residentId: Int
    let firstName: String
    let lastName: String
    let email: String?
    /// OWNER / TENANT (rola z pivotu unit_residents).
    let role: String?
    /// Etykieta relacji z zaproszenia („żona", „syn") — nil dla kont od admina.
    let relationLabel: String?
    /// Ma hasło = może się logować; false = konto z importu, niedokończone.
    let hasAccount: Bool?
    /// Czy to konto powstało z MOJEGO zaproszenia (audyt widoczny w UI).
    let invitedByMe: Bool?

    var id: Int { residentId }
    var fullName: String { "\(firstName) \(lastName)" }
}

/// Aktywne (PENDING) zaproszenie domownika — do listy + ponownego ShareLink.
struct HouseholdInvitation: Decodable, Identifiable {
    let id: Int
    let inviteeName: String
    let relationLabel: String?
    let unitLabel: String?
    let expiresAt: Date
    /// Kto wysłał — zaproszenia są per LOKAL (żona widzi zaproszenia męża).
    let invitedByName: String?
    /// Pełny link akceptacji — ShareLink może go wysłać ponownie z listy.
    let inviteUrl: String?
}

/// GET /resident/household — jeden strzał dla sekcji „Domownicy".
struct HouseholdOverview: Decodable {
    let members: [HouseholdMember]
    let invitations: [HouseholdInvitation]
}

/// POST /resident/household/invitations — świeżo utworzone zaproszenie.
struct HouseholdInviteCreated: Decodable {
    let id: Int
    let inviteeName: String
    let relationLabel: String?
    let unitLabel: String?
    let expiresAt: Date
    let inviteUrl: String
}

/// Payload VoIP push (PushKit) — co iOS dostaje budząc apkę na połączenie.
struct IntercomVoipPayload {
    let sessionId: String
    let intercomName: String
    let unitLabel: String
    let snapshotUrl: String
    /// Czy połączenie ma wideo (gość→mieszkaniec). Steruje CXCallUpdate.hasVideo.
    let hasVideo: Bool

    /// Parsuje słownik z PKPushPayload.dictionaryPayload.
    init?(_ dict: [AnyHashable: Any]) {
        guard let sid = dict["sessionId"] as? String else { return nil }
        self.sessionId = sid
        self.intercomName = (dict["intercomName"] as? String) ?? "Domofon"
        self.unitLabel = (dict["unitLabel"] as? String) ?? ""
        self.snapshotUrl = (dict["snapshotUrl"] as? String) ?? ""
        // Cloud wysyła Bool, ale APNs może zserializować jako 1/"true" — tolerujemy.
        if let b = dict["hasVideo"] as? Bool {
            self.hasVideo = b
        } else if let n = dict["hasVideo"] as? NSNumber {
            self.hasVideo = n.boolValue
        } else {
            self.hasVideo = true
        }
    }
}

