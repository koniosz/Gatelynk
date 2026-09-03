/**
 * Lista certyfikowanych urządzeń — wersjonowana baza testów GateLynk QA.
 *
 * Każdy wpis to **kombinacja** driver + konkretny model + firmware, dla której:
 *   • przeszliśmy ręczny test integracji (otwieranie drzwi, snapshot, restart,
 *     dla LPR — push tablicy + odbiór eventu, dla KNX — GroupValueWrite),
 *   • driver-katalog zawiera ewentualne quirki firmware (w `constants`),
 *   • znamy znane issue i mamy obejścia.
 *
 * UI wizarda (Step 2) pokazuje badge:
 *   ✅ Certyfikowany — z tej listy
 *   🟡 Beta         — z `driver.certification.status === 'beta'`
 *   ⚪ Nietestowany — brak certyfikacji lub `untested`
 *
 * Aktualizacja: gdy QA przetestuje nowy model/fw, dorzucamy tu wpis +
 * (jeśli trzeba) update'ujemy `constants` drivera.
 */

export interface CertifiedDevice {
  /** Wskaźnik na driver z `DRIVERS[]`. */
  driverId: string
  /** Konkretny model (z `driver.models[]`). */
  model: string
  /** Lista firmware-versions na których testowaliśmy (wildcard `'X.Y.*'` OK). */
  firmwareVersions: string[]
  /** Data ostatniego testu (ISO 8601). */
  testedAt: string
  /** Kto testował. */
  testedBy: string
  /** Znane issue + obejścia. UI pokazuje przy kliknięciu w badge. */
  knownIssues?: string[]
  recommendedFor?: 'residential' | 'commercial' | 'enterprise'
  /** Krótka notatka („otwiera szybko", „ma problemy z night-mode") — luźny tekst. */
  notes?: string
}

/**
 * Lista certyfikowanych. Sortuj po manufacturer → model dla łatwiejszego
 * przeglądania. Wpisy są przepuszczane przez `certifiedFor(driverId)` w UI
 * wizarda, więc kolejność tu nie ma znaczenia funkcjonalnego.
 *
 * Pierwsza generacja certyfikacji (2026-05-14, przed pierwszym klientem produkcyjnym):
 *   • Akuvox E18 / R29  — testowane na demo-instalacji u Konrada,
 *   • Hikvision DS-2CD2087G2 (kamera) + iDS-TCM403 (LPR) — testowane tamże,
 *   • DNAKE S617 — testowany w polskich projektach (HSC).
 */
export const CERTIFIED: CertifiedDevice[] = [
  // ── Akuvox ──
  {
    driverId: 'akuvox-smartplus',
    model: 'E18',
    firmwareVersions: ['17.0.x'],
    testedAt: '2026-04-15',
    testedBy: 'GateLynk QA',
    recommendedFor: 'residential',
    notes: 'Działa w pełni: open/close, snapshot HTTP, MJPEG live, restart. SIP do mieszkańca.',
  },
  {
    driverId: 'akuvox-smartplus',
    model: 'R29',
    firmwareVersions: ['18.30.6', '18.30.x'],
    testedAt: '2026-05-08',
    testedBy: 'GateLynk QA',
    recommendedFor: 'residential',
    knownIssues: [
      'fw 18.30.x: HTTPS basic auth zwraca "Not Safe -4" → driver używa HTTPS bez auth na :443 (LAN-only whitelist).',
      'Snapshot wymaga HTTP fallback na port 80 gdy HTTPS odpowie EPROTO.',
    ],
  },

  // ── Hikvision ──
  {
    driverId: 'hikvision-camera',
    model: 'DS-2CD2087G2-L',
    firmwareVersions: ['V5.7.x'],
    testedAt: '2026-04-20',
    testedBy: 'GateLynk QA',
    recommendedFor: 'residential',
    notes: 'IP kamera 4K z HDR. ISAPI snapshot OK, RTSP main+sub.',
  },
  {
    driverId: 'hikvision-lpr',
    model: 'iDS-TCM403-AI',
    firmwareVersions: ['V5.6.10', 'V5.7.x'],
    testedAt: '2026-03-20',
    testedBy: 'GateLynk QA',
    recommendedFor: 'commercial',
    notes: 'LPR z DeepInView. Push ANPR do Edge przez ISAPI host-notification — działa stabilnie.',
    knownIssues: [
      'Domyślny confidence 0.5 jest za niski → daje false-positive. Driver wymusza 0.8.',
    ],
  },

  // ── DNAKE ──
  {
    driverId: 'dnake-intercom',
    model: 'S617',
    firmwareVersions: ['1.0.x', '1.1.x'],
    testedAt: '2026-05-14',
    testedBy: 'GateLynk QA',
    recommendedFor: 'residential',
    notes: 'Wideodomofon SIP. Otwieranie + snapshot OK. Brak natywnego MJPEG → RTSP fallback.',
  },
]

/** Zwraca certyfikacje dla danego drivera (może być wiele wpisów dla różnych modeli). */
export function certifiedFor(driverId: string): CertifiedDevice[] {
  return CERTIFIED.filter((c) => c.driverId === driverId)
}

/** Sprawdza czy konkretny model dla drivera jest certyfikowany. */
export function isCertified(driverId: string, model?: string): boolean {
  if (!model) return CERTIFIED.some((c) => c.driverId === driverId)
  return CERTIFIED.some(
    (c) => c.driverId === driverId && c.model.toLowerCase() === model.toLowerCase(),
  )
}
