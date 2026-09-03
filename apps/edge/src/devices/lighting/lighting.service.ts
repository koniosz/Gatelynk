import { Injectable, Logger } from '@nestjs/common'
import { DeviceStatusEntry } from '../../tunnel/tunnel.types'

interface LightingConfig {
  ipAddress: string
  protocol: 'KNX_IP' | 'DALI' | 'MQTT' | 'HTTP'
  groupAddress?: string
  topic?: string
}

interface LightingDevice {
  id: string
  config: LightingConfig
  online: boolean
  lastSeen?: number
}

@Injectable()
export class LightingService {
  private readonly logger = new Logger(LightingService.name)
  private devices: Map<string, LightingDevice> = new Map()

  addDevice(id: string, config: LightingConfig) {
    this.devices.set(id, { id, config, online: false })
    this.logger.log(`Lighting registered: ${id} (${config.protocol})`)
  }

  removeDevice(id: string): boolean {
    const existed = this.devices.delete(id)
    if (existed) this.logger.log(`Lighting unregistered: ${id}`)
    return existed
  }

  async execute(action: string, payload?: any): Promise<any> {
    const deviceId = payload?.deviceId ?? [...this.devices.keys()][0]
    const device = this.devices.get(deviceId)
    if (!device) throw new Error(`Lighting ${deviceId} not found`)

    switch (action) {
      case 'LIGHTS_ON':
        this.logger.log(`Lights ON — ${device.id}`)
        device.online = true; device.lastSeen = Date.now()
        return { on: true, brightness: 100 }
      case 'LIGHTS_OFF':
        this.logger.log(`Lights OFF — ${device.id}`)
        device.online = true; device.lastSeen = Date.now()
        return { on: false }
      case 'LIGHTS_DIM':
        const level = payload?.level ?? 50
        this.logger.log(`Dim to ${level}% — ${device.id}`)
        device.online = true; device.lastSeen = Date.now()
        return { on: true, brightness: level }
      default:
        throw new Error(`Lighting: unknown action ${action}`)
    }
  }

  getStatus(): DeviceStatusEntry[] {
    return [...this.devices.values()].map((d) => ({
      id: d.id,
      type: 'LIGHTING',
      label: `Lighting (${d.config.protocol})`,
      status: d.online ? 'online' : 'offline',
      lastSeen: d.lastSeen,
    }))
  }
}
