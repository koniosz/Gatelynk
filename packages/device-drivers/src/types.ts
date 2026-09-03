/**
 * Wspólny model „drivera urządzenia" — używany jako jedno źródło prawdy przez:
 *   • web (apps/web)  — do dynamicznego renderowania formularza konfiguracyjnego,
 *   • Edge (apps/edge) — do dispatchowania akcji (otwórz drzwi, snapshot, restart…)
 *     bez sztywnych `if (manufacturer === 'akuvox')` rozsianych po serwisach,
 *   • Cloud API (apps/api) — do walidacji configu przed zapisem.
 *
 * Założenie: jedna instancja drivera obsługuje rodzinę modeli o tej samej
 * sygnaturze API (np. wszystkie Hikvision z ISAPI, wszystkie Akuvox SmartPlus).
 * Jeżeli model wymaga innego endpointu lub innego zestawu pól → osobny driver.
 */

/** Typ urządzenia w panelu — odpowiednik enuma w Edge (`device_config.type`). */
export type DeviceType =
  | 'INTERCOM'
  | 'CAMERA'
  | 'LPR_CAMERA'
  | 'ELEVATOR'
  | 'LIGHTING'
  | 'SWITCH'       // Shelly Pro 1 + inne on/off relay-only urządzenia LAN
  | 'LAN_SWITCH'   // managed L2/L3 switch (UniFi, Cisco) — port monitoring, PoE on/off, port→device assignment
  | 'LOCK'         // Tedee, Nuki — smart-locki (LAN lub cloud-bound)
  | 'KNX_BRIDGE'   // KNX-IP router/interface (eelectron, Jung, Gira) — bramka między LAN a magistralą KNX
  | 'KNX_OBJECT'   // logiczny obiekt na buście (mapowanie group address → funkcja); rodzic to KNX_BRIDGE

/**
 * Dostępne typy pól w formularzu. UI mapuje to bezpośrednio na komponent:
 *   text → <input type="text">, password → <input type="password">,
 *   number → <input type="number">, select → <select>,
 *   boolean → <input type="checkbox">,
 *   relays → custom edytor listy {index, name},
 *   textarea → <textarea> (np. dla pre-shared keys, MAC list).
 */
export type FieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'select'
  | 'boolean'
  | 'textarea'
  | 'relays'
  | 'mac'              // adres MAC — walidacja XX:XX:XX:XX:XX:XX (KNX bridge, Shelly OUI lookup)
  | 'group-address'    // KNX group address — walidacja "1/0/1" (3-poziomowy) lub "1/1" (2-poziomowy)
  | 'discovery-pick'   // przycisk „Znajdź w sieci" → uruchamia mDNS/scan przez Edge i wybiera z listy
  | 'repeating-group'  // tablica pod-obiektów (np. lista KNX objects pod jednym bridge'em)

/**
 * Grupy pól — wszystkie pola o tej samej grupie renderują się w jednej karcie
 * formularza. Pozwala to bez kopiowania UI dorzucić nowy parametr w istniejącą
 * sekcję (np. nowe pole RTSP wpada do karty „RTSP / Streaming").
 */
export type FieldGroup =
  | 'network'    // adres IP, porty
  | 'auth'       // login/hasło HTTP
  | 'rtsp'       // streaming
  | 'relays'     // przekaźniki / drzwi
  | 'lpr'        // parametry LPR (whitelist sync, listy plate'ów)
  | 'ai'         // AI/Frigate hooks (gdy doda się Frigate)
  | 'cloud'      // klucze API / tokeny do chmury producenta (Tedee PAK, Nuki Web token, …)
  | 'knx'        // KNX-specific: group addresses, datapoint types, fizyczny adres bridge'a
  | 'advanced'   // rzadko używane, schowane domyślnie pod „Zaawansowane"

