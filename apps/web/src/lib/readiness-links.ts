/**
 * Mapa: check gotowości → miejsce w panelu, gdzie się to konfiguruje.
 *
 * Jedno źródło prawdy dla setup-huba (karty „co zrobić") i karty „Gotowość
 * obiektu" na stronie obiektu — zgłoszenie Konrada 2026-08-01: każdy czerwony
 * / pomarańczowy check ma być klikalny i prowadzić prosto do konfiguracji.
 *
 * `href` = null → brak dedykowanej strony (np. konto BA zakładane w legacy
 * panelu superadmina) — wtedy wiersz zostaje nieklikalny.
 */
export interface ReadinessLink {
  href: ((buildingId: string) => string) | null
  /** Krótka etykieta celu — tooltip/CTA („Urządzenia → Punkty dostępu"). */
  cta: string | null
}

export const READINESS_LINKS: Record<string, ReadinessLink> = {
  edge: {
    href: (id) => `/integrator/buildings/${id}/devices`,
    cta: 'Urządzenia → karta Edge',
  },
  devices: {
    href: (id) => `/integrator/buildings/${id}/devices`,
    cta: 'Urządzenia → drzewo urządzeń',
  },
  access_points: {
    href: (id) => `/integrator/buildings/${id}/devices`,
    cta: 'Urządzenia → Punkty dostępu',
  },
  lpr: {
    href: (id) => `/integrator/buildings/${id}/devices`,
    cta: 'Urządzenia → Kamery LPR',
  },
  building_admin: { href: null, cta: null },
  concierge: {
    href: (id) => `/integrator/buildings/${id}`,
    cta: 'Strona obiektu → Typ obiektu',
  },
  building_data: {
    href: (id) => `/integrator/buildings/${id}/setup/import`,
    cta: 'Import mieszkańców (CSV)',
  },
  invitations: {
    href: (id) => `/integrator/buildings/${id}/setup/invitations`,
    cta: 'Zaproszenia mieszkańców',
  },
  ai_engine: {
    href: (id) => `/integrator/buildings/${id}/devices`,
    cta: 'Urządzenia → AI Engine',
  },
}

/** Ścieżka docelowa dla checku (null gdy brak dedykowanej strony). */
export function readinessHref(checkId: string, buildingId: string): string | null {
  const meta = READINESS_LINKS[checkId]
  return meta?.href ? meta.href(buildingId) : null
}

/** Etykieta celu („Urządzenia → Punkty dostępu") — do tooltipa/CTA. */
export function readinessCta(checkId: string): string | null {
  return READINESS_LINKS[checkId]?.cta ?? null
}
