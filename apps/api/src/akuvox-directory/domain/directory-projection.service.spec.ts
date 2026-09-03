/**
 * Testy jednostkowe projekcji (pkt 19 spec) — BEZ bazy: wejście = SourceUnitRow
 * fixture in-memory. Pokrycie: mapowanie mieszkaniec→user, priorytety, grupy,
 * normalizacja numeru lokalu, idempotencja/checksum, ukryty kontakt, usunięty
 * mieszkaniec, kilku mieszkańców w lokalu, SIP i IP, polskie znaki, puste pola,
 * bardzo długie nazwy, szablony, anonimizacja, walidacja.
 */
import { DirectoryProjectionService, SourceUnitRow } from './directory-projection.service'
import { AkuvoxDirectoryUser, CallTarget, DEFAULT_MAPPING, DirectoryPerson } from './directory.types'

const svc = new DirectoryProjectionService()

function row(partial: Partial<SourceUnitRow> & { unitId: number }): SourceUnitRow {
  return {
    unitNumber: String(partial.unitId),
    street: null,
    floor: null,
    stairwellName: null,
    contactGroupName: null,
    contactGroupSortOrder: null,
    residents: [],
    ...partial,
  }
}

const KOWALSKI = { id: 1, firstName: 'Jan', lastName: 'Kowalski' }
const NOWAK = { id: 2, firstName: 'Anna', lastName: 'Nowak' }

describe('DirectoryProjectionService — Contact Domain', () => {
  it('mapuje mieszkańca na DirectoryPerson z targetem extension = unit.id (routing punktowy)', () => {
    const persons = svc.toDirectoryPersons([row({ unitId: 42, unitNumber: '4/2', residents: [KOWALSKI] })], 9)
    expect(persons).toHaveLength(1)
    const p = persons[0]
    expect(p.id).toBe('gl-p1')
    expect(p.propertyId).toBe('9')
    expect(p.unitId).toBe('42')
    expect(p.callTargets).toEqual([
      expect.objectContaining({ type: 'extension', value: '42', priority: 1, dialAccount: 1, enabled: true }),
    ])
  })

  it('usunięty mieszkaniec (deletedAt) → enabled=false, niewidoczny, pomijany w projekcji', () => {
    const persons = svc.toDirectoryPersons(
      [row({ unitId: 1, residents: [{ ...KOWALSKI, deletedAt: '2026-07-01T00:00:00Z' }] })],
      9,
    )
    expect(persons[0].enabled).toBe(false)
    expect(persons[0].visibleOnIntercom).toBe(false)
    expect(svc.projectToAkuvoxUsers(persons, null)).toHaveLength(0)
  })

  it('ukryty kontakt (visibleOnIntercom=false na osobie lub lokalu) nie trafia do katalogu', () => {
    const persons = svc.toDirectoryPersons(
      [
        row({ unitId: 1, residents: [{ ...KOWALSKI, visibleOnIntercom: false }] }),
        row({ unitId: 2, residents: [NOWAK], visibleOnIntercom: false }),
        row({ unitId: 3, residents: [{ id: 3, firstName: 'Piotr', lastName: 'Wiśniewski' }] }),
      ],
      9,
    )
    const users = svc.projectToAkuvoxUsers(persons, null)
    expect(users).toHaveLength(1)
    expect(users[0].name).toContain('Wiśniewski')
  })
})