export interface DriverField {
  /** Klucz w `config.<key>` zapisywany do bazy/Edge. */
  key: string
  /** Etykieta po polsku, widoczna w formularzu. */
  label: string
  type: FieldType
  group: FieldGroup
  required?: boolean
  /** Wartość domyślna (np. `'admin'`, `554`, `1`). */
  default?: unknown
  /** Krótki opis pod inputem (tooltip / help text). */
  help?: string
  /** Placeholder w polu tekstowym. */
  placeholder?: string
  /** Opcje dla `type: 'select'`. */
  options?: { value: string; label: string }[]
  /**
   * Walidacja w UI — jeżeli zwróci string, traktujemy go jako error message.
   * Stringową regex można zapisać też w `pattern`, ale ta funkcja jest
   * elastyczniejsza (np. „port 1..65535").
   */
  validate?: (value: unknown, cfg: Record<string, unknown>) => string | null
  /**
   * Dynamiczna widoczność pola na podstawie innych pól. Przykład:
   * pole `rtspPath` pokazuj tylko gdy user zaznaczy `customRtspPath: true`.
   */
  showWhen?: (cfg: Record<string, unknown>) => boolean
  /**
   * Min/max dla pól liczbowych — UI ustawia `min`/`max` na <input>.
   */
  min?: number
  max?: number
}

/** Co dany driver potrafi — UI używa do pokazania/ukrycia kafli „Snapshot",
 *  „Restart", „MJPEG live"; Edge — do walidacji „czy mogę wywołać tę akcję". */
export type Capability =
  | 'openDoor'
  | 'snapshot'
  | 'mjpeg'
  | 'restart'
  | 'lprPushList'   // umie odebrać listę tablic do zapisania w kamerze
  | 'lprEvents'     // pushuje eventy ANPR przez ISAPI/HTTP host
  | 'aiAnalytics'   // posiada własny detektor (Frigate-like, np. Hik DeepInView)
  | 'toggle'        // SWITCH (Shelly/relay): on/off — bez stanu pośredniego
  | 'setLevel'      // DIMMER/BLINDS: 0–100% (przyszłość — placeholder, jeszcze nie używane)
  | 'lock'          // LOCK: zamknij zamek
  | 'unlock'        // LOCK: otwórz zamek
  | 'holdOpen'      // INTERCOM: trzymaj otwartą bramę X sekund (kurier, ekipa remontowa)
  | 'dnd'           // INTERCOM: Do Not Disturb — wyłącz dzwonienia na noc (portier)
  | 'discoverable'  // driver ma definicję `endpoints.discovery` — Edge potrafi go wykryć w LAN

/** Definicja akcji RPC — jak wykonać ją na realnym urządzeniu. */
export interface ActionEndpoint {
  /**
   * Protokół wykonania. Większość driverów to klasyczne HTTP (default).
   * - `http` — standardowy HTTP/HTTPS (placeholder {ip}, {httpPort}, …)
   * - `knxnet-ip` — KNXnet/IP tunneling (UDP, group address w `body`)
   * - `cloud` — driver-specific cloud SDK (np. Tedee API) — `url` to endpoint
   *   chmury, Edge musi mieć w configu token (np. `personalAccessKey`).
   * Pominięcie pola = `http` (backwards-compat z istniejącymi driverami).
   */
  protocol?: 'http' | 'knxnet-ip' | 'cloud'
  /** HTTP metoda. Dla `protocol='knxnet-ip'` ignorowana. */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /**
   * Szablon URL z placeholderami `{ip}`, `{port}`, `{login}`, `{relay}`, itd.
   * Patrz `template.ts` — funkcja `renderTemplate` rozwija wyrażenia takie jak
   * `{channel*100+1}` (Hikvision: kanał 1 → stream 101).
   *
   * Dla `protocol='cloud'` URL może być pełnym URL-em do API producenta
   * (np. `https://api.tedee.com/api/v1.32/lock/{lockId}/operation/unlock`).
   * Dla `protocol='knxnet-ip'` URL nie jest używany — patrz `body` (GA + value).
   */
  url: string
  /**
   * Schemat autoryzacji.
   * - `basic`/`digest` — standardowe HTTP
   * - `bearer` — `Authorization: Bearer {config.token}` (typowe dla cloud API)
   * - `apikey` — driver-specific header (np. `X-Api-Key: {config.apiKey}`)
   * - `none` — brak nagłówków auth (np. Akuvox LAN whitelist)
   */
  auth: 'basic' | 'digest' | 'bearer' | 'apikey' | 'none'
  /** Body dla POST/PUT (template też podlega rozwijaniu). */
  body?: string
  /** Content-Type body. */
  contentType?: string
  /** Akceptowane kody odpowiedzi (default: 200..299). */
  okStatus?: number[]
}

