/**
 * Etykieta lokalu — kopia `apps/api/src/common/unit-label.ts` (2026-09-07).
 * Front składa ją sam tam, gdzie API zwraca surowy lokal (pickery lokali
 * w formularzach pojazdów). **Zmieniasz jedną — zmień drugą.**
 */
export interface UnitLike {
  number: string;
  street?: string | null;
  stairwell?: { name: string } | null;
  stairwellName?: string | null;
}

export function formatUnitLabel(u: UnitLike): string {
  const street = (u.street ?? "").trim();
  const base = street ? `${street} ${u.number}` : u.number;
  const sw = (u.stairwellName ?? u.stairwell?.name ?? "").trim();
  return sw ? `${sw}/${base}` : base;
}
