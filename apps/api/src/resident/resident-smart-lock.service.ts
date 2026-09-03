/**
 * ResidentSmartLockService — onboarding zamka Nuki PRZEZ MIESZKAŃCA
 * (świadoma zgoda, 2026-07-09).
 *
 * Druga ścieżka dodania zamka obok flow Integratora
 * (`IntegratorService.createSmartLock`). Ta sama architektura bezpieczeństwa:
 *   • token API Nuki NIGDY nie ląduje w Postgres ani w logach Cloud —
 *     płynie pass-through bezpośrednim HTTP do Edge (`POST/PATCH/DELETE
 *     /devices`), token trzymany WYŁĄCZNIE w `device_config` sqlite Edge
 *     (jak hasła kamer). Mirror DEVICE_UPSERT sanityzuje `apiToken`
 *     → `apiTokenIsSet` po stronie Cloud (EdgeGateway.sanitizeDeviceConfig).
 *   • Cloud NIE woła Nuki bezpośrednio — listowanie zamków (`verify`) też
 *     deleguje do Edge (`POST /devices/smart-lock/list-smartlocks`).
 *
 * PRYWATNOŚĆ / IZOLACJA LOKALU (krytyczne):
 *   • mieszkaniec może podpiąć zamek TYLKO do WŁASNEGO lokalu — `unitId`
 *     wyliczany z pivotu `unit_residents` (aktywne okno), NIGDY z body.
 *   • usunięcie / status zamka też weryfikuje że AP należy do lokalu
 *     mieszkańca (`unitId ∈ activeUnitIds`).
 *   • token nie jest przekazywany do żadnego `this.logger` ani AccessEvent.
 */
import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  BadGatewayException,
  ConflictException,
} from '@nestjs/common'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'
import * as crypto from 'crypto'
import { PrismaService } from '../prisma/prisma.service'
import { EdgeGateway } from '../edge/edge.gateway'
import { AccessEventsService } from '../access-events/access-events.service'

// Ten sam Tailscale userspace proxy co w ResidentService / IntegratorService.
const edgeDispatcher: Dispatcher | undefined = process.env.TS_HTTP_PROXY
  ? new ProxyAgent(process.env.TS_HTTP_PROXY)
  : undefined

/** 409 gdy lokal ma już zamek a mieszkaniec nie potwierdził nadpisania. */
export const SMART_LOCK_EXISTS_CODE = 'SMART_LOCK_EXISTS'

/**
 * Krótki cache live-stanu zamka z Edge (per deviceUuid). Nuki Web API ma
 * rate-limity, a `GET /resident/smart-lock` bywa wołany przy każdym otwarciu
 * ekranu (ProfileView / Glass deck + pull-to-refresh). 12 s to kompromis:
 * status wygląda „na żywo", a nie bijemy Nuki przy każdym wejściu na ekran.
 * Po otwarciu zamka klient ponawia z `?fresh=1` (patrz `status`), co omija
 * cache i pokazuje zmianę stanu.
 */
interface CachedLockState {
  ts: number
  online: boolean
  lockState: number | null
  lockStateLabel: string | null
  doorState: number | null
  doorStateLabel: string | null
  batteryCritical: boolean | null
}
const LOCK_STATE_TTL_MS = 12_000
const lockStateCache = new Map<string, CachedLockState>()

export interface SmartLockListItem {
  smartlockId: string
  name: string
}

@Injectable()
export class ResidentSmartLockService {
  private readonly logger = new Logger(ResidentSmartLockService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly edgeGateway: EdgeGateway,
    private readonly accessEvents: AccessEventsService,
  ) {}

  /** Aktywne lokale mieszkańca (unit_residents, sinceDate<=NOW<untilDate). */
  private async activeUnitIds(residentId: number, buildingId: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<{ unitId: number }[]>`
      SELECT ur."unitId"
        FROM unit_residents ur
        JOIN units u ON u.id = ur."unitId"
       WHERE ur."residentId" = ${residentId}
         AND u."buildingId" = ${buildingId}
         AND ur."sinceDate" <= NOW()
         AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
       ORDER BY ur."unitId" ASC
    `
    return rows.map((r) => r.unitId)
  }

