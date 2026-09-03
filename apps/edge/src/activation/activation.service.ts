import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { StoreService } from '../store/store.service'
import axios from 'axios'
import * as os from 'os'

const TOKEN_KEY = 'edge.token'
const DEVICE_ID_KEY = 'edge.deviceId'
const BUILDING_ID_KEY = 'edge.buildingId'
const REFRESH_KEY = 'edge.refreshToken'
const CLOUD_URL_KEY = 'edge.cloudUrl'

export interface ActivationResult {
  success: boolean
  deviceId?: string
  buildingId?: number
  error?: string
}

@Injectable()
export class ActivationService {
  private readonly logger = new Logger(ActivationService.name)

  constructor(
    private store: StoreService,
    private config: ConfigService,
  ) {}

  // ── Check if already activated ───────────────────────────────────────────────
  isActivated(): boolean {
    return !!this.store.get(TOKEN_KEY)
  }

  getToken(): string | null {
    return this.store.get(TOKEN_KEY)
  }

  getDeviceId(): string | null {
    return this.store.get(DEVICE_ID_KEY)
  }

  getBuildingId(): number | null {
    const v = this.store.get(BUILDING_ID_KEY)
    return v ? parseInt(v, 10) : null
  }

  // ── Cloud URL (user-configurable, persisted in store) ─────────────────────────
  getCloudUrl(): string {
    return this.store.get(CLOUD_URL_KEY) ?? this.config.get<string>('cloudUrl')
  }

  setCloudUrl(url: string): void {
    this.store.set(CLOUD_URL_KEY, url)
    this.logger.log(`Cloud URL zaktualizowany → ${url}`)
  }

  // ── Activate with one-time code ──────────────────────────────────────────────
  async activate(code: string): Promise<ActivationResult> {
    const cloudUrl = this.getCloudUrl()
    const version = this.config.get<string>('version')

    try {
      this.logger.log(`Activating with code ${code}…`)

      const machineInfo = {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemGb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
      }

      const res = await axios.post(`${cloudUrl}/api/edge/activate`, {
        activationCode: code,
        version,
        machineInfo,
      })

      const { token, refreshToken, deviceId, buildingId } = res.data

      this.store.set(TOKEN_KEY, token)
      this.store.set(REFRESH_KEY, refreshToken)
      this.store.set(DEVICE_ID_KEY, deviceId)
      this.store.set(BUILDING_ID_KEY, String(buildingId))

      this.logger.log(`Activated — deviceId=${deviceId}, buildingId=${buildingId}`)
      return { success: true, deviceId, buildingId }
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err.message
      this.logger.error(`Activation failed: ${msg}`)
      return { success: false, error: msg }
    }
  }

  // ── Token refresh ────────────────────────────────────────────────────────────
  async refreshToken(): Promise<boolean> {
    const cloudUrl = this.getCloudUrl()
    const refresh = this.store.get(REFRESH_KEY)
    if (!refresh) return false

    try {
      const res = await axios.post(`${cloudUrl}/api/edge/refresh`, { refreshToken: refresh })
      this.store.set(TOKEN_KEY, res.data.token)
      if (res.data.refreshToken) this.store.set(REFRESH_KEY, res.data.refreshToken)
      this.logger.debug('Token refreshed')
      return true
    } catch {
      this.logger.warn('Token refresh failed — may need re-activation')
      return false
    }
  }

  // ── Deactivate ───────────────────────────────────────────────────────────────
  deactivate() {
    this.store.delete(TOKEN_KEY)
    this.store.delete(REFRESH_KEY)
    this.store.delete(DEVICE_ID_KEY)
    this.store.delete(BUILDING_ID_KEY)
    this.logger.warn('Device deactivated')
  }
}
