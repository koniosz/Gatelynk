/**
 * Shared types + formatters for LPR (license plate recognition) reads in the
 * web panels. Used by both the building-admin and concierge pages so their
 * copy/rendering stays consistent.
 *
 * The API response shape matches `ReadRow` in `apps/api/src/lpr-reads/lpr-reads.service.ts`.
 * Changes there must be reflected here.
 */
import { formatBuildingTime } from './time'

/** Matches the VehicleKind enum in the API (Postgres enum). */
export type VehicleKind = 'RESIDENT' | 'SERVICE' | 'DELIVERY' | 'EMERGENCY' | 'PUBLIC'

export interface LprRead {
  id: number
  buildingId: number
  cameraDeviceId: string
  plate: string
  matched: boolean
  owner: string | null
  gateOpened: boolean
  reason: string | null
  confidence: number | null
  direction: string | null
  edgeReadId: number | null
  ts: string // ISO timestamp
  vehicleColor: string | null
  vehicleBrand: string | null
  vehicleType: string | null
  vehicleSubtype: string | null
  hasImage: boolean

  // Identification enrichment (null when the plate is unknown → shows
  // "Identyfikuj…" CTA in the UI).
  vehicleId: number | null
  vehicleKind: VehicleKind | null
  vehicleServiceName: string | null
  vehicleMake: string | null
  vehicleModel: string | null
  vehicleColorStored: string | null
  vehicleTags: string[]
  residentId: number | null
  residentFirstName: string | null
  residentLastName: string | null
  unitId: number | null
  unitNumber: string | null
  unitFloor: number | null
  // 2026-09-07 — lokal przypisany WPROST do pojazdu (unitId wyżej może
  // pochodzić z lokalu mieszkańca). Używane do preselekcji trybu „Lokal".
  vehicleUnitId?: number | null
  vehicleUnitLabel?: string | null
  // Atrybucja gościa (2026-08-13): odczyt bez pojazdu w rejestrze, tablica
  // z aktywnego w chwili odczytu zaproszenia.
  guestName?: string | null
  guestUnitLabel?: string | null
}

/**
 * Katalog kategorii „pojazd inny niż mieszkaniec". Używany zarówno w modalu
 * identyfikacji (selektor kategorii), jak i do renderowania badge'a na liście
 * odczytów. Każdy wpis trzyma etykietę PL, emoji oraz zestaw klas Tailwind
 * (tło/tekst) — dzięki temu UI nie powtarza tego mapowania w kilku miejscach.
 */
export const VEHICLE_KIND_OPTIONS: {
  value: VehicleKind
  label: string
  icon: string
  badgeClass: string
}[] = [
  { value: 'RESIDENT',  label: 'Mieszkaniec',           icon: '👤', badgeClass: 'bg-blue-50 text-blue-700' },
  { value: 'DELIVERY',  label: 'Dostawa / Kurier',      icon: '📦', badgeClass: 'bg-orange-50 text-orange-700' },
  { value: 'SERVICE',   label: 'Usługa / Serwis',       icon: '🔧', badgeClass: 'bg-emerald-50 text-emerald-700' },
  { value: 'EMERGENCY', label: 'Służby ratunkowe',      icon: '🚑', badgeClass: 'bg-red-50 text-red-700' },
  { value: 'PUBLIC',    label: 'Instytucja publiczna',  icon: '🏛️', badgeClass: 'bg-slate-100 text-slate-700' },
]

export function vehicleKindOption(kind: VehicleKind | null | undefined) {
  return VEHICLE_KIND_OPTIONS.find(o => o.value === kind) ?? null
}

/** Human-friendly Polish labels for Hikvision `<vehicleType>` enum values. */
const VEHICLE_TYPE_PL: Record<string, string> = {
  SUVMPV: 'SUV / MPV',
  Sedan: 'Sedan',
  sedan: 'Sedan',
  MinibusMPV: 'Minibus',
  Minibus: 'Minibus',
  Minivan: 'Minivan',
  LargeTruck: 'Ciężarówka',
  Truck: 'Ciężarówka',
  MediumTruck: 'Ciężarówka',
  SmallTruck: 'Dostawczy',
  PickupTruck: 'Pickup',
  Pickup: 'Pickup',
  Bus: 'Autobus',
  LargeBus: 'Autobus',
  MotorVehicle: 'Pojazd',
  NonMotorVehicle: 'Pojazd',
  Motor: 'Motocykl',
  Motorcycle: 'Motocykl',
  Bicycle: 'Rower',
}

