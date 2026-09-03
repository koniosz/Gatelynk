/**
 * BUGFIX 2026-07-30 — realny cykl na R29C fw 29.30.10.128: lokalny eksport
 * kontaktów stacji (Contacts.csv, nagłówki w stylu vCard: FN, N, TEL_x, GROUP,
 * END) generował plik z PUSTYMI wierszami (mapowanie semantyczne znało tylko
 * Name/Phone/Group).
 *
 * Fixture 1:1 z plików właściciela (template „Jan Gola" + wygenerowany CSV).
 * Testy: rozpoznanie rodziny vCard, transformacja N (bez spacji), slot numeru
 * po sample (TEL_WORK), stałe z sample (EMAIL="0", ADDR_OTHER="null:0",
 * END="END"), guard danych osobowych, dialHost → "<unit.id>@<host>",
 * odmowa przy nierozpoznawalnym templacie.
 */
import { gunzipSync, gzipSync } from 'node:zlib'
import { IntercomAkuvoxExportService } from '../../resident/intercom-akuvox-export.service'
import { DirectoryProjectionService, SourceUnitRow } from '../domain/directory-projection.service'
import { AkuvoxDirectoryUser } from '../domain/directory.types'
import { comparableFieldsFromSpec, generateFromSpec, planCsvColumns } from './akuvox-file-generator'
import { AkuvoxTemplateParser } from './akuvox-template.parser'

const parser = new AkuvoxTemplateParser()

/** DOKŁADNA treść realnego eksportu ze stacji (2 linie + pusta). */
const REAL_CONTACTS_CSV =
  'FN,N,EMAIL,TEL_HOME,TEL_WORK,TEL_MOBILE,TEL_OTHER,TEL_FAX,TEL_CUSTOM,COMPANY,TITLE,ADDR_MAIN,ADDR_OTHER,IMS,WEB,NOTES,BIRTHDAY,X-IRMC-LUID,GROUP,PHOTOPATH,PHOTO,END\n' +
  'Jan Gola,JanGola,0,,192.168.1.127,,,,,0,,,null:0,,,,,,,,,END\n'

function user(over: Partial<AkuvoxDirectoryUser> = {}): AkuvoxDirectoryUser {
  return {
    externalId: 'gl-u49',
    userId: '1',
    name: 'Niewinna 4/2 — Popek',
    roomNumber: 'Niewinna 4/2',
    groupName: 'Budynek 1',
    enabled: true,
    contacts: [{ phone: '49@192.168.1.127', priority: 'Primary', dialAccount: 'Account1' }],
    ...over,
  }
}

