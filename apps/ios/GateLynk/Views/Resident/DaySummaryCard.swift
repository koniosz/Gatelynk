import SwiftUI

// MARK: - DaySummaryCard (Faza 8.h.17 + 8.h.18 — 2026-06-09)
//
// Card z dwoma sekcjami generowanymi przez Bielika na Edge AI prototype:
//   • Co dziś się wydarzy (predictions) — harmonogramy + planowane przerwy
//   • Co dziś się działo (recap) — aktywność (LPR + vision) z ostatnich 24h.
//
// Endpoint: GET /resident/assistant/day-summary
//   → { predictions: { text, source }, recap: { text, source },
//       generatedAt, fromCache, stale? }
//
// FAZA 8.h.18 — background refresh + typewriter UX:
//   1. Persistent cache w `@AppStorage` (UserDefaults JSON) — przy reopen
//      HomeView pokazujemy ostatni wynik INSTANT (zero spinner).
//   2. Async fetch w tle natychmiast po pokazaniu cache → fresh data zastępuje
//      cache gdy przyjdzie (zwykle <3s, ale nawet jeśli 30s — user już widzi
//      treść).
//   3. Timer.publish co 5 min while-foreground → odświeża cache w tle,
//      kolejne otwarcie HomeView dostaje świeże dane bez czekania.
//   4. TypewriterText (40 chars/sec) gdy treść jest NOWA (różna od cached).
//      Po reopen-ie — instant render z cache (bez typewriter-a, bo user już
//      to widział). Sekwencyjnie: predictions najpierw, recap po jego końcu.

struct DaySummaryCard: View {
    @Environment(\.colorScheme) private var scheme

    @State private var predictions: SectionState = .loading
    @State private var recap: SectionState = .loading
    @State private var generatedAt: Date?
    @State private var isRefreshing = false
    @State private var isStale = false
    @State private var predictionsDone = false
    @State private var animatePredictions = false
    @State private var animateRecap = false

    /// Persistent cache w UserDefaults — JSON string. Klucz osobny per user
    /// nie jest konieczny bo treść jest non-PII (planowane odbiory osiedla).
    @AppStorage("daySummaryCache") private var daySummaryCacheRaw: String = ""

    /// Co 5 min wymuszamy in-background refresh. iOS dorzuca timer-a do RunLoop
    /// głównej app-i, wyłącza go gdy view znika z hierarchii (auto-cleanup).
    private let refreshInterval: TimeInterval = 300

    private enum SectionState: Equatable {
        case loading
        case text(String)
        case error
    }

    /// DTO dla persistent cache — minimalna kopia tego co user już widział.
    private struct PersistedSummary: Codable {
        let predictionsText: String
        let recapText: String
        let generatedAtIso: String?
        let cachedAt: TimeInterval
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header

            section(
                title: "Co dziś się wydarzy",
                systemIcon: "calendar.badge.clock",
                tint: GLColor.accent300(scheme),
                state: predictions,
                animate: animatePredictions,
                onCompleted: { predictionsDone = true },
            )

            divider

            section(
                title: "Podsumowanie by Lynx",
                // 2026-06-10: Lynx brand — ikona "oka" (eye) zgodnie z badge
                // na stronie WWW. SF Symbol `eye` outline ma 2 łuki przypominające
                // brwi nad źrenicą, najbardziej zbliżone do brand-logo Lynx.
                systemIcon: "eye",
                tint: GLColor.info(scheme),
                state: recap,
                // Recap typewriter startuje DOPIERO gdy predictions się
                // skończył (sequential) — wygląda jak rozmowa Claude/ChatGPT,
                // gdzie kolejne sekcje pojawiają się jedna po drugiej.
                animate: animateRecap && predictionsDone,
            )

