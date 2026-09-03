/**
 * Parser template'ów Akuvox (pkt 7 spec) — administrator eksportuje z urządzenia
 * przykładowy plik, GateLynk zapisuje go jako template (model+firmware) i uczy
 * się z niego: nazw/kolejności atrybutów lub kolumn, wartości stałych,
 * separatora i kodowania CSV, struktury XML/TGZ. Generator produkuje potem plik
 * w IDENTYCZNYM formacie. Formatu nie zgadujemy — bez template'a generacja
 * directory-user jest odmawiana.
 *
 * Obsługiwane formaty: TGZ (tar+gzip, np. UserData.tgz z E18C — potwierdzony
 * sprzętowo), XML (pojedynczy plik), CSV. Czysta logika — testy na fixture.
 */
import { BadRequestException, Injectable } from '@nestjs/common'
import { gunzipSync } from 'node:zlib'
import {
  AkuvoxSnapshotEntry,
  TemplateFileSpec,
  TemplateSpec,
} from '../domain/directory.types'

export interface TarEntry {
  name: string
  content: Buffer
  /** Surowy 512-bajtowy nagłówek ustar wpisu — generator klonuje go 1:1
   *  (Akuvox/busybox odrzuca "File format error!" przy innym wariancie pól:
   *  GNU magic "ustar  ", uname/gname 10000, mode 600 — odkryte 2026-07-30). */
  header: Buffer
}

/** Atrybuty XML w kolejności wystąpienia. */
interface ParsedXmlRecord {
  attrs: [string, string][]
  children: string[]
}

@Injectable()
export class AkuvoxTemplateParser {
  // ── Format detection ────────────────────────────────────────────────────────

  detectFormat(filename: string, buf: Buffer): 'tgz' | 'xml' | 'csv' {
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'tgz'
    // R29C (fw 29.30.10.128) eksportuje "PhoneContacts.tgz" które jest GOŁYM
    // tar-em bez gzip (rozszerzenie kłamie) — magia "ustar" na offsecie 257.
    if (AkuvoxTemplateParser.looksLikeTar(buf)) return 'tgz'
    const head = buf.subarray(0, 512).toString('utf8').trimStart()
    if (head.startsWith('<?xml') || head.startsWith('<')) return 'xml'
    const lower = filename.toLowerCase()
    if (lower.endsWith('.xml')) return 'xml'
    if (lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) return 'tgz'
    return 'csv'
  }

  private static looksLikeTar(buf: Buffer): boolean {
    return buf.length >= 512 && buf.subarray(257, 262).toString('latin1') === 'ustar'
  }

