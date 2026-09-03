/**
 * Akuvox Directory Sync v2 — kanoniczny model domenowy (Contact Domain +
 * Contact Projection). Wiernie wg spec właściciela (2026-07-30), pkt 2/4/5/6/9/12/16.
 * Analiza: docs/akuvox-directory-v2-analysis.md.
 *
 * Zasada warstw: Contact Domain (DirectoryPerson) → Contact Projection
 * (AkuvoxDirectoryUser) → Akuvox Adapter → Sync Engine → Transport → Audit Log.
 * Logika Akuvox NIE mieszka w modelu mieszkańca.
 */

// ── Contact Domain ────────────────────────────────────────────────────────────

export interface CallTarget {
  id: string
  type: 'sip' | 'ip' | 'extension' | 'group'
  value: string
  priority: 1 | 2 | 3
  dialAccount?: 1 | 2
  enabled: boolean
}

export interface DirectoryPerson {
  id: string
  /** Brak encji Property w GateLynk — wypełniane String(buildingId) (analiza §7.1). */
  propertyId: string
  buildingId?: string
  unitId?: string
  displayName: string
  firstName?: string
  lastName?: string
  buildingNumber?: string
  staircase?: string
  floor?: string
  unitNumber?: string
  enabled: boolean
  visibleOnIntercom: boolean
  /** Nazwa grupy kontaktowej — mapowana na istniejący model ContactGroup (BA). */
  contactGroup?: string
  callTargets: CallTarget[]
  sourceUpdatedAt: string
  deletedAt?: string
}

// ── Contact Projection (Akuvox) ───────────────────────────────────────────────

export interface AkuvoxContactDetail {
  phone: string
  group?: string
  priority: 'Primary' | 'Secondary' | 'Tertiary'
  dialAccount: 'Account1' | 'Account2'
}

export interface AkuvoxDirectoryUser {
  /** Stabilny klucz idempotencji: `gl-u<unitId>` (displayMode=unit) / `gl-p<personId>`. */
  externalId: string
  userId: string
  name: string
  roomNumber?: string
  groupName?: string
  enabled: boolean
  contacts: AkuvoxContactDetail[]
}

// ── Capabilities (pkt 6) ──────────────────────────────────────────────────────

export interface AkuvoxCapabilities {
  model: string
  firmwareVersion: string
  hardwareVersion?: string
  supportsLegacyPhonebookUrl: boolean
  supportsDirectoryUsers: boolean
  supportsContactDetails: boolean
  supportsCsvImport: boolean
  supportsXmlImport: boolean
  supportsTgzImport: boolean
  supportsHttpApi: boolean
  /**
   * Zarządzanie kontaktami przez API urządzenia — OSOBNA flaga; NIE wynika
   * z samego istnienia menu HTTP API. True wyłącznie po potwierdzeniu
   * oficjalnych endpointów (dokumentacja producenta lub test na urządzeniu).
   */
  supportsDirectoryWriteApi: boolean
}

// ── Mapowanie (pkt 12) ────────────────────────────────────────────────────────

export interface AkuvoxDirectoryMapping {
  displayMode: 'person' | 'unit' | 'unit_group_call'
  groupBy: 'none' | 'building' | 'staircase' | 'floor'
  /** Szablony: {{lastName}} {{firstName}} {{lastNames}} {{unitNumber}} {{unitId}} {{buildingNumber}} {{staircase}} {{floor}} */
  displayNameTemplate: string
  roomNumberTemplate: string
  hideLastName: boolean
  anonymizeDirectory: boolean
}

/** Defaulty odtwarzające dzisiejsze zachowanie legacy (analiza §4.2). */
export const DEFAULT_MAPPING: AkuvoxDirectoryMapping = {
  displayMode: 'unit',
  groupBy: 'none',
  displayNameTemplate: '{{unitNumber}} — {{lastNames}}',
  roomNumberTemplate: '{{unitNumber}}',
  hideLastName: false,
  anonymizeDirectory: false,
}

