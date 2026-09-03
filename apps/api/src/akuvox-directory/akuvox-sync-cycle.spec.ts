/**
 * Etap 2 — testy E2E cyklu synchronizacji na czystej logice (bez bazy, bez
 * urządzeń): generator → parser (jak eksport z urządzenia) → diff.
 * Pokrycie: checksum świadomy formatu (pkt „otwarta decyzja #2"), pełny cykl
 * z ochroną SmartPlus w trybie MERGED, provisioning token.
 */
import { AkuvoxLegacyContactsAdapter, BUILTIN_E18C_TEMPLATE } from './adapters/akuvox-legacy-contacts.adapter'
import { AkuvoxDirectoryService } from './akuvox-directory.service'
import { DirectoryDiffService } from './domain/directory-diff.service'
import { DirectoryProjectionService } from './domain/directory-projection.service'
import {
  AkuvoxDirectorySnapshot,
  AkuvoxDirectoryUser,
  AkuvoxSnapshotEntry,
} from './domain/directory.types'
import { comparableFieldsFromSpec } from './template/akuvox-file-generator'
import { AkuvoxTemplateParser } from './template/akuvox-template.parser'

const parser = new AkuvoxTemplateParser()
const diffEngine = new DirectoryDiffService()

const EMPTY_SNAP: AkuvoxDirectorySnapshot = { takenAt: new Date(0).toISOString(), source: 'empty', entries: [] }

function user(over: Partial<AkuvoxDirectoryUser> = {}): AkuvoxDirectoryUser {
  return {
    externalId: 'gl-u41',
    userId: '1',
    name: 'Niewinna 4/1 — Kowalski',
    roomNumber: '4/1', // E18C NIE przenosi roomNumber — kluczowe dla checksuma
    groupName: 'Budynek 1',
    enabled: true,
    contacts: [{ phone: '41', priority: 'Primary', dialAccount: 'Account1' }],
    ...over,
  }
}

describe('checksum świadomy formatu (comparableFields)', () => {
  it('E18C przenosi name/group/phones/dialAccount, ale NIE roomNumber', () => {
    const fields = comparableFieldsFromSpec(BUILTIN_E18C_TEMPLATE)
    expect(fields.sort()).toEqual(['dialAccount', 'group', 'name', 'phones'])
  })

  it('pełny cykl: eksport → parse → diff = unchanged (bez fałszywych „update")', async () => {
    const users = [user(), user({ externalId: 'gl-u42', name: 'Niewinna 4/2 — Nowak', roomNumber: '4/2', contacts: [{ phone: '42', priority: 'Primary', dialAccount: 'Account1' }] })]
    const adapter = new AkuvoxLegacyContactsAdapter({ model: 'E18C', firmwareVersion: '218.30.10.101' }, EMPTY_SNAP)
    const file = await adapter.generateImportFile(users)

    // „Eksport z urządzenia" = nasz własny plik sparsowany z powrotem
    // (roomNumber ginie, bo format go nie przenosi).
    const entries = parser.parseDeviceExport('UserData.tgz', file.content)
    expect(entries[0].roomNumber).toBeUndefined()
    const snapshot: AkuvoxDirectorySnapshot = {
      takenAt: new Date().toISOString(),
      source: 'device-export-upload',
      entries,
    }

    // BEZ ograniczenia pól: fałszywe „update" (roomNumber niby się zmienił).
    const fullDiff = diffEngine.diff(users, snapshot)
    expect(fullDiff.usersToUpdate.length).toBeGreaterThan(0)

    // Z checksumem świadomym formatu: wszystko unchanged.
    const fields = comparableFieldsFromSpec(BUILTIN_E18C_TEMPLATE)
    const smartDiff = diffEngine.diff(users, snapshot, 'GATELYNK', fields)
    expect(smartDiff.unchangedUsers).toHaveLength(2)
    expect(smartDiff.usersToUpdate).toHaveLength(0)
    expect(smartDiff.usersToCreate).toHaveLength(0)
  })

  it('realna zmiana nazwy jest wykrywana także przy ograniczonych polach + field-level diff', async () => {
    const users = [user()]
    const adapter = new AkuvoxLegacyContactsAdapter({ model: 'E18C', firmwareVersion: '218.30.10.101' }, EMPTY_SNAP)
    const file = await adapter.generateImportFile(users)
    const snapshot: AkuvoxDirectorySnapshot = {
      takenAt: new Date().toISOString(),
      source: 'device-export-upload',
      entries: parser.parseDeviceExport('UserData.tgz', file.content),
    }
    const changed = [user({ name: 'Niewinna 4/1 — Kowalski / Nowak' })]
    const fields = comparableFieldsFromSpec(BUILTIN_E18C_TEMPLATE)
    const diff = diffEngine.diff(changed, snapshot, 'GATELYNK', fields)
    expect(diff.usersToUpdate).toHaveLength(1)
    const fc = DirectoryDiffService.fieldChanges(diff.usersToUpdate[0].current, diff.usersToUpdate[0].desired, fields)
    expect(fc).toEqual([
      { field: 'Nazwa', before: 'Niewinna 4/1 — Kowalski', after: 'Niewinna 4/1 — Kowalski / Nowak' },
    ])
    // roomNumber poza polami porównywalnymi — nie pojawia się w field diff.
    expect(fc.some((f) => f.field === 'Lokal')).toBe(false)
  })

  it('disable wykrywany PRZED checksumem (enabled nie jest przenoszone przez format)', () => {
    const snapshot: AkuvoxDirectorySnapshot = {
      takenAt: new Date().toISOString(),
      source: 'device-export-upload',
      entries: [{ ...user(), externalId: '', managedBy: 'unknown' } as AkuvoxSnapshotEntry],
    }
    const fields = comparableFieldsFromSpec(BUILTIN_E18C_TEMPLATE)
    const diff = diffEngine.diff([user({ enabled: false })], snapshot, 'GATELYNK', fields)
    expect(diff.usersToDisable).toHaveLength(1)
    expect(diff.unchangedUsers).toHaveLength(0)
  })
})