/**
 * Opis sposobu wykrywania urządzeń w LAN dla konkretnego drivera. Edge
 * używa tego w module `discovery/` (mDNS browse + ARP-OUI lookup) żeby
 * po jednym skanie zaproponować integratorowi listę kandydatów z
 * sugerowanym `driverId`.
 */
export interface DiscoveryHints {
  /**
   * Nazwa serwisu mDNS — np. `_shelly._tcp` dla Shelly Gen2/3, `_http._tcp`
   * dla generycznych urządzeń. Może być array (Shelly Pro publikuje
   * `_shelly._tcp` ORAZ `_http._tcp` z różnym TXT).
   */
  mdnsService?: string | string[]
  /**
   * Wzorzec hostname'u w mDNS (np. `/^shellypro1-/`) — gdy publikacja jest
   * pod genericznym `_http._tcp`, hostname zwykle wskazuje producenta.
   */
  mdnsHostnamePattern?: RegExp
  /**
   * Lista prefiksów OUI (3 pierwsze oktety MAC) dla ARP-lookup fallback.
   * Format: `'00:1F:7C'` (uppercase, separator `:`). Przykład: Akuvox = `B0:1F:81`,
   * Shelly/Allterco = `B8:27:EB` (też Raspberry Pi!), Hikvision = `C0:51:7E`.
   */
  macPrefixes?: string[]
  /**
   * Test HTTP banner — Edge robi `HEAD/GET` na podanej ścieżce i sprawdza
   * nagłówek (np. `Server: Hikvision`, `WWW-Authenticate: realm="akweb"`).
   * Używane gdy mDNS i ARP są niejednoznaczne.
   */
  httpProbe?: {
    path: string
    port?: number
    expectHeader?: { name: string; pattern: RegExp }
  }
  /**
   * Driver „bez sieci LAN" — discovery nie skanuje LAN. Ten wpis oznacza
   * tylko: pokaż w wizardzie pole `personalAccessKey` (cloud), pomiń mDNS.
   * Przykład: Tedee, Nuki Web API.
   */
  cloudBound?: boolean
}

