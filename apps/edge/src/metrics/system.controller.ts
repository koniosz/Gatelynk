/**
 * SystemController — endpointy `/api/system` + `/api/metrics`.
 *
 * Z handoff doc sek. 6/7. Ścieżki pod `/api/...` (NIE `/system`), żeby
 * uniknąć kolizji ze starym `/status` (legacy).
 */
import { Controller, Get, Post, Body, Query, BadRequestException, Logger, Res, Header } from '@nestjs/common'
import type { Response } from 'express'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { MetricsService } from './metrics.service'
import { ActivationService } from '../activation/activation.service'
import { TunnelService } from '../tunnel/tunnel.service'
import { StoreService } from '../store/store.service'
import { EventLogService } from '../event-log/event-log.service'

@Controller('api')
export class SystemController {
  private readonly logger = new Logger(SystemController.name)

  constructor(
    private metrics: MetricsService,
    private activation: ActivationService,
    private tunnel: TunnelService,
    private store: StoreService,
    private eventLog: EventLogService,
  ) {}

  /**
   * Pełny SystemInfo — instant snapshot (handoff doc Schema #6 SystemInfo).
   * Zwraca też latest sample z `MetricsService` żeby UI miał już dane bez
   * czekania na pierwszy /api/metrics request.
   */
  @Get('system')
  getSystem() {
    const startTime = (this.metrics as any).startTime ?? Date.now()
    const latest = this.metrics.getLatestSample()

    return {
      hostname: os.hostname(),
      ip:       this.getLanIp(),
      mac:      this.metrics.getMac() ?? 'unknown',
      // Serial — placeholder. Faza X: czytać z `/etc/gatelynk/serial` albo
      // env GLE_SERIAL. Edge dziś nie ma seriala — dajemy „dev" żeby UI nie pęknął.
      serial:   process.env.GLE_SERIAL ?? 'GLE-DEV',
      firmware: process.env.npm_package_version ?? '0.1.0',
      uptimeSec: Math.round(process.uptime()),

      /**
       * Strefa czasowa TEJ maszyny (np. `Europe/Warsaw`).
       *
       * Panel Edge musi pokazywać zdarzenia w czasie OBIEKTU, nie przeglądarki
       * (zgłoszenie 2026-08-08: integrator pracował z komputera w strefie
       * -04:00 i odczyty tablic wyświetlały się o 6 godzin przesunięte —
       * bezużyteczne przy ustalaniu, kiedy auto faktycznie wjechało).
       * Znaczniki czasu są zapisywane uniwersalnie (epoch), więc problem
       * dotyczył wyłącznie prezentacji — tu dajemy UI właściwą strefę.
       */
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        ?? process.env.TZ ?? 'Europe/Warsaw',

      cpu: {
        model: this.metrics.getCpuModel(),
        usage: latest?.cpu ?? 0,
      },
      ram: {
        used:  latest?.ramUsedMb  ?? Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
        total: latest?.ramTotalMb ?? Math.round(os.totalmem() / 1024 / 1024),
      },
      disk: {
        used:  latest?.diskUsedGb  ?? 0,
        total: latest?.diskTotalGb ?? 0,
      },
      temp: latest?.tempC ?? null,

      cloud: this.tunnel.isConnected() ? 'connected' : 'disconnected',
      lan:   { state: 'up' as const, linkMbps: 1000 },  // TODO: realny link speed
      // WAN — Edge LAN-only, brak osobnego WAN interface. Zwracamy `lan` jako fallback.
      wan:   { state: 'up' as const, linkMbps: 1000, isp: 'unknown' },

      // Bonus dla nowego UI Topbar — pełny activated flag
      activated:  this.activation.isActivated(),
      deviceId:   this.activation.getDeviceId(),
      buildingId: this.activation.getBuildingId(),
    }
  }

  /**
   * Time-series — handoff doc Schema #6 Metrics.
   * Range `1h` default; inne (`6h`, `24h`, `7d`) na razie zwracają to samo.
   */
  @Get('metrics')
  getMetrics(@Query('range') range?: string) {
    return this.metrics.getMetrics(range ?? '1h')
  }