// ── Sync różnicowy (pkt 9, 11) ────────────────────────────────────────────────

export type ManagedBy = 'gatelynk' | 'akuvox-cloud' | 'local' | 'unknown'

export type ContactAuthority = 'GATELYNK' | 'SMARTPLUS' | 'MERGED' | 'MANUAL'

export type SyncMode = 'MANUAL_EXPORT' | 'MANUAL_IMPORT' | 'PROVISIONING' | 'DEVICE_API'

export interface AkuvoxSnapshotEntry extends AkuvoxDirectoryUser {
  managedBy: ManagedBy
  checksum?: string
}

/** Stan katalogu odczytany z urządzenia (upload eksportu) lub z ostatniego eksportu. */
export interface AkuvoxDirectorySnapshot {
  takenAt: string
  source: 'device-export-upload' | 'gatelynk-export' | 'empty'
  entries: AkuvoxSnapshotEntry[]
  directoryChecksum?: string
}

export interface DirectoryConflict {
  externalId?: string
  key: string
  reason: string
  desired?: AkuvoxDirectoryUser
  current?: AkuvoxSnapshotEntry
}

/**
 * Pola porównywalne przy diffie — Etap 2 (checksum świadomy formatu):
 * porównujemy wyłącznie pola realnie przenoszone przez template danego
 * formatu (np. eksport E18C nie ma roomNumber → nie porównujemy roomNumber,
 * bo pierwsze porównanie dawałoby fałszywe „update").
 */
export type ComparableField = 'name' | 'roomNumber' | 'group' | 'phones' | 'dialAccount'

export const ALL_COMPARABLE_FIELDS: ComparableField[] = [
  'name',
  'roomNumber',
  'group',
  'phones',
  'dialAccount',
]

/** Zmiana pojedynczego pola (drill-down w widoku D). */
export interface FieldChange {
  field: string
  before: string
  after: string
}

export interface DirectoryDiff {
  usersToCreate: AkuvoxDirectoryUser[]
  usersToUpdate: { desired: AkuvoxDirectoryUser; current: AkuvoxSnapshotEntry }[]
  usersToDisable: AkuvoxDirectoryUser[]
  /** Wyłącznie rekordy managedBy='gatelynk' których już nie ma w źródle. Obce — NIGDY. */
  usersToDelete: AkuvoxSnapshotEntry[]
  unchangedUsers: AkuvoxDirectoryUser[]
  /** Rekordy spoza GateLynk zachowywane bez zmian (local/smartplus/unknown). */
  preservedForeign: AkuvoxSnapshotEntry[]
  conflicts: DirectoryConflict[]
}

// ── Dry-run / preview (pkt 16) ────────────────────────────────────────────────

export interface SyncPreviewSummary {
  create: number
  update: number
  disable: number
  delete: number
  unchanged: number
  conflicts: number
}

export interface SyncPreviewChange {
  op: 'create' | 'update' | 'disable' | 'delete'
  externalId?: string
  name: string
  detail?: string
  /** Etap 2 (widok D): zmiany per pole (before/after) dla op='update'. */
  fields?: FieldChange[]
}

export interface SyncPreviewConflict {
  externalId?: string
  key: string
  reason: string
  desiredName?: string
  currentName?: string
  currentManagedBy?: ManagedBy
}

export interface SyncPreviewResult {
  summary: SyncPreviewSummary
  changes: SyncPreviewChange[]
  warnings: string[]
  errors: string[]
  directoryChecksum: string
  /** Etap 2 (widok D): konflikty z kontekstem + liczba zachowanych obcych rekordów. */
  conflicts: SyncPreviewConflict[]
  preservedForeignCount: number
  /** Pola porównywane w tym diffie (checksum świadomy formatu). */
  comparedFields: ComparableField[]
}

// ── Walidacja (pkt 15) ────────────────────────────────────────────────────────

export interface ValidationIssue {
  level: 'error' | 'warning'
  code: string
  externalId?: string
  message: string
}

