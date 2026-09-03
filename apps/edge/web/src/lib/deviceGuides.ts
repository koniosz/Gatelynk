/**
 * deviceGuides.ts — przewodniki konfiguracji „krok po kroku" per model urządzenia.
 *
 * Treść jest STRUKTURALNA (dane, nie JSX) żeby dało się łatwo rozszerzać o kolejne
 * modele. Źródło faktów: `docs/intercom-akuvox-call.md` — szczególnie sekcja 12
 * „R29 vs E18C" (napisana po live-teście na sprzęcie 2026-07-08), sekcje SIP-proxy,
 * Remote Phonebook (D6), OpenDoor High-Security, snapshoty. NIC nie jest wymyślone
 * z pamięci — pola oznaczone „(do uzupełnienia)" nie mają jeszcze potwierdzenia w docs.
 *
 * Rozwiązanie modelu:
 *   Akuvox E18C/E18  → e18cGuide   (ekran 7", SIP account mode → sip-proxy :5062)
 *   Akuvox R29/R29C  → r29Guide    (kaseta, SIP direct-IP :5060 + Remote Phonebook)
 *   Akuvox (inny)    → genericAkuvoxGuide
 *   CAMERA/LPR_CAMERA→ cameraGuide (Hikvision — „wkrótce")
 *   inne             → genericGuide
 *
 * Placeholdery w wartościach kroków (`<edge-ip>`, `<buildingId>`, `<token>`, `<ip>`)
 * są podstawiane przy renderze w `DeviceGuideModal` z tego co Edge wie; nierozwiązane
 * zostają widoczne + legenda skąd je wziąć.
 */
import type { DeviceConfig, DeviceEntry, DeviceType } from './types'

export type StepStatus = 'ok' | 'warn' | 'unknown'

export interface GuideStep {
  /** Krótki tytuł kroku. */
  title: string
  /** Dokładna ścieżka w panelu web Akuvox (jak w docs). */
  path?: string
  /** Wartość do wpisania (może zawierać placeholdery <edge-ip>/<buildingId>/<token>/<ip>). */
  value?: string
  /** „Dlaczego" — jedno zdanie. */
  why?: string
  /** Krok krytyczny (podświetlony). */
  critical?: boolean
  /**
   * Best-effort status wyliczony z tego co Edge wie (config z GET /devices).
   * Zwraca undefined gdy nie da się nic wywnioskować (wtedy brak badge).
   */
  status?: (device: DeviceEntry) => StepStatus | undefined
}

export interface DeviceGuide {
  key: string
  /** Nagłówek panelu (np. „Akuvox E18C — ekran dotykowy 7""). */
  title: string
  /** 1–2 zdania kontekstu. */
  summary?: string
  /** Odwołanie do docs (pokazane w stopce panelu). */
  docRef?: string
  /** Czy kroki używają placeholderów sieciowych (włącza legendę). */
  usesPlaceholders?: boolean
  steps: GuideStep[]
  /** Uwagi końcowe / ostrzeżenia. */
  notes?: string[]
}

// ── Helpery statusów (tylko z config, bez nowych endpointów) ─────────────────

const hasApiPassword = (d: DeviceEntry): StepStatus =>
  d.config.rtspPassword ? 'ok' : 'warn'

const hasRelays = (d: DeviceEntry): StepStatus =>
  (d.config.relays?.length ?? 0) > 0 ? 'ok' : 'warn'

// ── Akuvox E18C (ekran dotykowy 7", np. .100 „Wyjazd") ───────────────────────
// Źródło: docs sekcja 12.1 (matryca), AkuvoxStationCard (E18C showConfig), sekcja 8.1.

