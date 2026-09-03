/**
 * Kreator migracji legacy → v2 (pkt 20 spec, Etap 2) — CZYSTA logika:
 * odtworzenie wpisów, które produkuje dziś stara integracja (UserData.tgz
 * per-budynek + Remote Phonebook XML), porównanie z projekcją v2 pod
 * mapowaniem parytetowym i raport różnic per lokal.
 *
 * Zasady (pkt 20): zachowaj nazwy, numery, grupy, kolejność; stara
 * konfiguracja NIE jest usuwana (deprecated, działa dalej) — rollback =
 * ponowne włączenie Remote Phonebook na urządzeniu; raport migracji trafia
 * do akuvox_sync_runs; podgląd przed aktywacją (preview ≠ adopt).
 *
 * Znane RÓŻNICE OCZEKIWANE (nie blokują migracji, raportowane z expected=true):
 *  - fallback grupy: legacy „Mieszkańcy" → v2 „Pozostali" (decyzja właściciela
 *    2026-07-30; ContactGroup → ulica → „Pozostali"),
 *  - kolejność nazwisk w lokalu: legacy SQL (string_agg DISTINCT) sortuje
 *    alfabetycznie, v2 zachowuje kolejność zamieszkania — porównujemy ZBIÓR
 *    nazwisk, nie ich kolejność,
 *  - prefiks grupy w nazwie (Remote Phonebook, format płaski) jest w v2
 *    zbędny — import plikowy ma grupy natywne.
 */
import {
  AkuvoxDirectoryMapping,
  AkuvoxDirectoryUser,
  DEFAULT_MAPPING,
} from './directory.types'
import { SourceUnitRow } from './directory-projection.service'

/**
 * Mapowanie parytetowe — odtwarza dzisiejsze zachowanie ekranu 1:1
 * (z fallbackiem grup zaszytym w projekcji domenowej).
 */
export const LEGACY_PARITY_MAPPING: AkuvoxDirectoryMapping = { ...DEFAULT_MAPPING }

/** Wpis w semantyce legacy (UserData.tgz / Remote Phonebook). */
export interface LegacyEntry {
  unitId: number
  /** Name z legacy tgz: "<numer> — <nazwiska posortowane>". */
  name: string
  /** Name z legacy phonebooka: "[grupa · ]<ulica numer> — <nazwiska>" (format płaski). */
  phonebookName: string
  /** Numer wybierania = unit.id (routing punktowy — NIE zmieniamy). */
  dial: string
  /** Group z legacy tgz: grupa kontaktowa > ulica > „Mieszkańcy". */
  group: string
  order: number
}

export interface MigrationDifference {
  field: 'name' | 'dial' | 'group' | 'order'
  legacy: string
  v2: string
  /** true = różnica świadoma/oczekiwana (patrz nagłówek), nie blokuje migracji. */
  expected: boolean
  note?: string
}

export interface MigrationRow {
  unitId: number
  legacyName: string
  v2Name: string
  dial: string
  legacyGroup: string
  v2Group: string
  differences: MigrationDifference[]
  /** identical = zero różnic; ok = tylko oczekiwane; differs = wymaga uwagi. */
  status: 'identical' | 'ok' | 'differs'
}

export interface MigrationReport {
  rows: MigrationRow[]
  summary: {
    total: number
    identical: number
    expectedOnly: number
    differing: number
    missingInV2: number
    extraInV2: number
  }
  notes: string[]
}

const MIGRATION_NOTES: string[] = [
  'Fallback grupy zmieniony decyzją właściciela (2026-07-30): legacy „Mieszkańcy" → v2 „Pozostali" (grupa kontaktowa → ulica → „Pozostali").',
  'Prefiks grupy w nazwie (workaround płaskiego Remote Phonebooka) jest w v2 zbędny — import plikowy ma grupy natywne; porównanie dotyczy nazwy bez prefiksu.',
  'Kolejność nazwisk w lokalu: legacy sortuje alfabetycznie (SQL DISTINCT), v2 zachowuje kolejność zamieszkania — porównywany jest zbiór nazwisk.',
  'Stara konfiguracja (Remote Phonebook URL + eksport per-budynek) pozostaje aktywna — rollback = ponowne włączenie Remote Phonebook na urządzeniu.',
]

/** Odtworzenie wpisów legacy z tych samych wierszy źródłowych co projekcja v2. */
export function buildLegacyEntries(rows: SourceUnitRow[]): LegacyEntry[] {
  const entries = rows.map((row) => {
    // string_agg(DISTINCT lastName, ' / ') — Postgres sortuje wartości DISTINCT.
    const names = [...new Set(row.residents.map((r) => r.lastName).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'pl'),
    )
    const nameCore = names.length > 0 ? `${row.unitNumber} — ${names.join(' / ')}` : row.unitNumber
    const group =
      row.contactGroupName && row.contactGroupName.trim()
        ? row.contactGroupName.trim()
        : row.street && row.street.trim()
          ? row.street.trim()
          : 'Mieszkańcy'
    const pbBase = row.street ? `${row.street} ${row.unitNumber}` : row.unitNumber
    const pbWithNames = names.length > 0 ? `${pbBase} — ${names.join(' / ')}` : pbBase
    const phonebookName = row.contactGroupName ? `${row.contactGroupName} · ${pbWithNames}` : pbWithNames
    return {
      unitId: row.unitId,
      name: nameCore,
      phonebookName,
      dial: String(row.unitId),
      group,
      row,
    }
  })
  // Sort legacy: grupa (sortOrder ASC NULLS LAST, nazwa ASC NULLS LAST) → numer.
  entries.sort((a, b) => {
    const sa = a.row.contactGroupName != null ? (a.row.contactGroupSortOrder ?? 0) : Number.POSITIVE_INFINITY
    const sb = b.row.contactGroupName != null ? (b.row.contactGroupSortOrder ?? 0) : Number.POSITIVE_INFINITY
    if (sa !== sb) return sa - sb
    const ga = a.row.contactGroupName ?? '￿'
    const gb = b.row.contactGroupName ?? '￿'
    if (ga !== gb) return ga.localeCompare(gb, 'pl')
    return a.row.unitNumber.localeCompare(b.row.unitNumber, 'pl', { numeric: true })
  })
  return entries.map((e, i) => ({
    unitId: e.unitId,
    name: e.name,
    phonebookName: e.phonebookName,
    dial: e.dial,
    group: e.group,
    order: i + 1,
  }))
}

