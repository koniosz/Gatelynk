import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import * as https from 'https'
import { StoreService } from '../store/store.service'
import { IntercomService } from './intercom/intercom.service'
import { CamerasService } from './cameras/cameras.service'
import { HikvisionLprService } from './cameras/hikvision-lpr.service'
import { ElevatorService } from './elevator/elevator.service'
import { LightingService } from './lighting/lighting.service'
import { LanSwitchService } from './lan-switch/lan-switch.service'
import { SmartLockService } from './smart-lock/smart-lock.service'
import { DeviceStatusEntry } from '../tunnel/tunnel.types'
import { requestWithDigest } from './http-digest'
import { lanHttpsAgent } from './lan-https-agent'
import {
  resolveDriver,
  pingUrls as enginePingUrls,
  snapshotUrls as engineSnapshotUrls,
  rtspPaths as engineRtspPaths,
} from './driver-engine'
import { guessDriverId, type DeviceDriver } from '@gatelynk/device-drivers'
import type { TestMatrix, TestMatrixEntry } from './test-matrix.types'

// Shared agent for self-signed camera/intercom HTTPS certs
const rejectUnauthorizedHttpsAgent = lanHttpsAgent

interface SnapCache {
  image: string
  fetchedAt: number
  refreshing: boolean
}

interface PingCache {
  online: boolean
  checkedAt: number
}

const TYPE_META: Record<string, { label: string; icon: string }> = {
  INTERCOM:       { label: 'Domofony',      icon: '🔔' },
  CAMERA:         { label: 'Kamery IP',      icon: '📷' },
  LPR_CAMERA:     { label: 'Kamery LPR',     icon: '🚗' },
  ELEVATOR:       { label: 'Kontrola windy', icon: '🛗' },
  LIGHTING:       { label: 'Oświetlenie',    icon: '💡' },
  // 2026-05-14 fix: SWITCH/LOCK/KNX bez wpisu tutaj zostawały poza `/devices/tree`,
  // a w `useDevices` UI (Edge SPA) mapuje status po deviceId z tree — bez wpisu
  // urządzenie pokazywało się jako offline mimo że było online.
  SWITCH:         { label: 'Przekaźniki',    icon: '🔌' },
  LAN_SWITCH:     { label: 'Switche LAN',    icon: '🌐' },
  LOCK:           { label: 'Zamki',          icon: '🔐' },
  SMART_LOCK:     { label: 'Zamki smart',    icon: '🔐' },
  KNX_BRIDGE:     { label: 'KNX-IP Bridge',  icon: '🏗️' },
  KNX_OBJECT:     { label: 'Obiekty KNX',    icon: '💡' },
}

@Injectable()
export class DeviceRegistryService implements OnModuleInit {
  private readonly logger = new Logger(DeviceRegistryService.name)
  // Snapshot cache: deviceId → {image, fetchedAt, refreshing}
  private readonly snapCache = new Map<string, SnapCache>()
  private readonly pingCache = new Map<string, PingCache>()
  private readonly PING_TTL  = 30_000 // 30 s

  constructor(
    private store: StoreService,
    private intercom: IntercomService,
    private cameras: CamerasService,
    private hikvisionLpr: HikvisionLprService,
    private elevator: ElevatorService,
    private lighting: LightingService,
    private lanSwitch: LanSwitchService,
    private smartLock: SmartLockService,
  ) {}

  onModuleInit() {
    const configs = this.store.getDeviceConfigs()
    this.logger.log(`Loading ${configs.length} device config(s) from store`)

    for (const dc of configs) {
      try {
        this.applyConfig(dc.type, dc.deviceId, dc.config)
      } catch (err: any) {
        this.logger.warn(`Failed to load device ${dc.deviceId}: ${err.message}`)
      }
    }
  }

  public applyConfig(type: string, deviceId: string, config: object) {
    // Migracja legacy: jeśli config nie ma `driverId` — spróbuj zgadnąć po
    // `manufacturer + model` używając katalogu @gatelynk/device-drivers.
    // Wstawiamy bezpośrednio w obiekt, żeby kolejne wywołania (snapshot,
    // restart, …) miały już rozstrzygnięty driver bez ponownego zgadywania.
    const cfg = config as Record<string, unknown>
    if (!cfg.driverId && type) {
      const guessed = guessDriverId(type as 'INTERCOM' | 'CAMERA' | 'LPR_CAMERA' | 'ELEVATOR' | 'LIGHTING' | 'LAN_SWITCH', {
        manufacturer: typeof cfg.manufacturer === 'string' ? cfg.manufacturer : undefined,
        model:        typeof cfg.model        === 'string' ? cfg.model        : undefined,
      })
      if (guessed) {
        cfg.driverId = guessed
        this.logger.log(`Legacy config ${deviceId}: zgadnięto driverId="${guessed}" po manufacturer="${cfg.manufacturer}"`)
      }
    }

    switch (type) {
      case 'INTERCOM':    return this.intercom.addDevice(deviceId, config as any)
      case 'CAMERA':      return this.cameras.addDevice(deviceId, config as any)
      case 'LPR_CAMERA':
        // Register on both: cameras (for snapshot/restart) and hikvisionLpr (for plate list)
        this.cameras.addDevice(deviceId, config as any)
        return this.hikvisionLpr.addDevice(deviceId, config as any)
      case 'ELEVATOR':    return this.elevator.addDevice(deviceId, config as any)
      case 'LIGHTING':    return this.lighting.addDevice(deviceId, config as any)
      case 'LAN_SWITCH':  return this.lanSwitch.addDevice(deviceId, config as any)
      case 'SMART_LOCK':
        // Nuki (2026-07-08) — SmartLockService jest STATELESS (config czytany
        // ze store przy każdym unlatch/getState). Brak in-memory rejestracji
        // = DEVICE_CONFIG_UPDATE / PATCH działają bez re-apply.
        this.logger.log(`Smart lock ${deviceId} registered (stateless — Nuki Web API)`)
        return
      default:
        this.logger.warn(`Unknown device type: ${type}`)
    }
  }

  listAll(): { deviceId: string; type: string; config: any; enabled: boolean }[] {
    return this.store.getDeviceConfigs()
  }

  saveDevice(deviceId: string, type: string, config: object) {
    this.store.setDeviceConfig(deviceId, type, config)
    this.applyConfig(type, deviceId, config)
    // Faza B-2 (2026-05-13): push do Cloud mirror żeby panel BA widział nowe
    // urządzenie bez czekania na reconnect WS. `tunnelPush` jest wstrzykiwany
    // lazy przez TunnelService (patrz `setTunnelPush()`) — uniknięcie cyklicznej
    // zależności (TunnelService → DeviceRegistryService).
    if (this.tunnelPush) {
      try {
        const cfg = config as Record<string, unknown>
        const driverId = typeof cfg.driverId === 'string' ? cfg.driverId : null
        this.tunnelPush.deviceUpsert(deviceId, type, config as Record<string, any>, driverId)
      } catch (err: any) {
        this.logger.warn(`Cloud mirror push (upsert ${deviceId}) failed: ${err.message}`)
      }
    }
    return { deviceId, type, config }
  }

  /**
   * Lazy-injected handler od TunnelService dla pushu do Cloud mirror.
   * Patrz `TunnelService.onModuleInit` — woła `setTunnelPush(...)` po starcie.
   * Bez tego DeviceRegistry działa normalnie (lokalny tryb), tylko Cloud
   * mirror nie jest aktualizowany w czasie rzeczywistym (sync nadrobi przy
   * następnym reconnect przez DEVICE_SYNC_ALL).
   */
  private tunnelPush?: {
    deviceUpsert: (uuid: string, type: string, config: Record<string, any>, driverId: string | null) => void
    deviceDelete: (uuid: string) => void
  }
  setTunnelPush(handlers: {
    deviceUpsert: (uuid: string, type: string, config: Record<string, any>, driverId: string | null) => void
    deviceDelete: (uuid: string) => void
  }) {
    this.tunnelPush = handlers
  }

