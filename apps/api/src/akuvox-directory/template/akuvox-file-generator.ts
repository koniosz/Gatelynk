/**
 * Generator plików importu — TEMPLATE-DRIVEN (pkt 7 spec): plik jest budowany
 * w IDENTYCZNYM formacie jak template zdjęty z urządzenia (kolejność atrybutów/
 * kolumn, wartości stałe, separator, kodowanie, struktura archiwum). Formatu
 * NIE zgadujemy — wywołujący (adapter) dostarcza TemplateSpec albo odmawia.
 *
 * Tar/gzip: reużywamy sprawdzone `IntercomAkuvoxExportService.makeTar`
 * (ręczny ustar writer, format potwierdzony importem na E18C).
 */
import { BadRequestException } from '@nestjs/common'
import { gzipSync } from 'node:zlib'
import { IntercomAkuvoxExportService } from '../../resident/intercom-akuvox-export.service'
import {
  AkuvoxDirectoryUser,
  ComparableField,
  GeneratedImportFile,
  TemplateFileSpec,
  TemplateSpec,
} from '../domain/directory.types'
import { DirectoryProjectionService } from '../domain/directory-projection.service'

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Wartość atrybutu/kolumny z danych użytkownika — undefined gdy pole nie-danych. */
function dataValue(key: string, u: AkuvoxDirectoryUser, index: number): string | undefined {
  switch (key.toLowerCase()) {
    case 'id':
    case 'userid':
      return String(index + 1)
    case 'externalid':
      return u.externalId
    case 'name':
      return u.name
    case 'phone':
    case 'phone1':
    case 'number':
      return u.contacts[0]?.phone ?? ''
    case 'phone2':
      return u.contacts[1]?.phone ?? ''
    case 'phone3':
      return u.contacts[2]?.phone ?? ''
    case 'group':
    case 'groupname':
      return u.groupName ?? ''
    case 'roomnumber':
    case 'room':
      return u.roomNumber ?? ''
    case 'dialaccount':
      return u.contacts[0]?.dialAccount === 'Account2' ? '1' : '0'
    default:
      return undefined
  }
}

/**
 * Rodziny nagłówków rozpoznawane semantycznie. BUGFIX 2026-07-30 (realny cykl
 * na R29C fw 29.30.10.128): lokalny eksport kontaktów stacji to CSV w stylu
 * vCard (FN,N,EMAIL,TEL_HOME,TEL_WORK,…,GROUP,…,END) — poprzednie mapowanie
 * znało tylko nagłówki Name/Phone/Group i generowało PUSTE wiersze.
 */
const NAME_HEADERS = new Set(['name', 'username', 'user', 'displayname', 'fn'])
/** vCard "N" — nazwa bez spacji (sample R29C: „Jan Gola" → „JanGola"). */
const NAME_NOSPACE_HEADERS = new Set(['n'])
const GROUP_HEADERS = new Set(['group', 'groupname'])
const ROOM_HEADERS = new Set(['roomnumber', 'room'])
const PHONE_HEADERS = new Set([
  'phone',
  'phone1',
  'phone2',
  'phone3',
  'number',
  'tel',
  'tel_home',
  'tel_work',
  'tel_mobile',
  'tel_other',
  'tel_fax',
  'tel_custom',
])

/**
 * Etap 2 — checksum świadomy formatu: które pola danych format REALNIE
 * przenosi (na podstawie atrybutów/kolumn template'a). Diff porównuje tylko
 * te pola — patrz DirectoryDiffService.diff(comparableFields).
 */
export function comparableFieldsFromSpec(spec: TemplateSpec): ComparableField[] {
  const userFile = spec.files.find((f) => f.kind === 'user-data')
  const keys = (userFile?.attributes ?? userFile?.csvHeaders ?? []).map((k) => k.toLowerCase())
  const fields = new Set<ComparableField>()
  for (const k of keys) {
    if (NAME_HEADERS.has(k) || NAME_NOSPACE_HEADERS.has(k)) fields.add('name')
    if (ROOM_HEADERS.has(k)) fields.add('roomNumber')
    if (GROUP_HEADERS.has(k)) fields.add('group')
    if (PHONE_HEADERS.has(k)) fields.add('phones')
    if (k === 'dialaccount') fields.add('dialAccount')
  }
  return [...fields]
}

