/**
 * Driver Comelit — REST API zbliżone do 2N.
 */
import type { DeviceDriver } from '../types'
import {
  FIELD_IP, FIELD_HTTP_PORT, FIELD_LOGIN, FIELD_PASSWORD,
  FIELD_RTSP_PORT, FIELD_RTSP_LOGIN, FIELD_RTSP_PASSWORD,
  FIELD_RELAYS, FIELD_NAME,
} from './_common'

export const comelitIntercom: DeviceDriver = {
  id: 'comelit-intercom',
  type: 'INTERCOM',
  manufacturer: 'Comelit',
  models: ['Ultra', 'Mini', 'Switch'],
  label: 'Comelit IP',
  icon: '🚪',
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
      'https://{ip}:{httpPort}/snapshot.jpg',
      'http://{ip}/snapshot.jpg',
    ],
    rtspPath: ['live/ch00_0', 'live/ch00_1'],
    openDoor: {
      method: 'POST',
      url: 'https://{ip}:{httpPort}/api/io/output/{relay}/on',
      auth: 'basic',
    },
  },
  certification: {
    status: 'untested',
    recommendedFor: 'residential',
    knownIssues: [
      'Driver szkielet — brak realnej weryfikacji. URL-e prawdopodobnie niepoprawne dla nowszych Comelit.',
    ],
  },
}
