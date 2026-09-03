/**
 * Drivery Dahua — Smart Series HTTP API + ITC dla LPR.
 */
import type { DeviceDriver } from '../types'
import {
  FIELD_IP, FIELD_HTTP_PORT, FIELD_LOGIN, FIELD_PASSWORD,
  FIELD_RTSP_PORT, FIELD_CHANNEL, FIELD_RTSP_LOGIN, FIELD_RTSP_PASSWORD,
  FIELD_RTSP_PATH_OVERRIDE, FIELD_NAME,
} from './_common'

export const dahuaCamera: DeviceDriver = {
  id: 'dahua-camera',
  type: 'CAMERA',
  manufacturer: 'Dahua',
  models: ['Dahua IP (Smart Series)'],
  label: 'Dahua IP camera',
  icon: '📷',
  capabilities: ['snapshot', 'mjpeg', 'restart'],
  fields: [
    FIELD_NAME,
    FIELD_IP, FIELD_HTTP_PORT,
    FIELD_LOGIN('admin'), FIELD_PASSWORD,
    FIELD_RTSP_PORT, FIELD_CHANNEL,
    FIELD_RTSP_LOGIN, FIELD_RTSP_PASSWORD, FIELD_RTSP_PATH_OVERRIDE,
  ],
  defaults: { httpPort: 80, rtspPort: 554, channel: 1, login: 'admin' },
  endpoints: {
    ping: ['http://{ip}:{httpPort}/cgi-bin/magicBox.cgi?action=getDeviceType'],
    snapshot: ['http://{ip}:{httpPort}/cgi-bin/snapshot.cgi?channel={channel}'],
    rtspPath: [
      'cam/realmonitor?channel={channel}&subtype=0',
      'cam/realmonitor?channel={channel}&subtype=1',
    ],
    restart: {
      method: 'GET',
      url: 'http://{ip}:{httpPort}/cgi-bin/magicBox.cgi?action=reboot',
      auth: 'digest',
    },
  },
  certification: {
    status: 'beta',
    recommendedFor: 'residential',
    knownIssues: [
      'Driver napisany na bazie Dahua HTTP API docs. Działa w podstawowym zakresie, brak pełnej walidacji.',
    ],
  },
}

export const dahuaItcLpr: DeviceDriver = {
  id: 'dahua-itc-lpr',
  type: 'LPR_CAMERA',
  manufacturer: 'Dahua',
  models: ['ITC215', 'ITC415', 'ITC237', 'ITC413'],
  label: 'Dahua ITC (LPR/ANPR)',
  icon: '🚗',
  capabilities: ['snapshot', 'mjpeg', 'restart', 'lprEvents'],
  fields: [
    FIELD_NAME,
    FIELD_IP, FIELD_HTTP_PORT,
    FIELD_LOGIN('admin'), FIELD_PASSWORD,
    FIELD_RTSP_PORT, FIELD_CHANNEL,
    FIELD_RTSP_LOGIN, FIELD_RTSP_PASSWORD, FIELD_RTSP_PATH_OVERRIDE,
    {
      key: 'whitelistMode',
      label: 'Tryb listy tablic',
      type: 'select',
      group: 'lpr',
      default: 'edge',
      options: [
        { value: 'camera', label: 'Lista wgrywana do kamery (Dahua TrafficSnap)' },
        { value: 'edge',   label: 'Edge dopasowuje tablice (rekomendowane dla ITC)' },
      ],
    },
    {
      key: 'pushListPullSec',
      label: 'Co ile sekund odświeżać listę',
      type: 'number',
      group: 'lpr',
      default: 60,
      min: 10,
      max: 3600,
      showWhen: (cfg) => cfg.whitelistMode === 'camera',
    },
  ],
  defaults: {
    httpPort: 80, rtspPort: 554, channel: 1, login: 'admin',
    whitelistMode: 'edge', pushListPullSec: 60,
  },
  endpoints: {
    ping: ['http://{ip}:{httpPort}/cgi-bin/magicBox.cgi?action=getDeviceType'],
    snapshot: ['http://{ip}:{httpPort}/cgi-bin/snapshot.cgi?channel={channel}'],
    rtspPath: [
      'cam/realmonitor?channel={channel}&subtype=0',
      'cam/realmonitor?channel={channel}&subtype=1',
    ],
    restart: {
      method: 'GET',
      url: 'http://{ip}:{httpPort}/cgi-bin/magicBox.cgi?action=reboot',
      auth: 'digest',
    },
  },
  certification: {
    status: 'beta',
    recommendedFor: 'commercial',
    knownIssues: [
      'Driver dla Dahua ITC LPR — testowany pobieżnie. Brak weryfikacji pełnego flow ANPR.',
    ],
  },
}
