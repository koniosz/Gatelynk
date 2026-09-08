/**
 * Mapa osiedla (2026-09-08) — typy konfiguracji i odpowiedzi.
 *
 * Konfiguracja pochodzi z paczki projektowej (konfiguracja-budynkow.json):
 * obszary budynków w pikselach renderu (środek x/y, rozmiar w/h, obrót a),
 * liczba lokali 1|2 i części A/B. Części to oznaczenia OBSZARÓW na rysunku —
 * nie numery /1 i /2; który lokal z bazy jest którą częścią, decyduje
 * administrator (estate_map_slots).
 */

export type EstateSlotKey = 'A' | 'B'

export interface EstateMapBuildingArea {
  /** Trwały klucz obszaru w obrębie osiedla, np. "outer-7". */
  id: string
  label: string
  street: string
  number: string
  unitCount: 1 | 2
  /** Środek obszaru w pikselach canvasu. */
  x: number
  y: number
  w: number
  h: number
  /** Obrót w stopniach. */
  a: number
  slots: EstateSlotKey[]
}

export interface EstateMapGate {
  id: string
  name: string
  /** Pozycja znormalizowana 0..1 względem canvasu. */
  x: number
  y: number
}

export interface EstateMapStreetLabel {
  label: string
  x: number
  y: number
}

export interface EstateMapConfigInput {
  name: string
  imageUrl: string
  canvas: { width: number; height: number }
  buildings: EstateMapBuildingArea[]
  gates?: EstateMapGate[]
  streets?: EstateMapStreetLabel[]
  geometryStatus?: string | null
  addressStatus?: string | null
}

export interface EstateMapOut extends EstateMapConfigInput {
  gates: EstateMapGate[]
  streets: EstateMapStreetLabel[]
  updatedAt: string
}

export interface EstateMapAssignment {
  mapBuildingId: string
  slot: EstateSlotKey
  unitId: number
  unitLabel: string
  assignedAt: string
}

export interface EstateMapUnit {
  id: number
  number: string
  street: string | null
  stairwellName: string | null
  label: string
}