// ── Plan kolumn CSV (sample-driven, format vCard/Akuvox-contacts) ─────────────

type CsvColumnKind =
  | 'name'
  | 'nameNoSpaces'
  | 'phone' // phoneSlot wskazuje który kontakt (0 = priorytet 1)
  | 'group'
  | 'roomNumber'
  | 'dialAccount'
  | 'id'
  | 'constant' // odtwarzana wartość z sample (stała/kod, np. "0", "null:0", "END")
  | 'empty'

interface CsvColumnPlan {
  header: string
  kind: CsvColumnKind
  phoneSlot?: number
  constantValue?: string
}

/** Czy wartość z sample wygląda na stałą/kod (nie na dane/tekst wolny). */
function looksLikeConstant(value: string): boolean {
  if (value === '') return false
  if (/^[\d:.,;\/\-_+#]*$/.test(value)) return true // same cyfry/punktacja, np. "0"
  // Słowa-klucze + opcjonalny sufiks kodowy, np. "null:0", "END", "true".
  return /^(?:null|true|false|end|yes|no|on|off)(?:[:.,\-_\/]\w*)*$/i.test(value)
}

/** Tokeny (≥3 znaki) z wartości kolumn nazwowych sample — guard danych osobowych. */
function personalTokens(headers: string[], sample: Record<string, string> | undefined): string[] {
  if (!sample) return []
  const tokens: string[] = []
  for (const h of headers) {
    const key = h.toLowerCase()
    if (NAME_HEADERS.has(key) || NAME_NOSPACE_HEADERS.has(key)) {
      for (const t of (sample[h] ?? '').split(/[^\p{L}\p{N}]+/u)) {
        if (t.length >= 3) tokens.push(t.toLowerCase())
      }
    }
  }
  return tokens
}

/**
 * Plan kolumn CSV z nagłówków + wiersza przykładowego template'a:
 *  - rodzina TEL_x / Phone: slot priorytetu 1 dostaje kolumna, w której SAMPLE
 *    miał numer (na R29C: TEL_WORK); pozostałe kolejne sloty w kolejności;
 *  - kolumny nierozpoznane: wartość-stała/kod z sample jest odtwarzana
 *    (np. EMAIL="0", ADDR_OTHER="null:0", END="END"), pusto zostaje pusto,
 *    a wartości wyglądające na dane osobowe NIGDY nie są kopiowane.
 */
export function planCsvColumns(
  headers: string[],
  sample: Record<string, string> | undefined,
): CsvColumnPlan[] {
  const guard = personalTokens(headers, sample)
  const sampleOf = (h: string) => (sample?.[h] ?? '').trim()

  // Sloty numerów: kolumna z numerem w sample = kontakt[0] (priorytet 1).
  const phoneHeaders = headers.filter((h) => PHONE_HEADERS.has(h.toLowerCase()))
  const primary = phoneHeaders.find((h) => sampleOf(h) !== '') ?? phoneHeaders[0]
  const phoneSlots = new Map<string, number>()
  if (primary !== undefined) {
    phoneSlots.set(primary, 0)
    let slot = 1
    for (const h of phoneHeaders) {
      if (h !== primary) phoneSlots.set(h, slot++)
    }
  }

  return headers.map((header): CsvColumnPlan => {
    const key = header.toLowerCase()
    if (NAME_HEADERS.has(key)) return { header, kind: 'name' }
    if (NAME_NOSPACE_HEADERS.has(key)) return { header, kind: 'nameNoSpaces' }
    if (PHONE_HEADERS.has(key)) return { header, kind: 'phone', phoneSlot: phoneSlots.get(header) ?? 99 }
    if (GROUP_HEADERS.has(key)) return { header, kind: 'group' }
    if (ROOM_HEADERS.has(key)) return { header, kind: 'roomNumber' }
    if (key === 'dialaccount') return { header, kind: 'dialAccount' }
    if (key === 'id' || key === 'userid') return { header, kind: 'id' }

    const sampleValue = sampleOf(header)
    if (sampleValue === '') return { header, kind: 'empty' }
    const lower = sampleValue.toLowerCase()
    if (guard.some((t) => lower.includes(t))) return { header, kind: 'empty' } // dane osobowe — nie kopiuj
    if (looksLikeConstant(sampleValue)) return { header, kind: 'constant', constantValue: sampleValue }
    return { header, kind: 'empty' } // tekst wolny nieznanego znaczenia — bezpieczniej pusto
  })
}

function renderXmlUserFile(users: AkuvoxDirectoryUser[], file: TemplateFileSpec): string {
  const root = file.rootElement ?? 'UserData'
  const el = file.recordElement ?? 'Data'
  const attributes = file.attributes ?? []
  const constants = file.constants ?? {}
  const children = file.childElements ?? []

  const records = users.map((u, i) => {
    const attrs = attributes
      .map((key) => {
        const v = dataValue(key, u, i) ?? constants[key] ?? ''
        return `${key}="${escapeXml(v)}"`
      })
      .join(' ')
    if (children.length === 0) return `    <${el} ${attrs} />`
    const kids = children
      .map((c) => (c.toLowerCase() === 'pin' ? `        <${c} Code="" />` : `        <${c} />`))
      .join('\n')
    return `    <${el} ${attrs}>\n${kids}\n    </${el}>`
  })

  return `<?xml version="1.0" encoding="UTF-8" ?>\n<${root}>\n${records.join('\n')}\n</${root}>\n`
}

function renderCsv(users: AkuvoxDirectoryUser[], spec: TemplateSpec): string {
  const file = spec.files.find((f) => f.kind === 'user-data')
  const headers = file?.csvHeaders ?? []
  if (headers.length === 0) throw new BadRequestException('Template CSV nie zawiera nagłówków kolumn')
  const plan = planCsvColumns(headers, spec.sampleRecord)

  // Defense-in-depth (bugfix 2026-07-30): bez rozpoznanej kolumny nazwy ORAZ
  // numeru NIE produkujemy pliku — zamiast pustych wierszy czytelna odmowa.
  const hasName = plan.some((c) => c.kind === 'name' || c.kind === 'nameNoSpaces')
  const hasPhone = plan.some((c) => c.kind === 'phone')
  if (!hasName || !hasPhone) {
    throw new BadRequestException(
      `Template nie zawiera rozpoznawalnych kolumn ${!hasName ? 'nazwy' : ''}${!hasName && !hasPhone ? ' i ' : ''}${!hasPhone ? 'numeru' : ''} ` +
        `(nagłówki: ${headers.join(', ')}). Wgraj eksport z co najmniej jednym wypełnionym kontaktem lub zgłoś format do obsługi.`,
    )
  }

  const sep = spec.csvSeparator ?? ','
  const quote = (v: string) => (v.includes(sep) || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v)
  const cellValue = (c: (typeof plan)[number], u: AkuvoxDirectoryUser, i: number): string => {
    switch (c.kind) {
      case 'name':
        return u.name
      case 'nameNoSpaces':
        return u.name.replace(/\s+/g, '')
      case 'phone':
        return u.contacts[c.phoneSlot ?? 99]?.phone ?? ''
      case 'group':
        return u.groupName ?? ''
      case 'roomNumber':
        return u.roomNumber ?? ''
      case 'dialAccount':
        return u.contacts[0]?.dialAccount === 'Account2' ? '1' : '0'
      case 'id':
        return String(i + 1)
      case 'constant':
        return c.constantValue ?? ''
      default:
        return ''
    }
  }
  const rows = users.map((u, i) => plan.map((c) => quote(cellValue(c, u, i))).join(sep))
  return [headers.join(sep), ...rows].join('\r\n') + '\r\n'
}

export function generateFromSpec(
  users: AkuvoxDirectoryUser[],
  spec: TemplateSpec,
  opts: { fileName: string; templateSource: string },
): GeneratedImportFile {
  const checksum = DirectoryProjectionService.directoryChecksum(users)
  const base = {
    fileName: opts.fileName,
    templateSource: opts.templateSource,
    directoryChecksum: checksum,
    entryCount: users.length,
  }

  // CSV jako bajty — BOM odtwarzany DOKŁADNIE gdy sample go miał (encoding
  // z template'a). Używane i dla gołego CSV, i dla CSV wewnątrz tgz.
  const csvBuffer = (): Buffer => {
    let buf = Buffer.from(renderCsv(users, spec), 'utf8')
    if (spec.encoding === 'utf-8-bom') buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf])
    return buf
  }

  if (spec.format === 'csv') {
    return { ...base, mimeType: 'text/csv; charset=utf-8', content: csvBuffer(), format: 'csv' }
  }

  const userFile = spec.files.find((f) => f.kind === 'user-data')
  if (!userFile) throw new BadRequestException('Template nie zawiera pliku z danymi użytkowników')

  // Bugfix 2026-07-30 (2): realny eksport R29C = tgz z pojedynczym Contacts.csv
  // (BOM + nagłówki vCard). Gdy user-data w archiwum jest CSV — pakujemy
  // IDENTYCZNIE: tar (makeTar) z wpisem o tej samej nazwie inner + gzip.
  const innerIsCsv = (userFile.csvHeaders?.length ?? 0) > 0

  let userContent: Buffer
  if (innerIsCsv) {
    userContent = csvBuffer() // renderCsv ma własną odmowę przy braku kolumn nazwy/numeru
  } else {
    // Defense-in-depth (bugfix 2026-07-30) — także dla XML/TGZ: atrybuty muszą
    // zawierać rozpoznawalną nazwę i numer, inaczej odmowa zamiast pustych pól.
    const attrKeys = (userFile.attributes ?? []).map((a) => a.toLowerCase())
    if (!attrKeys.some((k) => NAME_HEADERS.has(k)) || !attrKeys.some((k) => PHONE_HEADERS.has(k))) {
      throw new BadRequestException(
        `Template nie zawiera rozpoznawalnych atrybutów nazwy/numeru (atrybuty: ${(userFile.attributes ?? []).join(', ')})`,
      )
    }
    userContent = Buffer.from(renderXmlUserFile(users, userFile), 'utf8')
  }

  if (spec.format === 'xml') {
    return {
      ...base,
      mimeType: 'application/xml; charset=utf-8',
      content: userContent,
      format: 'xml',
    }
  }

  // TGZ: pliki w KOLEJNOŚCI z template'a; nie-rekordowe przenoszone 1:1.
  // Nagłówki tar KLONOWANE ze wzorca (patch tylko size+checksum) — Akuvox
  // (busybox) odrzuca "File format error!" przy naszym POSIX-owym wariancie
  // (GNU magic "ustar  ", uname/gname, mode — odkryte na R29C 2026-07-30).
  const tarFiles = spec.files.map((f) => ({
    name: f.name,
    content:
      f.kind === 'user-data' ? userContent : Buffer.from(f.verbatimContent ?? '', 'utf8'),
    rawTarHeader: f.rawTarHeader,
  }))
  const tar = tarFiles.every((f) => f.rawTarHeader)
    ? buildTarFromClonedHeaders(tarFiles as { name: string; content: Buffer; rawTarHeader: string }[])
    : IntercomAkuvoxExportService.makeTar(tarFiles)
  // Wariant kompresji 1:1 ze wzorca — R29C eksportuje .tgz bez gzip (goły tar).
  if (spec.archiveCompressed === false) {
    return { ...base, mimeType: 'application/x-tar', content: tar, format: 'tgz' }
  }
  return { ...base, mimeType: 'application/gzip', content: gzipSync(tar), format: 'tgz' }
}


