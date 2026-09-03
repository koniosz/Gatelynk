/**
 * Drivery Hikvision — ISAPI (HTTP API).
 *
 * Wszystkie modele Hikvision z ISAPI mają identyczny zestaw endpointów:
 *   • Snapshot:  GET  /ISAPI/Streaming/channels/{ch}/picture
 *   • Restart:   PUT  /ISAPI/System/reboot
 *   • Open door: PUT  /ISAPI/AccessControl/RemoteControl/door/{relay}
 *   • Ping:      GET  /ISAPI/System/deviceInfo
 *
 * Stąd wystarczy jeden driver na całą rodzinę intercom-ów + osobny driver
 * dla LPR (rozszerzony o pola `whitelistMode`, `cameraListSyncMethod`).
 */
import type { DeviceDriver } from '../types'
import {
  FIELD_IP, FIELD_LOGIN, FIELD_PASSWORD,
  FIELD_CHANNEL,
  FIELD_RTSP_PATH_OVERRIDE, FIELD_RELAYS, FIELD_NAME,
  FIELD_OCR_ENABLED,
} from './_common'

export const hikvisionIntercom: DeviceDriver = {
  id: 'hikvision-intercom',
  type: 'INTERCOM',
  manufacturer: 'Hikvision',
  models: [
    'DS-K1T671TM-3XF', 'DS-K1T673', 'DS-K1T673TM-3XF',
    'DS-KV6113', 'DS-KV8413', 'DS-KV8113',
    'DS-KD8003', 'DS-KD8403',
  ],
  label: 'Hikvision domofon (ISAPI)',
  icon: '🚪',
  notes: 'Każdy domofon Hikvision z włączonym ISAPI. Hasło — konto admin urządzenia (digest auth wymagany).',
  capabilities: ['openDoor', 'snapshot', 'mjpeg', 'restart'],
  fields: [
    FIELD_NAME,
    FIELD_IP,
    FIELD_LOGIN('admin'),
    FIELD_PASSWORD,
    FIELD_CHANNEL,
    FIELD_RTSP_PATH_OVERRIDE,
    FIELD_RELAYS,
    FIELD_OCR_ENABLED,
  ],
  defaults: { channel: 1, login: 'admin' },
  constants: {
    httpPort: 80,
    rtspPort: 554,
    relayPulseSeconds: 1,
    holdOpenMaxSeconds: 600,
    httpTimeoutMs: 5000,
    snapshotTimeoutMs: 5000,
    requiresDigestAuth: true,
  },
  certification: {
    status: 'beta',
    testedFirmware: ['V2.4.x'],
    testedBy: 'GateLynk QA',
    recommendedFor: 'residential',
  },
  endpoints: {
    ping: ['http://{ip}:{httpPort}/ISAPI/System/deviceInfo'],
    snapshot: ['http://{ip}:{httpPort}/ISAPI/Streaming/channels/{channel*100+1}/picture'],
    rtspPath: [
      'Streaming/Channels/{channel*100+1}',
      'Streaming/Channels/{channel*100+2}',
    ],
    restart: {
      method: 'PUT',
      url: 'http://{ip}:{httpPort}/ISAPI/System/reboot',
      auth: 'digest',
    },
    openDoor: {
      method: 'PUT',
      url: 'http://{ip}:{httpPort}/ISAPI/AccessControl/RemoteControl/door/{relay}',
      auth: 'digest',
      contentType: 'application/xml',
      body: '<RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>',
    },
    // Faza F-1 (2026-05-14): discovery hints.
    // Hikvision intercom publikuje pod `_http._tcp` z hostname `DS-K1T*` / `DS-KV*` / `DS-KD*`
    // (modele access-control). Inne Hik (kamery, LPR) NIE pasują do tego pattern-a — patrz
    // niżej `hikvisionCamera`/`hikvisionLpr` które mają swoje regexy.
    discovery: {
      mdnsHostnamePattern: /^DS-K[1-9]T|^DS-KV|^DS-KD|^HIKVISION DS-K/i,
      macPrefixes: [
        'C0:51:7E', '44:19:B6', '18:68:CB', '44:47:CC',
        'B4:A3:82', 'BC:AD:28', 'F4:B7:E2', 'F8:4D:FC',
      ],
      httpProbe: {
        path: '/ISAPI/System/deviceInfo',
        port: 80,
        expectHeader: { name: 'Server', pattern: /webserver|hikvision/i },
      },
    },
  },
}

