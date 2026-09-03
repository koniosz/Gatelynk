import SwiftUI

// AnomalyDetailView — 2026-05-24, Etap 4 fall detection.
//
// Pokazuje pojedynczą anomalię (upadek / przyszły fire / intruder):
//   • JPEG klatki z kamery (pull z Cloud proxy `/api/resident/anomaly-events/:id/image`)
//   • metadane (czas, likelihood %, indicators, kamera)
//   • dla mieszkańca: tylko READ + przycisk "Zadzwoń 112" (skrót systemowy)
//   • Building Admin / Concierge w przyszłości: "Obsłużone" / "Fałszywy alarm"
//     (dziś nieudostępnione z konta mieszkańca)
struct AnomalyDetailView: View {
    let event: AnomalyEvent
    @Environment(\.dismiss) private var dismiss

    @State private var imageData: Data?
    @State private var imageError: String?
    @State private var loadingImage = true

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    headerCard
                    imageCard
                    metadataCard
                    indicatorsCard
                    safetyCard
                }
                .padding()
            }
            .navigationTitle("Alert bezpieczeństwa")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Zamknij") { dismiss() }
                }
            }
            .task { await loadImage() }
        }
    }

    // MARK: – Header (czerwony pasek z typem + likelihood)
    private var headerCard: some View {
        HStack(spacing: 14) {
            Image(systemName: event.typeIcon)
                .font(.system(size: 36, weight: .semibold))
                .foregroundColor(.white)
                .frame(width: 56, height: 56)
                .background(Color.red.gradient, in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                Text(event.typeLabel)
                    .font(.title3.bold())
                Text("Prawdopodobieństwo: \(event.likelihoodPercent)%")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                if event.falsePositive {
                    Text("Oznaczone jako fałszywy alarm")
                        .font(.caption.bold())
                        .foregroundColor(.green)
                } else if event.isResolved {
                    Text("Obsłużone")
                        .font(.caption.bold())
                        .foregroundColor(.blue)
                }
            }
            Spacer()
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color.red.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(Color.red.opacity(0.3), lineWidth: 1)
                )
        )
    }

    // MARK: – Klatka z kamery
    @ViewBuilder
    private var imageCard: some View {
        if event.hasImage {
            VStack(alignment: .leading, spacing: 8) {
                Text("Klatka z kamery")
                    .font(.headline)
                ZStack {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color.gray.opacity(0.15))
                        .aspectRatio(16/9, contentMode: .fit)
                    if loadingImage {
                        ProgressView()
                    } else if let data = imageData, let ui = UIImage(data: data) {
                        Image(uiImage: ui)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "photo.badge.exclamationmark")
                                .font(.system(size: 36))
                                .foregroundColor(.secondary)
                            Text(imageError ?? "Klatka niedostępna")
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
        }
    }

    // MARK: – Metadane
    private var metadataCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Szczegóły")
                .font(.headline)
            row(label: "Czas wykrycia", value: formatTime(event.tsDate))
            row(label: "Kamera", value: cameraShort(event.cameraDeviceId))
            row(label: "Typ zdarzenia", value: event.typeLabel)
            row(label: "Pewność algorytmu", value: "\(event.likelihoodPercent)%")
        }
        .padding()
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.gray.opacity(0.06)))
    }

    @ViewBuilder
    private var indicatorsCard: some View {
        if !event.indicators.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Wykryte wskaźniki")
                    .font(.headline)
                Text("Algorytm porównuje 4 oznaki: kształt sylwetki, pozycja głowy względem bioder, kąt ramion, miejsce w kadrze. Im więcej wskaźników jednocześnie, tym większa pewność.")
                    .font(.caption)
                    .foregroundColor(.secondary)
                ForEach(event.indicators, id: \.self) { ind in
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.orange)
                        Text(indicatorLabel(ind))
                            .font(.subheadline)
                    }
                }
            }
            .padding()
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.gray.opacity(0.06)))
        }
    }

    // MARK: – Akcje bezpieczeństwa
    private var safetyCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Co zrobić?")
                .font(.headline)
            Text("System wczesnego ostrzegania nie zastępuje numeru 112. Sprawdź sytuację i, jeśli widzisz, że potrzebna pomoc — zadzwoń.")
                .font(.subheadline)
                .foregroundColor(.secondary)

            Link(destination: URL(string: "tel://112")!) {
                HStack {
                    Image(systemName: "phone.fill")
                    Text("Zadzwoń 112")
                        .fontWeight(.semibold)
                }
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color.red, in: RoundedRectangle(cornerRadius: 12))
            }

            Text("Możesz też skontaktować się z konsjerżem budynku jeśli widzisz problem w częściach wspólnych.")
                .font(.footnote)
                .foregroundColor(.secondary)
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.orange.opacity(0.05))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.orange.opacity(0.2), lineWidth: 1)
                )
        )
    }

    // MARK: – Helpers

    private func row(label: String, value: String) -> some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.subheadline)
                .foregroundColor(.secondary)
                .frame(width: 130, alignment: .leading)
            Text(value)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func formatTime(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "pl_PL")
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: d)
    }

    private func cameraShort(_ uuid: String) -> String {
        if uuid.count > 12 { return String(uuid.prefix(8)) + "…" }
        return uuid
    }

    private func indicatorLabel(_ key: String) -> String {
        switch key {
        case "horizontal_bbox": return "Sylwetka pozioma (osoba leży)"
        case "head_below_hips": return "Głowa poniżej bioder"
        case "vertical_shoulders": return "Pionowy układ ramion"
        case "low_in_frame": return "Niska pozycja w kadrze"
        default: return key.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private func loadImage() async {
        guard event.hasImage else {
            loadingImage = false
            return
        }
        do {
            let data = try await APIClient.shared.getRawData(
                "/resident/anomaly-events/\(event.id)/image"
            )
            imageData = data
        } catch {
            imageError = "Nie udało się pobrać obrazu"
        }
        loadingImage = false
    }
}