describe('pełny cykl MERGED — ochrona SmartPlus (pkt 11)', () => {
  it('rekordy SmartPlus w eksporcie z urządzenia przeżywają cały cykl nietknięte', async () => {
    // 1. Stan urządzenia: 1 wpis GateLynk (z poprzedniego importu) + 2 obce.
    const gatelynkUsers = [user()]
    const adapter = new AkuvoxLegacyContactsAdapter({ model: 'E18C', firmwareVersion: '218.30.10.101' }, EMPTY_SNAP)
    const exported = await adapter.generateImportFile(gatelynkUsers)
    const deviceEntries = parser.parseDeviceExport('UserData.tgz', exported.content)
    const foreign: AkuvoxSnapshotEntry[] = [
      {
        externalId: '',
        userId: '90',
        name: 'Ochrona (ręcznie)',
        enabled: true,
        contacts: [{ phone: '900', priority: 'Primary', dialAccount: 'Account1' }],
        managedBy: 'local',
      },
      {
        externalId: 'sp-777',
        userId: '91',
        name: 'SmartPlus Family',
        enabled: true,
        contacts: [{ phone: 'sp777', priority: 'Primary', dialAccount: 'Account2' }],
        managedBy: 'akuvox-cloud',
      },
    ]
    const snapshot: AkuvoxDirectorySnapshot = {
      takenAt: new Date().toISOString(),
      source: 'device-export-upload',
      entries: [...deviceEntries, ...foreign],
    }

    // 2. Źródło się zmienia: nowy lokal + zmiana nazwy istniejącego.
    const desired = [
      user({ name: 'Niewinna 4/1 — Kowalski / Nowak' }),
      user({ externalId: 'gl-u55', name: 'Niewinna 5/5 — Wiśniewski', roomNumber: '5/5', contacts: [{ phone: '55', priority: 'Primary', dialAccount: 'Account1' }] }),
    ]
    const fields = comparableFieldsFromSpec(BUILTIN_E18C_TEMPLATE)
    const diff = diffEngine.diff(desired, snapshot, 'MERGED', fields)

    // 3. Obce rekordy: zachowane, zero usunięć, zero modyfikacji.
    expect(diff.preservedForeign.map((e) => e.name).sort()).toEqual(['Ochrona (ręcznie)', 'SmartPlus Family'])
    expect(diff.usersToDelete).toHaveLength(0)
    expect(diff.usersToUpdate.map((u) => u.desired.externalId)).toEqual(['gl-u41'])
    expect(diff.usersToCreate.map((u) => u.externalId)).toEqual(['gl-u55'])

    const { summary } = DirectoryDiffService.summarize(diff, fields)
    expect(summary).toMatchObject({ create: 1, update: 1, delete: 0 })
  })

  it('kolizja numeru z rekordem SmartPlus w MERGED = konflikt do raportu, obcy rekord zachowany', () => {
    const snapshot: AkuvoxDirectorySnapshot = {
      takenAt: new Date().toISOString(),
      source: 'device-export-upload',
      entries: [
        {
          externalId: 'sp-1',
          userId: '1',
          name: 'SmartPlus zajmuje numer 41',
          enabled: true,
          contacts: [{ phone: '41', priority: 'Primary', dialAccount: 'Account1' }],
          managedBy: 'akuvox-cloud',
        },
      ],
    }
    const diff = diffEngine.diff([user()], snapshot, 'MERGED')
    expect(diff.conflicts.length).toBeGreaterThan(0)
    expect(diff.usersToDelete).toHaveLength(0)
    expect(diff.preservedForeign).toHaveLength(1)
  })
})

describe('PROVISIONING — token per urządzenie', () => {
  it('token jest deterministyczny, różny per urządzenie i zależny od sekretu', () => {
    const prev = process.env.JWT_SECRET
    process.env.JWT_SECRET = 'test-secret-1234567890'
    const t1 = AkuvoxDirectoryService.provisioningTokenFor(1)
    const t1b = AkuvoxDirectoryService.provisioningTokenFor(1)
    const t2 = AkuvoxDirectoryService.provisioningTokenFor(2)
    expect(t1).toBe(t1b)
    expect(t1).not.toBe(t2)
    expect(t1).toHaveLength(24)
    process.env.JWT_SECRET = 'inny-sekret-0987654321'
    expect(AkuvoxDirectoryService.provisioningTokenFor(1)).not.toBe(t1)
    process.env.JWT_SECRET = prev
  })
})
