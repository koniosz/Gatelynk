/**
 * Porównywanie oznaczeń lokali „po ludzku", a nie alfabetycznie.
 *
 * Zgłoszenie 2026-08-09 (Osiedle VN, numeracja 1/1 … 21/1): sortowanie tekstowe
 * stawia „10/1" przed „2/1" i lista domów wygląda na losową.
 *
 * Listy pobierane z API są już posortowane po stronie serwera
 * (apps/api/src/common/natural-sort.ts — tam żyje ta sama logika). Ten helper
 * jest dla list, które panel składa SAM z kilku źródeł i sam musi uporządkować.
 * Obie kopie trzeba zmieniać razem, inaczej kolejność w panelu rozjedzie się
 * z kolejnością na wyświetlaczu domofonu.
 *
 * Obsługuje formaty spotykane w bazie naraz:
 *   Niewinna 1/1 … Niewinna 21/2   (osiedle domów — numer z nazwą ulicy w środku)
 *   1, 2, 10, 21                    (numer mieszkania)
 *   4, 4A, 4B                       (lokale z literą — goły numer pierwszy)
 *   G-1, G-10                       (garaże)
 */

/** Rozbija „21/1" na `[21, '/', 1]` — liczby jako liczby, reszta jako tekst. */
function chunks(s: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /(\d+)|(\D+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] !== undefined ? Number(m[1]) : m[2]);
  }
  return out;
}

/**
 * Komparator do `Array.sort` dla oznaczeń lokali i etykiet.
 * Puste wartości lądują na końcu — brak numeru to brak informacji, a nie „0".
 */
export function compareNatural(a: string | null | undefined, b: string | null | undefined): number {
  const sa = (a ?? "").trim();
  const sb = (b ?? "").trim();
  if (!sa && !sb) return 0;
  if (!sa) return 1;
  if (!sb) return -1;

  const ca = chunks(sa);
  const cb = chunks(sb);
  const len = Math.min(ca.length, cb.length);

  for (let i = 0; i < len; i++) {
    const x = ca[i];
    const y = cb[i];
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else {
      // Fragment liczbowy przed tekstowym: „4" wcześniej niż „4A".
      const cmp = String(x).localeCompare(String(y), "pl", { sensitivity: "base" });
      if (cmp !== 0) return cmp;
    }
  }
  return ca.length - cb.length;
}
