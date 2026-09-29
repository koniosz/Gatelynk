import SwiftUI
import UIKit

/// Black presentation of the existing resident access flow. Only real API APs
/// become cards. The selected AP owns its camera, intercom and command outcome.
struct BlackAccessDeck: View {
    /// Owned by the resident root, so a tab change cannot erase an in-flight command.
    let interaction: BlackAccessState
    let accessPoints: [AccessPoint]
    let loadFailed: Bool
    let onOpen: (AccessPoint) async -> AccessOpenOutcome
    let onFireConfirm: (AccessPoint) -> Void
    let onOpenMenu: () -> Void
    let onCamera: (AccessPoint) -> Void
    let onIntercom: (AccessPoint) -> Void
    var intercomBusy = false
    var lockStatuses: [Int: NukiLockStatus] = [:]
    var favoriteKey: String? = nil
    var cameraHeight: CGFloat = 174
    var isSuspended = false
    var fixtureImages: [Int: UIImage] = [:]
    var demoMode = false

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .headline) private var gateFont: CGFloat = 23
    @ScaledMetric(relativeTo: .footnote) private var actionFont: CGFloat = 12
    @ScaledMetric(relativeTo: .caption) private var statusFont: CGFloat = 10
    @State private var frames: [Int: CameraFrame] = [:]
    @State private var cameraFailed: Set<Int> = []
    @State private var accessibleTarget: AccessPoint?
    @State private var favoriteApplied = false
    @State private var appeared = false

    private struct CameraFrame {
        let image: UIImage
        /// This is receipt time; the snapshot API does not supply capture time.
        let receivedAt: Date
    }

    private var isDemo: Bool {
        #if DEBUG
        demoMode
        #else
        false
        #endif
    }

    private var suspended: Bool { isSuspended || scenePhase != .active || !appeared }
    private var selectedAP: AccessPoint? { accessPoints.first { $0.id == interaction.selectedID } }
    private var infoHeight: CGFloat { max(54, gateFont * 2.18) }
    private var actionHeight: CGFloat { max(48, actionFont * 3.4) }
    private var slideHeight: CGFloat { cameraHeight + infoHeight + actionHeight + 12 }
    private var cameraTaskID: String { "\(interaction.selectedID ?? -1)|\(suspended)|\(isDemo)" }

    var body: some View {
        VStack(spacing: 8) {
            if accessPoints.isEmpty {
                emptyState
            } else {
                entranceTabs
                TabView(selection: Binding(
                    get: { interaction.selectedID ?? accessPoints.first?.id ?? -1 },
                    set: { interaction.select($0) }
                )) {
                    ForEach(accessPoints) { ap in
                        gateCard(ap).tag(ap.id)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .frame(height: slideHeight)
                .accessibilityLabel("Bramy i wejścia")
                .accessibilityValue(selectedAP?.label ?? "")
                .accessibilityAdjustableAction { direction in
                    guard let index = accessPoints.firstIndex(where: { $0.id == interaction.selectedID }) else { return }
                    let next = direction == .increment ? index + 1 : index - 1
                    if accessPoints.indices.contains(next) { select(accessPoints[next].id) }
                }
                pagination
                    .padding(.top, -8)
            }
        }
        .onAppear {
            appeared = true
            applySelection()
            interaction.suspend(suspended)
        }
        .onDisappear {
            appeared = false
            interaction.suspend(true)
        }
        .onChange(of: accessPoints.map(\.id)) { _, _ in applySelection() }
        .onChange(of: favoriteKey) { _, _ in
            favoriteApplied = false
            applySelection()
        }
        .onChange(of: suspended) { _, value in interaction.suspend(value) }
        .task(id: cameraTaskID) { await pollSelectedCamera() }
        .confirmationDialog(
            "Otworzyć: \(accessibleTarget?.label ?? "wejście")?",
            isPresented: Binding(get: { accessibleTarget != nil }, set: { if !$0 { accessibleTarget = nil } }),
            titleVisibility: .visible
        ) {
            if let ap = accessibleTarget {
                Button("Wyślij polecenie otwarcia") {
                    if let command = interaction.commitConfirmed(id: ap.id) { send(command, to: ap) }
                    accessibleTarget = nil
                }
            }
            Button("Anuluj", role: .cancel) { accessibleTarget = nil }
        }
    }

    private var entranceTabs: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 4) {
                ForEach(accessPoints) { ap in entranceTab(ap).frame(maxWidth: .infinity) }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) { ForEach(accessPoints) { ap in entranceTab(ap) } }
            }
        }
        .padding(3)
        .background(BlackTheme.surface, in: RoundedRectangle(cornerRadius: 11))
        .overlay { RoundedRectangle(cornerRadius: 11).strokeBorder(.white.opacity(0.04)) }
    }

    private func entranceTab(_ ap: AccessPoint) -> some View {
        let selected = interaction.selectedID == ap.id
        return Button { select(ap.id) } label: {
            Text(ap.label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(selected ? Color(hex: 0xE1D5FF) : BlackTheme.muted)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 7)
                .frame(minHeight: 38)
                .frame(maxWidth: .infinity)
                .background(selected ? Color(hex: 0x383045) : .clear, in: RoundedRectangle(cornerRadius: 7))
                .overlay {
                    RoundedRectangle(cornerRadius: 7)
                        .strokeBorder(selected ? BlackTheme.accent.opacity(0.14) : .clear)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Wybierz wejście: \(ap.label)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func gateCard(_ ap: AccessPoint) -> some View {
        VStack(spacing: 0) {
            camera(ap)
            HStack(spacing: 6) {
                Text(ap.label)
                    .font(.custom("BarlowSemiCondensed-Medium", fixedSize: gateFont))
                    .foregroundStyle(BlackTheme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 2)
                status(ap)
            }
            .padding(.horizontal, 13)
            .frame(height: infoHeight)

            if GlassAccessCategory.classify(ap).isEmergency {
                Button { onFireConfirm(ap) } label: {
                    HStack(spacing: 8) {
                        BlackIcon(name: "triangle-alert", size: 18)
                        Text("Otwórz awaryjnie…")
                            .font(.system(size: actionFont, weight: .semibold))
                        Spacer(minLength: 0)
                        BlackIcon(name: "chevron-right", size: 14)
                    }
                    .padding(.horizontal, 13)
                    .frame(height: actionHeight)
                    .foregroundStyle(Color(hex: 0xFFABB7))
                    .background(Color(hex: 0x592C3B), in: RoundedRectangle(cornerRadius: 9))
                }
                .buttonStyle(.plain)
                .disabled(suspended)
                .accessibilityLabel("\(ap.label). Otwórz awaryjnie. Wymaga potwierdzenia.")
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
            } else {
                openControl(ap)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
        }
        .background(Color(hex: 0x1C1D25))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(.white.opacity(0.09)) }
        .accessibilityHidden(interaction.selectedID != ap.id)
    }

    private func camera(_ ap: AccessPoint) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let frame = frames[ap.id]
            let fixture = isDemo ? fixtureImages[ap.id] : nil
            let image = fixture ?? frame?.image
            let stale = frame.map { context.date.timeIntervalSince($0.receivedAt) >= 15 } ?? false
            ZStack(alignment: .topLeading) {
                Color(hex: 0x272D31)
                if let image {
                    GeometryReader { geo in
                        Image(uiImage: image).resizable().scaledToFill()
                            .frame(width: geo.size.width, height: geo.size.height)
                            .clipped()
                    }
                    .allowsHitTesting(false)
                } else {
                    VStack(spacing: 8) {
                        if cameraFailed.contains(ap.id) || isDemo {
                            BlackIcon(name: "video-off", size: 24)
                            Text("Podgląd niedostępny")
                        } else {
                            ProgressView().tint(BlackTheme.accent)
                            Text("Ładowanie podglądu…")
                        }
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(BlackTheme.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                LinearGradient(colors: [.black.opacity(0.3), .clear, .black.opacity(0.18)], startPoint: .top, endPoint: .bottom)
                    .allowsHitTesting(false)
                HStack(alignment: .top, spacing: 3) {
                    cameraLabel(frame: frame, stale: stale)
                        .padding(.top, 4)
                    Spacer(minLength: 0)
                    cameraButton(name: "maximize-2", label: "Powiększ kamerę: \(ap.label)", green: false) { onCamera(ap) }
                    cameraButton(name: "phone", label: "Domofon: \(ap.label)", green: true) { onIntercom(ap) }
                        .disabled(intercomBusy || suspended)
                }
                .padding(.horizontal, 8)
                .padding(.top, 7)
                if let frame, !isDemo {
                    VStack {
                        Spacer()
                        HStack {
                            Spacer()
                            Text("Odebrano \(frame.receivedAt.formatted(date: .omitted, time: .standard))")
                                .font(.system(size: 9).monospacedDigit())
                                .foregroundStyle(.white.opacity(0.9))
                                .padding(5)
                                .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 5))
                        }
                    }
                    .padding(9)
                    .allowsHitTesting(false)
                }
            }
            .frame(height: cameraHeight)
            .clipped()
        }
    }

    private func cameraLabel(frame: CameraFrame?, stale: Bool) -> some View {
        HStack(spacing: 5) {
            BlackIcon(name: stale ? "clock" : "video", size: 12)
                .foregroundStyle(stale ? Color(hex: 0xFFCA76) : BlackTheme.accent)
            Text(isDemo ? "DEMO · przykładowy kadr" : stale ? "Ostatni obraz" : frame == nil ? "Kamera" : "Podgląd")
                .font(.system(size: 10))
                .lineLimit(1)
        }
        .foregroundStyle(BlackTheme.text)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color(hex: 0x151820).opacity(0.9), in: RoundedRectangle(cornerRadius: 6))
        .overlay { RoundedRectangle(cornerRadius: 6).strokeBorder(.white.opacity(0.12)) }
    }

    private func cameraButton(name: String, label: String, green: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            BlackIcon(name: name, size: 17)
                .foregroundStyle(green ? Color(hex: 0x8AF0BD) : BlackTheme.accent)
                .frame(width: 38, height: 38)
                .background(green ? Color(hex: 0x184638).opacity(0.94) : Color(hex: 0x131720).opacity(0.86), in: Circle())
                .overlay { Circle().strokeBorder(.white.opacity(0.16)) }
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(suspended)
        .accessibilityLabel(label)
    }

    private func status(_ ap: AccessPoint) -> some View {
        let line = statusLine(ap)
        return HStack(spacing: 4) {
            BlackIcon(name: line.icon, size: 12)
            Text(line.text)
                .font(.system(size: statusFont))
                .lineLimit(2)
                .multilineTextAlignment(.trailing)
        }
        .foregroundStyle(line.color)
        .frame(maxWidth: 155, alignment: .trailing)
        .accessibilityElement(children: .combine)
    }

    private func statusLine(_ ap: AccessPoint) -> (text: String, icon: String, color: Color) {
        switch interaction.phase(for: ap.id) {
        case .sending: return ("Wysyłanie…", "loader", BlackTheme.accent)
        case .accepted: return ("Polecenie przyjęte", "check", BlackTheme.green)
        case .unknown: return ("Wynik nieznany", "circle-help", Color(hex: 0xFFCA76))
        case .failed: return ("Nie udało się otworzyć", "circle-alert", Color(hex: 0xFFABB7))
        case .idle, .holding:
            if let lock = lockStatuses[ap.id], lock.online, let label = lock.effectiveStateLabel {
                return (label, "lock-keyhole", BlackTheme.muted)
            }
            if GlassAccessCategory.classify(ap).isEmergency {
                return ("Dostęp awaryjny", "triangle-alert", Color(hex: 0xFFCA76))
            }
            return ("Sterowanie bramą", "lock-keyhole", BlackTheme.muted)
        }
    }

    private func openControl(_ ap: AccessPoint) -> some View {
        let phase = interaction.phase(for: ap.id)
        return TimelineView(.animation(minimumInterval: 0.04, paused: phase != .holding)) { context in
            let progress = interaction.progress(id: ap.id, now: context.date)
            ZStack(alignment: .leading) {
                if phase == .accepted {
                    RoundedRectangle(cornerRadius: 9).fill(Color(hex: 0x194232))
                } else {
                    RoundedRectangle(cornerRadius: 9).fill(BlackTheme.actionGradient)
                }
                if phase == .holding {
                    GeometryReader { geo in
                        Color.white.opacity(0.32).frame(width: geo.size.width * progress)
                    }
                    .allowsHitTesting(false)
                }
                HStack(spacing: 9) {
                    BlackIcon(name: actionIcon(phase), size: 19)
                    Text(actionLabel(phase))
                        .font(.system(size: actionFont, weight: .medium))
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Rectangle().fill(Color.black.opacity(0.18)).frame(width: 1, height: 20)
                    Text(phase == .holding ? String(format: "%.1f s", max(0, 2 * (1 - progress))) : phase == .idle ? "2 s" : phase == .sending ? "…" : "OK")
                        .font(.system(size: 11).monospacedDigit())
                        .frame(minWidth: 20)
                }
                .foregroundStyle(phase == .accepted ? Color(hex: 0xA3F1C8) : Color(hex: 0x151222))
                .padding(.horizontal, 13)
            }
            .frame(height: actionHeight)
            .clipShape(RoundedRectangle(cornerRadius: 9))
            .contentShape(RoundedRectangle(cornerRadius: 9))
            .overlay {
                BlackHoldGesture(
                    enabled: !suspended && interaction.selectedID == ap.id,
                    duration: interaction.holdDuration,
                    onBegin: {
                        if interaction.beginHold(id: ap.id, now: Date()) {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        }
                    },
                    onRecognized: {
                        if let command = interaction.commitRecognizedHold(id: ap.id) { send(command, to: ap) }
                    },
                    onCancel: {
                        if interaction.phase(for: ap.id) == .holding { interaction.cancelHold() }
                    },
                    onTap: { interaction.resetResult(id: ap.id) }
                )
            }
            .allowsHitTesting(!suspended && interaction.selectedID == ap.id)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Otwórz: \(ap.label)")
            .accessibilityValue(actionLabel(phase))
            .accessibilityHint("Aktywuj i potwierdź otwarcie. Wynik polecenia nie potwierdza fizycznego otwarcia bramy.")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                if phase == .idle { accessibleTarget = ap }
                else { interaction.resetResult(id: ap.id) }
            }
        }
    }

    private func actionLabel(_ phase: BlackAccessState.Phase) -> String {
        switch phase {
        case .idle: return "Przytrzymaj, aby otworzyć"
        case .holding: return "Przytrzymaj…"
        case .sending: return "Wysyłanie polecenia…"
        case .accepted: return "Polecenie otwarcia przyjęte"
        case .unknown: return "Wynik nieznany — sprawdź wejście"
        case .failed(let reason): return reason ?? "Nie udało się otworzyć"
        }
    }

    private func actionIcon(_ phase: BlackAccessState.Phase) -> String {
        switch phase {
        case .accepted: return "check"
        case .unknown: return "circle-help"
        case .failed: return "circle-alert"
        case .sending: return "loader"
        default: return "lock-keyhole"
        }
    }

    private var pagination: some View {
        HStack(spacing: 5) {
            ForEach(accessPoints) { ap in
                Capsule()
                    .fill(interaction.selectedID == ap.id ? BlackTheme.accent : Color(hex: 0x55545F))
                    .frame(width: interaction.selectedID == ap.id ? 19 : 5, height: 5)
            }
        }
        .frame(height: 23)
        .accessibilityHidden(true)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            BlackIcon(name: "key-round", size: 28)
            Text(loadFailed ? "Nie udało się pobrać wejść" : "Brak dostępnych wejść")
                .font(.subheadline)
            Button("Wszystkie wejścia", action: onOpenMenu)
                .font(.footnote).foregroundStyle(BlackTheme.accent)
        }
        .foregroundStyle(BlackTheme.muted)
        .frame(maxWidth: .infinity, minHeight: 180)
        .background(BlackTheme.surface, in: RoundedRectangle(cornerRadius: 18))
    }

    private func select(_ id: Int) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.28)) { interaction.select(id) }
    }

    private func applySelection() {
        guard !accessPoints.isEmpty else {
            interaction.select(nil)
            return
        }
        // Returning to Dom keeps the user's selected entrance and its command.
        if accessPoints.contains(where: { $0.id == interaction.selectedID }) { return }
        if !favoriteApplied, let key = favoriteKey {
            favoriteApplied = true
            let favorite = UserDefaults.standard.integer(forKey: key)
            if accessPoints.contains(where: { $0.id == favorite && !GlassAccessCategory.classify($0).isEmergency }) {
                interaction.select(favorite)
                return
            }
        }
        if !accessPoints.contains(where: { $0.id == interaction.selectedID }) {
            interaction.select(accessPoints.first(where: { !GlassAccessCategory.classify($0).isEmergency })?.id ?? accessPoints.first?.id)
        }
    }

    private func send(_ command: BlackAccessState.Command, to ap: AccessPoint) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task { @MainActor in
            let result = await onOpen(ap)
            let outcome: BlackAccessState.Outcome
            switch result {
            case .accepted: outcome = .accepted
            case .unknown: outcome = .unknown
            case .failed(let message): outcome = .failed(message)
            }
            if interaction.resolve(command, outcome: outcome) {
                UINotificationFeedbackGenerator().notificationOccurred(outcome == .accepted ? .success : .warning)
            }
        }
    }

    private func pollSelectedCamera() async {
        guard !suspended, !isDemo, let ap = selectedAP else { return }
        while !Task.isCancelled && !suspended && interaction.selectedID == ap.id {
            do {
                let data = try await APIClient.shared.getRawData("/resident/access-points/\(ap.id)/snapshot?w=720&q=60&live=1")
                guard !Task.isCancelled, !suspended else { return }
                if let image = UIImage(data: data) {
                    frames[ap.id] = CameraFrame(image: image, receivedAt: Date())
                    cameraFailed.remove(ap.id)
                } else {
                    cameraFailed.insert(ap.id)
                }
            } catch {
                guard !Task.isCancelled else { return }
                cameraFailed.insert(ap.id)
            }
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }
}

