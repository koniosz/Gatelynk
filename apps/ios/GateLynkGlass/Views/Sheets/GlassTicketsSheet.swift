import SwiftUI
import PhotosUI
import UIKit

// MARK: - Sheet Zgłoszenia
//
// Lista usterek z 3 stanami (OPEN/IN_PROGRESS/DONE — design: oczekuje /
// w naprawie / rozwiązane) + formularz nowego zgłoszenia w tym samym
// sheecie. POST /resident/tickets (CreateTicketBody, kategorie z głównej
// apki: ISSUE/QUESTION/FEEDBACK).
//
// 2026-07-15: formularz przyjmuje zdjęcie (PhotosPicker → JPEG base64,
// max 800px — jak NewTicketView głównej apki), a tap na zgłoszenie otwiera
// szczegóły: status, treść, zdjęcie i KORESPONDENCJĘ (odpowiedzi
// administracji/konsjerża, GET /resident/tickets/:id) + własna odpowiedź
// (POST /resident/tickets/:id/replies).

struct GlassTicketsSheet: View {
    let tickets: [Ticket]
    /// Deep-link z pusha `ticket_reply` (2026-08-13) — otwórz od razu wątek
    /// tego zgłoszenia zamiast listy. Nil = normalne wejście z kafla.
    var initialTicketId: Int? = nil
    let onReload: () async -> Void
    let onClose: () -> Void

    @Environment(GlassToastCenter.self) private var toast

    private enum Mode: Equatable { case list, form }

    @State private var mode: Mode = .list
    @State private var title = ""
    @State private var bodyText = ""
    @State private var category = "ISSUE"
    @State private var submitting = false
    @State private var formError: String?

    // Zdjęcie do zgłoszenia (2026-07-15).
    @State private var photoItem: PhotosPickerItem?
    @State private var photoData: Data?
    @State private var photoPreview: UIImage?

    // Szczegóły zgłoszenia (2026-07-15) — tap na wiersz.
    @State private var detailTicket: Ticket?
    /// Pełny ticket z replies (lista z GET /resident/tickets nie zawsze
    /// je niesie) — doładowywany po otwarciu.
    @State private var fullDetail: Ticket?
    @State private var replyText = ""
    @State private var sendingReply = false

    // Załącznik odpowiedzi (2026-08-13) — aparat albo biblioteka, wybór
    // przez confirmationDialog przy spinaczu; miniatura nad polem tekstu,
    // usuwalna przed wysyłką. POST .../replies dostaje `photo`
    // (data:image/jpeg;base64 — konwencja jak Ticket.photo).
    @State private var replyPhotoItem: PhotosPickerItem?
    @State private var replyPhotoData: Data?
    @State private var replyPhotoPreview: UIImage?
    @State private var showReplyAttachDialog = false
    @State private var showReplyCamera = false
    @State private var showReplyLibrary = false
    /// Aparat w formularzu NOWEGO zgłoszenia (obok wyboru z biblioteki).
    @State private var showFormCamera = false

    // Swipe-to-delete (2026-07-13) — wspólny GlassSwipeToDelete; pełny
    // swipe usuwa zgłoszenie od razu (DELETE /resident/tickets/:id).
    @State private var swipedTicketId: Int?

