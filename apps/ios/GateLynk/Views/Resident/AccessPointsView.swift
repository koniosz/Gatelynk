import SwiftUI

struct AccessPointsView: View {

    @State private var points: [AccessPoint] = []
    @State private var loading = true
    @State private var error: String?
    @State private var btnState: [Int: RelayState] = [:]

    enum RelayState { case idle, loading, ok, err }

    var body: some View {
        Group {
            if loading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error {
                ContentUnavailableView(
                    error,
                    systemImage: "wifi.exclamationmark",
                    description: Text("Sprawdź połączenie z bramką")
                )
                .onTapGesture { Task { await load() } }
            } else if points.isEmpty {
                ContentUnavailableView(
                    "Brak wejść",
                    systemImage: "door.left.hand.open",
                    description: Text("Administrator nie skonfigurował jeszcze punktów dostępu")
                )
            } else {
                ScrollView {
                    LazyVGrid(
                        columns: [GridItem(.flexible()), GridItem(.flexible())],
                        spacing: 16
                    ) {
                        ForEach(points) { ap in
                            RelayCard(
                                ap: ap,
                                state: btnState[ap.id] ?? .idle
                            ) {
                                Task { await open(ap) }
                            }
                        }
                    }
                    .padding()
                }
                .refreshable { await load() }
            }
        }
        .navigationTitle("Otwórz wejście")
        .navigationBarTitleDisplayMode(.large)
        .task { await load() }
    }

    private func load() async {
        loading = true; error = nil
        do {
            points = try await APIClient.shared.get("/resident/access-points")
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func open(_ ap: AccessPoint) async {
        guard (btnState[ap.id] ?? .idle) == .idle else { return }
        btnState[ap.id] = .loading
        do {
            let _: OpenAccessPointResponse = try await APIClient.shared.post(
                "/resident/access-points/\(ap.id)/open",
                body: EmptyBody()
            )
            btnState[ap.id] = .ok
        } catch {
            btnState[ap.id] = .err
        }
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        btnState[ap.id] = .idle
    }
}

// MARK: - RelayCard

private struct RelayCard: View {
    let ap: AccessPoint
    let state: AccessPointsView.RelayState
    let onTap: () -> Void

    private var sfIcon: String {
        switch ap.icon {
        case "garage":   return "car.fill"
        case "gate":     return "fence.fill"
        case "elevator": return "arrow.up.arrow.down.square.fill"
        case "barrier":  return "stop.fill"
        default:         return "door.sliding.right.hand.open"
        }
    }

    private var accentColor: Color {
        switch ap.icon {
        case "garage":   return .orange
        case "gate":     return .green
        case "elevator": return .purple
        case "barrier":  return .red
        default:         return .blue
        }
    }

    private var btnColor: Color {
        switch state {
        case .ok:  return .green
        case .err: return .red
        default:   return accentColor
        }
    }

    private var btnLabel: String {
        switch state {
        case .ok:  return "Otwarto!"
        case .err: return "Błąd"
        default:   return "Otwórz"
        }
    }

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(accentColor.opacity(0.12))
                    .frame(width: 68, height: 68)
                if state == .loading {
                    ProgressView().tint(accentColor)
                } else if state == .ok {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(.green)
                } else if state == .err {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(.red)
                } else {
                    Image(systemName: sfIcon)
                        .font(.system(size: 28))
                        .foregroundStyle(accentColor)
                }
            }

            Text(ap.label)
                .font(.subheadline).fontWeight(.semibold)
                .multilineTextAlignment(.center)
                .foregroundStyle(.primary)
                .lineLimit(2)
                .frame(minHeight: 38)

            Button(action: onTap) {
                Text(btnLabel)
                    .font(.subheadline).fontWeight(.bold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(btnColor)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .disabled(state != .idle)
            .buttonStyle(.plain)
        }
        .padding(16)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(btnColor.opacity(state == .idle ? 0 : 0.6), lineWidth: 2)
        )
        .animation(.spring(response: 0.3), value: state == .idle)
    }
}

// MARK: - Helpers

private struct EmptyBody: Encodable {}