export const hikvisionLpr: DeviceDriver = {
  id: 'hikvision-lpr',
  type: 'LPR_CAMERA',
  manufacturer: 'Hikvision',
  models: [
    'iDS-TCM403-AI', 'iDS-TCM203', 'iDS-TCM403',
    'iDS-2CD7A26G0/P-IZHS', 'iDS-2CD7A46G0/P-IZHS',
    'DS-2CD7A26G0/P-IZHS',
    // DeepinView 4A (starsza generacja, fw V5.4.x) — zweryfikowane na obiekcie
    // VN 2026-08-05. Sufiks `/P` to wariant z ANPR; ta sama kamera BEZ `/P`
    // tablic nie czyta, więc NIE dopisuj tu `DS-2CD4A26FWD-IZS`.
    'DS-2CD4A26FWD-IZS/P', 'DS-2CD4A25FWD-IZS/P', 'DS-2CD4A35FWD-IZS/P',
  ],
  label: 'Hikvision LPR / ANPR',
  icon: '🚗',
  notes: 'Kamera ANPR Hik z ISAPI. Edge subskrybuje eventy ANPR przez HTTP host notification i otrzymuje pushe z numerami tablic.',
  capabilities: ['snapshot', 'mjpeg', 'restart', 'lprPushList', 'lprEvents'],
  // Skrócone pola — instalator wybiera tylko tryb whitelisty + identyfikacja
  // przy niskiej pewności (to są decyzje BIZNESOWE per instalacja). Resztę
  // (porty, channel, confidence threshold, plate length, cooldown) zaszywamy
  // w `constants` — przetestowane wartości dla Hik LPR.
  fields: [
    FIELD_NAME,
    FIELD_IP,
    FIELD_LOGIN('admin'),
    FIELD_PASSWORD,
    FIELD_CHANNEL,
    FIELD_RTSP_PATH_OVERRIDE,
    {
      key: 'plateSource',
      label: 'Kto odczytuje tablice',
      type: 'select',
      group: 'lpr',
      default: 'auto',
      options: [
        { value: 'auto',     label: 'Automatycznie — wykryj po modelu kamery' },
        { value: 'camera',   label: 'Kamera (natywne ANPR — kamera podaje gotowy numer)' },
        { value: 'edge-ocr', label: 'GateLynk Edge (kamera daje sygnał, tablicę czyta Edge)' },
      ],
      help:
        'Część kamer ANPR rozpoznaje tablice wyłącznie na własny użytek i nie udostępnia ' +
        'numeru przez sieć (starsze Hikvision DeepinView 4A — dane wychodzą tylko przez ' +
        'zamknięte SDK producenta). Dla nich wybierz „GateLynk Edge": kamera służy wtedy ' +
        'za wyzwalacz, a tablicę odczytujemy lokalnie. Tryb „Automatycznie" pyta kamerę ' +
        'o model i decyduje sam — zostaw go, jeśli nie masz powodu wymuszać innego.',
    },
    {
      key: 'whitelistMode',
      label: 'Tryb listy tablic',
      type: 'select',
      group: 'lpr',
      default: 'camera',
      options: [
        { value: 'camera', label: 'Lista wgrywana do kamery (kamera sama otwiera)' },
        { value: 'edge',   label: 'Edge dopasowuje tablice (kamera tylko zgłasza)' },
      ],
      help: 'Tryb „camera" wymaga aby kamera obsługiwała listy ANPR (zwykle Hik z firmware ≥ 5.5).',
    },
    {
      key: 'cameraListSyncMethod',
      label: 'Metoda synchronizacji listy do kamery',
      type: 'select',
      group: 'lpr',
      default: 'isapi',
      options: [
        { value: 'isapi', label: 'ISAPI (rekomendowane)' },
        { value: 'sdk',   label: 'Hik SDK (legacy)' },
        { value: 'none',  label: 'Brak — Edge nie wgrywa listy' },
      ],
      showWhen: (cfg) => cfg.whitelistMode === 'camera',
    },
    {
      key: 'identifyOnZeroConf',
      label: 'Identyfikuj również przy niskiej pewności',
      type: 'boolean',
      group: 'lpr',
      default: false,
      help: 'Gdy włączone — Edge zapisuje także odczyty z `confidence < 0.5` (więcej fałszywych pozytywów).',
    },
    FIELD_OCR_ENABLED,
  ],
  defaults: {
    channel: 1,
    login: 'admin',
    plateSource: 'auto',
    whitelistMode: 'camera',
    cameraListSyncMethod: 'isapi',
    identifyOnZeroConf: false,
  },
  constants: {
    httpPort: 80,
    rtspPort: 554,
    relayPulseSeconds: 1,
    httpTimeoutMs: 5000,
    snapshotTimeoutMs: 5000,
    requiresDigestAuth: true,
    // LPR-specific — zaszyte na podstawie testów Hik iDS-TCM403 fw V5.6.10.
    // Wartości dobrane żeby zminimalizować fałszywe pozytywy w polskiej
    // numeracji (5-7 znaków alfanum).
    confidenceThreshold: 0.8,
    minPlateLength: 5,
    maxPlateLength: 8,
    eventCooldownSeconds: 5,
    // Port Edge dla pushów ANPR — zaszyty bo nasz Edge zawsze :4000.
    // Gdy zmieniony, instalator musi zmienić w hosts notification kamery ręcznie.
    eventCallbackPort: 4000,
    // Co ile sekund Edge ściąga whitelist z Cloud (dla whitelistMode='camera').
    pushListPullSec: 60,
  },
  certification: {
    status: 'certified',
    testedFirmware: ['V5.4.5', 'V5.6.10', 'V5.7.x'],
    testedAt: '2026-08-05',
    testedBy: 'GateLynk QA',
    knownIssues: [
      'Domyślny confidence (0.5) daje false-positive — driver wymusza 0.8.',
      'Push ANPR po reboot kamery wymaga ponownej rejestracji host-notification (Edge robi to przy reconnect).',
      'fw V5.4.5 (DeepinView 4A): GET /ISAPI/Event/triggers zwraca 500 „Device Error", ' +
        'ale pojedynczy trigger /ISAPI/Event/triggers/vehicledetection-1 czyta się poprawnie. ' +
        'Nie traktuj błędu listy jako braku ANPR.',
      'fw V5.4.5: id triggera to `vehicledetection-1` (małe litery), nie `VehicleDetect-1`.',
      'Kamera ma tylko JEDEN slot http host notification — przy współistnieniu ze starszym ' +
        'systemem sprawdź, czy nie odbierasz mu kanału zdarzeń.',
    ],
    recommendedFor: 'commercial',
  },
  endpoints: {
    ping: ['http://{ip}:{httpPort}/ISAPI/System/deviceInfo'],
    snapshot: ['http://{ip}:{httpPort}/ISAPI/Streaming/channels/{channel*100+1}/picture'],
    rtspPath: [
      'Streaming/Channels/{channel*100+1}',
      'Streaming/Channels/{channel*100+2}',
    ],
    restart: {
      method: 'PUT',
      url: 'http://{ip}:{httpPort}/ISAPI/System/reboot',
      auth: 'digest',
    },
    // Faza F-1: discovery — Hik LPR-y to seria `iDS-TC*` (TCM403/203) plus
    // niektóre `DS-2CD7*P-IZHS` z ANPR ASIC. Patrz models[] dla pełnej listy.
    discovery: {
      mdnsHostnamePattern: /^iDS-TC|^DS-2CD7.*IZHS|^HIKVISION iDS-/i,
      macPrefixes: [
        'C0:51:7E', '44:19:B6', '18:68:CB', '44:47:CC',
        'B4:A3:82', 'BC:AD:28', 'F4:B7:E2', 'F8:4D:FC',
      ],
      httpProbe: {
        path: '/ISAPI/System/deviceInfo',
        port: 80,
        expectHeader: { name: 'Server', pattern: /webserver|hikvision/i },
      },
    },
  },
}

