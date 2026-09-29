import Foundation

/// Runs only deterministic local state: no UI, accounts, network or devices.
@main
struct BlackAccessStateTests {
    @MainActor static func main() {
        let tests: [(String, () throws -> Void)] = [
            ("requires a complete two-second hold", testHoldThreshold),
            ("cancelling a hold sends no command", testCancelledHold),
            ("changing selection cancels the old hold", testSelectionCancels),
            ("suspension cancels a hold and blocks actions", testSuspension),
            ("one gesture produces one command", testDuplicateCommit),
            ("late answers stay with their access point", testPerAccessPoint),
            ("stale answers cannot override a newer command", testStaleCommand),
            ("UI reset does not retry or clear an in-flight command", testResetIsLocal),
            ("accessible confirmation obeys selection and suspension", testAccessibleConfirmation),
            ("unknown and failed remain distinct from accepted", testOutcomes),
            ("removing the selected point invalidates a hold", testRemovedSelection),
            ("reselecting the same point preserves a deliberate hold", testStableSelection),
            ("native recognition requires an active uncancelled hold", testRecognizedHold),
        ]
        var failures: [String] = []
        for (name, run) in tests {
            do {
                try run()
                print("PASS \(name)")
            } catch {
                failures.append(name)
                print("FAIL \(name): \(error)")
            }
        }
        print("\(tests.count - failures.count)/\(tests.count) BlackAccessState tests passed")
        if !failures.isEmpty { exit(1) }
    }

    enum Failure: Error, CustomStringConvertible {
        case expectation(String, UInt)
        var description: String {
            switch self {
            case .expectation(let message, let line): "line \(line): \(message)"
            }
        }
    }

    private static let start = Date(timeIntervalSince1970: 1_000)

    private static func expect(_ value: @autoclosure () -> Bool, _ message: String, line: UInt = #line) throws {
        if !value() { throw Failure.expectation(message, line) }
    }

    @MainActor private static func holding(_ id: Int = 1) throws -> BlackAccessState {
        let state = BlackAccessState()
        state.select(id)
        try expect(state.beginHold(id: id, now: start), "selected point must allow a hold")
        return state
    }

