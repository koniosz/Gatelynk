/**
 * Testy integracyjne parsera na FIXTURE (pkt 19 spec):
 *  - realny format UserData.tgz E18C — generowany statykami legacy
 *    `IntercomAkuvoxExportService` (format odtworzony 1:1 z urządzenia),
 *  - syntetyczny template 29.30.10.465 (do czasu realnego — patrz analiza §7.7),
 *  - eksport XML / CSV z R29 (syntetyczne),
 *  - eksport z kontaktami SmartPlus,
 *  - uszkodzony plik.
 * Bez bazy i bez żądań do urządzeń.
 */
import { gzipSync } from 'node:zlib'
import { IntercomAkuvoxExportService } from '../../resident/intercom-akuvox-export.service'
import { AkuvoxTemplateParser } from './akuvox-template.parser'

const parser = new AkuvoxTemplateParser()

/** Fixture: UserData.tgz w formacie E18C (przez legacy tar-writer). */
function makeE18cTgz(
  rows: { id: number; number: string; street: string | null; names: string | null; groupName?: string | null }[],
): Buffer {
  const userXml = IntercomAkuvoxExportService.buildUserDataXml(rows)
  const schedule =
    `<?xml version="1.0" encoding="UTF-8" ?>\n<Schedule>\n` +
    `    <Data ID="1" ScheduleID="1001" Name="Always" Type="2" Date="" Weekly="" Daily="00:00-23:59" />\n` +
    `</Schedule>\n`
  const tar = IntercomAkuvoxExportService.makeTar([
    { name: 'userdata.xml', content: Buffer.from(userXml, 'utf8') },
    { name: 'DoorSchedule.xml', content: Buffer.from(schedule, 'utf8') },
  ])
  return gzipSync(tar)
}

const E18C_ROWS = [
  { id: 41, number: '4/1', street: 'Niewinna', names: 'Kowalski', groupName: 'Budynek 1' },
  { id: 42, number: '4/2', street: 'Niewinna', names: 'Nowak / Zielińska', groupName: 'Budynek 1' },
]

describe('AkuvoxTemplateParser — template z realnego formatu E18C (tgz)', () => {
  it('parsuje UserData.tgz: format, pliki, atrybuty w kolejności, stałe, dziecko Pin', () => {
    const spec = parser.parseTemplate('UserData.tgz', makeE18cTgz(E18C_ROWS))
    expect(spec.format).toBe('tgz')
    const userFile = spec.files.find((f) => f.kind === 'user-data')!
    expect(userFile.name).toBe('userdata.xml')
    expect(userFile.rootElement).toBe('UserData')
    expect(userFile.recordElement).toBe('Data')
    expect(userFile.attributes).toEqual([
      'ID', 'UserID', 'Name', 'WebRelay', 'Floor', 'Phone', 'Group', 'PriorityOfCall',
      'DialAccount', 'Schedule-Relay', 'Schedule-SRelay',
    ])
    expect(userFile.constants).toMatchObject({
      WebRelay: '0',
      Floor: '0',
      DialAccount: '0',
      'Schedule-Relay': '1001-1;',
    })
    expect(userFile.childElements).toEqual(['Pin'])
    const schedule = spec.files.find((f) => f.kind === 'schedule')!
    expect(schedule.verbatimContent).toContain('ScheduleID="1001"')
  })

  it('parsuje eksport z urządzenia → snapshot entries (nazwa, phone=unit.id, grupa)', () => {
    const entries = parser.parseDeviceExport('UserData.tgz', makeE18cTgz(E18C_ROWS))
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      name: '4/1 — Kowalski',
      groupName: 'Budynek 1',
      managedBy: 'unknown',
    })
    expect(entries[0].contacts[0].phone).toBe('41')
  })
})