    var body: some View {
        Group {
            if let t = detailTicket {
                detailContent(t)
            } else {
                switch mode {
                case .list: listContent
                case .form: formContent
                }
            }
        }
        // Deep-link z pusha: otwórz wątek initialTicketId. `id:` — gdy sheet
        // już jest otwarty i przychodzi push o INNYM zgłoszeniu, task odpala
        // się ponownie i przełącza wątek.
        .task(id: initialTicketId) {
            guard let id = initialTicketId, detailTicket?.id != id else { return }
            if let t = tickets.first(where: { $0.id == id }) {
                openDetail(t)
            } else if let t: Ticket = try? await APIClient.shared.get("/resident/tickets/\(id)") {
                // Ticket spoza przekazanej listy (świeża odpowiedź zanim
                // Home zdążył odświeżyć) — dociągnięty pojedynczo.
                detailTicket = t
                fullDetail = t
                replyText = ""
                GlassTicketSeenStore.markSeen(t)
            }
        }
        // Załączniki zdjęciowe (2026-08-13): aparat (fullScreenCover) +
        // biblioteka (photosPicker) dla odpowiedzi i formularza. Wspólne
        // miejsce — modyfikatory prezentacji działają dla obu trybów sheetu.
        .confirmationDialog("Dodaj zdjęcie", isPresented: $showReplyAttachDialog, titleVisibility: .visible) {
            Button("Zrób zdjęcie") { showReplyCamera = true }
            Button("Wybierz z biblioteki") { showReplyLibrary = true }
            Button("Anuluj", role: .cancel) {}
        }
        .photosPicker(isPresented: $showReplyLibrary, selection: $replyPhotoItem, matching: .images)
        .onChange(of: replyPhotoItem) { _, item in
            Task { await loadReplyPhoto(item) }
        }
        .fullScreenCover(isPresented: $showReplyCamera) {
            GlassCameraPicker { image in applyReplyPhoto(image) }
                .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $showFormCamera) {
            GlassCameraPicker { image in applyFormPhoto(image) }
                .ignoresSafeArea()
        }
    }

    // MARK: Załącznik odpowiedzi (2026-08-13)

    private func clearReplyPhoto() {
        replyPhotoItem = nil
        replyPhotoData = nil
        replyPhotoPreview = nil
    }

