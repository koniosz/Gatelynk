/**
 * Testy adapterów + capabilities (pkt 19 spec): detectCapabilities wyłącznie
 * na mockach (ZERO żądań do urządzeń), odmowa generacji bez template'a,
 * roundtrip generacja → parser, nieobsługiwany firmware.
 */
import { AkuvoxTemplateParser } from '../template/akuvox-template.parser'
import {
  compareFirmware,
  detectCapabilitiesFromInfo,
  recommendedAdapter,
} from './akuvox-capabilities'
import { AkuvoxDirectoryUserAdapter } from './akuvox-directory-user.adapter'
import {
  AkuvoxLegacyContactsAdapter,
  BUILTIN_E18C_TEMPLATE,
  BUILTIN_E18C_TEMPLATE_SOURCE,
} from './akuvox-legacy-contacts.adapter'
import {
  AkuvoxDirectorySnapshot,
  AkuvoxDirectoryUser,
} from '../domain/directory.types'

const EMPTY_SNAP: AkuvoxDirectorySnapshot = { takenAt: new Date(0).toISOString(), source: 'empty', entries: [] }

const USERS: AkuvoxDirectoryUser[] = [
  {
    externalId: 'gl-u41',
    userId: '1',
    name: 'Niewinna 4/1 — Kowalski',
    roomNumber: '4/1',
    groupName: 'Budynek 1',
    enabled: true,
    contacts: [{ phone: '41', priority: 'Primary', dialAccount: 'Account1' }],
  },
  {
    externalId: 'gl-u42',
    userId: '2',
    name: 'Niewinna 4/2 — Nowak & Syn', // & wymaga escapowania XML
    roomNumber: '4/2',
    groupName: 'Budynek 1',
    enabled: true,
    contacts: [{ phone: '42', priority: 'Primary', dialAccount: 'Account2' }],
  },
]

describe('capabilities detection (mock/fixture — bez sieci)', () => {
  it('R29C 29.30.10.128 = starsze: legacy phonebook TAK, directory users NIE', () => {
    const caps = detectCapabilitiesFromInfo({ model: 'R29C', firmwareVersion: '29.30.10.128' })
    expect(caps.supportsLegacyPhonebookUrl).toBe(true)
    expect(caps.supportsDirectoryUsers).toBe(false)
    expect(caps.supportsTgzImport).toBe(true)
    expect(recommendedAdapter(caps)).toBe('legacy-contacts')
  })

  it('29.30.10.465 LTS = model Directory User', () => {
    const caps = detectCapabilitiesFromInfo({ model: 'R29C', firmwareVersion: '29.30.10.465' })
    expect(caps.supportsDirectoryUsers).toBe(true)
    expect(caps.supportsContactDetails).toBe(true)
    expect(recommendedAdapter(caps)).toBe('directory-user')
  })

  it('supportsDirectoryWriteApi jest ZAWSZE false (żaden endpoint niepotwierdzony) — nawet gdy supportsHttpApi=true', () => {
    for (const fw of ['29.30.10.128', '29.30.10.465', '29.30.10.500']) {
      const caps = detectCapabilitiesFromInfo({ model: 'R29C', firmwareVersion: fw })
      expect(caps.supportsHttpApi).toBe(true)
      expect(caps.supportsDirectoryWriteApi).toBe(false)
    }
  })

  it('nieobsługiwany/nieznany firmware → wszystko zachowawczo false', () => {
    const caps = detectCapabilitiesFromInfo({ model: 'R29C', firmwareVersion: 'total-garbage' })
    expect(caps.supportsLegacyPhonebookUrl).toBe(false)
    expect(caps.supportsDirectoryUsers).toBe(false)
    expect(caps.supportsTgzImport).toBe(false)
  })

  it('capabilitiesOverride pozwala ręcznie potwierdzić flagę (np. CSV po teście na sprzęcie)', () => {
    const caps = detectCapabilitiesFromInfo({
      model: 'R29C',
      firmwareVersion: '29.30.10.128',
      capabilitiesOverride: { supportsCsvImport: true },
    })
    expect(caps.supportsCsvImport).toBe(true)
  })

  it('compareFirmware porównuje numerycznie (nie leksykalnie)', () => {
    expect(compareFirmware('29.30.10.128', '29.30.10.465')).toBeLessThan(0)
    expect(compareFirmware('29.30.10.465', '29.30.10.465')).toBe(0)
    expect(compareFirmware('29.30.2.9', '29.30.10.1')).toBeLessThan(0)
  })
})

