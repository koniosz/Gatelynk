/**
 * Testy sync różnicowego (pkt 9) + współistnienia ze SmartPlus (pkt 11) —
 * bez bazy, snapshoty in-memory.
 */
import { DirectoryDiffService } from './directory-diff.service'
import { DirectoryProjectionService } from './directory-projection.service'
import {
  AkuvoxDirectorySnapshot,
  AkuvoxDirectoryUser,
  AkuvoxSnapshotEntry,
} from './directory.types'

const svc = new DirectoryDiffService()

function user(over: Partial<AkuvoxDirectoryUser> = {}): AkuvoxDirectoryUser {
  return {
    externalId: 'gl-u1',
    userId: '1',
    name: 'Kowalski',
    roomNumber: '1',
    groupName: 'A',
    enabled: true,
    contacts: [{ phone: '42', priority: 'Primary', dialAccount: 'Account1' }],
    ...over,
  }
}

function entry(over: Partial<AkuvoxSnapshotEntry> = {}): AkuvoxSnapshotEntry {
  return { ...user(), managedBy: 'unknown', ...over }
}

function snap(entries: AkuvoxSnapshotEntry[]): AkuvoxDirectorySnapshot {
  return { takenAt: new Date().toISOString(), source: 'device-export-upload', entries }
}

describe('DirectoryDiffService', () => {
  it('pusty snapshot → wszystko do create', () => {
    const d = svc.diff([user()], snap([]))
    expect(d.usersToCreate).toHaveLength(1)
    expect(d.conflicts).toHaveLength(0)
  })

  it('identyczny wpis (match po externalId) → unchanged', () => {
    const d = svc.diff([user()], snap([entry({ externalId: 'gl-u1' })]))
    expect(d.unchangedUsers).toHaveLength(1)
    expect(d.usersToUpdate).toHaveLength(0)
  })

  it('zmieniona nazwa → update; wpis disabled → disable', () => {
    const d = svc.diff(
      [user({ name: 'Kowalski / Nowak' }), user({ externalId: 'gl-u2', enabled: false, contacts: [{ phone: '43', priority: 'Primary', dialAccount: 'Account1' }] })],
      snap([entry({ externalId: 'gl-u1' }), entry({ externalId: 'gl-u2', contacts: [{ phone: '43', priority: 'Primary', dialAccount: 'Account1' }] })]),
    )
    expect(d.usersToUpdate).toHaveLength(1)
    expect(d.usersToDisable).toHaveLength(1)
  })

  it('fallback matching po Phone=unit.id gdy format pliku nie przenosi externalId', () => {
    const d = svc.diff([user({ name: 'Nowa nazwa' })], snap([entry({ externalId: '', name: 'Stara nazwa' })]))
    expect(d.usersToCreate).toHaveLength(0)
    expect(d.usersToUpdate).toHaveLength(1)
  })

  it('rekord gl-* nieobecny w źródle → delete; obcy rekord → preserved (NIGDY delete)', () => {
    const d = svc.diff(
      [],
      snap([
        entry({ externalId: 'gl-u99', contacts: [{ phone: '99', priority: 'Primary', dialAccount: 'Account1' }] }),
        entry({ externalId: '', name: 'Ochrona', managedBy: 'local', contacts: [{ phone: '100', priority: 'Primary', dialAccount: 'Account1' }] }),
        entry({ externalId: 'sp-123', name: 'SmartPlus User', managedBy: 'akuvox-cloud', contacts: [{ phone: '200', priority: 'Primary', dialAccount: 'Account1' }] }),
      ]),
    )
    expect(d.usersToDelete.map((e) => e.externalId)).toEqual(['gl-u99'])
    expect(d.preservedForeign).toHaveLength(2)
  })

  it('konflikt SmartPlus: ten sam numer w rekordzie chmurowym → konflikt do raportu, bez auto-rozstrzygania', () => {
    const d = svc.diff(
      [user()],
      snap([entry({ externalId: 'sp-1', name: 'Cloud Guy', managedBy: 'akuvox-cloud' })]),
    )
    expect(d.usersToCreate).toHaveLength(1) // nasz wpis i tak powstaje
    expect(d.conflicts).toHaveLength(1)
    expect(d.conflicts[0].reason).toContain('akuvox-cloud')
    expect(d.usersToDelete).toHaveLength(0)
  })

  it('MERGED: rekordy SmartPlus zmatchowane po externalId zostają nietknięte + konflikt do raportu', () => {
    const d = svc.diff(
      [user({ externalId: 'gl-u1', name: 'Zmieniona' })],
      snap([entry({ externalId: 'gl-u1', managedBy: 'akuvox-cloud' })]),
      'MERGED',
    )
    expect(d.usersToUpdate).toHaveLength(0)
    expect(d.preservedForeign).toHaveLength(1)
    expect(d.conflicts).toHaveLength(1)
  })

  it('MANUAL: GateLynk niczego nie synchronizuje', () => {
    const d = svc.diff([user()], snap([entry({ managedBy: 'local' })]), 'MANUAL')
    expect(d.usersToCreate).toHaveLength(0)
    expect(d.preservedForeign).toHaveLength(1)
    expect(d.conflicts[0].reason).toContain('MANUAL')
  })

  it('classifyManagedBy: prefiks gl- → gatelynk, reszta → unknown', () => {
    expect(DirectoryDiffService.classifyManagedBy({ externalId: 'gl-u7', managedBy: 'unknown' })).toBe('gatelynk')
    expect(DirectoryDiffService.classifyManagedBy({ externalId: '', managedBy: 'unknown' })).toBe('unknown')
    expect(DirectoryDiffService.classifyManagedBy({ externalId: 'x', managedBy: 'local' })).toBe('local')
  })

  it('summarize liczy poprawnie', () => {
    const d = svc.diff(
      [user(), user({ externalId: 'gl-u2', name: 'Inny', contacts: [{ phone: '43', priority: 'Primary', dialAccount: 'Account1' }] })],
      snap([entry({ externalId: 'gl-u1' })]),
    )
    const { summary } = DirectoryDiffService.summarize(d)
    expect(summary).toEqual({ create: 1, update: 0, disable: 0, delete: 0, unchanged: 1, conflicts: 0 })
  })

  it('snapshot z checksumem pre-kalkulowanym jest respektowany', () => {
    const u = user()
    const e = entry({ externalId: 'gl-u1', checksum: DirectoryProjectionService.userChecksum(u) })
    const d = svc.diff([u], snap([e]))
    expect(d.unchangedUsers).toHaveLength(1)
  })
})
