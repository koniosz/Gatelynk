/**
 * Porządkowanie oznaczeń lokali „po ludzku", a nie alfabetycznie.
 *
 * Zgłoszenie 2026-08-09 (Osiedle VN, numeracja 1/1 … 21/1): `ORDER BY number`
 * w Postgresie porównuje TEKST, więc „10/1" wypada przed „2/1", a lista domów
 * wygląda na losową. To samo dotyczy zwykłych mieszkań (1, 10, 2, 21) — było
 * po prostu mniej widoczne przy krótkiej liście.
 *
 * Sortowanie robimy w aplikacji, nie w SQL, bo Postgres nie posortuje tego
 * naturalnie bez dodatkowej kolumny/kolacji, a listy lokali są małe
 * (dziesiątki–setki wierszy na budynek). `orderBy` w zapytaniach zostaje jako
 * stabilna baza — dzięki temu kolejność jest deterministyczna także wtedy,
 * gdy dwa oznaczenia porównają się jako równe.
 *
 * Ta sama logika po stronie panelu: apps/web/src/lib/natural-sort.ts.
 * Zmiana w jednym miejscu wymaga zmiany w drugim — inaczej lista w panelu
 * i lista na domofonie rozjadą się kolejnością.
 */

/** Rozbija „21/1" na `[21, '/', 1]` — liczby jako liczby, reszta jako tekst. */
function chunks(s: string): Array<string | number> {
  const out: Array<string | number> = []
  const re = /(\d+)|(\D+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] !== undefined ? Number(m[1]) : m[2])
  }
  return out
}

/**
 * Komparator naturalny dla oznaczeń lokali, numerów domów i etykiet.
 * Puste wartości na koniec — brak numeru to brak informacji, a nie „0".
 */
export function compareNatural(a: string | null | undefined, b: string | null | undefined): number {
  const sa = (a ?? '').trim()
  const sb = (b ?? '').trim()
  if (!sa && !sb) return 0
  if (!sa) return 1
  if (!sb) return -1

  const ca = chunks(sa)
  const cb = chunks(sb)
  const len = Math.min(ca.length, cb.length)

  for (let i = 0; i < len; i++) {
    const x = ca[i]
    const y = cb[i]
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y
    } else {
      // Fragment liczbowy przed tekstowym: „4" wcześniej niż „4A".
      const cmp = String(x).localeCompare(String(y), 'pl', { sensitivity: 'base' })
      if (cmp !== 0) return cmp
    }
  }
  return ca.length - cb.length
}

type UnitLike = {
  number?: string | null
  street?: string | null
  stairwell?: { name?: string | null } | null
}

/**
 * Sortuje listę lokali w miejscu i ją zwraca (wygodne w `return`).
 *
 * Klucz: ulica → klatka → numer. Na osiedlu domów ulicy i klatek zwykle nie ma
 * i decyduje sam numer; w budynku wielorodzinnym grupowanie po klatce jest tym,
 * czego administrator oczekuje — inaczej lokale z różnych klatek przeplatają się.
 */
export function sortUnits<T extends UnitLike>(units: T[]): T[] {
  return units.sort((a, b) => {
    const byStreet = compareNatural(a.street, b.street)
    if (byStreet !== 0) return byStreet
    const byStair = compareNatural(a.stairwell?.name, b.stairwell?.name)
    if (byStair !== 0) return byStair
    return compareNatural(a.number, b.number)
  })
}
