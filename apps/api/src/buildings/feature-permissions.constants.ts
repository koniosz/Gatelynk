// FAZA e (2026-06-02) — Permissions Matrix per role.
//
// Trzy role × N feature/AP. Integrator widzi w panelu visual matrix i decyduje
// co BA/Concierge/Resident dostaje per budynek. Backend filtruje API zwroty +
// rzuca 403 na zablokowane endpointy. Frontend (web BA + concierge + iOS)
// conditional rendering bazując na flagach.
//
// Defaulty per `objectType` siedzą w migracji
// `20260602210000_building_feature_permissions/migration.sql` — backfill
// idempotentny (`WHERE = '{}'::jsonb`). Po PATCH-u przez integratora
// permissions stają się eksplicytne dla danego budynku.

/**
 * Kompletna lista system features, które integrator może włączyć/wyłączyć
 * per rola. Nowa flaga = dodać tu + label + (opcjonalnie) hook po stronie
 * backendu w `requireFeature(...)` w danym serwisie.
 */
export const SYSTEM_FEATURES = [
  // FAZA 8.g (2026-06-03) — `ai_engine` jest MASTER feature-em dla wszystkich
  // ML-owych zależnych od zewnętrznego silnika YOLO/Vision (vision_dashboard,
  // brand_detection, plate_ocr, fall_detection). Wyłączenie `ai_engine`
  // automatycznie blokuje pozostałe przez kaskadę w `hasPermission`.
  'ai_engine',           // AI Engine / YOLO service (master flag)
  'vision_dashboard',    // Vision AI dashboard / detection feed
  'fall_detection',      // Fall detection alerts (BA dashboard + iOS push)
  'brand_detection',     // EasyOCR brand detection (kurier identyfikacja)
  'plate_ocr',           // LPR OCR przez AI Engine (alternative do Hikvision native)
  'vision_ai',           // (legacy alias dla vision_dashboard — zachowany dla starych perms)
  'lpr_audit',           // LPR audit / Odczyty tablic
  'guest_portal',        // Guest invitation + portal /g/<token>
  'resident_pin',        // Resident PIN configuration (Akuvox keypad)
  'courier_visits',      // Courier visits flow (osiedle domów)
  'schedules',           // AccessPoint cron schedules
  'parcels',             // Parcels management
  'tickets',             // Tickets / zgłoszenia
  'payments',            // Payments / czynsze
  'reservations',        // Common area reservations
  'vehicles',            // Vehicle management (whitelist LPR)
  'guests',              // Guest management
  'notifications',       // Push notifications
  'building_branding',   // Logo/background upload (BA only)
] as const

/**
 * Features które wymagają działającego AI Engine. Wyłączenie `feat_ai_engine`
 * przez integratora automatycznie blokuje te feature niezależnie od ich
 * jawnego ustawienia (kaskada master→child w `hasPermission`).
 *
 * UI integratora pokazuje to jako badge "zależy od AI Engine" przy każdej
 * z tych feature, plus hint przy odznaczeniu `feat_ai_engine`.
 */
export const AI_ENGINE_DEPENDENT_FEATURES: readonly SystemFeature[] = [
  'vision_dashboard',
  'fall_detection',
  'brand_detection',
  'plate_ocr',
  'vision_ai',   // legacy alias — też zależy od AI Engine
] as const

export type SystemFeature = typeof SYSTEM_FEATURES[number]
export type Role = 'ba' | 'concierge' | 'resident'

export const ROLES: readonly Role[] = ['ba', 'concierge', 'resident'] as const

export const FEATURE_LABELS: Record<SystemFeature, string> = {
  ai_engine:          'AI Engine (silnik wizji)',
  vision_dashboard:   'Vision AI dashboard',
  fall_detection:     'Wykrywanie upadków',
  brand_detection:    'Rozpoznawanie marek (kurierzy)',
  plate_ocr:          'OCR tablic przez AI',
  vision_ai:          'AI Vision dashboard (legacy)',
  lpr_audit:          'Odczyty tablic (LPR)',
  guest_portal:       'Portal gości',
  resident_pin:       'PIN mieszkańca',
  courier_visits:     'Wizyty kurierów',
  schedules:          'Harmonogramy bram (cron)',
  parcels:            'Paczki',
  tickets:            'Zgłoszenia',
  payments:           'Płatności',
  reservations:       'Rezerwacje części wspólnych',
  vehicles:           'Pojazdy / whitelist',
  guests:             'Goście',
  notifications:      'Powiadomienia',
  building_branding:  'Branding budynku (logo)',
}

