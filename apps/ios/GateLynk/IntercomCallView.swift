import SwiftUI
import UIKit

#if canImport(WebRTC)
import WebRTC
#endif

// MARK: - IntercomCallView — ekran połączenia domofonowego (Glass Depth Premium)
//
// Odwzorowanie handoffu „Domofon Wideo" (Glass Depth Premium):
//   • pełnoekranowy podgląd z kamery (snapshoty Akuvox / WebRTC track) + grade,
//   • górna nakładka: badge NA ŻYWO, tytuł, licznik czasu, chip rozpoznania,
//   • narożny przycisk aparatu (zapis klatki do Zdjęć),
//   • suwak „Przytrzymaj, aby otworzyć" (~1.1 s) → otwiera elektrozaczep,
//   • 4 szklane kontrolki: Wycisz / Mów / Rozłącz / Głośnik,
//   • toast + „veil" sukcesu.
// Ekran jest zawsze ciemny (leży na ciemnym wideo) — `.preferredColorScheme(.dark)`.

struct IntercomCallView: View {
    @Bindable var call: CallManager

    // Stan UI
    @State private var elapsed = 0
    @State private var holdProgress: CGFloat = 0
    @State private var holdTask: Task<Void, Never>?
    @State private var opened = false
    @State private var blink = false
    @State private var savedFrame = false
    @State private var toastText: String?
    @State private var toastDanger = false
    @State private var showVeil = false

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    // Paleta z handoffu
    private let cLive = Color(hex: 0xFF3B30)
    private let cGreen = Color(hex: 0x3DD68C)
    private let cGreenSoft = Color(hex: 0x7BE2A3)
    private let cPurple = Color(hex: 0xC5B0FF)
    private let cBlue = Color(hex: 0x5B7CFA)
    private let glassBg = Color(hex: 0x141826)

