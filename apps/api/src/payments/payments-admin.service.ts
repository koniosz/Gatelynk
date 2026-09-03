// payments-admin.service.ts — zarządzanie opłatami (czynszem) dla Building Admina.
//
// 2026-07-03 — nowy moduł płatności (patrz komentarz architektury w
// prisma/schema.prisma przy modelach Payment*):
//   • składowe opłat (PaymentComponent, budynkowe + per-lokal),
//   • naliczenia miesięczne (PaymentCharge, idempotentna generacja + lustrzany
//     PaymentEntry CHARGE dla kompatybilności salda/iOS),
//   • raport miesięczny kto zapłacił / kto nie,
//   • ręczne wpłaty + import MT940 (preview → confirm, dedup po hashu pliku).
//
// Nowy kod używa typed Prisma Client (Prisma 5.22 unified — generate działa).
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { Prisma } from '@prisma/client'
import * as crypto from 'crypto'
import { PrismaService } from '../prisma/prisma.service'
import {
  FEATURE_DISABLED_CODE,
  FEATURE_DISABLED_MESSAGE,
  featKey,
  hasPermission,
  normalizePermissions,
} from '../buildings/feature-permissions.constants'
import { decodeMt940Buffer, parseMt940, Mt940Transaction } from './mt940-parser'
import { sortUnits } from '../common/natural-sort'

// ── Typy publiczne (kontrakty API) ───────────────────────────────────────────

export interface ComponentDto {
  name: string
  amount: number
  calcType?: 'FIXED' | 'PER_SQM'
  unitId?: number | null
  activeFrom?: string | null
  activeTo?: string | null
}

export interface ComponentSnapshotItem {
  name: string
  amount: number
  calcType: string
}

export type ChargeStatus = 'PAID' | 'PARTIAL' | 'UNPAID' | 'OVERDUE' | 'NO_CHARGE'

export interface Mt940PreviewItem {
  index: number
  valueDate: string
  amount: number
  title: string | null
  senderName: string | null
  rawDetails: string
  reference: string | null
  suggestedUnitId: number | null
  suggestedUnitNumber: string | null
  suggestedChargeId: number | null
  matchReason: 'UNIT_NUMBER' | 'RESIDENT_NAME' | 'AMOUNT' | null
  duplicate: boolean
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

function periodBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split('-').map(Number)
  return {
    start: new Date(Date.UTC(y, m - 1, 1)),
    end: new Date(Date.UTC(y, m, 1)), // exclusive
  }
}

function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Wylicza status naliczenia (PAID/PARTIAL/UNPAID/OVERDUE) — WSPÓLNA logika
 * dla raportu miesięcznego BA i widoku mieszkańca (resident.service).
 * Status NIE jest przechowywany w bazie — zawsze wyliczany z kwot + terminu.
 * Tolerancja 0.005 zł na błędy zaokrągleń Decimal→Number.
 */
export function computeChargeStatus(
  charged: number,
  paid: number,
  dueDate: Date,
  now: Date = new Date(),
): { status: Exclude<ChargeStatus, 'NO_CHARGE'>; daysOverdue: number } {
  if (paid >= charged - 0.005) return { status: 'PAID', daysOverdue: 0 }
  if (now > dueDate) {
    return {
      status: 'OVERDUE',
      daysOverdue: Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000),
    }
  }
  return { status: paid > 0 ? 'PARTIAL' : 'UNPAID', daysOverdue: 0 }
}

@Injectable()
export class PaymentsAdminService {
  private readonly logger = new Logger(PaymentsAdminService.name)

  constructor(private prisma: PrismaService) {}

  // ── Guardy (multi-tenant + feature permission) ─────────────────────────────

  private async guard(buildingId: number, buildingIds: number[]) {
    if (!buildingIds.includes(buildingId)) throw new ForbiddenException()
    const rows = await this.prisma.$queryRaw<{ featurePermissions: unknown }[]>`
      SELECT "featurePermissions" FROM "buildings" WHERE id = ${buildingId} LIMIT 1
    `
    if (rows.length === 0) throw new NotFoundException('Budynek nie istnieje')
    const perms = normalizePermissions(rows[0]?.featurePermissions)
    if (!hasPermission(perms, 'ba', featKey('payments'))) {
      throw new ForbiddenException({
        message: FEATURE_DISABLED_MESSAGE,
        code: FEATURE_DISABLED_CODE,
        feature: 'payments',
      })
    }
  }

