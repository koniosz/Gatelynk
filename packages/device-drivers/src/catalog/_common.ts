/**
 * Re-używalne fragmenty schematu pól. Większość urządzeń ma identyczne
 * sekcje sieci/auth — definiujemy je raz, driverzy importują i mogą
 * nadpisywać `default` per-producent.
 */
import type { DriverField } from '../types'

export const FIELD_IP: DriverField = {
  key: 'ipAddress',
  label: 'Adres IP',
  type: 'text',
  group: 'network',
  required: true,
  placeholder: 'np. 192.168.1.100',
  validate: (v) => {
    if (typeof v !== 'string' || v.trim() === '') return 'Wymagane'
    // Prosta walidacja — pełnego IPv4/IPv6 nie sprawdzamy, bo niektóre kamery
    // mają nazwy hostów (DDNS).
    if (!/^[a-zA-Z0-9.\-:]+$/.test(v)) return 'Nieprawidłowy adres'
    return null
  },
}

export const FIELD_HTTP_PORT: DriverField = {
  key: 'httpPort',
  label: 'Port HTTP',
  type: 'number',
  group: 'network',
  default: 80,
  min: 1,
  max: 65535,
  help: 'Port webowego API. Domyślnie 80, dla HTTPS-only 443.',
}

export const FIELD_LOGIN = (defaultLogin = 'admin'): DriverField => ({
  key: 'login',
  label: 'Login',
  type: 'text',
  group: 'auth',
  default: defaultLogin,
  required: true,
  placeholder: defaultLogin,
})

export const FIELD_PASSWORD: DriverField = {
  key: 'password',
  label: 'Hasło',
  type: 'password',
  group: 'auth',
  required: true,
  help: 'Hasło konta administratora urządzenia (HTTP).',
}

export const FIELD_RTSP_PORT: DriverField = {
  key: 'rtspPort',
  label: 'Port RTSP',
  type: 'number',
  group: 'rtsp',
  default: 554,
  min: 1,
  max: 65535,
}

export const FIELD_CHANNEL: DriverField = {
  key: 'channel',
  label: 'Kanał',
  type: 'number',
  group: 'rtsp',
  default: 1,
  min: 1,
  max: 64,
  help: 'Numer kanału w NVR (1 = pierwszy). Dla pojedynczej kamery zostaw 1.',
}

export const FIELD_RTSP_LOGIN: DriverField = {
  key: 'rtspLogin',
  label: 'Login RTSP (opcjonalnie)',
  type: 'text',
  group: 'rtsp',
  help: 'Wypełnij tylko jeśli RTSP używa innego użytkownika niż HTTP.',
}

export const FIELD_RTSP_PASSWORD: DriverField = {
  key: 'rtspPassword',
  label: 'Hasło RTSP (opcjonalnie)',
  type: 'password',
  group: 'rtsp',
  help: 'Wypełnij tylko jeśli RTSP używa innego hasła niż HTTP.',
}

export const FIELD_RTSP_PATH_OVERRIDE: DriverField = {
  key: 'rtspPath',
  label: 'Niestandardowa ścieżka RTSP',
  type: 'text',
  group: 'advanced',
  help: 'Nadpisuje domyślną ścieżkę drivera. Użyj gdy kamera ma niestandardowy URL streamu.',
}

export const FIELD_RELAYS: DriverField = {
  key: 'relays',
  label: 'Przekaźniki / wyjścia',
  type: 'relays',
  group: 'relays',
  help: 'Każdy przekaźnik = jedne drzwi/brama. Numer = port w urządzeniu (zwykle 1, 2, 3).',
}

export const FIELD_NAME: DriverField = {
  key: 'name',
  label: 'Nazwa (opis)',
  type: 'text',
  group: 'network',
  placeholder: 'np. Domofon — wejście główne',
  help: 'Etykieta wyświetlana w panelach (mieszkańcy, portier).',
}

// ─────────────────────────────────────────────────────────────────────────────
//  Faza 1 (uniwersalny wizard) — nowe pola dla SWITCH / LOCK / KNX driverów
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adres MAC urządzenia — opcjonalny w UI, ale przydatny jako stabilny
 * identyfikator (Shelly zmienia IP po DHCP renew; KNX-IP router zwykle ma stały
 * IP, ale w pre-stage instalacji MAC z naklejki jest jedynym pewnym ID).
 * Walidacja: 6 oktetów po dwa znaki hex, separator `:` lub `-`.
 */
