/**
 * Etykieta lokalu — JEDNA definicja dla całego API (2026-09-07).
 *
 * Używana wszędzie, gdzie lokal trafia do człowieka albo na Edge
 * (`lpr_plates.unit_label`, panel odczytów LPR, lista pojazdów):
 *   • blok:    „B/15A"         (klatka/numer)
 *   • osiedle: „Kwiatowa 5"    (ulica numer — HOUSING_ESTATE z `Unit.street`)
 *   • VN:      „Niewinna 4/2"  (ulica wpisana w sam numer, `street` puste)
 *
 * Ta sama logika po stronie SQL: `unitLabelSql()` (dla zapytań raw, żeby
 * lista pojazdów nie robiła N+1 po lokale).
 */
import { Prisma } from '@prisma/client'

export function formatUnitLabel(u: {
  number: string
  street?: string | null
  stairwellName?: string | null
}): string {
  const street = (u.street ?? '').trim()
  const base = street ? `${street} ${u.number}` : u.number
  const sw = (u.stairwellName ?? '').trim()
  return sw ? `${sw}/${base}` : base
}

/**
 * Odpowiednik `formatUnitLabel` w SQL. `unitAlias` / `stairwellAlias` to
 * aliasy tabel `units` / `stairwells` w zapytaniu wołającego (LEFT JOIN-y).
 * Zwraca NULL gdy lokal nie jest złączony (unitAlias.id IS NULL).
 */
export function unitLabelSql(unitAlias: string, stairwellAlias: string): Prisma.Sql {
  const u = Prisma.raw(unitAlias)
  const s = Prisma.raw(stairwellAlias)
  return Prisma.sql`
    CASE WHEN ${u}.id IS NULL THEN NULL
         ELSE COALESCE(NULLIF(btrim(${s}.name), '') || '/', '')
           || COALESCE(NULLIF(btrim(${u}.street), '') || ' ', '')
           || ${u}.number
    END`
}
