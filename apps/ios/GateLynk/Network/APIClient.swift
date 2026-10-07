import Foundation

enum APIError: Error, LocalizedError {
    case invalidURL
    case httpError(Int, String)
    case decodingError(Error)
    case networkError(Error)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Nieprawidłowy URL"
        case .httpError(let code, let msg): return "Błąd \(code): \(msg)"
        case .decodingError: return "Błąd dekodowania odpowiedzi"
        case .networkError(let e): return e.localizedDescription
        case .unauthorized: return "Brak autoryzacji"
        }
    }
}

final class APIClient {
    static let shared = APIClient()

    // Debug build (Xcode → Run): DEFAULT → produkcja na Fly.io. Działa OOTB
    // z fizycznego iPhone-a podłączonego przez kabel bez konfiguracji
    // (wcześniej default = localhost:3000 powodował „Could not connect to
    // server" bo fizyczny iPhone próbował połączyć się ze swoim portem 3000).
    //
    // OVERRIDE dla lokalnego dev: ustaw env var `API_URL` w Xcode Scheme
    // (Edit Scheme → Run → Arguments → Environment Variables):
    //   • Symulator: API_URL = http://localhost:3000/api
    //   • Fizyczny iPhone w tej samej sieci LAN: API_URL = http://192.168.1.X:3000/api
    //     (gdzie X = IP Twojego Maca; sprawdź: ipconfig getifaddr en0)
    //
    // Release build (TestFlight, App Store): zawsze produkcja.
    #if DEBUG
    var baseURL = ProcessInfo.processInfo.environment["API_URL"]
        ?? "https://api.gatelynk.com/api"
    #else
    var baseURL = "https://api.gatelynk.com/api"
    #endif

    private var token: String? { KeychainHelper.load(forKey: KeychainHelper.tokenKey) }

    private func request<T: Decodable>(
        path: String,
        method: String = "GET",
        body: Encodable? = nil,
        authenticated: Bool = true
    ) async throws -> T {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authenticated, let token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = try JSONEncoder().encode(body)
        }

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.networkError(URLError(.badServerResponse)) }

        if http.statusCode == 401 { throw APIError.unauthorized }
        if !(200..<300).contains(http.statusCode) {
            // NestJS standard error: { statusCode, message, error }, gdzie
            // `message` to string albo tablica stringów (z ValidationPipe).
            // Próbujemy oba kształty + raw body fallback.
            let msg: String
            if let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let arr = dict["message"] as? [String] {
                    msg = arr.joined(separator: "; ")
                } else if let s = dict["message"] as? String {
                    msg = s
                } else if let s = String(data: data, encoding: .utf8), !s.isEmpty {
                    msg = s
                } else {
                    msg = HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
                }
            } else if let s = String(data: data, encoding: .utf8), !s.isEmpty {
                msg = s
            } else {
                msg = HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            }
            throw APIError.httpError(http.statusCode, msg)
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let str = try container.decode(String.self)
            // Try with fractional seconds first (Prisma returns "2024-01-15T10:30:00.000Z")
            let withMs = ISO8601DateFormatter()
            withMs.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = withMs.date(from: str) { return date }
            // Fallback: plain ISO8601
            let plain = ISO8601DateFormatter()
            if let date = plain.date(from: str) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Cannot parse date: \(str)")
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    func get<T: Decodable>(_ path: String, authenticated: Bool = true) async throws -> T {
        try await request(path: path, method: "GET", authenticated: authenticated)
    }

    func post<T: Decodable>(_ path: String, body: Encodable, authenticated: Bool = true) async throws -> T {
        try await request(path: path, method: "POST", body: body, authenticated: authenticated)
    }

    func patch<T: Decodable>(_ path: String, body: Encodable) async throws -> T {
        try await request(path: path, method: "PATCH", body: body)
    }

    func delete<T: Decodable>(_ path: String) async throws -> T {
        try await request(path: path, method: "DELETE")
    }

    /// Fetches raw binary data (e.g. JPEG snapshot) — no JSON decoding.
    /// `timeout` — dla odpytywania w pętli (podgląd kamery): domyślne 60 s
    /// URLSession potrafi zawiesić pętlę na minutę, gdy pierwsze żądanie po
    /// starcie/powrocie apki trafi na martwe połączenie.
    func getRawData(_ path: String, timeout: TimeInterval? = nil) async throws -> Data {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        if let timeout { req.timeoutInterval = timeout }
        if let token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.networkError(URLError(.badServerResponse))
        }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if !(200..<300).contains(http.statusCode) {
            throw APIError.httpError(http.statusCode, HTTPURLResponse.localizedString(forStatusCode: http.statusCode))
        }
        return data
    }
}