describe('AkuvoxTemplateParser — syntetyczny template 29.30.10.465 (XML)', () => {
  // UWAGA: format ZGADYWANY tylko na potrzeby testu parsera — generator
  // produkcyjny wymaga realnego template'a wgranego z urządzenia (pkt 7).
  const XML_465 =
    `<?xml version="1.0" encoding="UTF-8" ?>\n<UserData>\n` +
    `    <Data ID="1" UserID="1" Name="Jan Kowalski" RoomNumber="15A" Phone="101" Phone2="102" Group="Mieszkańcy" DialAccount="0" />\n` +
    `    <Data ID="2" UserID="2" Name="Anna Nowak" RoomNumber="15B" Phone="103" Phone2="" Group="Mieszkańcy" DialAccount="0" />\n` +
    `</UserData>\n`

  it('wykrywa atrybuty (w tym RoomNumber/Phone2) i stałe', () => {
    const spec = parser.parseTemplate('directory.xml', Buffer.from(XML_465, 'utf8'))
    expect(spec.format).toBe('xml')
    const f = spec.files[0]
    expect(f.attributes).toContain('RoomNumber')
    expect(f.attributes).toContain('Phone2')
    // Phone2 różni się między rekordami → NIE jest stałą.
    expect(f.constants).not.toHaveProperty('Phone2')
    expect(f.constants).toMatchObject({ DialAccount: '0' })
    expect(spec.sampleRecord?.Name).toBe('Jan Kowalski')
  })

  it('eksport XML z urządzenia → snapshot z roomNumber', () => {
    const entries = parser.parseDeviceExport('directory.xml', Buffer.from(XML_465, 'utf8'))
    expect(entries[0]).toMatchObject({ name: 'Jan Kowalski', roomNumber: '15A' })
  })

  it('eksport z kontaktami SmartPlus jest parsowany, managedBy=unknown (klasyfikacja w diffie)', () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>\n<UserData>\n` +
      `    <Data ID="1" UserID="1" Name="SmartPlus Family" Phone="sp10001" Group="SmartPlus" DialAccount="1" />\n` +
      `</UserData>\n`
    const entries = parser.parseDeviceExport('export.xml', Buffer.from(xml, 'utf8'))
    expect(entries[0].managedBy).toBe('unknown')
    expect(entries[0].contacts[0].dialAccount).toBe('Account2')
  })
})

describe('AkuvoxTemplateParser — CSV', () => {
  it('wykrywa separator ";", nagłówki i kodowanie BOM', () => {
    const csv = 'Name;Phone;Group;RoomNumber\r\nJan Kowalski;101;A;15A\r\n'
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')])
    const spec = parser.parseTemplate('contacts.csv', buf)
    expect(spec.format).toBe('csv')
    expect(spec.csvSeparator).toBe(';')
    expect(spec.encoding).toBe('utf-8-bom')
    expect(spec.files[0].csvHeaders).toEqual(['Name', 'Phone', 'Group', 'RoomNumber'])
    expect(spec.sampleRecord?.Phone).toBe('101')
  })

  it('eksport CSV z urządzenia → snapshot entries', () => {
    const csv = 'Name,Phone,Group\r\nOchrona,900,Serwis\r\n'
    const entries = parser.parseDeviceExport('contacts.csv', Buffer.from(csv, 'utf8'))
    expect(entries).toEqual([
      expect.objectContaining({ name: 'Ochrona', groupName: 'Serwis' }),
    ])
    expect(entries[0].contacts[0].phone).toBe('900')
  })
})

describe('AkuvoxTemplateParser — pliki błędne', () => {
  it('uszkodzony gzip → czytelny BadRequest', () => {
    const corrupted = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('to nie jest gzip')])
    expect(() => parser.parseTemplate('UserData.tgz', corrupted)).toThrow(/gzip/)
  })

  it('pusty plik i XML bez rekordów → odrzucone', () => {
    expect(() => parser.parseTemplate('x.xml', Buffer.alloc(0))).toThrow(/Pusty/)
    expect(() => parser.parseTemplate('x.xml', Buffer.from('<?xml version="1.0"?><Empty></Empty>'))).toThrow(
      /nie zawiera rekordów/,
    )
  })

  it('archiwum bez pliku użytkowników → odrzucone z listą znalezionych plików', () => {
    const tar = IntercomAkuvoxExportService.makeTar([
      { name: 'DoorSchedule.xml', content: Buffer.from('<Schedule></Schedule>') },
    ])
    expect(() => parser.parseTemplate('UserData.tgz', gzipSync(tar))).toThrow(/DoorSchedule\.xml/)
  })

  it('CSV z 1 kolumną → odrzucone', () => {
    expect(() => parser.parseTemplate('x.csv', Buffer.from('tylko-jedna-kolumna\nabc\n'))).toThrow(/kolumn/)
  })
})
