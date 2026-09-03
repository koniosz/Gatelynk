import SwiftUI

// MARK: - Sheet "Więcej"
//
// 2026-07-07 (produkcja): profil + wejścia wymagane przez App Store:
//   • Historia zdarzeń osiedla (parity z główną apką),
//   • Polityka prywatności (link — wymóg App Review),
//   • Usunięcie konta z poziomu apki (wymóg Apple 5.1.1(v)) — potwierdzenie
//     w tym samym sheecie, DELETE /resident/me → logout,
//   • Dynamic Island / geofencing — widoczna zapowiedź WKRÓTCE.

struct GlassMoreSheet: View {
    let building: Building?
    /// Live stan zamków Nuki lokalu (2026-07-10) — lista ze statusem nad
    /// przyciskiem „Dodaj zamek Nuki". Pusta = brak zamka / stary backend.
    var nukiLocks: [NukiLockStatus] = []
    let onOpenHistory: () -> Void
    /// Kalendarz wydarzeń osiedla (2026-07-16).
    let onOpenCalendar: () -> Void
    let onOpenNukiLock: () -> Void
    /// Nieruchomości (2026-08-11) — otwiera GlassPropertiesSheet (ta sama
    /// destynacja co ikonka domku w lewym górnym rogu ekranu głównego).
    let onOpenProperties: () -> Void
    let onComingSoon: (GlassUpcomingFeature) -> Void
    let onClose: () -> Void

    @Environment(AuthManager.self) private var auth
    @Environment(GlassToastCenter.self) private var toast
    @Environment(\.openURL) private var openURL

    /// Polityka prywatności GateLynk (żywy URL — landing gatelynk.pl).
    private static let privacyURL = URL(string: "https://gatelynk.pl/polityka-prywatnosci")!

    private enum Mode: Equatable { case main, deleteConfirm, household, householdInvite }

    @State private var mode: Mode = .main
    @State private var deleting = false
    @State private var deleteError: String?

    // Domownicy (2026-08-09) — mieszkaniec zaprasza żonę/dziecko do SWOJEGO
    // lokalu: zaproszenie (imię + relacja) → link ShareLink-iem → domownik
    // zakłada konto (własny e-mail + hasło) na /accept-household. Parity
    // z sekcją „Domownicy" w SettingsView głównej apki.
    @State private var householdData: HouseholdOverview? = nil
    @State private var householdError: String? = nil
    @State private var cancellingInviteId: Int? = nil
    @State private var inviteName = ""
    @State private var inviteRelation = ""
    @State private var inviteCreating = false
    @State private var inviteError: String? = nil
    @State private var createdInvite: HouseholdInviteCreated? = nil

    var body: some View {
        switch mode {
        case .main: mainContent
        case .deleteConfirm: deleteConfirmContent
        case .household: householdContent
        case .householdInvite: householdInviteContent
        }
    }

    // MARK: Główna treść

    private var mainContent: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Więcej", title: "Twoje konto", onClose: onClose)

            if case .resident(let user) = auth.role {
                profileCard(user)
            }

            // Historia zdarzeń
            actionRow(icon: "clock.arrow.circlepath", label: "Historia zdarzeń osiedla") {
                onOpenHistory()
            }

            // Kalendarz wydarzeń (odbiory śmieci itd.) — parity ze starą apką.
            actionRow(icon: "calendar", label: "Kalendarz osiedla") {
                onOpenCalendar()
            }

            // Zamek inteligentny (2026-07-16, wariant 1): wiersz statusu zamka
            // jest KLIKALNY i sam prowadzi do zarządzania (chevron po prawej) —
            // bez osobnej pozycji „Zarządzaj". Gdy zamka nie ma — uniwersalny
            // „Dodaj zamek (Nuki / Tedee)".
            ForEach(nukiLocks) { lock in
                Button {
                    onOpenNukiLock()
                } label: {
                    nukiLockRow(lock)
                }
                .buttonStyle(.plain)
            }
            if nukiLocks.isEmpty {
                actionRow(icon: "lock.badge.plus", label: "Dodaj zamek (Nuki / Tedee)") {
                    onOpenNukiLock()
                }
            }