  private async requireUnit(buildingId: number, unitId: number) {
    const unit = await this.prisma.unit.findFirst({ where: { id: unitId, buildingId } })
    if (!unit) throw new NotFoundException('Lokal nie istnieje')
    return unit
  }

  // ── Konfiguracja: składowe + termin wymagalności ───────────────────────────

  async getConfiguration(buildingId: number, buildingIds: number[]) {
    await this.guard(buildingId, buildingIds)

    const [settings, components, units] = await Promise.all([
      this.prisma.paymentSettings.findUnique({ where: { buildingId } }),
      this.prisma.paymentComponent.findMany({
        where: { buildingId },
        orderBy: [{ unitId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
        include: { unit: { select: { id: true, number: true, street: true } } },
      }),
      this.prisma.unit.findMany({
        where: { buildingId },
        select: { id: true, number: true, street: true, areaSqm: true },
        orderBy: { number: 'asc' },
      }),
    ])

    sortUnits(units)

    const currentMonth = periodBounds(periodOf(new Date()))
    const preview = units.map(u => {
      const items = this.componentsForUnit(components, u, currentMonth.start, currentMonth.end)
      return {
        unitId: u.id,
        number: u.number,
        street: u.street,
        areaSqm: u.areaSqm ? Number(u.areaSqm) : null,
        monthlyTotal: round2(items.reduce((s, c) => s + c.amount, 0)),
        components: items,
      }
    })

    return {
      settings: { dueDay: settings?.dueDay ?? 10 },
      components: components.map(c => ({
        id: c.id,
        unitId: c.unitId,
        unitNumber: c.unit?.number ?? null,
        unitStreet: c.unit?.street ?? null,
        name: c.name,
        amount: Number(c.amount),
        calcType: c.calcType,
        activeFrom: c.activeFrom,
        activeTo: c.activeTo,
      })),
      unitPreview: preview,
    }
  }

  /**
   * Wyznacza aktywne składowe dla lokalu w oknie [rangeStart, rangeEnd)
   * (semantyka OVERLAP — składowa dodana w połowie miesiąca liczy się do
   * naliczenia za ten miesiąc). Override per lokal po nazwie.
   */
  private componentsForUnit(
    components: Array<{
      unitId: number | null
      name: string
      amount: Prisma.Decimal
      calcType: string
      activeFrom: Date
      activeTo: Date | null
    }>,
    unit: { id: number; areaSqm: Prisma.Decimal | null },
    rangeStart: Date,
    rangeEnd: Date,
  ): ComponentSnapshotItem[] {
    const isActive = (c: { activeFrom: Date; activeTo: Date | null }) =>
      c.activeFrom < rangeEnd && (!c.activeTo || c.activeTo >= rangeStart)

    const building = components.filter(c => c.unitId === null && isActive(c))
    const unitOwn = components.filter(c => c.unitId === unit.id && isActive(c))

    const overridden = new Set(unitOwn.map(c => c.name.trim().toLowerCase()))
    const effective = [
      ...building.filter(c => !overridden.has(c.name.trim().toLowerCase())),
      ...unitOwn,
    ]

    return effective.map(c => {
      const base = Number(c.amount)
      const amount =
        c.calcType === 'PER_SQM' ? round2(base * (unit.areaSqm ? Number(unit.areaSqm) : 0)) : round2(base)
      return { name: c.name, amount, calcType: c.calcType }
    })
  }

  async createComponent(buildingId: number, buildingIds: number[], dto: ComponentDto) {
    await this.guard(buildingId, buildingIds)
    this.validateComponentDto(dto)
    if (dto.unitId) await this.requireUnit(buildingId, dto.unitId)

    const created = await this.prisma.paymentComponent.create({
      data: {
        buildingId,
        unitId: dto.unitId ?? null,
        name: dto.name.trim(),
        amount: new Prisma.Decimal(dto.amount),
        calcType: dto.calcType === 'PER_SQM' ? 'PER_SQM' : 'FIXED',
        activeFrom: dto.activeFrom ? new Date(dto.activeFrom) : new Date(),
        activeTo: dto.activeTo ? new Date(dto.activeTo) : null,
      },
    })
    return { id: created.id }
  }

  async updateComponent(
    buildingId: number,
    componentId: number,
    buildingIds: number[],
    dto: Partial<ComponentDto>,
  ) {
    await this.guard(buildingId, buildingIds)
    const existing = await this.prisma.paymentComponent.findFirst({
      where: { id: componentId, buildingId },
    })
    if (!existing) throw new NotFoundException('Składowa nie istnieje')
    if (dto.name !== undefined || dto.amount !== undefined) {
      this.validateComponentDto({
        name: dto.name ?? existing.name,
        amount: dto.amount ?? Number(existing.amount),
      })
    }
    if (dto.unitId) await this.requireUnit(buildingId, dto.unitId)

    await this.prisma.paymentComponent.update({
      where: { id: componentId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.amount !== undefined ? { amount: new Prisma.Decimal(dto.amount) } : {}),
        ...(dto.calcType !== undefined
          ? { calcType: dto.calcType === 'PER_SQM' ? 'PER_SQM' : 'FIXED' }
          : {}),
        ...(dto.unitId !== undefined ? { unitId: dto.unitId ?? null } : {}),
        ...(dto.activeFrom !== undefined
          ? { activeFrom: dto.activeFrom ? new Date(dto.activeFrom) : new Date() }
          : {}),
        ...(dto.activeTo !== undefined ? { activeTo: dto.activeTo ? new Date(dto.activeTo) : null } : {}),
      },
    })
    return { success: true }
  }

  async deleteComponent(buildingId: number, componentId: number, buildingIds: number[]) {
    await this.guard(buildingId, buildingIds)
    const existing = await this.prisma.paymentComponent.findFirst({
      where: { id: componentId, buildingId },
    })
    if (!existing) throw new NotFoundException('Składowa nie istnieje')
    await this.prisma.paymentComponent.delete({ where: { id: componentId } })
    return { success: true }
  }

  private validateComponentDto(dto: { name: string; amount: number }) {
    if (!dto.name || !dto.name.trim()) throw new BadRequestException('Nazwa składowej jest wymagana')
    if (typeof dto.amount !== 'number' || !Number.isFinite(dto.amount) || dto.amount < 0) {
      throw new BadRequestException('Kwota musi być liczbą ≥ 0')
    }
    if (dto.amount > 1_000_000) throw new BadRequestException('Kwota poza zakresem')
  }

  async upsertSettings(buildingId: number, buildingIds: number[], dto: { dueDay: number }) {
    await this.guard(buildingId, buildingIds)
    const dueDay = Math.trunc(Number(dto.dueDay))
    if (!Number.isFinite(dueDay) || dueDay < 1 || dueDay > 28) {
      throw new BadRequestException('Termin płatności musi być dniem 1–28')
    }
    await this.prisma.paymentSettings.upsert({
      where: { buildingId },
      create: { buildingId, dueDay },
      update: { dueDay },
    })
    return { success: true, dueDay }
  }

  // ── Naliczenia miesięczne ──────────────────────────────────────────────────

  /**
   * Generuje naliczenia za miesiąc `period` (YYYY-MM) dla wszystkich lokali.
   * IDEMPOTENTNE: lokale które już mają naliczenie za ten okres są pomijane.
   * Fallback: lokal bez składowych, ale z PaymentConfig.monthlyRent dostaje
   * jedną składową "Czynsz" (kompatybilność ze starą konfiguracją).
   */
  async generateCharges(buildingId: number, buildingIds: number[], period: string) {
    await this.guard(buildingId, buildingIds)
    if (!PERIOD_RE.test(period)) throw new BadRequestException('Okres w formacie YYYY-MM')
    return this.generateChargesInternal(buildingId, period)
  }

  /**
   * Automatyczne naliczanie czynszu — minutę po starcie aplikacji (żeby
   * świeży deploy / nowy miesiąc nie czekał 6 h) i dalej co 6 h
   * (idempotentnie: lokal naliczony w danym okresie jest pomijany, więc
   * realny INSERT zdarza się raz na miesiąc, tuż po jego rozpoczęciu).
   * Obejmuje każdy budynek, który ma skonfigurowane składowe opłat LUB
   * per-lokalowe payment_configs. Wymagalność (dueDate) liczona z
   * PaymentSettings.dueDay (default 10.).
   */
  onModuleInit() {
    setTimeout(() => void this.autoGenerateMonthlyCharges(), 60_000)
  }

  @Interval(6 * 60 * 60 * 1000)
  async autoGenerateMonthlyCharges() {
    const period = periodOf(new Date())
    try {
      const buildings = await this.prisma.$queryRaw<{ buildingId: number }[]>`
        SELECT DISTINCT "buildingId" FROM payment_components
        UNION
        SELECT DISTINCT u."buildingId"
        FROM payment_configs pc JOIN units u ON u.id = pc."unitId"
      `
      for (const b of buildings) {
        try {
          const res = await this.generateChargesInternal(b.buildingId, period)
          if (res.created > 0) {
            this.logger.log(
              `Auto-charges ${period}: building ${b.buildingId} → created ${res.created}, ` +
              `skipped existing ${res.skippedExisting}, no-config ${res.skippedNoConfig}`,
            )
          }
        } catch (err) {
          this.logger.error(`Auto-charges ${period}: building ${b.buildingId} failed`, err as Error)
        }
      }
    } catch (err) {
      this.logger.error('Auto-charges: building discovery failed', err as Error)
    }
  }

  private async generateChargesInternal(buildingId: number, period: string) {
    const { start, end } = periodBounds(period)
    const [y, m] = period.split('-').map(Number)

    const [units, components, configs, settings, existing] = await Promise.all([
      this.prisma.unit.findMany({
        where: { buildingId },
        select: { id: true, number: true, areaSqm: true },
      }),
      this.prisma.paymentComponent.findMany({ where: { buildingId } }),
      this.prisma.paymentConfig.findMany({
        where: { unit: { buildingId } },
        select: { unitId: true, monthlyRent: true, dueDay: true },
      }),
      this.prisma.paymentSettings.findUnique({ where: { buildingId } }),
      this.prisma.paymentCharge.findMany({
        where: { buildingId, period },
        select: { unitId: true },
      }),
    ])

    const configByUnit = new Map(configs.map(c => [c.unitId, c]))
    const alreadyCharged = new Set(existing.map(c => c.unitId))
    const defaultDueDay = settings?.dueDay ?? 10

    let created = 0
    let skippedExisting = 0
    let skippedNoConfig = 0

    for (const unit of units) {
      if (alreadyCharged.has(unit.id)) {
        skippedExisting++
        continue
      }

      let snapshot = this.componentsForUnit(components, unit, start, end)
      if (snapshot.length === 0) {
        const cfg = configByUnit.get(unit.id)
        if (cfg && Number(cfg.monthlyRent) > 0) {
          snapshot = [{ name: 'Czynsz', amount: round2(Number(cfg.monthlyRent)), calcType: 'FIXED' }]
        }
      }
      if (snapshot.length === 0) {
        skippedNoConfig++
        continue
      }

      const total = round2(snapshot.reduce((s, c) => s + c.amount, 0))
      if (total <= 0) {
        skippedNoConfig++
        continue
      }

      const dueDay = configByUnit.get(unit.id)?.dueDay ?? defaultDueDay
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
      const dueDate = new Date(Date.UTC(y, m - 1, Math.min(dueDay, daysInMonth)))

      await this.prisma.$transaction(async tx => {
        const charge = await tx.paymentCharge.create({
          data: {
            buildingId,
            unitId: unit.id,
            period,
            components: snapshot as unknown as Prisma.InputJsonValue,
            totalAmount: new Prisma.Decimal(total),
            dueDate,
          },
        })
        // Lustrzany wpis CHARGE w ledgerze — saldo i historia (iOS) bez zmian.
        await tx.paymentEntry.create({
          data: {
            unitId: unit.id,
            amount: new Prisma.Decimal(-total),
            type: 'CHARGE',
            date: start,
            description: `Naliczenie ${period}`,
            reference: `charge:${period}`,
            source: 'system',
            chargeId: charge.id,
          },
        })
      })
      created++
    }

    return { period, created, skippedExisting, skippedNoConfig, totalUnits: units.length }
  }

  // ── Raport miesięczny ──────────────────────────────────────────────────────

  async getMonthlyReport(buildingId: number, buildingIds: number[], period: string) {
    await this.guard(buildingId, buildingIds)
    if (!PERIOD_RE.test(period)) throw new BadRequestException('Okres w formacie YYYY-MM')

    const { start, end } = periodBounds(period)

    const [units, charges] = await Promise.all([
      this.prisma.unit.findMany({
        where: { buildingId },
        select: {
          id: true,
          number: true,
          street: true,
          unitResidents: {
            where: {
              sinceDate: { lte: new Date() },
              OR: [{ untilDate: null }, { untilDate: { gt: new Date() } }],
            },
            select: { resident: { select: { firstName: true, lastName: true } } },
            take: 3,
          },
        },
        orderBy: { number: 'asc' },
      }),
      this.prisma.paymentCharge.findMany({ where: { buildingId, period } }),
    ])

    sortUnits(units)

    const chargeByUnit = new Map(charges.map(c => [c.unitId, c]))
    const chargeIds = charges.map(c => c.id)

    // Wpłaty: powiązane z naliczeniem (chargeId) LUB nieprzypisane z datą w okresie
    const payments = await this.prisma.paymentEntry.findMany({
      where: {
        type: 'PAYMENT',
        unit: { buildingId },
        OR: [
          ...(chargeIds.length ? [{ chargeId: { in: chargeIds } }] : []),
          { chargeId: null, date: { gte: start, lt: end } },
        ],
      },
      select: { unitId: true, amount: true, chargeId: true, date: true },
    })

    const paidByUnit = new Map<number, number>()
    for (const p of payments) {
      paidByUnit.set(p.unitId, round2((paidByUnit.get(p.unitId) ?? 0) + Number(p.amount)))
    }

    const now = new Date()
    const rows = units.map(u => {
      const charge = chargeByUnit.get(u.id)
      const charged = charge ? Number(charge.totalAmount) : 0
      const paid = paidByUnit.get(u.id) ?? 0
      let status: ChargeStatus
      let daysOverdue = 0
      if (!charge) {
        status = 'NO_CHARGE'
      } else {
        const computed = computeChargeStatus(charged, paid, charge.dueDate, now)
        status = computed.status
        daysOverdue = computed.daysOverdue
      }
      return {
        unitId: u.id,
        number: u.number,
        street: u.street,
        residents: u.unitResidents.map(ur => `${ur.resident.firstName} ${ur.resident.lastName}`),
        chargeId: charge?.id ?? null,
        charged,
        paid,
        dueDate: charge?.dueDate ?? null,
        components: (charge?.components as unknown as ComponentSnapshotItem[]) ?? [],
        status,
        daysOverdue,
      }
    })

    const withCharge = rows.filter(r => r.status !== 'NO_CHARGE')
    const totals = {
      charged: round2(withCharge.reduce((s, r) => s + r.charged, 0)),
      paid: round2(rows.reduce((s, r) => s + r.paid, 0)),
      unitsTotal: rows.length,
      unitsCharged: withCharge.length,
      unitsPaid: withCharge.filter(r => r.status === 'PAID').length,
      unitsOverdue: withCharge.filter(r => r.status === 'OVERDUE').length,
      paidPct: withCharge.length
        ? Math.round((withCharge.filter(r => r.status === 'PAID').length / withCharge.length) * 100)
        : 0,
    }

    return { period, totals, rows }
  }

  // ── Ręczna wpłata ──────────────────────────────────────────────────────────

  async addManualPayment(
    buildingId: number,
    unitId: number,
    buildingIds: number[],
    dto: { amount: number; date: string; description?: string; period?: string },
  ) {
    await this.guard(buildingId, buildingIds)
    await this.requireUnit(buildingId, unitId)

    const amount = Number(dto.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Kwota wpłaty musi być dodatnia')
    }
    const date = new Date(dto.date)
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Nieprawidłowa data')

    // Powiąż z naliczeniem: jawnie podany okres albo miesiąc z daty wpłaty
    const period = dto.period && PERIOD_RE.test(dto.period) ? dto.period : periodOf(date)
    const charge = await this.prisma.paymentCharge.findUnique({
      where: { unitId_period: { unitId, period } },
    })

    const entry = await this.prisma.paymentEntry.create({
      data: {
        unitId,
        amount: new Prisma.Decimal(round2(amount)),
        type: 'PAYMENT',
        date,
        description: dto.description?.trim().slice(0, 500) || `Wpłata ręczna (${period})`,
        source: 'admin',
        chargeId: charge?.id ?? null,
      },
    })
    return { success: true, entryId: entry.id, linkedChargeId: charge?.id ?? null }
  }

  // ── Import MT940 ───────────────────────────────────────────────────────────

  /**
   * Krok 1 — preview: parsuje plik, auto-dopasowuje uznania do lokali,
   * NIC nie zapisuje. Zwraca listę do przeglądu (dopasowane + niedopasowane).
   */
  async mt940Preview(
    buildingId: number,
    buildingIds: number[],
    dto: { contentBase64?: string; content?: string; fileName?: string },
  ) {
    await this.guard(buildingId, buildingIds)

    let content: string
    let hashSource: Buffer
    if (dto.contentBase64) {
      hashSource = Buffer.from(dto.contentBase64, 'base64')
      content = decodeMt940Buffer(hashSource)
    } else if (dto.content) {
      content = dto.content
      hashSource = Buffer.from(dto.content, 'utf8')
    } else {
      throw new BadRequestException('Brak zawartości pliku')
    }
    if (hashSource.length > 5_000_000) throw new BadRequestException('Plik za duży (max 5 MB)')

    const fileHash = crypto.createHash('sha256').update(hashSource).digest('hex')
    const existingImport = await this.prisma.mt940Import.findUnique({
      where: { buildingId_fileHash: { buildingId, fileHash } },
    })

    const stmt = parseMt940(content)
    const credits = stmt.transactions.filter(t => t.direction === 'C' && !t.reversal && t.amount > 0)
    if (credits.length === 0 && stmt.transactions.length === 0) {
      throw new BadRequestException('Nie rozpoznano żadnych transakcji — czy to plik MT940?')
    }

    const matching = await this.loadMatchingContext(buildingId, credits)

    const items: Mt940PreviewItem[] = []
    for (let i = 0; i < credits.length; i++) {
      const tx = credits[i]
      const match = this.matchTransaction(tx, matching)
      const duplicate = await this.isDuplicatePayment(buildingId, tx)
      items.push({
        index: i,
        valueDate: tx.valueDate.toISOString(),
        amount: tx.amount,
        title: tx.title,
        senderName: tx.senderName,
        rawDetails: tx.rawDetails,
        reference: tx.reference,
        suggestedUnitId: match?.unitId ?? null,
        suggestedUnitNumber: match?.unitNumber ?? null,
        suggestedChargeId: match?.chargeId ?? null,
        matchReason: match?.reason ?? null,
        duplicate,
      })
    }

    return {
      fileHash,
      fileName: dto.fileName ?? null,
      accountNumber: stmt.accountNumber,
      statementNumber: stmt.statementNumber,
      alreadyImported: !!existingImport,
      importedAt: existingImport?.createdAt ?? null,
      creditCount: credits.length,
      totalTransactions: stmt.transactions.length,
      matchedCount: items.filter(it => it.suggestedUnitId !== null).length,
      items,
      units: matching.units.map(u => ({ id: u.id, number: u.number, street: u.street })),
    }
  }

  private async loadMatchingContext(buildingId: number, credits: Mt940Transaction[]) {
    const periods = [...new Set(credits.map(t => periodOf(t.valueDate)))]
    const [units, residents, charges] = await Promise.all([
      this.prisma.unit.findMany({
        where: { buildingId },
        select: { id: true, number: true, street: true },
      }),
      this.prisma.$queryRaw<
        { unitId: number; lastName: string }[]
      >`
        SELECT ur."unitId", r."lastName"
        FROM unit_residents ur
        JOIN residents r ON r.id = ur."residentId"
        JOIN units u ON u.id = ur."unitId"
        WHERE u."buildingId" = ${buildingId}
          AND ur."sinceDate" <= NOW()
          AND (ur."untilDate" IS NULL OR ur."untilDate" > NOW())
      `,
      periods.length
        ? this.prisma.paymentCharge.findMany({
            where: { buildingId, period: { in: periods } },
            select: { id: true, unitId: true, period: true, totalAmount: true },
          })
        : Promise.resolve([]),
    ])
    return { units, residents, charges }
  }

  /**
   * Heurystyki dopasowania przelewu do lokalu (w kolejności pewności):
   *  1. numer lokalu w tytule ("lokal 15A", "m. 3", "Kwiatowa 5"),
   *  2. nazwisko aktywnego mieszkańca w nadawcy/tytule,
   *  3. kwota przelewu == kwota naliczenia za miesiąc daty przelewu (unikalna).
   */
  private matchTransaction(
    tx: Mt940Transaction,
    ctx: {
      units: { id: number; number: string; street: string | null }[]
      residents: { unitId: number; lastName: string }[]
      charges: { id: number; unitId: number; period: string; totalAmount: Prisma.Decimal }[]
    },
  ): { unitId: number; unitNumber: string; chargeId: number | null; reason: 'UNIT_NUMBER' | 'RESIDENT_NAME' | 'AMOUNT' } | null {
    const haystack = `${tx.title ?? ''} ${tx.rawDetails} ${tx.senderName ?? ''}`
      .toLowerCase()
      .replace(/\s+/g, ' ')

    const period = periodOf(tx.valueDate)
    const chargeFor = (unitId: number) =>
      ctx.charges.find(c => c.unitId === unitId && c.period === period)?.id ?? null

    // 1. numer lokalu — dłuższe numery najpierw ("15A" przed "5"), z granicą słowa
    const byLen = [...ctx.units].sort((a, b) => b.number.length - a.number.length)
    for (const u of byLen) {
      const num = u.number.trim().toLowerCase()
      if (!num) continue
      const escaped = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // "lokal 15a" / "m 15a" / "m. 15a" / "mieszkanie 15a" / "ul. Kwiatowa 5"
      const contextual = new RegExp(
        `(?:lok(?:al|\\.)?|m(?:ieszk\\w*|\\.)?|dom|nr)\\s*${escaped}(?![\\da-ząęółśżźćń])`,
        'i',
      )
      if (contextual.test(haystack)) {
        return { unitId: u.id, unitNumber: u.number, chargeId: chargeFor(u.id), reason: 'UNIT_NUMBER' }
      }
      // osiedle: "ulica numer" ("kwiatowa 5")
      if (u.street) {
        const streetRe = new RegExp(
          `${u.street.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${escaped}(?![\\da-ząęółśżźćń])`,
          'i',
        )
        if (streetRe.test(haystack)) {
          return { unitId: u.id, unitNumber: u.number, chargeId: chargeFor(u.id), reason: 'UNIT_NUMBER' }
        }
      }
    }

    // 2. nazwisko mieszkańca (≥4 znaki, żeby uniknąć fałszywych trafień)
    const nameHits = new Map<number, string>()
    for (const r of ctx.residents) {
      const ln = r.lastName.trim().toLowerCase()
      if (ln.length < 4) continue
      if (haystack.includes(ln)) nameHits.set(r.unitId, r.lastName)
    }
    if (nameHits.size === 1) {
      const [unitId] = [...nameHits.keys()]
      const unit = ctx.units.find(u => u.id === unitId)
      if (unit) {
        return { unitId, unitNumber: unit.number, chargeId: chargeFor(unitId), reason: 'RESIDENT_NAME' }
      }
    }

    // 3. dokładna kwota naliczenia za okres przelewu — tylko gdy JEDNOZNACZNA
    const amountHits = ctx.charges.filter(
      c => c.period === period && Math.abs(Number(c.totalAmount) - tx.amount) < 0.005,
    )
    if (amountHits.length === 1) {
      const unit = ctx.units.find(u => u.id === amountHits[0].unitId)
      if (unit) {
        return { unitId: unit.id, unitNumber: unit.number, chargeId: amountHits[0].id, reason: 'AMOUNT' }
      }
    }

    return null
  }

  private async isDuplicatePayment(buildingId: number, tx: Mt940Transaction): Promise<boolean> {
    if (tx.reference) {
      const byRef = await this.prisma.paymentEntry.findFirst({
        where: { reference: tx.reference, source: 'mt940', unit: { buildingId } },
        select: { id: true },
      })
      if (byRef) return true
    }
    const sameDayAmount = await this.prisma.paymentEntry.findFirst({
      where: {
        source: 'mt940',
        unit: { buildingId },
        amount: new Prisma.Decimal(tx.amount),
        date: tx.valueDate,
      },
      select: { id: true },
    })
    return !!sameDayAmount
  }

  /**
   * Krok 2 — confirm: zapisuje przejrzane/zatwierdzone transakcje jako wpłaty
   * (source='mt940'). Tworzy Mt940Import (dedup po hashu pliku).
   */
  async mt940Confirm(
    buildingId: number,
    buildingIds: number[],
    dto: {
      fileHash: string
      fileName?: string
      accountNumber?: string | null
      statementNumber?: string | null
      transactionCount?: number
      items: Array<{
        unitId: number
        amount: number
        valueDate: string
        title?: string | null
        senderName?: string | null
        reference?: string | null
      }>
    },
  ) {
    await this.guard(buildingId, buildingIds)
    if (!dto.fileHash || !/^[a-f0-9]{64}$/i.test(dto.fileHash)) {
      throw new BadRequestException('Brak prawidłowego hasha pliku — najpierw wykonaj preview')
    }
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException('Brak transakcji do zapisania')
    }
    if (dto.items.length > 2000) throw new BadRequestException('Za dużo transakcji (max 2000)')

    const dup = await this.prisma.mt940Import.findUnique({
      where: { buildingId_fileHash: { buildingId, fileHash: dto.fileHash } },
    })
    if (dup) {
      throw new ConflictException(
        `Ten plik został już zaimportowany ${dup.createdAt.toLocaleDateString('pl-PL')} (${dup.savedCount} wpłat)`,
      )
    }

    // walidacja: wszystkie lokale należą do budynku
    const unitIds = [...new Set(dto.items.map(i => i.unitId))]
    const validUnits = await this.prisma.unit.findMany({
      where: { id: { in: unitIds }, buildingId },
      select: { id: true },
    })
    const validSet = new Set(validUnits.map(u => u.id))
    for (const it of dto.items) {
      if (!validSet.has(it.unitId)) throw new BadRequestException(`Lokal ${it.unitId} nie należy do budynku`)
      const amount = Number(it.amount)
      if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Nieprawidłowa kwota wpłaty')
      if (Number.isNaN(new Date(it.valueDate).getTime())) throw new BadRequestException('Nieprawidłowa data wpłaty')
    }

    // naliczenia dla auto-linkowania chargeId
    const periods = [...new Set(dto.items.map(i => periodOf(new Date(i.valueDate))))]
    const charges = await this.prisma.paymentCharge.findMany({
      where: { buildingId, period: { in: periods } },
      select: { id: true, unitId: true, period: true },
    })
    const chargeKey = (unitId: number, period: string) =>
      charges.find(c => c.unitId === unitId && c.period === period)?.id ?? null

    let saved = 0
    let skippedDuplicates = 0

    await this.prisma.$transaction(async tx => {
      const imp = await tx.mt940Import.create({
        data: {
          buildingId,
          fileName: (dto.fileName ?? 'import.mt940').slice(0, 200),
          fileHash: dto.fileHash.toLowerCase(),
          accountNumber: dto.accountNumber ?? null,
          statementNumber: dto.statementNumber ?? null,
          transactionCount: dto.transactionCount ?? dto.items.length,
        },
      })

      for (const it of dto.items) {
        // dedup pojedynczej transakcji po referencji
        if (it.reference) {
          const exists = await tx.paymentEntry.findFirst({
            where: { reference: it.reference, source: 'mt940', unit: { buildingId } },
            select: { id: true },
          })
          if (exists) {
            skippedDuplicates++
            continue
          }
        }
        const date = new Date(it.valueDate)
        const desc = [it.title, it.senderName ? `od: ${it.senderName}` : null]
          .filter(Boolean)
          .join(' | ')
          .slice(0, 500)
        await tx.paymentEntry.create({
          data: {
            unitId: it.unitId,
            amount: new Prisma.Decimal(round2(Number(it.amount))),
            type: 'PAYMENT',
            date,
            description: desc || 'Przelew MT940',
            reference: it.reference ?? null,
            source: 'mt940',
            chargeId: chargeKey(it.unitId, periodOf(date)),
            mt940ImportId: imp.id,
          },
        })
        saved++
      }

      await tx.mt940Import.update({ where: { id: imp.id }, data: { savedCount: saved } })
    })

    return { success: true, saved, skippedDuplicates }
  }
}
