/**
 * Testy kreatora migracji legacy → v2 (pkt 20, Etap 2) — czysta logika,
 * bez bazy. Weryfikują parytet: nazwy, numery wybierania, grupy, kolejność
 * oraz klasyfikację różnic oczekiwanych (fallback grup, kolejność nazwisk).
 */
import { DirectoryProjectionService, SourceUnitRow } from './directory-projection.service'
import { buildLegacyEntries, compareLegacyToV2, LEGACY_PARITY_MAPPING } from './legacy-migration'

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

function v2For(rows: SourceUnitRow[]) {
  return svc.projectToAkuvoxUsers(svc.toDirectoryPersons(rows, 9), LEGACY_PARITY_MAPPING, rows)
}

describe('buildLegacyEntries — odtworzenie semantyki legacy', () => {
  it('nazwa = "<numer> — <nazwiska alfabetycznie>", grupa = contactGroup > ulica > „Mieszkańcy"', () => {
    const entries = buildLegacyEntries([
      row({
        unitId: 5,
        unitNumber: '15A',
        residents: [
          { id: 1, firstName: 'Zofia', lastName: 'Wróblewska' },
          { id: 2, firstName: 'Adam', lastName: 'Adamski' },
        ],
      }),
    ])
    expect(entries[0].name).toBe('15A — Adamski / Wróblewska') // sort alfabetyczny jak SQL DISTINCT
    expect(entries[0].dial).toBe('5')
    expect(entries[0].group).toBe('Mieszkańcy') // legacy fallback
  })

  it('phonebookName ma prefiks grupy i ulicę (workaround płaskiego formatu)', () => {
    const entries = buildLegacyEntries([
      row({
        unitId: 1,
        unitNumber: '4/2',
        street: 'Niewinna',
        contactGroupName: 'Budynek 1',
        contactGroupSortOrder: 1,
        residents: [{ id: 1, firstName: 'Jan', lastName: 'Kowalski' }],
      }),
    ])
    expect(entries[0].phonebookName).toBe('Budynek 1 · Niewinna 4/2 — Kowalski')
    expect(entries[0].group).toBe('Budynek 1')
  })

  it('sortowanie: grupy wg sortOrder, bez grupy na końcu, w grupie po numerze', () => {
    const entries = buildLegacyEntries([
      row({ unitId: 1, unitNumber: '9', residents: [{ id: 1, firstName: 'A', lastName: 'B' }] }),
      row({ unitId: 2, unitNumber: '2', contactGroupName: 'G2', contactGroupSortOrder: 2, residents: [{ id: 2, firstName: 'A', lastName: 'B' }] }),
      row({ unitId: 3, unitNumber: '1', contactGroupName: 'G1', contactGroupSortOrder: 1, residents: [{ id: 3, firstName: 'A', lastName: 'B' }] }),
    ])
    expect(entries.map((e) => e.unitId)).toEqual([3, 2, 1])
    expect(entries.map((e) => e.order)).toEqual([1, 2, 3])
  })
})

