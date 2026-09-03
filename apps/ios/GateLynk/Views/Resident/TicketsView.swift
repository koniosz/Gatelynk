import SwiftUI
import PhotosUI
import UIKit

// MARK: - Category model

private struct TicketCategory {
    let value: String
    let label: String
    let icon: String
}

private let ticketCategories: [TicketCategory] = [
    TicketCategory(value: "ISSUE",    label: "Usterka",  icon: "wrench.and.screwdriver"),
    TicketCategory(value: "QUESTION", label: "Pytanie",  icon: "questionmark.circle"),
    TicketCategory(value: "FEEDBACK", label: "Opinia",   icon: "star"),
    TicketCategory(value: "OTHER",    label: "Inne",     icon: "ellipsis.circle"),
]

// MARK: - TicketsView (Glass Premium v3)
//
// Port designu z `docs/design/resident-2026-05-11/source/screens/secondary.jsx`
// → `TicketsScreen`. Layout:
//   • Segmented tab „Otwarte (n) / Zamknięte (n)" na górze
//   • GLCard list: top = category pill + #id, title, body preview, bottom =
//     status dot + label + time + replies count
//
// `TicketConversationView` (rozmowa) i `NewTicketView` (formularz) zachowują
// poprzedni Faza 4 layout — są poniżej w tym samym pliku.

struct TicketsView: View {
    /// Deep-link z pusha `ticket_reply` (2026-08-13) — po załadowaniu listy
    /// otwieramy od razu wątek tego zgłoszenia. Nil = normalne wejście z kafla.
    var initialTicketId: Int? = nil

    @State private var tickets: [Ticket] = []
    @State private var loading = true
    @State private var error: String?
    @State private var showNew = false
    @State private var selectedTicket: Ticket?
    @State private var tab: TicketsTab = .open
    /// Route skonsumowany — nie otwieraj wątku ponownie po refresh listy.
    @State private var didConsumeInitial = false

    @Environment(\.colorScheme) private var scheme

    enum TicketsTab: String, CaseIterable {
        case open, closed
        var label: String { self == .open ? "Otwarte" : "Zamknięte" }
        func matches(_ status: String) -> Bool {
            self == .closed ? status == "DONE" : status != "DONE"
        }
    }

