/**
 * LanSwitchService — zarządzanie managed switchami (UniFi, …) z Edge.
 *
 * Per-device state w pamięci:
 *   • config (UniFi controller URL, login, MAC switcha, mapping port→GateLynk device)
 *   • UnifiClient (lazy login)
 *   • cache last `port_table` + `port_overrides` + `device._id` + lastFetchedAt
 *
 * Polling: `@Interval(pollSeconds * 1000)` per device — odświeża stan portów.
 * Cache pozwala UI dostać natychmiastową odpowiedź na `GET /devices/:id/switch/ports`
 * bez czekania na round-trip do controllera (15 sek opóźnienia max).
 *
 * Port assignment (config.portMap):
 *   { [portIdx]: { label?: string; assignedDeviceId?: string } }
 * `label` pushujemy też do `port_overrides[].name` żeby było widoczne w UniFi.
 * `assignedDeviceId` to UUID innego urządzenia GateLynk (intercom/camera) — lokalne.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { StoreService } from '../../store/store.service'
import { UnifiClient, mergePortOverride } from './unifi-client'
import type {
  UnifiSwitchDevice, UnifiPortInfo, UnifiPortOverride, UnifiControllerType,
} from './unifi-client'

export interface LanSwitchConfig {
  controllerUrl: string
  controllerType?: UnifiControllerType
  site?: string
  login: string
  password: string
  mac: string
  pollSeconds?: number
  portCount?: number
  portMap?: Record<string, { label?: string; assignedDeviceId?: string }>
  /** Cached przez Edge dla szybkiego lookup-u przy PUT /port_overrides. */
  unifiDeviceId?: string
}

export interface PortStateView {
  portIdx: number
  name: string
  linkUp: boolean
  speedMbps: number
  poeEnabled: boolean
  poeMode: string
  poePower: number
  rxBytes: number
  txBytes: number
  /** Z `config.portMap` — kto siedzi na tym porcie wg ustawień admina. */
  assignedDeviceId?: string
  customLabel?: string
}

interface SwitchEntry {
  id: string
  config: LanSwitchConfig
  client: UnifiClient
  unifiDevice: UnifiSwitchDevice | null
  lastFetchedAt: number | null
  lastError: string | null
}

