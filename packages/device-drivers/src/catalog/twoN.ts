/**
 * Driver 2N (Helios) — REST API.
 */
import type { DeviceDriver } from '../types'
import {
  FIELD_IP, FIELD_HTTP_PORT, FIELD_LOGIN, FIELD_PASSWORD,
  FIELD_RTSP_PORT, FIELD_RTSP_LOGIN, FIELD_RTSP_PASSWORD,
  FIELD_RELAYS, FIELD_NAME,
} from './_common'

export const twoNHelios: DeviceDriver = {
  id: '2n-helios',
  type: 'INTERCOM',
  manufacturer: '2N',
  models: ['Helios IP', 'Helios IP Verso', 'Helios IP Force', 'Helios IP Vario'],
  label: '2N Helios IP',
  icon: '🚪',
  notes: '2N Helios — REST API. Hasło API ustawiasz w Web UI urządzenia (Service Settings → API).',
  capabilities: ['openDoor', 'snapshot', 'mjpeg', 'restart'],
  fields: [
    FIELD_NAME,
    FIELD_IP, FIELD_HTTP_PORT,
    FIELD_LOGIN('admin'), FIELD_PASSWORD,
    FIELD_RTSP_PORT, FIELD_RTSP_LOGIN, FIELD_RTSP_PASSWORD,
    FIELD_RELAYS,
  ],
  defaults: { httpPort: 443, rtspPort: 554, login: 'admin' },
  endpoints: {
    ping: [
      'https://{ip}:{httpPort}/api/system/info',
      'http://{ip}/api/system/info',
    ],
    snapshot: [
      'https://{ip}:{httpPort}/api/camera/snapshot',
      'http://{ip}/api/camera/snapshot',
    ],
    rtspPath: ['live/ch00_0', 'live/ch00_1'],
    restart: {
      method: 'POST',
      url: 'https://{ip}:{httpPort}/api/system/reboot',
      auth: 'basic',
    },
    openDoor: {
      method: 'POST',
      url: 'https://{ip}:{httpPort}/api/io/output/{relay}/on',
      auth: 'basic',
    },
  },
  certification: {
    status: 'untested',
    recommendedFor: 'commercial',
    knownIssues: [
      'Driver napisany na podstawie 2N HTTP API docs, brak realnej weryfikacji u klienta.',
    ],
  },
}