export const ROLE_LABELS: Record<Role, string> = {
  ba:        'Administrator',
  concierge: 'Konsjerż',
  resident:  'Mieszkaniec',
}

/**
 * Klucz w permissions[role][...] — typowanie z brandingiem.
 *   `feat_<system_feature>`  — flagą feature jak `feat_lpr_audit`
 *   `ap_<accessPointId>`     — per AccessPoint, np. `ap_39`
 */
export type PermissionKey = `feat_${SystemFeature}` | `ap_${number}`

export function featKey(feature: SystemFeature): PermissionKey {
  return `feat_${feature}` as PermissionKey
}

export function apKey(accessPointId: number): PermissionKey {
  return `ap_${accessPointId}` as PermissionKey
}

export interface BuildingFeaturePermissions {
  ba?: Record<string, boolean>
  concierge?: Record<string, boolean>
  resident?: Record<string, boolean>
}

/**
 * Czy dana rola ma dostęp do feature/AP w tym budynku.
 *
 * Logika:
 *   - kaskada: jeśli `key` należy do `AI_ENGINE_DEPENDENT_FEATURES` ORAZ
 *     `feat_ai_engine` jest JAWNIE `false` → zwróć `false` (kaskada master).
 *     Wsteczna kompatybilność: budynek bez `feat_ai_engine` w permissions
 *     → default `true` → ML feature działa normalnie jak dotąd.
 *   - jeśli `permissions[role][key]` jest jawnym booleanem → użyj go,
 *   - w przeciwnym razie zwróć `true` (nie blokuj feature, której
 *     integrator nigdy świadomie nie wyłączył).
 *
 * Defaulty per objectType są zapisane w DB przez migration backfill, więc
 * po pierwszym deploy każdy budynek będzie mieć jawne permissions dla
 * 99% case'ów. Fallback `true` to defense gdyby ktoś dodał nową feature
 * i jeszcze nie zrobił PATCH-u.
 */
export function hasPermission(
  permissions: BuildingFeaturePermissions | null | undefined,
  role: Role,
  key: PermissionKey | string,
): boolean {
  // FAZA 8.g — AI Engine cascade. Sprawdzamy czy `key` zaczyna się od
  // `feat_` i odpowiada feature zależnej od AI Engine.
  if (typeof key === 'string' && key.startsWith('feat_')) {
    const featName = key.slice(5) as SystemFeature
    if ((AI_ENGINE_DEPENDENT_FEATURES as readonly string[]).includes(featName)) {
      const aiEngineExplicit = permissions?.[role]?.['feat_ai_engine']
      if (aiEngineExplicit === false) return false
    }
  }
  const explicit = permissions?.[role]?.[key]
  if (typeof explicit === 'boolean') return explicit
  return true
}

/**
 * Normalizuje raw JSON z DB do typed shape. Wybiera tylko 3 klucze ról.
 * Wszystko inne ignorowane (forward-compat).
 */
export function normalizePermissions(raw: unknown): BuildingFeaturePermissions {
  if (!raw || typeof raw !== 'object') return { ba: {}, concierge: {}, resident: {} }
  const p = raw as Record<string, unknown>
  const grabRole = (key: Role): Record<string, boolean> => {
    const v = p[key]
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, boolean> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'boolean') out[k] = val
    }
    return out
  }
  return {
    ba:        grabRole('ba'),
    concierge: grabRole('concierge'),
    resident:  grabRole('resident'),
  }
}

/**
 * Spłaszczone permissions dla danej roli — flat dict `{ feat_*:bool, ap_*:bool }`
 * łatwy do wysłania do klienta (iOS / Web) który nie musi rozumieć
 * struktury 3-poziomowej.
 */
export function flattenForRole(
  permissions: BuildingFeaturePermissions | null | undefined,
  role: Role,
): Record<string, boolean> {
  return normalizePermissions(permissions)[role] ?? {}
}

/**
 * Defaulty per objectType — używane przez `POST /permissions/reset` żeby
 * przywrócić zalecane wartości dla danego typu budynku. Synced z
 * migration backfill — gdy zmieniasz tu wartości, pamiętaj o migracji
 * dla nowych budynków.
 */
