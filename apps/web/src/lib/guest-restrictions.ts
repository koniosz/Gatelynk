/**
 * Ograniczenia dostępu gościa (read-only) — pola ADDYTYWNE z endpointów list
 * gości dla BA/konsjerża. Starszy backend ich nie zwraca → helpery zwracają
 * null i UI nie pokazuje badge.
 *
 * Kontrakt (2026-07): każdy gość może mieć dodatkowo:
 *   • `allowedAccessPoints` — lista dozwolonych wejść z opcjonalnym limitem
 *     otwarć per wejście; null = wszystkie wejścia bez limitu
 *   • `recurringSchedule` — harmonogram cykliczny (dni ISO 1=pn..7=nd,
 *     null days = codziennie); null = dostęp przez cały okres ważności
 */

export interface GuestAllowedAccessPoint {
  apId: number;
  maxUses?: number | null;
}

export interface GuestRecurringSchedule {
  days: number[] | null;
  startTime: string;
  endTime: string;
  tz?: string | null;
}

/** Pola ograniczeń doklejane do gościa przez nowszy backend (opcjonalne). */
export interface GuestRestrictions {
  allowedAccessPoints?: GuestAllowedAccessPoint[] | null;
  recurringSchedule?: GuestRecurringSchedule | null;
}

/** Skróty dni tygodnia ISO — 1=pn .. 7=nd. */
const DAY_SHORT: Record<number, string> = {
  1: "pn",
  2: "wt",
  3: "śr",
  4: "czw",
  5: "pt",
  6: "sb",
  7: "nd",
};

/** „06:00" → „6:00" (spójnie z opisem backendu „Codziennie 6:00–7:00"). */
function fmtTime(t: string): string {
  return t.replace(/^0(\d)/, "$1");
}

/** Polska odmiana: 1 wejście / 2-4 wejścia / 5+ wejść (z regułą 12-14). */
function fmtEntriesCount(n: number): string {
  if (n === 1) return "1 wejście";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) {
    return `${n} wejścia`;
  }
  return `${n} wejść`;
}

/** „codziennie" albo lista dni „pn, śr, pt". */
function fmtDays(days: number[] | null): string {
  if (!days || days.length === 0 || days.length === 7) return "codziennie";
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => DAY_SHORT[d] ?? String(d))
    .join(", ");
}

/** Czy gość ma jakiekolwiek ograniczenia (badge widoczny)? */
export function hasRestrictions(g: GuestRestrictions): boolean {
  return g.allowedAccessPoints != null || g.recurringSchedule != null;
}

/**
 * Krótki opis ograniczeń do badge/tooltipa, np.
 * „2 wejścia · codziennie 6:00–7:00" albo „pn, śr 8:00–16:00".
 * Zwraca null gdy brak ograniczeń (stary backend / gość bez limitów).
 */
export function formatRestrictions(g: GuestRestrictions): string | null {
  const parts: string[] = [];
  if (g.allowedAccessPoints != null) {
    parts.push(fmtEntriesCount(g.allowedAccessPoints.length));
  }
  if (g.recurringSchedule != null) {
    const s = g.recurringSchedule;
    parts.push(`${fmtDays(s.days)} ${fmtTime(s.startTime)}–${fmtTime(s.endTime)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