export const FIELD_MAC: DriverField = {
  key: 'mac',
  label: 'MAC',
  type: 'mac',
  group: 'network',
  placeholder: 'np. B8:27:EB:1A:2B:3C',
  help: 'Opcjonalnie — gdy IP się zmieni przez DHCP, Edge może odnaleźć urządzenie po MAC.',
  validate: (v) => {
    if (v == null || v === '') return null // optional
    if (typeof v !== 'string') return 'Nieprawidłowy format'
    if (!/^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/.test(v)) {
      return 'Format: XX:XX:XX:XX:XX:XX (6 par hex)'
    }
    return null
  },
}

/**
 * Tedee Personal Access Key — token z konta tedee.com (Profile → Personal Access Key).
 * Pole `password` żeby UI maskował; przechowywane w configu drivera bez szyfrowania
 * (Faza 7.7 — encrypted at rest — odroczone do enterprise contractu).
 */
export const FIELD_TEDEE_PAK: DriverField = {
  key: 'personalAccessKey',
  label: 'Personal Access Key (Tedee)',
  type: 'password',
  group: 'cloud',
  required: true,
  help: 'Token z konta tedee.com → Profil → Personal Access Key. Edge używa go do API api.tedee.com.',
}

/**
 * Tedee Lock ID — numeryczny identyfikator konkretnego zamka w koncie.
 * Po wpisaniu PAK + scan-ie wizard listuje wszystkie zamki konta i user wybiera —
 * ale dopóki nie ma wizard-flow, integrator musi go znać z aplikacji Tedee.
 */
export const FIELD_TEDEE_LOCK_ID: DriverField = {
  key: 'lockId',
  label: 'ID zamka Tedee',
  type: 'number',
  group: 'cloud',
  required: true,
  min: 1,
  help: 'Liczba widoczna w aplikacji Tedee przy konkretnym zamku (Settings → About).',
}

/**
 * KNX group address — np. „1/0/1" (3-poziomowy, domyślny w ETS) albo „1/1"
 * (2-poziomowy, rzadziej). Edge konwertuje to na 16-bit raw GA przy wysyłce
 * KNXnet/IP.
 */
export const FIELD_GROUP_ADDR: DriverField = {
  key: 'groupAddress',
  label: 'Group Address',
  type: 'group-address',
  group: 'knx',
  required: true,
  placeholder: 'np. 1/0/1',
  help: 'Adres grupowy KNX (3-poziomowy "main/middle/sub" lub 2-poziomowy "main/sub").',
  validate: (v) => {
    if (typeof v !== 'string' || v.trim() === '') return 'Wymagane'
    // 3-poziomowy: main 0-31, middle 0-7, sub 0-255
    // 2-poziomowy: main 0-31, sub 0-2047
    if (/^([0-9]{1,2})\/([0-9])\/([0-9]{1,3})$/.test(v)) {
      const [m, mid, s] = v.split('/').map(Number)
      if (m > 31 || mid > 7 || s > 255) return 'Zakres 3-poziomowy: 0-31/0-7/0-255'
      return null
    }
    if (/^([0-9]{1,2})\/([0-9]{1,4})$/.test(v)) {
      const [m, s] = v.split('/').map(Number)
      if (m > 31 || s > 2047) return 'Zakres 2-poziomowy: 0-31/0-2047'
      return null
    }
    return 'Format: "1/0/1" lub "1/1"'
  },
}

/**
 * KNX physical address bridge'a — np. „1.1.1". Jednoznacznie identyfikuje
 * urządzenie na buście. Mniej krytyczne niż IP+port (ping i tak idzie po IP),
 * ale przydatne do diagnostyki.
 */