export const DEFAULT_PERMISSIONS_BY_OBJECT_TYPE: Record<string, BuildingFeaturePermissions> = {
  BUILDING: {
    ba: {
      feat_ai_engine: true, feat_vision_dashboard: true, feat_brand_detection: true,
      feat_plate_ocr: true,
      feat_vision_ai: true, feat_fall_detection: true, feat_lpr_audit: true,
      feat_guest_portal: true, feat_resident_pin: true, feat_courier_visits: false,
      feat_schedules: true, feat_parcels: true, feat_tickets: true,
      feat_payments: true, feat_reservations: true, feat_vehicles: true,
      feat_guests: true, feat_notifications: true, feat_building_branding: true,
    },
    concierge: {
      feat_lpr_audit: true, feat_guest_portal: true, feat_parcels: true,
      feat_tickets: true, feat_vehicles: true, feat_guests: true,
      feat_notifications: true, feat_reservations: true,
    },
    resident: {
      feat_fall_detection: true, feat_guest_portal: true, feat_resident_pin: true,
      feat_parcels: true, feat_tickets: true, feat_payments: true,
      feat_reservations: true, feat_vehicles: true, feat_guests: true,
      feat_notifications: true,
    },
  },
  HOUSING_ESTATE: {
    ba: {
      feat_ai_engine: true, feat_vision_dashboard: true, feat_brand_detection: true,
      feat_plate_ocr: true,
      feat_vision_ai: true, feat_fall_detection: true, feat_lpr_audit: true,
      feat_guest_portal: true, feat_resident_pin: true, feat_courier_visits: true,
      feat_schedules: true, feat_tickets: true, feat_payments: true,
      feat_vehicles: true, feat_guests: true, feat_notifications: true,
      feat_building_branding: true,
    },
    concierge: {},
    resident: {
      feat_fall_detection: true, feat_guest_portal: true, feat_resident_pin: true,
      feat_courier_visits: true, feat_tickets: true, feat_payments: true,
      feat_vehicles: true, feat_guests: true, feat_notifications: true,
    },
  },
  MIXED_USE: {
    ba: {
      feat_ai_engine: true, feat_vision_dashboard: true, feat_brand_detection: true,
      feat_plate_ocr: true,
      feat_vision_ai: true, feat_fall_detection: true, feat_lpr_audit: true,
      feat_guest_portal: true, feat_resident_pin: true, feat_courier_visits: false,
      feat_schedules: true, feat_parcels: true, feat_tickets: true,
      feat_payments: true, feat_vehicles: true, feat_guests: true,
      feat_notifications: true, feat_building_branding: true,
    },
    concierge: {
      feat_lpr_audit: true, feat_guest_portal: true, feat_parcels: true,
      feat_tickets: true, feat_vehicles: true, feat_guests: true,
      feat_notifications: true,
    },
    resident: {
      feat_fall_detection: true, feat_guest_portal: true, feat_resident_pin: true,
      feat_parcels: true, feat_tickets: true, feat_payments: true,
      feat_vehicles: true, feat_guests: true, feat_notifications: true,
    },
  },
  CAMPUS: {
    ba: {
      feat_ai_engine: true, feat_vision_dashboard: true, feat_brand_detection: true,
      feat_plate_ocr: true,
      feat_vision_ai: true, feat_fall_detection: true, feat_lpr_audit: true,
      feat_guest_portal: true, feat_resident_pin: true, feat_courier_visits: true,
      feat_schedules: true, feat_tickets: true, feat_payments: true,
      feat_vehicles: true, feat_guests: true, feat_notifications: true,
      feat_building_branding: true,
    },
    concierge: {
      feat_lpr_audit: true, feat_guest_portal: true, feat_tickets: true,
      feat_vehicles: true, feat_guests: true, feat_notifications: true,
    },
    resident: {
      feat_fall_detection: true, feat_guest_portal: true, feat_resident_pin: true,
      feat_courier_visits: true, feat_tickets: true, feat_payments: true,
      feat_vehicles: true, feat_guests: true, feat_notifications: true,
    },
  },
  PARKING: {
    ba: {
      feat_lpr_audit: true, feat_schedules: true, feat_vehicles: true,
      feat_notifications: true,
    },
    concierge: {},
    resident: {
      feat_vehicles: true, feat_notifications: true,
    },
  },
}

export function defaultPermissionsFor(objectType: string): BuildingFeaturePermissions {
  return DEFAULT_PERMISSIONS_BY_OBJECT_TYPE[objectType]
    ?? DEFAULT_PERMISSIONS_BY_OBJECT_TYPE.BUILDING
}

/**
 * Standard error code dla 403 gdy permission jest wyłączona. iOS / Web
 * używa tego do pokazania spójnego komunikatu.
 */
export const FEATURE_DISABLED_CODE = 'FEATURE_DISABLED'
export const FEATURE_DISABLED_MESSAGE = 'Funkcja nie jest aktywna w tym obiekcie'