    private static let dateFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        f.locale = Locale(identifier: "pl_PL")
        return f
    }()

    var body: some View {
        NavigationStack {
            ZStack {
                GLColor.bg1(scheme).ignoresSafeArea()

                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView(error, systemImage: "wifi.exclamationmark")
                } else {
                    ScrollView(showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 12) {
                            segmentedTabs
                            ticketList
                            Spacer(minLength: 40)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                    }
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Zgłoszenia")
            .navigationBarTitleDisplayMode(.large)
            .toolbarBackground(GLColor.bg1(scheme), for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: {
                        Image(systemName: "plus")
                            .foregroundStyle(GLColor.accent300(scheme))
                    }
                }
            }
            .sheet(isPresented: $showNew, onDismiss: { Task { await load() } }) {
                NewTicketView()
            }
            .sheet(item: $selectedTicket, onDismiss: { Task { await load() } }) { t in
                TicketConversationView(ticket: t)
            }
            .task {
                await load()
                await openInitialTicketIfNeeded()
            }
        }
    }

    /// Deep-link z pusha: znajdź ticket na liście (albo dociągnij pojedynczo,
    /// gdy listy jeszcze nie ma / ticket wypadł poza nią) i otwórz wątek.
    private func openInitialTicketIfNeeded() async {
        guard let id = initialTicketId, !didConsumeInitial else { return }
        didConsumeInitial = true
        if let t = tickets.first(where: { $0.id == id }) {
            tab = t.status == "DONE" ? .closed : .open
            selectedTicket = t
        } else if let t: Ticket = try? await APIClient.shared.get("/resident/tickets/\(id)") {
            tab = t.status == "DONE" ? .closed : .open
            selectedTicket = t
        }
    }

    // MARK: Segmented tabs

    private var segmentedTabs: some View {
        HStack(spacing: 4) {
            ForEach(TicketsTab.allCases, id: \.self) { t in
                Button { tab = t } label: {
                    HStack(spacing: 5) {
                        Text(t.label)
                            .font(.system(size: 13, weight: .semibold))
                        Text("(\(count(t)))")
                            .font(.system(size: 13))
                            .opacity(0.6)
                    }
                    .foregroundStyle(
                        tab == t ? GLColor.textPrimary(scheme) : GLColor.textTertiary(scheme),
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(tab == t ? GLColor.bg4(scheme) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: GLRadius.sm, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: GLRadius.md, style: .continuous))
    }

    private func count(_ t: TicketsTab) -> Int {
        tickets.filter { t.matches($0.status) }.count
    }

    // MARK: List

    @ViewBuilder
    private var ticketList: some View {
        let filtered = tickets.filter { tab.matches($0.status) }
        if filtered.isEmpty {
            emptyState
        } else {
            VStack(spacing: 10) {
                ForEach(filtered) { t in
                    Button { selectedTicket = t } label: {
                        ticketRow(t)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func ticketRow(_ t: Ticket) -> some View {
        GLCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    GLPill(text: categoryLabel(t.category), style: categoryStyle(t.category))
                    Spacer()
                    Text("#\(t.id)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(GLColor.textTertiary(scheme))
                }
                Text(t.title)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(GLColor.textPrimary(scheme))
                    .multilineTextAlignment(.leading)
                Text(t.body)
                    .font(.system(size: 12))
                    .foregroundStyle(GLColor.textTertiary(scheme))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                HStack(spacing: 8) {
                    Circle()
                        .fill(statusDotColor(t.status))
                        .frame(width: 6, height: 6)
                    Text(statusLabel(t.status))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(GLColor.textSecondary(scheme))
                    Spacer()
                    if let replies = t.replies, !replies.isEmpty {
                        HStack(spacing: 3) {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.system(size: 10))
                            Text("\(replies.count)")
                                .font(.system(size: 11, weight: .medium))
                        }
                        .foregroundStyle(GLColor.textTertiary(scheme))
                    }
                    Text(Self.dateFmt.string(from: t.createdAt))
                        .font(.system(size: 11))
                        .foregroundStyle(GLColor.textTertiary(scheme))
                }
                .padding(.top, 6)
                .overlay(
                    Rectangle()
                        .fill(GLColor.borderSubtle(scheme))
                        .frame(height: 1)
                        .padding(.top, 0),
                    alignment: .top,
                )
            }
        }
    }

    private func statusLabel(_ s: String) -> String {
        switch s {
        case "OPEN":        return "Nowe"
        case "IN_PROGRESS": return "W toku"
        case "DONE":        return "Rozwiązane"
        default:            return s
        }
    }

    private func statusDotColor(_ s: String) -> Color {
        switch s {
        case "OPEN":        return GLColor.info(scheme)
        case "IN_PROGRESS": return GLColor.warning(scheme)
        case "DONE":        return GLColor.success(scheme)
        default:            return GLColor.textTertiary(scheme)
        }
    }

    private func categoryLabel(_ c: String) -> String {
        ticketCategories.first { $0.value == c }?.label ?? c
    }

    private func categoryStyle(_ c: String) -> GLPill.Style {
        switch c {
        case "ISSUE":    return .danger
        case "QUESTION": return .info
        case "FEEDBACK": return .accent
        default:         return .neutral
        }
    }

    // MARK: Empty

    private var emptyState: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle().fill(GLColor.bg3(scheme))
                Image(systemName: "bubble.left.and.exclamationmark.bubble.right")
                    .font(.system(size: 26))
                    .foregroundStyle(GLColor.textSecondary(scheme))
            }
            .frame(width: 56, height: 56)
            Text(tab == .open ? "Brak otwartych zgłoszeń" : "Brak zamkniętych zgłoszeń")
                .font(.system(size: 14.5, weight: .semibold))
                .foregroundStyle(GLColor.textPrimary(scheme))
            Text("Kliknij + aby utworzyć nowe")
                .font(.system(size: 12))
                .foregroundStyle(GLColor.textTertiary(scheme))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: GLRadius.xl, style: .continuous)
                .strokeBorder(GLColor.borderDefault(scheme), style: StrokeStyle(lineWidth: 1, dash: [6])),
        )
    }

    private func load() async {
        loading = true; error = nil
        do { tickets = try await APIClient.shared.get("/resident/tickets") }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}

// MARK: - TicketConversationView

struct TicketConversationView: View {
    let ticket: Ticket
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var fullTicket: Ticket?
    @State private var loading = true
    @State private var replyText = ""
    @State private var sending = false
    @State private var sendError: String?

    // Załącznik odpowiedzi (2026-08-13) — aparat albo biblioteka, wybór
    // przez confirmationDialog przy spinaczu. Miniatura nad polem tekstu,
    // usuwalna przed wysyłką. Wysyłka: `photo` w body POST .../replies
    // (data:image/jpeg;base64 — ta sama konwencja co Ticket.photo).
    @State private var replyPhotoItem: PhotosPickerItem?
    @State private var replyPhotoData: Data?
    @State private var replyPhotoPreview: UIImage?
    @State private var showAttachDialog = false
    @State private var showReplyCamera = false
    @State private var showReplyLibrary = false

    private static let timeFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        f.locale = Locale(identifier: "pl_PL")
        return f
    }()

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let t = fullTicket {
                    conversationBody(t)
                }
            }
            .navigationTitle(ticket.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zamknij") { dismiss() }
                }
            }
            .task { await loadFull() }
        }
    }

    // Wątek jak iMessage (2026-08-13): mieszkaniec (zalogowany) po PRAWEJ
    // w akcentowym bąblu (gradient GLColor.accentGradient, biały tekst),
    // administracja/konsjerż po LEWEJ w stonowanym szarym bąblu z podpisem
    // nadawcy. Treść pierwotnego zgłoszenia = pierwszy bąbel mieszkańca
    // (spójna rozmowa, nie osobne sekcje); zdjęcie jako załącznik w bąblu.
    // Max szerokość bąbla ~75% ekranu (GeometryReader), radius 18.
    @ViewBuilder
    private func conversationBody(_ t: Ticket) -> some View {
        VStack(spacing: 0) {
            GeometryReader { geo in
                let maxBubble = geo.size.width * 0.75
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            // Pierwotne zgłoszenie — pierwszy bąbel mieszkańca
                            // (+ zdjęcie jako załącznik w tym samym bąblu).
                            residentBubble(
                                text: t.body,
                                date: t.createdAt,
                                isOriginal: true,
                                photo: Self.decodePhoto(t.photo),
                                maxWidth: maxBubble
                            )

                            ForEach(t.replies ?? []) { r in
                                if r.authorType == "RESIDENT" {
                                    residentBubble(
                                        text: r.body,
                                        date: r.createdAt,
                                        isOriginal: false,
                                        photo: Self.decodePhoto(r.photo),
                                        maxWidth: maxBubble
                                    )
                                } else if r.authorType == "CONCIERGE" {
                                    staffBubble(
                                        text: r.body,
                                        date: r.createdAt,
                                        role: "Konsjerż",
                                        name: r.authorName,
                                        icon: "bell.fill",
                                        iconTint: .green,
                                        photo: Self.decodePhoto(r.photo),
                                        maxWidth: maxBubble
                                    )
                                } else {
                                    staffBubble(
                                        text: r.body,
                                        date: r.createdAt,
                                        role: "Administrator",
                                        name: r.authorName,
                                        icon: "building.2.fill",
                                        iconTint: .blue,
                                        photo: Self.decodePhoto(r.photo),
                                        maxWidth: maxBubble
                                    )
                                }
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(.vertical, 12)
                    }
                    .onAppear { proxy.scrollTo("bottom") }
                    .onChange(of: fullTicket?.replies?.count) { _, _ in
                        withAnimation { proxy.scrollTo("bottom") }
                    }
                }
            }

            Divider()

            if let err = sendError {
                Text(err).font(.caption).foregroundStyle(.red).padding(.horizontal)
            }

            // Miniatura załącznika nad polem tekstu — usuwalna przed wysyłką.
            if let preview = replyPhotoPreview {
                HStack {
                    ZStack(alignment: .topTrailing) {
                        Image(uiImage: preview)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        Button { clearReplyPhoto() } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 19))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, Color.black.opacity(0.6))
                        }
                        .offset(x: 7, y: -7)
                    }
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)
            }

            HStack(spacing: 10) {
                // Załącznik — aparat / biblioteka (confirmationDialog).
                Button { showAttachDialog = true } label: {
                    Image(systemName: "paperclip")
                        .font(.title3)
                        .foregroundStyle(GLColor.accent300(scheme))
                        .frame(width: 36, height: 36)
                }
                .disabled(sending)

                TextField("Odpowiedz...", text: $replyText, axis: .vertical)
                    .lineLimit(1...4)
                    .padding(10)
                    .background(Color(.systemGray6))
                    .cornerRadius(20)

                Button {
                    Task { await sendReply() }
                } label: {
                    if sending {
                        ProgressView().frame(width: 36, height: 36)
                    } else {
                        Image(systemName: "paperplane.fill")
                            .font(.title3)
                            .foregroundStyle(GLColor.accent300(scheme))
                            .frame(width: 36, height: 36)
                    }
                }
                .disabled(replyText.trimmingCharacters(in: .whitespaces).isEmpty || sending)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .confirmationDialog("Dodaj zdjęcie", isPresented: $showAttachDialog, titleVisibility: .visible) {
            Button("Zrób zdjęcie") { showReplyCamera = true }
            Button("Wybierz z biblioteki") { showReplyLibrary = true }
            Button("Anuluj", role: .cancel) {}
        }
        .photosPicker(isPresented: $showReplyLibrary, selection: $replyPhotoItem, matching: .images)
        .onChange(of: replyPhotoItem) { _, item in
            Task { await loadReplyPhoto(item) }
        }
        .fullScreenCover(isPresented: $showReplyCamera) {
            CameraPicker { image in applyReplyPhoto(image) }
                .ignoresSafeArea()
        }
    }

    // MARK: Załącznik odpowiedzi

    private func clearReplyPhoto() {
        replyPhotoItem = nil
        replyPhotoData = nil
        replyPhotoPreview = nil
    }

    /// Wspólny pipeline (aparat + biblioteka): JPEG max bok 1600 px,
    /// quality 0.8 — serwer waliduje data-URI do ~6 MB.
    private func applyReplyPhoto(_ uiImage: UIImage) {
        let resized = uiImage.resizedToMaxDimension(1600)
        if let jpeg = resized.jpegData(compressionQuality: 0.8) {
            replyPhotoData = jpeg
            replyPhotoPreview = UIImage(data: jpeg)
        }
    }

    private func loadReplyPhoto(_ item: PhotosPickerItem?) async {
        guard let item,
              let data = try? await item.loadTransferable(type: Data.self),
              let uiImage = UIImage(data: data) else { return }
        applyReplyPhoto(uiImage)
    }

    /// Bąbel mieszkańca (zalogowanego) — PRAWA strona, akcentowy gradient,
    /// biały tekst, radius 18 (iMessage-style). `photo` = załącznik pierwotnego
    /// zgłoszenia renderowany w obrębie tego samego bąbla.
    @ViewBuilder
    private func residentBubble(
        text: String,
        date: Date,
        isOriginal: Bool,
        photo: UIImage?,
        maxWidth: CGFloat
    ) -> some View {
        VStack(alignment: .trailing, spacing: 4) {
            if isOriginal {
                Text("Twoje zgłoszenie")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let photo {
                Image(uiImage: photo)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: maxWidth)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            Text(text)
                .font(.system(size: 15.5))
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(GLColor.accentGradient(scheme))
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text(Self.timeFmt.string(from: date))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: maxWidth, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.horizontal, 16)
    }

    /// Bąbel administracji/konsjerża — LEWA strona, stonowany systemowy szary,
    /// mały podpis nadawcy (ikona + rola/imię) nad bąblem i godzina pod nim.
    /// Jeśli backend zwrócił `authorName` (Faza 4), pokazujemy
    /// „Anna K. · Konsjerż" — mieszkaniec wie, czy odpowiada admin osiedla
    /// czy konsjerż budynku. `photo` (2026-08-13) — załącznik odpowiedzi.
    @ViewBuilder
    private func staffBubble(
        text: String,
        date: Date,
        role: String,
        name: String?,
        icon: String,
        iconTint: Color,
        photo: UIImage?,
        maxWidth: CGFloat
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: icon).font(.caption2).foregroundStyle(iconTint)
                Text(name.map { "\($0) · \(role)" } ?? role)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.leading, 4)
            if let photo {
                Image(uiImage: photo)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: maxWidth)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            Text(text)
                .font(.system(size: 15.5))
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Color(.systemGray5))
                .foregroundStyle(.primary)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text(Self.timeFmt.string(from: date))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.leading, 4)
        }
        .frame(maxWidth: maxWidth, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
    }

    /// „data:image/jpeg;base64,…" → UIImage (fail-silent).
    private static func decodePhoto(_ photo: String?) -> UIImage? {
        guard let photo,
              let b64 = photo.components(separatedBy: ",").last,
              let data = Data(base64Encoded: b64) else { return nil }
        return UIImage(data: data)
    }

    private func loadFull() async {
        loading = true
        do { fullTicket = try await APIClient.shared.get("/resident/tickets/\(ticket.id)") }
        catch {}
        loading = false
    }

    private func sendReply() async {
        let text = replyText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        sending = true; sendError = nil
        let photoBase64 = replyPhotoData.map { "data:image/jpeg;base64," + $0.base64EncodedString() }
        do {
            struct Body: Encodable { let body: String; let photo: String? }
            let _: TicketReply = try await APIClient.shared.post(
                "/resident/tickets/\(ticket.id)/replies",
                body: Body(body: text, photo: photoBase64)
            )
            replyText = ""
            clearReplyPhoto()
            await loadFull()
        } catch {
            sendError = error.localizedDescription
        }
        sending = false
    }
}

