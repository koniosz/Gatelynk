import { Injectable } from '@nestjs/common'
import * as os from 'os'
import { ActivationService } from '../activation/activation.service'
import { StoreService } from '../store/store.service'

@Injectable()
export class StatusService {
  private readonly startTime = Date.now()

  constructor(
    private activation: ActivationService,
    private store: StoreService,
  ) {}

  /** Primary LAN IP — first non-loopback IPv4 address */
  getLanIp(): string {
    const ifaces = os.networkInterfaces()
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address
        }
      }
    }
    return 'unknown'
  }

  getInfo() {
    return {
      ip:       this.getLanIp(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch:     os.arch(),
      deviceId: this.activation.getDeviceId(),
      version:  process.env.npm_package_version ?? '0.1.0',
    }
  }

  getFullStatus() {
    const uptime = Math.round((Date.now() - this.startTime) / 1000)
    return {
      activated:  this.activation.isActivated(),
      deviceId:   this.activation.getDeviceId(),
      buildingId: this.activation.getBuildingId(),
      uptime,
      queueSize:  this.store.queueSize(),
      ip:         this.getLanIp(),
      system: {
        hostname:   os.hostname(),
        platform:   os.platform(),
        arch:       os.arch(),
        freeMemMb:  Math.round(os.freemem() / 1024 / 1024),
        totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
        loadAvg:    os.loadavg(),
      },
    }
  }
}