export const hikvisionCamera: DeviceDriver = {
  id: 'hikvision-camera',
  type: 'CAMERA',
  manufacturer: 'Hikvision',
  models: ['DS-2CD2087G2-L', 'DS-2CD2H85FWD-IZS', 'Hikvision IP (generic)'],
  label: 'Hikvision IP camera (ISAPI)',
  icon: '📷',
  capabilities: ['snapshot', 'mjpeg', 'restart'],
  fields: [
    FIELD_NAME,
    FIELD_IP,
    FIELD_LOGIN('admin'), FIELD_PASSWORD,
    FIELD_CHANNEL,
    FIELD_RTSP_PATH_OVERRIDE,
    FIELD_OCR_ENABLED,
  ],
  defaults: { channel: 1, login: 'admin' },
  constants: {
    httpPort: 80,
    rtspPort: 554,
    httpTimeoutMs: 5000,
    snapshotTimeoutMs: 5000,
    requiresDigestAuth: true,
  },
  certification: {
    status: 'certified',
    testedFirmware: ['V5.7.x'],
    testedAt: '2026-04-20',
    testedBy: 'GateLynk QA',
    recommendedFor: 'residential',
  },
  endpoints: {
    ping: ['http://{ip}:{httpPort}/ISAPI/System/deviceInfo'],
    snapshot: ['http://{ip}:{httpPort}/ISAPI/Streaming/channels/{channel*100+1}/picture'],
    rtspPath: [
      'Streaming/Channels/{channel*100+1}',
      'Streaming/Channels/{channel*100+2}',
    ],
    restart: {
      method: 'PUT',
      url: 'http://{ip}:{httpPort}/ISAPI/System/reboot',
      auth: 'digest',
    },
    // Faza F-1: discovery — generyczne kamery IP `DS-2CD*` / `DS-2DE*` (PTZ).
    // NIE matchujemy `DS-K*` (access control) ani `iDS-TC*` (LPR) — te mają
    // własne drivery z precyzyjnymi regexami.
    discovery: {
      mdnsHostnamePattern: /^DS-2CD(?!7.*IZHS)|^DS-2DE|^HIKVISION DS-2C/i,
      macPrefixes: [
        'C0:51:7E', '44:19:B6', '18:68:CB', '44:47:CC',
        'B4:A3:82', 'BC:AD:28', 'F4:B7:E2', 'F8:4D:FC',
      ],
      httpProbe: {
        path: '/ISAPI/System/deviceInfo',
        port: 80,
        expectHeader: { name: 'Server', pattern: /webserver|hikvision/i },
      },
    },
  },
}