            if let generatedAt {
                Text(footerText(from: generatedAt))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
            }
        }
        .padding(16)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: GLRadius.lg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: GLRadius.lg, style: .continuous)
                .stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
        )
        .glShadow(.sm)
        .task {
            // 1. Natychmiast pokaż cache jeśli mamy (instant render).
            applyPersistentCache()
            // 2. Async fetch z servera — zastąpi cache fresh-iem.
            await load(refresh: false)
        }
        // 3. While-foreground polling co 5 min — przy każdym ticku odpalamy
        // load w tle. Cache server-side trzyma 30 min więc realnie pierwszy
        // hit po deployu/cache-evict trafi LLM, pozostałe to ~30ms cache hit.
        .task(id: refreshInterval) {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(refreshInterval * 1_000_000_000))
                if Task.isCancelled { return }
                await load(refresh: false, silent: true)
            }
        }
    }

    // MARK: - Subviews

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(
                    LinearGradient(
                        colors: [GLColor.accent300(scheme), GLColor.accent400(scheme)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing,
                    ),
                )
            Text("GateLynk AI")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(GLColor.textTertiary(scheme))
            Spacer()
            if isRefreshing {
                ProgressView()
                    .scaleEffect(0.7)
            } else {
                Button {
                    Task { await load(refresh: true) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Odśwież podsumowanie")
            }
        }
    }

    @ViewBuilder
    private func section(
        title: String,
        systemIcon: String,
        tint: Color,
        state: SectionState,
        animate: Bool,
        onCompleted: (() -> Void)? = nil,
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: systemIcon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 18)
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(GLColor.textPrimary(scheme))
            }

            switch state {
            case .loading:
                // Skeleton — 2 linie placeholderu
                VStack(alignment: .leading, spacing: 6) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(GLColor.bg3(scheme))
                        .frame(height: 12)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(GLColor.bg3(scheme))
                        .frame(height: 12)
                        .frame(maxWidth: 220, alignment: .leading)
                }
                .redacted(reason: .placeholder)
            case .text(let body):
                TypewriterText(
                    fullText: body,
                    charsPerSecond: 40,
                    animate: animate,
                    foregroundStyle: GLColor.textPrimary(scheme),
                    onCompleted: onCompleted,
                )
            case .error:
                Text("Nie udało się pobrać tej sekcji.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(GLColor.borderSubtle(scheme))
            .frame(height: 1)
    }

    private func footerText(from date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        let prefix = isStale ? "Dane offline · " : "Wygenerowano "
        if interval < 60 { return prefix + "przed chwilą" }
        if interval < 3600 { return prefix + "\(Int(interval/60)) min temu" }
        if interval < 86400 { return prefix + "\(Int(interval/3600))h temu" }
        return prefix + "wcześniej"
    }

    // MARK: - Cache

    /// Wczytuje persistent cache PRZED pierwszym network call. Jeśli mamy
    /// dane sprzed <2h → pokazujemy je instant (zero spinnera). Starsze
    /// niż 2h pomijamy — lepiej skeleton niż nieaktualny snapshot.
    private func applyPersistentCache() {
        guard !daySummaryCacheRaw.isEmpty,
              let data = daySummaryCacheRaw.data(using: .utf8),
              let cached = try? JSONDecoder().decode(PersistedSummary.self, from: data) else {
            return
        }
        let age = Date().timeIntervalSince1970 - cached.cachedAt
        guard age < 2 * 3600 else { return }

        // Cache hit: instant render bez animacji (user już to widział).
        if !cached.predictionsText.isEmpty {
            predictions = .text(cached.predictionsText)
        }
        if !cached.recapText.isEmpty {
            recap = .text(cached.recapText)
        }
        if let iso = cached.generatedAtIso {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            generatedAt = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        }
        // FAZA 8.h.20 (2026-06-11) — typewriter RÓWNIEŻ dla cached content.
        // Decyzja UX (Konrad): przy każdym otwarciu aplikacji podsumowanie
        // ma się "pisać" litera po literze jak w ChatGPT — nawet gdy treść
        // pochodzi z cache (Edge generuje w tle co 20 min, więc treść jest
        // zawsze gotowa natychmiast; animacja to czysty efekt prezentacji,
        // nie maskowanie latencji).
        animatePredictions = true
        animateRecap = true
        predictionsDone = false
    }

    /// Zapisuje aktualne sekcje do UserDefaults — wywoływane po każdym
    /// udanym network responseu (fresh ALBO server-side stale).
    private func persistCurrentToCache() {
        let predText: String = {
            if case .text(let t) = predictions { return t }
            return ""
        }()
        let recapText: String = {
            if case .text(let t) = recap { return t }
            return ""
        }()
        // Brak treści → nic do zapisu (defensywnie).
        guard !predText.isEmpty || !recapText.isEmpty else { return }

        let iso: String? = {
            if let d = generatedAt {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return f.string(from: d)
            }
            return nil
        }()
        let payload = PersistedSummary(
            predictionsText: predText,
            recapText: recapText,
            generatedAtIso: iso,
            cachedAt: Date().timeIntervalSince1970,
        )
        if let data = try? JSONEncoder().encode(payload),
           let str = String(data: data, encoding: .utf8) {
            daySummaryCacheRaw = str
        }
    }

    // MARK: - Networking

    /// Public entry point — HomeView wywołuje przy pull-to-refresh.
    func refresh() async {
        await load(refresh: true)
    }

    /// `silent=true` — refresh w tle (polling co 5 min) NIE pokazuje spinnera
    /// żeby user nie widział losowo migającego loading state-a podczas scroll-a.
    private func load(refresh: Bool, silent: Bool = false) async {
        if !silent {
            if predictions == .loading && recap == .loading {
                // już skeleton, nic do roboty
            } else if refresh {
                isRefreshing = true
            }
        }
        defer { isRefreshing = false }

        let path = refresh
            ? "/resident/assistant/day-summary?refresh=1"
            : "/resident/assistant/day-summary"

        do {
            let resp: DaySummaryResponse = try await APIClient.shared.get(path)

            // Wykryj czy treść się ZMIENIŁA względem tego co user widzi —
            // jeśli tak, animuj typewriter; jeśli to samo (cache hit
            // server-side po prostu zwrócił to co już mamy), instant render.
            let predChanged: Bool = {
                if case .text(let cur) = predictions { return cur != resp.predictions.text }
                return true  // było loading/error → traktuj jako nowy content
            }()
            let recapChanged: Bool = {
                if case .text(let cur) = recap { return cur != resp.recap.text }
                return true
            }()

            if !resp.predictions.text.isEmpty {
                predictions = .text(resp.predictions.text)
                animatePredictions = predChanged
            } else {
                predictions = .error
                animatePredictions = false
            }
            if !resp.recap.text.isEmpty {
                recap = .text(resp.recap.text)
                animateRecap = recapChanged
            } else {
                recap = .error
                animateRecap = false
            }
            // Predictions->recap sequential: reset done flag tylko gdy
            // typewriter ma się odpalić od nowa.
            if animatePredictions {
                predictionsDone = false
            } else {
                predictionsDone = true
            }

            if let iso = resp.generatedAt {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                generatedAt = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
            }
            isStale = resp.stale ?? false

            // Persist do UserDefaults — następne otwarcie HomeView → instant.
            persistCurrentToCache()
        } catch {
            // Zostaw poprzednią treść jeśli istniała; placeholder jeśli pierwszy load.
            if case .loading = predictions { predictions = .error }
            if case .loading = recap { recap = .error }
        }
    }
}