  /**
   * Wybór lokalu, do którego mieszkaniec podpina zamek. Gdy podał `unitId`
   * w body — MUSI należeć do jego aktywnych lokali (izolacja). Gdy nie podał,
   * a ma dokładnie jeden lokal — bierzemy go. Przy wielu lokalach bez
   * jawnego wyboru → 400 (żeby nie zgadywać).
   */
  private async resolveOwnedUnit(
    residentId: number,
    buildingId: number,
    requestedUnitId?: number | null,
  ): Promise<number> {
    const owned = await this.activeUnitIds(residentId, buildingId)
    if (owned.length === 0) {
      throw new BadRequestException('Nie masz przypisanego lokalu w tym budynku')
    }
    if (requestedUnitId != null) {
      if (!owned.includes(requestedUnitId)) {
        // NIE ujawniamy istnienia cudzego lokalu — 404.
        throw new NotFoundException('Lokal nie istnieje')
      }
      return requestedUnitId
    }
    if (owned.length > 1) {
      throw new BadRequestException('Masz kilka lokali — wskaż, do którego dodać zamek (unitId)')
    }
    return owned[0]
  }

  private async getActiveEdgeIp(buildingId: number): Promise<string> {
    const liveIp = this.edgeGateway.getEdgeIpForBuilding(buildingId)
    if (liveIp) return liveIp
    const edge = await this.prisma.edgeDevice.findFirst({
      where: { buildingId, type: 'EDGE', isActivated: true },
      orderBy: { lastSeenAt: 'desc' },
    })
    if (!edge?.ipAddress) throw new NotFoundException('Brak aktywnego urządzenia Edge z adresem IP')
    return edge.ipAddress
  }

  private unitLabel(unit: { street: string | null; number: string | null; id: number }): string {
    return [unit.street, unit.number].filter(Boolean).join(' ') || `Lokal ${unit.id}`
  }