/** Zbiór nazwisk z nazwy "<cokolwiek> — A / B / C" (porównanie niezależne od kolejności). */
function nameParts(name: string): { prefix: string; names: Set<string> } {
  const idx = name.indexOf('—')
  if (idx < 0) return { prefix: name.trim(), names: new Set() }
  const prefix = name.slice(0, idx).trim()
  const names = new Set(
    name
      .slice(idx + 1)
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return { prefix, names }
}

function sameNameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/** Porównanie wpisów legacy z projekcją v2 (mapowanie parytetowe). */
export function compareLegacyToV2(legacy: LegacyEntry[], v2: AkuvoxDirectoryUser[]): MigrationReport {
  const v2ByUnit = new Map<string, { user: AkuvoxDirectoryUser; order: number }>()
  v2.forEach((u, i) => v2ByUnit.set(u.externalId.replace(/^gl-u/, ''), { user: u, order: i + 1 }))

  const rows: MigrationRow[] = []
  let missingInV2 = 0

  for (const le of legacy) {
    const match = v2ByUnit.get(String(le.unitId))
    if (!match) {
      missingInV2++
      rows.push({
        unitId: le.unitId,
        legacyName: le.name,
        v2Name: '—',
        dial: le.dial,
        legacyGroup: le.group,
        v2Group: '—',
        differences: [
          { field: 'name', legacy: le.name, v2: '—', expected: false, note: 'Lokal nieobecny w projekcji v2' },
        ],
        status: 'differs',
      })
      continue
    }
    v2ByUnit.delete(String(le.unitId))
    const { user, order } = match
    const differences: MigrationDifference[] = []

    // Numer wybierania — twardy wymóg identyczności (routing).
    const v2Dial = user.contacts[0]?.phone ?? ''
    if (v2Dial !== le.dial) {
      differences.push({ field: 'dial', legacy: le.dial, v2: v2Dial, expected: false, note: 'RÓŻNY NUMER WYBIERANIA — nie migruj!' })
    }

    // Nazwa — prefiks identyczny + ten sam zbiór nazwisk (kolejność = expected).
    const lp = nameParts(le.name)
    const vp = nameParts(user.name)
    if (lp.prefix !== vp.prefix || !sameNameSet(lp.names, vp.names)) {
      differences.push({ field: 'name', legacy: le.name, v2: user.name, expected: false })
    } else if (le.name !== user.name) {
      differences.push({
        field: 'name',
        legacy: le.name,
        v2: user.name,
        expected: true,
        note: 'Inna kolejność nazwisk (ten sam zbiór)',
      })
    }

    // Grupa — 'Mieszkańcy'→'Pozostali' jest oczekiwane (fallback zmieniony).
    const v2Group = user.groupName ?? ''
    if (le.group !== v2Group) {
      const expectedFallback = le.group === 'Mieszkańcy' && v2Group === 'Pozostali'
      differences.push({
        field: 'group',
        legacy: le.group,
        v2: v2Group,
        expected: expectedFallback,
        note: expectedFallback ? 'Zmiana fallbacku grupy (decyzja właściciela)' : undefined,
      })
    }

    // Kolejność — grupy fallbackowe mogą przesunąć wpisy; expected gdy
    // przesunięcie wynika wyłącznie z oczekiwanej różnicy grup.
    if (order !== le.order) {
      const groupDiffExpected = differences.some((d) => d.field === 'group' && d.expected)
      differences.push({
        field: 'order',
        legacy: String(le.order),
        v2: String(order),
        expected: groupDiffExpected || differences.length === 0,
        note: 'Pozycja na liście (sortowanie po grupach)',
      })
    }

    rows.push({
      unitId: le.unitId,
      legacyName: le.name,
      v2Name: user.name,
      dial: le.dial,
      legacyGroup: le.group,
      v2Group,
      differences,
      status:
        differences.length === 0 ? 'identical' : differences.every((d) => d.expected) ? 'ok' : 'differs',
    })
  }

  // Wpisy v2 bez odpowiednika legacy (nie powinno się zdarzyć — te same wiersze).
  const extraInV2 = v2ByUnit.size
  for (const [unitId, { user }] of v2ByUnit) {
    rows.push({
      unitId: Number(unitId),
      legacyName: '—',
      v2Name: user.name,
      dial: user.contacts[0]?.phone ?? '',
      legacyGroup: '—',
      v2Group: user.groupName ?? '',
      differences: [
        { field: 'name', legacy: '—', v2: user.name, expected: false, note: 'Wpis nowy względem legacy' },
      ],
      status: 'differs',
    })
  }

  return {
    rows,
    summary: {
      total: rows.length,
      identical: rows.filter((r) => r.status === 'identical').length,
      expectedOnly: rows.filter((r) => r.status === 'ok').length,
      differing: rows.filter((r) => r.status === 'differs').length,
      missingInV2,
      extraInV2,
    },
    notes: MIGRATION_NOTES,
  }
}
