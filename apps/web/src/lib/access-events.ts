/**
 * Wspólne typy + helpery dla widoku „Wejścia (audit)" — concierge i building-admin.
 *
 * Format wpisu odpowiada `AccessEventRow` z apps/api/src/access-events/access-events.service.ts.
 * BigInt po stronie API jest serializowany do stringa — dlatego `id` jest stringiem.
 */
import { formatBuildingTime } from './time'

export type AccessEventType =
  | 'LPR_MATCH'
  | 'LPR_NO_MATCH'
  | 'PIN_USED'
  | 'REMOTE_OPEN'
  | 'MANUAL_OPEN'
  | 'INTERCOM_CALL'

export type OpenedByType = 'RESIDENT' | 'ADMIN' | 'CONCIERGE' | 'EDGE' | 'SYSTEM'

export interface AccessEvent {
  id: string
  ts: string
  type: AccessEventType
  direction: string | null
  gateOpened: boolean
  reason: string | null
  plate: string | null
  accessPointId: number | null
  accessPointLabel: string | null
  residentId: number | null
  residentName: string | null
  residentUnitNumber: string | null
  vehicleId: number | null
  vehicleBrand: string | null
  vehicleModel: string | null
  guestId: number | null
  guestName: string | null
  openedById: number | null
  openedByType: OpenedByType | null
  openedByName: string | null
  meta: Record<string, unknown> | null
}

export const TYPE_LABEL: Record<AccessEventType, string> = {
  LPR_MATCH:     'Wjazd LPR',
  LPR_NO_MATCH:  'Nieznana tablica',
  PIN_USED:      'PIN gościa',
  REMOTE_OPEN:   'Otwarcie zdalne',
  MANUAL_OPEN:   'Otwarcie ręczne',
  INTERCOM_CALL: 'Wezwanie domofonu',
}

export const TYPE_ICON: Record<AccessEventType, string> = {
  LPR_MATCH:     '🚗',
  LPR_NO_MATCH:  '❓',
  PIN_USED:      '🔢',
  REMOTE_OPEN:   '📱',
  MANUAL_OPEN:   '🖐',
  INTERCOM_CALL: '🔔',
}

/** Tag CSS color klas dla ikon — Tailwind. */
export function typeBadgeClass(type: AccessEventType, gateOpened: boolean): string {
  if (!gateOpened) return 'bg-rose-100 text-rose-700'
  switch (type) {
    case 'LPR_MATCH':     return 'bg-emerald-100 text-emerald-700'
    case 'LPR_NO_MATCH':  return 'bg-amber-100 text-amber-700'
    case 'PIN_USED':      return 'bg-blue-100 text-blue-700'
    case 'REMOTE_OPEN':   return 'bg-violet-100 text-violet-700'
    case 'MANUAL_OPEN':   return 'bg-slate-200 text-slate-700'
    case 'INTERCOM_CALL': return 'bg-orange-100 text-orange-700'
  }
}

/** Format timestampu dla tabel — czas w strefie Edge (Europe/Warsaw), patrz `lib/time.ts`. */
export function formatEventTs(ts: string): string {
  return formatBuildingTime(ts, 'datetime')
}

/**
 * Imię gościa dla eventu — kolumna `guestName` z JOIN-a, a gdy gość został
 * już skasowany (FK SetNull) fallback do snapshotu `meta.guestName`
 * zapisywanego przy LPR-events (2026-07-04).
 */
export function eventGuestName(ev: AccessEvent): string | null {
  if (ev.guestName) return ev.guestName
  const metaName = ev.meta?.guestName
  return typeof metaName === 'string' && metaName.length > 0 ? metaName : null
}

/**
 * 2026-07-30 — Przepustka wyjazdowa (exit grace pass, docs/exit-grace-pass.md).
 * Edge zapisuje wyjazd pojazdu spoza whitelisty jako LPR_NO_MATCH z reason:
 *   exit_pass       — wyjazd w oknie przepustki (gateOpened=true)
 *   overstay        — wyjazd po oknie, polityka OPEN_AND_FLAG (gateOpened=true)
 *   overstay_denied — próba wyjazdu po oknie, polityka DENY (gateOpened=false)
 * meta.exitPass = { enteredAt, dwellMinutes, graceMinutes, ... }.
 */
export const EXIT_GRACE_REASON_LABEL: Record<string, string> = {
  exit_pass:       'Wyjazd na przepustce',
  overstay:        'Przekroczony czas pobytu',
  overstay_denied: 'Przekroczony czas pobytu — wyjazd zablokowany',
}

/**
 * Etykieta PL dla eventów przepustki wyjazdowej, z czasem pobytu gdy meta
 * go niesie: „Wyjazd na przepustce (12 min na osiedlu)". Null dla innych
 * eventów — caller pomija.
 */