    @MainActor private static func commit(_ state: BlackAccessState, id: Int = 1) throws -> BlackAccessState.Command {
        guard let command = state.commitHold(id: id, now: start.addingTimeInterval(2)) else {
            throw Failure.expectation("complete hold must produce a command", #line)
        }
        return command
    }

    @MainActor private static func testHoldThreshold() throws {
        let state = try holding()
        try expect(state.progress(id: 1, now: start.addingTimeInterval(-1)) == 0, "progress cannot be negative")
        try expect(state.progress(id: 1, now: start.addingTimeInterval(1)) == 0.5, "one second is half the hold")
        try expect(state.commitHold(id: 1, now: start.addingTimeInterval(1.999)) == nil, "must not send before two seconds")
        try expect(state.phase(for: 1) == .holding, "early commit does not discard a held gesture")
        try expect(state.progress(id: 1, now: start.addingTimeInterval(3)) == 1, "progress cannot exceed one")
        let command = try commit(state)
        try expect(command.accessPointID == 1, "command targets the selected point")
        try expect(state.phase(for: 1) == .sending, "complete hold moves to sending")
    }

    @MainActor private static func testCancelledHold() throws {
        let state = try holding()
        state.cancelHold()
        try expect(state.phase(for: 1) == .idle, "released hold returns to idle")
        try expect(state.progress(id: 1, now: start.addingTimeInterval(5)) == 0, "cancel removes old progress")
        try expect(state.commitHold(id: 1, now: start.addingTimeInterval(5)) == nil, "late gesture callback after cancel cannot send")
        try expect(state.beginHold(id: 1, now: start.addingTimeInterval(5)), "next deliberate hold is allowed")
        try expect(state.commitHold(id: 1, now: start.addingTimeInterval(6)) == nil, "new hold must run its own two seconds")
    }

    @MainActor private static func testSelectionCancels() throws {
        let state = try holding()
        state.select(2)
        try expect(state.phase(for: 1) == .idle, "swipe cancels old hold")
        try expect(state.commitHold(id: 1, now: start.addingTimeInterval(3)) == nil, "old target cannot commit after swipe")
        try expect(!state.beginHold(id: 1, now: start), "offscreen point cannot begin a hold")
        try expect(state.beginHold(id: 2, now: start), "selected point can begin a fresh hold")
    }

    @MainActor private static func testSuspension() throws {
        let state = try holding()
        state.suspend(true)
        try expect(state.phase(for: 1) == .idle, "sheet/background suspends an unfinished hold")
        try expect(state.commitHold(id: 1, now: start.addingTimeInterval(3)) == nil, "suspension prevents late gesture commit")
        try expect(!state.beginHold(id: 1, now: start), "cannot begin while suspended")
        try expect(state.commitConfirmed(id: 1) == nil, "accessibility confirmation is also blocked")
        state.suspend(false)
        try expect(state.commitHold(id: 1, now: start.addingTimeInterval(3)) == nil, "resume never resumes an old hold")
        try expect(state.beginHold(id: 1, now: start), "resume allows a new deliberate hold")
    }

    @MainActor private static func testDuplicateCommit() throws {
        let state = try holding()
        let command = try commit(state)
        try expect(state.commitHold(id: 1, now: start.addingTimeInterval(3)) == nil, "duplicate gesture cannot send twice")
        try expect(state.commitConfirmed(id: 1) == nil, "accessible and gesture actions cannot race into two commands")
        try expect(!state.beginHold(id: 1, now: start), "sending cannot start another hold")
        try expect(state.resolve(command, outcome: .accepted), "first response is applied")
        try expect(!state.resolve(command, outcome: .unknown), "duplicate response cannot overwrite accepted")
        try expect(state.phase(for: 1) == .accepted, "accepted remains accepted")
    }

    @MainActor private static func testPerAccessPoint() throws {
        let state = try holding()
        let first = try commit(state)
        state.select(2)
        try expect(state.beginHold(id: 2, now: start), "another point has independent interaction state")
        let second = try commit(state, id: 2)
        try expect(state.resolve(first, outcome: .accepted), "late first answer is retained")
        try expect(state.phase(for: 1) == .accepted, "first point receives its own answer")
        try expect(state.phase(for: 2) == .sending, "first answer never changes the second point")
        try expect(state.resolve(second, outcome: .unknown), "second answer is independent")
        try expect(state.phase(for: 1) == .accepted && state.phase(for: 2) == .unknown, "both states stay independent")
    }

    @MainActor private static func testStaleCommand() throws {
        let state = try holding()
        let first = try commit(state)
        try expect(state.resolve(first, outcome: .unknown), "initial unknown response is applied")
        state.resetResult(id: 1)
        try expect(state.beginHold(id: 1, now: start), "explicit new hold follows reset")
        let second = try commit(state)
        try expect(first.token != second.token, "each command has a unique identity")
        try expect(!state.resolve(first, outcome: .accepted), "stale accepted response cannot override new command")
        try expect(state.phase(for: 1) == .sending, "new command stays sending")
        try expect(state.resolve(second, outcome: .failed("Brak uprawnień")), "new command receives its own failure")
        try expect(state.phase(for: 1) == .failed("Brak uprawnień"), "failure reason is retained")
    }

    @MainActor private static func testResetIsLocal() throws {
        let state = try holding()
        let command = try commit(state)
        state.resetResult(id: 1)
        try expect(state.phase(for: 1) == .sending, "reset cannot clear an in-flight command")
        try expect(state.commitConfirmed(id: 1) == nil, "reset cannot create a second physical request")
        try expect(state.resolve(command, outcome: .accepted), "in-flight response is still accepted")
        state.resetResult(id: 1)
        try expect(state.phase(for: 1) == .idle, "completed result returns locally to idle")
        try expect(state.commitHold(id: 1, now: start.addingTimeInterval(9)) == nil, "reset itself is never retry authorization")
        try expect(!state.resolve(command, outcome: .accepted), "reset removes the completed command token")
    }

    @MainActor private static func testAccessibleConfirmation() throws {
        let state = BlackAccessState()
        state.select(1)
        try expect(state.commitConfirmed(id: 2) == nil, "confirmation cannot target a different card")
        state.suspend(true)
        try expect(state.commitConfirmed(id: 1) == nil, "confirmation cannot act behind a sheet")
        state.suspend(false)
        let command = state.commitConfirmed(id: 1)
        try expect(command?.accessPointID == 1, "explicit accessibility confirmation provides an equivalent command")
        try expect(state.phase(for: 1) == .sending, "confirmation moves to sending")
    }

    @MainActor private static func testOutcomes() throws {
        let cases: [(BlackAccessState.Outcome, BlackAccessState.Phase)] = [
            (.accepted, .accepted), (.unknown, .unknown),
            (.failed(nil), .failed(nil)), (.failed("Sesja wygasła"), .failed("Sesja wygasła")),
        ]
        for (outcome, expected) in cases {
            let state = try holding()
            let command = try commit(state)
            try expect(state.resolve(command, outcome: outcome), "outcome must be accepted for the matching command")
            try expect(state.phase(for: 1) == expected, "must preserve the exact API outcome")
        }
    }

    @MainActor private static func testRemovedSelection() throws {
        let state = try holding()
        state.select(nil)
        try expect(state.selectedID == nil, "empty/revoked list has no selected point")
        try expect(state.phase(for: 1) == .idle, "removing a point cancels its hold")
        try expect(state.commitHold(id: 1, now: start.addingTimeInterval(3)) == nil, "removed target cannot commit")
        try expect(state.commitConfirmed(id: 1) == nil, "removed target cannot confirm")
    }

    @MainActor private static func testStableSelection() throws {
        let state = try holding()
        state.select(1)
        try expect(state.phase(for: 1) == .holding, "unchanged API refresh must not cancel the same selection")
        _ = try commit(state)
    }

    @MainActor private static func testRecognizedHold() throws {
        let state = BlackAccessState()
        state.select(1)
        try expect(state.commitRecognizedHold(id: 1) == nil, "recognition cannot invent a touch")
        try expect(state.beginHold(id: 1, now: start), "touch begins an active hold")
        state.cancelHold()
        try expect(state.commitRecognizedHold(id: 1) == nil, "cancelled touch cannot commit")
        try expect(state.beginHold(id: 1, now: start), "new touch begins another hold")
        state.suspend(true)
        try expect(state.commitRecognizedHold(id: 1) == nil, "background or sheet prevents recognition")
        state.suspend(false)
        try expect(state.beginHold(id: 1, now: start), "foreground permits a fresh hold")
        try expect(state.commitRecognizedHold(id: 2) == nil, "recognition is tied to the selected point")
        try expect(state.commitRecognizedHold(id: 1)?.accessPointID == 1, "recognized hold commits its point")
        try expect(state.commitRecognizedHold(id: 1) == nil, "one recognized hold cannot repeat a command")
    }
}
