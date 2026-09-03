// 2026-06-02 (FAZA c) — AP category constants.
//
// Kategoria AccessPoint = semantyczny typ przejścia. Sterowanie defaultowym
// scope (np. FIRE_ESCAPE = ADMIN_ONLY) + grupowanie w UI integratora.

export const AP_CATEGORIES = [
  'MAIN_ENTRY',
  'FIRE_ESCAPE',
  'PEDESTRIAN_GATE',
  'GARAGE_ENTRY',
  'SERVICE_ENTRY',
  // 2026-07-08 (Nuki smart lock) — drzwi lokalu. AP z tą kategorią ma
  // `unitId` (przypisanie do lokalu) i specjalne reguły widoczności:
  //   • mieszkaniec: widzi tylko AP swojego lokalu (unit_residents),
  //   • gość: NIGDY w trybie „bez ograniczeń" — wyłącznie jawny wpis w
  //     allowedAccessPoints + jednorazowy podpisany nonce (Guest Pass).
  'UNIT_DOOR',
] as const

export type ApCategory = (typeof AP_CATEGORIES)[number]

export const AP_CATEGORY_LABELS: Record<ApCategory, string> = {
  MAIN_ENTRY: 'Brama główna',
  FIRE_ESCAPE: 'Brama pożarowa',
  PEDESTRIAN_GATE: 'Furtka piesza',
  GARAGE_ENTRY: 'Brama garażowa',
  SERVICE_ENTRY: 'Wjazd serwisowy',
  UNIT_DOOR: 'Drzwi lokalu',
}

export function isApCategory(value: unknown): value is ApCategory {
  return typeof value === 'string' && (AP_CATEGORIES as readonly string[]).includes(value)
}

// LPR camera direction (FAZA c). 'IN' = kamera wjazdowa, 'OUT' = wyjazdowa.
// Edge HikvisionLprService używa do logowania kierunku w access_events.
export const LPR_DIRECTIONS = ['IN', 'OUT'] as const
export type LprDirection = (typeof LPR_DIRECTIONS)[number]

export function isLprDirection(value: unknown): value is LprDirection {
  return typeof value === 'string' && (LPR_DIRECTIONS as readonly string[]).includes(value)
}