// MARK: - NewTicketView

struct NewTicketView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var category = "ISSUE"
    // Faza 4 — adresat zgłoszenia. ADMIN domyślnie, bo większość spraw
    // (usterki, pytania, opinie) trafia do administratora osiedla. CONCIERGE
    // dla bieżących spraw budynku (paczki, kurierzy, klucze).
    @State private var ticketType = "ADMIN"
    @State private var title = ""
    @State private var bodyText = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var photoData: Data?
    @State private var photoImage: Image?
    /// 2026-08-13 — zdjęcie prosto z aparatu (CameraPicker), obok wyboru
    /// z biblioteki. Wynik idzie przez ten sam pipeline `applyPhoto`.
    @State private var showCamera = false
    @State private var saving = false
    @State private var sendError: String?

    var body: some View {
        NavigationStack {
            Form {
                addresseeSection
                categorySection
                descriptionSection
                photoSection
                if let err = sendError {
                    Section { Text(err).foregroundStyle(.red).font(.caption) }
                }
            }
            .navigationTitle("Zgłoś sprawę")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Anuluj") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Wyślij") { Task { await send() } }
                        .disabled(title.isEmpty || bodyText.isEmpty || saving)
                }
            }
            .onChange(of: photoItem) { _, newItem in
                Task { await loadPhoto(newItem) }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in applyPhoto(image) }
                    .ignoresSafeArea()
            }
        }
    }

    private var addresseeSection: some View {
        Section {
            // Segmented picker — szybki wybór 1-z-2. Etykiety + krótki opis
            // pomocniczy żeby resident wiedział, kiedy wybrać który.
            Picker("Adresat", selection: $ticketType) {
                Label("Administracja", systemImage: "building.2.fill").tag("ADMIN")
                Label("Konsjerż", systemImage: "bell.fill").tag("CONCIERGE")
            }
            .pickerStyle(.segmented)
            Text(
                ticketType == "ADMIN"
                ? "Sprawy techniczne, opłaty, regulamin osiedla."
                : "Bieżące sprawy budynku — paczki, kurierzy, klucze."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        } header: {
            Text("Do kogo zgłoszenie?")
        }
    }

    private var categorySection: some View {
        Section("Temat sprawy") {
            Picker("Kategoria", selection: $category) {
                ForEach(ticketCategories, id: \.value) { cat in
                    Label(cat.label, systemImage: cat.icon).tag(cat.value)
                }
            }
            .pickerStyle(.navigationLink)
            TextField("Krótki tytuł", text: $title)
        }
    }

    private var descriptionSection: some View {
        Section("Opis") {
            TextField("Opisz sprawę...", text: $bodyText, axis: .vertical)
                .lineLimit(5...10)
        }
    }

    @ViewBuilder
    private var photoSection: some View {
        Section("Zdjęcie (opcjonalnie)") {
            // 2026-08-13 — dwie drogi: aparat (CameraPicker) i biblioteka
            // (PhotosPicker). Oba lądują w tym samym `applyPhoto`.
            Button { showCamera = true } label: {
                HStack {
                    Image(systemName: "camera.fill").foregroundStyle(.blue)
                    Text("Zrób zdjęcie")
                        .foregroundStyle(.primary)
                }
            }
            PhotosPicker(selection: $photoItem, matching: .images) {
                HStack {
                    Image(systemName: "photo.on.rectangle").foregroundStyle(.blue)
                    Text(photoData == nil ? "Wybierz z biblioteki" : "Zmień zdjęcie")
                }
            }
            if let img = photoImage {
                img
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 200)
                    .cornerRadius(8)
                Button(role: .destructive) {
                    photoItem = nil
                    photoData = nil
                    photoImage = nil
                } label: {
                    Label("Usuń zdjęcie", systemImage: "trash").font(.caption)
                }
            }
        }
    }

    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        guard let uiImage = UIImage(data: data) else { return }
        applyPhoto(uiImage)
    }

    /// Wspólny pipeline kompresji (biblioteka + aparat) — JPEG max 800 px,
    /// quality 0.7, jak dotychczas przy tworzeniu zgłoszenia.
    private func applyPhoto(_ uiImage: UIImage) {
        let compressed = uiImage.resizedToMaxDimension(800)
        if let jpeg = compressed.jpegData(compressionQuality: 0.7) {
            photoData = jpeg
            photoImage = Image(uiImage: UIImage(data: jpeg) ?? uiImage)
        }
    }

    private func send() async {
        saving = true; sendError = nil
        let photoBase64 = photoData.map { "data:image/jpeg;base64," + $0.base64EncodedString() }
        do {
            let _: Ticket = try await APIClient.shared.post(
                "/resident/tickets",
                body: CreateTicketBody(
                    category: category,
                    title: title,
                    body: bodyText,
                    photo: photoBase64,
                    type: ticketType
                )
            )
            dismiss()
        } catch {
            sendError = error.localizedDescription
        }
        saving = false
    }
}

