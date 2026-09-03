import SwiftUI

// MARK: - AssistantView
//
// Conversation UI for the Edge AI assistant. User types a Polish question
// (e.g. "Ile białych aut dziś wjechało?"), we POST to the Mac Mini Edge
// (`http://192.168.1.127:4000/assistant/ask`) and render bubbles.
//
// Layout:
//   • Header: small toggle row — smart mode + edge host picker (LAN/Tailscale)
//   • ScrollView of message bubbles (user right purple, AI left glass)
//   • Follow-up chips under the latest AI bubble (smart mode only)
//   • Composer pinned to bottom — TextField + send button + spinner
//
// Persistence: tylko `assistantSmartMode` (@AppStorage). Host picker
// usunięty 2026-05-19 — wszystko leci przez Cloud HTTPS z JWT auth.
// History in-memory only — out of scope for now.

struct AssistantView: View {
    @Environment(\.colorScheme) private var scheme
    @AppStorage("appTheme") private var appTheme = "dark"

    @AppStorage("assistantSmartMode") private var smartMode = true

    /// Optional question to auto-send on appear. Used when AssistantView jest
    /// otwierany z HomeView aiBar — user wpisał pytanie tam, my je tu fire-and-forget.
    let initialQuestion: String?

    init(initialQuestion: String? = nil) {
        self.initialQuestion = initialQuestion
    }

    @State private var draft: String = ""
    @State private var messages: [AssistantMessage] = []
    @State private var isLoading = false
    // FAZA 8.h.22 — aktualny komunikat postępu ("Szukam w bazie…" itd.)
    @State private var loadingStage = ""
    @State private var errorMessage: String?
    @State private var didProcessInitial = false
    @FocusState private var inputFocused: Bool

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                GLColor.bg1(scheme)
                    // Bg ignoruje ALL safe areas oprócz keyboard — pełen kolor
                    // do krawędzi ekranu, ale NIE rozciąga się pod klawiaturę
                    // (inaczej ZStack rośnie pod composer i ten się nie unosi).
                    .ignoresSafeArea(.container, edges: .all)