@Injectable()
export class LanSwitchService {
  private readonly logger = new Logger(LanSwitchService.name)
  private switches = new Map<string, SwitchEntry>()
  private pollTimers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly store: StoreService) {}

  addDevice(id: string, config: LanSwitchConfig) {
    if (this.switches.has(id)) this.removeDevice(id)
    const client = new UnifiClient({
      controllerUrl:  config.controllerUrl,
      controllerType: config.controllerType ?? 'unifi-os',
      username:       config.login,
      password:       config.password,
      site:           config.site ?? 'default',
    })
    const entry: SwitchEntry = {
      id, config, client,
      unifiDevice: null, lastFetchedAt: null, lastError: null,
    }
    this.switches.set(id, entry)

    // First fetch + polling
    const periodMs = Math.max(5_000, (config.pollSeconds ?? 15) * 1000)
    void this.refresh(id)
    const timer = setInterval(() => { void this.refresh(id) }, periodMs)
    this.pollTimers.set(id, timer)
    this.logger.log(`UniFi switch registered: ${id} @ ${config.controllerUrl} (poll ${periodMs}ms, mac ${config.mac})`)
  }

  removeDevice(id: string): boolean {
    const timer = this.pollTimers.get(id)
    if (timer) { clearInterval(timer); this.pollTimers.delete(id) }
    const existed = this.switches.delete(id)
    if (existed) this.logger.log(`UniFi switch unregistered: ${id}`)
    return existed
  }

  /** Pojedyncze odświeżenie stanu portów z controllera. */
  async refresh(id: string): Promise<void> {
    const entry = this.switches.get(id)
    if (!entry) return
    try {
      const device = await entry.client.findSwitchByMac(entry.config.mac)
      if (!device) {
        entry.lastError = `Switch o MAC ${entry.config.mac} nie znaleziony w controller-ze (site ${entry.config.site ?? 'default'})`
        entry.unifiDevice = null
      } else {
        entry.unifiDevice = device
        entry.lastError = null
        // Cache UniFi _id w configu — kolejne PUT-y nie muszą przeczytać /stat/device.
        if (entry.config.unifiDeviceId !== device._id) {
          entry.config.unifiDeviceId = device._id
          this.persistConfig(id, entry.config)
        }
      }
      entry.lastFetchedAt = Date.now()
    } catch (err: any) {
      entry.lastError = err?.message ?? String(err)
      entry.lastFetchedAt = Date.now()
      this.logger.warn(`UniFi refresh ${id}: ${entry.lastError}`)
    }
  }

  /** Synchroniczny widok ostatniego znanego stanu (z polling cache). */
  listPorts(id: string): PortStateView[] {
    const entry = this.requireEntry(id)
    if (!entry.unifiDevice) return this.placeholderPorts(entry)
    return entry.unifiDevice.port_table.map((p) => this.mapPort(p, entry))
  }

  status(id: string): { lastFetchedAt: number | null; lastError: string | null; online: boolean } {
    const entry = this.requireEntry(id)
    return {
      lastFetchedAt: entry.lastFetchedAt,
      lastError: entry.lastError,
      online: !!entry.unifiDevice && entry.unifiDevice.state === 1,
    }
  }

  /** Toggle PoE per port — `auto` lub `off`. Inne tryby (passive24) jak chcesz to per-driver. */
  async setPortPoe(id: string, portIdx: number, enabled: boolean): Promise<void> {
    const entry = this.requireEntry(id)
    if (!entry.unifiDevice) {
      // Spróbuj odświeżyć żeby mieć device._id.
      await this.refresh(id)
    }
    const device = entry.unifiDevice
    if (!device) throw new Error(entry.lastError ?? 'Switch unavailable')

    const overrides = mergePortOverride(
      device.port_overrides ?? [],
      portIdx,
      { poe_mode: enabled ? 'auto' : 'off' },
    )
    await entry.client.putPortOverrides(device._id, overrides)
    // Optimistic update — caller dostaje świeży stan po następnym poll-u.
    device.port_overrides = overrides
    this.logger.log(`UniFi ${id} port ${portIdx} PoE → ${enabled ? 'auto' : 'off'}`)
  }

  /** Przypisanie label-a + GateLynk deviceId do portu. */
  async setPortAssignment(
    id: string,
    portIdx: number,
    patch: { label?: string; assignedDeviceId?: string | null },
  ): Promise<void> {
    const entry = this.requireEntry(id)
    const portMap = { ...(entry.config.portMap ?? {}) }
    const key = String(portIdx)
    const prev = portMap[key] ?? {}
    portMap[key] = {
      ...prev,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...('assignedDeviceId' in patch
        ? (patch.assignedDeviceId
            ? { assignedDeviceId: patch.assignedDeviceId }
            : { assignedDeviceId: undefined })
        : {}),
    }
    // Wyczyść puste wpisy żeby nie zaśmiecać configu.
    if (!portMap[key].label && !portMap[key].assignedDeviceId) delete portMap[key]
    entry.config.portMap = portMap
    this.persistConfig(id, entry.config)

    // Push label do UniFi jako `port_overrides[].name` — widoczne też z poziomu UniFi UI.
    if (patch.label !== undefined && entry.unifiDevice) {
      const overrides = mergePortOverride(
        entry.unifiDevice.port_overrides ?? [],
        portIdx,
        { name: patch.label || '' },
      )
      try {
        await entry.client.putPortOverrides(entry.unifiDevice._id, overrides)
        entry.unifiDevice.port_overrides = overrides
      } catch (err: any) {
        this.logger.warn(`UniFi ${id} push label dla portu ${portIdx} nie powiódł się (lokalny portMap zapisany): ${err?.message ?? err}`)
      }
    }
    this.logger.log(`UniFi ${id} port ${portIdx} → ${JSON.stringify(portMap[key] ?? null)}`)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private requireEntry(id: string): SwitchEntry {
    const entry = this.switches.get(id)
    if (!entry) throw new NotFoundException(`LAN switch ${id} not registered`)
    return entry
  }

  private mapPort(p: UnifiPortInfo, entry: SwitchEntry): PortStateView {
    const portMap = entry.config.portMap ?? {}
    const assigned = portMap[String(p.port_idx)] ?? {}
    return {
      portIdx: p.port_idx,
      name: p.name ?? `Port ${p.port_idx}`,
      linkUp: !!p.up,
      speedMbps: p.speed ?? 0,
      poeEnabled: this.isPoeOn(p, entry.unifiDevice?.port_overrides),
      poeMode: this.resolvePoeMode(p, entry.unifiDevice?.port_overrides),
      poePower: Number(p.poe_power ?? 0) || 0,
      rxBytes: p.rx_bytes ?? 0,
      txBytes: p.tx_bytes ?? 0,
      assignedDeviceId: assigned.assignedDeviceId,
      customLabel: assigned.label,
    }
  }

  private isPoeOn(p: UnifiPortInfo, overrides: UnifiPortOverride[] | undefined): boolean {
    const ov = overrides?.find((o) => o.port_idx === p.port_idx)
    if (ov?.poe_mode) return ov.poe_mode !== 'off'
    if (p.poe_enable !== undefined) return !!p.poe_enable
    return (p.poe_mode ?? 'off') !== 'off'
  }

  private resolvePoeMode(p: UnifiPortInfo, overrides: UnifiPortOverride[] | undefined): string {
    const ov = overrides?.find((o) => o.port_idx === p.port_idx)
    return ov?.poe_mode ?? p.poe_mode ?? 'off'
  }

  /** Gdy controller niedostępny / 401 — zwracamy pusty grid wg `portCount`. */
  private placeholderPorts(entry: SwitchEntry): PortStateView[] {
    const count = entry.config.portCount ?? 8
    const portMap = entry.config.portMap ?? {}
    const out: PortStateView[] = []
    for (let i = 1; i <= count; i++) {
      const assigned = portMap[String(i)] ?? {}
      out.push({
        portIdx: i,
        name: `Port ${i}`,
        linkUp: false,
        speedMbps: 0,
        poeEnabled: false,
        poeMode: 'unknown',
        poePower: 0,
        rxBytes: 0, txBytes: 0,
        assignedDeviceId: assigned.assignedDeviceId,
        customLabel: assigned.label,
      })
    }
    return out
  }

  private persistConfig(id: string, config: LanSwitchConfig) {
    try {
      this.store.setDeviceConfig(id, 'LAN_SWITCH', config as unknown as Record<string, unknown>)
    } catch (err: any) {
      this.logger.warn(`Persist LAN_SWITCH config ${id} failed: ${err?.message ?? err}`)
    }
  }
}