/** Endpointy producenta — używane przez Edge zamiast `if (m.includes('hik'))`. */
export interface DriverEndpoints {
  /**
   * Lista URLi do testu połączenia (kolejność = priorytet, próbujemy pierwszy działający).
   * Dla `pingProtocol='knxnet-ip'` ignorowane — Edge zamiast HTTP robi
   * KNXnet/IP `SEARCH_REQUEST` na multicast 224.0.23.12:3671.
   */
  ping?: string[]
  /**
   * Protokół testu połączenia. Default `http` — pinguje pierwszy URL z `ping[]`.
   * Dla KNX bridge'a `knxnet-ip` — Edge emituje SEARCH_REQUEST i czeka na
   * SEARCH_RESPONSE od konkretnego IP/portu. Dla cloud-bound driverów
   * `cloud` — Edge robi authenticated request na `ping[0]` z tokenem.
   */
  pingProtocol?: 'http' | 'knxnet-ip' | 'cloud'
  /** URLe do snapshotu (HTTP). Edge próbuje po kolei. */
  snapshot?: string[]
  /**
   * Templaty ścieżek RTSP (bez `rtsp://user:pass@ip:port/`). Pierwszy = main,
   * drugi = sub. Przykład Hikvision: `'Streaming/Channels/{channel*100+1}'`.
   */
  rtspPath?: string[]
  /** Restart całego urządzenia. */
  restart?: ActionEndpoint
  /** Otwarcie przekaźnika nr `{relay}`. */
  openDoor?: ActionEndpoint
  /** Zamknięcie przekaźnika (rzadko wspierane — np. Akuvox). */
  closeDoor?: ActionEndpoint
  /**
   * Trzymaj otwarte przez `{seconds}` sekund (intercom HOLD_OPEN). Większość
   * intercomów tego nie ma natywnie — Edge symuluje przez setTimeout +
   * cykliczne `openDoor`. Pole istnieje na wypadek gdyby Hikvision/Akuvox
   * mieli natywny endpoint w przyszłości.
   */
  holdOpen?: ActionEndpoint
  /** SWITCH on/off — Shelly Pro 1 i inne relay-only. `{state}` = `'on'|'off'`. */
  toggle?: ActionEndpoint
  /** LOCK: zamknij — Tedee/Nuki. */
  lock?: ActionEndpoint
  /** LOCK: otwórz — Tedee/Nuki. */
  unlock?: ActionEndpoint
  /**
   * INTERCOM: Do Not Disturb on/off. `{state}` w body lub URL podstawiane na
   * `'on'|'off'` (lub `'1'|'0'`) zależnie od firmware-specific syntaxu.
   * Akuvox: `/fcgi/do?action=DoNotDisturb&op={state}`.
   */
  setDnd?: ActionEndpoint
  /** Hinty dla modułu discovery — patrz `DiscoveryHints` wyżej. */
  discovery?: DiscoveryHints
}

/**
 * „Zaszyte stałe drivera" — opinionated values specyficzne dla konkretnego
 * modelu / firmware. Dane Z RESEARCH-U i TESTÓW, nie z konfiguracji instalatora.
 *
 * Cel: skrócić liczbę pól w wizardzie (UX), schować firmware-specific quirki
 * (np. Akuvox „Not Safe" → wymusza `requiresUnauthenticatedFallback`), umożliwić
 * driver-update bez zmian per-instalację.
 *
 * Reguła pierwszeństwa przy renderowaniu URL/body endpointów (patrz
 * `buildTemplateVars` w `apps/edge/src/devices/driver-engine.ts`):
 *   1. `extras` (runtime, np. `{relay}` przy openDoor) — najwyższy priorytet
 *   2. `config` (user-supplied z formularza wizarda) — override
 *   3. `constants` (zaszyte w driverze) — fallback
 *
 * Logika: instalator może świadomie nadpisać constant przez ręczny wpis pola
 * (np. dla nietypowej kamery z portem 8443 zamiast 443), ale w 95% przypadków
 * constants są zostawione w spokoju → mniej pól, mniejsze ryzyko błędu.
 */
export interface DriverConstants {
  // ── Network / HTTP ──
  /** Port HTTP/HTTPS. Akuvox=443, Hikvision=80, Shelly=80, KNX-IP=3671. */
  httpPort?: number
  /** Timeout dla pojedynczego HTTP requestu (otwórz drzwi, restart). */
  httpTimeoutMs?: number
  /** Czas trzymania przekaźnika podczas OPEN_DOOR (sekundy). Większość urządzeń
   *  reguluje to po stronie firmware — to wartość INFORMACYJNA dla UI mieszkańca. */
  relayPulseSeconds?: number
  /** Max długość trzymania bramy otwartej (capability `holdOpen`, gdy dorzucone). */
  holdOpenMaxSeconds?: number

  // ── RTSP / streaming ──
  rtspPort?: number
  /** Ścieżka RTSP (bez `rtsp://login:hasło@ip:port/`). Akuvox=`live/ch00_0`,
   *  Hikvision=`Streaming/Channels/{channel*100+1}`. */
  rtspPath?: string
  snapshotTimeoutMs?: number

  // ── MJPEG ──
  /** Port natywnego MJPEG (Akuvox=8080). 0 lub undefined = brak MJPEG. */
  mjpegPort?: number