/// One recognizer owns hold timing and cancellation. SwiftUI's separate
/// pressing/perform callbacks can arrive in cancellation-first order.
private struct BlackHoldGesture: UIViewRepresentable {
    let enabled: Bool
    let duration: TimeInterval
    let onBegin: () -> Void
    let onRecognized: () -> Void
    let onCancel: () -> Void
    let onTap: () -> Void

    func makeUIView(context: Context) -> HoldView { HoldView() }

    func updateUIView(_ view: HoldView, context: Context) {
        view.onBegin = onBegin
        view.onRecognized = onRecognized
        view.onCancel = onCancel
        view.onTap = onTap
        view.press.minimumPressDuration = duration
        if view.press.isEnabled != enabled { view.press.isEnabled = enabled }
        if view.tap.isEnabled != enabled { view.tap.isEnabled = enabled }
        view.isUserInteractionEnabled = enabled
    }

    final class HoldView: UIView {
        var onBegin: () -> Void = {}
        var onRecognized: () -> Void = {}
        var onCancel: () -> Void = {}
        var onTap: () -> Void = {}
        let press = TouchAwareLongPress()
        let tap = UITapGestureRecognizer()

        override init(frame: CGRect) {
            super.init(frame: frame)
            backgroundColor = .clear
            isAccessibilityElement = false
            press.allowableMovement = 12
            press.onTouchBegan = { [weak self] in self?.onBegin() }
            press.onTouchCancelled = { [weak self] in self?.onCancel() }
            press.addTarget(self, action: #selector(holdChanged))
            tap.addTarget(self, action: #selector(tapped))
            tap.require(toFail: press)
            addGestureRecognizer(press)
            addGestureRecognizer(tap)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        @objc private func holdChanged() {
            switch press.state {
            case .began: onRecognized()
            case .ended, .cancelled, .failed: onCancel()
            default: break
            }
        }

        @objc private func tapped() { onTap() }
    }

    final class TouchAwareLongPress: UILongPressGestureRecognizer {
        var onTouchBegan: () -> Void = {}
        var onTouchCancelled: () -> Void = {}

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            onTouchBegan()
            super.touchesBegan(touches, with: event)
        }

        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
            super.touchesMoved(touches, with: event)
            if state == .failed || state == .cancelled { onTouchCancelled() }
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
            super.touchesEnded(touches, with: event)
            onTouchCancelled()
        }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
            super.touchesCancelled(touches, with: event)
            onTouchCancelled()
        }

        override func reset() {
            super.reset()
            onTouchCancelled()
        }
    }
}
