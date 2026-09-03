import AppIntents
import Foundation

// MARK: - App Intents / Siri (2026-07-16) — „Otwórz wjazd w GateLynk"
//
// Krok 1 planu CarPlay: otwieranie wejść głosem przez Siri — działa też
// w samochodzie (Siri w CarPlay), BEZ żadnych entitlementów od Apple.
// Krok 2 (właściwa apka CarPlay „Driving Task" z przyciskami na ekranie
// auta) wymaga entitlementu — wniosek: docs/carplay-entitlement-request.md.
//
// Architektura:
//   • GlassEntranceEntity — punkt dostępu jako AppEntity; lista z cache
//     w UserDefaults (GlassEntranceStore), odświeżana przy każdym loadAll
//     w GlassHomeView. Dzięki temu Siri zna nazwy („Wjazd", „Wyjazd")
//     bez uruchamiania apki.
//   • OpenEntranceIntent — otwiera przez istniejące
//     POST /resident/access-points/:id/open (APIClient, token z Keychain).
//   • Bramy POŻAROWE wykluczone — otwarcie ma wymagać świadomego
//     potwierdzenia w UI, nie komendy głosowej.
//
// Fraza Siri MUSI zawierać nazwę apki: „Otwórz wjazd w GateLynk".
// Display name to „GateLynk" (docelowa nazwa App Store, decyzja 2026-07-16);
// INAlternativeAppNames w Info.plist niesie podpowiedź wymowy dla Siri PL.

/// Cache punktów dostępu dla intentów + sync fraz App Shortcuts.
enum GlassEntranceStore {
    private static let key = "siriEntrancesCache"

    struct Entry: Codable {
        let id: Int
        let label: String
    }

    /// Wołane z GlassHomeView.loadAll po pobraniu punktów dostępu.
    static func save(_ accessPoints: [AccessPoint]) {
        let entries = accessPoints
            .filter { !GlassGateSheet.isFireGate($0) }
            .map { Entry(id: $0.id, label: $0.label) }
        if let data = try? JSONEncoder().encode(entries) {
            UserDefaults.standard.set(data, forKey: key)
        }
        // Siri uczy się wartości parametru („Wjazd"/„Wyjazd") z tego sync-a.
        Task { await GlassAppShortcuts.updateAppShortcutParameters() }
    }

    static func load() -> [Entry] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let entries = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return entries
    }
}

struct GlassEntranceEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Wejście")
    static var defaultQuery = GlassEntranceQuery()

    let id: Int
    let label: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(label)")
    }
}

struct GlassEntranceQuery: EntityQuery {
    func entities(for identifiers: [Int]) async throws -> [GlassEntranceEntity] {
        GlassEntranceStore.load()
            .filter { identifiers.contains($0.id) }
            .map { GlassEntranceEntity(id: $0.id, label: $0.label) }
    }

    func suggestedEntities() async throws -> [GlassEntranceEntity] {
        GlassEntranceStore.load().map { GlassEntranceEntity(id: $0.id, label: $0.label) }
    }
}

struct OpenEntranceIntent: AppIntent {
    static var title: LocalizedStringResource = "Otwórz wejście"
    static var description = IntentDescription(
        "Otwiera wybraną bramę lub szlaban na osiedlu."
    )
    /// Działa w tle, bez otwierania apki — kluczowe dla użycia w aucie.
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Wejście")
    var entrance: GlassEntranceEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Otwórz \(\.$entrance)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        do {
            let r: OpenAccessPointResponse = try await APIClient.shared.post(
                "/resident/access-points/\(entrance.id)/open",
                body: GlassEmptyBody()
            )
            if r.success {
                return .result(dialog: "Otwieram — \(entrance.label).")
            }
            return .result(dialog: "Nie udało się otworzyć wejścia \(entrance.label).")
        } catch {
            return .result(dialog: "Nie udało się otworzyć — sprawdź aplikację GateLynk.")
        }
    }
}

struct GlassAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenEntranceIntent(),
            phrases: [
                "Otwórz \(\.$entrance) w \(.applicationName)",
                "Otwórz bramę w \(.applicationName)",
                "Open \(\.$entrance) in \(.applicationName)",
            ],
            shortTitle: "Otwórz wejście",
            systemImageName: "car.fill"
        )
    }
}
