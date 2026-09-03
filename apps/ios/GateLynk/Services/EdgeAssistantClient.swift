import Foundation

// MARK: - Edge Assistant API client (2026-05-19 — przepisane na Cloud-proxy)
//
// Aplikacja iOS NIE łączy się bezpośrednio z Edge w LAN/Tailscale.
// Wszystkie zapytania idą przez Cloud HTTPS z JWT auth:
//
//   iOS (anywhere, internet)
//     → POST https://api.gatelynk.com/api/resident/assistant/ask
//     → Cloud forwards via Tailscale do Edge na Mac Mini :4000
//     → Edge proxy do Python prototype :8000
//     → response back
//
// Auth: JWT bearer z KeychainHelper — ten sam token co APIClient (login resident).
// Cloud guard `jwt-resident` resolves buildingId z JWT — wie który Edge wywołać.
//
// Smart mode: ~7s LLM-shaped natural answer. Fast mode: ~10-700ms template.

enum EdgeAssistantError: Error, LocalizedError {
    case invalidURL
    case unauthorized
    case httpError(Int, String)
    case decodingError(Error)
    case networkError(Error)
    case timeout
    case edgeUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidURL:        return "Nieprawidłowy adres serwera"
        case .unauthorized:      return "Brak autoryzacji — zaloguj się ponownie"
        case .httpError(let c, let m): return "Serwer zwrócił błąd \(c): \(m)"
        case .decodingError:     return "Nie udało się zdekodować odpowiedzi"
        case .networkError(let e): return e.localizedDescription
        case .timeout:           return "Asystent nie odpowiedział w 60 s"
        case .edgeUnavailable:   return "Asystent niedostępny — Edge tego budynku jest offline"
        }
    }
}

// MARK: - Request / response models

/// One conversation turn — last N są wysyłane razem z każdym pytaniem
/// żeby prototyp rozwiązał zaimki/elipsy ("A jego mail?" → "Email Janusza").
struct AssistantHistoryTurn: Encodable {
    let role: String  // "user" | "assistant"
    let content: String
}

struct AssistantRequest: Encodable {
    let question: String
    let smart: Bool
    /// Tail-trimmed historia rozmowy (max 6-8 ostatnich tur). Pomijamy gdy
    /// pusto — backend rozumie brak pola jako stateless tryb (pre-multi-turn).
    let history: [AssistantHistoryTurn]?
}

/// Mirror of Cloud `/resident/assistant/ask` response (identyczny shape jak Edge).
struct AssistantResponse: Decodable {
    let answer: String
    let intent: String?
    let parameters: [String: AnyCodableValue]?
    let totalMs: Int?
    let followUps: [String]?
    let modelUsed: String?
    let data: AnyCodableValue?
    /// Gdy prototyp przepisał pytanie używając historii — oryginał (z requestu)
    /// vs rewritten. UI może to pokazać jako tooltip/badge.
    let rewrittenQuestion: String?
}

// MARK: - Generic JSON value
//
// Tiny `AnyCodable`-style holder dla `parameters` i `data` (free-form JSON
// per intent — nie chce tworzyć typowanego struct per każdy intent).

enum AnyCodableValue: Decodable, Encodable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([AnyCodableValue])
    case object([String: AnyCodableValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self)   { self = .bool(v);   return }
        if let v = try? c.decode(Int.self)    { self = .int(v);    return }
        if let v = try? c.decode(Double.self) { self = .double(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([AnyCodableValue].self)        { self = .array(v);  return }
        if let v = try? c.decode([String: AnyCodableValue].self) { self = .object(v); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unknown JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null:           try c.encodeNil()
        case .bool(let v):    try c.encode(v)
        case .int(let v):     try c.encode(v)
        case .double(let v):  try c.encode(v)
        case .string(let v):  try c.encode(v)
        case .array(let v):   try c.encode(v)
        case .object(let v):  try c.encode(v)
        }
    }

    var displayString: String {
        switch self {
        case .null:           return "—"
        case .bool(let v):    return v ? "tak" : "nie"
        case .int(let v):     return String(v)
        case .double(let v):  return String(v)
        case .string(let v):  return v
        case .array(let v):   return v.map(\.displayString).joined(separator: ", ")
        case .object(let v):  return v.map { "\($0.key)=\($0.value.displayString)" }.joined(separator: ", ")
        }
    }
}

// MARK: - Client

final class EdgeAssistantClient {
    static let shared = EdgeAssistantClient()

    /// Ten sam pattern jak APIClient — DEBUG default → produkcja na Fly.io
    /// (działa OOTB z fizycznego iPhone-a). Override przez env var `API_URL`
    /// w Xcode Scheme dla lokalnego dev (symulator: localhost, fizyczny iPhone
    /// w LAN: IP Maca). Release build: zawsze produkcja.
    #if DEBUG
    private var baseURL: String {
        ProcessInfo.processInfo.environment["API_URL"]
            ?? "https://api.gatelynk.com/api"
    }
    #else
    private let baseURL = "https://api.gatelynk.com/api"
    #endif

    /// JWT z Keychain (ten sam co APIClient — zapisywany po loginie resident).
    private var token: String? {
        KeychainHelper.load(forKey: KeychainHelper.tokenKey)
    }

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        // Smart mode (LLM cold-start) bywa ~10s, gen do 60s tolerujemy.
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 120
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - Public API

    /// POST /api/resident/assistant/ask
    ///
    /// - Parameters:
    ///   - question: pytanie użytkownika (max 500 chars walidowane backend-side)
    ///   - smart: true = LLM natural answer + follow-ups (~7s), false = template (~10ms)
    ///   - history: ostatnie tury rozmowy (klient powinien wysłać max ~6).
    ///     Backend tail-trim-uje do 12, prototype LLM rewrite tail-trim do 4.
    ///     Pusto / nil = stateless tryb.
    func ask(
        _ question: String,
        smart: Bool,
        history: [AssistantHistoryTurn] = [],
    ) async throws -> AssistantResponse {
        guard let url = URL(string: baseURL + "/resident/assistant/ask") else {
            throw EdgeAssistantError.invalidURL
        }
        guard let token = token else { throw EdgeAssistantError.unauthorized }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try encoder.encode(AssistantRequest(
            question: question,
            smart: smart,
            history: history.isEmpty ? nil : history,
        ))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError where e.code == .timedOut {
            throw EdgeAssistantError.timeout
        } catch {
            throw EdgeAssistantError.networkError(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw EdgeAssistantError.networkError(URLError(.badServerResponse))
        }
        switch http.statusCode {
        case 200..<300:
            break
        case 401:
            throw EdgeAssistantError.unauthorized
        case 503:
            // Cloud zwraca 503 gdy Edge budynku jest offline / brak ipAddress.
            throw EdgeAssistantError.edgeUnavailable
        default:
            let body = String(data: data, encoding: .utf8) ?? ""
            throw EdgeAssistantError.httpError(http.statusCode, body)
        }

        do {
            return try decoder.decode(AssistantResponse.self, from: data)
        } catch {
            throw EdgeAssistantError.decodingError(error)
        }
    }
}