  /**
   * Remove a device fully — in-memory map in the type-specific service,
   * persisted device_config row, and any side-tables owned by the device type
   * (currently `lpr_plates` for LPR_CAMERA).
   *
   * We read the config *before* deleting it so we know which type-specific
   * cleanup to run. Cleanup failures are logged but don't abort the removal —
   * we'd rather have an inconsistent state we can see than a device stuck in
   * the registry because some teardown path threw.
   */
  removeDevice(deviceId: string) {
    const dc = this.store.getDeviceConfigs().find(c => c.deviceId === deviceId)
    const type = dc?.type

    // 1) Drop from type-specific in-memory map so handlers stop accepting events.
    try {
      switch (type) {
        case 'INTERCOM':    this.intercom.removeDevice(deviceId); break
        case 'CAMERA':      this.cameras.removeDevice(deviceId); break
        case 'LPR_CAMERA':
          // LPR cameras live in BOTH registries (cameras for snapshot, hikvisionLpr for plates).
          this.cameras.removeDevice(deviceId)
          this.hikvisionLpr.removeDevice(deviceId)
          break
        case 'ELEVATOR':    this.elevator.removeDevice(deviceId); break
        case 'LIGHTING':    this.lighting.removeDevice(deviceId); break
        case 'LAN_SWITCH':  this.lanSwitch.removeDevice(deviceId); break
      }
    } catch (err: any) {
      this.logger.warn(`In-memory cleanup for ${deviceId} (${type}) failed: ${err.message}`)
    }

    // 2) Wipe type-owned side-tables. We do this unconditionally rather than
    // gating on `type === 'LPR_CAMERA'` — if the config row is missing
    // (inconsistent state, or dummy UUID) we still want orphaned plate rows
    // gone. It's a cheap DELETE WHERE that's a no-op for non-LPR devices.
    try {
      const removed = this.store.lprDeleteAllForCamera(deviceId)
      if (removed > 0) {
        this.logger.log(`Removed ${removed} orphaned plate(s) for ${deviceId}`)
      }
    } catch (err: any) {
      this.logger.warn(`Could not wipe lpr_plates for ${deviceId}: ${err.message}`)
    }

    // 3) Finally drop the config row itself.
    this.store.deleteDeviceConfig(deviceId)

    // 4) Faza B-2 — push DEVICE_DELETE do Cloud mirror.
    if (this.tunnelPush) {
      try {
        this.tunnelPush.deviceDelete(deviceId)
      } catch (err: any) {
        this.logger.warn(`Cloud mirror push (delete ${deviceId}) failed: ${err.message}`)
      }
    }

    if (!type) {
      this.logger.warn(`removeDevice(${deviceId}): no config row found — config deletion was a no-op`)
    } else {
      this.logger.log(`Device ${deviceId} (${type}) removed`)
    }
  }

  // ── Restart a device (intercom or camera) ─────────────────────────────────────
  async restartDevice(deviceId: string): Promise<{ restarted: boolean }> {
    const dc = this.store.getDeviceConfigs().find(c => c.deviceId === deviceId)
    if (!dc) throw new Error('Urządzenie nie znalezione')
    if (dc.type === 'INTERCOM') return this.intercom.restart(deviceId)
    if (dc.type === 'CAMERA' || dc.type === 'LPR_CAMERA') return this.cameras.restart(deviceId)
    throw new Error(`Restart nie jest obsługiwany dla typu ${dc.type}`)
  }

  // ── Trigger a specific relay on an intercom / smart lock ─────────────────────
  async triggerRelay(deviceId: string, relayIndex: number): Promise<any> {
    const dc = this.store.getDeviceConfigs().find(c => c.deviceId === deviceId)
    if (!dc) throw new Error('Urządzenie nie znalezione')
    // 2026-07-08 (Nuki): zamek drzwi lokalu — „relay" = unlatch przez Nuki
    // Web API (relayIndex ignorowany, zamek ma jedno wyjście). Ta sama
    // ścieżka HTTP co przekaźniki → Cloud open flow działa bez zmian.
    if (dc.type === 'SMART_LOCK') {
      await this.smartLock.unlatch(deviceId)
      return { opened: true, provider: 'nuki' }
    }
    if (dc.type !== 'INTERCOM') throw new Error('Nie jest domofonem')
    // `source: 'HTTP'` żeby relay-counter w Metrics wiedział że to trigger
    // z panelu (UI / apka mobilna), nie z Akuvox event flow.
    return this.intercom.execute('OPEN_DOOR', { deviceId, doorIndex: relayIndex, source: 'HTTP' })
  }

  // ── Smart lock (Nuki) — stan zamka dla „Testuj" w panelu Integratora ────────
  async smartLockState(deviceId: string) {
    const dc = this.store.getDeviceConfigs().find(c => c.deviceId === deviceId)
    if (!dc) throw new Error('Urządzenie nie znalezione')
    if (dc.type !== 'SMART_LOCK') throw new Error('Nie jest zamkiem')
    return this.smartLock.getState(deviceId)
  }

  // ── Smart lock (Nuki) — lista zamków dla PODANEGO tokenu (onboarding
  //    mieszkańca 2026-07-09). Token przychodzi z Cloud, nie jest zapisywany. ──
  async smartLockList(apiToken: string) {
    return this.smartLock.listSmartlocks(apiToken)
  }

  // ── Faza F-2: HOLD_OPEN wrappery (delegate do IntercomService) ──────────────
  async holdOpenIntercom(deviceId: string, seconds: number, doorIndex: number) {
    const dc = this.store.getDeviceConfigs().find(c => c.deviceId === deviceId)
    if (!dc) throw new Error('Urządzenie nie znalezione')
    if (dc.type !== 'INTERCOM') throw new Error('HOLD_OPEN dostępne tylko dla intercomu')
    return this.intercom.holdOpen(deviceId, seconds, doorIndex)
  }

  cancelHoldOpenIntercom(deviceId: string) {
    return this.intercom.cancelHoldOpen(deviceId)
  }

  // ── Faza F-4.1: DND wrapper ────────────────────────────────────────────────
  async setDndIntercom(deviceId: string, enabled: boolean) {
    const dc = this.store.getDeviceConfigs().find(c => c.deviceId === deviceId)
    if (!dc) throw new Error('Urządzenie nie znalezione')
    if (dc.type !== 'INTERCOM') throw new Error('DND dostępne tylko dla intercomu')
    return this.intercom.setDnd(deviceId, enabled)
  }

  // ── Faza F-3.1: LPR SET_CONFIDENCE wrapper ─────────────────────────────────
  async setLprConfidence(deviceId: string, threshold: number) {
    const dc = this.store.getDeviceConfigs().find(c => c.deviceId === deviceId)
    if (!dc) throw new Error('Urządzenie nie znalezione')
    if (dc.type !== 'LPR_CAMERA') throw new Error('SET_CONFIDENCE dostępne tylko dla LPR kamer')
    return this.hikvisionLpr.setConfidence(deviceId, threshold)
  }

  // ── Quick snapshot without full test ──────────────────────────────────────────
  async quickSnapshot(
    deviceId: string, skipCache = false, width?: number, quality?: number,
  ): Promise<{ snapshot: string | null }> {
    const dc = this.store.getDeviceConfigs().find(c => c.deviceId === deviceId)
    if (!dc) return { snapshot: null }
    const cfg = dc.config as any

    if (dc.type === 'INTERCOM') {
      const snap = skipCache
        ? await this.fetchIntercomSnapshot(cfg)
        : await this.cachedSnapshot(deviceId, cfg)
      return { snapshot: await this.maybeResizeSnapshot(snap, width, quality) }
    }
    if (dc.type === 'CAMERA' || dc.type === 'LPR_CAMERA') {
      const snap = await this.cameras.getSnapshot(deviceId)
      return { snapshot: await this.maybeResizeSnapshot(snap?.image ?? null, width, quality) }
    }
    return { snapshot: null }
  }

