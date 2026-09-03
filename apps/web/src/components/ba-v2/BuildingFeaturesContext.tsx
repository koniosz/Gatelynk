"use client";
/**
 * BuildingFeaturesContext (FAZA b — 2026-06-02).
 *
 * Per-budynek context z `objectType` + `features`. Wystawiany przez BA v2
 * layout (`apps/web/src/app/(ba-v2)/.../[id]/layout.tsx`) — child strony
 * używają `useBuildingFeatures()` do conditional rendering (np. sekcja
 * paczek pokazuje notatkę gdy `has_central_mailbox=false`).
 *
 * Defaulty z `BUILDING` żeby SSR/initial render nie kraszowały. Po fetch
 * w layout-cie context się aktualizuje.
 */
import { createContext, useContext } from "react";

export type ObjectType =
  | "BUILDING"
  | "HOUSING_ESTATE"
  | "MIXED_USE"
  | "CAMPUS"
  | "PARKING";

export interface BuildingFeatures {
  has_concierge: boolean;
  has_central_mailbox: boolean;
  delivery_to_door: boolean;
  has_security_guard: boolean;
  has_common_parking: boolean;
}

export const OBJECT_TYPE_LABELS: Record<ObjectType, string> = {
  BUILDING: "Budynek wielorodzinny",
  HOUSING_ESTATE: "Osiedle domów",
  MIXED_USE: "Wielofunkcyjny",
  CAMPUS: "Kampus",
  PARKING: "Tylko parking",
};

const DEFAULT_FEATURES: BuildingFeatures = {
  has_concierge: true,
  has_central_mailbox: true,
  delivery_to_door: false,
  has_security_guard: false,
  has_common_parking: true,
};

/**
 * FAZA e (2026-06-02) — Permissions Matrix per role.
 *
 * Backend wysyła w `building.featurePermissions` spłaszczony dict tylko dla
 * roli BA (klucze `feat_*` i `ap_*`). Tutaj trzymamy go w kontekście +
 * udostępniamy helper `hasBaFeature(key)` — child strony używają do
 * conditional rendering.
 */
export type FeaturePermissions = Record<string, boolean>;

interface BuildingFeaturesContextValue {
  objectType: ObjectType;
  features: BuildingFeatures;
  /** Permissions BA z `feat_*` + `ap_*`. Niezdefiniowany klucz → `true`. */
  featurePermissions: FeaturePermissions;
  /** Convenience: `hasBaFeature('vision_ai')`. */
  hasBaFeature: (feature: string) => boolean;
}

function defaultHasBaFeature(_: string) {
  return true;
}

const BuildingFeaturesContext = createContext<BuildingFeaturesContextValue>({
  objectType: "BUILDING",
  features: DEFAULT_FEATURES,
  featurePermissions: {},
  hasBaFeature: defaultHasBaFeature,
});

// FAZA 8.g (2026-06-03) — feature zależne od AI Engine. Wyłączenie
// `feat_ai_engine` automatycznie blokuje te przez kaskadę (backend tak
// samo robi w `hasPermission`; klient powtarza logikę żeby UI nie pokazywał
// elementu który backend i tak zwróci jako FEATURE_DISABLED).
const AI_ENGINE_DEPENDENT_FEATURES: ReadonlySet<string> = new Set([
  "vision_dashboard",
  "fall_detection",
  "brand_detection",
  "plate_ocr",
  "vision_ai",
]);

export function BuildingFeaturesProvider({
  objectType,
  features,
  featurePermissions,
  children,
}: {
  objectType: ObjectType;
  features: BuildingFeatures;
  featurePermissions?: FeaturePermissions;
  children: React.ReactNode;
}) {
  const perms = featurePermissions ?? {};
  const hasBaFeature = (feature: string): boolean => {
    const key = feature.startsWith("feat_") || feature.startsWith("ap_") ? feature : `feat_${feature}`;
    // FAZA 8.g — AI Engine cascade. Jeśli `feat_ai_engine` jest jawnie false
    // a `key` jest ML-dependent → zwróć false (cascade).
    if (key.startsWith("feat_")) {
      const featName = key.slice(5);
      if (AI_ENGINE_DEPENDENT_FEATURES.has(featName)) {
        if (perms["feat_ai_engine"] === false) return false;
      }
    }
    const v = perms[key];
    if (typeof v === "boolean") return v;
    return true; // default-on
  };
  return (
    <BuildingFeaturesContext.Provider
      value={{ objectType, features, featurePermissions: perms, hasBaFeature }}
    >
      {children}
    </BuildingFeaturesContext.Provider>
  );
}

export function useBuildingFeatures(): BuildingFeaturesContextValue {
  return useContext(BuildingFeaturesContext);
}

/**
 * Normalizuje `featurePermissions` z API (spłaszczone) — odrzuca śmieci.
 */
export function normalizeFeaturePermissions(input: unknown): FeaturePermissions {
  if (!input || typeof input !== "object") return {};
  const out: FeaturePermissions = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "boolean" && (k.startsWith("feat_") || k.startsWith("ap_"))) {
      out[k] = v;
    }
  }
  return out;
}

export function normalizeObjectType(raw: unknown): ObjectType {
  if (
    raw === "BUILDING" ||
    raw === "HOUSING_ESTATE" ||
    raw === "MIXED_USE" ||
    raw === "CAMPUS" ||
    raw === "PARKING"
  ) {
    return raw;
  }
  return "BUILDING";
}

export function normalizeFeatures(input: unknown): BuildingFeatures {
  if (!input || typeof input !== "object") return { ...DEFAULT_FEATURES };
  const obj = input as Record<string, unknown>;
  return {
    has_concierge: typeof obj.has_concierge === "boolean" ? obj.has_concierge : DEFAULT_FEATURES.has_concierge,
    has_central_mailbox: typeof obj.has_central_mailbox === "boolean" ? obj.has_central_mailbox : DEFAULT_FEATURES.has_central_mailbox,
    delivery_to_door: typeof obj.delivery_to_door === "boolean" ? obj.delivery_to_door : DEFAULT_FEATURES.delivery_to_door,
    has_security_guard: typeof obj.has_security_guard === "boolean" ? obj.has_security_guard : DEFAULT_FEATURES.has_security_guard,
    has_common_parking: typeof obj.has_common_parking === "boolean" ? obj.has_common_parking : DEFAULT_FEATURES.has_common_parking,
  };
}
