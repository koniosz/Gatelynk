// 2026-06-02 (FAZA b) — Universal object types.
//
// Object type to typ obiektu zarządzanego przez GateLynk. Wartości trzymamy
// po stronie aplikacji (TS const) — DB ma TEXT bez constraint-u (backwards
// compat). Każdy typ ma own default zestaw `BuildingFeatures` (flagi
// behavioralne sterujące UI + service flow), nadpisywalny per-budynek przez
// integratora.

export const OBJECT_TYPES = [
  'BUILDING',
  'HOUSING_ESTATE',
  'MIXED_USE',
  'CAMPUS',
  'PARKING',
] as const

export type ObjectType = (typeof OBJECT_TYPES)[number]

export const OBJECT_TYPE_LABELS: Record<ObjectType, string> = {
  BUILDING: 'Budynek wielorodzinny',
  HOUSING_ESTATE: 'Osiedle domów',
  MIXED_USE: 'Wielofunkcyjny (sklepy + mieszkania)',
  CAMPUS: 'Kampus / wielobudynkowe',
  PARKING: 'Tylko parking',
}

/**
 * Flagi behavioralne sterujące UI/service flow. Trzymane jako JSON w
 * `Building.features` (open structure — nowe flagi bez migracji).
 *
 * Konwencje:
 *   - `has_*`  = element infrastrukturalny istnieje fizycznie w obiekcie
 *   - `*_to_*` = workflow dostawy/obsługi
 *
 * Konsumenci (jak na FAZE b):
 *   - BA panel: ukrywa sekcje paczek gdy `has_central_mailbox=false`
 *   - Concierge panel: blokuje login gdy `has_concierge=false`
 *   - iOS Resident: w przyszłości — kurier flow gdy `delivery_to_door=true`
 */
export interface BuildingFeatures {
  has_concierge: boolean
  has_central_mailbox: boolean
  delivery_to_door: boolean
  has_security_guard: boolean
  has_common_parking: boolean
  /**
   * 2026-07-30 — Przepustka wyjazdowa (exit grace pass, docs/exit-grace-pass.md).
   * Pojazd spoza whitelisty który wjechał, może wyjechać w oknie `minutes`
   * (kamera OUT otwiera przy no-match). Default WYŁĄCZONE — pole opcjonalne,
   * brak = disabled (Edge parsuje defensywnie po swojej stronie).
   */
  exitGrace?: ExitGraceConfig
}

/** Konfiguracja przepustki wyjazdowej — trzymana w Building.features (JSON). */
export interface ExitGraceConfig {
  enabled: boolean
  /** Okno ważności przepustki w minutach (5–120). */
  minutes: number
  /**
   * Polityka po upływie okna przy próbie wyjazdu:
   *   OPEN_AND_FLAG (default, decyzja właściciela 2026-07-30) — otwórz +
   *     zdarzenie OVERSTAY (nikt nie zostaje uwięziony przy szlabanie),
   *   DENY — nie otwieraj (kierowca dzwoni domofonem).
   */
  afterExpiry: 'OPEN_AND_FLAG' | 'DENY'
}

export const EXIT_GRACE_MIN_MINUTES = 5
export const EXIT_GRACE_MAX_MINUTES = 120

export const DEFAULT_EXIT_GRACE: ExitGraceConfig = {
  enabled: false,
  minutes: 15,
  afterExpiry: 'OPEN_AND_FLAG',
}

/**
 * Sanityzacja configu exitGrace (z DB JSON albo z PATCH body). Braki/śmieci
 * → defaulty; minutes clamp 5–120. Lustro `parseExitGraceConfig` na Edge
 * (apps/edge/src/devices/cameras/exit-grace.util.ts) — oba końce muszą
 * rozumieć ten sam kształt.
 */
export function normalizeExitGrace(raw: unknown): ExitGraceConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_EXIT_GRACE }
  const o = raw as Record<string, unknown>
  const minutesNum = Number(o.minutes)
  const minutes = Number.isFinite(minutesNum)
    ? Math.min(EXIT_GRACE_MAX_MINUTES, Math.max(EXIT_GRACE_MIN_MINUTES, Math.round(minutesNum)))
    : DEFAULT_EXIT_GRACE.minutes
  return {
    enabled: o.enabled === true,
    minutes,
    afterExpiry: o.afterExpiry === 'DENY' ? 'DENY' : 'OPEN_AND_FLAG',
  }
}

/**
 * Defaulty per ObjectType. Używane przy:
 *  - create Building (integrator wybiera tylko `objectType`, features prefill)
 *  - change `objectType` (PATCH — features = DEFAULT_FEATURES[newType]
 *    chyba że jawnie podane w body)
 */
export const DEFAULT_FEATURES: Record<ObjectType, BuildingFeatures> = {
  BUILDING: {
    has_concierge: true,
    has_central_mailbox: true,
    delivery_to_door: false,
    has_security_guard: false,
    has_common_parking: true,
  },
  HOUSING_ESTATE: {
    has_concierge: false,
    has_central_mailbox: false,
    delivery_to_door: true,
    has_security_guard: true,
    has_common_parking: false,
  },
  MIXED_USE: {
    has_concierge: true,
    has_central_mailbox: true,
    delivery_to_door: false,
    has_security_guard: true,
    has_common_parking: true,
  },
  CAMPUS: {
    has_concierge: false,
    has_central_mailbox: false,
    delivery_to_door: true,
    has_security_guard: true,
    has_common_parking: false,
  },
  PARKING: {
    has_concierge: false,
    has_central_mailbox: false,
    delivery_to_door: false,
    has_security_guard: false,
    has_common_parking: true,
  },
}

/**
 * Normalizuje partial input z body do pełnego `BuildingFeatures`. Brakujące
 * pola dopełnia z defaultów dla danego typu. Używane w PATCH endpoincie.
 */
export function normalizeFeatures(
  objectType: ObjectType,
  input: Partial<BuildingFeatures> | null | undefined,
): BuildingFeatures {
  const defaults = DEFAULT_FEATURES[objectType]
  if (!input || typeof input !== 'object') return { ...defaults }
  return {
    has_concierge:       typeof input.has_concierge === 'boolean'       ? input.has_concierge       : defaults.has_concierge,
    has_central_mailbox: typeof input.has_central_mailbox === 'boolean' ? input.has_central_mailbox : defaults.has_central_mailbox,
    delivery_to_door:    typeof input.delivery_to_door === 'boolean'    ? input.delivery_to_door    : defaults.delivery_to_door,
    has_security_guard:  typeof input.has_security_guard === 'boolean'  ? input.has_security_guard  : defaults.has_security_guard,
    has_common_parking:  typeof input.has_common_parking === 'boolean'  ? input.has_common_parking  : defaults.has_common_parking,
    // exitGrace jest opcjonalne (brak = wyłączone) — ale gdy obecne w input,
    // MUSI przejść przez normalizację i nie może zostać zgubione (wcześniej
    // normalizeFeatures strip-owało nieznane pola, co przy PATCH object-type
    // kasowałoby konfigurację przepustki wyjazdowej).
    ...(input.exitGrace !== undefined ? { exitGrace: normalizeExitGrace(input.exitGrace) } : {}),
  }
}

export function isObjectType(value: unknown): value is ObjectType {
  return typeof value === 'string' && (OBJECT_TYPES as readonly string[]).includes(value)
}