describe('AkuvoxLegacyContactsAdapter (builtin E18C — format potwierdzony sprzętowo)', () => {
  const adapter = new AkuvoxLegacyContactsAdapter(
    { model: 'E18C', firmwareVersion: '218.30.10.101' },
    EMPTY_SNAP,
  )

  it('generuje UserData.tgz zgodne z formatem E18C — roundtrip przez parser', async () => {
    const file = await adapter.generateImportFile(USERS)
    expect(file.fileName).toBe('UserData.tgz')
    expect(file.format).toBe('tgz')
    expect(file.templateSource).toBe(BUILTIN_E18C_TEMPLATE_SOURCE)
    expect(file.entryCount).toBe(2)

    const parser = new AkuvoxTemplateParser()
    const spec = parser.parseTemplate('UserData.tgz', file.content)
    const userFile = spec.files.find((f) => f.kind === 'user-data')!
    // Kolejność atrybutów identyczna z template'em E18C.
    expect(userFile.attributes).toEqual(BUILTIN_E18C_TEMPLATE.files[0].attributes)
    expect(userFile.childElements).toEqual(['Pin'])

    const entries = parser.parseDeviceExport('UserData.tgz', file.content)
    expect(entries.map((e) => e.name)).toEqual(['Niewinna 4/1 — Kowalski', 'Niewinna 4/2 — Nowak & Syn'])
    expect(entries.map((e) => e.contacts[0].phone)).toEqual(['41', '42'])
    expect(entries[1].contacts[0].dialAccount).toBe('Account2')
    expect(entries[0].groupName).toBe('Budynek 1')
  })

  it('applyDirectory/verifyDirectory w Etapie 1 nie dotykają urządzenia', async () => {
    const apply = await adapter.applyDirectory(await adapter.generateImportFile(USERS))
    expect(apply.ok).toBe(false)
    expect(apply.message).toContain('MANUAL')
    const verify = await adapter.verifyDirectory()
    expect(verify.ok).toBe(false)
  })
})

describe('AkuvoxDirectoryUserAdapter (template-driven, pkt 7)', () => {
  it('BEZ template\'a ODMAWIA generacji z instrukcją dla instalatora', async () => {
    const adapter = new AkuvoxDirectoryUserAdapter(
      { model: 'R29C', firmwareVersion: '29.30.10.465' },
      EMPTY_SNAP,
      null,
    )
    await expect(adapter.generateImportFile(USERS)).rejects.toThrow(/template|na oko/i)
  })

  it('z wgranym template XML generuje plik w IDENTYCZNYM formacie (kolejność atrybutów + stałe)', async () => {
    const parser = new AkuvoxTemplateParser()
    const templateXml =
      `<?xml version="1.0" encoding="UTF-8" ?>\n<UserData>\n` +
      `    <Data ID="1" UserID="1" Name="Sample" RoomNumber="1" Phone="100" Group="G" DialAccount="0" WebRelay="0" />\n` +
      `    <Data ID="2" UserID="2" Name="Sample2" RoomNumber="2" Phone="101" Group="G" DialAccount="0" WebRelay="0" />\n` +
      `</UserData>\n`
    const spec = parser.parseTemplate('sample.xml', Buffer.from(templateXml, 'utf8'))
    const adapter = new AkuvoxDirectoryUserAdapter(
      { model: 'R29C', firmwareVersion: '29.30.10.465' },
      EMPTY_SNAP,
      { spec, source: 'template:test' },
    )
    const file = await adapter.generateImportFile(USERS)
    expect(file.format).toBe('xml')
    const text = file.content.toString('utf8')
    // Kolejność atrybutów jak w template.
    expect(text).toMatch(/<Data ID="1" UserID="1" Name="Niewinna 4\/1 — Kowalski" RoomNumber="4\/1" Phone="41" Group="Budynek 1" DialAccount="0" WebRelay="0" \/>/)
    // Escapowanie XML.
    expect(text).toContain('Nowak &amp; Syn')
    // Roundtrip.
    const entries = parser.parseDeviceExport('gen.xml', file.content)
    expect(entries).toHaveLength(2)
    expect(entries[1].roomNumber).toBe('4/2')
  })

  it('z template CSV generuje CSV z separatorem i BOM z template\'a', async () => {
    const parser = new AkuvoxTemplateParser()
    const csv = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Name;Phone;Group;RoomNumber\r\nSample;100;G;1\r\n', 'utf8'),
    ])
    const spec = parser.parseTemplate('sample.csv', csv)
    const adapter = new AkuvoxDirectoryUserAdapter(
      { model: 'R29C', firmwareVersion: '29.30.10.465' },
      EMPTY_SNAP,
      { spec, source: 'template:test-csv' },
    )
    const file = await adapter.generateImportFile(USERS)
    expect(file.format).toBe('csv')
    expect(file.content[0]).toBe(0xef) // BOM zachowany
    const text = file.content.subarray(3).toString('utf8')
    expect(text.split('\r\n')[0]).toBe('Name;Phone;Group;RoomNumber')
    expect(text).toContain('Niewinna 4/1 — Kowalski;41;Budynek 1;4/1')
  })
})
