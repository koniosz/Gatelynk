/**
 * Formatowanie czasu w strefie OBIEKTU, nie przeglądarki.
 *
 * Zgłoszenie 2026-08-08: integrator pracował z komputera w strefie -04:00,
 * a oba obiekty stoją w Europe/Warsaw (+02:00). Odczyty tablic wyświetlały się
 * przesunięte o 6 godzin — czyli w praktyce bezużyteczne, bo nie dało się
 * powiedzieć, o której auto naprawdę wjechało na osiedle.
 *
 * Same znaczniki czasu są i były poprawne: zapisujemy je jako epoch (moment
 * uniwersalny, bez strefy). Błąd dotyczył WYŁĄCZNIE prezentacji — `toLocaleString`
 * bez wskazania strefy używa strefy przeglądarki.
 *
 * Zasada: zdarzenie na obiekcie opisujemy czasem obiektu. Osoba oglądająca
 * panel z innego kraju ma zobaczyć „14:32", bo o 14:32 czasu lokalnego auto
 * przejechało przez bramę — niezależnie od tego, gdzie ona sama siedzi.
 *
 * Strefa pochodzi z `/api/system` (pole `timezone` = strefa maszyny Edge).
 * Gdy jeszcze nie dotarła, używamy `Europe/Warsaw` — wszystkie dotychczasowe
 * instalacje są w Polsce, a błędne założenie i tak jest lepsze niż strefa
 * przypadkowego laptopa. Po dojściu danych komponenty przerysują się same.
 */

/** Strefa awaryjna — patrz uzasadnienie w nagłówku pliku. */
const FALLBACK_TZ = 'Europe/Warsaw'

let edgeTimezone: string = FALLBACK_TZ

/** Ustawia strefę obiektu — wołane z `useSystemInfo` po pobraniu `/api/system`. */
export function setEdgeTimezone(tz: string | undefined | null): void {
  if (tz && typeof tz === 'string') edgeTimezone = tz
}

export function getEdgeTimezone(): string {
  return edgeTimezone
}

function locale(lang: string): string {
  return lang === 'pl' ? 'pl-PL' : 'en-GB'
}

/** Data + godzina w czasie obiektu (np. „08.08, 16:48:36"). */
export function formatEdgeDateTime(
  ts: string | number | Date,
  lang: string,
  opts: Intl.DateTimeFormatOptions = {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  },
): string {
  return new Date(ts).toLocaleString(locale(lang), { ...opts, timeZone: edgeTimezone })
}

/** Sama godzina w czasie obiektu (np. „16:48:36"). */
export function formatEdgeTime(
  ts: string | number | Date,
  lang: string,
  opts: Intl.DateTimeFormatOptions = {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  },
): string {
  return new Date(ts).toLocaleTimeString(locale(lang), { ...opts, timeZone: edgeTimezone })
}

/**
 * Skrót strefy do pokazania obok czasu (np. „CEST").
 *
 * Warto go wyświetlać, gdy panel jest oglądany spoza strefy obiektu —
 * inaczej użytkownik nie ma jak zauważyć, że patrzy na czas zdalny.
 */
export function edgeTimezoneAbbr(lang: string): string {
  try {
    const parts = new Intl.DateTimeFormat(locale(lang), {
      timeZone: edgeTimezone,
      timeZoneName: 'short',
    }).formatToParts(new Date())
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/** Czy przeglądarka jest w innej strefie niż obiekt (→ warto pokazać strefę). */
export function viewerIsRemote(): boolean {
  try {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!browser || browser === edgeTimezone) return false
    // Porównujemy realne przesunięcie, nie nazwę strefy: `Europe/Warsaw` i
    // `Europe/Berlin` to różne nazwy, ale ten sam czas na zegarze — nie ma
    // wtedy czego sygnalizować.
    const now = new Date()
    const inTz = (tz: string) =>
      new Date(now.toLocaleString('en-US', { timeZone: tz })).getTime()
    return Math.abs(inTz(browser) - inTz(edgeTimezone)) > 60_000
  } catch {
    return false
  }
}
