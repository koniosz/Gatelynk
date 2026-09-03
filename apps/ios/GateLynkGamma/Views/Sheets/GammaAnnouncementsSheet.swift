import SwiftUI

// MARK: - Sheet Ogłoszenia
//
// GET /resident/notifications → [AppNotification]. Wiersze z orbami
// w kolorach cyklicznych (jak prototyp: woda, śmieci, zebranie, nasadzenia).

struct GammaAnnouncementsSheet: View {
    let onClose: () -> Void

    @State private var notifications: [AppNotification] = []
    @State private var loading = true

    private static let orbPalette: [[Color]] = [
        [GammaColor.orbBlue1, GammaColor.orbBlue2],
        [Color(red: 139/255, green: 154/255, blue: 107/255), Color(red: 90/255, green: 107/255, blue: 69/255)],
        [GammaColor.accentLight, GammaColor.accentBlue],
        [GammaColor.orbAmber1, GammaColor.orbAmber2],
    ]

    var body: some View {
        VStack(spacing: 9) {
            GammaSheetHeader(kicker: "Ogłoszenia", title: "Z życia osiedla", onClose: onClose)

            if loading {
                GammaSheetLoading()
            } else if notifications.isEmpty {
                GammaSheetEmptyState(
                    icon: "megaphone",
                    text: "Brak ogłoszeń — cisza na osiedlu."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(Array(notifications.prefix(20).enumerated()), id: \.element.id) { idx, n in
                            row(n, index: idx)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .task { await load() }
    }

    private func row(_ n: AppNotification, index: Int) -> some View {
        GammaActionRow(
            orbGradient: Self.orbPalette[index % Self.orbPalette.count],
            orbIcon: "megaphone.fill",
            title: n.title,
            subtitle: GammaFormat.relative.localizedString(for: n.sentAt, relativeTo: Date()),
            dimmed: index > 4,
            trailing: { EmptyView() },
            extra: {
                if !n.body.isEmpty {
                    Text(n.body)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(3)
                        .padding(.top, 3)
                }
            }
        )
    }

    private func load() async {
        if let n: [AppNotification] = try? await APIClient.shared.get("/resident/notifications") {
            notifications = n
        }
        loading = false
    }
}
