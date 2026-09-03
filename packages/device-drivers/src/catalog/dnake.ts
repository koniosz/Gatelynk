/**
 * Driver Dnake — API zgodne z Akuvoxem (FCGI).
 */
import type { DeviceDriver } from '../types'
import {
  FIELD_IP, FIELD_LOGIN, FIELD_PASSWORD,
  FIELD_RTSP_PATH_OVERRIDE, FIELD_RELAYS, FIELD_NAME,
} from './_common'

export const dnakeIntercom: DeviceDriver = {
  id: 'dnake-intercom',
  type: 'INTERCOM',
  manufacturer: 'Dnake',
  models: ['280M', 'S615', 'S617', 'D9-IL'],
  label: 'Dnake (FCGI)',
  icon: '🚪',
  notes: 'Wideodomofon DNAKE. API zgodne z Akuvox FCGI. Brak natywnego MJPEG — Edge fallbackuje na RTSP.',
  capabilities: ['openDoor', 'snapshot', 'mjpeg', 'restart'],
  fields: [
    FIELD_NAME,
    FIELD_IP,
    FIELD_LOGIN('admin'), FIELD_PASSWORD,
    FIELD_RTSP_PATH_OVERRIDE,
    FIELD_RELAYS,
  ],
  defaults: { login: 'admin' },
  constants: {
    httpPort: 443,
    rtspPort: 554,
    rtspPath: 'live/ch00_0',
    relayPulseSeconds: 1,
    holdOpenMaxSeconds: 600,
    httpTimeoutMs: 5000,
    snapshotTimeoutMs: 5000,
  },
  certification: {
    status: 'certified',
    testedFirmware: ['1.0.x', '1.1.x'],
    testedAt: '2026-05-14',
    testedBy: 'GateLynk QA',
    recommendedFor: 'residential',
    knownIssues: [
      'Brak natywnego MJPEG (Akuvox ma) — snapshot przez RTSP fallback (~1.5s vs 50ms HTTP).',
    ],
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
    restart: {
      method: 'GET',
      url: 'https://{ip}:{httpPort}/fcgi/do?action=Restart',
      auth: 'basic',
    },
    openDoor: {
      method: 'GET',
      url: 'https://{ip}:{httpPort}/fcgi/do?action=OpenDoor&door={relay}',
      auth: 'basic',
    },
  },
}