export function vehicleTypePl(raw: string | null | undefined): string {
  if (!raw) return ''
  return VEHICLE_TYPE_PL[raw] ?? raw
}

/** Polish translation for the Hikvision `color` enum. Plate/car colors. */
const COLOR_PL: Record<string, string> = {
  black: 'czarny',
  white: 'biały',
  gray: 'szary',
  grey: 'szary',
  silver: 'srebrny',
  red: 'czerwony',
  blue: 'niebieski',
  green: 'zielony',
  yellow: 'żółty',
  brown: 'brązowy',
  orange: 'pomarańczowy',
  gold: 'złoty',
  pink: 'różowy',
  purple: 'fioletowy',
  beige: 'beżowy',
  unknown: '',
}

export function colorPl(raw: string | null | undefined): string {
  if (!raw) return ''
  return COLOR_PL[raw.toLowerCase()] ?? raw
}

/** CSS color for a little color swatch next to the brand. */
export function colorSwatch(raw: string | null | undefined): string | null {
  if (!raw) return null
  const map: Record<string, string> = {
    black: '#111827',
    white: '#f9fafb',
    gray: '#6b7280',
    grey: '#6b7280',
    silver: '#cbd5e1',
    red: '#dc2626',
    blue: '#2563eb',
    green: '#16a34a',
    yellow: '#eab308',
    brown: '#92400e',
    orange: '#f97316',
    gold: '#d4a017',
    pink: '#ec4899',
    purple: '#9333ea',
    beige: '#d6bfa4',
  }
  return map[raw.toLowerCase()] ?? null
}

/**
 * Short time formatter — czas w strefie Edge (Europe/Warsaw), NIE browsera.
 * Patrz `lib/time.ts` po uzasadnienie.
 */
export function formatReadTs(iso: string): string {
  return formatBuildingTime(iso, 'short')
}

/** Resident info label for a read: "Kowalski Jan · m. 12" or "" if unknown. */
export function ownerLabel(r: LprRead): string {
  if (!r.residentId) return ''
  const name = `${r.residentLastName ?? ''} ${r.residentFirstName ?? ''}`.trim()
  const unit = r.unitNumber ? ` · m. ${r.unitNumber}` : ''
  return name + unit
}

/**
 * Describes an identified read in one shot — used by the "Właściciel" cell.
 *
 * Priorytet renderowania:
 *   1. Pojazd RESIDENT (zawsze z mieszkańcem) → "Kowalski · m.12"
 *   2. Pojazd SERVICE/DELIVERY/EMERGENCY/PUBLIC z mieszkańcem
 *      → "🔧 Anna · Kowalski m.12" (mieszkaniec zgłosił swoją sprzątaczkę)
 *   3. Pojazd SERVICE/DELIVERY/... bez mieszkańca (ogólny serwis budynku)
 *      → "📦 Glovo"
 *
 * Zwraca obiekt, nie string, żeby wywołujący (React) mógł zrenderować
 * badge kategorii + tekst obok.
 */
export interface OwnerDisplay {
  kind: VehicleKind | null      // null dla nieprzypisanych odczytów
  icon: string | null           // emoji kategorii, null dla RESIDENT
  badgeClass: string | null
  primary: string               // główny tekst (serwis lub nazwisko)
  secondary: string | null      // dodatkowa linia (mieszkaniec pod serwisem albo "")
}