describe('realny template Contacts.csv z R29C (vCard)', () => {
  const spec = parser.parseTemplate('Contacts.csv', Buffer.from(REAL_CONTACTS_CSV, 'utf8'))

  it('parser: 22 kolumny, separator ",", sample Jan Gola', () => {
    expect(spec.format).toBe('csv')
    expect(spec.csvSeparator).toBe(',')
    expect(spec.files[0].csvHeaders).toHaveLength(22)
    expect(spec.sampleRecord?.FN).toBe('Jan Gola')
    expect(spec.sampleRecord?.TEL_WORK).toBe('192.168.1.127')
  })

  it('comparableFieldsFromSpec rozpoznaje rodzinę vCard (name/phones/group)', () => {
    expect(comparableFieldsFromSpec(spec).sort()).toEqual(['group', 'name', 'phones'])
  })

  it('plan kolumn: FN=name, N=nameNoSpaces, TEL_WORK=slot 0 (sample miał tam numer), stałe z sample', () => {
    const plan = planCsvColumns(spec.files[0].csvHeaders!, spec.sampleRecord)
    const byHeader = Object.fromEntries(plan.map((c) => [c.header, c]))
    expect(byHeader.FN.kind).toBe('name')
    expect(byHeader.N.kind).toBe('nameNoSpaces')
    expect(byHeader.TEL_WORK).toMatchObject({ kind: 'phone', phoneSlot: 0 })
    expect(byHeader.TEL_HOME.kind).toBe('phone')
    expect(byHeader.TEL_HOME.phoneSlot).toBeGreaterThan(0)
    expect(byHeader.GROUP.kind).toBe('group')
    expect(byHeader.EMAIL).toMatchObject({ kind: 'constant', constantValue: '0' })
    expect(byHeader.COMPANY).toMatchObject({ kind: 'constant', constantValue: '0' })
    expect(byHeader.ADDR_OTHER).toMatchObject({ kind: 'constant', constantValue: 'null:0' })
    expect(byHeader.END).toMatchObject({ kind: 'constant', constantValue: 'END' })
    expect(byHeader.TITLE.kind).toBe('empty')
    expect(byHeader.PHOTO.kind).toBe('empty')
  })

  it('generuje NIEPUSTE wiersze: FN/N/TEL_WORK z @host/GROUP/END wypełnione, stałe odtworzone, puste zostają puste', () => {
    const users = [
      user(),
      user({
        externalId: 'gl-u50',
        name: 'Niewinna 5/2 — Rubik',
        roomNumber: 'Niewinna 5/2',
        groupName: 'Budynek 1',
        contacts: [{ phone: '50@192.168.1.127', priority: 'Primary', dialAccount: 'Account1' }],
      }),
      user({
        externalId: 'gl-u52',
        name: 'Niewinna 6/1 — Staryga',
        roomNumber: 'Niewinna 6/1',
        groupName: 'Pozostali',
        contacts: [{ phone: '52@192.168.1.127', priority: 'Primary', dialAccount: 'Account1' }],
      }),
    ]
    const file = generateFromSpec(users, spec, { fileName: 'GateLynkDirectory.csv', templateSource: 'template:test' })
    const lines = file.content.toString('utf8').trim().split('\r\n')
    expect(lines[0]).toBe(REAL_CONTACTS_CSV.split('\n')[0]) // nagłówek 1:1
    expect(lines[1]).toBe(
      'Niewinna 4/2 — Popek,Niewinna4/2—Popek,0,,49@192.168.1.127,,,,,0,,,null:0,,,,,,Budynek 1,,,END',
    )
    expect(lines[2]).toBe(
      'Niewinna 5/2 — Rubik,Niewinna5/2—Rubik,0,,50@192.168.1.127,,,,,0,,,null:0,,,,,,Budynek 1,,,END',
    )
    expect(lines[3]).toBe(
      'Niewinna 6/1 — Staryga,Niewinna6/1—Staryga,0,,52@192.168.1.127,,,,,0,,,null:0,,,,,,Pozostali,,,END',
    )
    // Regresja bugfixa: ŻADEN wiersz nie jest samymi separatorami.
    for (const line of lines.slice(1)) {
      expect(line.replace(/,/g, '')).not.toBe('')
    }
  })

  it('eksport z urządzenia (widok E) parsuje FN + pierwszy niepusty TEL_*', () => {
    const entries = parser.parseDeviceExport('Contacts.csv', Buffer.from(REAL_CONTACTS_CSV, 'utf8'))
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('Jan Gola')
    expect(entries[0].contacts[0].phone).toBe('192.168.1.127')
  })
})

describe('guard danych osobowych + odmowa (defense-in-depth)', () => {
  it('NIGDY nie kopiuje do wszystkich wierszy wartości z nazwiskiem z sample', () => {
    const csv =
      'FN,N,TEL_WORK,NOTES,COMPANY,GROUP,END\n' +
      'Jan Gola,JanGola,192.168.1.127,notatka o Jan Gola,Gola,,END\n'
    const spec = parser.parseTemplate('Contacts.csv', Buffer.from(csv, 'utf8'))
    const plan = planCsvColumns(spec.files[0].csvHeaders!, spec.sampleRecord)
    const byHeader = Object.fromEntries(plan.map((c) => [c.header, c]))
    expect(byHeader.NOTES.kind).toBe('empty') // tekst wolny z nazwiskiem
    expect(byHeader.COMPANY.kind).toBe('empty') // wartość = nazwisko z sample
    const file = generateFromSpec([user()], spec, { fileName: 'x.csv', templateSource: 't' })
    const text = file.content.toString('utf8')
    expect(text).not.toContain('Gola')
    expect(text).not.toContain('notatka')
  })

  it('template bez rozpoznawalnych kolumn nazwy/numeru → ODMOWA (nie puste wiersze)', () => {
    const csv = 'A,B,C\nfoo,bar,baz\n'
    const spec = parser.parseTemplate('unknown.csv', Buffer.from(csv, 'utf8'))
    expect(() => generateFromSpec([user()], spec, { fileName: 'x.csv', templateSource: 't' })).toThrow(
      /rozpoznawalnych kolumn nazwy i numeru/,
    )
  })

  it('sama nazwa bez numeru → odmowa wskazująca brakujący numer', () => {
    const csv = 'FN,GROUP\nJan Gola,G\n'
    const spec = parser.parseTemplate('x.csv', Buffer.from(csv, 'utf8'))
    expect(() => generateFromSpec([user()], spec, { fileName: 'x.csv', templateSource: 't' })).toThrow(
      /rozpoznawalnych kolumn numeru/,
    )
  })

  it('XML bez atrybutu numeru → odmowa (ten sam strażnik dla XML/TGZ)', () => {
    const xml = `<?xml version="1.0"?>\n<UserData>\n    <Data ID="1" Name="X" Group="G" />\n</UserData>\n`
    const spec = parser.parseTemplate('x.xml', Buffer.from(xml, 'utf8'))
    expect(() => generateFromSpec([user()], spec, { fileName: 'x.xml', templateSource: 't' })).toThrow(
      /rozpoznawalnych atrybutów/,
    )
  })
})