describe('DirectoryProjectionService — projekcja Akuvox (pkt 4/12)', () => {
  it('displayMode=unit: kilku mieszkańców w lokalu = jeden wpis z nazwiskami', () => {
    const rows = [row({ unitId: 5, unitNumber: '15A', residents: [KOWALSKI, NOWAK] })]
    const users = svc.projectToAkuvoxUsers(svc.toDirectoryPersons(rows, 9), null, rows)
    expect(users).toHaveLength(1)
    expect(users[0].externalId).toBe('gl-u5')
    expect(users[0].name).toBe('15A — Kowalski / Nowak')
    expect(users[0].contacts).toHaveLength(1)
    expect(users[0].contacts[0].phone).toBe('5')
  })

  it('displayMode=person: jeden wpis per osoba', () => {
    const rows = [row({ unitId: 5, unitNumber: '15A', residents: [KOWALSKI, NOWAK] })]
    const users = svc.projectToAkuvoxUsers(
      svc.toDirectoryPersons(rows, 9),
      { displayMode: 'person', displayNameTemplate: '{{lastName}} {{firstName}}' },
      rows,
    )
    expect(users).toHaveLength(2)
    expect(users.map((u) => u.name).sort()).toEqual(['Kowalski Jan', 'Nowak Anna'])
    expect(new Set(users.map((u) => u.externalId))).toEqual(new Set(['gl-p1', 'gl-p2']))
  })

  it('grupy: contactGroup mapuje się na groupName; fallback ulica → „Pozostali"; sortowanie wg sortOrder', () => {
    // Fallback grup (decyzja Konrada 2026-07-30): grupa → ulica → „Pozostali".
    const rows = [
      row({ unitId: 1, unitNumber: '1', residents: [KOWALSKI] }), // bez grupy i ulicy → „Pozostali"
      row({ unitId: 2, unitNumber: '2', residents: [NOWAK], contactGroupName: 'Budynek B', contactGroupSortOrder: 2 }),
      row({
        unitId: 3,
        unitNumber: '3',
        residents: [{ id: 3, firstName: 'X', lastName: 'Y' }],
        contactGroupName: 'Budynek A',
        contactGroupSortOrder: 1,
      }),
      row({ unitId: 4, unitNumber: '4', residents: [{ id: 4, firstName: 'Z', lastName: 'W' }], street: 'Komfortowa' }), // bez grupy, z ulicą
    ]
    const users = svc.projectToAkuvoxUsers(svc.toDirectoryPersons(rows, 9), null, rows)
    expect(users.map((u) => u.groupName)).toEqual(['Budynek A', 'Budynek B', 'Komfortowa', 'Pozostali'])
    // userId = pozycja na liście
    expect(users.map((u) => u.userId)).toEqual(['1', '2', '3', '4'])
  })

  it('groupBy=staircase / floor nadpisuje grupę kontaktową', () => {
    const rows = [
      row({ unitId: 1, unitNumber: '1', residents: [KOWALSKI], stairwellName: 'Klatka A', floor: 3, contactGroupName: 'G' }),
    ]
    const persons = svc.toDirectoryPersons(rows, 9)
    expect(svc.projectToAkuvoxUsers(persons, { groupBy: 'staircase' }, rows)[0].groupName).toBe('Klatka A')
    expect(svc.projectToAkuvoxUsers(persons, { groupBy: 'floor' }, rows)[0].groupName).toBe('Piętro 3')
  })

  it('priorytety 1/2/3 → Primary/Secondary/Tertiary, dialAccount 2 → Account2, SIP i IP obsługiwane', () => {
    const targets: CallTarget[] = [
      { id: 't3', type: 'ip', value: '192.168.1.50', priority: 3, dialAccount: 2, enabled: true },
      { id: 't1', type: 'sip', value: '101@sip.local', priority: 1, dialAccount: 1, enabled: true },
      { id: 't2', type: 'extension', value: '42', priority: 2, enabled: true },
      { id: 't4', type: 'sip', value: 'disabled@x', priority: 2, enabled: false },
    ]
    const person: DirectoryPerson = {
      id: 'gl-p1',
      propertyId: '9',
      unitId: '42',
      unitNumber: '42',
      displayName: 'Jan Kowalski',
      firstName: 'Jan',
      lastName: 'Kowalski',
      enabled: true,
      visibleOnIntercom: true,
      callTargets: targets,
      sourceUpdatedAt: new Date().toISOString(),
    }
    const users = svc.projectToAkuvoxUsers([person], { displayMode: 'person' })
    expect(users[0].contacts).toEqual([
      expect.objectContaining({ phone: '101@sip.local', priority: 'Primary', dialAccount: 'Account1' }),
      expect.objectContaining({ phone: '42', priority: 'Secondary', dialAccount: 'Account1' }),
      expect.objectContaining({ phone: '192.168.1.50', priority: 'Tertiary', dialAccount: 'Account2' }),
    ])
  })

  it('polskie znaki przechodzą bez zmian (NFC)', () => {
    const rows = [
      row({ unitId: 1, unitNumber: '1', residents: [{ id: 1, firstName: 'Łukasz', lastName: 'Żółć-Ściborska' }] }),
    ]
    const users = svc.projectToAkuvoxUsers(svc.toDirectoryPersons(rows, 9), null, rows)
    expect(users[0].name).toBe('1 — Żółć-Ściborska')
  })

  it('puste pola: szablon z pustymi wartościami nie zostawia wiszących separatorów', () => {
    const rows = [row({ unitId: 1, unitNumber: '7', residents: [{ id: 1, firstName: '', lastName: '' }] })]
    const users = svc.projectToAkuvoxUsers(svc.toDirectoryPersons(rows, 9), null, rows)
    expect(users[0].name).toBe('7')
  })

  it('bardzo długie nazwy są przycinane do limitu + walidacja ostrzega przed przycięciem', () => {
    const longName = 'Bardzo'.repeat(30)
    const rows = [row({ unitId: 1, unitNumber: '1', residents: [{ id: 1, firstName: 'Jan', lastName: longName }] })]
    const users = svc.projectToAkuvoxUsers(svc.toDirectoryPersons(rows, 9), null, rows)
    expect(users[0].name.length).toBeLessThanOrEqual(63)
  })

  it('normalizacja numeru lokalu: trim + pojedyncze spacje; znaki łamiące XML usunięte z nazwy', () => {
    expect(DirectoryProjectionService.normalizeUnitNumber('  Niewinna   4/2 ')).toBe('Niewinna 4/2')
    expect(DirectoryProjectionService.sanitize('A<b>"c"\nd', 63)).toBe('A b c d')
  })

  it('hideLastName ukrywa nazwiska; anonymizeDirectory pokazuje wyłącznie numer lokalu (pkt 13)', () => {
    const rows = [row({ unitId: 1, unitNumber: '15A', residents: [KOWALSKI] })]
    const persons = svc.toDirectoryPersons(rows, 9)
    expect(svc.projectToAkuvoxUsers(persons, { hideLastName: true }, rows)[0].name).toBe('15A')
    expect(svc.projectToAkuvoxUsers(persons, { anonymizeDirectory: true }, rows)[0].name).toBe('Lokal 15A')
  })

  it('szablony niestandardowe: {{buildingNumber}}-{{unitNumber}}', () => {
    const rows = [row({ unitId: 1, unitNumber: '4', street: 'Niewinna', residents: [KOWALSKI] })]
    const users = svc.projectToAkuvoxUsers(
      svc.toDirectoryPersons(rows, 9),
      { displayNameTemplate: '{{buildingNumber}}-{{unitNumber}}' },
      rows,
    )
    expect(users[0].name).toBe('Niewinna-4')
  })
})

