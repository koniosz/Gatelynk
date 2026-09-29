import XCTest

/// Exercises the same native controls as the resident screen using only the
/// DEBUG fixture. No account, API request, APNs registration or device action.
final class BlackUITests: XCTestCase {
    private let idle = "Przytrzymaj, aby otworzyć"
    private let accepted = "Polecenie otwarcia przyjęte"

    @MainActor
    private func launchPreview() -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "com.gatelynk.app.black")
        app.launchArguments = ["-black-design-preview"]
        app.launch()
        XCTAssertTrue(app.buttons["Wybierz wejście: Wjazd"].waitForExistence(timeout: 10))
        expectValue(idle, on: app.buttons["Otwórz: Wjazd"])
        return app
    }

    @MainActor
    private func expectValue(_ value: String, on element: XCUIElement,
                             timeout: TimeInterval = 4,
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), file: file, line: line)
        let matches = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [matches], timeout: timeout), .completed,
                       "Expected control value: \(value); actual: \(String(describing: element.value))",
                       file: file, line: line)
    }

    @MainActor
    private func attach(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    func testShortHoldDoesNotSendCommand() {
        let app = launchPreview()
        let open = app.buttons["Otwórz: Wjazd"]
        open.press(forDuration: 0.35)
        expectValue(idle, on: open)
        // Also reject a delayed send after the original two-second threshold.
        let leavesIdle = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", idle), object: open)
        leavesIdle.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [leavesIdle], timeout: 2.2), .completed)
        attach("Short hold — no command", app: app)
    }

    @MainActor
    func testDraggingAwayCancelsAnUnfinishedHold() {
        let app = launchPreview()
        let open = app.buttons["Otwórz: Wjazd"]
        let start = open.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let outside = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.26))
        start.press(forDuration: 0.5, thenDragTo: outside)
        expectValue(idle, on: open)
        let leavesIdle = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", idle), object: open)
        leavesIdle.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [leavesIdle], timeout: 2.2), .completed)
        attach("Dragged outside — hold cancelled", app: app)
    }

    @MainActor
    func testFullHoldKeepsOutcomeWithItsEntranceAcrossNavigation() {
        let app = launchPreview()
        app.buttons["Otwórz: Wjazd"].press(forDuration: 2.2)
        expectValue(accepted, on: app.buttons["Otwórz: Wjazd"])
        attach("Entrance — command accepted", app: app)

        app.buttons["Sprawy"].tap()
        app.buttons["Dom"].tap()
        expectValue(accepted, on: app.buttons["Otwórz: Wjazd"])

        app.buttons["Wybierz wejście: Wyjazd"].tap()
        expectValue(idle, on: app.buttons["Otwórz: Wyjazd"])
        app.buttons["Wybierz wejście: Wjazd"].tap()
        expectValue(accepted, on: app.buttons["Otwórz: Wjazd"])
        attach("Entrance — outcome retained after navigation", app: app)
    }

    @MainActor
    func testNamedTabsAndHorizontalSwipeSelectTheCorrectEntrance() {
        let app = launchPreview()
        app.buttons["Wybierz wejście: Wyjazd"].tap()
        expectValue(idle, on: app.buttons["Otwórz: Wyjazd"])
        attach("Exit — selected by name", app: app)

        // Swipe the camera area; leave the hold-to-open control untouched.
        let left = app.coordinate(withNormalizedOffset: CGVector(dx: 0.18, dy: 0.29))
        let right = app.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.29))
        left.press(forDuration: 0.05, thenDragTo: right)
        expectValue(idle, on: app.buttons["Otwórz: Wjazd"])
        attach("Entrance — selected by swipe", app: app)
    }

    @MainActor
    func testFireEntranceRequiresItsDedicatedConfirmation() {
        let app = launchPreview()
        app.buttons["Wybierz wejście: Brama pożarowa"].tap()
        let emergency = app.buttons["Brama pożarowa. Otwórz awaryjnie. Wymaga potwierdzenia."]
        XCTAssertTrue(emergency.waitForExistence(timeout: 4))
        emergency.tap()
        XCTAssertTrue(app.staticTexts["Brama pożarowa — podgląd"].waitForExistence(timeout: 4))
        let close = app.buttons["Zamknij podgląd"]
        XCTAssertTrue(close.exists)
        attach("Fire entrance — explicit confirmation", app: app)
        close.tap()
        XCTAssertTrue(emergency.waitForExistence(timeout: 4))
        app.buttons["Wybierz wejście: Wjazd"].tap()
        expectValue(idle, on: app.buttons["Otwórz: Wjazd"])
    }
}
