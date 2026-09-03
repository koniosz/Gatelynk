/**
 * Akuvox Contact Sync Service (v2) — orkiestracja warstw (pkt 1 spec):
 * Contact Domain / Contact Projection / Akuvox Adapter / Sync Engine /
 * Transport (MVP: manual) / Audit Log (akuvox_sync_runs).
 *
 * GateLynk = źródło prawdy; katalog Akuvox = synchronizowana kopia.
 * ZERO żądań do fizycznych urządzeń (Etap 1) — snapshoty pochodzą z plików
 * wgrywanych przez instalatora. Analiza: docs/akuvox-directory-v2-analysis.md.
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
import { AkuvoxCryptoService } from './akuvox-crypto.service'
import { AkuvoxDirectoryConfigService } from './akuvox-directory-config.service'
import { detectCapabilitiesFromInfo, recommendedAdapter } from './adapters/akuvox-capabilities'
import { AkuvoxDirectoryUserAdapter } from './adapters/akuvox-directory-user.adapter'
import { AkuvoxLegacyContactsAdapter } from './adapters/akuvox-legacy-contacts.adapter'
import { DirectoryDiffService } from './domain/directory-diff.service'
import {
  DirectoryProjectionService,
  SourceUnitRow,
} from './domain/directory-projection.service'
import {
  AkuvoxAdapter,
  AkuvoxCapabilities,
  AkuvoxDirectoryMapping,
  AkuvoxDirectorySnapshot,
  AkuvoxDirectoryUser,
  AkuvoxSnapshotEntry,
  ComparableField,
  ContactAuthority,
  DEFAULT_MAPPING,
  GeneratedImportFile,
  SyncPreviewResult,
  TemplateSpec,
  ValidationResult,
} from './domain/directory.types'
import {
  buildLegacyEntries,
  compareLegacyToV2,
  LEGACY_PARITY_MAPPING,
  MigrationReport,
} from './domain/legacy-migration'
import { BUILTIN_E18C_TEMPLATE } from './adapters/akuvox-legacy-contacts.adapter'
import { comparableFieldsFromSpec } from './template/akuvox-file-generator'
import { AkuvoxTemplateParser } from './template/akuvox-template.parser'
import { createHmac } from 'node:crypto'
import { sortUnits } from '../common/natural-sort'

export interface UpsertAkuvoxDeviceDto {
  intercomId?: number | null
  name: string
  model?: string | null
  ipAddress?: string | null
  macAddress?: string | null
  firmwareVersion?: string | null
  hardwareVersion?: string | null
  /** Host SIP numerów wybierania ("<unit.id>@<dialHost>"); puste = goły unit.id. */
  dialHost?: string | null
  syncMode?: string
  contactAuthority?: string
  adapter?: string
  mapping?: Partial<AkuvoxDirectoryMapping>
  credentialUser?: string | null
  /** Plain-text tylko w locie żądania — zapis wyłącznie AES-256-GCM. */
  credentialPassword?: string | null
  enabled?: boolean
}

const SYNC_MODES = ['MANUAL_EXPORT', 'MANUAL_IMPORT', 'PROVISIONING', 'DEVICE_API']
const AUTHORITIES = ['GATELYNK', 'SMARTPLUS', 'MERGED', 'MANUAL']
const ADAPTERS = ['legacy-contacts', 'directory-user']

