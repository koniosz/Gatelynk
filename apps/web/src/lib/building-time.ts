/**
 * Czas OSIEDLA, nie przeglądarki (2026-08-15).
 *
 * Zgłoszenie: strona Wizji AI oglądana z komputera w innej strefie czasowej
 * (np. USA) pokazywała czasy przesunięte o kilka godzin — `toLocaleTimeString`
 * bez `timeZone` formatuje w strefie PRZEGLĄDARKI. Zdarzenia na osiedlu
 * (przejazdy, detekcje, odczyty) mają sens wyłącznie w czasie lokalnym
 * obiektu — administrator porównuje je z nagraniami i relacjami mieszkańców.
 *
 * Wszystkie instalacje GateLynk są dziś w Polsce, więc strefa jest stałą.
 * Gdy dojdzie obiekt za granicą: dodać `Building.timezone` i podawać ją
 * z API zamiast stałej — sygnatury poniżej się nie zmienią.
 */
export const BUILDING_TZ = "Europe/Warsaw";

export function buildingTime(ms: number, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleTimeString("pl-PL", {
    timeZone: BUILDING_TZ,
    hour: "2-digit",
    minute: "2-digit",
    ...opts,
  });
}

export function buildingDate(ms: number, opts?: Intl.DateTimeFormatOptions): string {
  return new Date(ms).toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ, ...opts });
}

/** „YYYY-MM-DD" w strefie osiedla — do porównań „ten sam dzień co dziś?". */
export function buildingDayKey(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUILDING_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}