  /** gzip+tar ALBO goły tar (R29C .tgz bez kompresji) → { tar, compressed }. */
  private static unpackArchive(buf: Buffer): { tar: Buffer; compressed: boolean } {
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        return { tar: gunzipSync(buf), compressed: true }
      } catch {
        throw new BadRequestException('Uszkodzony plik — nie udało się rozpakować gzip')
      }
    }
    if (AkuvoxTemplateParser.looksLikeTar(buf)) return { tar: buf, compressed: false }
    throw new BadRequestException('Uszkodzony plik — to nie jest gzip ani tar')
  }

  // ── Template parsing ────────────────────────────────────────────────────────

  parseTemplate(filename: string, buf: Buffer): TemplateSpec {
    if (buf.length === 0) throw new BadRequestException('Pusty plik template')
    const format = this.detectFormat(filename, buf)
    switch (format) {
      case 'tgz':
        return this.parseTgzTemplate(buf, filename)
      case 'xml':
        return this.parseXmlTemplate('-', this.decodeText(buf).text, this.decodeText(buf).encoding)
      case 'csv':
        return this.parseCsvTemplate(buf)
    }
  }

  private parseTgzTemplate(buf: Buffer, outerFilename?: string): TemplateSpec {
    const { tar, compressed } = AkuvoxTemplateParser.unpackArchive(buf)
    const entries = AkuvoxTemplateParser.parseTar(tar)
    if (entries.length === 0) throw new BadRequestException('Archiwum tar nie zawiera plików')

    const files: TemplateFileSpec[] = []
    const warnings: string[] = []
    let sampleRecord: Record<string, string> | undefined
    let encoding = 'utf-8'

    let csvSeparator: string | undefined

    for (const e of entries) {
      const decoded = this.decodeText(e.content)
      // Klasyfikacja po NAZWIE PLIKU, nie pełnej ścieżce — E18C pakuje w katalog
      // "UserData/", przez co DoorSchedule.xml matchował 'userdata' po ścieżce
      // i był nadpisywany treścią użytkowników (bug znaleziony 2026-07-30).
      const lower = (e.name.split('/').pop() ?? e.name).toLowerCase()
      const isDir = e.name.endsWith('/') || e.content.length === 0
      if (isDir) {
        // Wpis katalogu (albo pusty plik) — przenosimy 1:1, bez parsowania.
        files.push({ name: e.name, kind: 'other', verbatimContent: '', rawTarHeader: e.header.toString('base64') })
        continue
      }
      if (lower.includes('userdata') || lower.includes('contact') || lower.includes('user')) {
        if (AkuvoxTemplateParser.looksLikeXml(decoded.text)) {
          const spec = this.parseXmlTemplate(e.name, decoded.text, decoded.encoding)
          const fileSpec = spec.files[0]
          fileSpec.kind = 'user-data'
          fileSpec.rawTarHeader = e.header.toString('base64')
          files.push(fileSpec)
          sampleRecord = spec.sampleRecord ?? sampleRecord
          warnings.push(...(spec.warnings ?? []))
          encoding = decoded.encoding
        } else {
          // Bugfix 2026-07-30 (2): realny eksport R29C to tgz z pojedynczym
          // Contacts.csv (BOM UTF-8 + nagłówki vCard) — parsujemy istniejącą
          // ścieżką CSV i zapamiętujemy strukturę archiwum (inner name, BOM).
          const csvSpec = this.parseCsvTemplate(e.content)
          const fileSpec = csvSpec.files[0]
          fileSpec.name = e.name
          fileSpec.kind = 'user-data'
          fileSpec.rawTarHeader = e.header.toString('base64')
          files.push(fileSpec)
          sampleRecord = csvSpec.sampleRecord ?? sampleRecord
          warnings.push(...(csvSpec.warnings ?? []))
          encoding = csvSpec.encoding ?? decoded.encoding
          csvSeparator = csvSpec.csvSeparator
        }
      } else {
        files.push({
          name: e.name,
          kind: lower.includes('schedule') ? 'schedule' : 'other',
          verbatimContent: decoded.text,
          rawTarHeader: e.header.toString('base64'),
        })
      }
    }
    if (!files.some((f) => f.kind === 'user-data')) {
      throw new BadRequestException(
        `Archiwum nie zawiera pliku z danymi użytkowników (znalezione: ${entries.map((e) => e.name).join(', ')})`,
      )
    }
    return { format: 'tgz', outerFilename, archiveCompressed: compressed, files, encoding, csvSeparator, sampleRecord, warnings }
  }

  private static looksLikeXml(text: string): boolean {
    return text.trimStart().startsWith('<')
  }

  private parseXmlTemplate(fileName: string, text: string, encoding: string): TemplateSpec {
    const records = AkuvoxTemplateParser.extractXmlRecords(text)
    if (records.length === 0) {
      throw new BadRequestException(
        `Plik ${fileName === '-' ? 'XML' : fileName} nie zawiera rekordów użytkowników (<Data>/<Contact>)`,
      )
    }
    const { recordElement, parsed } = records[0].meta
    const attributes = parsed[0].attrs.map(([k]) => k)
    // Stałe: atrybuty o tej samej wartości we WSZYSTKICH rekordach template'a,
    // niebędące polami danych (nazwa/numer/grupa zmieniają się per rekord).
    const dataAttrs = new Set(['id', 'userid', 'name', 'phone', 'group', 'roomnumber', 'room'])
    const constants: Record<string, string> = {}
    for (const [key, firstVal] of parsed[0].attrs) {
      if (dataAttrs.has(key.toLowerCase())) continue
      const allSame = parsed.every((r) => r.attrs.find(([k]) => k === key)?.[1] === firstVal)
      if (allSame) constants[key] = firstVal
    }
    const warnings: string[] = []
    if (parsed.length === 1) {
      warnings.push(
        'Template zawiera tylko 1 rekord — wartości stałe wykryte z pojedynczego przykładu (zalecane ≥2 rekordy)',
      )
    }
    const sampleRecord = Object.fromEntries(parsed[0].attrs)
    const rootMatch = /<\?xml[^>]*\?>\s*<([A-Za-z0-9_:.\-]+)/.exec(text) ?? /^\s*<([A-Za-z0-9_:.\-]+)/.exec(text)
    return {
      format: 'xml',
      files: [
        {
          name: fileName,
          kind: 'user-data',
          rootElement: rootMatch?.[1] ?? 'UserData',
          recordElement,
          attributes,
          constants,
          childElements: parsed[0].children,
        },
      ],
      encoding,
      sampleRecord,
      warnings,
    }
  }

  private parseCsvTemplate(buf: Buffer): TemplateSpec {
    const { text, encoding } = this.decodeText(buf)
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (lines.length === 0) throw new BadRequestException('Pusty plik CSV')
    const header = lines[0]
    const counts: [string, number][] = [
      [';', (header.match(/;/g) ?? []).length],
      [',', (header.match(/,/g) ?? []).length],
      ['\t', (header.match(/\t/g) ?? []).length],
    ]
    counts.sort((a, b) => b[1] - a[1])
    const separator = counts[0][1] > 0 ? counts[0][0] : ','
    const csvHeaders = header.split(separator).map((h) => h.trim().replace(/^"|"$/g, ''))
    if (csvHeaders.length < 2) {
      throw new BadRequestException('Nagłówek CSV ma mniej niż 2 kolumny — plik nie wygląda na eksport kontaktów')
    }
    const warnings: string[] = []
    if (lines.length < 2) warnings.push('CSV bez wierszy danych — brak przykładowego rekordu')
    const sampleRecord =
      lines.length >= 2
        ? Object.fromEntries(
            csvHeaders.map((h, i) => [h, (lines[1].split(separator)[i] ?? '').trim().replace(/^"|"$/g, '')]),
          )
        : undefined
    return {
      format: 'csv',
      files: [{ name: '-', kind: 'user-data', csvHeaders }],
      csvSeparator: separator,
      encoding,
      sampleRecord,
      warnings,
    }
  }

  // ── Device export → snapshot (widok E: „wgraj eksport z urządzenia") ────────

  parseDeviceExport(filename: string, buf: Buffer): AkuvoxSnapshotEntry[] {
    const format = this.detectFormat(filename, buf)
    let text: string
    if (format === 'tgz') {
      const { tar } = AkuvoxTemplateParser.unpackArchive(buf)
      const entries = AkuvoxTemplateParser.parseTar(tar)
      const userFile = entries.find((e) => {
        if (e.name.endsWith('/') || e.content.length === 0) return false
        const l = (e.name.split('/').pop() ?? e.name).toLowerCase()
        return l.includes('userdata') || l.includes('contact') || l.includes('user')
      })
      if (!userFile) throw new BadRequestException('Archiwum nie zawiera pliku z użytkownikami')
      text = this.decodeText(userFile.content).text
      // Bugfix 2026-07-30 (2): tgz z CSV w środku (PhoneContacts.tgz z R29C).
      if (!AkuvoxTemplateParser.looksLikeXml(text)) {
        return this.parseCsvExport(userFile.content)
      }
    } else if (format === 'xml') {
      text = this.decodeText(buf).text
    } else {
      return this.parseCsvExport(buf)
    }

    const records = AkuvoxTemplateParser.extractXmlRecords(text)
    if (records.length === 0) return []
    return records[0].meta.parsed.map((r) => AkuvoxTemplateParser.xmlRecordToEntry(r))
  }

  private parseCsvExport(buf: Buffer): AkuvoxSnapshotEntry[] {
    const spec = this.parseCsvTemplate(buf)
    const { text } = this.decodeText(buf)
    const sep = spec.csvSeparator ?? ','
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    const headers = (spec.files[0].csvHeaders ?? []).map((h) => h.toLowerCase())
    const idx = (name: string) => headers.findIndex((h) => h === name)
    // Bugfix 2026-07-30: lokalny eksport kontaktów R29C używa nagłówków
    // vCard — FN (nazwa wyświetlana) + rodzina TEL_* (sloty numerów).
    const nameIdx = ['fn', 'name', 'username', 'user'].map(idx).find((i) => i >= 0) ?? -1
    const phoneIdxs = ['phone', 'number', 'phone1', 'phone2', 'phone3', 'tel', 'tel_home', 'tel_work', 'tel_mobile', 'tel_other', 'tel_fax', 'tel_custom']
      .map(idx)
      .filter((i) => i >= 0)
    const groupIdx = ['group', 'groupname'].map(idx).find((i) => i >= 0) ?? -1
    const roomIdx = ['roomnumber', 'room'].map(idx).find((i) => i >= 0) ?? -1
    return lines.slice(1).map((line, i) => {
      const cols = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''))
      // Numer = pierwsza niepusta kolumna z rodziny phone/TEL_* w TYM wierszu.
      const phone = phoneIdxs.map((p) => cols[p] ?? '').find((v) => v !== '') ?? ''
      return {
        externalId: '',
        userId: String(i + 1),
        name: nameIdx >= 0 ? (cols[nameIdx] ?? '') : '',
        roomNumber: roomIdx >= 0 ? cols[roomIdx] : undefined,
        groupName: groupIdx >= 0 ? cols[groupIdx] : undefined,
        enabled: true,
        contacts: phone ? [{ phone, priority: 'Primary' as const, dialAccount: 'Account1' as const }] : [],
        managedBy: 'unknown' as const,
      }
    })
  }

  // ── Static helpers ──────────────────────────────────────────────────────────

  private static xmlRecordToEntry(r: ParsedXmlRecord): AkuvoxSnapshotEntry {
    const get = (key: string) => r.attrs.find(([k]) => k.toLowerCase() === key)?.[1]
    const phone = get('phone') ?? ''
    const dial = get('dialaccount')
    return {
      externalId: get('externalid') ?? '',
      userId: get('userid') ?? get('id') ?? '',
      name: get('name') ?? '',
      roomNumber: get('roomnumber') ?? get('room'),
      groupName: get('group'),
      enabled: true,
      contacts: phone
        ? [
            {
              phone,
              group: get('group'),
              priority: 'Primary',
              dialAccount: dial === '1' ? 'Account2' : 'Account1',
            },
          ]
        : [],
      managedBy: 'unknown',
    }
  }

  /**
   * Wyciąga rekordy `<Data …>`/`<Contact …>` z XML (regex — format Akuvox jest
   * płaski i przewidywalny; pełny parser XML = nowa zależność npm, unikamy
   * jak w legacy tar-writerze).
   */
  static extractXmlRecords(
    text: string,
  ): { meta: { recordElement: string; parsed: ParsedXmlRecord[] } }[] {
    for (const el of ['Data', 'Contact', 'User']) {
      const re = new RegExp(`<${el}\\b([^>]*?)(/>|>([\\s\\S]*?)</${el}>)`, 'g')
      const parsed: ParsedXmlRecord[] = []
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const attrText = m[1]
        const inner = m[3] ?? ''
        const attrs: [string, string][] = []
        const attrRe = /([A-Za-z0-9_:.\-]+)\s*=\s*"([^"]*)"/g
        let am: RegExpExecArray | null
        while ((am = attrRe.exec(attrText)) !== null) attrs.push([am[1], AkuvoxTemplateParser.unescapeXml(am[2])])
        const children: string[] = []
        const childRe = /<([A-Za-z0-9_:.\-]+)\b[^>]*\/?>/g
        let cm: RegExpExecArray | null
        while ((cm = childRe.exec(inner)) !== null) {
          if (!children.includes(cm[1]) && cm[1] !== el) children.push(cm[1])
        }
        parsed.push({ attrs, children })
      }
      if (parsed.length > 0) return [{ meta: { recordElement: el, parsed } }]
    }
    return []
  }

  /** Minimalny czytnik tar (ustar) — odpowiednik makeTar z legacy serwisu. */
  static parseTar(tar: Buffer): TarEntry[] {
    const entries: TarEntry[] = []
    let offset = 0
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512)
      if (header.every((b) => b === 0)) break // koniec archiwum
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
      const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/[^0-7]/g, '')
      const size = Number.parseInt(sizeOctal || '0', 8)
      if (!name || Number.isNaN(size)) {
        throw new BadRequestException('Uszkodzone archiwum tar — nieczytelny nagłówek')
      }
      const typeflag = String.fromCharCode(header[156])
      const content = tar.subarray(offset + 512, offset + 512 + size)
      // Pomijamy metadane archiwizatorów (bugfix 2026-07-30/2): macOS bsdtar
      // dopisuje AppleDouble "._plik" i "PaxHeader/…" — to NIE są pliki danych
      // (instalator może przepakować eksport na Macu).
      const base = name.split('/').pop() ?? name
      const isMeta = base.startsWith('._') || base === '.DS_Store' || name.startsWith('PaxHeader/')
      if ((typeflag === '0' || typeflag === '\0' || typeflag === '') && !isMeta) {
        entries.push({ name, content: Buffer.from(content), header: Buffer.from(header) })
      } else if (typeflag === '5' && !isMeta) {
        // Wpis KATALOGU (E18C pakuje pliki w "UserData/") — zachowujemy, żeby
        // generator odtworzył archiwum 1:1 (klonowany nagłówek, content pusty).
        entries.push({ name, content: Buffer.alloc(0), header: Buffer.from(header) })
      }
      offset += 512 + Math.ceil(size / 512) * 512
    }
    return entries
  }

  /** Dekodowanie tekstu: BOM UTF-8 → 'utf-8-bom'; nie-UTF8 → 'windows-1250' (best effort). */
  private decodeText(buf: Buffer): { text: string; encoding: string } {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' }
    }
    const utf8 = buf.toString('utf8')
    if (!utf8.includes('�')) return { text: utf8, encoding: 'utf-8' }
    // Fallback latin — dokładna transkodacja windows-1250 w Etapie 2 (iconv);
    // na potrzeby template'u wystarczy struktura, nie diakrytyki.
    return { text: buf.toString('latin1'), encoding: 'windows-1250' }
  }

  private static unescapeXml(s: string): string {
    return s
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
  }
}