describe('compareLegacyToV2 — raport migracji', () => {
  it('lokal z grupą kontaktową: pełna identyczność (status=identical)', () => {
    const rows = [
      row({
        unitId: 1,
        unitNumber: '4/1',
        contactGroupName: 'Budynek 1',
        contactGroupSortOrder: 1,
        residents: [{ id: 1, firstName: 'Jan', lastName: 'Kowalski' }],
      }),
    ]
    const report = compareLegacyToV2(buildLegacyEntries(rows), v2For(rows))
    expect(report.summary).toMatchObject({ total: 1, identical: 1, differing: 0 })
    expect(report.rows[0].status).toBe('identical')
  })

  it('fallback „Mieszkańcy"→„Pozostali" = różnica OCZEKIWANA (status=ok, nie blokuje)', () => {
    const rows = [row({ unitId: 1, unitNumber: '7', residents: [{ id: 1, firstName: 'Jan', lastName: 'Kowalski' }] })]
    const report = compareLegacyToV2(buildLegacyEntries(rows), v2For(rows))
    expect(report.rows[0].status).toBe('ok')
    const groupDiff = report.rows[0].differences.find((d) => d.field === 'group')!
    expect(groupDiff).toMatchObject({ legacy: 'Mieszkańcy', v2: 'Pozostali', expected: true })
    expect(report.summary.differing).toBe(0)
  })

  it('fallback ulicy zachowany identycznie (legacy ulica == v2 ulica)', () => {
    const rows = [
      row({ unitId: 1, unitNumber: '4', street: 'Niewinna', residents: [{ id: 1, firstName: 'J', lastName: 'K' }] }),
    ]
    const report = compareLegacyToV2(buildLegacyEntries(rows), v2For(rows))
    expect(report.rows[0].legacyGroup).toBe('Niewinna')
    expect(report.rows[0].v2Group).toBe('Niewinna')
    expect(report.rows[0].status).toBe('identical')
  })

  it('inna kolejność nazwisk (ten sam zbiór) = oczekiwana; inny zbiór = wymaga uwagi', () => {
    const rows = [
      row({
        unitId: 1,
        unitNumber: '1',
        contactGroupName: 'G',
        contactGroupSortOrder: 1,
        residents: [
          { id: 1, firstName: 'Z', lastName: 'Zieliński' },
          { id: 2, firstName: 'A', lastName: 'Adamski' },
        ],
      }),
    ]
    const legacy = buildLegacyEntries(rows)
    const report = compareLegacyToV2(legacy, v2For(rows))
    // v2 zachowuje kolejność zamieszkania (Zieliński / Adamski), legacy sortuje.
    const nameDiff = report.rows[0].differences.find((d) => d.field === 'name')
    expect(nameDiff?.expected).toBe(true)
    expect(report.rows[0].status).toBe('ok')

    // Zmieniony zbiór nazwisk → nieoczekiwana różnica.
    const tampered = v2For(rows).map((u) => ({ ...u, name: '1 — Obcy' }))
    const report2 = compareLegacyToV2(legacy, tampered)
    expect(report2.rows[0].status).toBe('differs')
  })

  it('RÓŻNY NUMER WYBIERANIA = twarda różnica (nigdy expected)', () => {
    const rows = [row({ unitId: 1, unitNumber: '1', contactGroupName: 'G', contactGroupSortOrder: 1, residents: [{ id: 1, firstName: 'J', lastName: 'K' }] })]
    const v2 = v2For(rows).map((u) => ({
      ...u,
      contacts: [{ ...u.contacts[0], phone: '999' }],
    }))
    const report = compareLegacyToV2(buildLegacyEntries(rows), v2)
    const dialDiff = report.rows[0].differences.find((d) => d.field === 'dial')!
    expect(dialDiff.expected).toBe(false)
    expect(dialDiff.note).toContain('nie migruj')
    expect(report.summary.differing).toBe(1)
  })

  it('lokal nieobecny w v2 → missingInV2 + status differs', () => {
    const rows = [row({ unitId: 1, unitNumber: '1', residents: [{ id: 1, firstName: 'J', lastName: 'K' }] })]
    const report = compareLegacyToV2(buildLegacyEntries(rows), [])
    expect(report.summary.missingInV2).toBe(1)
    expect(report.rows[0].status).toBe('differs')
  })

  it('kolejność: przesunięcie wynikające z oczekiwanej zmiany grup = expected', () => {
    // Dwa lokale bez grupy: legacy grupuje po ulicy vs 'Mieszkańcy'; v2 ulica vs 'Pozostali'.
    // Sortowanie w obu przypadkach analogiczne — raport nie powinien zgłaszać twardych różnic.
    const rows = [
      row({ unitId: 1, unitNumber: '2', street: 'Aleja', residents: [{ id: 1, firstName: 'J', lastName: 'K' }] }),
      row({ unitId: 2, unitNumber: '1', residents: [{ id: 2, firstName: 'A', lastName: 'N' }] }),
    ]
    const report = compareLegacyToV2(buildLegacyEntries(rows), v2For(rows))
    expect(report.summary.differing).toBe(0)
  })
})
