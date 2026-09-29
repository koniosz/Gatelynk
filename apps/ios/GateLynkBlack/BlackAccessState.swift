import Foundation
import Observation

/// Deterministic interaction state, separate from presentation and networking.
/// An accepted relay command never means that the gate physically opened.
@MainActor @Observable
final class BlackAccessState {
    enum Phase: Equatable {
        case idle, holding, sending, accepted, unknown
        case failed(String?)
    }

    enum Outcome: Equatable {
        case accepted, unknown, failed(String?)
    }

    struct Command: Equatable {
        let accessPointID: Int
        let token: UUID
    }

    private(set) var selectedID: Int?
    private(set) var phases: [Int: Phase] = [:]
    private(set) var suspended = false
    private var holdStartedAt: Date?
    private var holdID: Int?
    private var commands: [Int: Command] = [:]
    let holdDuration: TimeInterval = 2

    func phase(for id: Int) -> Phase { phases[id, default: .idle] }

    func select(_ id: Int?) {
        guard selectedID != id else { return }
        cancelHold()
        selectedID = id
    }

    func suspend(_ value: Bool) {
        suspended = value
        if value { cancelHold() }
    }

    @discardableResult
    func beginHold(id: Int, now: Date) -> Bool {
        guard !suspended, selectedID == id, phase(for: id) == .idle else { return false }
        holdID = id
        holdStartedAt = now
        phases[id] = .holding
        return true
    }

    func progress(id: Int, now: Date) -> Double {
        guard holdID == id, let start = holdStartedAt else { return 0 }
        return min(1, max(0, now.timeIntervalSince(start) / holdDuration))
    }

    func cancelHold() {
        if let holdID, phase(for: holdID) == .holding { phases[holdID] = .idle }
        holdID = nil
        holdStartedAt = nil
    }

    /// Returns a command once, only after a complete hold on the selected AP.
    func commitHold(id: Int, now: Date) -> Command? {
        guard !suspended, selectedID == id, holdID == id,
              phase(for: id) == .holding, progress(id: id, now: now) >= 1 else { return nil }
        return makeCommand(id: id)
    }

    /// UIKit's long-press recognizer owns the two-second threshold. Do not
    /// measure it again with a second clock after its recognition callback.
    func commitRecognizedHold(id: Int) -> Command? {
        guard !suspended, selectedID == id, holdID == id,
              phase(for: id) == .holding else { return nil }
        return makeCommand(id: id)
    }

    /// Equivalent explicit confirmation for VoiceOver and Switch Control.
    func commitConfirmed(id: Int) -> Command? {
        guard !suspended, selectedID == id, phase(for: id) == .idle else { return nil }
        return makeCommand(id: id)
    }

    private func makeCommand(id: Int) -> Command {
        let command = Command(accessPointID: id, token: UUID())
        holdID = nil
        holdStartedAt = nil
        phases[id] = .sending
        commands[id] = command
        return command
    }

    /// Late replies are associated with their command, never the current card.
    @discardableResult
    func resolve(_ command: Command, outcome: Outcome) -> Bool {
        guard commands[command.accessPointID] == command,
              phase(for: command.accessPointID) == .sending else { return false }
        switch outcome {
        case .accepted: phases[command.accessPointID] = .accepted
        case .unknown: phases[command.accessPointID] = .unknown
        case .failed(let reason): phases[command.accessPointID] = .failed(reason)
        }
        return true
    }

    /// Reset is local UI only; a retry always requires another deliberate hold.
    func resetResult(id: Int) {
        switch phase(for: id) {
        case .accepted, .unknown, .failed:
            phases[id] = .idle
            commands[id] = nil
        default: break
        }
    }
}
