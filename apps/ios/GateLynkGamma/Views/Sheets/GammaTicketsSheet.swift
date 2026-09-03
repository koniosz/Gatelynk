import SwiftUI

// MARK: - Sheet Zgłoszenia
//
// Lista usterek z 3 stanami (OPEN/IN_PROGRESS/DONE — design: oczekuje /
// w naprawie / rozwiązane) + formularz nowego zgłoszenia w tym samym
// sheecie. POST /resident/tickets (CreateTicketBody, kategorie z głównej
// apki: ISSUE/QUESTION/FEEDBACK).

struct GammaTicketsSheet: View {
    let tickets: [Ticket]
    let onReload: () async -> Void
    let onClose: () -> Void

    @Environment(GammaToastCenter.self) private var toast

    private enum Mode: Equatable { case list, form }

    @State private var mode: Mode = .list
    @State private var title = ""
    @State private var bodyText = ""
    @State private var category = "ISSUE"
    @State private var submitting = false
    @State private var formError: String?

    var body: some View {
        switch mode {
        case .list: listContent
        case .form: formContent
        }
    }

    // MARK: Lista

    private var listContent: some View {
        VStack(spacing: 9) {
            GammaSheetHeader(kicker: "Zgłoszenia", title: "Twoje usterki", onClose: onClose)

            if tickets.isEmpty {
                GammaSheetEmptyState(
                    icon: "wrench.and.screwdriver",
                    text: "Brak zgłoszeń. Coś nie działa?\nDaj znać administracji."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(sortedTickets) { t in
                            row(t)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }

            GammaButton(title: "+ Nowe zgłoszenie") {
                mode = .form
            }
            .padding(.top, 6)
        }
    }

    private var sortedTickets: [Ticket] {
        let open = tickets.filter { $0.status != "DONE" }
        let done = tickets.filter { $0.status == "DONE" }.prefix(3)
        return open + Array(done)
    }

    private func row(_ t: Ticket) -> some View {
        GammaActionRow(
            orbGradient: orbGradient(t.status),
            orbIcon: orbIcon(t.status),
            title: t.title,
            subtitle: "#\(t.id) · \(GammaFormat.relative.localizedString(for: t.createdAt, relativeTo: Date()))",
            dimmed: t.status == "DONE",
            trailing: { EmptyView() },
            extra: {
                Text(statusLine(t.status))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(statusColor(t.status))
                    .padding(.top, 3)
            }
        )
    }

    private func statusLine(_ s: String) -> String {
        switch s {
        case "OPEN":        return "● Oczekuje na przyjęcie"
        case "IN_PROGRESS": return "● W trakcie naprawy"
        case "DONE":        return "✓ Rozwiązane"
        default:            return s
        }
    }

    private func statusColor(_ s: String) -> Color {
        switch s {
        case "OPEN":        return GammaColor.orbAmber1
        case "IN_PROGRESS": return GammaColor.successLight
        default:            return .white.opacity(0.5)
        }
    }

    private func orbGradient(_ s: String) -> [Color] {
        switch s {
        case "OPEN":        return [GammaColor.orbAmber1, GammaColor.orbAmber2]
        case "IN_PROGRESS": return [GammaColor.accentBlue, GammaColor.success]
        default:            return [Color.white.opacity(0.2), Color.white.opacity(0.1)]
        }
    }

    private func orbIcon(_ s: String) -> String {
        switch s {
        case "DONE": return "checkmark"
        default:     return "wrench.fill"
        }
    }

    // MARK: Formularz

    private var formContent: some View {
        VStack(spacing: 12) {
            GammaSheetHeader(kicker: "Zgłoszenia", title: "Nowe zgłoszenie", onClose: onClose)

            categoryPicker

            TextField("", text: $title, prompt: Text("Tytuł — co się dzieje?").foregroundStyle(.white.opacity(0.5)))
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background { Capsule().fill(Color.white.opacity(0.08)) }
                .overlay { Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 1) }

            TextField(
                "",
                text: $bodyText,
                prompt: Text("Opisz problem…").foregroundStyle(.white.opacity(0.5)),
                axis: .vertical
            )
            .lineLimit(4...8)
            .font(.system(size: 14))
            .foregroundStyle(.white)
            .padding(14)
            .background {
                RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                    .fill(Color.white.opacity(0.08))
            }
            .overlay {
                RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.16), lineWidth: 1)
            }

            if let formError {
                Text(formError)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(GammaColor.dangerSoft)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            GammaButton(title: "Wyślij zgłoszenie", busyText: "Wysyłam…", isBusy: submitting) {
                Task { await submit() }
            }

            GammaButton(title: "Wróć", style: .ghost) {
                mode = .list
            }
        }
    }

    private static let categories: [(key: String, label: String)] = [
        ("ISSUE", "Usterka"),
        ("QUESTION", "Pytanie"),
        ("FEEDBACK", "Opinia"),
    ]

    private var categoryPicker: some View {
        HStack(spacing: 6) {
            ForEach(Self.categories, id: \.key) { c in
                let selected = category == c.key
                Button {
                    category = c.key
                } label: {
                    Text(c.label)
                        .font(.system(size: 12, weight: selected ? .bold : .medium))
                        .foregroundStyle(selected ? .white : .white.opacity(0.6))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background {
                            if selected {
                                Capsule().fill(GammaColor.accentGradient)
                            } else {
                                Capsule().fill(Color.white.opacity(0.08))
                            }
                        }
                        .overlay {
                            if !selected {
                                Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                            }
                        }
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
    }

    private func submit() async {
        let t = title.trimmingCharacters(in: .whitespaces)
        let b = bodyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !b.isEmpty else {
            formError = "Uzupełnij tytuł i opis."
            return
        }
        submitting = true
        formError = nil
        do {
            let _: Ticket = try await APIClient.shared.post(
                "/resident/tickets",
                body: CreateTicketBody(category: category, title: t, body: b, photo: nil, type: nil)
            )
            await onReload()
            toast.show("Zgłoszenie wysłane")
            title = ""; bodyText = ""
            mode = .list
        } catch {
            formError = error.localizedDescription
        }
        submitting = false
    }
}