/** Tar z klonowanych nagłówków wzorca: podmieniamy TYLKO size (offset 124,
 *  11 cyfr ósemkowych + NUL — format jak w eksporcie stacji) i checksum
 *  (offset 148, 6 cyfr + NUL + spacja; liczony z polem checksum = spacje).
 *  Reszta pól (mode/uid/gid/mtime/magic GNU/uname/gname) zostaje 1:1. */
function buildTarFromClonedHeaders(
  files: { name: string; content: Buffer; rawTarHeader: string }[],
): Buffer {
  const parts: Buffer[] = []
  for (const f of files) {
    const header = Buffer.from(f.rawTarHeader, 'base64')
    if (header.length !== 512) throw new Error('rawTarHeader musi mieć 512 bajtów')
    const h = Buffer.from(header)
    // size: 11 cyfr ósemkowych + NUL (pole 124..136)
    const sizeOctal = f.content.length.toString(8).padStart(11, '0')
    h.write(sizeOctal + '\0', 124, 12, 'ascii')
    // checksum: pole (148..156) wypełnione spacjami na czas sumowania
    h.fill(0x20, 148, 156)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    const padded = Math.ceil(f.content.length / 512) * 512
    const data = Buffer.alloc(padded)
    f.content.copy(data)
    parts.push(h, data)
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}