// MARK: - UIImage helper

extension UIImage {
    func resizedToMaxDimension(_ maxDim: CGFloat) -> UIImage {
        let scale = min(maxDim / size.width, maxDim / size.height, 1)
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        // format.scale = 1 — bez tego renderer mnoży rozmiar przez skalę
        // ekranu (@3x) i „800px" robi się 2400px (~1-2 MB payload). Ten sam
        // fix co w GlassTicketsSheet.loadPhoto (2026-07-15); tu konieczny
        // od 2026-08-13, bo odpowiedzi kompresujemy do 1600 px (limit
        // serwera ~6 MB — 4800 px z aparatu 48 Mpix by go przebiło).
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: newSize, format: format)
        return renderer.image { _ in draw(in: CGRect(origin: .zero, size: newSize)) }
    }
}

// MARK: - CameraPicker (2026-08-13)
//
// UIImagePickerController z sourceType .camera — SwiftUI nie ma natywnego
// odpowiednika. Wynik (UIImage) wraca callbackiem i idzie przez TEN SAM
// pipeline kompresji co zdjęcia z biblioteki. W symulatorze aparatu nie ma —
// guard `isSourceTypeAvailable` zostawia domyślną bibliotekę zamiast crasha
// (aparat testowany przez właściciela na sprzęcie). Wymaga
// NSCameraUsageDescription w Info.plist (dodane w obu targetach).

struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            picker.sourceType = .camera
        }
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage {
                parent.onImage(image)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