  // ── POST /resident/smart-lock/verify ──────────────────────────────────────
  /**
   * Token → Edge → Nuki `GET /smartlock`. Zwraca listę `{ smartlockId, name }`.
   * Token NIE jest logowany (przekazany tylko do Edge, response bez tokenu).
   */
  async verify(
    residentId: number,
    buildingId: number,
    apiToken: string,
  ): Promise<{ smartlocks: SmartLockListItem[] }> {
    const token = String(apiToken ?? '').trim()
    if (token.length < 10) {
      throw new BadRequestException('Podaj token API Nuki (web.nuki.io → Account → API)')
    }
    // Mieszkaniec musi mieć lokal — inaczej nie ma po co listować.
    await this.resolveOwnedUnit(residentId, buildingId, null).catch((e) => {
      // Przy wielu lokalach resolveOwnedUnit rzuca 400 — ale do samego
      // listowania lokal nie jest potrzebny, więc tolerujemy ten przypadek.
      if (e instanceof BadRequestException && /kilka lokali/.test(e.message)) return 0
      throw e
    })
    const ip = await this.getActiveEdgeIp(buildingId)
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices/smart-lock/list-smartlocks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: token }),
        signal: AbortSignal.timeout(15_000),
        dispatcher: edgeDispatcher,
      })
      const data: any = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.message ?? `Edge HTTP ${res.status}`)
      const smartlocks: SmartLockListItem[] = Array.isArray(data?.smartlocks) ? data.smartlocks : []
      return { smartlocks }
    } catch (err: any) {
      throw new BadGatewayException(`Nie udało się pobrać listy zamków Nuki: ${err.message}`)
    }
  }

  // ── POST /resident/smart-lock ─────────────────────────────────────────────
  /**
   * Rejestruje zamek jako AccessPoint UNIT_DOOR lokalu mieszkańca.
   * `unitId` z pivotu (NIE z body). Token pass-through → Edge (NIE do Postgres).
   * Gdy lokal ma już zamek: 409 SMART_LOCK_EXISTS chyba że `replace=true`.
   */
  async create(
    residentId: number,
    buildingId: number,
    body: {
      apiToken?: unknown
      smartlockId?: unknown
      name?: unknown
      unitId?: unknown
      replace?: unknown
    },
  ) {
    const smartlockId = String(body.smartlockId ?? '').trim()
    const apiToken = String(body.apiToken ?? '').trim()
    const name = String(body.name ?? '').trim() || 'Drzwi mieszkania'
    const requestedUnitId =
      body.unitId != null && Number.isInteger(Number(body.unitId)) ? Number(body.unitId) : null
    const replace = body.replace === true

    if (!/^\d{5,20}$/.test(smartlockId)) {
      throw new BadRequestException('Wybierz zamek z listy (smartlockId musi być liczbą)')
    }
    if (apiToken.length < 10) {
      throw new BadRequestException('Podaj token API Nuki (web.nuki.io → Account → API)')
    }

    const unitId = await this.resolveOwnedUnit(residentId, buildingId, requestedUnitId)
    const unit = await this.prisma.unit.findFirst({
      where: { id: unitId, buildingId },
      select: { id: true, number: true, street: true },
    })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')

    // Czy lokal ma już zamek (UNIT_DOOR)? Nadpisanie wymaga potwierdzenia.
    const existing = await this.prisma.accessPoint.findFirst({
      where: { buildingId, category: 'UNIT_DOOR', unitId },
    })
    if (existing && !replace) {
      throw new ConflictException({
        message: 'Ten lokal ma już przypisany zamek. Potwierdź, aby go zastąpić.',
        code: SMART_LOCK_EXISTS_CODE,
        apId: existing.id,
        name: existing.label,
      })
    }

    const ip = await this.getActiveEdgeIp(buildingId)

    // 1. Urządzenie SMART_LOCK na Edge — token pass-through (NIE do Postgres).
    const deviceUuid = crypto.randomUUID()
    try {
      const res = await undiciFetch(`http://${ip}:4000/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'SMART_LOCK',
          config: {
            id: deviceUuid,
            name,
            manufacturer: 'Nuki',
            smartlockId,
            apiToken,
            driverId: 'nuki-web-api',
          },
        }),
        signal: AbortSignal.timeout(10_000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
    } catch (err: any) {
      throw new BadGatewayException(
        `Nie udało się zapisać zamka na urządzeniu budynku (token NIE został nigdzie zapisany): ${err.message}`,
      )
    }

    // 2. Jeśli nadpisujemy — najpierw sprzątamy stary zamek (Edge + AP).
    if (existing) {
      await this.deleteEdgeDevice(ip, existing.deviceId).catch((err) =>
        this.logger.warn(
          `Smart lock (resident replace) — Edge delete starego ${existing.deviceId} failed: ${err.message}`,
        ),
      )
      await this.prisma.accessPoint.delete({ where: { id: existing.id } }).catch(() => undefined)
      this.edgeGateway
        .sendToBuilding(buildingId, 'AP_DELETE', { id: existing.id })
        .catch((err) => this.logger.warn(`AP_DELETE (replace) push failed: ${err.message}`))
    }

    // 3. AccessPoint — metadane w Cloud (bez tokenu).
    const edge = await this.prisma.edgeDevice.findFirst({
      where: { buildingId, type: 'EDGE', isActivated: true },
      orderBy: { lastSeenAt: 'desc' },
    })
    const ap = await this.prisma.accessPoint.create({
      data: {
        buildingId,
        label: name,
        icon: 'door',
        edgeDeviceId: edge?.id ?? null,
        deviceId: deviceUuid,
        relayIndex: 0,
        outputDeviceId: deviceUuid,
        outputIndex: 0,
        durationMs: 800,
        scope: 'RESIDENT',
        category: 'UNIT_DOOR',
        unitId,
        sortOrder: 100,
      },
    })

    // 4. AP_UPSERT przez tunel — spójność syncu Edge.
    this.pushApUpsert(ap).catch((err) =>
      this.logger.warn(`AP_UPSERT (resident smart lock) push failed for ap#${ap.id}: ${err.message}`),
    )

    // 5. Audyt — BEZ tokenu.
    this.logger.log(
      `[audit] SMART_LOCK_CREATE (resident) resident#${residentId} building#${buildingId} ` +
        `unit#${unitId} ap#${ap.id} smartlockId=${smartlockId}${existing ? ' (replaced)' : ''}`,
    )
    this.accessEvents
      .record({
        buildingId,
        type: 'REMOTE_OPEN',
        accessPointId: ap.id,
        gateOpened: false,
        reason: existing ? 'SMART_LOCK_REPLACED (resident)' : 'SMART_LOCK_REGISTERED (resident)',
        residentId,
        openedById: residentId,
        openedByType: 'RESIDENT',
        meta: { action: 'smart_lock_register', provider: 'nuki', unitId, smartlockId },
      })
      .catch(() => undefined)

    return {
      apId: ap.id,
      label: ap.label,
      unitId: ap.unitId,
      unitLabel: this.unitLabel(unit),
      deviceUuid,
      isActive: ap.isActive,
      replaced: !!existing,
    }
  }

  // ── DELETE /resident/smart-lock/:apId ─────────────────────────────────────
  async remove(residentId: number, buildingId: number, apId: number) {
    const ap = await this.prisma.accessPoint.findFirst({
      where: { id: apId, buildingId, category: 'UNIT_DOOR' },
    })
    if (!ap || ap.unitId == null) throw new NotFoundException('Zamek nie istnieje')

    // Izolacja: AP musi należeć do lokalu MIESZKAŃCA.
    const owned = await this.activeUnitIds(residentId, buildingId)
    if (!owned.includes(ap.unitId)) throw new NotFoundException('Zamek nie istnieje')

    // Edge best-effort — jeśli offline, AP i tak kasujemy.
    try {
      const ip = await this.getActiveEdgeIp(buildingId)
      await this.deleteEdgeDevice(ip, ap.deviceId)
    } catch (err: any) {
      this.logger.warn(
        `Smart lock (resident) Edge delete failed (device ${ap.deviceId}): ${err.message}`,
      )
    }

    await this.prisma.accessPoint.delete({ where: { id: apId } })
    this.edgeGateway
      .sendToBuilding(buildingId, 'AP_DELETE', { id: apId })
      .catch((err) => this.logger.warn(`AP_DELETE push failed for ap#${apId}: ${err.message}`))

    this.logger.log(
      `[audit] SMART_LOCK_DELETE (resident) resident#${residentId} building#${buildingId} ` +
        `unit#${ap.unitId} ap#${apId}`,
    )
    this.accessEvents
      .record({
        buildingId,
        type: 'REMOTE_OPEN',
        accessPointId: null,
        gateOpened: false,
        reason: 'SMART_LOCK_REMOVED (resident)',
        residentId,
        openedById: residentId,
        openedByType: 'RESIDENT',
        meta: { action: 'smart_lock_remove', provider: 'nuki', unitId: ap.unitId, apId },
      })
      .catch(() => undefined)

    return { deleted: true }
  }

  // ── GET /resident/smart-lock ──────────────────────────────────────────────
  /**
   * Status zamka lokalu (jest/brak, nazwa) — BEZ tokenu. Best-effort live stan
   * z Edge: `lockState/lockStateLabel` (rygiel) + `doorState/doorStateLabel`
   * (czujnik drzwi, jeśli jest) + `batteryCritical` + `online`. Błąd Edge/Nuki
   * → `online=false` (nie wywala listy). `fresh=true` omija 12 s cache
   * (klient po otwarciu zamka ponawia, żeby zobaczyć zmianę stanu).
   */
  async status(residentId: number, buildingId: number, opts?: { fresh?: boolean }) {
    const owned = await this.activeUnitIds(residentId, buildingId)
    if (owned.length === 0) return { locks: [] as any[] }

    const aps = await this.prisma.accessPoint.findMany({
      where: { buildingId, category: 'UNIT_DOOR', unitId: { in: owned } },
      include: { unit: { select: { id: true, number: true, street: true } } },
      orderBy: { id: 'asc' },
    })

    const locks = await Promise.all(
      aps.map(async (ap) => {
        const state = await this.fetchLockState(buildingId, ap.deviceId, opts?.fresh === true)
        return {
          apId: ap.id,
          name: ap.label,
          unitId: ap.unitId,
          unitLabel: ap.unit ? this.unitLabel(ap.unit) : null,
          isActive: ap.isActive,
          online: state?.online ?? false,
          // Rygiel (lock). `stateLabel` zostaje jako alias dla starszego iOS.
          lockState: state?.lockState ?? null,
          lockStateLabel: state?.lockStateLabel ?? null,
          stateLabel: state?.lockStateLabel ?? null,
          // Czujnik drzwi (null gdy zamek go nie ma / wyłączony).
          doorState: state?.doorState ?? null,
          doorStateLabel: state?.doorStateLabel ?? null,
          batteryCritical: state?.batteryCritical ?? null,
        }
      }),
    )
    return { locks }
  }

  /**
   * Live stan zamka z Edge z krótkim cache (12 s, per deviceUuid). `fresh`
   * omija cache. Zwraca `null` gdy nie udało się odczytać (Edge offline /
   * Nuki błąd / stary Edge bez pól) — caller mapuje na `online=false`.
   */
  private async fetchLockState(
    buildingId: number,
    deviceUuid: string,
    fresh: boolean,
  ): Promise<CachedLockState | null> {
    const now = Date.now()
    if (!fresh) {
      const cached = lockStateCache.get(deviceUuid)
      if (cached && now - cached.ts < LOCK_STATE_TTL_MS) return cached
    }
    try {
      const ip = await this.getActiveEdgeIp(buildingId)
      const res = await undiciFetch(`http://${ip}:4000/devices/${deviceUuid}/smart-lock/state`, {
        signal: AbortSignal.timeout(8000),
        dispatcher: edgeDispatcher,
      })
      if (!res.ok) return lockStateCache.get(deviceUuid) ?? null
      const d: any = await res.json().catch(() => null)
      if (!d?.ok) return lockStateCache.get(deviceUuid) ?? null
      const entry: CachedLockState = {
        ts: now,
        online: true,
        // `lockState`/`lockStateLabel` z nowego Edge; fallback do `state`/
        // `stateLabel` na wypadek starszego builda Edge (kompatybilność).
        lockState: d.lockState ?? d.state ?? null,
        lockStateLabel: d.lockStateLabel ?? d.stateLabel ?? null,
        doorState: d.doorState ?? null,
        doorStateLabel: d.doorStateLabel ?? null,
        batteryCritical: d.batteryCritical ?? null,
      }
      lockStateCache.set(deviceUuid, entry)
      return entry
    } catch {
      // Best-effort — brak Edge/online nie blokuje statusu. Zwróć ostatni znany
      // stan z cache jeśli jest (choćby przeterminowany) — lepszy niż nic.
      return lockStateCache.get(deviceUuid) ?? null
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private async deleteEdgeDevice(ip: string, deviceUuid: string): Promise<void> {
    const res = await undiciFetch(`http://${ip}:4000/devices/${deviceUuid}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10_000),
      dispatcher: edgeDispatcher,
    })
    if (!res.ok) throw new Error(`Edge HTTP ${res.status}`)
  }

  private async pushApUpsert(ap: {
    id: number
    buildingId: number
    label: string
    icon: string
    scope: string | null
    category: string
    outputDeviceId: string | null
    outputIndex: number | null
    durationMs: number | null
    isActive: boolean
    sortOrder: number | null
    deviceId: string
    relayIndex: number
  }): Promise<void> {
    await this.edgeGateway.sendToBuilding(ap.buildingId, 'AP_UPSERT', {
      id: ap.id,
      buildingId: ap.buildingId,
      label: ap.label,
      icon: ap.icon,
      scope: ap.scope ?? 'RESIDENT',
      category: ap.category,
      outputDeviceId: ap.outputDeviceId ?? null,
      outputIndex: ap.outputIndex ?? null,
      durationMs: ap.durationMs ?? 800,
      isActive: ap.isActive,
      sortOrder: ap.sortOrder ?? 0,
      deviceId: ap.deviceId,
      relayIndex: ap.relayIndex,
    })
  }
}