export interface ValidationResult {
  /** Wpisy które przeszły walidację (błędny pojedynczy kontakt NIE blokuje całości). */
  validUsers: AkuvoxDirectoryUser[]
  issues: ValidationIssue[]
}

// ── Adapter (pkt 5) ───────────────────────────────────────────────────────────

export interface GeneratedImportFile {
  fileName: string
  mimeType: string
  content: Buffer
  format: 'tgz' | 'xml' | 'csv'
  /** Skąd wzięto format: builtin (potwierdzony sprzętowo) lub id template'a z bazy. */
  templateSource: string
  directoryChecksum: string
  entryCount: number
}

export interface ApplyResult {
  ok: boolean
  message: string
  appliedAt?: string
}

export interface VerificationResult {
  ok: boolean
  message: string
  mismatches?: DirectoryConflict[]
}

/** Info o urządzeniu przekazywane adapterowi (Etap 1: z bazy, ZERO żądań do urządzeń). */
export interface AkuvoxDeviceInfo {
  model: string
  firmwareVersion: string
  hardwareVersion?: string
  capabilitiesOverride?: Partial<AkuvoxCapabilities> | null
}

export interface AkuvoxAdapter {
  detectCapabilities(): Promise<AkuvoxCapabilities>
  exportCurrentDirectory(): Promise<AkuvoxDirectorySnapshot>
  generateImportFile(users: AkuvoxDirectoryUser[]): Promise<GeneratedImportFile>
  applyDirectory(file: GeneratedImportFile): Promise<ApplyResult>
  verifyDirectory(): Promise<VerificationResult>
}

// ── Template (pkt 7) ──────────────────────────────────────────────────────────

export interface TemplateFileSpec {
  /** Surowy 512B nagłówek ustar wpisu z archiwum wzorca (base64) — generator
   *  klonuje go i patchuje tylko size+checksum (fidelity dla parsera Akuvoxa). */
  rawTarHeader?: string
  /** Nazwa pliku w archiwum (tgz) lub '-' dla formatów jednoplikowych. */
  name: string
  kind: 'user-data' | 'schedule' | 'other'
  /** XML: element główny dokumentu (np. UserData). */
  rootElement?: string
  /** XML: nazwa elementu rekordu + atrybuty w KOLEJNOŚCI z template'a. */
  recordElement?: string
  attributes?: string[]
  /** Atrybuty o stałej wartości w każdym rekordzie template'a (np. WebRelay="0"). */
  constants?: Record<string, string>
  /** Elementy dzieci rekordu (np. <Pin Code=""/>). */
  childElements?: string[]
  /** Surowa treść plików nie-rekordowych (przenoszone 1:1, np. DoorSchedule.xml). */
  verbatimContent?: string
  /** CSV: nagłówki w kolejności. */
  csvHeaders?: string[]
}

export interface TemplateSpec {
  format: 'tgz' | 'xml' | 'csv'
  /**
   * Bugfix 2026-07-30 (2): nazwa ZEWNĘTRZNA wgranego archiwum (np.
   * "PhoneContacts.tgz" z R29C) — wygenerowany plik dostaje tę samą nazwę,
   * a struktura archiwum (pojedynczy wpis inner, BOM) jest odtwarzana 1:1.
   */
  outerFilename?: string
  /** Czy archiwum wzorca było skompresowane gzip-em. R29C fw 29.30.10.128
   *  eksportuje .tgz będące GOŁYM tar-em — wynik odtwarza wariant z sample. */
  archiveCompressed?: boolean
  files: TemplateFileSpec[]
  /** CSV: separator (',' | ';' | '\t') i kodowanie ('utf-8' | 'utf-8-bom' | 'windows-1250'). */
  csvSeparator?: string
  encoding?: string
  /** Przykładowy rekord z template'a (debug / podgląd w panelu). */
  sampleRecord?: Record<string, string>
  /** Ostrzeżenia z parsowania. */
  warnings?: string[]
}