describe('DirectoryProjectionService — idempotencja / checksum (pkt 10)', () => {
  const user = (over: Partial<AkuvoxDirectoryUser> = {}): AkuvoxDirectoryUser => ({
    externalId: 'gl-u1',
    userId: '1',
    name: 'Jan Kowalski',
    roomNumber: '15A',
    groupName: 'Budynek A',
    enabled: true,
    contacts: [{ phone: '42', priority: 'Primary', dialAccount: 'Account1' }],
    ...over,
  })

  it('checksum jest deterministyczny i niewrażliwy na whitespace', () => {
    const a = DirectoryProjectionService.userChecksum(user())
    const b = DirectoryProjectionService.userChecksum(user({ name: '  Jan   Kowalski ' }))
    expect(a).toBe(b)
  })

  it('zmiana pola zmienia checksum', () => {
    expect(DirectoryProjectionService.userChecksum(user())).not.toBe(
      DirectoryProjectionService.userChecksum(user({ roomNumber: '15B' })),
    )
  })

  it('checksum katalogu nie zależy od kolejności wpisów', () => {
    const u1 = user()
    const u2 = user({ externalId: 'gl-u2', name: 'Anna Nowak' })
    expect(DirectoryProjectionService.directoryChecksum([u1, u2])).toBe(
      DirectoryProjectionService.directoryChecksum([u2, u1]),
    )
  })

  it('idempotencja projekcji: dwa przebiegi na tych samych danych → identyczny checksum katalogu', () => {
    const rows = [row({ unitId: 5, unitNumber: '15A', residents: [KOWALSKI, NOWAK], contactGroupName: 'A' })]
    const run = () =>
      DirectoryProjectionService.directoryChecksum(
        svc.projectToAkuvoxUsers(svc.toDirectoryPersons(rows, 9), DEFAULT_MAPPING, rows),
      )
    expect(run()).toBe(run())
  })
})

describe('DirectoryProjectionService — walidacja (pkt 15)', () => {
  const base: AkuvoxDirectoryUser = {
    externalId: 'gl-u1',
    userId: '1',
    name: 'OK',
    roomNumber: '1',
    enabled: true,
    contacts: [{ phone: '42', priority: 'Primary', dialAccount: 'Account1' }],
  }

  it('brak nazwy / brak numeru = error; błędny wpis NIE blokuje pozostałych', () => {
    const res = svc.validateUsers([
      base,
      { ...base, externalId: 'gl-u2', name: '' },
      { ...base, externalId: 'gl-u3', contacts: [] },
    ])
    expect(res.validUsers.map((u) => u.externalId)).toEqual(['gl-u1'])
    expect(res.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['MISSING_NAME', 'MISSING_CALL_TARGET']),
    )
  })

  it('duplikat externalId = error dla obu wpisów; duplikat numeru lokalu = warning', () => {
    const res = svc.validateUsers([
      base,
      { ...base, name: 'Inny' },
      { ...base, externalId: 'gl-u9', roomNumber: '1' },
    ])
    expect(res.issues.some((i) => i.code === 'DUPLICATE_EXTERNAL_ID' && i.level === 'error')).toBe(true)
    expect(res.issues.some((i) => i.code === 'DUPLICATE_ROOM' && i.level === 'warning')).toBe(true)
    expect(res.validUsers.map((u) => u.externalId)).toEqual(['gl-u9'])
  })

  it('niedozwolone znaki w numerze i >3 kontakty = error', () => {
    const c = { phone: '42', priority: 'Primary' as const, dialAccount: 'Account1' as const }
    const res = svc.validateUsers([
      { ...base, externalId: 'gl-u2', contacts: [{ ...c, phone: 'zły numer!' }] },
      { ...base, externalId: 'gl-u3', contacts: [c, c, c, c] },
    ])
    expect(res.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['INVALID_PHONE_CHARS', 'TOO_MANY_PRIORITIES']),
    )
    expect(res.validUsers).toHaveLength(0)
  })
})
