/**
 * REST endpoint dla wizard-a w panelu webowym.
 *
 * Flow integratora:
 *   1. Web `POST /devices/discover` z body `{ protocols, timeoutMs }`
 *      → Edge zwraca `{ runId, status: 'running', startedAt }`.
 *   2. Web pollu je `GET /devices/discover/:runId` co 1-2 sek aż
 *      `status === 'done'`, wtedy renderuje listę `candidates`.
 *   3. User wybiera kandydata → wizard pre-fillu je formularz drivera
 *      (ip, port, mac, suggestedDriverId, suggestedType).
 *
 * Multi-tenant: discovery jest LAN-scoped, więc nie wymaga buildingId —
 * Edge jest fizycznie w jednej sieci budynku. Autoryzacja przyjdzie z tunelu
 * (POST jest dostępny tylko z chmury przez WS proxy lub bezpośrednio z LAN
 * przez integrator-a wpiętego do panelu Edge `/ui`).
 */
import { Body, Controller, Get, Param, Post, BadRequestException, NotFoundException } from '@nestjs/common'
import { DiscoveryService } from './discovery.service'
import { EventLogService } from '../event-log/event-log.service'
import type { DiscoveryStartOpts, DiscoveryProtocol } from './discovery.types'

@Controller('devices/discover')
export class DiscoveryController {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly eventLog: EventLogService,
  ) {}

  @Post()
  startScan(@Body() body: DiscoveryStartOpts = {}) {
    // Walidacja protokołów — żeby user nie wstrzyknął innej nazwy.
    if (body.protocols) {
      if (!Array.isArray(body.protocols)) {
        throw new BadRequestException('`protocols` must be an array')
      }
      const allowed: DiscoveryProtocol[] = ['mdns', 'knxnet-ip']
      for (const p of body.protocols) {
        if (!allowed.includes(p)) {
          throw new BadRequestException(`Unsupported protocol: ${p}. Allowed: ${allowed.join(', ')}`)
        }
      }
    }
    if (body.timeoutMs && (typeof body.timeoutMs !== 'number' || body.timeoutMs < 1000)) {
      throw new BadRequestException('`timeoutMs` must be a number >= 1000')
    }

    const run = this.discovery.start(body)
    this.eventLog.info(
      'DISCOVERY',
      `🔍 LAN scan started (${run.protocols.join(', ')}, ${run.timeoutMs}ms)`,
      { runId: run.id },
    )

    // Zwracamy uproszczony widok (bez `candidates: []` — pusty na starcie)
    return {
      runId: run.id,
      status: run.status,
      protocols: run.protocols,
      timeoutMs: run.timeoutMs,
      startedAt: run.startedAt,
    }
  }

  @Get(':runId')
  getRun(@Param('runId') runId: string) {
    const run = this.discovery.getRun(runId)
    if (!run) throw new NotFoundException(`Run ${runId} not found (expired after 5 min)`)
    return run
  }

  @Get()
  listRuns() {
    // Zwraca listę run-ów z ostatnich 5 min — przydatne do diagnostyki.
    // Bez pełnych `candidates[]` per run (mniej JSON-a), tylko meta.
    return this.discovery.listRuns().map((r) => ({
      id: r.id,
      status: r.status,
      protocols: r.protocols,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      candidateCount: r.candidates.length,
    }))
  }
}
