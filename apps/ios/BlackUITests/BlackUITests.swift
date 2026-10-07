import XCTest

/// Exercises the same native controls as the resident screen using only the
/// DEBUG fixture. No account, API request, APNs registration or device action.
final class BlackUITests: XCTestCase {
    private let idle = "Przytrzymaj, aby otworzyć"
    private let accepted = "Polecenie otwarcia przyjęte"

    @MainActor
    private func launchPreview(extraArguments: [String] = []) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "com.gatelynk.app.black")
        app.launchArguments = ["-black-design-preview"] + extraArguments
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
        // Wynik sam znika po 4 s, a nawigacja w symulatorze trwa dłużej —
        // tu sprawdzamy przypisanie wyniku do wejścia, nie czas wygaszania.
        let app = launchPreview(extraArguments: ["-black-result-seconds", "120"])
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

    /// 2026-10-07: wynik nie wisi do stuknięcia — po kilku sekundach przycisk
    /// sam wraca do „Przytrzymaj, aby otworzyć".
    @MainActor
    func testOutcomeReturnsToIdleOnItsOwn() {
        let app = launchPreview()
        let open = app.buttons["Otwórz: Wjazd"]
        open.press(forDuration: 2.2)
        expectValue(accepted, on: open)
        expectValue(idle, on: open, timeout: 10)
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

    // MARK: Warianty podglądu (2026-09-30) — stany P1 z raportu weryfikacji

    @MainActor
    private func launchPreview(variant: String) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "com.gatelynk.app.black")
        app.launchArguments = ["-black-design-preview", "-black-preview-variant", variant]
        app.launch()
        return app
    }

    /// Kamera offline to stan PODGLĄDU: nakładka „Obraz nieaktualny" z akcją
    /// odświeżenia nie blokuje świadomego otwarcia i nie zmienia wyniku polecenia.
    @MainActor
    func testOfflineCameraOverlayDoesNotBlockDeliberateOpen() {
        let app = launchPreview(variant: "camera-offline")
        XCTAssertTrue(app.staticTexts["Obraz nieaktualny"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Odśwież podgląd kamery: Wjazd"].exists)
        let open = app.buttons["Otwórz: Wjazd"]
        expectValue(idle, on: open)
        open.press(forDuration: 2.2)
        expectValue(accepted, on: open)
        XCTAssertTrue(app.staticTexts["Obraz nieaktualny"].exists, "wynik polecenia nie „naprawia” stanu kamery")
        attach("Offline camera — command accepted independently", app: app)
    }

    /// Więcej niż trzy wejścia: selektor się przewija, wybrany segment jest
    /// dosuwany do widoku, a karta i sterowanie należą do wybranego wejścia.
    @MainActor
    func testMoreThanThreeEntrancesKeepSelectorAndCardInSync() {
        let app = launchPreview(variant: "many-gates")
        XCTAssertTrue(app.buttons["Wybierz wejście: Wjazd"].waitForExistence(timeout: 10))
        app.buttons["Wybierz wejście: Furtka od ul. Niewinnej"].tap()
        expectValue(idle, on: app.buttons["Otwórz: Furtka od ul. Niewinnej"])
        let last = app.buttons["Wybierz wejście: Garaż podziemny"]
        XCTAssertTrue(last.waitForExistence(timeout: 4))
        last.tap()
        expectValue(idle, on: app.buttons["Otwórz: Garaż podziemny"])
        // Karty spoza wyboru są ukryte dla dostępności — sterowanie należy tylko do wybranego wejścia.
        XCTAssertFalse(app.buttons["Otwórz: Wjazd"].exists)
        attach("Five entrances — last selected", app: app)
    }
}
