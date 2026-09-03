// PR-5 (2026-07-05) — Import mieszkańców z CSV (design doc
// docs/design/onboarding-instalacja-budynku-2026-07.md, Faza 5).
//
// Dwufazowy flow: `dryRun` (parse → walidacja → podgląd, zero zapisu)
// i `commit` (ta sama walidacja + transakcyjny zapis). Frontend wysyła
// SUROWY tekst CSV w JSON body — commit re-waliduje, więc między dry-run
// a commit nie ma okna na rozjazd (idempotentnie: re-upload tego samego
// pliku niczego nie duplikuje).
//
// Zasady:
//   • lokal (Unit) tworzony automatycznie gdy nie istnieje — numer + ulica,
//   • hasła NIE są ustawiane — konta aktywują się przez zaproszenia (PR-6),
//   • duplikat e-maila w budynku → wiersz SKIP (mieszkaniec już istnieje),
//   • brak e-maila → placeholder `@brak-email.gatelynk.invalid` (patrz
//     no-email.constants.ts), dedup po (imię+nazwisko+lokal),
//   • multi-tenant: WSZYSTKIE zapytania filtrowane po buildingId; tenant-check
//     robi kontroler (integrator: Building.adminId, BA: buildingIds z JWT).
import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { parseResidentsCsv, EMAIL_RE, type ParsedCsvRow } from './csv-parser'
import { buildPlaceholderEmail, isPlaceholderEmail } from './no-email.constants'

export type ImportRowStatus = 'create' | 'skip' | 'error'

export interface ImportRowPreview {
  rowNumber: number
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  unitNumber: string
  street: string | null
  status: ImportRowStatus
  /** Komunikaty PL — błędy (status=error) lub ostrzeżenia/informacje. */
  messages: string[]
  /** True gdy lokal z tego wiersza zostanie dopiero utworzony. */
  willCreateUnit: boolean
}

export interface ImportPreview {
  totalRows: number
  toCreate: number
  toSkip: number
  errors: number
  /** Lokale, których nie ma w budynku — commit je utworzy. */
  unitsToCreate: string[]
  unknownHeaders: string[]
  matchedColumns: string[]
  delimiter: string
  rows: ImportRowPreview[]
}

export interface ImportCommitResult {
  createdResidents: number
  createdUnits: number
  skipped: number
  errors: number
  /** Ilu utworzonych ma prawdziwy e-mail (można wysłać zaproszenia). */
  invitableCount: number
  rows: ImportRowPreview[]
}

const MAX_ROWS = 2000
const MAX_CSV_BYTES = 2 * 1024 * 1024 // 2 MB

@Injectable()
export class ResidentsImportService {
  private readonly logger = new Logger(ResidentsImportService.name)

  constructor(private prisma: PrismaService) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  async dryRun(buildingId: number, csvText: string): Promise<ImportPreview> {
    return this.analyze(buildingId, csvText)
  }

