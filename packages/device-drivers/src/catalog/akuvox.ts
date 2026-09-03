/**
 * Driver Akuvox — własne API SmartPlus FCGI + natywny MJPEG na porcie 8080.
 *
 * Edge ma dla Akuvoxa specjalną ścieżkę szybkiego snapshotu (HTTP /picture.jpg
 * zamiast RTSP+ffmpeg) — to driver wskazuje przez `capabilities` że umie
 * szybki HTTP snapshot, a serwis Edge wybiera odpowiednią ścieżkę.
 */
import type { DeviceDriver } from '../types'
import {
  FIELD_IP, FIELD_LOGIN, FIELD_PASSWORD,
  FIELD_RTSP_PATH_OVERRIDE, FIELD_RELAYS, FIELD_NAME,
  FIELD_OCR_ENABLED,
} from './_common'

export const akuvoxIntercom: DeviceDriver = {
  id: 'akuvox-smartplus',
  type: 'INTERCOM',
  manufacturer: 'Akuvox',
  models: [
    'R29C', 'R29', 'R20A', 'R20B', 'R20K',
    'E12W', 'E16C', 'E16S', 'E18C', 'E18',
    'S539', 'S562', 'S567',
  ],
  label: 'Akuvox SmartPlus',
  icon: '🚪',
  notes: 'Akuvox z ChinaTalk/SmartPlus API (FCGI). Driver zna firmware-quirki (HTTPS „Not Safe" na 18.30.x) i fallbackuje na HTTP bez auth gdy potrzeba.',
  capabilities: ['openDoor', 'snapshot', 'mjpeg', 'restart', 'dnd'],
  // Skrócony zestaw pól — instalator widzi TYLKO to co realnie różni instalacje:
  // nazwę, IP, login, hasło, mapowanie przekaźników (+ opcjonalny rtspPath override
  // dla nietypowych konfigów). Reszta (httpPort=443, rtspPort=554, rtspPath, mjpegPort,
  // pulseSeconds, quirk HTTPS „Not Safe") jest zaszyta w `constants` poniżej.
  fields: [
    FIELD_NAME,
    FIELD_IP,
    FIELD_LOGIN('admin'),
    FIELD_PASSWORD,
    FIELD_RTSP_PATH_OVERRIDE,
    FIELD_RELAYS,
    FIELD_OCR_ENABLED,
  ],
  defaults: {
    login: 'admin',
  },
  constants: {
    httpPort: 443,
    rtspPort: 554,
    rtspPath: 'live/ch00_0',
    mjpegPort: 8080,
    relayPulseSeconds: 1,
    holdOpenMaxSeconds: 600,
    httpTimeoutMs: 5000,
    snapshotTimeoutMs: 5000,
    // fw 18.30.x quirk: HTTPS basic auth → „Not Safe -4". Endpoints używają HTTPS
    // bez auth, ale tę flagę widzi też test-matrix / driver-engine dla diagnostyki.
    requiresUnauthenticatedFallback: true,
  },
  certification: {
    status: 'certified',
    testedFirmware: ['17.0.x', '18.30.x', '29.30.10.128 (R29)'],
    testedAt: '2026-07-08',
    testedBy: 'GateLynk QA',
    knownIssues: [
      'fw 18.30.x: HTTPS basic auth zwraca "Not Safe -4" — driver używa HTTPS bez auth.',
      'Snapshot HTTPS może zwrócić EPROTO przy self-signed cert → fallback na HTTP :80.',
      'R29 fw 29.30.10.128: High-Security OpenDoor (/fcgi/OpenDoor) zwraca HTTP 503 ' +
        '(lighttpd) DOPÓKI na urządzeniu nie włączysz "Open Relay via HTTP" ' +
        '(Intercom → Relay, ustaw HTTP username/password = hasło API). Legacy ' +
        '/fcgi/do?action=OpenDoor zwraca "please use new interface". E18C (.100) ' +
        'ma tę opcję włączoną i HS OpenDoor działa (retcode 0).',
      'R29 fw 29.30.10.128: fast-snapshot :8080/picture.jpg wymaga hasła API ' +
        '(digest), zwraca 401 gdy niewłączone/złe hasło → Edge fallbackuje na ' +
        'RTSP live/ch00_0 (~68 KB, ~900 ms zamiast ~50 ms). GetSnapshot ' +
        '(/fcgi/do?action=GetSnapshot) zwraca formularz HTML (88 B), NIE JPEG.',
    ],
    recommendedFor: 'residential',
  },
  endpoints: {
    ping: [
      'https://{ip}:{httpPort}/fcgi/do?action=GetSysInfo',
      'http://{ip}/fcgi/do?action=GetSysInfo',
    ],
    snapshot: [
      'https://{ip}:{httpPort}/fcgi/do?action=GetSnapshot',
      'http://{ip}/fcgi/do?action=GetSnapshot',
    ],
    rtspPath: ['live/ch00_0', 'live/ch00_1'],
    // Uwaga firmware-osobliwość Akuvox 18.30.x:
    // ─ HTTPS na :443 z Basic Auth → Akuvox zwraca {"retcode":-4,"message":"Not Safe"}
    //   (firmware-level "anti-tamper" gate dla zewnętrznego ISAPI)
    // ─ HTTPS na :443 bez auth → fizycznie otwiera drzwi (intercom whitelistuje LAN)
    // Stąd `auth: 'none'` i URL bez `:{httpPort}` (lighttpd HTTPS na 443 default).
    restart: {
      method: 'GET',
      url: 'https://{ip}/fcgi/do?action=Restart',
      auth: 'none',
    },
    openDoor: {
      method: 'GET',
      url: 'https://{ip}/fcgi/do?action=OpenDoor&door={relay}',
      auth: 'none',
    },
    // Faza F-4.1 (2026-05-14): DND on/off przez Akuvox FCGI.
    // Firmware quirk 18.30.x — używamy `op` (lowercase) jako parametr; starsze
    // mogą wymagać `enable=1`/`enable=0`. Driver-engine renderuje `{state}` na
    // 'on'|'off' (patrz IntercomService.setDnd).
    setDnd: {
      method: 'GET',
      url: 'https://{ip}/fcgi/do?action=DoNotDisturb&op={state}',
      auth: 'none',
    },
    // Faza F-1 (2026-05-14): discovery hints — Akuvox raczej nie publikuje
    // mDNS jednolicie (LAN-only, brak Bonjour wsparcia w fw), więc polegamy
    // głównie na OUI lookup z ARP. Hostname-pattern jako bonus dla niestandardowych
    // konfigów które publikują `_http._tcp`.
    discovery: {
      macPrefixes: [
        'B0:1F:81',  // Akuvox główny OUI (intercom R29/E16/E12/S5x)
        '0C:11:05',  // Akuvox/Allmedia (starsze modele)
      ],
      mdnsHostnamePattern: /^akuvox-|^Akuvox-/i,
      httpProbe: {
        path: '/fcgi/do?action=GetSysInfo',
        port: 443,
        // Akuvox zwraca w JSON `{"vendor":"Akuvox"}` — header sprawdza, body
        // by wymagało parsingu (TODO Faza 6 — rozbudować httpProbe o body check).
      },
    },
  },
}
