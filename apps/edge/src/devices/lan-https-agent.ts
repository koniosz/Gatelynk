import * as https from 'https'
import * as crypto from 'crypto'

/**
 * Wspólny agent HTTPS do urządzeń w LAN-ie (domofony, kamery).
 *
 * Dwa powody, dla których nie może to być zwykły `new https.Agent()`:
 *
 * 1. **Self-signed certy** — Akuvox ma CN=akweb, Hikvision własne CA.
 *    Edge żyje za firewallem i gada tylko z urządzeniami w LAN, więc
 *    `rejectUnauthorized: false` jest tu świadomą decyzją, nie niedbalstwem.
 *
 * 2. **Prehistoryczny stos TLS w firmware** (zdiagnozowane 2026-08-05 na
 *    dwóch R29C w instalacji VN). Te kasety negocjują WYŁĄCZNIE:
 *      TLSv1.0 + DHE-RSA-AES256-SHA  (SHA1, słabe DH, bez RFC 5746)
 *    Node 22 / OpenSSL 3 odrzuca to potrójnie i to na długo PRZED
 *    jakimkolwiek HTTP:
 *      - domyślne `minVersion` = TLSv1.2      → ERR_SSL_UNSUPPORTED_PROTOCOL
 *      - domyślny SECLEVEL=1 wycina SHA1/DH   → handshake failure / timeout
 *      - brak secure renegotiation po stronie → ERR_SSL_UNSAFE_LEGACY_
 *        urządzenia                              RENEGOTIATION_DISABLED
 *    Objaw dla użytkownika: „Internal server error" przy otwieraniu
 *    przekaźnika, w logu `write EPROTO ... unsupported protocol` albo
 *    głuchy `timeout of 8000ms exceeded`. MYLĄCE: `curl` z tej samej
 *    maszyny dostaje 200, bo macOS linkuje LibreSSL, który jest
 *    pobłażliwy — więc „z terminala działa, z Edge nie".
 *
 * Ustawienia niżej NIE psują nowoczesnych urządzeń: `maxVersion` zostaje
 * domyślny, a szyfry TLS 1.3 są konfigurowane osobnym polem, którego tu
 * nie ruszamy — nowa kamera dalej negocjuje TLS 1.3. Obniżamy tylko
 * *dolną* granicę tego, co jesteśmy w stanie zaakceptować.
 *
 * `keepAlive` jest tu istotny wydajnościowo: handshake DHE na słabym CPU
 * kasety trwa ~2 s (zmierzone na 192.168.1.10), więc recykling połączenia
 * zdejmuje te 2 s z każdego kolejnego żądania.
 */
const LEGACY_TLS_OPTIONS =
  crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT |
  crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION

export const lanHttpsAgent = new https.Agent({
  rejectUnauthorized: false,
  minVersion: 'TLSv1',
  // 'ALL' + SECLEVEL=0 dopuszcza SHA1/DHE, których wymaga stary firmware.
  // Samo '@SECLEVEL=0' nie wystarcza — domyślna lista szyfrów i tak nie
  // zawiera DHE-RSA-AES256-SHA (potwierdzone eksperymentalnie: bez 'ALL'
  // jedna z kaset kończyła się timeoutem, druga przechodziła).
  ciphers: 'ALL:@SECLEVEL=0',
  secureOptions: LEGACY_TLS_OPTIONS,
  keepAlive: true,
  keepAliveMsecs: 15_000,
})
