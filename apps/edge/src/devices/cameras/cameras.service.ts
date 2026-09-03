import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { lanHttpsAgent } from '../lan-https-agent'
import { DeviceStatusEntry } from '../../tunnel/tunnel.types'
import { requestWithDigest } from '../http-digest'

interface CameraConfig {
  ipAddress: string
  /** Default 'admin' for Hikvision — LPR cameras added via Cloud often omit this field. */
  login?: string
  password: string
  manufacturer: string
  channel?: number
  rtspPort?: number
  httpPort?: number  // default 80
}

/**
 * Resolve the username for an HTTP(S) request to the camera. Hikvision's
 * default admin user is 'admin'; if config was saved without a login
 * (as happens for LPR cameras created via the Cloud panel before the
 * form was updated), we fall back rather than sending undefined and
 * getting a 401.
 */
function resolveLogin(config: CameraConfig): string {
  if (config.login && config.login.trim().length > 0) return config.login
  const m = config.manufacturer?.toLowerCase() ?? ''
  if (m.includes('hikvision')) return 'admin'
  if (m.includes('dahua'))     return 'admin'
  if (m.includes('axis'))      return 'root'
  return ''
}

const httpsAgent = lanHttpsAgent

interface CameraDevice {
  id: string
  config: CameraConfig
  online: boolean
  lastSeen?: number
}

@Injectable()
export class CamerasService {
  private readonly logger = new Logger(CamerasService.name)
  private devices: Map<string, CameraDevice> = new Map()

  addDevice(id: string, config: CameraConfig) {
    // Normalize login so downstream code (including snapshot/restart) never
    // has to repeat the Hikvision-admin fallback dance.
    const normalized: CameraConfig = { ...config, login: resolveLogin(config) }
    this.devices.set(id, { id, config: normalized, online: false })
    this.logger.log(`Camera registered: ${id} @ ${normalized.ipAddress} (user=${normalized.login || '-'})`)
  }

  removeDevice(id: string): boolean {
    const existed = this.devices.delete(id)
    if (existed) this.logger.log(`Camera unregistered: ${id}`)
    return existed
  }

  async execute(action: string, payload?: any): Promise<any> {
    const deviceId = payload?.deviceId ?? [...this.devices.keys()][0]
    const device = this.devices.get(deviceId)
    if (!device) throw new Error(`Camera ${deviceId} not found`)

    if (action === 'CAMERA_SNAPSHOT') return this.snapshot(device)
    throw new Error(`Camera: unknown action ${action}`)
  }

  // Public accessor for device-registry
  async getSnapshot(deviceId: string): Promise<{ image: string } | null> {
    const device = this.devices.get(deviceId)
    if (!device) return null
    try {
      return await this.snapshot(device)
    } catch (err: any) {
      this.logger.warn(`Camera snapshot failed for ${deviceId} (${device.config.ipAddress}): ${err?.message || err}`)
      return null
    }
  }

  /**
   * Build the list of snapshot URLs to try, per manufacturer.
   * Tries http first, then https (self-signed OK).
   * For Hikvision, normalises the channel field: if the user wrote "1"
   * the URL becomes .../channels/101/... (channel 1, main stream).
   */
  private buildSnapshotUrls(config: CameraConfig): string[] {
    const ip   = config.ipAddress
    const port = config.httpPort ? `:${config.httpPort}` : ''
    const m    = config.manufacturer.toLowerCase()

    if (m.includes('hikvision')) {
      // Accept both stream-IDs (101, 102, 201…) and plain channel numbers (1, 2…)
      const raw = config.channel ?? 101
      const streamId = raw < 100 ? raw * 100 + 1 : raw   // 1 → 101, 2 → 201, 101 stays 101
      const subId    = raw < 100 ? raw * 100 + 2 : (streamId % 100 === 1 ? streamId + 1 : streamId)
      return [
        `http://${ip}${port}/ISAPI/Streaming/channels/${streamId}/picture`,
        `https://${ip}${port}/ISAPI/Streaming/channels/${streamId}/picture`,
        // Sub-stream fallback (lower res, but works when main is busy)
        `http://${ip}${port}/ISAPI/Streaming/channels/${subId}/picture`,
      ]
    }
    if (m.includes('dahua')) {
      const ch = config.channel ?? 1
      return [
        `http://${ip}${port}/cgi-bin/snapshot.cgi?channel=${ch}`,
        `https://${ip}${port}/cgi-bin/snapshot.cgi?channel=${ch}`,
      ]
    }
    if (m.includes('axis')) {
      return [
        `http://${ip}${port}/axis-cgi/jpg/image.cgi`,
        `https://${ip}${port}/axis-cgi/jpg/image.cgi`,
      ]
    }
    return [
      `http://${ip}${port}/snapshot.jpg`,
      `https://${ip}${port}/snapshot.jpg`,
    ]
  }