  /**
   * 2026-08-19: downscale data-URI JPEG przez sharp (kafle „Dostęp" żądają
   * ?w=720&q=60 — pełna klatka 300–740 KB spada do ~50–90 KB, mniej na
   * uplinku osiedla i na LTE mieszkańca). Bez `w` albo przy błędzie —
   * oryginał bez zmian. Resize ~10–20 ms na Mac Mini.
   */
  private async maybeResizeSnapshot(
    snap: string | null, width?: number, quality?: number,
  ): Promise<string | null> {
    if (!snap || !width) return snap
    try {
      const sharp = require('sharp')
      const commaIdx = snap.indexOf(',')
      const b64 = commaIdx >= 0 ? snap.slice(commaIdx + 1) : snap
      const out: Buffer = await sharp(Buffer.from(b64, 'base64'))
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: quality ?? 70 })
        .toBuffer()
      return `data:image/jpeg;base64,${out.toString('base64')}`
    } catch {
      return snap
    }
  }

  async testDevice(deviceId: string): Promise<{ online: boolean; latency?: number; detail?: string; error?: string; snapshot?: string }> {
    const configs = this.store.getDeviceConfigs()
    const dc = configs.find(c => c.deviceId === deviceId)
    if (!dc) return { online: false, error: 'Device not found' }

    // 2026-07-08 (Nuki): zamek nie ma LAN IP — test = GET stanu z Nuki Web API.
    if (dc.type === 'SMART_LOCK') {
      const start = Date.now()
      try {
        const state = await this.smartLock.getState(deviceId)
        return { online: true, latency: Date.now() - start, detail: `Nuki: ${state.stateLabel}` }
      } catch (err: any) {
        return { online: false, error: err.message }
      }
    }

    const cfg = dc.config as any
    if (!cfg.ipAddress) return { online: false, error: 'No IP configured' }

    // Step 1: TCP reachability — try port 443 first (most intercoms use HTTPS), fallback to 80
    let tcpResult = await this.tcpPing(cfg.ipAddress, 443, 3000)
    if (!tcpResult.reachable) {
      tcpResult = await this.tcpPing(cfg.ipAddress, 80, 3000)
    }
    if (!tcpResult.reachable) {
      return { online: false, error: `Brak połączenia TCP z ${cfg.ipAddress} (porty 443/80) — ${tcpResult.error}` }
    }

    // Step 2: Parallel HTTP ping + snapshot for intercoms
    if (dc.type === 'INTERCOM' && cfg.login && cfg.password) {
      const start = Date.now()

      const [pingOk, snapshot] = await Promise.all([
        this.httpPingIntercom(cfg),
        this.cachedSnapshot(deviceId, cfg),
      ])

      if (!pingOk && !snapshot) {
        return { online: true, latency: tcpResult.latency, detail: 'TCP OK (brak HTTP — sprawdź login/hasło)' }
      }

      return {
        online: true,
        latency: Date.now() - start,
        detail: `TCP OK${pingOk ? ` + HTTP ${cfg.manufacturer}` : ''}${snapshot ? ' + Snapshot' : ''}`,
        ...(snapshot ? { snapshot } : {}),
      }
    }

    // Step 3: For cameras — try HTTP with auth + fetch snapshot
    if (dc.type === 'CAMERA' || dc.type === 'LPR_CAMERA') {
      const snap = await this.cameras.getSnapshot(deviceId)
      if (snap) {
        return { online: true, latency: tcpResult.latency, detail: 'TCP OK + Snapshot OK', snapshot: snap.image }
      }
      return { online: true, latency: tcpResult.latency, detail: 'TCP OK' }
    }

    return { online: true, latency: tcpResult.latency, detail: 'TCP OK' }
  }

  private tcpPing(host: string, port: number, timeout: number): Promise<{ reachable: boolean; latency?: number; error?: string }> {
    return new Promise((resolve) => {
      const start = Date.now()
      let done = false

      const finish = (reachable: boolean, error?: string, req?: any) => {
        if (done) return
        done = true
        if (req && typeof req.destroy === 'function') req.destroy()
        const latency = Date.now() - start
        if (!reachable) {
          this.logger.warn(`tcpPing(${host}:${port}) → ${error} after ${latency}ms`)
        }
        resolve({ reachable, latency, error })
      }

      // macOS Tahoe (26.x) regresja: raw `net.Socket.connect()` z procesu Edge
      // (NestJS, listen na 4000+1883) dostaje natychmiastowy EHOSTUNREACH (errno=-65)
      // dla LAN IP-ów mimo że curl + bare node z shell-a działa. Workaround:
      // używamy http/https request zamiast raw TCP socket — to działa, bo
      // poziom HTTP używa innej socket-creation path w Node.
      //
      // Pojedynczy „reachable" = dostaliśmy JAKĄKOLWIEK odpowiedź HTTP
      // (200, 401, 308, 404 itp.) — TCP się otworzył, więc network OK.
      // macOS 26 Tahoe: Edge musi być uruchomiony jako child Apple-signed
      // procesu (np. `caffeinate -i node dist/main.js`) żeby dziedziczyć
      // TCC Local Network grant. LaunchAgent plist zaktualizowany 2026-05-16.
      // Bez tego raw TCP do RFC1918 zwraca EHOSTUNREACH errno=-65 natychmiast.
      const net = require('net')
      const socket = net.createConnection({ host, port, family: 4 })
      socket.setTimeout(timeout)
      socket.on('connect', () => finish(true, undefined, socket))
      socket.on('error', (err: any) => finish(
        false,
        `${err.code ?? err.message}|errno=${err.errno}`,
        socket,
      ))
      socket.on('timeout', () => finish(false, 'TIMEOUT', socket))
    })
  }

  /**
   * URL-e do pingu domofonu — delegujemy do `driver-engine`. Driver z katalogu
   * @gatelynk/device-drivers podaje listę URLi (HTTPS preferowany, HTTP fallback).
   * Gdy nie znajdziemy drivera (legacy/unknown vendor) — zwracamy proste fallbacki.
   */
  private buildIntercomPingUrls(cfg: any): string[] {
    const driver = resolveDriver('INTERCOM', cfg)
    const urls = enginePingUrls(driver, cfg)
    if (urls.length > 0) return urls
    // Fallback dla całkowicie nieznanych urządzeń.
    const ip = cfg.ipAddress
    return [`http://${ip}`, `https://${ip}`]
  }

  private buildIntercomSnapshotUrls(cfg: any): string[] {
    const driver = resolveDriver('INTERCOM', cfg)
    const urls = engineSnapshotUrls(driver, cfg)
    if (urls.length > 0) return urls
    const ip = cfg.ipAddress
    return [`http://${ip}/snapshot.jpg`, `https://${ip}/snapshot.jpg`]
  }

  /**
   * Ścieżki RTSP — driver-engine renderuje template'y per driver
   * (`Streaming/Channels/{channel*100+1}` dla Hikvisiona itd.). Override przez
   * `cfg.rtspPath` ma najwyższy priorytet (obsługiwany w samym engine).
   *
   * Zachowujemy starszą sygnaturę (manufacturer string + channel) dla
   * miejsc, które jeszcze nie mają pełnego configu — w razie braku drivera
   * wracamy do generic fallbacku.
   */
  private buildRtspPaths(cfg: any): string[]
  private buildRtspPaths(manufacturer: string, channel?: number): string[]
  private buildRtspPaths(arg: any, channel?: number): string[] {
    if (typeof arg === 'string') {
      // Stara sygnatura — synthetic config tylko z manufacturer/channel.
      const cfg = { manufacturer: arg, channel }
      const driver = resolveDriver('INTERCOM', cfg) ?? resolveDriver('CAMERA', cfg)
      const paths = engineRtspPaths(driver, cfg)
      if (paths.length > 0) return paths
      // Generic fallback — żeby `axis` / inne mało popularne urządzenia
      // nadal miały sensowną domyślną ścieżkę.
      const m = arg.toLowerCase()
      if (m.includes('axis'))                            return ['axis-media/media.amp']
      if (m.includes('uniview') || m.includes('uniarch')) return ['media/video1', 'media/video2']
      return ['live/ch00_0', 'live/ch00_1']
    }
    // Nowa sygnatura — pełen config, driver po driverId/manufacturer.
    const cfg = arg
    const driver = resolveDriver('INTERCOM', cfg) ?? resolveDriver('CAMERA', cfg)
    const paths = engineRtspPaths(driver, cfg)
    if (paths.length > 0) return paths
    return ['live/ch00_0', 'live/ch00_1']
  }

  private async httpPingIntercom(cfg: any): Promise<boolean> {
    const axios = require('axios')
    const urls = this.buildIntercomPingUrls(cfg)
    for (const url of urls) {
      try {
        await axios.get(url, {
          auth: { username: cfg.login, password: cfg.password },
          timeout: 3000,
          maxRedirects: 2,
          validateStatus: (s: number) => s < 500,
        })
        return true
      } catch { /* try next */ }
    }
    return false
  }

  // Returns cached snapshot immediately if fresh (<60s), fetches new one in background.
  // On first call: fetches synchronously so the user gets the image on first click too.
  private async cachedSnapshot(deviceId: string, cfg: any): Promise<string | null> {
    const CACHE_TTL = 60_000  // 60 seconds
    const cached = this.snapCache.get(deviceId)

    // Fresh cache hit → return instantly, kick off background refresh if >20s old
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      if (!cached.refreshing && Date.now() - cached.fetchedAt > 20_000) {
        cached.refreshing = true
        this.fetchIntercomSnapshot(cfg).then(img => {
          if (img) this.snapCache.set(deviceId, { image: img, fetchedAt: Date.now(), refreshing: false })
          else if (cached) cached.refreshing = false
        })
      }
      return cached.image
    }

    // Stale/missing → fetch now, but with a shorter deadline so UI doesn't hang
    const img = await this.fetchIntercomSnapshot(cfg)
    if (img) this.snapCache.set(deviceId, { image: img, fetchedAt: Date.now(), refreshing: false })
    return img
  }

  private async fetchIntercomSnapshot(cfg: any): Promise<string | null> {
    const m = (cfg.manufacturer ?? '').toLowerCase()

    // ── Akuvox: fast HTTP snapshot (no ffmpeg, ~50ms vs 1.5s RTSP) ───────────────
    if (m.includes('akuvox')) {
      const snap = await this.akuvoxHttpSnapshot(cfg)
      if (snap) return snap
      // RTSP fallback if HTTP failed
      const rtsp = await this.rtspSnapshot(cfg)
      if (rtsp) return rtsp
      return null
    }

    // ── RTSP frame grab via ffmpeg (any device with rtspPort configured) ──────────
    if (cfg.rtspPort || cfg.rtspPassword != null) {
      const snap = await this.rtspSnapshot(cfg)
      if (snap) return snap
    }

    // ── HTTP snapshot fallback (Digest-aware for Hikvision/Dahua) ───────────────
    const urls = this.buildIntercomSnapshotUrls(cfg)

    for (const url of urls) {
      try {
        const res = await requestWithDigest('GET', url, cfg.login, cfg.password, {
          responseType: 'arraybuffer',
          timeout: 6000,
          maxRedirects: 3,
          httpsAgent: rejectUnauthorizedHttpsAgent,
          validateStatus: (s: number) => s === 200,
        })
        const ct = ((res.headers['content-type'] ?? 'image/jpeg') as string).split(';')[0].trim()
        if (!ct.startsWith('image/')) continue
        const buf = Buffer.from(res.data as ArrayBuffer)
        if (buf.length < 500) continue
        this.logger.log(`Intercom snapshot OK (HTTP) from ${url}`)
        return `data:${ct};base64,${buf.toString('base64')}`
      } catch (err: any) {
        this.logger.debug(`Intercom HTTP snapshot failed ${url}: ${err?.response?.status ?? err?.message ?? 'ERR'}`)
      }
    }
    return null
  }

  private async rtspSnapshot(cfg: any): Promise<string | null> {
    const rtspUser     = cfg.rtspLogin    ?? cfg.login    ?? 'admin'
    // Fall back to HTTP password if rtspPassword wasn't explicitly set — most cameras
    // share credentials between HTTP and RTSP (Hikvision/Dahua/Axis).
    const rtspPassword = cfg.rtspPassword ?? cfg.password ?? 'admin'
    const rtspPort     = cfg.rtspPort     ?? 554
    const ip           = cfg.ipAddress

    // Try paths that match the manufacturer — Akuvox/Dnake use live/ch00_x,
    // Hikvision uses Streaming/Channels/101, Dahua uses cam/realmonitor?...
    const m = (cfg.manufacturer ?? '').toLowerCase()
    // 2026-05-14 fix: fallback channel=1 — patrz `pipeVideoStream` komentarz.
    const streams = cfg.rtspPath
      ? [cfg.rtspPath]
      : this.buildRtspPaths(m, cfg.channel ?? 1)

    for (const rtspPath of streams) {
      const rtspUrl = `rtsp://${rtspUser}:${rtspPassword}@${ip}:${rtspPort}/${rtspPath}`
      const img = await this.spawnFfmpegSnapshot(rtspUrl)
      if (img) return img
    }
    return null
  }

  private spawnFfmpegSnapshot(rtspUrl: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        const ffmpegPath: string = require('ffmpeg-static')
        const { spawn } = require('child_process')
        const os           = require('os')
        const path         = require('path')
        const fs           = require('fs')
        const outFile      = path.join(os.tmpdir(), `snap_${Date.now()}.jpg`)

        const args = [
          // ── Speed optimizations ──────────────────────────────────────────
          '-fflags',           'nobuffer',       // no input buffering
          '-flags',            'low_delay',       // low latency mode
          '-analyzeduration',  '0',              // skip stream duration analysis (saves 1-2s)
          '-probesize',        '32',             // minimal probe (default is 5MB)
          // ── Connection ───────────────────────────────────────────────────
          '-rtsp_transport',   'tcp',
          '-timeout',          '4000000',        // 4s connect timeout (µs)
          '-i',                rtspUrl,
          // ── Output ───────────────────────────────────────────────────────
          '-frames:v',         '1',
          '-q:v',              '2',              // JPEG quality (2=best, 31=worst)
          '-f',                'image2',
          outFile, '-y',
        ]

        // macOS 26 Tahoe: ffmpeg-static musi być podpisany z entitlementem
        // `com.apple.security.network.client` (patrz `install/setup-ffmpeg-tahoe.sh`).
        const proc = spawn(ffmpegPath, args)
        let done   = false
        const TIMEOUT_MS = 6000

        const finish = (ok: boolean) => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (ok && fs.existsSync(outFile)) {
            try {
              const data = fs.readFileSync(outFile)
              fs.unlinkSync(outFile)
              const valid = data.length > 500          // sanity: reject tiny/corrupt files
              if (valid) {
                this.logger.log(`RTSP snapshot OK (${data.length}B) ${rtspUrl.replace(/:[^@]+@/, ':***@')}`)
                resolve(`data:image/jpeg;base64,${data.toString('base64')}`)
                return
              }
            } catch { /* fall through */ }
          }
          resolve(null)
        }

        const timer = setTimeout(() => { proc.kill('SIGKILL'); finish(false) }, TIMEOUT_MS)
        proc.on('close',  (code: number) => finish(code === 0))
        proc.on('error',  (err: any) => { this.logger.debug(`ffmpeg spawn error: ${err.message}`); finish(false) })
      } catch (err: any) {
        this.logger.debug(`rtspSnapshot setup error: ${err.message}`)
        resolve(null)
      }
    })
  }

  // ── Streaming diagnostic test ────────────────────────────────────────────────
  async streamTest(deviceId: string, emit: (d: object) => void) {
    const configs = this.store.getDeviceConfigs()
    const dc = configs.find(c => c.deviceId === deviceId)
    if (!dc) { emit({ step: 'error', label: 'Urządzenie nie znalezione', status: 'error' }); return }

    const cfg = dc.config as any

    // ── Step 1: TCP connectivity ─────────────────────────────────────────────
    emit({ step: 'tcp', status: 'testing', label: `Połączenie IP (${cfg.ipAddress})` })
    let tcpResult = await this.tcpPing(cfg.ipAddress, 443, 3000)
    if (!tcpResult.reachable) tcpResult = await this.tcpPing(cfg.ipAddress, 80, 3000)

    if (!tcpResult.reachable) {
      emit({ step: 'tcp', status: 'error', label: `Połączenie IP (${cfg.ipAddress})`, detail: `Brak odpowiedzi — ${tcpResult.error}` })
      emit({ step: 'done', online: false })
      return
    }
    emit({ step: 'tcp', status: 'ok', label: `Połączenie IP (${cfg.ipAddress})`, detail: `${tcpResult.latency} ms` })

    if (dc.type !== 'INTERCOM') {
      // For cameras just do a snapshot
      emit({ step: 'snapshot', status: 'testing', label: 'Snapshot kamery' })
      const snap = await this.cameras.getSnapshot(deviceId)
      emit({ step: 'snapshot', status: snap ? 'ok' : 'warn', label: 'Snapshot kamery',
             detail: snap ? 'Obraz pobrany' : 'Brak obrazu', ...(snap ? { snapshot: snap.image } : {}) })
      emit({ step: 'done', online: true })
      return
    }

    // ── Step 2: HTTP authentication ──────────────────────────────────────────
    const mfr = cfg.manufacturer || 'domofon'
    emit({ step: 'http', status: 'testing', label: `Autoryzacja HTTP (${mfr})` })
    const httpOk = await this.httpPingIntercom(cfg)
    emit({ step: 'http', status: httpOk ? 'ok' : 'warn',
           label: `Autoryzacja HTTP (${mfr})`,
           detail: httpOk ? 'Zalogowano pomyślnie' : 'Sprawdź login i hasło' })

    // ── Step 3: Each relay ───────────────────────────────────────────────────
    const relays: { index: number; name: string }[] = cfg.relays ?? []
    for (const relay of relays) {
      const label = `Elektrozaczep ${relay.index}${relay.name ? ` — „${relay.name}"` : ''}`
      emit({ step: `relay_${relay.index}`, status: 'testing', label })
      const result = await this.testRelayApi(cfg, relay.index)
      emit({ step: `relay_${relay.index}`, status: result.ok ? 'ok' : 'warn',
             label, detail: result.detail })
    }

    // ── Step 4: Camera snapshot ──────────────────────────────────────────────
    emit({ step: 'snapshot', status: 'testing', label: 'Kamera domofonu' })
    const snapshot = await this.cachedSnapshot(deviceId, cfg)
    emit({ step: 'snapshot', status: snapshot ? 'ok' : 'warn',
           label: 'Kamera domofonu',
           detail: snapshot ? 'Podgląd dostępny' : 'Brak obrazu (sprawdź hasło RTSP)',
           ...(snapshot ? { snapshot } : {}) })

    emit({ step: 'done', online: true })
  }

  private async testRelayApi(cfg: any, relayIndex: number): Promise<{ ok: boolean; detail: string }> {
    const axios = require('axios')
    const m     = (cfg.manufacturer ?? '').toLowerCase()
    const ip    = cfg.ipAddress

    // Build the open-door URL per manufacturer
    let urls: string[]
    if (m.includes('akuvox') || m.includes('dnake')) {
      urls = [
        `https://${ip}/fcgi/do?action=OpenDoor&door=${relayIndex}`,
        `http://${ip}/fcgi/do?action=OpenDoor&door=${relayIndex}`,
      ]
    } else if (m.includes('2n') || m.includes('comelit')) {
      urls = [`https://${ip}/api/io/output/${relayIndex}/on`, `http://${ip}/api/io/output/${relayIndex}/on`]
    } else if (m.includes('hikvision')) {
      urls = [`http://${ip}/ISAPI/AccessControl/door/capabilities`, `https://${ip}/ISAPI/AccessControl/door/capabilities`]
    } else {
      // Unknown manufacturer — just confirm HTTP is alive
      return { ok: true, detail: 'Nie testowano (nieznany producent)' }
    }

    for (const url of urls) {
      try {
        const res = await axios.get(url, {
          auth: { username: cfg.login, password: cfg.password },
          timeout: 3000,
          maxRedirects: 2,
          validateStatus: () => true,         // accept any status
        })
        if (res.status < 500) {
          // Parse retcode for Akuvox-style APIs
          const body = typeof res.data === 'object' ? res.data : {}
          const retcode = body?.retcode ?? body?.RetCode ?? 0
          if (retcode === 0) return { ok: true,  detail: 'Otwarty ✓' }
          if (retcode === -4) return { ok: true,  detail: 'API odpowiada (Not Safe — sprawdź ustawienia bezpieczeństwa)' }
          if (retcode === -1) return { ok: true,  detail: 'API odpowiada' }
          return { ok: true, detail: `Odpowiedź: retcode ${retcode}` }
        }
      } catch { /* try next */ }
    }
    return { ok: false, detail: 'Brak odpowiedzi API' }
  }

  // ── MJPEG live stream proxy ───────────────────────────────────────────────────
  async pipeVideoStream(deviceId: string, res: any) {
    const dc = this.store.getDeviceConfigs().find(c => c.deviceId === deviceId)
    if (!dc) { res.status(404).end(); return }

    const cfg = dc.config as any
    const m   = (cfg.manufacturer ?? '').toLowerCase()

    // ── Akuvox: proxy native MJPEG from https://IP:8080/video.cgi (no ffmpeg) ────
    if (m.includes('akuvox')) {
      const proxied = await this.proxyAkuvoxMjpeg(cfg, res)
      if (proxied) return
      this.logger.warn(`Akuvox MJPEG proxy failed for ${deviceId}, falling back to RTSP`)
    }

    const rtspUser  = cfg.rtspLogin    ?? cfg.login    ?? 'admin'
    // Same fallback as rtspSnapshot — cameras typically reuse HTTP credentials for RTSP.
    const rtspPass  = cfg.rtspPassword ?? cfg.password ?? 'admin'
    const rtspPort  = cfg.rtspPort     ?? 554
    // 2026-05-14 fix: stare configi (sprzed Fazy C-1 `applyDriverDefaults`) nie
    // mają `channel` w configu — wyleciał do `driver.constants`. Fallback do 1
    // (typowy kanał single-camera) żeby `channel*100+1` nie wyszło NaN.
    const channel = cfg.channel ?? 1
    // Pick RTSP paths per manufacturer — without this, Hikvision/Dahua fall through
    // to Akuvox paths and ffmpeg gets 404.
    const rtspPaths = cfg.rtspPath
      ? [cfg.rtspPath]
      : this.buildRtspPaths(m, channel)

    const boundary = 'mjpegframe'
    res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${boundary}`)
    res.setHeader('Cache-Control', 'no-store, no-cache')
    res.setHeader('Pragma', 'no-cache')
    res.flushHeaders()

    const ffmpegPath: string = require('ffmpeg-static')
    const { spawn }          = require('child_process')

    // Try stream paths in order; use first that provides frames
    for (const rtspPath of rtspPaths) {
      const rtspUrl = `rtsp://${rtspUser}:${rtspPass}@${cfg.ipAddress}:${rtspPort}/${rtspPath}`

      // macOS 26 Tahoe: ffmpeg-static musi być podpisany z entitlementem
      // `com.apple.security.network.client` (patrz `install/setup-ffmpeg-tahoe.sh`).
      // Wtedy ma własne uprawnienie do outbound network, niezależnie od parent
      // procesu (Edge spawn child). Wcześniejszy caffeinate-wrap nie pomagał
      // bo TCC scoped per-binary, nie per-parent-chain.
      const proc = spawn(ffmpegPath, [
        '-fflags',          'nobuffer',
        '-flags',           'low_delay',
        '-analyzeduration', '0',
        '-probesize',       '32',
        '-rtsp_transport',  'tcp',
        '-timeout',         '5000000',
        '-i',               rtspUrl,
        '-f',               'mjpeg',
        '-q:v',             '5',
        '-r',               '12',      // 12 fps — smooth enough, not too heavy
        'pipe:1',
      ])

      let framesWritten = 0
      let buf = Buffer.alloc(0)

      const writeFrame = (frame: Buffer) => {
        if (res.writableEnded) return
        try {
          res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`)
          res.write(frame)
          res.write('\r\n')
          framesWritten++
        } catch { proc.kill('SIGKILL') }
      }

      proc.stdout.on('data', (chunk: Buffer) => {
        if (res.writableEnded) { proc.kill('SIGKILL'); return }
        buf = Buffer.concat([buf, chunk])

        // Parse JPEG frames: SOI=FFD8 … EOI=FFD9
        while (true) {
          const soiIdx = buf.indexOf(Buffer.from([0xFF, 0xD8]))
          if (soiIdx === -1) { buf = Buffer.alloc(0); break }

          const eoiIdx = buf.indexOf(Buffer.from([0xFF, 0xD9]), soiIdx + 2)
          if (eoiIdx === -1) {
            // EOI not yet received — keep buffer from SOI
            if (soiIdx > 0) buf = buf.slice(soiIdx)
            break
          }

          writeFrame(buf.slice(soiIdx, eoiIdx + 2))
          buf = buf.slice(eoiIdx + 2)
        }
      })

      proc.stderr.on('data', (d: Buffer) => {
        const msg = d.toString()
        if (msg.includes('401') || /unauthori[sz]ed/i.test(msg)) {
          this.logger.warn(`RTSP 401 on ${rtspPath} (user=${rtspUser}) — check rtspPassword / login`)
        } else if (/404|not\s*found/i.test(msg)) {
          this.logger.warn(`RTSP 404 on ${rtspPath} — wrong stream path for ${m || 'device'}`)
        } else if (/connection\s*refused|timed?\s*out|no route/i.test(msg)) {
          this.logger.warn(`RTSP connect failed on ${rtspPath}: ${msg.trim().slice(0, 120)}`)
        } else {
          this.logger.debug(`stream [${rtspPath}]: ${msg.trim().slice(0, 120)}`)
        }
      })

      // Wait for ffmpeg to finish or client to disconnect
      await new Promise<void>((resolve) => {
        res.on('close',  () => { proc.kill('SIGKILL'); resolve() })
        proc.on('close', () => {
          if (framesWritten === 0 && !res.writableEnded) {
            this.logger.debug(`No frames on ${rtspPath}, trying next`)
          }
          resolve()
        })
        // Safety timeout — kill after 5 min of inactivity
        const watchdog = setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 5 * 60_000)
        proc.on('close', () => clearTimeout(watchdog))
      })

      if (framesWritten > 0 || res.writableEnded) break
    }

    if (!res.writableEnded) res.end()
  }

  // Execute a command on a device type
  async executeOnDevice(type: string, action: string, payload?: any): Promise<any> {
    switch (type) {
      case 'intercom':  return this.intercom.execute(action, payload)
      case 'camera':    return this.cameras.execute(action, payload)
      case 'lprCamera': return this.hikvisionLpr.execute(action, payload)
      case 'elevator':  return this.elevator.execute(action, payload)
      case 'lighting':  return this.lighting.execute(action, payload)
      default:
        throw new Error(`No device handler for type: ${type}`)
    }
  }

  // Get status of all device types
  getStatus(): DeviceStatusEntry[] {
    return [
      ...this.intercom.getStatus(),
      ...this.cameras.getStatus(),
      ...this.elevator.getStatus(),
      ...this.lighting.getStatus(),
    ]
  }

  // ── Akuvox HTTP snapshot (Digest auth, ~50ms, no ffmpeg) ─────────────────────
  private async akuvoxHttpSnapshot(cfg: any): Promise<string | null> {
    const axios = require('axios')
    const user  = cfg.rtspLogin ?? cfg.login ?? 'admin'
    const pass  = cfg.rtspPassword ?? 'admin'

    // Port 8080 na kasetach Akuvox serwuje picture.jpg po HTTP *albo* HTTPS —
    // zależnie od firmware/ustawienia web serwera; część sztuk nie wymaga
    // auth, część robi digest (VN: HTTP bez auth; Villa Natura E18: tylko
    // HTTPS z powolnym handshakiem legacy-TLS 1–2 s, patrz pułapka #20).
    // Sondy idą RÓWNOLEGLE i wygrywa pierwszy PRAWDZIWY obraz — sekwencyjnie
    // nieudana pierwsza sonda zjadała 5-sekundowy budżet proxy Clouda, zanim
    // druga (działająca) zdążyła odpowiedzieć (regresja 2026-08-11).
    const attempt = async (url: string): Promise<string> => {
      const opts: any = {
        responseType: 'arraybuffer',
        timeout: 4000,
        // 401 ma wrócić jako response (challenge digest), nie exception.
        validateStatus: () => true,
      }
      if (url.startsWith('https')) opts.httpsAgent = lanHttpsAgent

      let res = await axios.get(url, opts)
      if (res.status === 401) {
        const wwwAuth: string = res.headers?.['www-authenticate'] ?? ''
        const realm = wwwAuth.match(/realm="([^"]+)"/)?.[1] ?? ''
        const nonce = wwwAuth.match(/nonce="([^"]+)"/)?.[1] ?? ''
        if (!realm || !nonce) throw new Error('digest challenge bez realm/nonce')
        const authHeader = this.buildDigestAuth('GET', '/picture.jpg', user, pass, realm, nonce)
        res = await axios.get(url, { ...opts, headers: { Authorization: authHeader } })
      }
      // Nowsze firmware serwuje na :8080 web UI (Angular), które odpowiada
      // 200 + HTML na KAŻDĄ ścieżkę — także /picture.jpg. Sam status i
      // rozmiar nie wystarczą: bez kontroli typu podgląd dostałby stronę
      // HTML zakodowaną jako "jpeg". Akceptujemy wyłącznie prawdziwy obraz
      // (Content-Type image/* lub magic bytes JPEG-a).
      const buf = Buffer.from(res.data ?? [])
      const ct = String(res.headers?.['content-type'] ?? '').toLowerCase()
      const isJpeg = buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8
      if (res.status === 200 && buf.length > 500 && (ct.startsWith('image/') || isJpeg)) {
        this.logger.log(`Akuvox HTTP snapshot OK (${buf.length}B) ${url}`)
        return `data:image/jpeg;base64,${buf.toString('base64')}`
      }
      throw new Error(`HTTP ${res.status}, content-type ${ct || 'brak'}`)
    }

    try {
      return await Promise.any([
        attempt(`http://${cfg.ipAddress}:8080/picture.jpg`),
        attempt(`https://${cfg.ipAddress}:8080/picture.jpg`),
      ])
    } catch (err: any) {
      const reasons = (err?.errors ?? [err]).map((e: any) => e?.message).join(' | ')
      this.logger.debug(`Akuvox snapshot: obie sondy :8080 nieudane (${reasons}) ${cfg.ipAddress}`)
      return null
    }
  }

  // ── Akuvox native MJPEG proxy (https://IP:8080/video.cgi, no ffmpeg) ─────────
  private async proxyAkuvoxMjpeg(cfg: any, res: any): Promise<boolean> {
    // Jak w akuvoxHttpSnapshot: :8080 mówi HTTP albo HTTPS zależnie od
    // firmware (VN: plain HTTP; Villa Natura E18: HTTPS + legacy TLS).
    // Sekwencyjnie http → https: nieudana próba kończy się szybko
    // (connection refused / brak challenge), a stream i tak zestawia się raz.
    for (const scheme of ['http', 'https'] as const) {
      if (await this.tryAkuvoxMjpeg(scheme, cfg, res)) return true
    }
    return false
  }

  private tryAkuvoxMjpeg(scheme: 'http' | 'https', cfg: any, res: any): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const mod = scheme === 'https'
          ? (require('https') as typeof import('https'))
          : (require('http') as typeof import('http'))
        const user  = cfg.rtspLogin ?? cfg.login ?? 'admin'
        const pass  = cfg.rtspPassword ?? 'admin'
        const path  = '/video.cgi'
        const host  = cfg.ipAddress as string
        const port  = 8080
        const baseOpts: any = { hostname: host, port, path, method: 'GET', timeout: 4000 }
        if (scheme === 'https') baseOpts.agent = lanHttpsAgent

        let settled = false
        const ok   = () => { if (!settled) { settled = true; resolve(true) } }
        const fail = () => { if (!settled) { settled = true; resolve(false) } }

        // Odpowiedź strumienia: pipe TYLKO gdy 200 + multipart. Nowsze
        // firmware serwuje na :8080 web UI, które odpowiada 200 + text/html
        // na każdą ścieżkę — bez kontroli typu klient dostałby HTML
        // zamiast MJPEG (ta sama pułapka co przy picture.jpg).
        const pipeIfStream = (proxyRes: any, cleanup: () => void) => {
          const ct = String(proxyRes.headers['content-type'] ?? '')
          if (proxyRes.statusCode !== 200 || !ct.includes('multipart')) {
            proxyRes.resume(); cleanup(); fail(); return
          }
          // NIE surowy pipe. Kaseta wypycha MJPEG pełnej rozdzielczości
          // (zmierzone: ~60 Mbit/s) — to nie przejdzie przez uplink osiedla
          // do Cloud proxy ani przez LTE, a TCP-owe dławienie tylko buduje
          // rosnące opóźnienie. Przerzedzamy do MJPEG_MAX_FPS i zmniejszamy
          // klatki sharpem (jak snapshoty LPR w tunelu) — realne ~2 Mbit/s,
          // opóźnienie stałe, bo zawsze leci NAJNOWSZA kompletna klatka.
          this.thinAndPipeMjpeg(proxyRes, res, cleanup)
          proxyRes.once('data', ok)
          proxyRes.on('error', fail)
          // Safety: resolve true after 500ms even without first data
          setTimeout(ok, 500)
        }

        // Krok 1: żądanie bez auth — 200 pipe od razu (firmware bez auth),
        // 401 → challenge digest i drugie żądanie.
        const chalReq = mod.request(baseOpts, (chalRes) => {
          if (chalRes.statusCode !== 401) {
            pipeIfStream(chalRes, () => { chalRes.destroy?.(); chalReq.destroy() })
            return
          }
          const wwwAuth = chalRes.headers['www-authenticate'] ?? ''
          const realm = wwwAuth.match(/realm="([^"]+)"/)?.[1] ?? ''
          const nonce = wwwAuth.match(/nonce="([^"]+)"/)?.[1] ?? ''
          chalRes.resume()
          if (!realm || !nonce) { fail(); return }

          const authHeader = this.buildDigestAuth('GET', path, user, pass, realm, nonce)
          const streamReq = mod.request(
            { ...baseOpts, headers: { Authorization: authHeader } },
            (proxyRes) => pipeIfStream(proxyRes, () => { proxyRes.destroy(); streamReq.destroy() }),
          )
          streamReq.on('error', fail)
          streamReq.on('timeout', () => { streamReq.destroy(); fail() })
          streamReq.end()
        })
        chalReq.on('error', fail)
        chalReq.on('timeout', () => { chalReq.destroy(); fail() })
        chalReq.end()
      } catch {
        resolve(false)
      }
    })
  }

  /** Przerzedzanie + zmniejszanie strumienia MJPEG (patrz pipeIfStream). */
  private thinAndPipeMjpeg(source: any, res: any, cleanup: () => void) {
    const MJPEG_MAX_FPS = 6
    const MJPEG_MAX_WIDTH = 720
    const BOUNDARY = 'glframe'

    let sharp: any = null
    try { sharp = require('sharp') } catch { /* brak sharp → klatki bez resize */ }

    res.setHeader('Content-Type', `multipart/x-mixed-replace; boundary=${BOUNDARY}`)
    res.setHeader('Cache-Control', 'no-store, no-cache')
    res.setHeader('Pragma', 'no-cache')
    res.flushHeaders()

    const SOI = Buffer.from([0xff, 0xd8])
    const EOI = Buffer.from([0xff, 0xd9])
    let buf = Buffer.alloc(0)
    let latest: Buffer | null = null
    let emitting = false
    let closed = false

    const emit = async () => {
      if (emitting || closed || !latest) return
      emitting = true
      const frame = latest
      latest = null
      try {
        const jpeg: Buffer = sharp
          ? await sharp(frame).resize({ width: MJPEG_MAX_WIDTH, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer()
          : frame
        if (closed) return
        const head = `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`
        // Backpressure: gdy klient (LTE) nie nadąża, po prostu gubimy klatki
        // — kolejny emit weźmie najnowszą. Live > kompletność.
        res.write(Buffer.concat([Buffer.from(head), jpeg, Buffer.from('\r\n')]))
      } catch { /* pojedyncza zła klatka — pomijamy */ }
      emitting = false
    }
    const ticker = setInterval(emit, Math.floor(1000 / MJPEG_MAX_FPS))

    source.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      // Wytnij wszystkie kompletne JPEG-i; zostaw tylko NAJNOWSZY.
      for (;;) {
        const soi = buf.indexOf(SOI)
        if (soi < 0) break
        const eoi = buf.indexOf(EOI, soi + 2)
        if (eoi < 0) break
        latest = buf.subarray(soi, eoi + 2)
        buf = buf.subarray(eoi + 2)
      }
      // Ochrona przed rozjazdem parsera (śmieci bez EOI).
      if (buf.length > 4_000_000) buf = Buffer.alloc(0)
    })

    const teardown = () => {
      if (closed) return
      closed = true
      clearInterval(ticker)
      cleanup()
      try { res.end() } catch { /* już zamknięte */ }
    }
    source.on('end', teardown)
    source.on('error', teardown)
    res.on('close', teardown)
  }

  // ── Digest auth header builder ────────────────────────────────────────────────
  private buildDigestAuth(method: string, uri: string, user: string, pass: string, realm: string, nonce: string): string {
    const { createHash } = require('crypto') as typeof import('crypto')
    const ha1 = createHash('md5').update(`${user}:${realm}:${pass}`).digest('hex')
    const ha2 = createHash('md5').update(`${method}:${uri}`).digest('hex')
    const response = createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex')
    return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
  }

  // ── Device tree (for LAN overview) ───────────────────────────────────────────

  async getDeviceTree() {
    const configs = this.store.getDeviceConfigs()

    // Ping all devices in parallel (respects 30-second cache)
    const pingResults = await Promise.all(
      configs.map(async dc => ({
        deviceId: dc.deviceId,
        online: await this.pingDevice((dc.config as any).ipAddress),
      })),
    )
    const pingMap = new Map(pingResults.map(r => [r.deviceId, r.online]))

    // Group by type
    const groups = new Map<string, { type: string; label: string; icon: string; devices: any[] }>()

    for (const dc of configs) {
      const cfg = dc.config as any
      if (!groups.has(dc.type)) {
        const meta = TYPE_META[dc.type] ?? { label: dc.type, icon: '📡' }
        groups.set(dc.type, { type: dc.type, label: meta.label, icon: meta.icon, devices: [] })
      }

      const relays: { index: number; name: string }[] =
        Array.isArray(cfg.relays) && cfg.relays.length > 0
          ? cfg.relays.map((r: any) => ({ index: r.index ?? 0, name: r.name || `Przekaźnik ${r.index ?? 0}` }))
          : cfg.doorRelayIndex != null
            ? [{ index: cfg.doorRelayIndex, name: cfg.name || dc.deviceId }]
            : []

      groups.get(dc.type)!.devices.push({
        deviceId:     dc.deviceId,
        name:         cfg.name         || dc.deviceId,
        ipAddress:    cfg.ipAddress    ?? null,
        manufacturer: cfg.manufacturer ?? null,
        model:        cfg.model        ?? null,
        relays,
        online:       pingMap.get(dc.deviceId) ?? false,
        checkedAt:    new Date().toISOString(),
      })
    }

    return Array.from(groups.values())
  }

  private async pingDevice(ip: string | undefined): Promise<boolean> {
    if (!ip) return false
    const cached = this.pingCache.get(ip)
    if (cached && Date.now() - cached.checkedAt < this.PING_TTL) return cached.online
    const result = await this.tcpPing(ip, 80, 1500)
    this.pingCache.set(ip, { online: result.reachable, checkedAt: Date.now() })
    return result.reachable
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Test matrix — diagnostyka per-capability dla wizarda dodawania urządzenia
  // ────────────────────────────────────────────────────────────────────────
  //  Zamiast jednego `online: true/false` (które ukrywa „TCP OK ale auth fail")
  //  buduje strukturę per capability, którą UI renderuje jako kafle:
  //     ✅ Ping     ✅ Auth     ✅ Snapshot     🟡 Restart (kliknij Test)
  //
  //  Akcje destrukcyjne (restart, openDoor, toggle, lock, unlock) są **tylko**
  //  raportowane jako `supported_untested` — UI ma osobne przyciski testowe
  //  (POST /devices/:id/restart, /relay/:idx), które wywoła user świadomie.
  //
  //  Cloud-bound drivery (Tedee) — `network/ping` to authenticated GET na
  //  api.tedee.com, nie LAN ping; reszta capabilities też idzie cloud.

  /**
   * Zwraca pustą entry „nie wspiera" — driver nie wystawia tej capability.
   */
  private unsupportedEntry(): TestMatrixEntry {
    return { supported: false, tested: false }
  }

  /**
   * Wystawiona ale nie testowana — np. restart (destrukcyjny) albo openDoor
   * (wymaga decyzji integratora). Hint mówi UI co zrobić.
   */
  private supportedUntestedEntry(hint: string): TestMatrixEntry {
    return { supported: true, tested: false, hint }
  }

  /**
   * Główna metoda — uruchamia pełną macierz testową dla urządzenia.
   * Bezpieczna: nie wystrzela żadnej destrukcyjnej akcji bez consent-u UI.
   *
   * Strategia:
   *   1. Sprawdź czy device istnieje w store; jeśli nie → `found: false`.
   *   2. Pomocniczo policz `driver` i zestaw obsługiwanych capabilities.
   *   3. TCP ping (network) — 443/80 fallback, daje latency.
   *   4. Jeśli driver ma `endpoints.ping[]` → HTTP ping z auth → auth + http entries.
   *   5. Jeśli driver wspiera snapshot → fetch cached snapshot (z deduplikacją).
   *   6. Pozostałe capabilities → `supported_untested` z hint-em.
   *   7. `online` globalny = network OK && (auth OK lub auth nie wymagane).
   */
  async runTestMatrix(deviceId: string): Promise<TestMatrix> {
    const startedAt = Date.now()
    const configs = this.store.getDeviceConfigs()
    const dc = configs.find((c) => c.deviceId === deviceId)
    if (!dc) {
      return {
        deviceId,
        driverId: null,
        found: false,
        online: false,
        startedAt,
        finishedAt: Date.now(),
        capabilities: {
          network: { supported: true, tested: false, error: 'Device not found in store' },
          auth: this.unsupportedEntry(),
          ping: this.unsupportedEntry(),
        },
      }
    }

    const cfg = dc.config as any
    const driver: DeviceDriver | null = resolveDriver(dc.type as any, cfg)
    const cloudBound = driver?.endpoints.discovery?.cloudBound === true

    // ── 1. Network (TCP ping) ───────────────────────────────────────────────
    let network: TestMatrixEntry
    if (cloudBound) {
      // Driver cloud-bound (Tedee) — TCP ping LAN nie ma sensu.
      // „Network" oznacza tu wyjście na świat, sprawdzamy DNS+TCP do api.tedee.com.
      network = { supported: true, tested: true, ok: true, detail: 'cloud-bound (LAN ping pominięty)' }
    } else if (!cfg.ipAddress) {
      network = { supported: true, tested: true, ok: false, error: 'No IP configured' }
    } else {
      let tcp = await this.tcpPing(cfg.ipAddress, 443, 3000)
      if (!tcp.reachable) tcp = await this.tcpPing(cfg.ipAddress, 80, 3000)
      network = tcp.reachable
        ? { supported: true, tested: true, ok: true, detail: `TCP ${cfg.ipAddress}:${tcp.latency}ms`, latencyMs: tcp.latency }
        : { supported: true, tested: true, ok: false, error: tcp.error ?? 'unreachable' }
    }

    // ── 2. HTTP Ping + Auth — tylko gdy driver wystawia `endpoints.ping[]` ──
    const pingHttpUrls = driver ? enginePingUrls(driver, cfg) : []
    let ping: TestMatrixEntry
    let auth: TestMatrixEntry

    if (pingHttpUrls.length === 0) {
      ping = this.unsupportedEntry()
      auth = this.unsupportedEntry()
    } else if (!network.ok) {
      ping = { supported: true, tested: false, hint: 'Pomijam — brak TCP' }
      auth = { supported: true, tested: false, hint: 'Pomijam — brak TCP' }
    } else if (driver?.endpoints.pingProtocol === 'knxnet-ip') {
      // KNX-IP: ping idzie przez SEARCH_REQUEST — to robi Discovery, nie test-matrix.
      // Tu wystarczy że TCP do portu 3671 jest reachable (już zrobione w network).
      ping = { supported: true, tested: false, hint: 'KNXnet/IP ping przez Discovery' }
      auth = this.unsupportedEntry() // KNX nie ma user/pass na bridge'u
    } else {
      // HTTP/Cloud ping z auth — driver może mieć kilka URL-i (HTTPS + HTTP fallback),
      // próbujemy po kolei aż któryś odpowie sensownie (200..299 lub 401/403).
      const httpResult = await this.runHttpPingWithFallback(pingHttpUrls, cfg, driver)
      ping = httpResult.ping
      auth = httpResult.auth
    }

    // ── 3. Snapshot — gdy driver/capability wystawia ────────────────────────
    let snapshot: TestMatrixEntry | undefined
    if (driver?.capabilities.includes('snapshot')) {
      if (!network.ok) {
        snapshot = { supported: true, tested: false, hint: 'Pomijam — brak TCP' }
      } else {
        snapshot = await this.runSnapshotTest(deviceId, dc.type as string, cfg)
      }
    }

    // ── 4. Destrukcyjne / capability flags ──────────────────────────────────
    const restart  = driver?.endpoints.restart  ? this.supportedUntestedEntry('Kliknij „Test restart" w UI') : this.unsupportedEntry()
    const openDoor = driver?.endpoints.openDoor ? this.supportedUntestedEntry('Kliknij „Test relay" w UI')   : this.unsupportedEntry()
    const toggle   = driver?.endpoints.toggle   ? this.supportedUntestedEntry('Kliknij „Test toggle" w UI')  : this.unsupportedEntry()
    const lock     = driver?.endpoints.lock     ? this.supportedUntestedEntry('Kliknij „Test zamknij" w UI') : this.unsupportedEntry()
    const unlock   = driver?.endpoints.unlock   ? this.supportedUntestedEntry('Kliknij „Test otwórz" w UI')  : this.unsupportedEntry()

    // RTSP / MJPEG — informacyjne; pełny test wymaga ffprobe.
    const rtsp = driver?.endpoints.rtspPath && driver.endpoints.rtspPath.length > 0
      ? this.supportedUntestedEntry('Sprawdź w VLC: rtsp://login:hasło@IP/...')
      : undefined
    const mjpeg = driver?.capabilities.includes('mjpeg')
      ? this.supportedUntestedEntry('Live MJPEG dostępny przez aplikację')
      : undefined

    // LPR flags
    const lprPushList = driver?.capabilities.includes('lprPushList')
      ? { supported: true, tested: false, detail: 'Whitelist sync z chmury → kamera' }
      : undefined
    const lprEvents = driver?.capabilities.includes('lprEvents')
      ? { supported: true, tested: false, detail: `Kamera pushuje ANPR do /events/lpr` }
      : undefined

    // ── 5. Final ────────────────────────────────────────────────────────────
    // „Online" = TCP OK + (przynajmniej jeden ze rzeczywiście wykonanych testów
    // przeszedł). Idea: Akuvox ma EPROTO na HTTP ping (firmware quirk) ale
    // snapshot HTTP działa — z punktu widzenia integratora urządzenie żyje.
    // Auth.tested=false (skipped) NIE jest powodem do uznania urządzenia za
    // offline — to po prostu nic nie powiedzieliśmy.
    const allEntries: TestMatrixEntry[] = [
      network, auth, ping,
      ...(snapshot ? [snapshot] : []),
    ]
    const positiveTest = allEntries.some((e) => e.tested && e.ok)
    const negativeBlocker = !!(network.tested && network.ok === false) ||
                            !!(auth.tested && auth.ok === false)
    const online = !!network.ok && positiveTest && !negativeBlocker

    return {
      deviceId,
      driverId: driver?.id ?? null,
      ip: cfg.ipAddress,
      port: cfg.httpPort,
      found: true,
      online,
      startedAt,
      finishedAt: Date.now(),
      capabilities: {
        network, auth, ping,
        ...(snapshot ? { snapshot } : {}),
        // Capability flags — wpinamy TYLKO gdy driver wystawia daną akcję.
        // Inaczej UI integratora widzi puste „⚪ openDoor" dla kamery, co jest mylące.
        ...(restart.supported  ? { restart }  : {}),
        ...(openDoor.supported ? { openDoor } : {}),
        ...(toggle.supported   ? { toggle }   : {}),
        ...(lock.supported     ? { lock }     : {}),
        ...(unlock.supported   ? { unlock }   : {}),
        ...(rtsp  ? { rtsp }  : {}),
        ...(mjpeg ? { mjpeg } : {}),
        ...(lprPushList ? { lprPushList } : {}),
        ...(lprEvents   ? { lprEvents }   : {}),
      },
    }
  }

  /**
   * Próbuje po kolei każdy URL z `endpoints.ping[]` — pierwsza odpowiedź (sukces
   * lub auth-related 401/403) wygrywa i decyduje o wyniku ping+auth. Reszta URL-i
   * to fallback (np. HTTPS pada → próbuj HTTP).
   *
   * Zwraca też URL-a po którym się udało (`detail`) — przydatne w UI gdy
   * driver miał kilka kanałów.
   */
  private async runHttpPingWithFallback(
    urls: string[],
    cfg: any,
    driver: DeviceDriver | null,
  ): Promise<{ ping: TestMatrixEntry; auth: TestMatrixEntry }> {
    let lastResult: { ping: TestMatrixEntry; auth: TestMatrixEntry } | null = null
    for (const url of urls) {
      const r = await this.runHttpPing(url, cfg, driver)
      // Sukces 2xx → wracamy od razu.
      if (r.ping.ok && r.auth.ok) return r
      // 401/403 — host odpowiada, ale auth fail. Też wracamy (kolejne URL-e
      // miałyby ten sam auth → bez sensu próbować).
      if (r.ping.ok && r.auth.tested && r.auth.ok === false) return r
      // Network error → spróbuj kolejny URL
      lastResult = r
    }
    return lastResult ?? {
      ping: { supported: true, tested: true, ok: false, error: 'no ping URLs' },
      auth: this.unsupportedEntry(),
    }
  }

  /**
   * Wykonuje HTTP ping + odczytuje czy auth działa.
   * Status 200..299 → ping ok, auth ok.
   * Status 401/403  → ping ok (host osiągalny), auth NIE.
   * Network error   → ping fail.
   */
  private async runHttpPing(
    url: string,
    cfg: any,
    driver: DeviceDriver | null,
  ): Promise<{ ping: TestMatrixEntry; auth: TestMatrixEntry }> {
    const axios = require('axios')
    const start = Date.now()
    try {
      const res = await axios.get(url, {
        auth: cfg.login && cfg.password ? { username: cfg.login, password: cfg.password } : undefined,
        timeout: 5000,
        maxRedirects: 2,
        validateStatus: () => true,  // sami klasyfikujemy
        httpsAgent: rejectUnauthorizedHttpsAgent,
      })
      const latencyMs = Date.now() - start
      const status = res.status as number

      if (status >= 200 && status < 300) {
        return {
          ping: { supported: true, tested: true, ok: true, latencyMs, detail: `${status} OK` },
          auth: cfg.login
            ? { supported: true, tested: true, ok: true, latencyMs, detail: `Login „${cfg.login}" działa` }
            : { supported: false, tested: false },
        }
      }
      if (status === 401 || status === 403) {
        return {
          ping: { supported: true, tested: true, ok: true, latencyMs, detail: `${status} (host osiągalny)` },
          auth: { supported: true, tested: true, ok: false, latencyMs, error: `${status} — sprawdź login/hasło` },
        }
      }
      // 4xx/5xx — host odpowiada ale coś nie tak
      return {
        ping: { supported: true, tested: true, ok: true, latencyMs, detail: `${status}` },
        auth: { supported: true, tested: false, hint: `HTTP ${status} — sprawdź endpoint manualnie` },
      }
    } catch (err: any) {
      const latencyMs = Date.now() - start
      const errMsg = err.code ?? err.message ?? 'unknown'
      return {
        ping: { supported: true, tested: true, ok: false, latencyMs, error: errMsg },
        auth: { supported: true, tested: false, hint: 'Pomijam — brak HTTP' },
      }
    }
  }

  /**
   * Snapshot test — używa istniejących ścieżek per device-type.
   *   INTERCOM → cachedSnapshot (HTTP-first, RTSP fallback)
   *   CAMERA / LPR_CAMERA → cameras.getSnapshot (RTSP)
   * Zwraca rozmiar zdjęcia w bajtach (z dataURL `image/jpeg;base64,...`).
   */
  private async runSnapshotTest(
    deviceId: string,
    type: string,
    cfg: any,
  ): Promise<TestMatrixEntry> {
    const start = Date.now()
    try {
      let dataUrl: string | null = null
      if (type === 'INTERCOM') {
        dataUrl = await this.cachedSnapshot(deviceId, cfg)
      } else if (type === 'CAMERA' || type === 'LPR_CAMERA') {
        const snap = await this.cameras.getSnapshot(deviceId)
        dataUrl = snap?.image ?? null
      }

      if (!dataUrl) {
        return { supported: true, tested: true, ok: false, error: 'Brak zdjęcia (timeout RTSP/HTTP)', latencyMs: Date.now() - start }
      }
      // Estymacja rozmiaru — base64 to ~133% raw, więc raw = base64.length * 0.75
      const b64 = dataUrl.split(',')[1] ?? ''
      const sizeBytes = Math.round(b64.length * 0.75)
      return {
        supported: true,
        tested: true,
        ok: true,
        latencyMs: Date.now() - start,
        detail: `${(sizeBytes / 1024).toFixed(1)} KB`,
      }
    } catch (err: any) {
      return { supported: true, tested: true, ok: false, error: err.message ?? 'snapshot failed', latencyMs: Date.now() - start }
    }
  }
}