describe('realne archiwum PhoneContacts.tgz z R29C (tgz z pojedynczym Contacts.csv + BOM)', () => {
  // Fixture 1:1 wg realnego archiwum: gzip+tar, JEDEN wpis w korzeniu
  // `Contacts.csv` (bez katalogu), zawartość z BOM UTF-8 przed "FN,".
  const innerCsv = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(REAL_CONTACTS_CSV, 'utf8')])
  const realTgz = gzipSync(
    IntercomAkuvoxExportService.makeTar([{ name: 'Contacts.csv', content: innerCsv }]),
  )

  const spec = parser.parseTemplate('PhoneContacts.tgz', realTgz)

  it('parser: format tgz, outerFilename, inner Contacts.csv, BOM, 22 kolumny vCard', () => {
    expect(spec.format).toBe('tgz')
    expect(spec.outerFilename).toBe('PhoneContacts.tgz')
    expect(spec.encoding).toBe('utf-8-bom')
    expect(spec.csvSeparator).toBe(',')
    const userFile = spec.files.find((f) => f.kind === 'user-data')!
    expect(userFile.name).toBe('Contacts.csv')
    expect(userFile.csvHeaders).toHaveLength(22)
    expect(spec.sampleRecord?.FN).toBe('Jan Gola')
    expect(comparableFieldsFromSpec(spec).sort()).toEqual(['group', 'name', 'phones'])
  })

  it('generacja: identyczne pakowanie (tar z 1 wpisem Contacts.csv, BOM, gzip) + wiersze jak w fixie CSV', () => {
    const users = [
      user(),
      user({
        externalId: 'gl-u50',
        name: 'Niewinna 5/2 — Rubik',
        groupName: 'Budynek 1',
        contacts: [{ phone: '50@192.168.1.127', priority: 'Primary', dialAccount: 'Account1' }],
      }),
    ]
    const file = generateFromSpec(users, spec, {
      fileName: spec.outerFilename ?? 'x.tgz',
      templateSource: 'template:test',
    })
    expect(file.format).toBe('tgz')
    expect(file.fileName).toBe('PhoneContacts.tgz')
    expect(file.mimeType).toBe('application/gzip')

    // Struktura bajtowa: gzip → tar → dokładnie 1 wpis o nazwie inner z template'a.
    const entries = AkuvoxTemplateParser.parseTar(gunzipSync(file.content))
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('Contacts.csv')
    // BOM obecny (sample go miał).
    expect([...entries[0].content.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])

    const lines = entries[0].content.subarray(3).toString('utf8').trim().split('\r\n')
    expect(lines[0]).toBe(REAL_CONTACTS_CSV.split('\n')[0])
    expect(lines[1]).toBe(
      'Niewinna 4/2 — Popek,Niewinna4/2—Popek,0,,49@192.168.1.127,,,,,0,,,null:0,,,,,,Budynek 1,,,END',
    )
    expect(lines[2]).toBe(
      'Niewinna 5/2 — Rubik,Niewinna5/2—Rubik,0,,50@192.168.1.127,,,,,0,,,null:0,,,,,,Budynek 1,,,END',
    )
    for (const line of lines.slice(1)) expect(line.replace(/,/g, '')).not.toBe('')
  })

  it('GOŁY tar bez gzip (prawdziwy eksport R29C — rozszerzenie .tgz kłamie): parse + generacja bez kompresji', () => {
    // Odkrycie na sprzęcie 2026-07-30: PhoneContacts.tgz ze stacji NIE jest
    // gzip-em — to nieskompresowany POSIX tar ("ustar" @257, plik zaczyna się
    // od nagłówka "Contacts.csv"). macOS tar auto-wykrywa i maskuje różnicę.
    const plainTar = IntercomAkuvoxExportService.makeTar([{ name: 'Contacts.csv', content: innerCsv }])
    const plainSpec = parser.parseTemplate('PhoneContacts.tgz', plainTar)
    expect(plainSpec.format).toBe('tgz')
    expect(plainSpec.archiveCompressed).toBe(false)
    expect(plainSpec.files.find((f) => f.kind === 'user-data')?.name).toBe('Contacts.csv')

    const file = generateFromSpec([user()], plainSpec, {
      fileName: plainSpec.outerFilename ?? 'x.tgz',
      templateSource: 'template:test',
    })
    // Wynik odtwarza wariant ze wzorca: BEZ gzip (magia ustar, nie 1f 8b).
    expect([file.content[0], file.content[1]]).not.toEqual([0x1f, 0x8b])
    expect(file.content.subarray(257, 262).toString('latin1')).toBe('ustar')
    const entries = AkuvoxTemplateParser.parseTar(file.content)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('Contacts.csv')
    expect([...entries[0].content.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    // Wariant gzip-owy dalej daje archiveCompressed=true (asercja obok w suite).
    expect(spec.archiveCompressed).toBe(true)
    // parseDeviceExport przyjmuje goły tar.
    const rt = parser.parseDeviceExport('PhoneContacts.tgz', file.content)
    expect(rt[0].contacts[0].phone).toBe('49@192.168.1.127')
  })

  it('round-trip: parseDeviceExport na wygenerowanym tgz + na realnym archiwum', () => {
    const fromReal = parser.parseDeviceExport('PhoneContacts.tgz', realTgz)
    expect(fromReal).toHaveLength(1)
    expect(fromReal[0].name).toBe('Jan Gola')
    expect(fromReal[0].contacts[0].phone).toBe('192.168.1.127')

    const file = generateFromSpec([user()], spec, { fileName: 'PhoneContacts.tgz', templateSource: 't' })
    const roundTrip = parser.parseDeviceExport('PhoneContacts.tgz', file.content)
    expect(roundTrip).toHaveLength(1)
    expect(roundTrip[0].name).toBe('Niewinna 4/2 — Popek')
    expect(roundTrip[0].groupName).toBe('Budynek 1')
    expect(roundTrip[0].contacts[0].phone).toBe('49@192.168.1.127')
  })

  it('metadane macOS w archiwum (._Contacts.csv, PaxHeader) są ignorowane', () => {
    // Instalator może przepakować eksport na Macu — bsdtar dopisuje AppleDouble.
    const appleDouble = Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]) // magic AppleDouble
    const tgzWithMeta = gzipSync(
      IntercomAkuvoxExportService.makeTar([
        { name: '._Contacts.csv', content: appleDouble },
        { name: '.DS_Store', content: Buffer.from('junk') },
        { name: 'Contacts.csv', content: innerCsv },
      ]),
    )
    const s = parser.parseTemplate('PhoneContacts.tgz', tgzWithMeta)
    const userFile = s.files.find((f) => f.kind === 'user-data')!
    expect(userFile.name).toBe('Contacts.csv')
    expect(s.files).toHaveLength(1) // metadane odfiltrowane
    expect(s.sampleRecord?.FN).toBe('Jan Gola')
  })

  it('zgodność wstecz: goły csv-template (bez BOM) dalej generuje goły CSV bez BOM', () => {
    const plainSpec = parser.parseTemplate('Contacts.csv', Buffer.from(REAL_CONTACTS_CSV, 'utf8'))
    expect(plainSpec.format).toBe('csv')
    expect(plainSpec.outerFilename).toBeUndefined()
    const file = generateFromSpec([user()], plainSpec, { fileName: 'GateLynkDirectory.csv', templateSource: 't' })
    expect(file.format).toBe('csv')
    expect(file.content[0]).not.toBe(0xef) // sample bez BOM → wynik bez BOM
    expect(file.content.toString('utf8')).toContain('49@192.168.1.127')
  })
})