  async commit(buildingId: number, csvText: string): Promise<ImportCommitResult> {
    const preview = await this.analyze(buildingId, csvText)
    const creatable = preview.rows.filter((r) => r.status === 'create')

    if (creatable.length === 0) {
      return {
        createdResidents: 0,
        createdUnits: 0,
        skipped: preview.toSkip,
        errors: preview.errors,
        invitableCount: 0,
        rows: preview.rows,
      }
    }

    // Transakcja interaktywna — units + residents + pivoty albo wszystko,
    // albo nic (re-upload po błędzie nie zostawia połówek).
    const { createdUnits, createdResidents, invitableCount } = await this.prisma.$transaction(
      async (tx) => {
        // 1. Typ lokalu — systemowy „apartment" (seed), fallback: pierwszy
        //    nie-common typ budynku, ostatecznie tworzymy własny.
        let unitType = await tx.unitType.findFirst({
          where: {
            code: 'apartment',
            OR: [{ buildingId }, { isSystem: true, buildingId: null }],
          },
          orderBy: { isSystem: 'asc' },
        })
        if (!unitType) {
          unitType = await tx.unitType.findFirst({
            where: {
              isCommonArea: false,
              OR: [{ buildingId }, { isSystem: true, buildingId: null }],
            },
          })
        }
        if (!unitType) {
          unitType = await tx.unitType.create({
            data: {
              buildingId, code: 'apartment', name: 'Mieszkanie', icon: 'home',
              isSystem: false, isCommonArea: false,
            },
          })
        }

        // 2. Lokale — mapowanie numer → id, tworzenie brakujących.
        const existingUnits = await tx.unit.findMany({
          where: { buildingId },
          select: { id: true, number: true },
        })
        const unitIdByNumber = new Map<string, number>(
          existingUnits.map((u) => [u.number.trim().toLowerCase(), u.id]),
        )
        let createdUnits = 0
        for (const row of creatable) {
          const key = row.unitNumber.trim().toLowerCase()
          if (!unitIdByNumber.has(key)) {
            const unit = await tx.unit.create({
              data: {
                buildingId,
                unitTypeId: unitType.id,
                number: row.unitNumber.trim(),
                street: row.street?.trim() || null,
              },
            })
            unitIdByNumber.set(key, unit.id)
            createdUnits++
          }
        }

        // 3. Mieszkańcy + pivot unit_residents. Hasła NIE ustawiamy.
        let createdResidents = 0
        let invitableCount = 0
        for (const row of creatable) {
          const email = row.email ?? buildPlaceholderEmail(row.unitNumber, row.rowNumber)
          const resident = await tx.resident.create({
            data: {
              buildingId,
              firstName: row.firstName,
              lastName: row.lastName,
              email,
              phone: row.phone || null,
            },
          })
          const unitId = unitIdByNumber.get(row.unitNumber.trim().toLowerCase())!
          await tx.unitResident.create({
            data: { unitId, residentId: resident.id, role: 'OWNER', sinceDate: new Date() },
          })
          createdResidents++
          if (!isPlaceholderEmail(email)) invitableCount++
        }

        return { createdUnits, createdResidents, invitableCount }
      },
      { timeout: 60_000 },
    )

    this.logger.log(
      `Import CSV budynek=${buildingId}: +${createdResidents} mieszkańców, ` +
      `+${createdUnits} lokali, skip=${preview.toSkip}, błędy=${preview.errors}`,
    )

    return {
      createdResidents,
      createdUnits,
      skipped: preview.toSkip,
      errors: preview.errors,
      invitableCount,
      rows: preview.rows,
    }
  }

  // ── Core: parse + walidacja ────────────────────────────────────────────────

  private async analyze(buildingId: number, csvText: string): Promise<ImportPreview> {
    if (typeof csvText !== 'string' || csvText.trim() === '') {
      throw new BadRequestException('Pusty plik CSV')
    }
    if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
      throw new BadRequestException('Plik CSV jest za duży (limit 2 MB)')
    }

    const parsed = parseResidentsCsv(csvText)
    if (parsed.rows.length === 0) {
      throw new BadRequestException('Nie znaleziono żadnych wierszy danych w pliku CSV')
    }
    if (parsed.rows.length > MAX_ROWS) {
      throw new BadRequestException(`Za dużo wierszy (${parsed.rows.length}, limit ${MAX_ROWS})`)
    }
    const required: Array<[string, string]> = [
      ['firstName', 'imię'], ['lastName', 'nazwisko'], ['unitNumber', 'lokal/numer'],
    ]
    const missing = required.filter(([key]) => !parsed.matchedColumns.includes(key))
    if (missing.length > 0) {
      throw new BadRequestException(
        `Brak wymaganych kolumn: ${missing.map(([, label]) => label).join(', ')}. ` +
        `Rozpoznane kolumny: ${parsed.matchedColumns.join(', ') || 'żadne'}.`,
      )
    }

    // Stan istniejący w budynku — do wykrywania konfliktów.
    const [existingResidents, existingUnits, activePivots] = await Promise.all([
      this.prisma.resident.findMany({
        where: { buildingId },
        select: { id: true, email: true, firstName: true, lastName: true },
      }),
      this.prisma.unit.findMany({ where: { buildingId }, select: { id: true, number: true } }),
      this.prisma.unitResident.findMany({
        where: { unit: { buildingId }, untilDate: null },
        select: { residentId: true, unitId: true },
      }),
    ])
    const emailTaken = new Map<string, number>(
      existingResidents
        .filter((r) => !isPlaceholderEmail(r.email))
        .map((r) => [r.email.toLowerCase(), r.id]),
    )
    const unitByNumber = new Map<string, number>(
      existingUnits.map((u) => [u.number.trim().toLowerCase(), u.id]),
    )
    const unitIdsByResident = new Map<number, Set<number>>()
    for (const p of activePivots) {
      const set = unitIdsByResident.get(p.residentId) ?? new Set<number>()
      set.add(p.unitId)
      unitIdsByResident.set(p.residentId, set)
    }
    // dedup no-email po (imię+nazwisko+lokal) — idempotencja re-uploadu
    const nameUnitTaken = new Set<string>()
    for (const p of activePivots) {
      const r = existingResidents.find((x) => x.id === p.residentId)
      const u = existingUnits.find((x) => x.id === p.unitId)
      if (r && u) {
        nameUnitTaken.add(
          `${r.firstName.toLowerCase()}|${r.lastName.toLowerCase()}|${u.number.trim().toLowerCase()}`,
        )
      }
    }