    var body: some View {
        // Redesign 2026-08-20 (feedback Konrada): wideo NIE jest już
        // pełnoekranowym tłem — `scaledToFill` bez kontenera rozpychał layout
        // ponad szerokość ekranu (przyciski „Mów"/„Rozłącz" na krawędziach,
        // „Wycisz"/„Głośnik" całkiem poza ekranem), a fisheye na cały ekran
        // nocą wyglądał jak szum. Teraz: kadr w ramce 4:3 u góry, kontrolki
        // na solidnym ciemnym tle pod spodem — zawsze w całości widoczne.
        ZStack {
            Color(hex: 0x0B0E16).ignoresSafeArea()

            if showVeil {
                RadialGradient(
                    colors: [cGreen.opacity(0.22), .clear],
                    center: UnitPoint(x: 0.5, y: 0.45), startRadius: 10, endRadius: 480
                )
                .ignoresSafeArea().allowsHitTesting(false).transition(.opacity)
            }

            VStack(spacing: 14) {
                topOverlay
                feedCard
                Spacer(minLength: 12)
                bottomControls
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay(alignment: .bottom) { toastOverlay }
        .preferredColorScheme(.dark)
        .onReceive(ticker) { _ in if call.callState == .active { elapsed += 1 } }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { blink = true }
        }
    }

    // MARK: - Kadr z kamery — ramka 4:3 (2026-08-20)

    /// `Color.clear` jako baza layoutu + wideo w `.overlay` — content
    /// (RemoteVideoView / snapshot scaledToFill) NIE wpływa na wymiary
    /// widoku, więc nic nie rozpycha ekranu. Przycisk zapisu kadru w rogu.
    private var feedCard: some View {
        Color.clear
            .aspectRatio(4.0 / 3.0, contentMode: .fit)
            .overlay { feed }
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.16), lineWidth: 1)
            }
            .overlay(alignment: .topTrailing) { cornerButton }
            .shadow(color: .black.opacity(0.5), radius: 18, y: 10)
    }

    // MARK: - Pełnoekranowy podgląd

    private var feed: some View {
        ZStack {
            #if canImport(WebRTC)
            if call.snapshotImage == nil, let track = call.remoteVideoTrack {
                RemoteVideoView(track: track)
            } else if let img = call.snapshotImage {
                Image(uiImage: img).resizable().scaledToFill()
            } else {
                feedPlaceholder
            }
            #else
            if let img = call.snapshotImage {
                Image(uiImage: img).resizable().scaledToFill()
            } else {
                feedPlaceholder
            }
            #endif
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
    }

    private var feedPlaceholder: some View {
        ZStack {
            Color(hex: 0x0B0E16)
            VStack(spacing: 12) {
                Image(systemName: "video.fill")
                    .font(.system(size: 44)).foregroundStyle(.white.opacity(0.28))
                Text("Łączenie z kamerą…")
                    .font(.subheadline).foregroundStyle(.white.opacity(0.5))
            }
        }
    }

    // MARK: - Górna nakładka

    private var topOverlay: some View {
        VStack(spacing: 12) {
            liveBadge
            VStack(spacing: 4) {
                Text(call.activeSession?.intercomName ?? "Domofon")
                    .font(.system(size: 27, weight: .semibold))
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.55), radius: 16, y: 2)
                HStack(spacing: 7) {
                    Text(subtitleLeft)
                    Circle().fill(.white.opacity(0.5)).frame(width: 5, height: 5)
                    Text(timerString)
                        .foregroundStyle(call.callState == .active ? cGreenSoft : .white.opacity(0.78))
                        .monospacedDigit()
                }
                .font(.system(size: 13.5, weight: .medium))
                .foregroundStyle(.white.opacity(0.78))
                .shadow(color: .black.opacity(0.5), radius: 8)
            }
            recoChip
        }
        .padding(.top, 8)
    }

    private var liveBadge: some View {
        HStack(spacing: 7) {
            Circle().fill(.white).frame(width: 7, height: 7).opacity(blink ? 0.3 : 1)
            Text(call.callState == .active ? "NA ŻYWO" : "POŁĄCZENIE")
                .font(.system(size: 11, weight: .bold)).tracking(1.1)
        }
        .foregroundStyle(.white)
        .padding(.leading, 9).padding(.trailing, 11).padding(.vertical, 5)
        .background(Capsule().fill(cLive.opacity(0.92)))
        .shadow(color: cLive.opacity(0.4), radius: 9, y: 4)
    }

    /// Chip rozpoznania (placeholder — docelowo wynik face-recognition / dopasowania
    /// gościa). Dziś statycznie „gość", spójnie z handoffem.
    private var recoChip: some View {
        HStack(spacing: 9) {
            ZStack {
                Circle().fill(LinearGradient(colors: [cPurple, cBlue], startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "person.fill").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
            }
            .frame(width: 26, height: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text("Wykryto: osoba").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
                Text("Brak dopasowania · gość").font(.system(size: 11)).foregroundStyle(.white.opacity(0.6))
            }
        }
        .padding(.leading, 8).padding(.trailing, 14).padding(.vertical, 7)
        .background(glassCapsule)
    }

    // MARK: - Narożny aparat

    private var cornerButton: some View {
        Button { saveFrame() } label: {
            Image(systemName: savedFrame ? "checkmark" : "camera")
                .font(.system(size: 17, weight: .medium)).foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Circle().fill(.ultraThinMaterial))
                .overlay(Circle().stroke(.white.opacity(0.16), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .opacity(call.callState == .active || call.callState == .connecting ? 1 : 0)
        .padding(10)
    }

    private func saveFrame() {
        guard let img = call.snapshotImage else { return }
        UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
        savedFrame = true
        showToast("Zapisano zdjęcie z kamery")
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 900_000_000)
            savedFrame = false
        }
    }

    // MARK: - Dolne kontrolki

    @ViewBuilder
    private var bottomControls: some View {
        switch call.callState {
        case .ringing:
            ringingControls
        case .connecting, .active:
            VStack(spacing: 16) {
                holdSlider
                orbRow
            }
        case .idle, .ended:
            EmptyView()
        }
    }

    // Suwak „przytrzymaj, aby otworzyć"
    private var holdSlider: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: opened
                                ? [cGreen.opacity(0.55), cGreen.opacity(0.35)]
                                : [cPurple.opacity(0.5), cBlue.opacity(0.4)],
                            startPoint: .leading, endPoint: .trailing
                        )
                    )
                    .frame(width: opened ? geo.size.width : (54 + (geo.size.width - 54) * holdProgress))

                HStack(spacing: 9) {
                    Image(systemName: opened ? "checkmark" : "lock.open.fill")
                        .font(.system(size: 16, weight: .semibold))
                    Text(opened ? "Brama otwarta" : "Przytrzymaj, aby otworzyć")
                        .font(.system(size: 15, weight: .semibold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: 66)
        .background(.ultraThinMaterial)
        .background(glassBg.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(.white.opacity(opened ? 0.3 : 0.2), lineWidth: 1)
        )
        .scaleEffect(holdProgress > 0 && !opened ? 0.992 : 1)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in beginHold() }
                .onEnded { _ in endHold() }
        )
    }

    private var orbRow: some View {
        HStack(alignment: .top, spacing: 0) {
            orb(icon: call.isMuted ? "mic.slash.fill" : "mic.fill",
                label: "Wycisz", active: call.isMuted, tint: cPurple) {
                call.toggleMute()
                showToast(call.isMuted ? "Mikrofon wyciszony" : "Mikrofon włączony")
            }
            Spacer(minLength: 0)
            orb(icon: "waveform", label: "Mów", active: !call.isMuted, tint: cGreen) {
                call.toggleMute()
                showToast(call.isMuted ? "Mikrofon zwolniony" : "Mówisz")
            }
            Spacer(minLength: 0)
            endOrb
            Spacer(minLength: 0)
            orb(icon: call.isSpeaker ? "speaker.wave.3.fill" : "speaker.fill",
                label: "Głośnik", active: call.isSpeaker, tint: cPurple) {
                call.toggleSpeaker()
                showToast(call.isSpeaker ? "Głośnik włączony" : "Głośnik wyłączony")
            }
        }
        .padding(.horizontal, 6)
    }

    private func orb(icon: String, label: String, active: Bool, tint: Color, action: @escaping () -> Void) -> some View {
        VStack(spacing: 8) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(width: 58, height: 58)
                    .background(
                        ZStack {
                            Circle().fill(.ultraThinMaterial)
                            if active { Circle().fill(tint.opacity(0.4)) }
                        }
                    )
                    .overlay(Circle().stroke(active ? tint.opacity(0.7) : .white.opacity(0.16), lineWidth: 1))
                    .shadow(color: active ? tint.opacity(0.35) : .clear, radius: 12)
            }
            .buttonStyle(.plain)
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(active ? tint : .white.opacity(0.8))
        }
        .frame(width: 62)
    }

    private var endOrb: some View {
        VStack(spacing: 8) {
            Button { call.hangup() } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 58, height: 58)
                    .background(Circle().fill(cLive))
                    .shadow(color: cLive.opacity(0.45), radius: 14, y: 4)
            }
            .buttonStyle(.plain)
            Text("Rozłącz")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white.opacity(0.8))
        }
        .frame(width: 62)
    }

    // Przychodzące — Odbierz / Odrzuć
    private var ringingControls: some View {
        HStack(spacing: 30) {
            ringButton(icon: "phone.down.fill", tint: cLive, label: "Odrzuć") { call.decline() }
            ringButton(icon: "phone.fill", tint: cGreen, label: "Odbierz") { call.answer() }
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 8)
    }

    private func ringButton(icon: String, tint: Color, label: String, action: @escaping () -> Void) -> some View {
        VStack(spacing: 9) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(Circle().fill(tint))
                    .shadow(color: tint.opacity(0.5), radius: 16, y: 6)
            }
            .buttonStyle(.plain)
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white.opacity(0.85))
        }
    }

    // MARK: - Toast

    @ViewBuilder
    private var toastOverlay: some View {
        if let toastText {
            HStack(spacing: 9) {
                Image(systemName: toastDanger ? "xmark" : "checkmark")
                    .font(.system(size: 13, weight: .bold))
                Text(toastText).font(.system(size: 13.5, weight: .semibold))
            }
            .foregroundStyle(toastDanger ? Color(hex: 0xFF8A80) : cGreenSoft)
            .padding(.horizontal, 18).padding(.vertical, 11)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke((toastDanger ? cLive : cGreen).opacity(0.45), lineWidth: 1)
            )
            .padding(.bottom, 132)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: - Helpers

    private var subtitleLeft: String {
        if let unit = call.activeSession?.unitLabel, !unit.isEmpty { return unit }
        return "Brama główna"
    }

    private var timerString: String {
        switch call.callState {
        case .active:   return String(format: "%02d:%02d", elapsed / 60, elapsed % 60)
        case .ringing:  return "dzwoni…"
        default:        return "łączenie…"
        }
    }

    private var glassCapsule: some View {
        Capsule()
            .fill(.ultraThinMaterial)
            .overlay(Capsule().stroke(.white.opacity(0.16), lineWidth: 1))
            .shadow(color: .black.opacity(0.3), radius: 11, y: 4)
    }

    // MARK: - Hold-to-open logika

    private func beginHold() {
        guard holdTask == nil, !opened else { return }
        holdTask = Task { @MainActor in
            let steps = 60                       // ~1.1 s przy 18 ms kroku
            for i in 1...steps {
                try? await Task.sleep(nanoseconds: 18_000_000)
                if Task.isCancelled { return }
                holdProgress = CGFloat(i) / CGFloat(steps)
            }
            completeOpen()
        }
    }

    private func endHold() {
        holdTask?.cancel()
        holdTask = nil
        if !opened {
            withAnimation(.easeOut(duration: 0.25)) { holdProgress = 0 }
        }
    }

    private func completeOpen() {
        holdTask = nil
        opened = true
        holdProgress = 1
        call.openDoor()
        withAnimation(.easeOut(duration: 0.3)) { showVeil = true }
        showToast("Brama otwarta")
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_600_000_000)
            withAnimation(.easeInOut(duration: 0.4)) {
                showVeil = false
                opened = false
                holdProgress = 0
            }
        }
    }

    private func showToast(_ text: String, danger: Bool = false) {
        toastDanger = danger
        withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) { toastText = text }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            if toastText == text {
                withAnimation(.easeOut(duration: 0.25)) { toastText = nil }
            }
        }
    }
}

#if canImport(WebRTC)
// MARK: - RemoteVideoView — Metal renderer obrazu gościa (1-way, recvonly)

struct RemoteVideoView: UIViewRepresentable {
    let track: RTCVideoTrack

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView()
        view.videoContentMode = .scaleAspectFill
        track.add(view)
        context.coordinator.renderer = view
        context.coordinator.track = track
        return view
    }

    func updateUIView(_ uiView: RTCMTLVideoView, context: Context) {
        if context.coordinator.track !== track {
            context.coordinator.track?.remove(uiView)
            track.add(uiView)
            context.coordinator.track = track
        }
    }

    static func dismantleUIView(_ uiView: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.track?.remove(uiView)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        weak var renderer: RTCMTLVideoView?
        var track: RTCVideoTrack?
    }
}
#endif
