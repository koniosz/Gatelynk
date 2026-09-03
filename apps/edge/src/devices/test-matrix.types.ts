/**
 * Test matrix — wynik diagnostyki urządzenia per-capability.
 *
 * Krok 4 wizarda dodawania urządzenia ("Test") konsumuje to bezpośrednio:
 *  • zielony check gdy `tested: true, ok: true`
 *  • żółty „supported, kliknij Test" gdy `supported: true, tested: false`
 *  • szary „nie wspiera" gdy `supported: false`
 *  • czerwony błąd gdy `tested: true, ok: false`
 *
 * Akcje destrukcyjne (restart, openDoor) **nigdy** nie są autotestowane —
 * UI ma osobne przyciski „Test restart" / „Test relay" wywołujące już
 * istniejące endpointy (`POST /devices/:id/restart`, `/relay/:relayIndex`).
 */

/**
 * Jeden wpis matrycy. Wspólny kształt dla wszystkich capabilities.
 *  • `supported: false` → driver nie wystawia tej akcji (nie ma `endpoints.openDoor`).
 *  • `supported: true, tested: false` → wystawiana, ale nie wykonywaliśmy
 *    (destrukcyjne lub wymaga interakcji manualnej). `hint` mówi co dalej.
 *  • `supported: true, tested: true, ok: true` → przeszło, `detail` opisuje co dokładnie.
 *  • `supported: true, tested: true, ok: false` → padło, `error` wyjaśnia dlaczego.
 */
export interface TestMatrixEntry {
  /** Driver wystawia tę akcję (`endpoints.<capability>` istnieje). */
  supported: boolean
  /** Czy faktycznie wywołaliśmy test (vs supported_untested). */
  tested: boolean
  /** Wynik testu, gdy `tested === true`. */
  ok?: boolean
  /** Krótki opis sukcesu, np. "200 OK, 84 KB". */
  detail?: string
  /** Tekstowy hint dla UI gdy `tested: false` — np. "Kliknij Test relay 1". */
  hint?: string
  /** Treść błędu, gdy `ok: false`. */
  error?: string
  /** Czas wykonania testu w ms (jeśli mierzony). */
  latencyMs?: number
}

/**
 * Cała macierz testowa dla jednego urządzenia. Klucze to capabilities
 * + dwie kategorie "syntetyczne":
 *   • `network` — TCP reach, podstawa (wszystko inne ma sens tylko gdy OK)
 *   • `auth`    — login/hasło działa (jeśli driver wymaga auth)
 */
export interface TestMatrix {
  deviceId: string
  driverId: string | null
  /** Snapshot configu używanego do testu (bez `password`/`personalAccessKey`). */
  ip?: string
  port?: number
  /** Czy device w ogóle istnieje w store. */
  found: boolean
  /** Globalny stan — true jeśli `network.ok && auth.ok` (lub auth nie wymagane). */
  online: boolean
  /** Wykonane od → do (ms timestamp). */
  startedAt: number
  finishedAt: number
  /** Lista entries — co testowaliśmy + wynik. */
  capabilities: {
    network:     TestMatrixEntry  // zawsze obecne (TCP ping)
    auth:        TestMatrixEntry  // sprawdza login/hasło (jeśli driver wymaga)
    ping:        TestMatrixEntry  // HTTP ping na driver.endpoints.ping[0]
    snapshot?:   TestMatrixEntry  // cameras/intercoms
    restart?:    TestMatrixEntry  // SUPPORTED-only (destrukcyjne)
    openDoor?:   TestMatrixEntry  // SUPPORTED-only (destrukcyjne)
    toggle?:     TestMatrixEntry  // SWITCH (Shelly) — SUPPORTED-only
    lock?:       TestMatrixEntry  // LOCK (Tedee) — SUPPORTED-only
    unlock?:     TestMatrixEntry  // LOCK (Tedee) — SUPPORTED-only
    rtsp?:       TestMatrixEntry  // istnieje rtspPath w driverze (informacyjnie — brak ping)
    lprPushList?: TestMatrixEntry // LPR — supported flag
    lprEvents?:  TestMatrixEntry  // LPR — supported flag
    mjpeg?:      TestMatrixEntry  // MJPEG live (informacyjnie)
  }
}