export function exitPassLabel(ev: AccessEvent): string | null {
  if (!ev.reason || !(ev.reason in EXIT_GRACE_REASON_LABEL)) return null
  const meta = ev.meta?.exitPass as { dwellMinutes?: unknown } | undefined
  const dwell = typeof meta?.dwellMinutes === 'number' ? meta.dwellMinutes : null
  const base = EXIT_GRACE_REASON_LABEL[ev.reason]
  return dwell != null ? `${base} (${dwell} min na osiedlu)` : base
}

/**
 * Czytelny opis „kto / co" — używany w kolumnie głównej tabeli.
 * Reguły priorytetu:
 *   1) Tablica (LPR) — najmocniejszy sygnał wizualny.
 *   2) Imię gościa (PIN_USED, REMOTE_OPEN przez portal).
 *   3) Imię rezydenta (REMOTE_OPEN z app).
 *   4) Fallback: typeLabel.
 */
export function eventPrimary(ev: AccessEvent): string {
  if (ev.plate) return ev.plate
  const guest = eventGuestName(ev)
  if (guest) return `Gość: ${guest}`
  if (ev.residentName) return ev.residentName
  return TYPE_LABEL[ev.type]
}

/** Drugi rząd — kontekst (gość przy LPR, punkt dostępu, marka pojazdu, powód odrzucenia). */
export function eventSecondary(ev: AccessEvent): string {
  const parts: string[] = []
  // Gdy primary to tablica (LPR), imię gościa nie może zginąć — wjazd autem
  // gościa jest oznaczany „Gość: X" w drugim rzędzie (2026-07-04).
  const guest = eventGuestName(ev)
  if (ev.plate && guest) parts.push(`Gość: ${guest}`)
  // Przepustka wyjazdowa — „Wyjazd na przepustce (X min na osiedlu)" /
  // „Przekroczony czas pobytu" widoczne wprost w feedzie.
  const exitPass = exitPassLabel(ev)
  if (exitPass) parts.push(exitPass)
  if (ev.accessPointLabel) parts.push(ev.accessPointLabel)
  if (ev.type === 'LPR_MATCH') {
    const bm = [ev.vehicleBrand, ev.vehicleModel].filter(Boolean).join(' ')
    if (bm) parts.push(bm)
  }
  if (ev.residentUnitNumber) parts.push(`Lok. ${ev.residentUnitNumber}`)
  // Raw reason pomijamy gdy exitPassLabel już go opisał po polsku.
  if (!ev.gateOpened && ev.reason && !exitPass) parts.push(`Odrzucone: ${ev.reason}`)
  return parts.join(' · ')
}

/**
 * Status otwarcia bramy — opisuje co fizycznie się stało po danym evencie.
 * Symetrycznie do kolumny „Brama" na liście odczytów LPR (page.tsx),
 * dzięki czemu user nie musi się zastanawiać „a czy to LPR_MATCH otworzyło
 * bramę, czy tylko zapisało event?".
 *
 * Zwracamy descriptor (label + tone), nie gotowy JSX, żeby builderzy stron
 * mogli go ostylować jak chcą (badge w tabeli vs ikona w iOS w przyszłości).
 */
export type GateStatusTone = 'ok' | 'warn' | 'bad' | 'muted'
export interface GateStatus {
  label: string
  tone: GateStatusTone
  /** Krótki opis na hover — dla rejected/denied podajemy `reason` z eventu. */
  hint?: string
}

export function gateStatus(ev: AccessEvent): GateStatus {
  if (ev.type === 'INTERCOM_CALL') {
    // Domofon dzwoni — nikt nie otworzył jeszcze bramy, to nie odrzucenie.
    return { label: 'wezwanie', tone: 'muted' }
  }
  if (ev.gateOpened) {
    return { label: '✓ otwarta', tone: 'ok' }
  }
  // gateOpened=false — albo odrzucenie (LPR_NO_MATCH, PIN expired) albo
  // „matched ale nie otwarto" (rzadki: LPR_MATCH gdy Edge nie wywołał relay).
  if (ev.type === 'LPR_MATCH') {
    return { label: 'przypisana, nie otwarto', tone: 'warn', hint: ev.reason ?? undefined }
  }
  return { label: '⛔ odrzucona', tone: 'bad', hint: ev.reason ?? undefined }
}

/** Tailwind klasy dla badge'a `gateStatus`. */
export function gateStatusClass(tone: GateStatusTone): string {
  switch (tone) {
    case 'ok':    return 'text-green-700 bg-green-50'
    case 'warn':  return 'text-amber-700 bg-amber-50'
    case 'bad':   return 'text-rose-700 bg-rose-50'
    case 'muted': return 'text-gray-500 bg-gray-100'
  }
}
