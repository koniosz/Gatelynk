import SwiftUI

struct BlackHomeHeader: View {
    let propertyName: String
    let title: String?
    let compact: Bool
    let onProperty: () -> Void
    let onAccount: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onProperty) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(propertyName.uppercased())
                            .font(.system(size: 11, weight: .medium))
                            .tracking(1.7)
                            .lineLimit(1)
                        BlackIcon(name: "chevron-down", size: 13)
                    }
                    .foregroundStyle(Color(hex: 0xB4B0C0))
                    if let title {
                        Text(title)
                            .font(BlackTheme.heading(29))
                            .foregroundStyle(BlackTheme.text)
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Nieruchomość: \(propertyName)")
            .accessibilityHint("Zmień nieruchomość")

            Button(action: onAccount) {
                BlackIcon(name: "user-round", size: 19)
                    .foregroundStyle(BlackTheme.accent)
                    .frame(width: 44, height: 44)
                    .background(BlackTheme.accent.opacity(0.05), in: Circle())
                    .overlay(Circle().strokeBorder(BlackTheme.accent.opacity(0.17), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Konto i ustawienia")
        }
        .padding(.horizontal, 20)
        .padding(.top, 3)
        .padding(.bottom, 10)
        .frame(minHeight: title == nil ? 58 : compact ? 72 : 78)
        .background(BlackTheme.background.opacity(0.96))
    }
}

enum BlackModule: String, CaseIterable, Identifiable {
    case vehicles, guests, payments, tickets, parcels, announcements
    var id: Self { self }
    var title: String {
        switch self {
        case .vehicles: "Pojazdy"
        case .guests: "Goście"
        case .payments: "Płatności"
        case .tickets: "Zgłoszenia"
        case .parcels: "Przesyłki"
        case .announcements: "Ogłoszenia"
        }
    }
    var icon: String {
        switch self {
        case .vehicles: "car-front"
        case .guests: "users-round"
        case .payments: "credit-card"
        case .tickets: "wrench"
        case .parcels: "package"
        case .announcements: "megaphone"
        }
    }
    var color: Color {
        switch self {
        case .vehicles, .announcements: Color(hex: 0xC2A0FF)
        case .guests: Color(hex: 0x70E1DD)
        case .payments: BlackTheme.coral
        case .tickets: BlackTheme.amber
        case .parcels: BlackTheme.blue
        }
    }
    var tint: Color {
        switch self {
        case .vehicles, .announcements: Color(hex: 0x3D2E59)
        case .guests: Color(hex: 0x1B454C)
        case .payments: Color(hex: 0x592C3B)
        case .tickets: Color(hex: 0x4B381F)
        case .parcels: Color(hex: 0x253B5B)
        }
    }
    var sheet: GlassSheetKind {
        switch self {
        case .vehicles: .vehicles
        case .guests: .guests
        case .payments: .payments
        case .tickets: .tickets
        case .parcels: .parcels
        case .announcements: .announcements
        }
    }
}

struct BlackShortcutGrid: View {
    let modules: [BlackModule]
    var summaries: [BlackModule: String] = [:]
    let onSelect: (BlackModule) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption) private var labelSize = 11.0

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: dynamicTypeSize.isAccessibilitySize ? 2 : 3), spacing: 8) {
            ForEach(modules) { module in
                Button { onSelect(module) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        BlackIcon(name: module.icon, size: 17)
                            .foregroundStyle(module.color)
                            .frame(width: 28, height: 28)
                            .background(module.tint, in: Circle())
                            .overlay(Circle().strokeBorder(.white.opacity(0.08), lineWidth: 1))
                        Text(module.title)
                            .font(.system(size: labelSize))
                            .foregroundStyle(Color(hex: 0xE8E7EE))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, minHeight: 51, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(Color(hex: 0x1B1C23), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.055), lineWidth: 1))
                    .contentShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(module.title)
                .accessibilityValue(summaries[module] ?? "")
            }
        }
    }
}

struct BlackContextNotice: View {
    let title: String
    let detail: String
    var icon: String = "package-check"
    var tint: Color = BlackTheme.blue
    let action: () -> Void
    @ScaledMetric(relativeTo: .caption) private var titleSize = 12.0
    @ScaledMetric(relativeTo: .caption) private var detailSize = 11.0

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                BlackIcon(name: icon, size: 21).foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: titleSize, weight: .medium)).foregroundStyle(BlackTheme.text)
                    Text(detail).font(.system(size: detailSize)).foregroundStyle(BlackTheme.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                BlackIcon(name: "chevron-right", size: 15).foregroundStyle(BlackTheme.muted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(minHeight: 57)
            .background(LinearGradient(colors: [Color(hex: 0x1D2939), Color(hex: 0x1C2029)], startPoint: .leading, endPoint: .trailing), in: RoundedRectangle(cornerRadius: 11))
            .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(tint.opacity(0.14), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

struct BlackAssistantLink: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                BlackIcon(name: "sparkles", size: 16)
                Text("Zapytaj GateLynk").font(.system(size: 12))
                Spacer()
                BlackIcon(name: "arrow-up-right", size: 13)
            }
            .foregroundStyle(Color(hex: 0xD1C1F3))
            .padding(.horizontal, 4)
            .frame(minHeight: 45)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

struct BlackTabBar: View {
    @Binding var selection: GlassHomeTab
    var flagged: Set<GlassHomeTab> = []
    private func icon(_ tab: GlassHomeTab) -> String {
        switch tab {
        case .home: "house"
        case .access: "key-round"
        case .matters: "layers"
        case .estate: "building-2"
        }
    }
    var body: some View {
        HStack(spacing: 0) {
            ForEach(GlassHomeTab.allCases) { tab in
                Button { selection = tab } label: {
                    VStack(spacing: 5) {
                        BlackIcon(name: icon(tab), size: 21)
                            .overlay(alignment: .topTrailing) {
                                if flagged.contains(tab) {
                                    Circle().fill(BlackTheme.amber).frame(width: 6, height: 6).offset(x: 5, y: -2)
                                }
                            }
                        Text(tab.title).font(.caption2)
                    }
                    .foregroundStyle(tab == selection ? Color(hex: 0xC5AEFF) : Color(hex: 0x9E9EAB))
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title + (flagged.contains(tab) ? ", są sprawy wymagające uwagi" : ""))
                .accessibilityAddTraits(tab == selection ? [.isSelected] : [])
            }
        }
        .padding(.horizontal, 13)
        .padding(.top, 7)
        .background(Color(hex: 0x111217).ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.05)).frame(height: 1) }
    }
}