  /**
   * Ostatnie ~50 trigerów przekaźników z metadanymi (`ts`, `deviceId`,
   * `relayIndex`, `source`). UI Monitoring pokazuje listę pod sparkline
   * „Triggery przekaźników" żeby instalator widział faktyczne otwarcia
   * (nie tylko zagregowany count per minutę).
   */
  @Get('metrics/recent-relay-triggers')
  getRecentRelayTriggers() {
    return { triggers: this.metrics.getRecentRelayTriggers() }
  }

  /**
   * Ostatnie N (default 50) odczytów LPR ze wszystkich kamer. Bezpośrednio
   * z `lpr_reads` (sqlite, indeks ts DESC). UI Monitoring pokazuje listę
   * pod sparkline „Odczyty LPR".
   */
  @Get('metrics/recent-lpr-reads')
  getRecentLprReads(@Query('limit') limit?: string) {
    const n = limit ? Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) : 50
    return { reads: this.metrics.getRecentLprReads(n) }
  }

  private getLanIp(): string {
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

  // ────────────────────────────────────────────────────────────────────────
  //  Faza E-6.2 (2026-05-14): Settings actions
  //
  //  Wszystkie operacje destrukcyjne (restart, factory-reset) wymagają
  //  consent przez body. Tu nie ma autoryzacji — Edge to LAN-only. Cloud
  //  panel BA NIE wystawia tych endpointów (Cloud → Edge przez tunel CMD).
  // ────────────────────────────────────────────────────────────────────────

  /**
   * GET /api/settings/cloud — szczegóły połączenia z chmurą GateLynk.
   * Sub-tab „Chmura" w SettingsPage konsumuje to bezpośrednio.
   */
  @Get('settings/cloud')
  getCloudSettings() {
    const info = this.tunnel.getConnectionInfo()
    return {
      connected: this.tunnel.isConnected(),
      endpoint: process.env.CLOUD_URL ? `${process.env.CLOUD_URL.replace(/^http/, 'ws')}/api/edge/tunnel` : 'wss://api.gatelynk.com/api/edge/tunnel',
      buildingId: this.activation.getBuildingId(),
      deviceId: this.activation.getDeviceId(),
      activated: this.activation.isActivated(),
      ...info,
    }
  }

  /**
   * POST /api/system/restart — wymusza zakończenie procesu Edge (exit 0).
   * Service manager (pm2 / launchd) auto-restartuje proces.
   *
   * 3-sec delay żeby HTTP response zdążyła dotrzeć do UI przed `process.exit`.
   * UI pokazuje toast „Restart wysłany — wróć za 5-10 sek" i czeka aż
   * `/api/system` znów odpowiada.
   *
   * Bez auth challenge — Edge LAN-only, instalator który ma dostęp do `/ui`
   * implicit ma uprawnienia (panel za firewallem/Tailscale).
   */
  @Post('system/restart')
  restart() {
    this.logger.warn('Restart requested via /api/system/restart — exiting in 3s')
    this.eventLog.warn('SYSTEM', '🔄 Edge restart requested from /ui panel')
    setTimeout(() => process.exit(0), 3000)
    return { restarting: true, delaySeconds: 3 }
  }

  /**
   * GET /api/system/backup — pobiera tarball z krytycznymi danymi Edge.
   *
   * Zawartość zawsze:
   *   • store.db — sqlite z activation token, JWT, device configs, lpr_plates,
   *     lpr_reads, relay_triggers, event_log, guest_pins
   *   • MANIFEST.txt — kiedy zrobiono, hostname, wersja, lista plików
   *
   * Opcjonalnie (zależnie od query params):
   *   • lpr-snapshots/ — historyczne JPEG-i z kamer LPR (~1-3 GB / 30 dni)
   *
   * Query params:
   *   ?snapshots=none|7d|30d|all  — domyślnie 'none' (małe ~1-2 MB)
   *
   * Implementacja:
   *  1. `store.exportBackup(tmpDb)` — sqlite VACUUM INTO do tmp pliku (safe live snapshot)
   *  2. tar(1) z tmp store.db + opcjonalnie filtered lpr-snapshots dir
   *  3. Stream tar stdout do response (gzip-owany)
   *  4. Cleanup tmp w `res.on('close')`
   *
   * Wire: `Content-Type: application/gzip`, `Content-Disposition: attachment;
   * filename="gatelynk-edge-backup_<host>_<ts>.tar.gz"`.
   *
   * Bezpieczeństwo: nie ma autoryzacji (Edge LAN-only). Backup zawiera
   * activation JWT — kto ma do niego dostęp może zaimpersonować Edge
   * w Cloud. Trzymać w bezpiecznym miejscu (NIE upload do publicznych dysków).
   */
  @Get('system/backup')
  @Header('Cache-Control', 'no-store')
  async backup(
    @Query('snapshots') snapshots: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const includeSnapshots = snapshots && snapshots !== 'none' ? snapshots : null
    const validRanges: Record<string, number | null> = { '7d': 7, '30d': 30, 'all': null }
    if (includeSnapshots && !(includeSnapshots in validRanges)) {
      throw new BadRequestException(`Invalid snapshots="${includeSnapshots}". Use: none, 7d, 30d, all.`)
    }

    // 1. Safe sqlite snapshot do tmp
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gle-backup-'))
    const tmpDb = path.join(tmpDir, 'store.db')
    try {
      this.store.exportBackup(tmpDb)
    } catch (err: any) {
      this.logger.error(`exportBackup failed: ${err.message}`)
      fs.rmSync(tmpDir, { recursive: true, force: true })
      throw new BadRequestException(`Backup failed: ${err.message}`)
    }

    // 2. MANIFEST
    const manifest = [
      `GateLynk Edge — backup`,
      `========================`,
      `Created:        ${new Date().toISOString()}`,
      `Hostname:       ${os.hostname()}`,
      `macOS:          ${os.release()}`,
      `Edge version:   ${process.env.npm_package_version ?? '0.1.0'}`,
      `Activated:      ${this.activation.isActivated()}`,
      `Device ID:      ${this.activation.getDeviceId() ?? '(none)'}`,
      `Building ID:    ${this.activation.getBuildingId() ?? '(none)'}`,
      `Include snapshots: ${includeSnapshots ?? 'no'}`,
      ``,
      `To restore:`,
      `  1. Stop Edge:           pm2 stop gatelynk-edge`,
      `  2. tar xzf <this-file>`,
      `  3. Copy store.db over:  cp store.db ~/gatelynk-edge/data/store.db`,
      `  4. (Optional) snapshots: cp -R lpr-snapshots ~/gatelynk-edge/data/`,
      `  5. Restart:             pm2 start gatelynk-edge`,
    ].join('\n')
    fs.writeFileSync(path.join(tmpDir, 'MANIFEST.txt'), manifest)

    // 3. Filename + headers
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const host = os.hostname().replace(/[^a-zA-Z0-9-]/g, '_')
    const filename = `gatelynk-edge-backup_${host}_${stamp}.tar.gz`
    res.setHeader('Content-Type', 'application/gzip')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

    // 4. Argumenty tar — store.db zawsze, opcjonalnie snapshots
    // -C tmpDir żeby ścieżki w tarballu były relatywne (`store.db` nie /tmp/.../store.db)
    const tarArgs: string[] = ['-czf', '-', '-C', tmpDir, 'store.db', 'MANIFEST.txt']

    let snapshotsRelativeDir: string | null = null
    if (includeSnapshots) {
      const sourceDir = this.store.lprSnapshotsDir()
      // Dla full = wszystko, dla 7d/30d = utworzymy symlinka albo użyjemy --files-from
      // Najprostsze: utwórz tmp katalog z hardlinkami tylko wybranych plików.
      const linkedDir = path.join(tmpDir, 'lpr-snapshots')
      fs.mkdirSync(linkedDir)
      const cutoffDays = validRanges[includeSnapshots]
      const cutoffMs = cutoffDays ? Date.now() - cutoffDays * 86400_000 : 0
      try {
        const files = fs.readdirSync(sourceDir)
        let copied = 0
        for (const f of files) {
          const src = path.join(sourceDir, f)
          const stat = fs.statSync(src)
          if (stat.isFile() && stat.mtimeMs >= cutoffMs) {
            // Hardlink jest O(1) i nie kopiuje danych (same i-node)
            fs.linkSync(src, path.join(linkedDir, f))
            copied++
          }
        }
        this.logger.log(`Backup: linked ${copied}/${files.length} snapshot files (range=${includeSnapshots})`)
      } catch (err: any) {
        this.logger.warn(`Snapshot linking failed: ${err.message}`)
      }
      snapshotsRelativeDir = 'lpr-snapshots'
      tarArgs.push(snapshotsRelativeDir)
    }

    // 5. Stream tar gzip → response
    const tar = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    tar.stdout.pipe(res)

    let stderrBuf = ''
    tar.stderr.on('data', (chunk) => { stderrBuf += chunk.toString() })
    tar.on('error', (err) => {
      this.logger.error(`tar spawn error: ${err.message}`)
      try { res.end() } catch { /* ignore */ }
    })
    tar.on('close', (code) => {
      if (code !== 0) {
        this.logger.warn(`tar exited code=${code} stderr=${stderrBuf.slice(0, 200)}`)
      }
      // Cleanup
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    // Klient zamyka request → ubij tar + cleanup
    res.on('close', () => {
      if (!tar.killed) {
        try { tar.kill('SIGTERM') } catch { /* ignore */ }
      }
    })

    this.eventLog.info('SYSTEM', `📦 Backup downloaded (snapshots=${includeSnapshots ?? 'no'})`)
  }

  /**
   * POST /api/system/factory-reset — kasuje sqlite store + activation token.
   *
   * Auth challenge: body musi zawierać `confirmHostname` matching `os.hostname()`.
   * To zapobiega przypadkowemu wywołaniu (curl bez --data albo źle kliknięty
   * przycisk w UI).
   *
   * Po reset: Edge wraca do stanu sprzed pierwszego activation code (pusty
   * device list, pusty cache, brak buildingId). Wymagana ponowna aktywacja
   * z Superadmin panelu.
   */
  @Post('system/factory-reset')
  factoryReset(@Body() body: { confirmHostname?: string }) {
    const hostname = os.hostname()
    if (body?.confirmHostname !== hostname) {
      throw new BadRequestException(
        `Wymagane potwierdzenie hostname. Wpisz „${hostname}" w polu confirmHostname.`,
      )
    }
    this.logger.error(`FACTORY RESET requested — wiping sqlite + activation`)
    this.eventLog.error('SYSTEM', '⚠️ FACTORY RESET — wiping Edge state')
    try {
      // Wipe stałych tabel — store.service eksponuje metody, ale dla safety
      // korzystam z drop wzorca (najpierw `db.exec('DELETE FROM ...')`).
      const db = (this.store as any).db
      if (db) {
        db.exec('DELETE FROM device_configs')
        db.exec('DELETE FROM lpr_plates')
        db.exec('DELETE FROM lpr_reads')
        db.exec('DELETE FROM event_queue')
        db.exec('DELETE FROM activation')
      }
    } catch (err: any) {
      this.logger.error(`Factory reset DB wipe failed: ${err.message}`)
    }
    // Exit po 2s — service manager restartuje w czystym stanie.
    setTimeout(() => process.exit(0), 2000)
    return { factoryReset: true, restartingIn: 2 }
  }

  /**
   * POST /api/settings/firmware/check — sprawdza dostępność nowej wersji.
   *
   * MVP stub: zwraca current = package.json version. W przyszłości będzie
   * fetch do https://releases.gatelynk.com/edge/latest.json albo GitHub API.
   */
  @Post('settings/firmware/check')
  firmwareCheck() {
    const current = process.env.npm_package_version ?? '0.1.0'
    // TODO: realny fetch do release endpoint
    return {
      current,
      latest: current,
      hasUpdate: false,
      checkedAt: new Date().toISOString(),
    }
  }
}