                // Messages ScrollView wypełnia całość, a settingsBar/composer
                // są wstrzykiwane przez `.safeAreaInset` — to dedykowany pattern
                // SwiftUI dla chat-style layoutów: ScrollView dostaje proper
                // keyboard avoidance, a inset-y są ZAWSZE ponad klawiaturą.
                messagesScroll
                    .safeAreaInset(edge: .top, spacing: 0) {
                        settingsBar
                            .padding(.horizontal, 16)
                            .padding(.top, 12)
                            .padding(.bottom, 8)
                            .background(GLColor.bg1(scheme))
                    }
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        composer
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(GLColor.bg2(scheme))
                            .overlay(
                                Rectangle()
                                    .frame(height: 1)
                                    .foregroundStyle(GLColor.borderSubtle(scheme)),
                                alignment: .top,
                            )
                    }

                if let err = errorMessage {
                    errorBanner(err)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 80)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .navigationTitle("Asystent")
            .navigationBarTitleDisplayMode(.inline)
            .preferredColorScheme(AppTheme(rawValue: appTheme)?.colorScheme ?? .dark)
            // Toolbar nad klawiaturą — explicit "Gotowe" do dismiss focusu,
            // gdyby user chciał zamknąć keyboard bez wysyłania.
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Gotowe") { inputFocused = false }
                        .font(.system(size: 15, weight: .semibold))
                }
            }
            .onAppear {
                // Auto-send pytania jeśli zostało podane przy init (np. z HomeView).
                // Guard `didProcessInitial` — nawigacja może wyzwolić onAppear wielokrotnie.
                if let q = initialQuestion?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !q.isEmpty,
                   !didProcessInitial {
                    didProcessInitial = true
                    Task { await send(q) }
                }
            }
        }
    }

    // MARK: - Settings bar

    private var settingsBar: some View {
        HStack(spacing: 10) {
            // Smart-mode toggle. `assistantSmartMode` persists across launches.
            Toggle(isOn: $smartMode) {
                HStack(spacing: 6) {
                    Image(systemName: "wand.and.stars")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(GLColor.accent300(scheme))
                    Text("Tryb mądry")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(GLColor.textPrimary(scheme))
                }
            }
            .toggleStyle(.switch)
            .tint(GLColor.accent300(scheme))
            .frame(maxWidth: 200)

            Spacer()
        }
    }

    // MARK: - Messages

    private var messagesScroll: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if messages.isEmpty {
                        emptyState
                            .padding(.top, 60)
                            .padding(.horizontal, 24)
                    }

                    ForEach(messages) { msg in
                        messageBubble(msg)
                            .id(msg.id)
                    }

                    if let last = messages.last,
                       last.role == .assistant,
                       let followUps = last.followUps,
                       !followUps.isEmpty {
                        followUpChips(followUps)
                            .padding(.horizontal, 14)
                            .padding(.top, 4)
                    }

                    if isLoading {
                        loadingBubble
                            .id("loading")
                    }

                    Color.clear.frame(height: 8).id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
            }
            .onChange(of: messages.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: isLoading) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "sparkles")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(
                    LinearGradient(
                        colors: [GLColor.accent300(scheme), GLColor.accent400(scheme)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing,
                    ),
                )

            Text("Zapytaj GateLynk AI")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(GLColor.textPrimary(scheme))

            Text("Asystent odpowie na pytania o paczki, pojazdy, ostatnie wjazdy. Spróbuj np. \u{201E}Ile białych aut dziś wjechało?\u{201D}")
                .font(.system(size: 13))
                .foregroundStyle(GLColor.textSecondary(scheme))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)

            VStack(spacing: 8) {
                ForEach(samplePrompts, id: \.self) { prompt in
                    Button {
                        Task { await send(prompt) }
                    } label: {
                        HStack {
                            Text(prompt)
                                .font(.system(size: 13))
                                .foregroundStyle(GLColor.textPrimary(scheme))
                                .multilineTextAlignment(.leading)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(GLColor.accent300(scheme))
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(GLColor.bg2(scheme))
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func messageBubble(_ msg: AssistantMessage) -> some View {
        switch msg.role {
        case .user:
            HStack {
                Spacer(minLength: 40)
                userBubble(msg.text)
            }
        case .assistant:
            HStack(alignment: .top, spacing: 8) {
                assistantAvatar
                aiBubble(msg)
                Spacer(minLength: 40)
            }
        }
    }

    private func userBubble(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 14.5))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(GLColor.accentGradient(scheme))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .glShadow(.sm)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func aiBubble(_ msg: AssistantMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(msg.text)
                .font(.system(size: 14.5))
                .foregroundStyle(GLColor.textPrimary(scheme))
                .fixedSize(horizontal: false, vertical: true)

            if let intent = msg.intent, !intent.isEmpty {
                metaRow(msg)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
        )
        .glShadow(.sm)
    }

    private func metaRow(_ msg: AssistantMessage) -> some View {
        HStack(spacing: 6) {
            if let intent = msg.intent {
                GLPill(text: intent, style: .accent)
            }
            if let ms = msg.totalMs {
                Text("\(ms) ms")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(GLColor.textTertiary(scheme))
            }
            if let model = msg.modelUsed, !model.isEmpty {
                Text("· \(model)")
                    .font(.system(size: 10))
                    .foregroundStyle(GLColor.textTertiary(scheme))
            }
        }
    }

    private var assistantAvatar: some View {
        ZStack {
            Circle().fill(GLColor.accent300(scheme).opacity(0.18))
            Image(systemName: "sparkles")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(GLColor.accent300(scheme))
        }
        .frame(width: 28, height: 28)
    }

    private func followUpChips(_ chips: [String]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(chips, id: \.self) { chip in
                    Button {
                        Task { await send(chip) }
                    } label: {
                        Text(chip)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(GLColor.accent300(scheme))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(GLColor.accent300(scheme).opacity(0.12))
                            .clipShape(Capsule())
                            .overlay(
                                Capsule().stroke(GLColor.accent300(scheme).opacity(0.3), lineWidth: 1),
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // FAZA 8.h.22 (2026-06-12) — staged progress zamiast statycznego "Myślę…".
    // Decyzja UX (Konrad): user nie ma czekać i się denerwować — komunikaty
    // "Szukam w bazie…" / "Przeszukuję rejestry…" zmieniają się w trakcie,
    // dobrane pod TREŚĆ pytania (brand → kamery, harmonogram → ogłoszenia,
    // tablica → rejestr wjazdów). Etapy są symulowane client-side (backend
    // nie streamuje trace), ale timing dobrany pod realny flow ai-prototype:
    // classify (~0.5s) → SQL/KB (~1-3s) → Bielik (3-40s).
    private var loadingBubble: some View {
        HStack(alignment: .top, spacing: 8) {
            assistantAvatar
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                    .tint(GLColor.accent300(scheme))
                Text(loadingStage.isEmpty ? "Analizuję pytanie…" : loadingStage)
                    .font(.system(size: 13))
                    .foregroundStyle(GLColor.textSecondary(scheme))
                    .contentTransition(.opacity)
                    .animation(.easeInOut(duration: 0.3), value: loadingStage)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(GLColor.bg2(scheme))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
            )
            Spacer(minLength: 40)
        }
    }

    /// Sekwencja etapów dopasowana do treści pytania. Pierwsza zawsze
    /// "Analizuję pytanie…", ostatnia zostaje na ekranie aż przyjdzie
    /// odpowiedź (long-tail "dużo danych" po ~12s uspokaja przy wolnym LLM).
    private static func progressStages(for question: String) -> [(text: String, holdSeconds: Double)] {
        let q = question.lowercased()

        let middle: [(String, Double)]
        if q.range(of: #"dhl|dpd|inpost|uber|bolt|glovo|wolt|frisco|ikea|media|kurier|dostaw"#,
                   options: .regularExpression) != nil {
            middle = [("Sprawdzam detekcje kamer…", 2.2),
                      ("Przeglądam rozpoznane napisy…", 2.2)]
        } else if q.range(of: #"harmonogram|odbi[oó]r|śmieci|smieci|planowan|przerw|wywoz|wywóz"#,
                          options: .regularExpression) != nil {
            middle = [("Przeglądam harmonogramy…", 2.2),
                      ("Sprawdzam ogłoszenia osiedla…", 2.2)]
        } else if q.range(of: #"[a-z]{1,3}\s?\d{4,5}|tablic|rejestracyj"#,
                          options: .regularExpression) != nil {
            middle = [("Szukam w rejestrze wjazdów…", 2.5)]
        } else if q.range(of: #"\bile\b|wjecha|wyjecha|aut|samochod|samochód"#,
                          options: .regularExpression) != nil {
            middle = [("Liczę wjazdy i wyjazdy…", 2.5)]
        } else if q.range(of: #"regulamin|uchwa[lł]|administrat|kontakt|telefon|zarząd|zarzad"#,
                          options: .regularExpression) != nil {
            middle = [("Przeszukuję bazę wiedzy osiedla…", 2.5)]
        } else {
            middle = [("Przeszukuję bazę zdarzeń…", 2.0),
                      ("Sprawdzam rejestry…", 2.0)]
        }

        var stages: [(String, Double)] = [("Analizuję pytanie…", 1.3)]
        stages.append(contentsOf: middle)
        stages.append(("Formułuję odpowiedź…", 9.0))
        stages.append(("Jeszcze chwila — analizuję większą ilość danych…", .infinity))
        return stages
    }

    /// Odpala pętlę etapów; cancel w `send()` gdy odpowiedź przyjdzie.
    private func runLoadingStages(for question: String) -> Task<Void, Never> {
        let stages = Self.progressStages(for: question)
        return Task { @MainActor in
            for stage in stages {
                if Task.isCancelled { return }
                loadingStage = stage.text
                if stage.holdSeconds == .infinity { return }  // ostatni — zostaje
                try? await Task.sleep(nanoseconds: UInt64(stage.holdSeconds * 1_000_000_000))
            }
        }
    }

    // MARK: - Composer

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Zadaj pytanie…", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .font(.system(size: 14.5))
                .foregroundStyle(GLColor.textPrimary(scheme))
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(GLColor.bg3(scheme))
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(GLColor.borderSubtle(scheme), lineWidth: 1),
                )
                .focused($inputFocused)
                .disabled(isLoading)
                .submitLabel(.send)

            Button {
                let q = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !q.isEmpty else { return }
                Task { await send(q) }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(
                        canSend
                            ? AnyShapeStyle(GLColor.accentGradient(scheme))
                            : AnyShapeStyle(GLColor.bg4(scheme)),
                    )
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
        }
    }

    private var canSend: Bool {
        !isLoading && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Error banner

    private func errorBanner(_ text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(GLColor.danger(scheme))
            Text(text)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(GLColor.textPrimary(scheme))
                .lineLimit(3)
            Spacer()
            Button {
                withAnimation { errorMessage = nil }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(GLColor.textSecondary(scheme))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(GLColor.bg2(scheme))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(GLColor.danger(scheme).opacity(0.4), lineWidth: 1),
        )
        .glShadow(.md)
    }

    // MARK: - Sending

    private func send(_ question: String) async {
        let trimmed = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Multi-turn context: ostatnie 6 wiadomości PRZED dorzuceniem aktualnego pytania.
        // Backend (Cloud + Edge) i tak tail-trim-uje, ale wysyłamy zwięźle żeby
        // payload był mały (każda tura przycięta do 1000 chars).
        let history = Array(messages.suffix(6)).map { msg in
            AssistantHistoryTurn(
                role: msg.role == .user ? "user" : "assistant",
                content: String(msg.text.prefix(1000)),
            )
        }

        messages.append(AssistantMessage(role: .user, text: trimmed))
        draft = ""
        isLoading = true
        errorMessage = nil
        inputFocused = false

        // FAZA 8.h.22 — staged progress w trakcie czekania na odpowiedź.
        let stageTask = runLoadingStages(for: trimmed)
        defer {
            isLoading = false
            stageTask.cancel()
            loadingStage = ""
        }

        do {
            let res = try await EdgeAssistantClient.shared.ask(
                trimmed,
                smart: smartMode,
                history: history,
            )
            messages.append(AssistantMessage(
                role: .assistant,
                text: res.answer,
                intent: res.intent,
                totalMs: res.totalMs,
                modelUsed: res.modelUsed,
                followUps: res.followUps,
                rewrittenQuestion: res.rewrittenQuestion,
            ))
        } catch let err as EdgeAssistantError {
            withAnimation { errorMessage = err.localizedDescription }
        } catch {
            withAnimation { errorMessage = error.localizedDescription }
        }
    }

    // MARK: - Helpers

    private let samplePrompts: [String] = [
        "Ile białych aut dziś wjechało?",
        "Czy mam jakieś paczki?",
        "Kto ostatnio wjechał?",
    ]
}

// MARK: - Models

private struct AssistantMessage: Identifiable {
    enum Role { case user, assistant }

    let id = UUID()
    let role: Role
    let text: String
    var intent: String? = nil
    var totalMs: Int? = nil
    var modelUsed: String? = nil
    var followUps: [String]? = nil
    /// Multi-turn: gdy backend przepisał pytanie używając kontekstu,
    /// trzymamy oryginał vs rewrite dla debug-pokazania (tap-to-expand).
    var rewrittenQuestion: String? = nil
}

#Preview {
    AssistantView()
}
