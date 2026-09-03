/**
 * Cienka warstwa nad `fetch` dla Edge API.
 *
 * Edge SPA serwowane przez Express na tym samym originie co API (`localhost:4000`),
 * więc wszystkie endpointy używamy ścieżek względnych (`/devices`, `/logs`, …).
 *
 * Dev mode: Vite (5173) proxy-uje do :4000 (patrz `vite.config.ts`), więc te
 * same ścieżki działają.
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json() as { message?: string }
      if (body?.message) msg = body.message
    } catch { /* ignore parse error */ }
    throw new Error(msg)
  }
  // 204 / pusta odpowiedź
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

import type {
  DeviceEntry, DeviceTreeGroup, TestResult, TestMatrix,
  Driver, DiscoveryRunStatus, DiscoveryProtocol, DeviceType, DeviceConfig,
  LanSwitchPortsResponse, LanSwitchStatus,
} from './types'

export const api = {
  // ── Devices ────────────────────────────────────────────────────────────
  listDevices: () => request<DeviceEntry[]>('/devices'),
  /**
   * Zwraca grupy per typ urządzenia, każda z `devices[]` zawierającym
   * `online`/`checkedAt`. Flatten w `useDevices` żeby uzyskać Map<deviceId, status>.
   */
  getDeviceTree: () => request<DeviceTreeGroup[]>('/devices/tree'),
  testDevice: (id: string) =>
    request<TestResult>(`/devices/${id}/test`, { method: 'POST' }),
  testMatrix: (id: string) =>
    request<TestMatrix>(`/devices/${id}/test-matrix`, { method: 'POST' }),
  restartDevice: (id: string) =>
    request<{ restarted: boolean }>(`/devices/${id}/restart`, { method: 'POST' }),
  triggerRelay: (id: string, relayIndex: number) =>
    request<{ ok: boolean; latencyMs?: number }>(
      `/devices/${id}/relay/${relayIndex}`,
      { method: 'POST' },
    ),
  holdOpen: (id: string, seconds: number, doorIndex?: number) =>
    request<{ holding: boolean; seconds: number; deviceId: string }>(
      `/devices/${id}/hold-open`,
      {
        method: 'POST',
        body: JSON.stringify({ seconds, doorIndex }),
      },
    ),
  cancelHoldOpen: (id: string) =>
    request<{ cancelled: boolean }>(
      `/devices/${id}/hold-open/cancel`,
      { method: 'POST' },
    ),
  setDnd: (id: string, enabled: boolean) =>
    request<{ dnd: boolean; deviceId: string }>(
      `/devices/${id}/dnd`,
      { method: 'POST', body: JSON.stringify({ enabled }) },
    ),
  deleteDevice: (id: string) =>
    request<{ removed: boolean }>(`/devices/${id}`, { method: 'DELETE' }),
  quickSnapshot: (id: string) =>
    request<{ snapshot: string | null }>(`/devices/${id}/snapshot`),

  // ── Wizard: drivers + discovery + device CRUD ──────────────────────────
  listDrivers: (type?: DeviceType) =>
    request<Driver[]>(`/devices/drivers${type ? `?type=${type}` : ''}`),
  startDiscovery: (opts: { protocols?: DiscoveryProtocol[]; timeoutMs?: number }) =>
    request<{ runId: string }>(`/devices/discover`, {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
  getDiscoveryRun: (runId: string) =>
    request<DiscoveryRunStatus>(`/devices/discover/${runId}`),
  createDevice: (payload: { type: DeviceType; config: DeviceConfig }) =>
    request<{ deviceId: string }>(`/devices`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateDevice: (id: string, payload: { type: DeviceType; config: DeviceConfig }) =>
    request<{ updated: boolean }>(`/devices/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  // ── LAN switch port management (UniFi, …) ──────────────────────────────
  listSwitchPorts: (id: string) =>
    request<LanSwitchPortsResponse>(`/devices/${id}/switch/ports`),
  refreshSwitch: (id: string) =>
    request<{ refreshed: boolean; status: LanSwitchStatus }>(`/devices/${id}/switch/refresh`, { method: 'POST' }),
  setPortPoe: (id: string, portIdx: number, enabled: boolean) =>
    request<{ ok: boolean; portIdx: number; poeEnabled: boolean }>(
      `/devices/${id}/switch/ports/${portIdx}/poe`,
      { method: 'POST', body: JSON.stringify({ enabled }) },
    ),
  setPortAssignment: (
    id: string,
    portIdx: number,
    body: { label?: string; assignedDeviceId?: string | null },
  ) =>
    request<{ ok: boolean; portIdx: number }>(
      `/devices/${id}/switch/ports/${portIdx}/assignment`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  // ── System / Settings (E-6.2) ──────────────────────────────────────────
  /** Wymusza exit(0) — pm2/launchd restartuje proces. */
  restartSystem: () =>
    request<{ restarting: boolean; delaySeconds: number }>(
      `/api/system/restart`, { method: 'POST' },
    ),
  /** Factory reset — wymaga `confirmHostname` matching `os.hostname()`. */
  factoryReset: (confirmHostname: string) =>
    request<{ factoryReset: boolean; restartingIn: number }>(
      `/api/system/factory-reset`,
      { method: 'POST', body: JSON.stringify({ confirmHostname }) },
    ),
  /**
   * Upload backup tarball — wymaga `confirmHostname` matching `os.hostname()`.
   *
   * Body to raw application/gzip bytes (NIE JSON, NIE multipart) — backend
   * streamuje `req` bezpośrednio do dysku przez `req.pipe(writeStream)`,
   * więc unikamy 3 GB blob-a w pamięci po stronie serwera.
   *
   * Frontend i tak musi załadować Blob do RAM (browser File API), ale
   * dla typowego backup-u (kilkadziesiąt MB do 3 GB) to OK.
   *
   * onProgress: opcjonalny callback z postępem (loaded/total bytes) —
   * używamy XMLHttpRequest zamiast fetch bo fetch nie wspiera upload progress.
   */
  restoreUpload: (
    confirmHostname: string,
    file: File | Blob,
    onProgress?: (loaded: number, total: number) => void,
  ) =>
    new Promise<{ restoring: boolean; restartingIn: number; stagingDir: string; uploadSize: number; manifestPreview: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const url = `/api/system/restore?confirmHostname=${encodeURIComponent(confirmHostname)}`
      xhr.open('POST', url)
      xhr.setRequestHeader('Content-Type', 'application/gzip')
      if (onProgress && xhr.upload) {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) onProgress(e.loaded, e.total)
        })
      }
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText))
          } catch {
            resolve({ restoring: true, restartingIn: 2, stagingDir: '', uploadSize: 0, manifestPreview: '' })
          }
        } else {
          let msg = `HTTP ${xhr.status}`
          try {
            const body = JSON.parse(xhr.responseText) as { message?: string; error?: string }
            msg = body?.message ?? body?.error ?? msg
          } catch { /* ignore */ }
          reject(new Error(msg))
        }
      })
      xhr.addEventListener('error', () => reject(new Error('Network error')))
      xhr.addEventListener('abort', () => reject(new Error('Upload aborted')))
      xhr.send(file)
    }),
  /** Sprawdzenie nowej wersji firmware (MVP stub — zwraca current jako latest). */
  firmwareCheck: () =>
    request<{ current: string; latest: string; hasUpdate: boolean; checkedAt: string }>(
      `/api/settings/firmware/check`, { method: 'POST' },
    ),
  getCloudSettings: () =>
    request<{
      connected: boolean
      endpoint: string
      buildingId: number | null
      deviceId: string | null
      activated: boolean
    }>(`/api/settings/cloud`),

  // ── Edge activation (provisioning flow) ────────────────────────────────
  /** Pobiera konfigurację: cloudUrl + flagi activated/deviceId/buildingId. */
  getActivationConfig: () =>
    request<{
      cloudUrl: string
      activated: boolean
      deviceId: string | null
      buildingId: number | null
    }>(`/activation/config`),
  /**
   * Aktywuje Edge kodem jednorazowym z Superadmin panelu. Edge wysyła kod
   * do Cloud `/api/edge/activate`, dostaje JWT + refresh token, zapisuje
   * w sqlite kv. Reconnect tunelu automatycznie po sukcesie.
   */
  activate: (code: string) =>
    request<{
      success: boolean
      deviceId?: string
      buildingId?: number
      error?: string
    }>(`/activation/activate`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  /**
   * Deaktywacja: czyści token/refresh/deviceId/buildingId w sqlite. WS się
   * rwie z error „No token", reconnect nie wystartuje. Wymaga ponownej
   * aktywacji świeżym kodem.
   */
  deactivate: () =>
    request<{ success: boolean }>(`/activation/deactivate`, { method: 'POST' }),
  /**
   * Override URL-a Cloud-a (dla deploymentów staging / on-prem cloud).
   * NIE wymaga deaktywacji — zmienia tylko gdzie wskazuje next reconnect.
   * Persystowane w sqlite key `edge.cloudUrl`.
   */
  setCloudUrl: (cloudUrl: string) =>
    request<{ success: boolean; cloudUrl?: string; error?: string }>(`/activation/config`, {
      method: 'POST',
      body: JSON.stringify({ cloudUrl }),
    }),
  /** Ostatnie ~50 relay-trigerów dla listy w Monitoringu. */
  getRecentRelayTriggers: () =>
    request<{
      triggers: Array<{
        ts: number
        deviceId: string
        relayIndex: number
        source: 'HTTP' | 'PIN' | 'HOLD_OPEN' | 'LPR' | 'OTHER'
      }>
    }>(`/api/metrics/recent-relay-triggers`),

  /**
   * Cross-camera feed odczytów LPR z filtrami. Endpoint `/lpr/reads` (bez
   * cameraDeviceId) zwraca wszystkie kamery LPR w sieci, sortowane malejąco
   * po ts. Limit max 1000 (sqlite indeks).
   */
  listLprReads: (opts: {
    plate?: string
    matched?: 'true' | 'false'
    cameraId?: string
    limit?: number
  } = {}) => {
    const params = new URLSearchParams()
    if (opts.plate)    params.set('plate', opts.plate)
    if (opts.matched)  params.set('matched', opts.matched)
    if (opts.cameraId) params.set('cameraId', opts.cameraId)
    if (opts.limit)    params.set('limit', String(opts.limit))
    const qs = params.toString()
    return request<{
      reads: Array<{
        id: number
        cameraDeviceId: string
        plate: string
        matched: boolean
        /** Privacy-safe label lokalu (np. "Niewinna 6/1"). Wcześniej `owner` było
         *  imieniem i nazwiskiem mieszkańca — zostało zredagowane na backendzie. */
        unitLabel: string | null
        gateOpened: boolean
        reason: string | null
        confidence: number | null
        direction: string | null
        ts: number
        imagePath: string | null
        vehicleColor: string | null
        vehicleBrand: string | null
        vehicleType: string | null
        vehicleSubtype: string | null
      }>
    }>(`/lpr/reads${qs ? `?${qs}` : ''}`)
  },
}