const e18cGuide: DeviceGuide = {
  key: 'akuvox-e18c',
  title: 'Akuvox E18C / E18 — panel z ekranem 7"',
  summary:
    'E18C działa w trybie SIP account — rejestruje się do lokalnego sip-proxy na Edge (port 5062, NIE 5060). ' +
    'OpenDoor High-Security i szybki snapshot HTTP działają (potwierdzone na .100). E18 NIE ma Remote Phonebook — kontakty przez import UserData.tgz.',
  docRef: 'docs/intercom-akuvox-call.md — sekcja 12 (E18C) + sekcja 8.1',
  usesPlaceholders: true,
  steps: [
    {
      title: 'Konto SIP — rejestracja do mostka',
      path: 'Account → Basic → SIP Account',
      value: 'Account Enabled ✓ · Register Name / Username = door · Password = door',
      why: 'Domofon rejestruje się do sip-proxy Edge jako konto „door"; status konta musi pokazać „Registered".',
    },
    {
      title: 'Serwer SIP — port 5062 (NIE 5060!)',
      path: 'Account → Basic → Preferred SIP Server',
      value: 'Server Address = <edge-ip> · Sip Server Port = 5062',
      why: 'E18C w account-mode idzie przez sip-proxy GateLynk na :5062 — port 5060 to bezpośredni Janus (dla R29).',
      critical: true,
    },
    {
      title: 'Direct IP — dla fizycznego przycisku',
      path: 'Intercom → Basic → Direct IP',
      value: 'Enabled ✓ · port 5060 · dzwoni direct-IP do <edge-ip> („dzwoń do wszystkich")',
      why: 'Fizyczny przycisk na panelu wywołuje mostek bez wybierania konkretnego lokalu.',
    },
    {
      title: 'Import listy mieszkańców (UserData.tgz)',
      path: 'Directory → User → Import',
      value: 'Wgraj UserData.tgz (eksport z panelu BA/Integratora) · Phone = id lokalu',
      why: 'E18 nie ma Remote Phonebook — lista lokali wchodzi importem; Phone = id lokalu routuje wywołanie do mieszkańców tego lokalu.',
    },
    {
      title: 'Wyświetlanie listy gościowi',
      path: 'Intercom → Basic → Tenants List',
      value: '„Show Tenants of Local Group" ✓ · „Click Tenants to Dial Out" ✓',
      why: 'Gość widzi nazwiska i dotyka kontaktu zamiast wpisywać numer.',
    },
    {
      title: 'OpenDoor High-Security + hasło API',
      path: 'Intercom → Relay (High Security Mode) / Security → API',
      value:
        'Endpoint /fcgi/OpenDoor?action=OpenDoor&DoorNum=N (N = relay+1), digest, ' +
        'hasło API = admin (≠ hasło web). Podaj to hasło Edge jako „hasło API" (pole rtspPassword).',
      why: 'Edge otwiera bramę tą ścieżką (na E18C zwraca retcode 0). Hasło API jest osobne od hasła logowania do panelu.',
      status: hasApiPassword,
    },
    {
      title: 'Szybki snapshot HTTP',
      path: 'Security → API (to samo hasło API)',
      value: ':8080/picture.jpg (digest, hasło API) — ~195 KB, ~50 ms',
      why: 'Szybki podgląd bez RTSP+ffmpeg; działa gdy hasło API jest ustawione i włączone.',
      status: hasApiPassword,
    },
    {
      title: 'Mapowanie przekaźników',
      path: 'Panel Edge → karta urządzenia → Przekaźniki',
      value: 'Każdy przekaźnik = jedne drzwi/brama; numer = port w urządzeniu (1, 2…).',
      why: 'Edge musi wiedzieć który relay to które drzwi żeby „Otwórz" trafiał w cel.',
      status: hasRelays,
    },
    {
      title: 'PIN / Action URL (jeśli używane)',
      path: 'Intercom → Action URL (klawiatura)',
      value: 'http://<edge-ip>:4000/akuvox/event',
      why: 'Walidacja PIN gości/mieszkańców offline-first po stronie Edge (działa bez internetu).',
    },
  ],
  notes: [
    'E18C NIE ma Remote Phonebook — nie szukaj tej opcji w panelu.',
    'fw 18.30.x: HTTPS basic auth zwraca „Not Safe -4" — driver Edge używa HTTPS bez auth (to normalne).',
  ],
}

// ── Akuvox R29 / R29C (kaseta, np. .109 „Kaseta R29") ────────────────────────
// Źródło: docs sekcja 12.2 (konfiguracja krok po kroku) + 12.1 (matryca) + 12.3 (SIP direct-IP).

