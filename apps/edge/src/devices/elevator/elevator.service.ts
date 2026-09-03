import { Injectable, Logger } from '@nestjs/common'
import { DeviceStatusEntry } from '../../tunnel/tunnel.types'

interface ElevatorConfig {
  ipAddress: string
  protocol: 'MODBUS_TCP' | 'HTTP' | 'MQTT'
  topic?: string
  floors?: number
}

interface ElevatorDevice {
  id: string
  config: ElevatorConfig
  online: boolean
  lastSeen?: number
}

@Injectable()
export class ElevatorService {
  private readonly logger = new Logger(ElevatorService.name)
  private devices: Map<string, ElevatorDevice> = new Map()

  addDevice(id: string, config: ElevatorConfig) {
    this.devices.set(id, { id, config, online: false })
    this.logger.log(`Elevator registered: ${id} (${config.protocol} @ ${config.ipAddress})`)
  }

  removeDevice(id: string): boolean {
    const existed = this.devices.delete(id)
    if (existed) this.logger.log(`Elevator unregistered: ${id}`)
    return existed
  }

  async execute(action: string, payload?: any): Promise<any> {
    const deviceId = payload?.deviceId ?? [...this.devices.keys()][0]
    const device = this.devices.get(deviceId)
    if (!device) throw new Error(`Elevator ${deviceId} not found`)

    if (action === 'ELEVATOR_CALL') {
      const floor = payload?.floor ?? 0
      this.logger.log(`Elevator call to floor ${floor} on ${device.id}`)
      // Protocol-specific implementation would go here
      // (Modbus TCP register write, HTTP command, or MQTT publish)
      device.online = true
      device.lastSeen = Date.now()
      return { called: true, floor }
    }

    throw new Error(`Elevator: unknown action ${action}`)
  }

  getStatus(): DeviceStatusEntry[] {
    return [...this.devices.values()].map((d) => ({
      id: d.id,
      type: 'ELEVATOR',
      label: `Elevator (${d.config.protocol} @ ${d.config.ipAddress})`,
      status: d.online ? 'online' : 'offline',
      lastSeen: d.lastSeen,
    }))
  }
}
