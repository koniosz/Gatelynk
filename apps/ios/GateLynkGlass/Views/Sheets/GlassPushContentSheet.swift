import SwiftUI

// MARK: - Karta do czytania pusha treściowego (2026-08-28)
//
// Zgłoszenie: tap w push (Kronika dnia 21:00 / poranny brief 7:30 /
// przypomnienie o kubłach 19:00) otwierał apkę „donikąd" — treść z bannera
// przepadała. Ta karta pokazuje tytuł + pełny tekst pusha NATYCHMIAST
// (route niesie je z UNNotificationContent), a dla Kroniki dociąga pełną
// wersję dnia z `/resident/assistant/chronicle?smart=0` (deterministyczne
// linie, bez czekania na narrację LLM — ta potrafi mielić 20-40 s).

struct GlassPushContentSheet: View {
    let route: ContentPushRoute
    let onClose: () -> Void

    /// Pełna Kronika z API (tylko kind == evening-chronicle).
    @State private var chronicleLines: [String] = []
    @State private var chronicleLoading = false

    private var kicker: String {
        switch route.kind {
        case "evening-chronicle": return "Kronika dnia"
        case "morning-brief":     return "Poranny brief"
        case "waste-reminder":    return "Przypomnienie"
        default:                  return "Powiadomienie"
        }
    }

    private var icon: String {
        switch route.kind {
        case "evening-chronicle": return "book.pages"
        case "morning-brief":     return "sun.max.fill"
        case "waste-reminder":    return "trash.fill"
        default:                  return "bell.fill"
        }
    }

    /// „środa, 27 sierpnia" z payloadowego `date` (YYYY-MM-DD); nil = bez daty.
    private var dateLabel: String? {
        guard let key = route.dateKey else { return nil }
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        guard let d = parser.date(from: key) else { return nil }
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateFormat = "EEEE, d MMMM"
        return df.string(from: d).capitalized
    }

    var body: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: kicker, title: route.title, onClose: onClose)

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 12) {
                    if let dateLabel {
                        Label(dateLabel, systemImage: "calendar")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.62))
                    }

                    // Treść pusha — zawsze dostępna od razu, bez sieci.
                    bodyCard

                    // Kronika: pełna wersja dnia (wszystkie zdarzenia, nie
                    // tylko top 3 z pusha).
                    if route.kind == "evening-chronicle" {
                        if chronicleLoading {
                            GlassSheetLoading()
                        } else if !chronicleLines.isEmpty {
                            fullChronicleCard
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 8)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .task { await loadChronicleIfNeeded() }
    }

    private var bodyCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(.white.opacity(0.85))
                .frame(width: 40, height: 40)
                .background {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.white.opacity(0.10))
                }

            Text(route.body)
                .font(.system(size: 15, weight: .regular))
                .lineSpacing(4)
                .foregroundStyle(.white.opacity(0.92))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.07))
        }
    }

    private var fullChronicleCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("PEŁNA KRONIKA")
                .font(.system(size: 11, weight: .bold))
                .tracking(1.1)
                .foregroundStyle(.white.opacity(0.55))

            ForEach(Array(chronicleLines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.system(size: 13.5))
                    .lineSpacing(3)
                    .foregroundStyle(.white.opacity(0.85))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color.white.opacity(0.05))
        }
    }

    // MARK: Dane

    private struct ChronicleResponse: Decodable {
        let date: String?
        let lines: [String]
    }

    private func loadChronicleIfNeeded() async {
        guard route.kind == "evening-chronicle" else { return }
        chronicleLoading = true
        // smart=0 — deterministyczne linie w ~50 ms; narracja Bielika bywa
        // wolniejsza niż cierpliwość czytającego. Fail-silent: karta i tak
        // pokazuje treść pusha.
        if let full: ChronicleResponse = try? await APIClient.shared.get(
            "/resident/assistant/chronicle?smart=0"
        ) {
            chronicleLines = full.lines
        }
        chronicleLoading = false
    }
}