const r29Guide: DeviceGuide = {
  key: 'akuvox-r29',
  title: 'Akuvox R29 / R29C — kaseta zewnętrzna',
  summary:
    'R29 dzwoni SIP direct-IP prosto do Janusa (:5060, niesie user-part → dzwonienie punktowe bez sip-proxy) i MA Remote Phonebook. ' +
    'UWAGA: z fabryki OpenDoor przez HTTP jest WYŁĄCZONY (503) dopóki nie włączysz „Open Relay via HTTP" na urządzeniu.',
  docRef: 'docs/intercom-akuvox-call.md — sekcja 12.2 / 12.1 / 12.3 (live-test fw 29.30.10.128)',
  usesPlaceholders: true,
  steps: [
    {
      title: 'Logowanie do panelu',
      path: 'https://<ip> (przeglądarka)',
      value: 'admin / hasło web',
      why: 'Wszystkie poniższe kroki wykonuje się w panelu web kasety.',
    },
    {
      title: 'Sieć — statyczne IP',
      path: 'Network → Basic',
      value: 'Statyczne IP w podsieci LAN Edge (192.168.1.x), brama, DNS',
      why: 'Edge i Janus muszą znać stały adres kasety (mapowanie stacji po źródłowym IP INVITE).',
    },
    {
      title: 'SIP (Account) — direct-IP',
      path: 'Account → Basic',
      value: 'Serwer = LAN IP Edge/Janusa (<edge-ip>) · port 5060 · transport UDP',
      why: 'R29 dzwoni direct-IP, a user-part (numer z książki) niesie routing do konkretnego lokalu — bez sip-proxy :5062.',
    },
    {
      title: '„Open Relay via HTTP" — KROK KRYTYCZNY',
      path: 'Intercom → Relay',
      value:
        'Włącz HTTP command dla OpenDoor + ustaw HTTP username/password. To hasło podaj Edge jako „hasło API" (pole rtspPassword).',
      why: 'Bez tego OpenDoor przez HTTP zwraca 503 — „Otwórz" z apki/portiera/PIN/LPR nie zadziała, mimo że Edge loguje próbę.',
      critical: true,
      status: hasApiPassword,
    },
    {
      title: 'Remote Phonebook',
      path: 'Phone → Remote Phonebook → URL',
      value:
        'https://gatelynk-api.fly.dev/api/intercom/phonebook?b=<buildingId>&t=<token>&host=<edge-ip>',
      why: 'Endpoint żyje w CHMURZE (Edge go NIE serwuje). Zwraca XML <Directory> z kontaktami lokali (Office="unitId@host", host=IP Edge do dzwonienia); dotknięcie kontaktu → INVITE do Janusa z user-part = unitId (dzwonienie punktowe).',
    },
    {
      title: 'Snapshot — hasło API dla szybkiego :8080',
      path: 'Security → API',
      value:
        ':8080/picture.jpg wymaga hasła API (fabrycznie wyłączone → 401). ' +
        'Ustaw hasło API i podaj Edge jako rtspPassword. Bez tego Edge fallbackuje na RTSP (~68 KB, ~900 ms).',
      why: 'Szybki HTTP snapshot (~50 ms jak E18C) zamiast wolniejszego RTSP fallback.',
      status: hasApiPassword,
    },
    {
      title: 'RTSP',
      path: 'domyślne (Edge już zna)',
      value: 'live/ch00_0 na :554',
      why: 'Strumień wideo + snapshot fallback; oba streamy (ch00_0/ch01_0) odpowiadają 200.',
    },
    {
      title: 'Mapowanie przekaźników',
      path: 'Panel Edge → karta urządzenia → Przekaźniki',
      value: 'Każdy przekaźnik = jedne drzwi/brama; numer = port w urządzeniu.',
      why: 'Edge musi wiedzieć który relay to które drzwi żeby „Otwórz" trafiał w cel.',
      status: hasRelays,
    },
  ],
  notes: [
    'OpenDoor legacy (/fcgi/do?action=OpenDoor) zwraca „please use new interface" — używamy High-Security (DoorNum=relay+1).',
    'Weryfikacja na żywo (2026-07-08): SIP i Remote Phonebook wymagają device-side konfiguracji panelu R29 (kroki SIP + Relay + Phonebook) — bez nich w logach Edge nie ma INVITE/REGISTER z kasety.',
    'Token Remote Phonebook = HMAC z JWT_SECRET (żyje na Cloud, NIE na Edge) — pobierz gotowy URL z panelu Integratora, nie licz tokenu na Edge.',
  ],
}

// ── Generic Akuvox (nieznany model) ──────────────────────────────────────────