@Injectable()
export class AkuvoxDirectoryService {
  private readonly logger = new Logger(AkuvoxDirectoryService.name)
  /** Blokada równoległej synchronizacji per urządzenie (pkt 18; MVP in-memory). */
  private readonly syncLocks = new Set<number>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: DirectoryProjectionService,
    private readonly diffEngine: DirectoryDiffService,
    private readonly templateParser: AkuvoxTemplateParser,
    private readonly crypto: AkuvoxCryptoService,
    private readonly config: AkuvoxDirectoryConfigService,
  ) {}

  // ── Dostęp / urządzenia ─────────────────────────────────────────────────────

  private async assertBuildingAccess(buildingId: number, adminId: number): Promise<void> {
    const b = await this.prisma.building.findFirst({ where: { id: buildingId, adminId }, select: { id: true } })
    if (!b) throw new ForbiddenException('Brak dostępu do budynku')
  }

  private async getDeviceChecked(deviceId: number, adminId: number) {
    const device = await this.prisma.akuvoxDevice.findUnique({
      where: { id: deviceId },
      include: { building: { select: { adminId: true } } },
    })
    if (!device) throw new NotFoundException('Urządzenie nie istnieje')
    if (device.building.adminId !== adminId) throw new ForbiddenException('Brak dostępu do urządzenia')
    return device
  }

  /** Poświadczenia NIE wracają do frontendu — tylko flaga credentialIsSet (pkt 18). */
  private sanitizeDevice(d: {
    credentialEnc: string | null
    [k: string]: unknown
  }): Record<string, unknown> {
    const { credentialEnc, lastDeviceSnapshot, ...rest } = d as Record<string, unknown>
    const snapshot = lastDeviceSnapshot as AkuvoxDirectorySnapshot | null
    return {
      ...rest,
      credentialIsSet: credentialEnc != null,
      deviceSnapshotEntryCount: snapshot?.entries?.length ?? null,
      deviceSnapshotTakenAt: snapshot?.takenAt ?? null,
    }
  }

  async listDevices(buildingId: number, adminId: number) {
    await this.assertBuildingAccess(buildingId, adminId)
    const devices = await this.prisma.akuvoxDevice.findMany({
      where: { buildingId },
      orderBy: { id: 'asc' },
    })
    return devices.map((d) => this.sanitizeDevice(d))
  }

  async createDevice(buildingId: number, adminId: number, dto: UpsertAkuvoxDeviceDto) {
    await this.assertBuildingAccess(buildingId, adminId)
    this.validateDeviceDto(dto)
    const data = await this.deviceDataFromDto(dto)
    const created = await this.prisma.akuvoxDevice.create({
      data: { buildingId, name: dto.name, ...data },
    })
    this.logger.log(`akuvox device created [b#${buildingId}] #${created.id} "${created.name}"`)
    return this.sanitizeDevice(created)
  }

  async updateDevice(deviceId: number, adminId: number, dto: Partial<UpsertAkuvoxDeviceDto>) {
    await this.getDeviceChecked(deviceId, adminId)
    this.validateDeviceDto(dto)
    const data = await this.deviceDataFromDto(dto)
    if (dto.name !== undefined) (data as Record<string, unknown>).name = dto.name
    const updated = await this.prisma.akuvoxDevice.update({ where: { id: deviceId }, data })
    return this.sanitizeDevice(updated)
  }

  private validateDeviceDto(dto: Partial<UpsertAkuvoxDeviceDto>): void {
    if (dto.syncMode !== undefined && !SYNC_MODES.includes(dto.syncMode)) {
      throw new BadRequestException(`Nieprawidłowy syncMode (dozwolone: ${SYNC_MODES.join(', ')})`)
    }
    if (dto.syncMode === 'PROVISIONING' && !this.config.flags.provisioningSync) {
      throw new BadRequestException('PROVISIONING wyłączony (flaga AKUVOX_PROVISIONING_SYNC) — Etap 2')
    }
    if (dto.syncMode === 'DEVICE_API' && !this.config.flags.directoryWriteApi) {
      throw new BadRequestException(
        'DEVICE_API wyłączony (flaga AKUVOX_DIRECTORY_WRITE_API) — wymaga potwierdzenia oficjalnych endpointów Akuvox (Etap 3)',
      )
    }
    if (dto.contactAuthority !== undefined && !AUTHORITIES.includes(dto.contactAuthority)) {
      throw new BadRequestException(`Nieprawidłowy contactAuthority (dozwolone: ${AUTHORITIES.join(', ')})`)
    }
    if (dto.adapter !== undefined && !ADAPTERS.includes(dto.adapter)) {
      throw new BadRequestException(`Nieprawidłowy adapter (dozwolone: ${ADAPTERS.join(', ')})`)
    }
    if (dto.dialHost != null && dto.dialHost !== '' && !/^[a-zA-Z0-9.\-]+(?::\d{1,5})?$/.test(dto.dialHost.trim())) {
      throw new BadRequestException('Nieprawidłowy dialHost — oczekiwany hostname lub IP (opcjonalnie :port)')
    }
  }

  private async deviceDataFromDto(dto: Partial<UpsertAkuvoxDeviceDto>) {
    const data: Record<string, unknown> = {}
    for (const key of [
      'intercomId',
      'model',
      'ipAddress',
      'macAddress',
      'firmwareVersion',
      'hardwareVersion',
      'dialHost',
      'syncMode',
      'contactAuthority',
      'adapter',
      'credentialUser',
      'enabled',
    ] as const) {
      if (dto[key] !== undefined) data[key] = dto[key]
    }
    if (dto.mapping !== undefined) {
      data.mapping = { ...DEFAULT_MAPPING, ...dto.mapping } as unknown as Prisma.InputJsonValue
    }
    if (dto.credentialPassword !== undefined && dto.credentialPassword !== null && dto.credentialPassword !== '') {
      // Szyfrowanie AES-256-GCM — rzuca gdy brak AKUVOX_CRED_KEY (nigdy plain-text).
      data.credentialEnc = this.crypto.encrypt(dto.credentialPassword)
    }
    return data
  }

  // ── Capabilities (pkt 6) — bez sieci, z danych urządzenia w bazie ───────────

  async getCapabilities(deviceId: number, adminId: number): Promise<AkuvoxCapabilities & { recommendedAdapter: string }> {
    const device = await this.getDeviceChecked(deviceId, adminId)
    const caps = detectCapabilitiesFromInfo({
      model: device.model ?? '',
      firmwareVersion: device.firmwareVersion ?? '',
      hardwareVersion: device.hardwareVersion ?? undefined,
      capabilitiesOverride: device.capabilitiesOverride as Partial<AkuvoxCapabilities> | null,
    })
    return { ...caps, recommendedAdapter: recommendedAdapter(caps) }
  }

  // ── Projekcja katalogu (widok C) ────────────────────────────────────────────

  /** Aktywne lokale budynku z mieszkańcami — wejście Contact Domain. */
  private async loadSourceRows(buildingId: number): Promise<SourceUnitRow[]> {
    const units = await this.prisma.unit.findMany({
      where: { buildingId },
      include: {
        stairwell: { select: { name: true } },
        contactGroup: { select: { name: true, sortOrder: true } },
        unitResidents: {
          where: { OR: [{ untilDate: null }, { untilDate: { gt: new Date() } }] },
          include: { resident: { select: { id: true, firstName: true, lastName: true, createdAt: true } } },
        },
      },
      orderBy: { number: 'asc' },
    })
    // Kolejność wpisów w książce telefonicznej domofonu — gość przewija ją
    // palcem, więc „1, 2, 3…" zamiast „1, 10, 11, 2" to nie kosmetyka.
    return sortUnits(units)
      .filter((u) => u.unitResidents.length > 0)
      .map((u) => ({
        unitId: u.id,
        unitNumber: u.number,
        street: u.street,
        floor: u.floor,
        stairwellName: u.stairwell?.name ?? null,
        contactGroupName: u.contactGroup?.name ?? null,
        contactGroupSortOrder: u.contactGroup?.sortOrder ?? null,
        residents: u.unitResidents.map((ur) => ({
          id: ur.resident.id,
          firstName: ur.resident.firstName,
          lastName: ur.resident.lastName,
        })),
        sourceUpdatedAt: u.unitResidents
          .map((ur) => ur.resident.createdAt)
          .reduce((max, d) => (d > max ? d : max), u.createdAt)
          .toISOString(),
      }))
  }

  private async buildProjection(device: {
    buildingId: number
    mapping: unknown
    dialHost?: string | null
  }): Promise<{ users: AkuvoxDirectoryUser[]; validation: ValidationResult; rows: SourceUnitRow[] }> {
    const rows = await this.loadSourceRows(device.buildingId)
    // Bugfix 2026-07-30: dialHost → numery jako "<unit.id>@<host>" (routing
    // per-lokal dla formatów dzwoniących na surowy string, np. CSV R29C).
    const persons = this.projection.toDirectoryPersons(rows, device.buildingId, {
      dialHost: device.dialHost,
    })
    const users = this.projection.projectToAkuvoxUsers(
      persons,
      device.mapping as Partial<AkuvoxDirectoryMapping> | null,
      rows,
    )
    const validation = this.projection.validateUsers(users)
    return { users, validation, rows }
  }

  async getDirectory(deviceId: number, adminId: number) {
    const device = await this.getDeviceChecked(deviceId, adminId)
    const { users, validation } = await this.buildProjection(device)
    return {
      entries: users,
      count: users.length,
      validCount: validation.validUsers.length,
      issues: validation.issues,
      directoryChecksum: DirectoryProjectionService.directoryChecksum(validation.validUsers),
      mapping: { ...DEFAULT_MAPPING, ...(device.mapping as object) },
    }
  }

  // ── Template + eksport z urządzenia (widok E) ───────────────────────────────

  async uploadTemplate(
    deviceId: number,
    adminId: number,
    file: { originalname: string; buffer: Buffer },
    operator: string,
  ) {
    const device = await this.getDeviceChecked(deviceId, adminId)
    if (!device.model || !device.firmwareVersion) {
      throw new BadRequestException('Uzupełnij model i wersję firmware urządzenia przed wgraniem template-a')
    }
    let spec: TemplateSpec
    try {
      spec = this.templateParser.parseTemplate(file.originalname, file.buffer)
    } catch (err) {
      await this.recordRun(deviceId, 'TEMPLATE_UPLOAD', 'ERROR', operator, {
        errors: [err instanceof Error ? err.message : String(err)],
        fileName: file.originalname,
      })
      throw err
    }
    const saved = await this.prisma.akuvoxImportTemplate.upsert({
      where: {
        model_firmwareVersion_format: {
          model: device.model,
          firmwareVersion: device.firmwareVersion,
          format: spec.format,
        },
      },
      create: {
        buildingId: device.buildingId,
        model: device.model,
        firmwareVersion: device.firmwareVersion,
        format: spec.format,
        originalFilename: file.originalname,
        rawFile: file.buffer,
        parsedSpec: spec as unknown as Prisma.InputJsonValue,
        uploadedBy: operator,
      },
      update: {
        originalFilename: file.originalname,
        rawFile: file.buffer,
        parsedSpec: spec as unknown as Prisma.InputJsonValue,
        uploadedBy: operator,
      },
    })
    await this.recordRun(deviceId, 'TEMPLATE_UPLOAD', spec.warnings?.length ? 'WARNING' : 'OK', operator, {
      warnings: spec.warnings,
      fileName: file.originalname,
    })
    this.logger.log(
      `akuvox template upserted #${saved.id} (${device.model}/${device.firmwareVersion}/${spec.format})`,
    )
    return { id: saved.id, format: spec.format, spec }
  }

  async uploadDeviceExport(
    deviceId: number,
    adminId: number,
    file: { originalname: string; buffer: Buffer },
    operator: string,
  ) {
    const device = await this.getDeviceChecked(deviceId, adminId)
    let entries: AkuvoxSnapshotEntry[]
    try {
      entries = this.templateParser.parseDeviceExport(file.originalname, file.buffer)
    } catch (err) {
      await this.recordRun(deviceId, 'DEVICE_EXPORT_UPLOAD', 'ERROR', operator, {
        errors: [err instanceof Error ? err.message : String(err)],
        fileName: file.originalname,
      })
      throw err
    }
    const snapshot: AkuvoxDirectorySnapshot = {
      takenAt: new Date().toISOString(),
      source: 'device-export-upload',
      entries,
    }
    await this.prisma.akuvoxDevice.update({
      where: { id: device.id },
      data: { lastDeviceSnapshot: snapshot as unknown as Prisma.InputJsonValue },
    })
    await this.recordRun(deviceId, 'DEVICE_EXPORT_UPLOAD', 'OK', operator, {
      summary: { create: 0, update: 0, disable: 0, delete: 0, unchanged: entries.length, conflicts: 0 },
      fileName: file.originalname,
    })
    return { entryCount: entries.length, takenAt: snapshot.takenAt }
  }

  // ── Dry-run / eksport / apply (pkt 8, 9, 16) ────────────────────────────────

  private deviceSnapshot(device: { lastDeviceSnapshot: unknown }): AkuvoxDirectorySnapshot {
    const snap = device.lastDeviceSnapshot as AkuvoxDirectorySnapshot | null
    return snap ?? { takenAt: new Date(0).toISOString(), source: 'empty', entries: [] }
  }

  private async adapterFor(device: {
    id: number
    model: string | null
    firmwareVersion: string | null
    hardwareVersion: string | null
    adapter: string
    capabilitiesOverride: unknown
    lastDeviceSnapshot: unknown
  }): Promise<AkuvoxAdapter> {
    const info = {
      model: device.model ?? '',
      firmwareVersion: device.firmwareVersion ?? '',
      hardwareVersion: device.hardwareVersion ?? undefined,
      capabilitiesOverride: device.capabilitiesOverride as Partial<AkuvoxCapabilities> | null,
    }
    const snapshot = this.deviceSnapshot(device)
    const template = await this.findTemplate(device)
    if (device.adapter === 'legacy-contacts') {
      return new AkuvoxLegacyContactsAdapter(info, snapshot, template)
    }
    return new AkuvoxDirectoryUserAdapter(info, snapshot, template)
  }

  private async findTemplate(device: {
    model: string | null
    firmwareVersion: string | null
  }): Promise<{ spec: TemplateSpec; source: string } | null> {
    if (!device.model || !device.firmwareVersion) return null
    const tpl = await this.prisma.akuvoxImportTemplate.findFirst({
      where: { model: device.model, firmwareVersion: device.firmwareVersion },
      orderBy: { createdAt: 'desc' },
    })
    if (!tpl) return null
    return { spec: tpl.parsedSpec as unknown as TemplateSpec, source: `template:${tpl.id}` }
  }

  /**
   * Etap 2 — checksum świadomy formatu: pola porównywalne dla urządzenia =
   * pola przenoszone przez jego template (wgrany lub builtin E18C dla
   * adaptera legacy). Bez template'a — porównanie pełne.
   */
  private async comparableFieldsFor(device: {
    model: string | null
    firmwareVersion: string | null
    adapter: string
  }): Promise<ComparableField[] | undefined> {
    const template = await this.findTemplate(device)
    if (template) return comparableFieldsFromSpec(template.spec)
    if (device.adapter === 'legacy-contacts') return comparableFieldsFromSpec(BUILTIN_E18C_TEMPLATE)
    return undefined
  }

  /**
   * Bugfix 2026-07-30: dla formatów kontaktów CSV (stacja dzwoni na SUROWY
   * string z kolumny TEL_*) brak dialHost = plik zadzwoni na goły unit.id.
   * Generujemy mimo to, ale GŁOŚNO ostrzegamy (preview + audyt eksportu).
   */
  private async dialHostWarning(device: {
    model: string | null
    firmwareVersion: string | null
    adapter: string
    dialHost: string | null
  }): Promise<string | null> {
    if (device.dialHost?.trim()) return null
    const template = await this.findTemplate(device)
    if (template?.spec.format !== 'csv') return null
    return (
      'Brak hosta SIP (dialHost) — numery w pliku kontaktów CSV będą gołym unit.id i stacja NIE dodzwoni się do lokalu. ' +
      'Ustaw dialHost w widoku A (zwykle LAN IP huba Edge; nie kopiuj ślepo IP z bazy urządzeń — bywa adresem Tailscale).'
    )
  }

  private withLock<T>(deviceId: number, fn: () => Promise<T>): Promise<T> {
    if (this.syncLocks.has(deviceId)) {
      throw new ConflictException('Synchronizacja tego urządzenia już trwa — spróbuj za chwilę')
    }
    this.syncLocks.add(deviceId)
    return fn().finally(() => this.syncLocks.delete(deviceId))
  }

  async preview(deviceId: number, adminId: number, operator: string): Promise<SyncPreviewResult> {
    const device = await this.getDeviceChecked(deviceId, adminId)
    return this.withLock(deviceId, async () => {
      const { users, validation } = await this.buildProjection(device)
      const comparedFields = await this.comparableFieldsFor(device)
      const diff = this.diffEngine.diff(
        validation.validUsers,
        this.deviceSnapshot(device),
        device.contactAuthority as ContactAuthority,
        comparedFields,
      )
      const { summary, changes } = DirectoryDiffService.summarize(diff, comparedFields)
      const warnings = [
        ...validation.issues.filter((i) => i.level === 'warning').map((i) => i.message),
        ...diff.conflicts.map((c) => c.reason),
      ]
      if (this.deviceSnapshot(device).source === 'empty') {
        warnings.push(
          'Brak eksportu z urządzenia — porównanie z pustym katalogiem. Przed pierwszym importem wgraj eksport z urządzenia (Import/Eksport), żeby chronić kontakty lokalne/SmartPlus.',
        )
      }
      const dialHostWarning = await this.dialHostWarning(device)
      if (dialHostWarning) warnings.push(dialHostWarning)
      const errors = validation.issues.filter((i) => i.level === 'error').map((i) => i.message)
      const result: SyncPreviewResult = {
        summary,
        changes,
        warnings,
        errors,
        directoryChecksum: DirectoryProjectionService.directoryChecksum(validation.validUsers),
        conflicts: diff.conflicts.map((c) => ({
          externalId: c.externalId,
          key: c.key,
          reason: c.reason,
          desiredName: c.desired?.name,
          currentName: c.current?.name,
          currentManagedBy: c.current?.managedBy,
        })),
        preservedForeignCount: diff.preservedForeign.length,
        comparedFields: comparedFields ?? [],
      }
      await this.recordRun(deviceId, 'PREVIEW', errors.length ? 'WARNING' : 'OK', operator, {
        summary,
        warnings,
        errors,
        directoryChecksum: result.directoryChecksum,
      })
      return result
    })
  }

  async exportFile(
    deviceId: number,
    adminId: number,
    operator: string,
  ): Promise<GeneratedImportFile & { syncRunId: number }> {
    if (!this.config.flags.manualImport) {
      throw new BadRequestException('Ręczny eksport wyłączony (flaga AKUVOX_MANUAL_IMPORT)')
    }
    const device = await this.getDeviceChecked(deviceId, adminId)
    return this.withLock(deviceId, async () => {
      const { users, validation } = await this.buildProjection(device)
      if (validation.validUsers.length === 0) {
        throw new BadRequestException('Brak poprawnych wpisów do eksportu — sprawdź walidację w podglądzie')
      }
      const adapter = await this.adapterFor(device)
      let file: GeneratedImportFile
      try {
        file = await adapter.generateImportFile(validation.validUsers)
      } catch (err) {
        await this.recordRun(deviceId, 'EXPORT', 'ERROR', operator, {
          errors: [err instanceof Error ? err.message : String(err)],
        })
        throw err
      }
      const exportWarnings = validation.issues.filter((i) => i.level === 'warning').map((i) => i.message)
      const dialHostWarning = await this.dialHostWarning(device)
      if (dialHostWarning) exportWarnings.push(dialHostWarning)
      const run = await this.recordRun(deviceId, 'EXPORT', dialHostWarning ? 'WARNING' : 'OK', operator, {
        summary: {
          create: 0,
          update: 0,
          disable: 0,
          delete: 0,
          unchanged: file.entryCount,
          conflicts: 0,
        },
        warnings: exportWarnings,
        directoryChecksum: file.directoryChecksum,
        fileName: file.fileName,
      })
      this.logger.log(
        `akuvox export [dev#${deviceId}] ${file.entryCount} wpisów → ${file.fileName} (${file.templateSource})`,
      )
      return { ...file, syncRunId: run.id }
    })
  }

  /**
   * MVP „apply" = potwierdzenie przez instalatora, że wygenerowany plik został
   * ręcznie zaimportowany na urządzeniu (pkt 8: MANUAL_IMPORT). Zapisuje
   * snapshot stanu (nasze wpisy + zachowane obce) i lastSyncAt. ZERO żądań
   * do urządzenia — DEVICE_API to Etap 3.
   */
  async applyConfirm(deviceId: number, adminId: number, operator: string) {
    if (!this.config.flags.manualImport) {
      throw new BadRequestException('Ręczny import wyłączony (flaga AKUVOX_MANUAL_IMPORT)')
    }
    const device = await this.getDeviceChecked(deviceId, adminId)
    return this.withLock(deviceId, async () => {
      const { users, validation } = await this.buildProjection(device)
      const previous = this.deviceSnapshot(device)
      const comparedFields = await this.comparableFieldsFor(device)
      const diff = this.diffEngine.diff(
        validation.validUsers,
        previous,
        device.contactAuthority as ContactAuthority,
        comparedFields,
      )
      const { summary } = DirectoryDiffService.summarize(diff, comparedFields)
      const checksum = DirectoryProjectionService.directoryChecksum(validation.validUsers)
      const snapshot: AkuvoxDirectorySnapshot = {
        takenAt: new Date().toISOString(),
        source: 'gatelynk-export',
        entries: [
          ...validation.validUsers.map((u) => ({
            ...u,
            managedBy: 'gatelynk' as const,
            checksum: DirectoryProjectionService.userChecksum(u),
          })),
          // Obce rekordy zachowane (pkt 9/11) — dalej częścią stanu urządzenia.
          ...diff.preservedForeign,
        ],
        directoryChecksum: checksum,
      }
      await this.prisma.akuvoxDevice.update({
        where: { id: deviceId },
        data: {
          lastDeviceSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          lastSyncAt: new Date(),
          lastSyncChecksum: checksum,
        },
      })
      const run = await this.recordRun(deviceId, 'APPLY', 'OK', operator, {
        summary,
        directoryChecksum: checksum,
      })
      return { ok: true, syncRunId: run.id, summary, directoryChecksum: checksum }
    })
  }

  // ── Kreator migracji legacy → v2 (pkt 20, Etap 2) ───────────────────────────

  /**
   * Podgląd migracji: wpisy legacy (odtworzone 1:1 z semantyki UserData.tgz /
   * Remote Phonebook) vs projekcja v2 pod mapowaniem parytetowym. NIC nie
   * zmienia — aktywacja to osobny `migrationAdopt`.
   */
  async migrationPreview(
    deviceId: number,
    adminId: number,
  ): Promise<MigrationReport & { proposedMapping: AkuvoxDirectoryMapping; currentMapping: unknown }> {
    const device = await this.getDeviceChecked(deviceId, adminId)
    const rows = await this.loadSourceRows(device.buildingId)
    const legacy = buildLegacyEntries(rows)
    const persons = this.projection.toDirectoryPersons(rows, device.buildingId)
    const v2Users = this.projection.projectToAkuvoxUsers(persons, LEGACY_PARITY_MAPPING, rows)
    const report = compareLegacyToV2(legacy, v2Users)
    return {
      ...report,
      proposedMapping: LEGACY_PARITY_MAPPING,
      currentMapping: { ...DEFAULT_MAPPING, ...(device.mapping as object) },
    }
  }

  /**
   * Aktywacja migracji: zapisuje mapowanie parytetowe na urządzeniu + raport
   * do historii (audyt). Starej konfiguracji NIE usuwa (phonebook URL działa
   * dalej — rollback możliwy); import pliku na urządzeniu to normalny flow
   * z widoku E po migracji.
   */
  async migrationAdopt(deviceId: number, adminId: number, operator: string) {
    const device = await this.getDeviceChecked(deviceId, adminId)
    const preview = await this.migrationPreview(deviceId, adminId)
    await this.prisma.akuvoxDevice.update({
      where: { id: deviceId },
      data: { mapping: LEGACY_PARITY_MAPPING as unknown as Prisma.InputJsonValue },
    })
    const status = preview.summary.differing > 0 ? 'WARNING' : 'OK'
    const run = await this.recordRun(deviceId, 'MIGRATION', status, operator, {
      summary: {
        create: 0,
        update: 0,
        disable: 0,
        delete: 0,
        unchanged: preview.summary.identical + preview.summary.expectedOnly,
        conflicts: preview.summary.differing,
      },
      warnings: preview.notes,
      errors: preview.rows
        .filter((r) => r.status === 'differs')
        .map((r) => `Lokal #${r.unitId}: ${r.differences.filter((d) => !d.expected).map((d) => `${d.field}: "${d.legacy}" → "${d.v2}"`).join('; ')}`),
    })
    this.logger.log(
      `akuvox migration adopt [dev#${deviceId}] ${preview.summary.total} wpisów (identical=${preview.summary.identical}, expected=${preview.summary.expectedOnly}, differing=${preview.summary.differing})`,
    )
    return { ...preview, adopted: true, syncRunId: run.id, status }
  }

  // ── PROVISIONING (SyncMode, Etap 2 — ZA FLAGĄ, default OFF) ─────────────────
  //
  // Mechanizm WYŁĄCZNIE po stronie GateLynk: plik importu wystawiony pod
  // stabilnym URL-em z tokenem per urządzenie (wzorzec autop/provisioning —
  // urządzenie samo pobiera). ZERO żądań do urządzeń. UWAGA: oficjalna
  // dokumentacja Akuvox NIE potwierdza dystrybucji katalogu użytkowników
  // przez autoprovisioning dla R29 na 29.30.10.x — endpoint jest
  // przygotowany, flaga AKUVOX_PROVISIONING_SYNC pozostaje false do czasu
  // potwierdzenia (analiza §9 / installer doc).

  /** Token per urządzenie (stabilny, bez DB) — wzorzec jak legacy tokenFor(). */
  static provisioningTokenFor(deviceId: number): string {
    const secret = process.env.JWT_SECRET ?? 'gatelynk-dev-secret'
    return createHmac('sha256', secret).update(`akuvox-prov:${deviceId}`).digest('hex').slice(0, 24)
  }

  /** Dane dla integratora (widok A): URL + token + status flagi. */
  async provisioningInfo(deviceId: number, adminId: number) {
    const device = await this.getDeviceChecked(deviceId, adminId)
    return {
      enabled: this.config.flags.provisioningSync,
      syncMode: device.syncMode,
      active: this.config.flags.provisioningSync && device.syncMode === 'PROVISIONING' && device.enabled,
      path: `/api/integrations/akuvox/provisioning/${deviceId}/directory`,
      token: AkuvoxDirectoryService.provisioningTokenFor(deviceId),
      note:
        'Dystrybucja katalogu użytkowników przez autoprovisioning NIE jest potwierdzona oficjalną dokumentacją Akuvox dla R29 na 29.30.10.x — endpoint przygotowany, flaga AKUVOX_PROVISIONING_SYNC domyślnie wyłączona.',
    }
  }

  /**
   * Pobranie pliku przez urządzenie (endpoint publiczny z tokenem — Akuvox
   * nie zrobi JWT). Wymaga: flaga ON + syncMode=PROVISIONING + enabled +
   * poprawny token. 404 (nie 403) przy wyłączonej fladze — nie zdradzamy
   * istnienia zasobu.
   */
  async provisioningFetch(deviceId: number, token: string): Promise<GeneratedImportFile> {
    if (!this.config.flags.provisioningSync) {
      throw new NotFoundException('Not found')
    }
    if (!token || token !== AkuvoxDirectoryService.provisioningTokenFor(deviceId)) {
      throw new ForbiddenException('bad token')
    }
    const device = await this.prisma.akuvoxDevice.findUnique({ where: { id: deviceId } })
    if (!device || !device.enabled || device.syncMode !== 'PROVISIONING') {
      throw new NotFoundException('Urządzenie nie jest w trybie PROVISIONING')
    }
    return this.withLock(deviceId, async () => {
      const { validation } = await this.buildProjection(device)
      if (validation.validUsers.length === 0) {
        throw new BadRequestException('Brak poprawnych wpisów do wydania')
      }
      const adapter = await this.adapterFor(device)
      const file = await adapter.generateImportFile(validation.validUsers)
      await this.recordRun(deviceId, 'PROVISION_FETCH', 'OK', 'DEVICE', {
        summary: { create: 0, update: 0, disable: 0, delete: 0, unchanged: file.entryCount, conflicts: 0 },
        directoryChecksum: file.directoryChecksum,
        fileName: file.fileName,
      })
      this.logger.log(`akuvox provisioning fetch [dev#${deviceId}] ${file.entryCount} wpisów`)
      return file
    })
  }

  // ── Historia (widok F, pkt 16/18) ───────────────────────────────────────────

  async history(deviceId: number, adminId: number, limit = 50) {
    await this.getDeviceChecked(deviceId, adminId)
    return this.prisma.akuvoxSyncRun.findMany({
      where: { deviceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    })
  }

  async getSyncRun(deviceId: number, syncId: number, adminId: number) {
    await this.getDeviceChecked(deviceId, adminId)
    const run = await this.prisma.akuvoxSyncRun.findFirst({ where: { id: syncId, deviceId } })
    if (!run) throw new NotFoundException('Operacja nie istnieje')
    return run
  }

  private async recordRun(
    deviceId: number,
    kind: string,
    status: string,
    operator: string,
    data: {
      summary?: unknown
      warnings?: unknown
      errors?: unknown
      directoryChecksum?: string
      fileName?: string
    },
  ) {
    return this.prisma.akuvoxSyncRun.create({
      data: {
        deviceId,
        kind,
        status,
        operator,
        summary: (data.summary as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        warnings: (data.warnings as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        errors: (data.errors as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        directoryChecksum: data.directoryChecksum,
        fileName: data.fileName,
      },
    })
  }
}