export const FIELD_KNX_PHYS_ADDR: DriverField = {
  key: 'physicalAddress',
  label: 'Adres fizyczny bridge\'a',
  type: 'text',
  group: 'knx',
  placeholder: 'np. 1.1.1',
  help: 'Adres fizyczny KNX-IP routera na buście (3-poziomowy: area.line.device).',
  validate: (v) => {
    if (v == null || v === '') return null
    if (typeof v !== 'string') return 'Nieprawidłowy format'
    if (!/^([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{1,3})$/.test(v)) {
      return 'Format: "1.1.1" (area.line.device)'
    }
    return null
  },
}

/**
 * KNX-IP Bridge ID — pole referencji w `KNX_OBJECT` configu wskazujące na
 * konkretny KNX_BRIDGE. UI renderuje jako select z listą bridge'y budynku.
 */
export const FIELD_KNX_BRIDGE_REF: DriverField = {
  key: 'bridgeDeviceId',
  label: 'KNX-IP Bridge',
  type: 'select',
  group: 'knx',
  required: true,
  help: 'Wybierz KNX-IP router/bridge, do którego ten obiekt należy.',
  // options są wstrzykiwane dynamicznie przez UI (lista KNX_BRIDGE w budynku)
  options: [],
}

/**
 * KNX Datapoint Type (DPT) — definiuje co siedzi pod GA: bool (DPT 1.001),
 * skalar 0-100% (5.001), temperatura (9.001), dim step (3.007), …
 * Lista to wycinek najczęściej spotykanych — pełna jest >250 pozycji.
 */
export const FIELD_KNX_DPT: DriverField = {
  key: 'dpt',
  label: 'Datapoint Type (DPT)',
  type: 'select',
  group: 'knx',
  required: true,
  default: '1.001',
  help: 'Typ danych pod tym GA — musi się zgadzać z konfiguracją w ETS.',
  options: [
    { value: '1.001', label: 'DPT 1.001 — Switch (on/off)' },
    { value: '1.002', label: 'DPT 1.002 — Bool' },
    { value: '1.008', label: 'DPT 1.008 — Up/Down (rolety)' },
    { value: '1.009', label: 'DPT 1.009 — Open/Close' },
    { value: '3.007', label: 'DPT 3.007 — Dimming control (step)' },
    { value: '5.001', label: 'DPT 5.001 — Scaling 0-100%' },
    { value: '5.010', label: 'DPT 5.010 — Counter 0-255' },
    { value: '9.001', label: 'DPT 9.001 — Temperature (°C)' },
    { value: '14.056', label: 'DPT 14.056 — Power (W)' },
  ],
}

/**
 * Logiczna funkcja KNX_OBJECT — jak prezentować go w UI mieszkańca/admina.
 * Mapuje na `Capability` przy dispatchu komendy.
 */
export const FIELD_KNX_FUNCTION: DriverField = {
  key: 'function',
  label: 'Funkcja w panelu',
  type: 'select',
  group: 'knx',
  required: true,
  default: 'switch',
  help: 'Jak ten obiekt będzie się prezentował w aplikacji (decyduje o ikonie i komendach).',
  options: [
    { value: 'switch',     label: 'Włącznik (on/off)' },
    { value: 'dimmer',     label: 'Ściemniacz (0-100%)' },
    { value: 'blinds',     label: 'Rolety (góra/dół/%)' },
    { value: 'thermostat', label: 'Termostat (temperatura)' },
    { value: 'scene',      label: 'Scena (jeden przycisk)' },
    { value: 'sensor',     label: 'Czujnik (tylko odczyt)' },
  ],
}

/**
 * Rozpoznawanie tekstu i tablic z obrazu tej kamery — LOKALNIE na Edge.
 *
 * Dostępne dla dowolnego urządzenia z kamerą, także domofonu: kaseta widzi
 * podjeżdżające auto tak samo jak kamera, a napis na burcie kuriera jest z
 * niej równie czytelny. Działa niezależnie od serwera AI — odczyt tekstu to
 * systemowy silnik Vision na Edge, nie model wizyjny.
 *
 * Domyślnie WYŁĄCZONE: analiza każdej zmiany w kadrze kosztuje, więc włącza
 * się ją świadomie tam, gdzie jest po co (wjazd, brama), a nie wszędzie.
 */
export const FIELD_OCR_ENABLED: DriverField = {
  key: 'ocrEnabled',
  label: 'Rozpoznawaj tablice i napisy',
  type: 'boolean',
  group: 'ai',
  default: false,
  help:
    'Edge analizuje obraz przy każdej istotnej zmianie w kadrze i odczytuje ' +
    'tablice rejestracyjne oraz napisy (kurierzy, firmy). Działa lokalnie — ' +
    'nie wymaga serwera AI. Odczyty trafiają do historii jak z kamery LPR, ' +
    'ale NIE otwierają żadnego wejścia.',
}
