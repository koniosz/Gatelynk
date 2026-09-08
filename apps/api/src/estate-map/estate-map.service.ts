/**
 * Mapa osiedla — konfiguracja + przypisania miejsc do lokali (2026-09-08).
 *
 * Reguły (docs paczki „gatelynk-mapa-villa-natura"):
 *   • przypisanie identyfikuje osiedle + obszar na mapie + część A/B,
 *   • klucz przypisania = ID lokalu z bazy, nigdy adres (adres tylko do
 *     wyświetlania/wyszukiwania — „nie zgaduj nieczytelnych adresów"),
 *   • max 1 lokal w miejscu i max 1 miejsce per lokal (UNIQUE w bazie),
 *   • część B odrzucana tam, gdzie obszar ma 1 lokal; nieznane obszary/
 *     części/lokale → 404/400,
 *   • wymiana przypisania ATOMOWA (transakcja: zwolnienie starego + zajęcie
 *     nowego), a równoczesna edycja dwóch administratorów serializowana
 *     blokadą doradczą per osiedle + wykrywana przez `expectedUnitId`
 *     (optymistyczna kontrola: klient mówi, co widział w tym miejscu).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { formatUnitLabel } from '../common/unit-label'
import { sortUnits } from '../common/natural-sort'
import {
  EstateMapAssignment,
  EstateMapBuildingArea,
  EstateMapConfigInput,
  EstateMapOut,
  EstateMapUnit,
  EstateSlotKey,
} from './estate-map.types'

/** Przestrzeń blokady doradczej Postgresa (pg_advisory_xact_lock(ns, buildingId)). */
const LOCK_NS = 4_713_02

export interface AssignSlotInput {
  unitId: number
  /** Co klient widział w tym miejscu (null = puste). Niezgodność → 409 STALE. */
  expectedUnitId?: number | null
  /** Zgoda na zastąpienie lokalu, który już zajmuje to miejsce. */
  replace?: boolean
  /** Zgoda na przeniesienie lokalu z innego miejsca na mapie. */
  move?: boolean
}

export interface UnlinkSlotInput {
  expectedUnitId?: number | null
}

@Injectable()
export class EstateMapService {
  private readonly logger = new Logger(EstateMapService.name)

  constructor(private readonly prisma: PrismaService) {}

  // ── Odczyt ────────────────────────────────────────────────────────────────

  async get(buildingId: number, buildingIds: number[]) {
    this.guard(buildingId, buildingIds)
    const [map, assignments, units] = await Promise.all([
      this.prisma.estateMap.findUnique({ where: { buildingId } }),
      this.loadAssignments(buildingId),
      this.loadUnits(buildingId),
    ])
    return { map: map ? this.mapOut(map) : null, assignments, units }
  }

  // ── Konfiguracja mapy ─────────────────────────────────────────────────────