  // Returns base64 JPEG snapshot — tries Digest first (Hikvision & friends), falls back to Basic.
  private async snapshot(device: CameraDevice): Promise<{ image: string }> {
    const { config } = device
    const urls = this.buildSnapshotUrls(config)
    const errors: string[] = []

    const user = resolveLogin(config)
    for (const url of urls) {
      try {
        const res = await requestWithDigest('GET', url, user, config.password, {
          responseType: 'arraybuffer',
          timeout: 8000,
          maxRedirects: 3,
          httpsAgent,
          validateStatus: (s: number) => s === 200,
        })
        const ct = String(res.headers['content-type'] ?? 'image/jpeg').split(';')[0].trim()
        if (!ct.startsWith('image/')) {
          errors.push(`${url} → ${res.status} content-type=${ct}`)
          continue
        }
        const buf = Buffer.from(res.data as ArrayBuffer)
        if (buf.length < 500) {
          errors.push(`${url} → tiny payload ${buf.length}B`)
          continue
        }

        device.online  = true
        device.lastSeen = Date.now()
        this.logger.log(`Camera snapshot OK (${buf.length}B) from ${url}`)
        return { image: `data:${ct};base64,${buf.toString('base64')}` }
      } catch (err: any) {
        errors.push(`${url} → ${err?.response?.status ?? err?.code ?? err?.message ?? 'ERR'}`)
      }
    }

    throw new Error(`All snapshot URLs failed: ${errors.join(' | ')}`)
  }

  async restart(deviceId: string): Promise<{ restarted: boolean }> {
    const device = this.devices.get(deviceId)
    if (!device) throw new Error(`Camera ${deviceId} not found`)
    const { config } = device
    const { url, method } = this.buildRestartRequest(config)
    this.logger.log(`Restarting camera ${deviceId} via ${method} ${url}`)
    await axios.request({
      method,
      url,
      auth: { username: resolveLogin(config), password: config.password },
      timeout: 8000,
    })
    return { restarted: true }
  }

  private buildRestartRequest(config: CameraConfig): { url: string; method: 'GET' | 'POST' | 'PUT' } {
    const base = `http://${config.ipAddress}`
    const m = config.manufacturer.toLowerCase()
    if (m.includes('hikvision')) return { url: `${base}/ISAPI/System/reboot`, method: 'PUT' }
    if (m.includes('dahua'))     return { url: `${base}/cgi-bin/magicBox.cgi?action=reboot`, method: 'GET' }
    if (m.includes('uniview') || m.includes('uniview')) return { url: `${base}/LAPI/V1.0/System/Reboot`, method: 'POST' }
    // Generic fallback
    return { url: `${base}/cgi-bin/reboot`, method: 'GET' }
  }

  getStatus(): DeviceStatusEntry[] {
    return [...this.devices.values()].map((d) => ({
      id: d.id,
      type: 'CAMERA',
      label: `${d.config.manufacturer} (${d.config.ipAddress})`,
      status: d.online ? 'online' : 'offline',
      lastSeen: d.lastSeen,
    }))
  }
}