            // Dynamic Island geofencing — zapowiedź WKRÓTCE
            Button {
                onComingSoon(.geofencing)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "location.viewfinder")
                        .font(.system(size: 14))
                        .foregroundStyle(GlassColor.accentLight)
                        .frame(width: 24)
                    Text("Otwieranie przy zbliżaniu")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.7))
                    GlassSoonBadge()
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.35))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Domownicy — zaproś żonę/dziecko do swojego lokalu (pełne konto
            // mieszkańca przez link ShareLink).
            actionRow(icon: "person.2.fill", label: "Domownicy") {
                mode = .household
            }

            // Osiedle — klikalne: prowadzi do przełącznika nieruchomości
            // (zmiana obiektu bez wylogowania + jak dodać kolejny).
            Button {
                onOpenProperties()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "building.2.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(GlassColor.accentLight)
                        .frame(width: 24)
                    Text("Osiedle")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.7))
                    Spacer()
                    Text(building?.name ?? "—")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.35))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            infoRow(icon: "sparkles", label: "Wersja", value: appVersion)

            // Polityka prywatności (wymóg App Store)
            actionRow(icon: "hand.raised.fill", label: "Polityka prywatności") {
                openURL(Self.privacyURL)
            }

            GlassButton(title: "Wyloguj się", style: .ghost) {
                auth.logout()
            }
            .padding(.top, 2)

            // Usunięcie konta (wymóg Apple)
            Button {
                deleteError = nil
                mode = .deleteConfirm
            } label: {
                Text("Usuń konto")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(GlassColor.dangerSoft.opacity(0.9))
                    .padding(.vertical, 6)
            }
            .buttonStyle(.plain)
        }
    }

    private var appVersion: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
        return "GateLynk β \(v) · Glass Depth"
    }

    // MARK: Potwierdzenie usunięcia konta

    private var deleteConfirmContent: some View {
        VStack(spacing: 12) {
            GlassSheetHeader(kicker: "Konto", title: "Usunąć konto?", onClose: onClose)

            VStack(spacing: 8) {
                Image(systemName: "person.crop.circle.badge.xmark")
                    .font(.system(size: 32))
                    .foregroundStyle(GlassColor.dangerSoft)
                Text("Twoje dane osobowe zostaną usunięte,\na dostęp do osiedla wyłączony.")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                Text("Aktywne zaproszenia gości zostaną anulowane. Historia wejść budynku pozostaje u zarządcy (obowiązek prawny). Tej operacji nie można cofnąć — ponowny dostęp wymaga kontaktu z administracją.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity)
            .padding(16)
            .background {
                RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                    .fill(GlassColor.dangerSoft.opacity(0.12))
            }
            .overlay {
                RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                    .strokeBorder(GlassColor.dangerSoft.opacity(0.35), lineWidth: 1)
            }

            if let deleteError {
                Text(deleteError)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(GlassColor.dangerSoft)
                    .multilineTextAlignment(.center)
            }

            GlassButton(
                title: "Tak, usuń moje konto",
                style: .danger,
                busyText: "Usuwam…",
                isBusy: deleting
            ) {
                Task { await deleteAccount() }
            }

            GlassButton(title: "Anuluj", style: .ghost) {
                mode = .main
            }
        }
    }

    private func deleteAccount() async {
        deleting = true
        deleteError = nil
        do {
            try await auth.deleteAccount()
            // deleteAccount() robi logout → GlassApp pokaże ekran logowania.
            toast.show("Konto zostało usunięte")
        } catch {
            deleteError = error.localizedDescription
        }
        deleting = false
    }

    // MARK: Domownicy (2026-08-09)
    //
    // Lista: aktywni współlokatorzy + aktywne zaproszenia (GET /resident/
    // household). Zaproszenia są per LOKAL — widać i można anulować także te
    // wysłane przez innych domowników (transparentność w rodzinie). Link
    // z listy da się wysłać ponownie ShareLink-iem (token jest w inviteUrl).

    private var householdContent: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Konto", title: "Domownicy", onClose: onClose)

            if householdData == nil && householdError == nil {
                ProgressView()
                    .tint(.white)
                    .padding(.vertical, 18)
            }

            if let data = householdData {
                if data.members.isEmpty && data.invitations.isEmpty {
                    Text("Mieszkasz sam? Zaproś domowników —\nkażdy dostanie własne konto do otwierania bram.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.white.opacity(0.6))
                        .multilineTextAlignment(.center)
                        .padding(.vertical, 10)
                } else {
                    ScrollView(showsIndicators: false) {
                        VStack(spacing: 9) {
                            ForEach(data.members) { m in
                                householdMemberRow(m)
                            }
                            ForEach(data.invitations) { inv in
                                householdInviteRow(inv)
                            }
                        }
                    }
                    .frame(maxHeight: 300)
                    .scrollBounceBehavior(.basedOnSize)
                }
            }

            if let householdError {
                Text(householdError)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(GlassColor.dangerSoft)
                    .multilineTextAlignment(.center)
            }

            GlassButton(title: "Zaproś domownika") {
                inviteName = ""
                inviteRelation = ""
                inviteError = nil
                createdInvite = nil
                mode = .householdInvite
            }

            Text("Domownik dostaje pełne konto mieszkańca Twojego lokalu: bramy, goście, domofon. Link ważny 7 dni, jednorazowy.")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.5))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            GlassButton(title: "Wróć", style: .ghost) {
                mode = .main
            }
        }
        .task { await loadHousehold() }
    }

    private func householdMemberRow(_ m: HouseholdMember) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "person.fill")
                .font(.system(size: 14))
                .foregroundStyle(GlassColor.accentLight)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(m.fullName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                Text(householdMemberCaption(m))
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.5))
            }
            Spacer()
            if m.hasAccount == false {
                Text("bez konta")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(Color.white.opacity(0.10)))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.06))
        }
    }

    private func householdInviteRow(_ inv: HouseholdInvitation) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "hourglass")
                .font(.system(size: 14))
                .foregroundStyle(GlassColor.accentLight)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(inv.inviteeName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                Text("zaproszenie do \(Self.glassShortDate(inv.expiresAt))")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.5))
            }
            Spacer()
            // Ponowne wysłanie linku — ShareLink jak przy PIN-ie gościa.
            if let urlString = inv.inviteUrl, let url = URL(string: urlString) {
                ShareLink(
                    item: url,
                    message: Text(Self.householdShareText(name: inv.inviteeName))
                ) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(GlassColor.accentLight)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(Color.white.opacity(0.08)))
                }
                .buttonStyle(.plain)
            }
            // Anulowanie zaproszenia (jednorazowe unieważnienie linku).
            if cancellingInviteId == inv.id {
                ProgressView().tint(.white)
            } else {
                Button {
                    Task { await cancelHouseholdInvite(inv.id) }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(GlassColor.dangerSoft)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(GlassColor.dangerSoft.opacity(0.14)))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.06))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
        }
    }

    private func householdMemberCaption(_ m: HouseholdMember) -> String {
        var parts: [String] = []
        if let rel = m.relationLabel, !rel.isEmpty {
            parts.append(rel)
        } else if let role = m.role {
            parts.append(role == "OWNER" ? "właściciel" : "domownik")
        }
        if m.invitedByMe == true { parts.append("zaproszony przez Ciebie") }
        return parts.isEmpty ? "mieszkaniec lokalu" : parts.joined(separator: " · ")
    }

    // MARK: Domownicy — formularz zaproszenia + udostępnienie linku

    private var householdInviteContent: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Domownicy", title: "Zaproś domownika", onClose: onClose)

            if let inv = createdInvite {
                // Krok 2 — link gotowy, wysyłamy ShareLink-iem (iMessage itd.).
                VStack(spacing: 8) {
                    Image(systemName: "person.2.badge.plus")
                        .font(.system(size: 32))
                        .foregroundStyle(GlassColor.accentLight)
                    Text("Zaproszenie dla \(inv.inviteeName) gotowe")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                    Text("Po otwarciu linku domownik poda swój e-mail, ustawi hasło i zaloguje się w aplikacji. Link ważny do \(Self.glassShortDate(inv.expiresAt)), jednorazowy.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.white.opacity(0.6))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity)
                .padding(16)
                .background {
                    RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                }

                if let url = URL(string: inv.inviteUrl) {
                    ShareLink(
                        item: url,
                        message: Text(Self.householdShareText(name: inv.inviteeName))
                    ) {
                        HStack(spacing: 8) {
                            Image(systemName: "paperplane.fill")
                                .font(.system(size: 14, weight: .semibold))
                            Text("Wyślij zaproszenie")
                                .font(.system(size: 15, weight: .bold))
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background {
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .fill(GlassColor.accentGradient)
                                .shadow(color: GlassColor.accentBlue.opacity(0.45), radius: 13, y: 5)
                        }
                    }
                    .buttonStyle(.plain)
                }

                GlassButton(title: "Gotowe", style: .ghost) {
                    createdInvite = nil
                    mode = .household
                }
            } else {
                // Krok 1 — formularz: imię (wymagane) + relacja (opcjonalna).
                glassField("Imię i nazwisko", text: $inviteName)
                glassField("Relacja (np. żona, syn) — opcjonalnie", text: $inviteRelation)

                Text("Domownik dostanie te same funkcje co Ty — otwieranie bram, zapraszanie gości, domofon.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                if let inviteError {
                    Text(inviteError)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(GlassColor.dangerSoft)
                        .multilineTextAlignment(.center)
                }

                GlassButton(
                    title: "Utwórz zaproszenie",
                    busyText: "Tworzę…",
                    isBusy: inviteCreating
                ) {
                    Task { await createHouseholdInvite() }
                }

                GlassButton(title: "Wróć", style: .ghost) {
                    mode = .household
                }
            }
        }
    }

    /// Pole formularza w stylu Glass (wzór: GlassGuestsSheet.formField).
    private func glassField(_ placeholder: String, text: Binding<String>) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundStyle(.white.opacity(0.5)))
            .textInputAutocapitalization(.words)
            .autocorrectionDisabled()
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background { Capsule().fill(Color.white.opacity(0.08)) }
            .overlay { Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 1) }
    }

    /// Treść wiadomości ShareLink — parity z główną apką.
    private static func householdShareText(name: String) -> String {
        "Cześć \(name)! Zapraszam Cię do aplikacji GateLynk naszego osiedla. Otwórz link, podaj swój e-mail i ustaw hasło — będziesz otwierać bramę i furtkę z telefonu."
    }

    /// Formatter poza @ViewBuilder (pułapka #17 CLAUDE.md) — „16 sie 2026".
    private static func glassShortDate(_ date: Date) -> String {
        let df = DateFormatter()
        df.locale = Locale(identifier: "pl_PL")
        df.dateStyle = .medium
        df.timeStyle = .none
        return df.string(from: date)
    }

    private func loadHousehold() async {
        householdError = nil
        do {
            householdData = try await APIClient.shared.get("/resident/household")
        } catch {
            if householdData == nil {
                householdError = "Nie udało się pobrać listy domowników"
            }
        }
    }

    private func createHouseholdInvite() async {
        let name = inviteName.trimmingCharacters(in: .whitespaces)
        guard name.count >= 2 else {
            inviteError = "Podaj imię domownika"
            return
        }
        inviteCreating = true
        inviteError = nil
        struct Body: Encodable { let name: String; let relationLabel: String? }
        do {
            let relation = inviteRelation.trimmingCharacters(in: .whitespaces)
            let resp: HouseholdInviteCreated = try await APIClient.shared.post(
                "/resident/household/invitations",
                body: Body(name: name, relationLabel: relation.isEmpty ? nil : relation)
            )
            createdInvite = resp
            toast.show("Zaproszenie utworzone")
        } catch let APIError.httpError(_, message) {
            inviteError = message
        } catch {
            inviteError = "Nie udało się utworzyć zaproszenia — spróbuj ponownie"
        }
        inviteCreating = false
    }

    private func cancelHouseholdInvite(_ id: Int) async {
        cancellingInviteId = id
        defer { cancellingInviteId = nil }
        do {
            struct Resp: Decodable { let success: Bool }
            let _: Resp = try await APIClient.shared.delete("/resident/household/invitations/\(id)")
            toast.show("Zaproszenie anulowane")
            await loadHousehold()
        } catch {
            householdError = "Nie udało się anulować zaproszenia"
        }
    }

    // MARK: Komponenty

    private func profileCard(_ user: ResidentUser) -> some View {
        HStack(spacing: 13) {
            ZStack {
                Circle().fill(GlassColor.accentGradient)
                Text(initials(user))
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
            }
            .frame(width: 48, height: 48)

            VStack(alignment: .leading, spacing: 2) {
                Text("\(user.firstName) \(user.lastName)")
                    .font(.system(size: 15.5, weight: .bold))
                    .foregroundStyle(.white)
                Text(user.email)
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.6))
            }
            Spacer()
        }
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.08))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        }
    }

    private func initials(_ user: ResidentUser) -> String {
        let f = user.firstName.prefix(1)
        let l = user.lastName.prefix(1)
        return "\(f)\(l)".uppercased()
    }

    private func infoRow(icon: String, label: String, value: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 14))
                .foregroundStyle(GlassColor.accentLight)
                .frame(width: 24)
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.7))
            Spacer()
            Text(value)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.06))
        }
    }

    private func actionRow(icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(GlassColor.accentLight)
                    .frame(width: 24)
                Text(label)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.85))
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.35))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(0.06))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Wiersz zamka Nuki ze stanem (2026-07-10)

    @ViewBuilder
    private func nukiLockRow(_ lock: NukiLockStatus) -> some View {
        let (text, color): (String, Color) = {
            switch lock.badge {
            case .secure:     return (lock.effectiveStateLabel ?? "Zamknięty", Color(hex: 0x34D399))
            case .open:       return (lock.effectiveStateLabel ?? "Otwarty", Color(hex: 0xF0A93E))
            case .transition: return (lock.effectiveStateLabel ?? "W ruchu", Color(hex: 0x6E8BFF))
            case .unknown:    return (lock.effectiveStateLabel ?? "Nieznany", Color(hex: 0x8A93A6))
            case .offline:    return ("offline", Color(hex: 0x8A93A6))
            }
        }()
        HStack(spacing: 12) {
            Image(systemName: "lock.fill")
                .font(.system(size: 14))
                .foregroundStyle(GlassColor.accentLight)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(lock.name)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.85))
                if let door = lock.doorLabel, lock.online {
                    Text(door)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.white.opacity(0.5))
                }
            }
            Spacer()
            if lock.batteryCritical == true {
                Text("🔋")
                    .font(.system(size: 11))
            }
            HStack(spacing: 5) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(text)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(color)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(Capsule().fill(color.opacity(0.16)))

            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white.opacity(0.35))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.06))
        }
    }
}

