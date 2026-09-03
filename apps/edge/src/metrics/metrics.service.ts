/**
 * MetricsService — zbiera i przechowuje próbki systemowe Edge.
 *
 * Cron co 60s → push do circular buffer (60 punktów = ostatnia godzina).
 * Endpointy w `system.controller.ts`:
 *   GET /api/system          → instant SystemInfo (current state, no time-series)
 *   GET /api/metrics?range=… → Metrics (time-series ostatnich N punktów)
 *
 * MVP: jeden bufor 1h (60×60s). Range-y `6h`, `24h`, `7d` na tym etapie zwracają
 * to samo (handoff doc dopuszcza — większe range-y to follow-up).
 *
 * Platformy:
 *   • CPU usage   — delta `os.cpus()` idle/total między samplami
 *   • RAM         — `os.totalmem() / freemem()` (cross-platform)
 *   • Disk        — `df -k /` parse (macOS + Linux); 0 jeśli fail
 *   • Temp        — macOS wymaga sudo (powermetrics); zwracamy null
 *   • Net I/O     — `netstat -ib` (macOS) lub `/proc/net/dev` (Linux);
 *                   counter monotonic → delta między samplami → Mbps
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import * as os from 'os'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import { DeviceRegistryService } from '../devices/device-registry.service'
import { StoreService } from '../store/store.service'

const exec = promisify(execCb)

export interface MetricSample {
  ts: number              // Date.now() ms
  cpu: number             // 0-100 %
  ramUsedMb: number
  ramTotalMb: number
  diskUsedGb: number
  diskTotalGb: number
  tempC: number | null    // null gdy niedostępne
  netInMbps: number       // ostatnie 60s avg
  netOutMbps: number
  devicesOnline: number
  relayTriggers: number   // count z ostatnich 60s (drain z relay-counter.ts)
  lprReads: number        // count z ostatnich 60s (SELECT z lpr_reads.ts)
}

const BUFFER_SIZE = 60        // 60 samples = 60 min @ 60s interval
const SAMPLE_INTERVAL_MS = 60_000

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name)
  private buffer: MetricSample[] = []
  private prevCpuTotals = { idle: 0, total: 0 }
  private prevNetCounters: { ibytes: number; obytes: number; ts: number } | null = null
  /** Last bucket start ts — używane do liczenia LPR-odczytów w sliding window. */
  private lastBucketEndMs: number = Date.now()

  constructor(
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly store: StoreService,
  ) {}

  onModuleInit() {
    // Initial sample na start (bez delta — zapisuje seed dla net counter)
    this.sample().catch((err) => this.logger.warn(`Initial sample failed: ${err.message}`))
  }

  /**
   * Zwraca ostatnie N relay-trigerów z czytelną nazwą urządzenia (JOIN z
   * `device_config`). Bezpośrednio z sqlite — przeżywa restart Edge w
   * przeciwieństwie do poprzedniej wersji in-memory.
   */
  getRecentRelayTriggers(limit = 50) {
    return this.store.relayTriggerListRecent(limit)
  }

  /** Ostatnie N odczytów LPR (cross-camera). Bezpośrednio z sqlite. */
  getRecentLprReads(limit = 50) {
    return this.store.lprListRecentAll({ limit })
  }

  @Interval(SAMPLE_INTERVAL_MS)
  async sample(): Promise<void> {
    try {
      const ts = Date.now()
      const cpu = this.measureCpu()
      const ram = await this.measureRam()
      const disk = await this.measureDisk()
      const temp = await this.measureTemp()
      const net = await this.measureNet()
      const devicesOnline = await this.countOnlineDevices()
      // Sliding window [lastBucketEnd, ts) dla obu metryk — persistent w sqlite,
      // dokładne, przeżywa restart Edge. Pierwszy sample po starcie używa
      // ts-60s żeby nie liczyć od zera (gdyby zegarek Edge ostatnio kliknął).
      const windowStart = this.lastBucketEndMs > 0
        ? this.lastBucketEndMs
        : ts - SAMPLE_INTERVAL_MS
      let lprReads = 0
      let relayTriggers = 0
      try {
        lprReads = this.store.lprCountInWindow(windowStart, ts)
      } catch (err: any) {
        this.logger.warn(`lprCountInWindow failed: ${err.message}`)
      }
      try {
        relayTriggers = this.store.relayTriggerCountInWindow(windowStart, ts)
      } catch (err: any) {
        this.logger.warn(`relayTriggerCountInWindow failed: ${err.message}`)
      }
      this.lastBucketEndMs = ts

      this.buffer.push({
        ts,
        cpu,
        ramUsedMb: ram.usedMb,
        ramTotalMb: ram.totalMb,
        diskUsedGb: disk.usedGb,
        diskTotalGb: disk.totalGb,
        tempC: temp,
        netInMbps: net.inMbps,
        netOutMbps: net.outMbps,
        devicesOnline,
        relayTriggers,
        lprReads,
      })
      if (this.buffer.length > BUFFER_SIZE) {
        this.buffer.shift()
      }
    } catch (err: any) {
      this.logger.warn(`Sample failed: ${err.message}`)
    }
  }

  /** Zwraca instant snapshot — najnowszy sample (do `/api/system`). */
  getLatestSample(): MetricSample | null {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null
  }

  /**
   * Time-series w formacie który UI konsumuje (jak handoff doc):
   * { timestamps: [...], cpu: [...], ram: [...], … }
   *
   * Range na razie ignorowany — zwraca pełen bufor (1h). Większe range-y =
   * follow-up implementacji.
   */
  getMetrics(_range: string = '1h') {
    const buf = this.buffer
    return {
      timestamps: buf.map((s) => new Date(s.ts).toISOString()),
      cpu:        buf.map((s) => s.cpu),
      ram:        buf.map((s) => s.ramTotalMb > 0 ? (s.ramUsedMb / s.ramTotalMb) * 100 : 0),
      disk:       buf.map((s) => s.diskTotalGb > 0 ? (s.diskUsedGb / s.diskTotalGb) * 100 : 0),
      temp:       buf.map((s) => s.tempC),
      netIn:      buf.map((s) => s.netInMbps),
      netOut:     buf.map((s) => s.netOutMbps),
      devicesOnline:  buf.map((s) => s.devicesOnline),
      relayTriggers:  buf.map((s) => s.relayTriggers),
      lprReads:       buf.map((s) => s.lprReads ?? 0),
    }
  }

  // ── Measurement helpers ────────────────────────────────────────────────

  private measureCpu(): number {
    // Delta między bieżącym a poprzednim cpu times — zwraca % usage.
    const cpus = os.cpus()
    let idle = 0
    let total = 0
    for (const cpu of cpus) {
      const times = cpu.times
      idle += times.idle
      total += times.user + times.nice + times.sys + times.idle + times.irq
    }
    const idleDelta = idle - this.prevCpuTotals.idle
    const totalDelta = total - this.prevCpuTotals.total
    this.prevCpuTotals = { idle, total }
    if (totalDelta === 0) return 0
    const usage = (1 - idleDelta / totalDelta) * 100
    return Math.max(0, Math.min(100, Math.round(usage * 10) / 10))
  }

  /**
   * Mierzy zużycie RAM tak jak Activity Monitor / `free -m available`, nie
   * `os.freemem()`.
   *
   * BUG na macOS: `os.freemem()` zwraca TYLKO `Pages free` z `vm_stat` —
   * pomija inactive/speculative/purgeable, które kernel cache-uje ale natychmiast
   * zwolni gdy proces zażąda. macOS na 8GB pokazywałby 95-99% „zużycia" cały
   * czas (cache wypełnia wolną pamięć). NIE to chcemy pokazać instalatorowi.
   *
   * Działanie:
   *  • macOS — `vm_stat` parse: `used = active + wired_down` (faktycznie zajęte
   *    przez procesy), `total = os.totalmem()` (lub suma wszystkich kategorii).
   *  • Linux — `/proc/meminfo` parse: `used = MemTotal - MemAvailable` (kernel
   *    sam wylicza MemAvailable z free+cache+buffers - 'kontrolowanego buforu').
   *  • Fallback — `os.totalmem() - os.freemem()` jak wcześniej (pessimistic).
   *
   * @returns `{ usedMb, totalMb }` — `used` to faktyczne zużycie procesów,
   *          NIE wliczając cache który system trzyma „na zapas".
   */
  private async measureRam(): Promise<{ usedMb: number; totalMb: number }> {
    const totalMb = Math.round(os.totalmem() / 1024 / 1024)

    if (process.platform === 'darwin') {
      try {
        const { stdout } = await exec('vm_stat', { timeout: 2000 })
        // vm_stat output:
        //   Mach Virtual Memory Statistics: (page size of 16384 bytes)
        //   Pages free:                               123456.
        //   Pages active:                              7890.
        //   Pages inactive:                           45678.
        //   Pages speculative:                         1234.
        //   Pages wired down:                         98765.
        //   ...
        const pageSizeMatch = stdout.match(/page size of (\d+) bytes/)
        const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384
        const getPages = (key: string): number => {
          const re = new RegExp(`Pages ${key}:\\s*(\\d+)`, 'i')
          const m = stdout.match(re)
          return m ? parseInt(m[1], 10) : 0
        }
        const active   = getPages('active')
        const wired    = getPages('wired down')
        // Used = active + wired (faktycznie zajęte przez procesy).
        // Inactive/speculative/purgeable to cache — kernel zwolni w razie potrzeby.
        const usedBytes = (active + wired) * pageSize
        const usedMb = Math.round(usedBytes / 1024 / 1024)
        return { usedMb, totalMb }
      } catch {
        // Fallback do strict free
        return { usedMb: totalMb - Math.round(os.freemem() / 1024 / 1024), totalMb }
      }
    }

    if (process.platform === 'linux') {
      try {
        const raw = await fs.promises.readFile('/proc/meminfo', 'utf-8')
        // MemAvailable jest dostępne na kernelu ≥ 3.14 (od ~2014). Jeśli brak —
        // fallback do MemFree + Buffers + Cached.
        const memTotalMatch = raw.match(/^MemTotal:\s+(\d+)\s+kB/m)
        const memAvailMatch = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m)
        if (memTotalMatch && memAvailMatch) {
          const totalKb = parseInt(memTotalMatch[1], 10)
          const availKb = parseInt(memAvailMatch[1], 10)
          return {
            usedMb: Math.round((totalKb - availKb) / 1024),
            totalMb: Math.round(totalKb / 1024),
          }
        }
      } catch { /* fall through */ }
    }

    // Cross-platform fallback (pessimistic)
    const freeMb = Math.round(os.freemem() / 1024 / 1024)
    return { usedMb: totalMb - freeMb, totalMb }
  }

  private async measureDisk(): Promise<{ usedGb: number; totalGb: number }> {
    try {
      // `df -k /` zwraca KB. Wynik:
      //   Filesystem 1024-blocks Used Available Capacity ...
      //   /dev/disk1   ...        XXX   YYY      ZZ%      ...
      const { stdout } = await exec('df -k /', { timeout: 2000 })
      const lines = stdout.trim().split('\n')
      if (lines.length < 2) return { usedGb: 0, totalGb: 0 }
      const parts = lines[1].split(/\s+/)
      const totalKb = parseInt(parts[1], 10) || 0
      const usedKb = parseInt(parts[2], 10) || 0
      return {
        usedGb: Math.round(usedKb / 1024 / 1024 * 10) / 10,
        totalGb: Math.round(totalKb / 1024 / 1024 * 10) / 10,
      }
    } catch {
      return { usedGb: 0, totalGb: 0 }
    }
  }

  private async measureTemp(): Promise<number | null> {
    // Linux: `/sys/class/thermal/thermal_zone0/temp` daje miligrad C.
    if (process.platform === 'linux') {
      try {
        const raw = await fs.promises.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf-8')
        return Math.round(parseInt(raw.trim(), 10) / 1000)
      } catch {
        return null
      }
    }
    // macOS wymaga sudo `powermetrics` lub osobnego sterownika (smc-cli).
    // Zostawiamy null — UI pokazuje „—" w sparkline.
    return null
  }

  private async measureNet(): Promise<{ inMbps: number; outMbps: number }> {
    try {
      const counter = await this.readNetCounter()
      if (!counter) return { inMbps: 0, outMbps: 0 }
      const now = Date.now()
      if (!this.prevNetCounters) {
        this.prevNetCounters = { ...counter, ts: now }
        return { inMbps: 0, outMbps: 0 }
      }
      const dtSec = (now - this.prevNetCounters.ts) / 1000
      if (dtSec <= 0) return { inMbps: 0, outMbps: 0 }
      const dIn = Math.max(0, counter.ibytes - this.prevNetCounters.ibytes)
      const dOut = Math.max(0, counter.obytes - this.prevNetCounters.obytes)
      this.prevNetCounters = { ...counter, ts: now }
      // bytes/sec → bits/sec → Mbps
      return {
        inMbps:  Math.round((dIn * 8 / 1_000_000 / dtSec) * 100) / 100,
        outMbps: Math.round((dOut * 8 / 1_000_000 / dtSec) * 100) / 100,
      }
    } catch {
      return { inMbps: 0, outMbps: 0 }
    }
  }

  /**
   * Czyta cumulative net counters (bytes in/out) dla aktywnego interfejsu.
   *   macOS: `netstat -ib` — kolumny `Name … Ibytes … Obytes`
   *   Linux: `/proc/net/dev` — `iface: rx_bytes ... tx_bytes ...`
   * Bierzemy pierwszy non-loopback, up interface (en0 / eth0 itp.).
   */
  private async readNetCounter(): Promise<{ ibytes: number; obytes: number } | null> {
    if (process.platform === 'darwin') {
      const { stdout } = await exec('netstat -ib', { timeout: 2000 })
      // Format:
      // Name  Mtu  Network  Address  Ipkts  Ierrs  Ibytes  Opkts  Oerrs  Obytes  Coll
      // en0   1500 ...               12345          67890        ...           90123
      const lines = stdout.split('\n')
      for (const line of lines) {
        if (line.startsWith('en0') || line.startsWith('en1')) {
          const parts = line.split(/\s+/)
          // Indeksy bazują na standardowym output netstat -ib. Strażnik na
          // wypadek odchyleń (różne fw macOS).
          if (parts.length < 10) continue
          const ibytes = parseInt(parts[6], 10)
          const obytes = parseInt(parts[9], 10)
          if (Number.isFinite(ibytes) && Number.isFinite(obytes)) {
            return { ibytes, obytes }
          }
        }
      }
      return null
    }
    if (process.platform === 'linux') {
      try {
        const raw = await fs.promises.readFile('/proc/net/dev', 'utf-8')
        const lines = raw.split('\n').slice(2) // skip headers
        for (const line of lines) {
          const t = line.trim()
          if (!t || t.startsWith('lo:')) continue
          const [name, rest] = t.split(':')
          if (!name.match(/^(eth|en|ens|enp)/)) continue
          const parts = (rest ?? '').trim().split(/\s+/)
          const ibytes = parseInt(parts[0], 10)
          const obytes = parseInt(parts[8], 10)
          if (Number.isFinite(ibytes) && Number.isFinite(obytes)) {
            return { ibytes, obytes }
          }
        }
        return null
      } catch {
        return null
      }
    }
    return null
  }

  private async countOnlineDevices(): Promise<number> {
    try {
      // `getDeviceTree()` zwraca Promise (kosztowne — ping wszystkich urządzeń).
      // Dla 1-min sample-a to OK; gdyby kiedyś wstawiać szybsze próbki (10s),
      // dorzucić caching w DeviceRegistry.
      const tree = await this.deviceRegistry.getDeviceTree()
      let count = 0
      for (const group of tree) {
        for (const node of (group as any).devices ?? []) {
          if (node.online) count++
        }
      }
      return count
    } catch {
      return 0
    }
  }

  // ── Helpers do SystemInfo (z `/api/system`) ────────────────────────────

  getMac(): string | null {
    const ifaces = os.networkInterfaces()
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] ?? []) {
        if (iface.family === 'IPv4' && !iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          return iface.mac.toUpperCase()
        }
      }
    }
    return null
  }

  getCpuModel(): string {
    const cpus = os.cpus()
    if (cpus.length === 0) return 'unknown'
    return `${cpus[0].model} (${cpus.length} cores)`
  }
}