describe('dialHost — SIP URI per lokal (routing zamiast fallback-all)', () => {
  const svc = new DirectoryProjectionService()
  const rows: SourceUnitRow[] = [
    {
      unitId: 49,
      unitNumber: 'Niewinna 4/2',
      street: null,
      floor: null,
      stairwellName: null,
      contactGroupName: 'Budynek 1',
      contactGroupSortOrder: 1,
      residents: [{ id: 1, firstName: 'Adam', lastName: 'Popek' }],
    },
  ]

  it('z dialHost target = sip "<unit.id>@<host>"; bez = extension "<unit.id>"', () => {
    const withHost = svc.toDirectoryPersons(rows, 9, { dialHost: '192.168.1.127' })
    expect(withHost[0].callTargets[0]).toMatchObject({ type: 'sip', value: '49@192.168.1.127' })
    const without = svc.toDirectoryPersons(rows, 9)
    expect(without[0].callTargets[0]).toMatchObject({ type: 'extension', value: '49' })
  })

  it('SIP URI przechodzi walidację numerów (znaki @ i kropki dozwolone)', () => {
    const users = svc.projectToAkuvoxUsers(svc.toDirectoryPersons(rows, 9, { dialHost: '192.168.1.127' }), null, rows)
    const res = svc.validateUsers(users)
    expect(res.issues.filter((i) => i.code === 'INVALID_PHONE_CHARS')).toHaveLength(0)
    expect(res.validUsers).toHaveLength(1)
  })
})
