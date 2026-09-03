/**
 * DiscoveryService — orchestrator wykrywania urządzeń w LAN.
 *
 * Wystawia 2 metody:
 *   • `start(opts)` — uruchamia run, zwraca natychmiast `{ runId }`. Run leci
 *     w tle (Promise.allSettled na adapterach), wynik kumulowany w mapie.
 *   • `getRun(runId)` — odczyt stanu + listy kandydatów.
 *
 * Po `done` run zostaje 5 minut w pamięci (UI musi mieć czas zassać),
 * potem cron-GC kasuje.
 *
 * Kandydaci są post-procesowani:
 *   • OUI lookup wzbogaca `vendor` (gdy mDNS nie dał) i `suggestedDriverId`
 *     (gdy mDNS nie matchował driver-a po service-name).
 *   • Deduplikacja po (ip, mac) — kandidat znaleziony przez mDNS i KNXnet/IP
 *     to jeden wpis, ale `foundVia` mówi „mdns,knxnet-ip" (concat).
 */
import { Injectable, Logger } from '@nestjs/common'
import { v4 as uuidv4 } from 'uuid'
import { mdnsBrowseAll } from './mdns.adapter'
import { knxnetIpSearch } from './knxnet-ip.adapter'
import { lanScan } from './lan-scan.adapter'
import { lookupOui, normalizeMac } from './oui-lookup'
import type {
  DiscoveryRun,
  DiscoveryCandidate,
  DiscoveryStartOpts,
  DiscoveryProtocol,
} from './discovery.types'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS     = 60_000
const RUN_RETENTION_MS   = 5 * 60_000  // 5 min — po `done` trzymamy wynik dla UI

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name)
  /** Aktywne i niedawno zakończone run-y. Klucz = runId. */
  private readonly runs = new Map<string, DiscoveryRun>()
  /** GC interval — czyści runs starsze niż retention. */
  private gcTimer?: NodeJS.Timeout

  constructor() {
    this.gcTimer = setInterval(() => this.gcOldRuns(), 60_000)
  }

  onModuleDestroy() {
    if (this.gcTimer) clearInterval(this.gcTimer)
  }

  // ────────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────────

  start(opts: DiscoveryStartOpts = {}): DiscoveryRun {
    // `lan-scan` w domyślnym zestawie: bez niego urządzenia nierozgłaszające się
    // (Akuvox) nigdy nie trafiały na listę i instalator wpisywał je ręcznie.
    const protocols: DiscoveryProtocol[] = opts.protocols ?? ['mdns', 'knxnet-ip', 'lan-scan']
    const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

    const run: DiscoveryRun = {
      id: uuidv4(),
      status: 'running',
      protocols,
      timeoutMs,
      startedAt: Date.now(),
      candidates: [],
    }
    this.runs.set(run.id, run)

    this.logger.log(`Discovery run ${run.id} started: protocols=[${protocols.join(',')}], timeout=${timeoutMs}ms`)

    // Run w tle — nie blokujemy odpowiedzi HTTP
    this.executeRun(run).catch((err) => {
      this.logger.error(`Run ${run.id} crashed: ${err.message}`)
      run.status = 'error'
      run.error = err.message
      run.finishedAt = Date.now()
    })

    return run
  }

  getRun(runId: string): DiscoveryRun | null {
    return this.runs.get(runId) ?? null
  }

  listRuns(): DiscoveryRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internal
  // ────────────────────────────────────────────────────────────────────────

  private async executeRun(run: DiscoveryRun): Promise<void> {
    const tasks: Promise<DiscoveryCandidate[]>[] = []

    if (run.protocols.includes('mdns')) {
      tasks.push(this.safeRun('mdns', () => mdnsBrowseAll(run.timeoutMs)))
    }
    if (run.protocols.includes('knxnet-ip')) {
      tasks.push(this.safeRun('knxnet-ip', () => knxnetIpSearch(run.timeoutMs)))
    }
    // Aktywny skan sieci — znajduje urządzenia, które się nie ogłaszają
    // (Akuvox nie rozgłasza mDNS, więc bez tego był niewidoczny).
    if (run.protocols.includes('lan-scan')) {
      tasks.push(this.safeRun('lan-scan', () => lanScan(run.timeoutMs)))
    }

    const results = await Promise.allSettled(tasks)
    const merged: DiscoveryCandidate[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') merged.push(...r.value)
    }

    // Wzbogacenie OUI: gdy `vendor` lub `suggestedDriverId` puste,
    // a `mac` znany — dorzucamy z OUI mapy.
    for (const c of merged) {
      const mac = normalizeMac(c.mac)
      if (!mac) continue
      const oui = lookupOui(mac)
      if (oui) {
        if (!c.vendor) c.vendor = oui.manufacturer
        if (!c.suggestedDriverId && oui.suggestedDriverIds.length > 0) {
          c.suggestedDriverId = oui.suggestedDriverIds[0]
          c.alternativeDrivers = oui.suggestedDriverIds.slice(1)
        }
      }
    }

    // Dedup po samym IP. Pierwszy wpis zostaje; reszta merguje `foundVia`
    // i dopełnia pola brakujące w pierwszym.
    //
    // Klucz był wcześniej `ip|mac` i to dawało DUPLIKATY: mDNS nie zna adresu
    // sprzętowego, a skan sieci zna — więc to samo urządzenie trafiało na
    // listę dwa razy, raz bez producenta (2026-08-07). W sieci lokalnej adres
    // IP jednoznacznie identyfikuje urządzenie w danej chwili, więc wystarcza;
    // MAC i tak dopełniamy przy scalaniu poniżej.
    const deduped = new Map<string, DiscoveryCandidate>()
    for (const c of merged) {
      const key = c.ip
      const existing = deduped.get(key)
      if (!existing) {
        deduped.set(key, c)
      } else {
        // Merge — jeden zostaje główny, ale dopełniamy
        if (!existing.mac && c.mac) existing.mac = c.mac
        if (!existing.vendor && c.vendor) existing.vendor = c.vendor
        if (!existing.suggestedDriverId && c.suggestedDriverId) {
          existing.suggestedDriverId = c.suggestedDriverId
          existing.alternativeDrivers = c.alternativeDrivers
        }
        if (!existing.txt && c.txt) existing.txt = c.txt
        else if (existing.txt && c.txt) Object.assign(existing.txt, c.txt)
        // foundVia: concat unikalnych protokołów
        if (existing.foundVia !== c.foundVia) {
          existing.foundVia = `${existing.foundVia},${c.foundVia}` as any
        }
      }
    }

    run.candidates = [...deduped.values()]
    run.status = 'done'
    run.finishedAt = Date.now()

    this.logger.log(
      `Discovery run ${run.id} done: ${run.candidates.length} candidate(s) in ${run.finishedAt - run.startedAt}ms`,
    )
  }

  /**
   * Wrapper na adapter — łapie wyjątki i zwraca pustą tablicę (zamiast crashować
   * cały run gdy jeden protokół padnie, np. brak uprawnień do multicast).
   */
  private async safeRun(
    name: string,
    fn: () => Promise<DiscoveryCandidate[]>,
  ): Promise<DiscoveryCandidate[]> {
    try {
      return await fn()
    } catch (err: any) {
      this.logger.warn(`Adapter ${name} failed: ${err.message}`)
      return []
    }
  }

  /** Kasuje run-y zakończone dłużej niż RUN_RETENTION_MS. */
  private gcOldRuns() {
    const now = Date.now()
    for (const [id, run] of this.runs) {
      if (run.status !== 'running' && run.finishedAt && now - run.finishedAt > RUN_RETENTION_MS) {
        this.runs.delete(id)
      }
    }
  }
}
