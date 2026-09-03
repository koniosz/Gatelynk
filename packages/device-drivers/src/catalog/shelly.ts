/**
 * Drivery Shelly — Gen2/Gen3 RPC API.
 *
 * Shelly Pro 1 to Ethernet-only relay (1× NO/NC), bez WiFi-default, bez kamery,
 * bez baterii. Z punktu widzenia GateLynka idealny do:
 *   • sterowania bramą/furtką (impuls 1 sek przez przekaźnik 12V),
 *   • prostych obwodów (oświetlenie wjazdu, klimatyzacja konsjerżówki),
 *   • backup-u dla intercomu (jeśli Akuvox padnie, Shelly trzyma drugi tor).
 *
 * Komunikacja: HTTP RPC pod `/rpc/<Method>`, format JSON.
 * Auth: opcjonalne HTTP Digest (zalecane od fw 1.0.0); driver wystawia go jako
 * `digest` — jeśli userka nie ustawi hasła w urządzeniu, Edge dostanie 200 OK
 * bez wyzwania, więc digest jest „opportunistic" (nie blokuje braku auth).
 *
 * Pulse (otwarcie bramy):
 *   POST /rpc/Switch.Set { id: 0, on: true, toggle_after: 1 }
 * `toggle_after` to natywna funkcja Shelly — sam wyłączy po 1 sek, więc nie
 * trzeba w Edge robić setTimeout-a (mniej ryzyka gdy WS pada w połowie).
 *
 * mDNS: Shelly Pro publikuje `_shelly._tcp.local.` ORAZ `_http._tcp.local.`.
 * Hostname: `shellypro1-<MAC bez :>.local` (np. `shellypro1-349454ABCDEF`).
 */
import type { DeviceDriver } from '../types'
import {
  FIELD_NAME, FIELD_IP, FIELD_HTTP_PORT, FIELD_LOGIN, FIELD_PASSWORD,
  FIELD_MAC, FIELD_RELAYS,
} from './_common'

export const shellyPro1: DeviceDriver = {
  id: 'shelly-pro1',
  type: 'SWITCH',
  manufacturer: 'Shelly',
  models: ['Pro 1', 'Pro 1PM', 'Pro 2'],
  label: 'Shelly Pro (Ethernet relay)',
  icon: '🔌',
  notes: 'Shelly Pro 1/1PM/2 z Ethernetem. Sterowanie bramą przez impuls 1 sek (Switch.Set z toggle_after). Hasło ustaw w Web UI urządzenia (zalecane); driver używa Digest, ale działa też bez auth jeśli nie skonfigurowane.',
  capabilities: ['toggle', 'openDoor', 'restart', 'discoverable'],
  fields: [
    FIELD_NAME,
    FIELD_IP,
    FIELD_HTTP_PORT,
    FIELD_LOGIN('admin'),
    FIELD_PASSWORD,
    FIELD_MAC,
    {
      key: 'switchId',
      label: 'Numer przekaźnika',
      type: 'number',
      group: 'relays',
      default: 0,
      min: 0,
      max: 1,
      help: 'Shelly Pro 1 ma jeden przekaźnik (id=0). Pro 2 ma dwa (id=0, id=1).',
    },
    {
      key: 'pulseSeconds',
      label: 'Długość impulsu bramy (sek)',
      type: 'number',
      group: 'relays',
      default: 1,
      min: 1,
      max: 30,
      help: 'Czas po którym Shelly sam wyłączy przekaźnik przy „otwórz bramę". Standardowo 1 sek dla 12V impulsu.',
    },
    FIELD_RELAYS,
  ],
  defaults: {
    httpPort: 80,
    switchId: 0,
    pulseSeconds: 1,
    login: 'admin',
  },
  endpoints: {
    ping: ['http://{ip}:{httpPort}/rpc/Shelly.GetStatus'],
    pingProtocol: 'http',
    // Pełny on (bez auto-off) — przydatne dla lamp / pomp.
    toggle: {
      method: 'POST',
      url: 'http://{ip}:{httpPort}/rpc/Switch.Set',
      auth: 'digest',
      contentType: 'application/json',
      body: '{"id":{switchId},"on":{state}}',
    },
    // Impuls dla bramy — natywne `toggle_after` w Shelly fw.
    // {state} jest podstawiane przez Edge na `true` (state stuck = on, ale toggle_after wyłączy).
    openDoor: {
      method: 'POST',
      url: 'http://{ip}:{httpPort}/rpc/Switch.Set',
      auth: 'digest',
      contentType: 'application/json',
      body: '{"id":{switchId},"on":true,"toggle_after":{pulseSeconds}}',
    },
    restart: {
      method: 'POST',
      url: 'http://{ip}:{httpPort}/rpc/Shelly.Reboot',
      auth: 'digest',
      contentType: 'application/json',
      body: '{}',
    },
    discovery: {
      mdnsService: ['_shelly._tcp', '_http._tcp'],
      mdnsHostnamePattern: /^shellypro\d+-/i,
      macPrefixes: [
        // Allterco Robotics (Shelly Pro line) — Ethernet OUIs
        '34:94:54',
        'DC:53:60',
        '9C:90:0E',
        '2C:6A:6F',
        // Espressif-based starsze gen-2 (Plus): rzadziej w Pro
        '8C:AA:B5',
        '84:CC:A8',
      ],
      httpProbe: {
        path: '/shelly',
        port: 80,
        // Gen2 response zawiera `"gen":2` + `"app":"Pro1"` w JSON-ie
        expectHeader: { name: 'Server', pattern: /shelly|esp32/i },
      },
    },
  },
  certification: {
    status: 'untested',
    testedFirmware: ['1.0.x', '1.4.x'],
    recommendedFor: 'residential',
    knownIssues: [
      'Driver napisany na podstawie Shelly Gen2 RPC docs. Brak weryfikacji u realnego klienta.',
      'Pulse 1s przez `toggle_after` — wymaga fw ≥ 0.10 dla natywnego wsparcia.',
    ],
  },
}
