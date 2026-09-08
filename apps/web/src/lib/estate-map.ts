/**
 * Mapa osiedla (2026-09-08) — typy odpowiedzi API + helpery dopasowania
 * lokali do obszarów. Lustro `apps/api/src/estate-map/estate-map.types.ts`.
 */

export type EstateSlotKey = "A" | "B";

export interface EstateMapBuildingArea {
  id: string;
  label: string;
  street: string;
  number: string;
  unitCount: 1 | 2;
  x: number;
  y: number;
  w: number;
  h: number;
  a: number;
  slots: EstateSlotKey[];
}

export interface EstateMapGate {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface EstateMapStreetLabel {
  label: string;
  x: number;
  y: number;
}

export interface EstateMapConfig {
  name: string;
  imageUrl: string;
  canvas: { width: number; height: number };
  buildings: EstateMapBuildingArea[];
  gates: EstateMapGate[];
  streets: EstateMapStreetLabel[];
  geometryStatus?: string | null;
  addressStatus?: string | null;
  updatedAt?: string;
}

export interface EstateMapAssignment {
  mapBuildingId: string;
  slot: EstateSlotKey;
  unitId: number;
  unitLabel: string;
  assignedAt: string;
}

export interface EstateMapUnit {
  id: number;
  number: string;
  street: string | null;
  stairwellName: string | null;
  label: string;
}

export interface EstateMapResponse {
  map: EstateMapConfig | null;
  assignments: EstateMapAssignment[];
  units: EstateMapUnit[];
}

export const slotKey = (mapBuildingId: string, slot: EstateSlotKey) => `${mapBuildingId}:${slot}`;

/** Bez ogonków, małe litery — do wyszukiwania i porównań adresów. */
export function normalizePl(value: string | null | undefined): string {
  return String(value ?? "")
    .toLocaleLowerCase("pl")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Czy lokal z bazy „pasuje" adresowo do obszaru na mapie — tylko do
 * PODPOWIEDZI (kolejność i filtr „pod tym adresem"), nigdy do automatycznego
 * przypisania. Obsługuje oba modele: `street` osobno (osiedla domów) i
 * ulicę wpisaną w sam numer („Niewinna 7/1", jak w VN).
 */
export function unitMatchesArea(unit: EstateMapUnit, area: EstateMapBuildingArea): boolean {
  const street = normalizePl(area.street);
  const number = normalizePl(area.number);
  if (!number) return false;
  const full = normalizePl(`${unit.street ?? ""} ${unit.number}`);
  const key = street ? `${street} ${number}` : number;
  if (full === key) return true;
  if (full.startsWith(`${key}/`) || full.startsWith(`${key} `)) return true;
  // Numer bez ulicy w konfiguracji (np. „Budynek 16"): dopasuj po samym numerze
  // domu z dowolną ulicą — „niewinna 16/1" pasuje do „16".
  if (!street) {
    const m = full.match(/(?:^|\s)(\d+[a-z]?)(?:\/|$|\s)/);
    return !!m && m[1] === number;
  }
  return false;
}

export function areaTitle(area: EstateMapBuildingArea): string {
  const addr = `${area.street} ${area.number}`.trim();
  return addr || area.label;
}