export function ownerDisplay(r: LprRead): OwnerDisplay | null {
  if (!r.vehicleId) {
    // Gość (2026-08-13): zamiast „nieznany" pokazujemy lokal zapraszającego —
    // administrator od razu wie, czyj to gość. Imię gościa w drugiej linii
    // (admin i tak widzi gości w swoim panelu — to nie wyciek).
    if (r.guestUnitLabel || r.guestName) {
      return {
        kind: null,
        icon: '🎫',
        badgeClass: null,
        primary: r.guestUnitLabel ? `Gość lokalu ${r.guestUnitLabel}` : 'Gość',
        secondary: r.guestName ?? null,
      }
    }
    return null   // nieprzypisany odczyt
  }

  const kind = (r.vehicleKind ?? 'RESIDENT') as VehicleKind
  const opt = vehicleKindOption(kind)
  const residentStr = r.residentId ? ownerLabel(r) : ''

  if (kind === 'RESIDENT') {
    return {
      kind,
      icon: null,
      badgeClass: null,
      primary: residentStr || '—',
      secondary: null,
    }
  }
  return {
    kind,
    icon: opt?.icon ?? '🚗',
    badgeClass: opt?.badgeClass ?? null,
    primary: r.vehicleServiceName?.trim() || opt?.label || 'Usługa',
    secondary: residentStr || null,
  }
}

/** Vehicle label combining camera-seen brand and manually-entered one. */
export function brandLabel(r: LprRead): string {
  // Human-entered (from Vehicle row) always wins — it's what the admin/
  // concierge confirmed manually. The camera's `vehicleBrand` is shown only
  // as a fallback for unidentified reads.
  if (r.vehicleMake) {
    return r.vehicleModel ? `${r.vehicleMake} ${r.vehicleModel}` : r.vehicleMake
  }
  return r.vehicleBrand ?? ''
}

/** Best color string for display (human-entered > camera-detected). */
export function colorLabel(r: LprRead): string {
  if (r.vehicleColorStored) return r.vehicleColorStored
  return colorPl(r.vehicleColor)
}

/**
 * Unified search filter used by the LPR reads pages (concierge + building-admin).
 *
 * Dopasowuje wpisany tekst kolejno do:
 *   • numeru tablicy (znak bez spacji i myślników, case-insensitive),
 *   • imienia / nazwiska mieszkańca (oba pola razem),
 *   • marki i modelu pojazdu (ręcznie wpisane oraz rozpoznane przez kamerę),
 *   • nazwy firmy/serwisu (np. „Glovo"),
 *   • numeru mieszkania („12", „m. 12", „m.12" — wszystko działa).
 *
 * Pusty query zawsze zwraca `true`. Dzięki temu wywołujący nie musi pilnować
 * krótkopisaństwa i może wrzucać cały stan pola tekstowego bezpośrednio.
 */
export function matchesReadSearch(r: LprRead, rawQuery: string): boolean {
  const raw = rawQuery.trim()
  if (!raw) return true

  // Tablica — porównujemy po usunięciu separatorów (np. „WA 12345" pasuje
  // do zapisanego „WA12345").
  const plateQ = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (plateQ && r.plate.includes(plateQ)) return true

  const q = raw.toLowerCase()

  // Mieszkaniec — oba pola łączymy, żeby „Jan Kow" też pasowało.
  const name = `${r.residentFirstName ?? ''} ${r.residentLastName ?? ''}`.toLowerCase()
  if (name.trim() && name.includes(q)) return true

  // Marka/model — ręcznie wprowadzone ma pierwszeństwo, ale przeszukujemy
  // też to, co rozpoznała kamera (przydatne dla nieprzypisanych odczytów).
  const brand = [
    r.vehicleMake, r.vehicleModel, r.vehicleBrand,
  ].filter(Boolean).join(' ').toLowerCase()
  if (brand && brand.includes(q)) return true

  // Nazwa firmy / serwisu — szukamy też bez akcentów czy emoji.
  const svc = (r.vehicleServiceName ?? '').toLowerCase()
  if (svc && svc.includes(q)) return true

  // Tagi pojazdu — admin/konsjerż taguje samochody (kabrio, Glovo, opiekunka,
  // żółty…). Szukamy substringiem po połączonych tagach, więc wpisanie
  // "glovo" znajdzie nawet "Glovo wieczorny kierowca".
  if (r.vehicleTags && r.vehicleTags.length > 0) {
    const tagsBlob = r.vehicleTags.join(' ').toLowerCase()
    if (tagsBlob.includes(q)) return true
  }

  // Mieszkanie — dopuszczamy wpisanie samego numeru („12") lub z prefixem.
  if (r.unitNumber) {
    const unitQ = q.replace(/^m\.?\s*/, '').trim()
    if (unitQ && r.unitNumber.toLowerCase().includes(unitQ)) return true
  }

  return false
}
