import SwiftUI

// MARK: - Sheet "Zapytaj AI" — czat z asystentem osiedlowym
//
// POST /api/resident/assistant/ask przez EdgeAssistantClient (smart mode,
// multi-turn history — ostatnie 6 tur). Bąbelki: user gradient / bot glass.
// Follow-up suggestions z odpowiedzi renderowane jako klikalne chipsy.

struct GammaChatSheet: View {
    let onClose: () -> Void

    private struct ChatMessage: Identifiable, Equatable {
        let id = UUID()
        let role: String   // "user" | "assistant"
        let text: String
    }

    @State private var messages: [ChatMessage] = [
        .init(role: "assistant", text: "Cześć! W czym pomóc?")
    ]
    @State private var input = ""
    @State private var waiting = false
    @State private var followUps: [String] = []
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            GammaSheetHeader(kicker: "GateLynk AI", title: "Asystent osiedlowy", onClose: onClose)

            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(messages) { msg in
                            bubble(msg)
                        }
                        if waiting {
                            HStack {
                                GammaTypingDots()
                                    .padding(.horizontal, 13)
                                    .padding(.vertical, 12)
                                    .background {
                                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                                            .fill(Color.white.opacity(0.1))
                                    }
                                Spacer()
                            }
                        }
                        if !followUps.isEmpty && !waiting {
                            followUpChips
                        }
                        Color.clear.frame(height: 1).id("chat-bottom")
                    }
                    .padding(.vertical, 4)
                }
                .frame(minHeight: 160, maxHeight: 320)
                .onChange(of: messages) { _, _ in
                    withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
                .onChange(of: waiting) { _, _ in
                    withAnimation { proxy.scrollTo("chat-bottom", anchor: .bottom) }
                }
            }

            inputBar
                .padding(.top, 10)
        }
    }

    // MARK: Bąbelki

    @ViewBuilder
    private func bubble(_ msg: ChatMessage) -> some View {
        let isUser = msg.role == "user"
        HStack {
            if isUser { Spacer(minLength: 40) }
            Text(msg.text)
                .font(.system(size: 13))
                .lineSpacing(2.5)
                .foregroundStyle(.white)
                .padding(.horizontal, 13)
                .padding(.vertical, 10)
                .background {
                    if isUser {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(GammaColor.accentGradient)
                    } else {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color.white.opacity(0.1))
                            .overlay {
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                            }
                    }
                }
            if !isUser { Spacer(minLength: 40) }
        }
    }

    private var followUpChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(followUps, id: \.self) { suggestion in
                    Button {
                        Task { await send(suggestion) }
                    } label: {
                        Text(suggestion)
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(GammaColor.accentLight)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background { Capsule().fill(GammaColor.accentLight.opacity(0.12)) }
                            .overlay { Capsule().strokeBorder(GammaColor.accentLight.opacity(0.3), lineWidth: 1) }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.top, 2)
    }

    // MARK: Input

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField(
                "",
                text: $input,
                prompt: Text("Napisz wiadomość…").foregroundStyle(.white.opacity(0.5))
            )
            .focused($inputFocused)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .background { Capsule().fill(Color.white.opacity(0.08)) }
            .overlay { Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 1) }
            .onSubmit { Task { await send(nil) } }

            Button {
                Task { await send(nil) }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 42, height: 42)
                    .background {
                        Circle()
                            .fill(GammaColor.accentGradient)
                            .shadow(color: GammaColor.accentBlue.opacity(0.5), radius: 7, y: 3)
                    }
            }
            .buttonStyle(.plain)
            .disabled(waiting)
        }
    }

    // MARK: Send

    private func send(_ preset: String?) async {
        let question = (preset ?? input).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !waiting else { return }

        input = ""
        followUps = []
        messages.append(.init(role: "user", text: question))
        waiting = true

        // ostatnie 6 tur jako kontekst multi-turn (bez powitania bota)
        let history = messages
            .dropLast()
            .suffix(6)
            .filter { !($0.role == "assistant" && $0.text == "Cześć! W czym pomóc?") }
            .map { AssistantHistoryTurn(role: $0.role, content: $0.text) }

        do {
            let resp = try await EdgeAssistantClient.shared.ask(
                question,
                smart: true,
                history: Array(history)
            )
            messages.append(.init(role: "assistant", text: resp.answer))
            followUps = Array((resp.followUps ?? []).prefix(3))
        } catch {
            messages.append(.init(
                role: "assistant",
                text: "Nie udało się połączyć z asystentem: \(error.localizedDescription)"
            ))
        }
        waiting = false
    }
}