    const seenEmailsInFile = new Set<string>()
    const seenNameUnitInFile = new Set<string>()
    const unitsToCreate = new Set<string>()
    const rows: ImportRowPreview[] = []

    for (const raw of parsed.rows) {
      rows.push(this.validateRow(raw, {
        emailTaken, unitByNumber, nameUnitTaken,
        seenEmailsInFile, seenNameUnitInFile, unitsToCreate,
      }))
    }

    const toCreate = rows.filter((r) => r.status === 'create').length
    const toSkip = rows.filter((r) => r.status === 'skip').length
    const errors = rows.filter((r) => r.status === 'error').length

    return {
      totalRows: rows.length,
      toCreate,
      toSkip,
      errors,
      unitsToCreate: [...unitsToCreate].sort(),
      unknownHeaders: parsed.unknownHeaders,
      matchedColumns: parsed.matchedColumns,
      delimiter: parsed.delimiter,
      rows,
    }
  }

  private validateRow(
    raw: ParsedCsvRow,
    ctx: {
      emailTaken: Map<string, number>
      unitByNumber: Map<string, number>
      nameUnitTaken: Set<string>
      seenEmailsInFile: Set<string>
      seenNameUnitInFile: Set<string>
      unitsToCreate: Set<string>
    },
  ): ImportRowPreview {
    const messages: string[] = []
    let status: ImportRowStatus = 'create'

    const firstName = raw.firstName.trim()
    const lastName = raw.lastName.trim()
    const unitNumber = raw.unitNumber.trim()
    const email = raw.email.trim().toLowerCase()
    const phone = raw.phone.trim()
    const street = raw.street.trim()

    if (!firstName) messages.push('Brak imienia')
    if (!lastName) messages.push('Brak nazwiska')
    if (!unitNumber) messages.push('Brak numeru lokalu')
    if (email && !EMAIL_RE.test(email)) messages.push(`Nieprawidłowy adres e-mail: „${raw.email.trim()}"`)
    if (messages.length > 0) status = 'error'

    const nameUnitKey = `${firstName.toLowerCase()}|${lastName.toLowerCase()}|${unitNumber.toLowerCase()}`

    if (status !== 'error') {
      if (email) {
        if (ctx.seenEmailsInFile.has(email)) {
          status = 'skip'
          messages.push('Duplikat w pliku — ten adres e-mail występuje wyżej')
        } else if (ctx.emailTaken.has(email)) {
          status = 'skip'
          messages.push('Mieszkaniec z tym adresem e-mail już istnieje w budynku')
        }
      } else {
        messages.push('Brak adresu e-mail — mieszkaniec nie otrzyma zaproszenia (status „bez e-maila")')
        if (ctx.seenNameUnitInFile.has(nameUnitKey)) {
          status = 'skip'
          messages.push('Duplikat w pliku — ta osoba (imię+nazwisko+lokal) występuje wyżej')
        } else if (ctx.nameUnitTaken.has(nameUnitKey)) {
          status = 'skip'
          messages.push('Osoba o tym imieniu i nazwisku jest już przypisana do tego lokalu')
        }
      }
    }

    let willCreateUnit = false
    if (status === 'create') {
      if (email) ctx.seenEmailsInFile.add(email)
      ctx.seenNameUnitInFile.add(nameUnitKey)
      if (!ctx.unitByNumber.has(unitNumber.toLowerCase())) {
        willCreateUnit = true
        if (!ctx.unitsToCreate.has(unitNumber)) {
          ctx.unitsToCreate.add(unitNumber)
          messages.push(`Lokal „${unitNumber}" zostanie utworzony`)
        }
      }
    }

    return {
      rowNumber: raw.rowNumber,
      firstName, lastName,
      email: email || null,
      phone: phone || null,
      unitNumber,
      street: street || null,
      status, messages, willCreateUnit,
    }
  }
}
