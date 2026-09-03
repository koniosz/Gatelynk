import SwiftUI

// MARK: - Sheet Goście
//
// Lista zaproszeń (aktywne ● zielone / nadchodzące ○ fiolet / wygasłe
// przygaszone) + kompaktowy kreator zaproszenia w tym samym sheecie.
// POST /resident/guests zwraca Guest z 6-cyfrowym PIN-em — pokazujemy go
// od razu w toaście i na liście.

struct GammaGuestsSheet: View {
    let guests: [Guest]
    let onReload: () async -> Void
    let onClose: () -> Void

    @Environment(GammaToastCenter.self) private var toast

    private enum Mode: Equatable { case list, form }

    @State private var mode: Mode = .list

    // Formularz
    @State private var name = ""
    @State private var plate = ""
    @State private var validFrom = Date()
    @State private var validTo = Date().addingTimeInterval(4 * 3600)
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
            GammaSheetHeader(kicker: "Goście", title: "Zaproszenia", onClose: onClose)

            if visibleGuests.isEmpty {
                GammaSheetEmptyState(
                    icon: "person.2",
                    text: "Brak aktywnych zaproszeń.\nZaproś gościa — dostanie PIN do bramy."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(visibleGuests) { g in
                            row(g)
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            }

            GammaButton(title: "+ Zaproś gościa") {
                mode = .form
            }
            .padding(.top, 6)
        }
    }

    /// Aktywne i nadchodzące na górze, ostatnie wygasłe na końcu (max 3).
    private var visibleGuests: [Guest] {
        let active = guests.filter { $0.status == .active }
        let inactive = guests.filter { $0.status != .active }.prefix(3)
        return active + Array(inactive)
    }

    private func row(_ g: Guest) -> some View {
        let upcoming = g.status == .active && g.validFrom > Date()
        let initial = String(g.name.prefix(1)).uppercased()

        return GammaActionRow(
            orbGradient: g.status == .active
                ? (upcoming
                    ? [GammaColor.accentLight, GammaColor.accentBlue]
                    : [GammaColor.success, GammaColor.accentBlue])
                : [Color.white.opacity(0.2), Color.white.opacity(0.1)],
            orbIcon: "person.fill",
            title: g.name,
            subtitle: subtitle(g),
            dimmed: g.status != .active,
            trailing: { EmptyView() },
            extra: {
                HStack(spacing: 8) {
                    if g.status == .active {
                        Text(upcoming ? "○ Nadchodzące" : "● Aktywne teraz")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(upcoming ? GammaColor.accentLight : GammaColor.successLight)
                        Text("PIN \(g.pin)")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white.opacity(0.75))
                    } else {
                        Text(g.status.label)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.5))
                    }
                }
                .padding(.top, 3)
            }
        )
        // używamy initial w orbie? GammaOrb przyjmuje SF Symbol — initial pomijamy
        .accessibilityLabel("\(initial) — \(g.name)")
    }

    private func subtitle(_ g: Guest) -> String {
        var s = GammaFormat.guestWindow(g)
        if let p = g.vehiclePlate, !p.isEmpty {
            s += " · \(p)"
        }
        return s
    }

    // MARK: Formularz

    private var formContent: some View {
        VStack(spacing: 12) {
            GammaSheetHeader(kicker: "Goście", title: "Zaproś gościa", onClose: onClose)

            formField("Imię i nazwisko gościa", text: $name)
            formField("Tablica rejestracyjna (opcjonalnie)", text: $plate, autocapitalize: true)

            datePickerRow("Od", selection: $validFrom)
            datePickerRow("Do", selection: $validTo)

            if let formError {
                Text(formError)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(GammaColor.dangerSoft)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            GammaButton(
                title: "Utwórz zaproszenie",
                busyText: "Tworzę…",
                isBusy: submitting
            ) {
                Task { await submit() }
            }

            GammaButton(title: "Wróć", style: .ghost) {
                mode = .list
            }
        }
    }

    private func formField(_ placeholder: String, text: Binding<String>, autocapitalize: Bool = false) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundStyle(.white.opacity(0.5)))
            .textInputAutocapitalization(autocapitalize ? .characters : .words)
            .autocorrectionDisabled()
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background { Capsule().fill(Color.white.opacity(0.08)) }
            .overlay { Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 1) }
    }

    private func datePickerRow(_ label: String, selection: Binding<Date>) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
            Spacer()
            DatePicker("", selection: selection, displayedComponents: [.date, .hourAndMinute])
                .labelsHidden()
                .environment(\.locale, Locale(identifier: "pl_PL"))
                .tint(GammaColor.accentLight)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background {
            RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.08))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GammaRadius.row, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
    }

    private func submit() async {
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        guard !trimmedName.isEmpty else {
            formError = "Podaj imię gościa."
            return
        }
        guard validTo > validFrom else {
            formError = "Koniec okna czasowego musi być po początku."
            return
        }
        submitting = true
        formError = nil

        let trimmedPlate = plate.trimmingCharacters(in: .whitespaces).uppercased()
        let body = CreateGuestBody(
            name: trimmedName,
            phone: nil,
            email: nil,
            vehiclePlate: trimmedPlate.isEmpty ? nil : trimmedPlate,
            validFrom: GammaFormat.iso8601.string(from: validFrom),
            validTo: GammaFormat.iso8601.string(from: validTo)
        )
        do {
            let created: Guest = try await APIClient.shared.post("/resident/guests", body: body)
            await onReload()
            toast.show("Zaproszenie gotowe · PIN \(created.pin)")
            name = ""; plate = ""
            mode = .list
        } catch {
            formError = error.localizedDescription
        }
        submitting = false
    }
}