  async upsertConfig(buildingId: number, buildingIds: number[], input: EstateMapConfigInput) {
    this.guard(buildingId, buildingIds)
    const cfg = this.validateConfig(input)
    const data = {
      name: cfg.name,
      imageUrl: cfg.imageUrl,
      canvasWidth: cfg.canvas.width,
      canvasHeight: cfg.canvas.height,
      config: {
        buildings: cfg.buildings,
        gates: cfg.gates ?? [],
        streets: cfg.streets ?? [],
        geometryStatus: cfg.geometryStatus ?? null,
        addressStatus: cfg.addressStatus ?? null,
      } as unknown as Prisma.InputJsonValue,
    }
    const saved = await this.prisma.estateMap.upsert({
      where: { buildingId },
      create: { buildingId, ...data },
      update: data,
    })

    // Przypisania do obszarów/części, których nie ma w nowej konfiguracji,
    // usuwamy JAWNIE (z logiem) — inaczej wisiałyby jako sieroty bez miejsca.
    const valid = new Set(cfg.buildings.flatMap((b) => b.slots.map((s) => `${b.id}:${s}`)))
    const existing = await this.prisma.estateMapSlot.findMany({ where: { buildingId } })
    const stale = existing.filter((r) => !valid.has(`${r.mapBuildingId}:${r.slot}`))
    if (stale.length) {
      await this.prisma.estateMapSlot.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } })
      this.logger.warn(
        `estate-map b${buildingId}: nowa konfiguracja usunęła ${stale.length} przypisań ` +
          `(${stale.map((s) => `${s.mapBuildingId}/${s.slot}→unit ${s.unitId}`).join(', ')})`,
      )
    }
    return {
      map: this.mapOut(saved),
      removedAssignments: stale.length,
      assignments: await this.loadAssignments(buildingId),
    }
  }

  // ── Przypisania ───────────────────────────────────────────────────────────

  async assign(
    buildingId: number,
    buildingIds: number[],
    mapBuildingId: string,
    slotRaw: string,
    input: AssignSlotInput,
    adminId: number | null,
  ) {
    this.guard(buildingId, buildingIds)
    const slot = this.normalizeSlot(slotRaw)
    const { area } = await this.requireArea(buildingId, mapBuildingId, slot)

    const unitId = Number(input?.unitId)
    if (!Number.isInteger(unitId) || unitId <= 0) throw new BadRequestException('Podaj identyfikator lokalu')
    const unit = await this.prisma.unit.findFirst({
      where: { id: unitId, buildingId },
      include: { stairwell: true },
    })
    if (!unit) throw new NotFoundException('Lokal nie należy do tego osiedla')
    const unitLabel = formatUnitLabel({
      number: unit.number, street: unit.street, stairwellName: unit.stairwell?.name ?? null,
    })

    let released: Array<{ mapBuildingId: string; slot: string; unitId: number }> = []
    let noop = false
    try {
      await this.prisma.$transaction(async (tx) => {
        // Serializacja równoczesnych edycji w obrębie osiedla — dwóch
        // administratorów klikających naraz wchodzi tu po kolei.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, ${buildingId}::int)`

        const current = await tx.estateMapSlot.findUnique({
          where: { buildingId_mapBuildingId_slot: { buildingId, mapBuildingId, slot } },
        })
        if (input.expectedUnitId !== undefined && (current?.unitId ?? null) !== (input.expectedUnitId ?? null)) {
          throw new ConflictException({
            code: 'STALE',
            message: 'Ktoś zmienił to miejsce w międzyczasie. Odświeżono mapę — sprawdź i spróbuj ponownie.',
            currentUnitId: current?.unitId ?? null,
          })
        }
        if (current && current.unitId === unitId) {
          noop = true
          return
        }
        if (current && !input.replace) {
          throw new ConflictException({
            code: 'SLOT_OCCUPIED',
            message: `Część ${slot} budynku „${area.label}" ma już przypisany lokal. Potwierdź zastąpienie.`,
            occupantUnitId: current.unitId,
          })
        }
        const elsewhere = await tx.estateMapSlot.findUnique({ where: { unitId } })
        if (elsewhere && !input.move) {
          throw new ConflictException({
            code: 'UNIT_ASSIGNED_ELSEWHERE',
            message: `Lokal ${unitLabel} jest już przypisany do innego miejsca na mapie. Potwierdź przeniesienie.`,
            mapBuildingId: elsewhere.mapBuildingId,
            slot: elsewhere.slot,
          })
        }
        // Atomowo: zwolnienie starych miejsc + zajęcie nowego w JEDNEJ transakcji.
        if (elsewhere) {
          await tx.estateMapSlot.delete({ where: { id: elsewhere.id } })
          released.push({ mapBuildingId: elsewhere.mapBuildingId, slot: elsewhere.slot, unitId: elsewhere.unitId })
        }
        if (current) {
          await tx.estateMapSlot.delete({ where: { id: current.id } })
          released.push({ mapBuildingId: current.mapBuildingId, slot: current.slot, unitId: current.unitId })
        }
        await tx.estateMapSlot.create({
          data: { buildingId, mapBuildingId, slot, unitId, assignedById: adminId },
        })
      })
    } catch (err: any) {
      // Backstop: UNIQUE w bazie złapał wyścig mimo blokady (np. dwie instancje API).
      if (err?.code === 'P2002') {
        throw new ConflictException({
          code: 'RACE',
          message: 'Przypisanie zmieniło się równocześnie. Odśwież mapę i spróbuj ponownie.',
        })
      }
      throw err
    }

    this.logger.log(
      `estate-map b${buildingId}: ${noop ? 'noop' : 'assign'} ${mapBuildingId}/${slot} ← unit ${unitId} (${unitLabel})` +
        (released.length ? ` released ${released.map((r) => `${r.mapBuildingId}/${r.slot}`).join(',')}` : '') +
        ` by admin ${adminId ?? '?'}`,
    )
    return {
      ok: true,
      noop,
      assigned: { mapBuildingId, slot, unitId, unitLabel },
      released,
      assignments: await this.loadAssignments(buildingId),
    }
  }

  async unlink(
    buildingId: number,
    buildingIds: number[],
    mapBuildingId: string,
    slotRaw: string,
    input: UnlinkSlotInput,
    adminId: number | null,
  ) {
    this.guard(buildingId, buildingIds)
    const slot = this.normalizeSlot(slotRaw)
    await this.requireArea(buildingId, mapBuildingId, slot)

    let removedUnitId: number | null = null
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, ${buildingId}::int)`
      const current = await tx.estateMapSlot.findUnique({
        where: { buildingId_mapBuildingId_slot: { buildingId, mapBuildingId, slot } },
      })
      if (input?.expectedUnitId !== undefined && (current?.unitId ?? null) !== (input.expectedUnitId ?? null)) {
        throw new ConflictException({
          code: 'STALE',
          message: 'Ktoś zmienił to miejsce w międzyczasie. Odświeżono mapę — sprawdź i spróbuj ponownie.',
          currentUnitId: current?.unitId ?? null,
        })
      }
      if (!current) return
      await tx.estateMapSlot.delete({ where: { id: current.id } })
      removedUnitId = current.unitId
    })

    this.logger.log(`estate-map b${buildingId}: unlink ${mapBuildingId}/${slot} (unit ${removedUnitId ?? 'brak'}) by admin ${adminId ?? '?'}`)
    return { ok: true, removedUnitId, assignments: await this.loadAssignments(buildingId) }
  }

  // ── Helpery ───────────────────────────────────────────────────────────────

  private guard(buildingId: number, buildingIds: number[]) {
    if (!Array.isArray(buildingIds) || !buildingIds.includes(buildingId)) {
      throw new ForbiddenException('Brak dostępu do tego osiedla')
    }
  }

  private normalizeSlot(raw: string): EstateSlotKey {
    const s = String(raw ?? '').trim().toUpperCase()
    if (s !== 'A' && s !== 'B') throw new BadRequestException('Część budynku musi być A lub B')
    return s
  }

  private async requireArea(buildingId: number, mapBuildingId: string, slot: EstateSlotKey) {
    const map = await this.prisma.estateMap.findUnique({ where: { buildingId } })
    if (!map) throw new NotFoundException('To osiedle nie ma skonfigurowanej mapy')
    const cfg = map.config as unknown as { buildings?: EstateMapBuildingArea[] }
    const area = (cfg.buildings ?? []).find((b) => b.id === mapBuildingId)
    if (!area) throw new NotFoundException('Nieznany budynek na mapie')
    if (!area.slots.includes(slot)) {
      throw new BadRequestException(`Budynek „${area.label}" nie ma części ${slot}`)
    }
    return { map, area }
  }

  private mapOut(m: {
    name: string; imageUrl: string; canvasWidth: number; canvasHeight: number; config: unknown; updatedAt: Date
  }): EstateMapOut {
    const cfg = (m.config ?? {}) as Partial<EstateMapConfigInput>
    return {
      name: m.name,
      imageUrl: m.imageUrl,
      canvas: { width: m.canvasWidth, height: m.canvasHeight },
      buildings: cfg.buildings ?? [],
      gates: cfg.gates ?? [],
      streets: cfg.streets ?? [],
      geometryStatus: cfg.geometryStatus ?? null,
      addressStatus: cfg.addressStatus ?? null,
      updatedAt: m.updatedAt.toISOString(),
    }
  }

  private async loadUnits(buildingId: number): Promise<EstateMapUnit[]> {
    const rows = await this.prisma.unit.findMany({
      where: { buildingId },
      include: { stairwell: true },
      orderBy: { number: 'asc' },
    })
    return sortUnits(rows).map((u) => ({
      id: u.id,
      number: u.number,
      street: u.street ?? null,
      stairwellName: u.stairwell?.name ?? null,
      label: formatUnitLabel({ number: u.number, street: u.street, stairwellName: u.stairwell?.name ?? null }),
    }))
  }

  private async loadAssignments(buildingId: number): Promise<EstateMapAssignment[]> {
    const rows = await this.prisma.estateMapSlot.findMany({
      where: { buildingId },
      include: { unit: { include: { stairwell: true } } },
      orderBy: [{ mapBuildingId: 'asc' }, { slot: 'asc' }],
    })
    return rows.map((r) => ({
      mapBuildingId: r.mapBuildingId,
      slot: r.slot as EstateSlotKey,
      unitId: r.unitId,
      unitLabel: formatUnitLabel({
        number: r.unit.number, street: r.unit.street, stairwellName: r.unit.stairwell?.name ?? null,
      }),
      assignedAt: r.assignedAt.toISOString(),
    }))
  }

  /** Walidacja konfiguracji — kształt z paczki projektowej, bez zaufania do klienta. */
  private validateConfig(input: EstateMapConfigInput): EstateMapConfigInput {
    const bad = (msg: string) => new BadRequestException(`Konfiguracja mapy: ${msg}`)
    if (!input || typeof input !== 'object') throw bad('brak treści')
    const name = String(input.name ?? '').trim()
    if (!name) throw bad('brak nazwy')
    const imageUrl = String(input.imageUrl ?? '').trim()
    if (!/^(\/|https:\/\/)/.test(imageUrl)) throw bad('imageUrl musi być ścieżką „/…" albo adresem https://')
    const width = Number(input.canvas?.width)
    const height = Number(input.canvas?.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw bad('canvas.width/height')
    if (!Array.isArray(input.buildings) || input.buildings.length === 0) throw bad('brak listy budynków')

    const ids = new Set<string>()
    const buildings: EstateMapBuildingArea[] = input.buildings.map((b, i) => {
      const id = String(b?.id ?? '').trim()
      if (!id) throw bad(`budynek #${i + 1} bez id`)
      if (ids.has(id)) throw bad(`powtórzony id budynku „${id}"`)
      ids.add(id)
      const unitCount = Number(b.unitCount) === 1 ? 1 : 2
      const slotsIn = Array.isArray(b.slots) && b.slots.length
        ? b.slots.map((s) => String(s).toUpperCase())
        : (unitCount === 1 ? ['A'] : ['A', 'B'])
      if (slotsIn.some((s) => s !== 'A' && s !== 'B') || new Set(slotsIn).size !== slotsIn.length) {
        throw bad(`budynek „${id}": części muszą być A/B bez powtórzeń`)
      }
      if (slotsIn.length !== unitCount) throw bad(`budynek „${id}": liczba części ≠ unitCount`)
      const nums = ['x', 'y', 'w', 'h', 'a'].map((k) => Number((b as any)[k]))
      if (nums.some((n) => !Number.isFinite(n))) throw bad(`budynek „${id}": x/y/w/h/a muszą być liczbami`)
      return {
        id,
        label: String(b.label ?? '').trim() || `Budynek ${id}`,
        street: String(b.street ?? '').trim(),
        number: String(b.number ?? '').trim(),
        unitCount: unitCount as 1 | 2,
        x: nums[0], y: nums[1], w: nums[2], h: nums[3], a: nums[4],
        slots: slotsIn as EstateSlotKey[],
      }
    })

    const gates = (Array.isArray(input.gates) ? input.gates : [])
      .filter((g) => g && typeof g === 'object')
      .map((g) => ({ id: String(g.id ?? ''), name: String(g.name ?? ''), x: Number(g.x), y: Number(g.y) }))
      .filter((g) => g.id && Number.isFinite(g.x) && Number.isFinite(g.y))
    const streets = (Array.isArray(input.streets) ? input.streets : [])
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({ label: String(s.label ?? ''), x: Number(s.x), y: Number(s.y) }))
      .filter((s) => s.label && Number.isFinite(s.x) && Number.isFinite(s.y))

    return {
      name,
      imageUrl,
      canvas: { width: Math.round(width), height: Math.round(height) },
      buildings,
      gates,
      streets,
      geometryStatus: input.geometryStatus ? String(input.geometryStatus) : null,
      addressStatus: input.addressStatus ? String(input.addressStatus) : null,
    }
  }
}