    /// Załącznik odpowiedzi: JPEG max bok 1600 px, quality 0.8 —
    /// serwer waliduje data-URI do ~6 MB.
    private func applyReplyPhoto(_ uiImage: UIImage) {
        if let jpeg = Self.compressedJpeg(uiImage, maxDim: 1600, quality: 0.8) {
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

    // MARK: Lista

    private var listContent: some View {
        VStack(spacing: 9) {
            GlassSheetHeader(kicker: "Zgłoszenia", title: "Twoje zgłoszenia", onClose: onClose)

            if tickets.isEmpty {
                GlassSheetEmptyState(
                    icon: "wrench.and.screwdriver",
                    text: "Brak zgłoszeń. Coś nie działa?\nDaj znać administracji."
                )
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(spacing: 9) {
                        ForEach(sortedTickets) { t in
                            GlassSwipeToDelete(
                                id: t.id,
                                openId: $swipedTicketId,
                                // Audyt UX 2026-09-21: usuwanie bez pytania +
                                // kosz bez nazwy → nazwana akcja z potwierdzeniem.
                                confirmTitle: "Usunąć zgłoszenie „\(t.title)\"?",
                                confirmMessage: "Zgłoszenie i korespondencja znikną z Twojej listy. Tej operacji nie można cofnąć.",
                                destructiveLabel: "Usuń zgłoszenie",
                                onDelete: { await deleteTicket(t) },
                                onTap: { openDetail(t) }
                            ) { row(t) }
                        }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)

                Text("Dotknij zgłoszenie, aby zobaczyć korespondencję. Przesuń w lewo, aby usunąć.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .padding(.vertical, 4)
            }

            GlassButton(title: "+ Nowe zgłoszenie") {
                mode = .form
            }
            .padding(.top, 6)
        }
    }

    /// DELETE /resident/tickets/:id — twarde usunięcie własnego zgłoszenia
    /// wraz z odpowiedziami (endpoint dodany 2026-07-13).
    /// Zwraca sukces — komponent swipe cofa animację przy błędzie.
    private func deleteTicket(_ t: Ticket) async -> Bool {
        do {
            let _: EmptyResponse = try await APIClient.shared.delete("/resident/tickets/\(t.id)")
            await onReload()
            toast.show("Zgłoszenie usunięte")
            return true
        } catch {
            toast.show("Nie udało się usunąć zgłoszenia", error: true)
            return false
        }
    }

    private var sortedTickets: [Ticket] {
        let open = tickets.filter { $0.status != "DONE" }
        let done = tickets.filter { $0.status == "DONE" }.prefix(3)
        return open + Array(done)
    }

    private func row(_ t: Ticket) -> some View {
        GlassActionRow(
            orbGradient: orbGradient(t.status),
            orbIcon: orbIcon(t.status),
            title: t.title,
            subtitle: "#\(t.id) · \(GlassFormat.relative.localizedString(for: t.createdAt, relativeTo: Date()))",
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
        case "OPEN":        return GlassColor.orbAmber1
        case "IN_PROGRESS": return GlassColor.successLight
        default:            return .white.opacity(0.5)
        }
    }

    private func orbGradient(_ s: String) -> [Color] {
        switch s {
        case "OPEN":        return [GlassColor.orbAmber1, GlassColor.orbAmber2]
        case "IN_PROGRESS": return [GlassColor.accentBlue, GlassColor.success]
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
            GlassSheetHeader(kicker: "Zgłoszenia", title: "Nowe zgłoszenie", onClose: onClose)

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
                RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                    .fill(Color.white.opacity(0.08))
            }
            .overlay {
                RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.16), lineWidth: 1)
            }

            photoSection

            if let formError {
                Text(formError)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(GlassColor.dangerSoft)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            GlassButton(title: "Wyślij zgłoszenie", busyText: "Wysyłam…", isBusy: submitting) {
                Task { await submit() }
            }

            GlassButton(title: "Wróć", style: .ghost) {
                mode = .list
            }
        }
    }

    // MARK: Zdjęcie do zgłoszenia (2026-07-15)

    private var photoSection: some View {
        VStack(spacing: 9) {
            // 2026-08-13 — dwie drogi na zdjęcie: aparat (GlassCameraPicker)
            // i biblioteka (PhotosPicker). Oba lądują w `applyFormPhoto`.
            HStack(spacing: 9) {
                Button { showFormCamera = true } label: {
                    photoActionLabel(icon: "camera.fill", text: "Zrób zdjęcie")
                }
                .buttonStyle(.plain)

                PhotosPicker(selection: $photoItem, matching: .images) {
                    photoActionLabel(
                        icon: "photo.on.rectangle",
                        text: photoData == nil ? "Z biblioteki" : "Zmień zdjęcie"
                    )
                }
            }
            .onChange(of: photoItem) { _, item in
                Task { await loadPhoto(item) }
            }

            if let img = photoPreview {
                ZStack(alignment: .topTrailing) {
                    Image(uiImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(height: 120)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: GlassRadius.row, style: .continuous))

                    Button {
                        photoItem = nil
                        photoData = nil
                        photoPreview = nil
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 26, height: 26)
                            .background { Circle().fill(Color.black.opacity(0.55)) }
                    }
                    .buttonStyle(.plain)
                    .padding(7)
                }
            }
        }
    }

    /// Kapsułka akcji zdjęciowej (aparat / biblioteka) — wspólny wygląd
    /// obu przycisków formularza.
    private func photoActionLabel(icon: String, text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
            Text(text)
                .font(.system(size: 13, weight: .semibold))
        }
        .foregroundStyle(GlassColor.accentLight)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11)
        .background { Capsule().fill(Color.white.opacity(0.08)) }
        .overlay { Capsule().strokeBorder(GlassColor.accentLight.opacity(0.35), lineWidth: 1) }
    }

    /// Zdjęcie z galerii → wspólny pipeline `applyFormPhoto`.
    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item,
              let data = try? await item.loadTransferable(type: Data.self),
              let uiImage = UIImage(data: data) else { return }
        applyFormPhoto(uiImage)
    }

    /// Wspólny pipeline formularza (biblioteka + aparat, 2026-08-13):
    /// JPEG max 800px, ~0.7 quality (payload < ~300 KB) — jak dotychczas.
    private func applyFormPhoto(_ uiImage: UIImage) {
        if let jpeg = Self.compressedJpeg(uiImage, maxDim: 800, quality: 0.7) {
            photoData = jpeg
            photoPreview = UIImage(data: jpeg)
        }
    }

    /// Skalowanie + JPEG. format.scale = 1 — bez tego renderer mnoży rozmiar
    /// przez skalę ekranu (@3x) i „800px" robi się 2400px (~1-2 MB payload).
    private static func compressedJpeg(_ uiImage: UIImage, maxDim: CGFloat, quality: CGFloat) -> Data? {
        let scale = min(maxDim / max(uiImage.size.width, uiImage.size.height), 1)
        let target = CGSize(width: uiImage.size.width * scale, height: uiImage.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            uiImage.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: quality)
    }

    // MARK: Szczegóły zgłoszenia + korespondencja (2026-07-15)

    private func openDetail(_ t: Ticket) {
        // Otwarcie wątku = odpowiedź obsługi przeczytana → znika z „Wymaga
        // uwagi" na Domu (dopóki nie przyjdzie kolejna).
        GlassTicketSeenStore.markSeen(t)
        detailTicket = t
        fullDetail = nil
        replyText = ""
        clearReplyPhoto()
        Task { await loadDetail(t.id) }
    }

    /// GET /resident/tickets/:id — pełny ticket z odpowiedziami.
    private func loadDetail(_ id: Int) async {
        if let full: Ticket = try? await APIClient.shared.get("/resident/tickets/\(id)") {
            fullDetail = full
            GlassTicketSeenStore.markSeen(full)
        }
    }

    private func detailContent(_ t: Ticket) -> some View {
        let ticket = fullDetail ?? t
        return VStack(spacing: 12) {
            GlassSheetHeader(kicker: "Zgłoszenie #\(ticket.id)", title: ticket.title, onClose: onClose)

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 10) {
                    statusCard(ticket)

                    // Wątek jak iMessage (2026-08-13): pierwotne zgłoszenie
                    // to pierwszy bąbel mieszkańca (akcentowy gradient,
                    // zdjęcie jako załącznik W bąblu), odpowiedzi
                    // administracji/konsjerża po lewej — spójna rozmowa,
                    // nie osobne sekcje.
                    residentBubble(
                        text: ticket.body,
                        date: ticket.createdAt,
                        isOriginal: true,
                        photo: Self.decodePhoto(ticket.photo)
                    )

                    let replies = ticket.replies ?? []
                    if replies.isEmpty {
                        HStack(spacing: 8) {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.system(size: 13))
                            Text(fullDetail == nil ? "Wczytuję korespondencję…" : "Brak odpowiedzi — administracja odpisze tutaj.")
                                .font(.system(size: 12))
                        }
                        .foregroundStyle(.white.opacity(0.5))
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 10)
                    } else {
                        ForEach(replies) { r in
                            bubble(r)
                        }
                    }
                }
                .padding(.bottom, 6)
            }
            .scrollBounceBehavior(.basedOnSize)

            // Odpowiedź mieszkańca (+ załącznik zdjęciowy 2026-08-13)
            VStack(spacing: 8) {
                // Miniatura załącznika nad polem tekstu — usuwalna przed wysyłką.
                if let preview = replyPhotoPreview {
                    HStack {
                        ZStack(alignment: .topTrailing) {
                            Image(uiImage: preview)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 58, height: 58)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            Button { clearReplyPhoto() } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(.white)
                                    .frame(width: 20, height: 20)
                                    .background { Circle().fill(Color.black.opacity(0.55)) }
                            }
                            .buttonStyle(.plain)
                            .offset(x: 6, y: -6)
                        }
                        Spacer()
                    }
                }

                HStack(spacing: 8) {
                    // Załącznik — aparat / biblioteka (confirmationDialog).
                    Button { showReplyAttachDialog = true } label: {
                        Image(systemName: "paperclip")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(GlassColor.accentLight)
                            .frame(width: 40, height: 40)
                            .background { Circle().fill(Color.white.opacity(0.08)) }
                            .overlay { Circle().strokeBorder(Color.white.opacity(0.16), lineWidth: 1) }
                    }
                    .buttonStyle(.plain)
                    .disabled(sendingReply)

                    TextField("", text: $replyText, prompt: Text("Napisz odpowiedź…").foregroundStyle(.white.opacity(0.5)))
                        .font(.system(size: 14))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 11)
                        .background { Capsule().fill(Color.white.opacity(0.08)) }
                        .overlay { Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 1) }

                    Button {
                        Task { await sendReply(ticket) }
                    } label: {
                        ZStack {
                            Circle().fill(GlassColor.accentGradient)
                            if sendingReply {
                                ProgressView().tint(.white).scaleEffect(0.7)
                            } else {
                                Image(systemName: "paperplane.fill")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(.white)
                            }
                        }
                        .frame(width: 40, height: 40)
                    }
                    .buttonStyle(.plain)
                    .disabled(sendingReply || replyText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            GlassButton(title: "Wróć", style: .ghost) {
                detailTicket = nil
                fullDetail = nil
                clearReplyPhoto()
            }
        }
    }

    /// Karta statusu: kropka + etykieta, kategoria, adresat i data.
    private func statusCard(_ t: Ticket) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(statusLine(t.status))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(statusColor(t.status))
                HStack(spacing: 6) {
                    Text(Self.categories.first(where: { $0.key == t.category })?.label ?? t.category)
                    Text("·")
                    Text(t.type == "CONCIERGE" ? "Konsjerż" : "Administracja")
                    Text("·")
                    Text(GlassFormat.relative.localizedString(for: t.createdAt, relativeTo: Date()))
                }
                .font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.55))
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .glassCard()
    }

    // MARK: Bąble wątku (iMessage-style, 2026-08-13)

    /// Max szerokość bąbla ~75% szerokości contentu sheeta
    /// (ekran − 2×18 padding kontenera; na standardowym iPhone ≈ 355pt).
    private static let maxBubbleWidth: CGFloat = 270

    /// Godzina wiadomości (krótka data + czas, pl) — iMessage-style zamiast
    /// relatywnego „2 godz. temu" w wątku.
    private static let timeFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        f.locale = Locale(identifier: "pl_PL")
        return f
    }()

    /// Bąbel mieszkańca (zalogowanego) — PRAWA strona, gradient akcentowy,
    /// biały tekst, radius 18. `photo` = zdjęcie pierwotnego zgłoszenia jako
    /// załącznik w obrębie tego samego bąbla.
    private func residentBubble(
        text: String,
        date: Date,
        isOriginal: Bool,
        photo: UIImage? = nil
    ) -> some View {
        VStack(alignment: .trailing, spacing: 4) {
            if isOriginal {
                Text("Twoje zgłoszenie")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.5))
            }
            if let photo {
                Image(uiImage: photo)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: Self.maxBubbleWidth)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(GlassColor.accentGradient)
                }
            Text(Self.timeFmt.string(from: date))
                .font(.system(size: 10))
                .foregroundStyle(.white.opacity(0.4))
        }
        .frame(maxWidth: Self.maxBubbleWidth, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    /// Bubble korespondencji: mieszkaniec (RESIDENT) po prawej w gradiencie
    /// akcentowym, administracja/konsjerż po lewej w stonowanym białym
    /// (opacity 0.10) z podpisem nadawcy i godziną.
    private func bubble(_ r: TicketReply) -> some View {
        let mine = r.authorType == "RESIDENT"
        let staffLabel = r.authorType == "CONCIERGE" ? "Konsjerż" : "Administracja"
        return VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
            if !mine {
                HStack(spacing: 5) {
                    Image(systemName: r.authorType == "CONCIERGE" ? "bell.badge.fill" : "building.2.fill")
                        .font(.system(size: 10))
                    Text(r.authorName.map { "\(staffLabel) · \($0)" } ?? staffLabel)
                        .font(.system(size: 10.5, weight: .semibold))
                }
                .foregroundStyle(r.authorType == "CONCIERGE" ? GlassColor.successLight : GlassColor.accentLight)
                .padding(.leading, 4)
            }
            // Załącznik zdjęciowy odpowiedzi (2026-08-13) — w obrębie bąbla.
            if let img = Self.decodePhoto(r.photo) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: Self.maxBubbleWidth)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            Text(r.body)
                .font(.system(size: 14))
                .foregroundStyle(mine ? .white : .white.opacity(0.92))
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(mine ? AnyShapeStyle(GlassColor.accentGradient) : AnyShapeStyle(Color.white.opacity(0.10)))
                }
            Text(Self.timeFmt.string(from: r.createdAt))
                .font(.system(size: 10))
                .foregroundStyle(.white.opacity(0.4))
        }
        .frame(maxWidth: Self.maxBubbleWidth, alignment: mine ? .trailing : .leading)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }

    /// POST /resident/tickets/:id/replies (+ opcjonalne `photo`) + odświeżenie wątku.
    private func sendReply(_ t: Ticket) async {
        let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sendingReply = true
        let photoBase64 = replyPhotoData.map { "data:image/jpeg;base64," + $0.base64EncodedString() }
        do {
            struct ReplyBody: Encodable { let body: String; let photo: String? }
            let _: TicketReply = try await APIClient.shared.post(
                "/resident/tickets/\(t.id)/replies",
                body: ReplyBody(body: text, photo: photoBase64)
            )
            replyText = ""
            clearReplyPhoto()
            await loadDetail(t.id)
            await onReload()
        } catch {
            toast.show("Nie udało się wysłać odpowiedzi", error: true)
        }
        sendingReply = false
    }

    /// „data:image/jpeg;base64,…" → UIImage (fail-silent).
    private static func decodePhoto(_ photo: String?) -> UIImage? {
        guard let photo,
              let b64 = photo.components(separatedBy: ",").last,
              let data = Data(base64Encoded: b64) else { return nil }
        return UIImage(data: data)
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
                                Capsule().fill(GlassColor.accentGradient)
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
        // Jedno dotknięcie = jedno zgłoszenie (brak duplikatów).
        guard !submitting else { return }
        submitting = true
        formError = nil
        let photoBase64 = photoData.map { "data:image/jpeg;base64," + $0.base64EncodedString() }
        do {
            let _: Ticket = try await APIClient.shared.post(
                "/resident/tickets",
                body: CreateTicketBody(category: category, title: t, body: b, photo: photoBase64, type: nil)
            )
            await onReload()
            toast.show("Zgłoszenie wysłane")
            title = ""; bodyText = ""
            photoItem = nil; photoData = nil; photoPreview = nil
            mode = .list
        } catch {
            formError = GlassErrorText.save(error, fallback: "Nie udało się wysłać zgłoszenia. Spróbuj ponownie.")
        }
        submitting = false
    }
}

// MARK: - GlassCameraPicker (2026-08-13)
//
// UIImagePickerController z sourceType .camera — SwiftUI nie ma natywnego
// odpowiednika. Kopia CameraPicker z targetu GateLynk (TicketsView.swift),
// który nie jest kompilowany w Glass (wzorzec jak GlassSplashLoadingDots).
// Wynik (UIImage) wraca callbackiem i idzie przez ten sam pipeline
// kompresji co zdjęcia z biblioteki. W symulatorze aparatu nie ma — guard
// `isSourceTypeAvailable` zostawia domyślną bibliotekę zamiast crasha
// (aparat testowany przez właściciela na sprzęcie). Wymaga
// NSCameraUsageDescription w Info.plist targetu Glass.

struct GlassCameraPicker: UIViewControllerRepresentable {
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
        private let parent: GlassCameraPicker
        init(_ parent: GlassCameraPicker) { self.parent = parent }

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