const genericAkuvoxGuide: DeviceGuide = {
  key: 'akuvox-generic',
  title: 'Akuvox (model nierozpoznany)',
  summary:
    'Wspólny rdzeń dla domofonów Akuvox. Zweryfikuj dokładne ścieżki menu w panelu tego modelu — poniżej wartości potwierdzone dla R29/E18C.',
  docRef: 'docs/intercom-akuvox-call.md — sekcja 12',
  usesPlaceholders: true,
  steps: [
    {
      title: 'SIP — Direct IP lub Account',
      path: 'Account → Basic (zweryfikuj w panelu)',
      value: 'Serwer = <edge-ip> · port 5060 (direct-IP) lub 5062 (account/sip-proxy)',
      why: 'Domofon musi dzwonić do mostka na Edge; tryb zależy od modelu (R29 = direct-IP :5060, E18C = account :5062).',
    },
    {
      title: 'OpenDoor + hasło API',
      path: 'Intercom → Relay (zweryfikuj w panelu)',
      value:
        'Włącz OpenDoor przez HTTP + ustaw hasło API (≠ hasło web). Podaj je Edge jako „hasło API" (rtspPassword).',
      why: 'Niektóre modele (R29) mają OpenDoor-over-HTTP wyłączony fabrycznie (503) — trzeba go włączyć.',
      critical: true,
      status: hasApiPassword,
    },
    {
      title: 'Snapshot',
      path: 'Security → API (zweryfikuj w panelu)',
      value: ':8080/picture.jpg (hasło API) lub RTSP live/ch00_0 :554 jako fallback',
      why: 'Szybki podgląd HTTP wymaga hasła API; bez niego Edge użyje RTSP.',
      status: hasApiPassword,
    },
    {
      title: 'Mapowanie przekaźników',
      path: 'Panel Edge → karta urządzenia → Przekaźniki',
      value: 'Każdy przekaźnik = jedne drzwi/brama.',
      why: 'Edge musi wiedzieć który relay to które drzwi.',
      status: hasRelays,
    },
  ],
  notes: [
    'Hasło API ≠ hasło logowania do panelu web — to częsta pułapka.',
    'Sprawdź w panelu czy model ma Remote Phonebook (R29 tak, E18C nie).',
  ],
}

// ── Kamera / LPR (Hikvision) — „wkrótce" ─────────────────────────────────────
// Brak zweryfikowanego docs w repo (istnieje tylko intercom-akuvox-call.md).
// Zgodnie ze zleceniem: nie wymyślamy ścieżek ISAPI/ANPR — oznaczamy „(do uzupełnienia)".

const cameraGuide: DeviceGuide = {
  key: 'camera-hikvision',
  title: 'Kamera / LPR (Hikvision)',
  summary:
    'Przewodnik konfiguracji kamery jest w przygotowaniu. Poniższe kroki to szkielet — dokładne ścieżki ISAPI / ANPR httpHosts wymagają weryfikacji w panelu.',
  docRef: '(do uzupełnienia — brak zweryfikowanego docs kamer w repo)',
  usesPlaceholders: false,
  steps: [
    {
      title: 'ANPR push do Edge (do uzupełnienia)',
      path: '(zweryfikuj w panelu Hikvision)',
      value: 'httpHosts push / ISAPI, hasło digest — dokładne wartości do potwierdzenia',
      why: 'Kamera LPR wypycha odczyty tablic do Edge; szczegóły zależą od modelu/firmware.',
    },
  ],
  notes: [
    'Sekcja kamer zostanie uzupełniona po weryfikacji na sprzęcie (ISAPI, ANPR httpHosts, hasło digest).',
    'Pułapka #7 (CLAUDE.md): <vehicleLogoRecog> to marka fabryczna, NIE operator kuriera — identyfikacja kuriera tylko przez OCR napisu na boku vana.',
  ],
}

// ── Generic (nieznany producent) ─────────────────────────────────────────────

const genericGuide: DeviceGuide = {
  key: 'generic',
  title: 'Urządzenie — brak dedykowanego przewodnika',
  summary:
    'Dla tego producenta/modelu nie ma jeszcze przewodnika konfiguracji krok po kroku. Poniżej pokazujemy bieżące ustawienia, które Edge zna o tym urządzeniu.',
  usesPlaceholders: false,
  steps: [],
  notes: ['Przewodnik dla tego modelu zostanie dodany (do uzupełnienia).'],
}

// ── Resolver ─────────────────────────────────────────────────────────────────

/** Zwraca przewodnik dopasowany do producenta+modelu, z fallbackiem generic. */
export function resolveGuide(config: DeviceConfig, type: DeviceType): DeviceGuide {
  if (type === 'CAMERA' || type === 'LPR_CAMERA') return cameraGuide

  const manufacturer = (config.manufacturer ?? '').toLowerCase()
  const model = (config.model ?? '').toUpperCase()

  if (manufacturer.includes('akuvox') || type === 'INTERCOM') {
    if (/E18/.test(model)) return e18cGuide
    if (/R29/.test(model)) return r29Guide
    if (manufacturer.includes('akuvox')) return genericAkuvoxGuide
  }

  return genericGuide
}

/** Podstawienie placeholderów sieciowych w wartościach kroków. */
export function fillPlaceholders(
  raw: string | undefined,
  vars: { edgeIp?: string | null; buildingId?: number | null; ip?: string | null },
): string {
  if (!raw) return ''
  let out = raw
  if (vars.edgeIp) out = out.replaceAll('<edge-ip>', vars.edgeIp)
  if (vars.buildingId != null) out = out.replaceAll('<buildingId>', String(vars.buildingId))
  if (vars.ip) out = out.replaceAll('<ip>', vars.ip)
  return out
}