// MARK: - Sheet "Nieruchomości" (multi-property)
//
// Samodzielny sheet — od 2026-08-11 wejście NIE przez „Więcej", tylko wprost
// z ikonki domku w lewym górnym rogu ekranu głównego (decyzja właściciela:
// zmiana nieruchomości ma być na wierzchu). Wiersz „Osiedle" w „Więcej"
// prowadzi w to samo miejsce.

struct GlassPropertiesSheet: View {
    let onClose: () -> Void

    @Environment(AuthManager.self) private var auth
    @Environment(GlassToastCenter.self) private var toast

    @State private var myBuildings: [ResidentBuildingChoice]? = nil
    @State private var propsError: String? = nil
    @State private var switchingId: Int? = nil
    @State private var emailCopied = false

    // MARK: Nieruchomości (multi-property, 2026-08-09)
    //
    // Lista kont tego e-maila we wszystkich obiektach (GET /resident/my-buildings).
    // Przełączenie = POST switch-building z aktualnym tokenem (bez hasła);
    // po sukcesie GlassApp przebudowuje GlassHomeView przez `.id(residentId)`
    // — sheet znika ze starym drzewem widoków, deck ładuje nowy budynek.
    // „Dodanie" nieruchomości nie wymaga niczego w apce: zarządca nowego
    // obiektu dodaje mieszkańca na TEN SAM e-mail i konto pojawia się samo.

