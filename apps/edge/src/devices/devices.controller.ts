import { Controller, Get, Post, Patch, Delete, Param, Query, Body, Res, HttpException, HttpStatus } from '@nestjs/common'
import { Response } from 'express'
import { DeviceRegistryService } from './device-registry.service'
import { EventLogService } from '../event-log/event-log.service'
import { v4 as uuidv4 } from 'uuid'
import { DRIVERS, driversForType, findDriver, type DeviceType } from '@gatelynk/device-drivers'

@Controller('devices')
export class DevicesController {
  constructor(
    private registry: DeviceRegistryService,
    private eventLog: EventLogService,
  ) {}

  @Get()
  list() {
    return this.registry.listAll()
  }

  /**
   * Katalog driverów dla wizarda dodawania urządzenia (`/ui/wizard.html`).
   *
   * Zwraca pełną tablicę `DeviceDriver` z `@gatelynk/device-drivers`:
   *   • `id`, `type`, `manufacturer`, `models[]`, `label`, `icon`, `notes`
   *   • `capabilities[]` — co driver potrafi (toggle/openDoor/...)
   *   • `fields[]` — schemat formularza (klucze, typy, walidacja, hint-y)
   *   • `endpoints` — meta (frontend tego nie potrzebuje, ale czasem przydatne do debugu)
   *   • `defaults` — pre-fill nowego formularza
   *
   * UWAGA: regexy w `endpoints.discovery.mdnsHostnamePattern` nie serializują się do JSON
   * (zwracają `{}`). Frontend ich nie potrzebuje (Discovery działa po stronie Edge).
   *
   * Optional ?type=INTERCOM filtruje katalog do jednego typu (Step 1 → Step 2 w wizardzie).
   */
  @Get('drivers')
  listDrivers(@Query('type') type?: string) {
    const list = type ? driversForType(type as DeviceType) : DRIVERS
    return list.map((d) => ({
      id: d.id,
      type: d.type,
      manufacturer: d.manufacturer,
      models: d.models,
      label: d.label,
      icon: d.icon,
      notes: d.notes,
      capabilities: d.capabilities,
      fields: d.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        group: f.group,
        required: !!f.required,
        default: f.default,
        help: f.help,
        placeholder: f.placeholder,
        options: f.options,
        min: f.min,
        max: f.max,
      })),
      defaults: d.defaults ?? {},
      // Faza C-1: status certyfikacji — UI wizarda renderuje badge.
      certification: d.certification ?? { status: 'untested' as const },
    }))
  }

  @Post()
  add(@Body() body: { type: string; config: any }) {
    const deviceId = body.config.id || uuidv4()
    delete body.config.id
    const config = this.applyDriverDefaults(body.config)
    return this.registry.saveDevice(deviceId, body.type.toUpperCase(), config)
  }

  /**
   * Onboarding zamka Nuki przez mieszkańca (2026-07-09) — lista zamków konta.
   * Body `{ apiToken }`; Edge woła Nuki `GET /smartlock` i zwraca
   * `{ ok, smartlocks: [{ smartlockId, name }] }`. Token NIE jest zapisywany
   * ani logowany (świadomie brak `eventLog` z body). Route statyczna PRZED
   * `:id/*` — bez kolizji z param-capture.
   */
  @Post('smart-lock/list-smartlocks')
  async smartLockListSmartlocks(@Body() body: { apiToken?: string }) {
    try {
      const smartlocks = await this.registry.smartLockList(String(body?.apiToken ?? ''))
      // Log BEZ tokenu — tylko liczba znalezionych zamków.
      this.eventLog.info('SMART_LOCK', `🔎 Lista zamków Nuki: ${smartlocks.length}`, {})
      return { ok: true, smartlocks }
    } catch (err: any) {
      this.eventLog.error('SMART_LOCK', `❌ Lista zamków Nuki failed: ${err.message}`, {})
      throw new HttpException({ ok: false, message: err.message }, HttpStatus.BAD_GATEWAY)
    }
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { type: string; config: any }) {
    // **MERGE** existing config z patch body — NIE replace. Wcześniej PATCH
    // z payload-em `{config: {password: 'X'}}` kasował wszystkie inne pola
    // (ipAddress, manufacturer, model itp.). Patrz 2026-05-17 incident.
    //
    // Reguła: bierzemy istniejący config z sqlite, mergujemy płytko z body.config.
    // POST (`add()`) nadal robi full-replace bo tam użytkownik tworzy nowy device.
    const existing = this.registry.listAll().find((d) => d.deviceId === id)
    const merged = { ...(existing?.config ?? {}), ...body.config }
    const config = this.applyDriverDefaults(merged)
    return this.registry.saveDevice(id, body.type.toUpperCase(), config)
  }

  /**
   * Wzbogaca config o driver constants + defaults. Reguła pierwszeństwa:
   *   1. user-config (z formularza wizarda) — najwyższy priorytet
   *   2. driver.defaults — placeholder values
   *   3. driver.constants — zaszyte stałe drivera (porty, ścieżki, quirki fw)
   *
   * Po merge config jest „kompletny" i Edge service nie musi sięgać do drivera
   * przy każdym czytaniu. Save w sqlite trzyma fully-resolved snapshot — to
   * znaczy że gdy driver kiedyś zmieni `constants.httpPort` z 443 na 444,
   * istniejące instalacje **nie** zostaną automatycznie zaktualizowane.
   * To celowe: niech instalator po update'cie biblioteki Edge przejdzie
   * wizardem ponownie albo edytuje przez UI.
   */
  private applyDriverDefaults(userConfig: Record<string, any>): Record<string, any> {
    const driverId = userConfig.driverId
    const driver = typeof driverId === 'string' ? findDriver(driverId) : null
    if (!driver) return userConfig

    return {
      ...(driver.constants ?? {}),
      ...(driver.defaults ?? {}),
      ...userConfig,
    }
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    this.registry.removeDevice(id)
    return { removed: true }
  }

  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.registry.testDevice(id)
  }

  /**
   * Test matrix — diagnostyka per-capability dla wizarda dodawania urządzenia.
   * Zwraca strukturę: network/auth/ping/snapshot/restart/openDoor/toggle/lock/...
   *   • status `tested: true, ok: true/false` dla non-destrukcyjnych testów
   *   • status `tested: false, hint: "..."` dla destrukcyjnych (restart/relay/...)
   *
   * Endpoint świadomie POST (nie GET) — niektóre adaptery (cloud) mogą mieć
   * efekty uboczne (np. wybudzić zamek z low-power). UI w wizardzie traktuje
   * to jako idempotentne wywołanie.
   */
  @Post(':id/test-matrix')
  async testMatrix(@Param('id') id: string) {
    return this.registry.runTestMatrix(id)
  }

  /** Restart device (intercom or camera) */
  @Post(':id/restart')
  async restart(@Param('id') id: string) {
    this.eventLog.info('HTTP', `🔄 Device restart requested`, { deviceId: id })
    try {
      const result = await this.registry.restartDevice(id)
      this.eventLog.success('RESTART', `✅ Restart command sent to device`, { deviceId: id })
      return result
    } catch (err: any) {
      this.eventLog.error('RESTART', `❌ Restart failed: ${err.message}`, { deviceId: id })
      throw err
    }
  }

  /**
   * Faza F-2 (2026-05-14): HOLD_OPEN — trzymaj otwartą bramę przez N sekund.
   * Akuvox/Hik/2N/DNAKE nie mają natywnego hold-open, więc Edge symuluje
   * przez cykliczne wywołania openDoor (patrz `IntercomService.holdOpen`).
   *
   * Body: `{ seconds: number, doorIndex?: number }`.
   * `seconds` clamp do `driver.constants.holdOpenMaxSeconds` (default 600).
   */
  @Post(':id/hold-open')
  async holdOpen(
    @Param('id') id: string,
    @Body() body: { seconds?: number; doorIndex?: number },
  ) {
    const seconds = body.seconds ?? 30
    const doorIndex = body.doorIndex ?? 0
    this.eventLog.info('HTTP', `🔓 HOLD_OPEN start (${seconds}s, relay ${doorIndex})`, { deviceId: id })
    try {
      const result = await this.registry.holdOpenIntercom(id, seconds, doorIndex)
      this.eventLog.success('HOLD_OPEN', `✅ Hold-open active (${result.seconds}s)`, { deviceId: id })
      return result
    } catch (err: any) {
      this.eventLog.error('HOLD_OPEN', `❌ Failed: ${err.message}`, { deviceId: id })
      throw err
    }
  }

  @Post(':id/hold-open/cancel')
  cancelHoldOpen(@Param('id') id: string) {
    this.eventLog.info('HTTP', `🔒 HOLD_OPEN cancel`, { deviceId: id })
    return this.registry.cancelHoldOpenIntercom(id)
  }

  /**
   * Faza F-4.1 (2026-05-14): DND on/off — domofon przestaje dzwonić.
   * Body: `{ enabled: boolean }`. Typowy use case: portier wyłącza na noc.
   */
  @Post(':id/dnd')
  async setDnd(
    @Param('id') id: string,
    @Body() body: { enabled: boolean },
  ) {
    this.eventLog.info('HTTP', `🔕 DND ${body.enabled ? 'ON' : 'OFF'}`, { deviceId: id })
    try {
      const result = await this.registry.setDndIntercom(id, body.enabled)
      this.eventLog.success('DND', `✅ DND ${body.enabled ? 'ON' : 'OFF'}`, { deviceId: id })
      return result
    } catch (err: any) {
      this.eventLog.error('DND', `❌ ${err.message}`, { deviceId: id })
      throw err
    }
  }

  /**
   * Faza F-3.1 (2026-05-14): SET_CONFIDENCE — zmienia próg pewności ANPR
   * detekcji w kamerze LPR. Body: `{ threshold: number }` (0.0–1.0).
   *
   * Edge wysyła ISAPI PUT do Hik kamery, persistuje też w sqlite żeby override
   * przeżył restart. Driver.constants.confidenceThreshold to default; tu mamy
   * per-device runtime override.
   */
  @Post(':id/lpr/confidence')
  async setLprConfidence(
    @Param('id') id: string,
    @Body() body: { threshold: number },
  ) {
    this.eventLog.info('HTTP', `🎯 LPR SET_CONFIDENCE → ${(body.threshold * 100).toFixed(0)}%`, { deviceId: id })
    try {
      const result = await this.registry.setLprConfidence(id, body.threshold)
      if (result.set) {
        this.eventLog.success('LPR_CONFIDENCE', `✅ Threshold ${body.threshold}`, { deviceId: id, ...result })
      } else {
        this.eventLog.warn('LPR_CONFIDENCE', `⚠️ Failed to set: ${result.error}`, { deviceId: id })
      }
      return result
    } catch (err: any) {
      this.eventLog.error('LPR_CONFIDENCE', `❌ ${err.message}`, { deviceId: id })
      throw err
    }
  }

  /** Trigger a specific relay on an intercom (test elektrozaczep) */
  @Post(':id/relay/:relayIndex')
  async triggerRelay(@Param('id') id: string, @Param('relayIndex') relayIndex: string) {
    const idx = parseInt(relayIndex, 10)
    this.eventLog.info('HTTP', `📲 Relay [${idx}] open requested`, { deviceId: id, relayIndex: idx, source: 'HTTP API (mobile app / panel)' })
    try {
      const result = await this.registry.triggerRelay(id, idx)
      this.eventLog.success('RELAY', `✅ Relay [${idx}] opened`, { deviceId: id, result })
      return result
    } catch (err: any) {
      this.eventLog.error('RELAY', `❌ Failed to open relay [${idx}]: ${err.message}`, { deviceId: id })
      throw err
    }
  }

  /** Smart lock (Nuki) — stan zamka z Nuki Web API. Używane przez „Testuj"
   *  w panelu Integratora (Cloud woła bezpośrednio HTTP) oraz diagnostykę. */
  @Get(':id/smart-lock/state')
  async smartLockState(@Param('id') id: string) {
    try {
      const state = await this.registry.smartLockState(id)
      this.eventLog.info('SMART_LOCK', `🔍 Stan zamka: ${state.stateLabel}`, { deviceId: id })
      return state
    } catch (err: any) {
      this.eventLog.error('SMART_LOCK', `❌ Test zamka failed: ${err.message}`, { deviceId: id })
      throw new HttpException({ ok: false, message: err.message }, HttpStatus.BAD_GATEWAY)
    }
  }

  /** Device tree — all LAN devices grouped by type with online status */
  @Get('tree')
  getDeviceTree() {
    return this.registry.getDeviceTree()
  }

  /** Quick snapshot — returns {snapshot: dataUrl|null} without running full diagnostics.
   *  Pass ?live=1 to bypass the 60-second cache and always fetch a fresh frame.
   *  2026-08-19: ?w=720&q=60 — downscale przez sharp NA EDGE (kafle „Dostęp"
   *  w apce; pełna klatka z kasety to 300–740 KB — sekundy na LTE i zbędne
   *  obciążenie uplinku osiedla; po resize ~50–90 KB). */
  @Get(':id/snapshot')
  quickSnapshot(
    @Param('id') id: string,
    @Query('live') live?: string,
    @Query('w') w?: string,
    @Query('q') q?: string,
  ) {
    const skipCache = live === '1' || live === 'true'
    const width = w ? Math.max(160, Math.min(parseInt(w, 10) || 0, 1920)) : undefined
    const quality = q ? Math.max(30, Math.min(parseInt(q, 10) || 0, 90)) : undefined
    return this.registry.quickSnapshot(id, skipCache, width, quality)
  }

  /** MJPEG live stream proxy — browser-compatible live video via <img src="..."> */
  @Get(':id/stream')
  async liveStream(@Param('id') id: string, @Res() res: Response) {
    await this.registry.pipeVideoStream(id, res)
  }

  /** Streaming test — returns SSE events for each step in real time */
  @Get(':id/test/stream')
  async testStream(@Param('id') id: string, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const emit = (data: object) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch { /* client disconnected */ }
    }

    await this.registry.streamTest(id, emit)
    res.end()
  }
}