  // ── LPR-specific ──
  /** Próg pewności rozpoznania tablicy (0.0-1.0). Hikvision domyślnie 0.8. */
  confidenceThreshold?: number
  minPlateLength?: number
  maxPlateLength?: number
  /** Cooldown sekund między detekcjami tego samego pojazdu — żeby nie zapisywać
   *  20 detekcji gdy auto stoi przed bramą. */
  eventCooldownSeconds?: number

  // ── KNX-specific ──
  knxRepeatCount?: number
  knxResponseTimeoutMs?: number

  // ── Auth quirks ──
  /** True dla Shelly Pro (Gen2 RPC wymaga digest gdy hasło ustawione). */
  requiresDigestAuth?: boolean
  /** True dla Akuvox 18.30.x — HTTPS basic auth → „Not Safe -4", więc driver
   *  używa HTTPS bez auth na :443 (intercom whitelistuje LAN przy LAN-only). */
  requiresUnauthenticatedFallback?: boolean

  // ── Extension point ──
  /** Dowolne dodatkowe constants specyficzne dla drivera — driver-engine i Edge
   *  services mogą je czytać przez `driver.constants?.[key]`. Trzymane jako
   *  `unknown` żeby nie zaśmiecać top-level typu. */
  [key: string]: unknown
}

/**
 * Status certyfikacji drivera — informacja dla wizarda UI i marketingu.
 * Driver z `certified` = testowany przez GateLynk QA na konkretnym fw.
 * Driver `beta` = działa u jednego klienta, ale nie ma formalnego sign-offu.
 * Driver `untested` = napisany na podstawie dokumentacji, nikt nie testował.
 * Driver `community` = przyjęty z PR-a (kiedyś), GateLynk nie utrzymuje.
 */
export interface DriverCertification {
  status: 'certified' | 'beta' | 'untested' | 'community'
  /** Lista firmware-versions na których driver był testowany (z opcjonalnym
   *  wildcard, np. `'18.30.*'`). UI może ostrzec instalatora gdy fw urządzenia
   *  nie pasuje (Faza X — auto-discovery fw version przez `Hikvision.deviceInfo`). */
  testedFirmware?: string[]
  /** Data ostatniego testu (ISO 8601, np. `'2026-05-08'`). */
  testedAt?: string
  /** Kto testował — typowo `'GateLynk QA'` lub initials inżyniera. */
  testedBy?: string
  /** Lista znanych issue + workaroundów. Pokazywane w UI po kliknięciu w badge. */
  knownIssues?: string[]
  /** Rekomendowany typ instalacji — UI w wizardzie pokazuje to jako hint. */
  recommendedFor?: 'residential' | 'commercial' | 'enterprise'
}

export interface DeviceDriver {
  /** Stabilny identyfikator (kebab-case). Zapisywany w `config.driverId`. */
  id: string
  type: DeviceType
  manufacturer: string
  /** Lista modeli pokrywanych przez tego drivera (do pickera „Model"). */
  models: string[]
  /** Wyświetlana etykieta w pickerze. */
  label: string
  icon?: string
  /** Krótka instrukcja dla integratora (1-2 zdania). */
  notes?: string
  capabilities: Capability[]
  /**
   * **Pola formularza wizarda** — TYLKO instalacja-specyficzne (IP, login,
   * hasło, mapowanie przekaźników). Driver-specific stałe (porty, ścieżki RTSP,
   * timeoutowy, quirki firmware) idą do `constants` — instalator ich nie widzi.
   */
  fields: DriverField[]
  endpoints: DriverEndpoints
  /** Pre-fill defaultów pól — wywoływane gdy user wybiera tego drivera. */
  defaults?: Record<string, unknown>
  /**
   * Zaszyte stałe drivera — patrz dokumentacja `DriverConstants`. UI nie pokazuje;
   * Edge service i driver-engine czytają i używają w URL-templates / logice.
   */
  constants?: DriverConstants
  /**
   * Status certyfikacji — UI wizarda pokazuje badge (`✅ Certyfikowany`, `🟡 Beta`).
   * Brak pola = traktujemy jak `untested` (default conservatively).
   */
  certification?: DriverCertification
}