    var body: some View {
        VStack(spacing: 10) {
            GlassSheetHeader(kicker: "Konto", title: "Nieruchomości", onClose: onClose)

            if let list = myBuildings {
                ForEach(list) { b in
                    propertyRow(b)
                }
            } else if propsError == nil {
                ProgressView()
                    .tint(.white)
                    .padding(.vertical, 18)
            }

            if let propsError {
                Text(propsError)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(GlassColor.dangerSoft)
                    .multilineTextAlignment(.center)
            }

            addPropertyCard
        }
        .task { await loadMyBuildings() }
    }

    private func propertyRow(_ b: ResidentBuildingChoice) -> some View {
        let isCurrent = b.residentId == auth.currentResidentId
        return Button {
            guard !isCurrent, switchingId == nil else { return }
            Task { await switchProperty(b) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: isCurrent ? "building.2.fill" : "building.2")
                    .font(.system(size: 14))
                    .foregroundStyle(isCurrent ? GlassColor.accentLight : .white.opacity(0.5))
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(b.buildingName)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                    Text([b.buildingAddress, b.unit.map { "lokal \($0)" }]
                        .compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.white.opacity(0.5))
                }
                Spacer()
                if switchingId == b.residentId {
                    ProgressView().tint(.white)
                } else if isCurrent {
                    Text("obecna")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(GlassColor.accentLight)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(GlassColor.accentLight.opacity(0.16)))
                } else {
                    Image(systemName: "arrow.right.circle")
                        .font(.system(size: 15))
                        .foregroundStyle(.white.opacity(0.4))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(isCurrent ? 0.1 : 0.06))
            }
            .overlay {
                if isCurrent {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(GlassColor.accentLight.opacity(0.35), lineWidth: 1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(switchingId != nil)
    }

    private var addPropertyCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Dodaj nieruchomość", systemImage: "plus.circle.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(GlassColor.accentLight)
            Text("Podaj zarządcy nowej nieruchomości swój adres e-mail. Gdy doda Cię jako mieszkańca, obiekt pojawi się na tej liście automatycznie — bez zakładania nowego konta.")
                .font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.6))
                .fixedSize(horizontal: false, vertical: true)
            if case .resident(let user) = auth.role {
                Button {
                    UIPasteboard.general.string = user.email
                    emailCopied = true
                    toast.show("Skopiowano adres e-mail")
                    Task {
                        try? await Task.sleep(for: .seconds(2))
                        emailCopied = false
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: emailCopied ? "checkmark.circle.fill" : "doc.on.doc")
                            .font(.system(size: 12))
                        Text(user.email)
                            .font(.system(size: 12, weight: .semibold))
                            .lineLimit(1)
                    }
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Color.white.opacity(0.1)))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .fill(Color.white.opacity(0.05))
        }
        .overlay {
            RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
        }
    }

    private func loadMyBuildings() async {
        propsError = nil
        do {
            myBuildings = try await auth.fetchMyBuildings()
        } catch {
            if myBuildings == nil { propsError = "Nie udało się pobrać listy nieruchomości" }
        }
    }

    private func switchProperty(_ b: ResidentBuildingChoice) async {
        switchingId = b.residentId
        propsError = nil
        do {
            try await auth.switchBuilding(to: b.residentId)
            toast.show("Przełączono na \(b.buildingName)")
            onClose()
        } catch {
            propsError = "Nie udało się przełączyć — spróbuj ponownie"
        }
        switchingId = nil
    }
}
