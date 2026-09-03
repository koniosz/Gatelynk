/**
 * Ograniczenia dostępu gościa (2026-07-08) — czyste funkcje walidacji.
 *
 * Guest ma dwa opcjonalne pola (NULL = brak ograniczeń, pełny backward-compat):
 *   • `allowedAccessPoints` — [{apId, maxUses?}] — do których AP gość ma dostęp
 *     i ile razy może każde otworzyć (brak maxUses = bez limitu),
 *   • `recurringSchedule` — {days, startTime, endTime, tz} — cykliczne okno
 *     dobowe DZIAŁAJĄCE W RAMACH validFrom..validTo (oba warunki AND).
 *
 * UWAGA: bliźniacza kopia tego pliku żyje na Edge
 * (apps/edge/src/devices/intercom/guest-restrictions.util.ts) — Edge musi
 * walidować OFFLINE, bez importu z Cloud. Zmieniasz tu → zmień tam
 * (unit testy graniczne są po stronie Edge: północ, przejście przez dobę, DST).
 *
 * Strefa czasowa: harmonogram liczymy w strefie `tz` (domyślnie
 * Europe/Warsaw) przez Intl.DateTimeFormat — poprawnie obsługuje DST
 * (sqlite na Edge nie ma TZ, więc liczenie musi być w JS).
 */

export interface AllowedAccessPointEntry {
  apId: number
  /** Ile razy gość może otworzyć to wejście. undefined/null = bez limitu. */
  maxUses?: number | null
  /**
   * 2026-07-08 (Nuki UNIT_DOOR) — tryb zatwierdzania przez hosta: klik gościa
   * tworzy PENDING request + push do mieszkańca zamiast natychmiastowego
   * otwarcia. Egzekwowane TYLKO dla AP category=UNIT_DOOR (Cloud portal path);
   * dla zwykłych AP pole jest ignorowane. undefined/null = otwarcie od razu.
   */
  approvalRequired?: boolean | null
}

export interface RecurringSchedule {
  /** Dni tygodnia ISO (1=pn … 7=nd). Pusta lista / null = codziennie. */
  days?: number[] | null
  /** "HH:MM" początek okna dobowego (w strefie tz). */
  startTime: string
  /** "HH:MM" koniec okna. endTime <= startTime → okno przez północ. */
  endTime: string
  /** IANA tz, domyślnie Europe/Warsaw. */
  tz?: string | null
}

export const DEFAULT_GUEST_TZ = 'Europe/Warsaw'

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** "06:30" → 390 (minuty od północy). null gdy zły format. */
export function parseHHMM(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = HHMM_RE.exec(v.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * Parsuje/waliduje surowy JSON `allowedAccessPoints`. Zwraca null gdy brak
 * ograniczeń (null/undefined/pusta lista) — pusta lista NIE jest sposobem na
 * „zablokuj wszystko" (od tego jest cancel zaproszenia).
 * Rzuca Error przy nieprawidłowej strukturze (walidacja DTO).
 */
export function parseAllowedAccessPoints(raw: unknown): AllowedAccessPointEntry[] | null {
  if (raw === null || raw === undefined) return null
  if (!Array.isArray(raw)) throw new Error('allowedAccessPoints musi być listą')
  const out: AllowedAccessPointEntry[] = []
  for (const it of raw) {
    const apId = Number((it as any)?.apId)
    if (!Number.isInteger(apId) || apId <= 0) {
      throw new Error('allowedAccessPoints: każdy wpis wymaga apId (dodatnia liczba)')
    }
    const rawMax = (it as any)?.maxUses
    let maxUses: number | null = null
    if (rawMax !== undefined && rawMax !== null && rawMax !== '') {
      maxUses = Number(rawMax)
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
        throw new Error('allowedAccessPoints: maxUses musi być liczbą 1..1000')
      }
    }
    const approvalRequired = (it as any)?.approvalRequired === true ? true : null
    if (!out.some((e) => e.apId === apId)) out.push({ apId, maxUses, approvalRequired })
  }
  return out.length > 0 ? out : null
}

/**
 * Parsuje/waliduje surowy JSON `recurringSchedule`. null = brak harmonogramu.
 * Rzuca Error przy złej strukturze. startTime == endTime jest odrzucane
 * (okno zerowe — bez sensu; pełna doba = brak harmonogramu).
 */
export function parseRecurringSchedule(raw: unknown): RecurringSchedule | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('recurringSchedule musi być obiektem')
  }
  const o = raw as Record<string, unknown>
  const start = parseHHMM(o.startTime)
  const end = parseHHMM(o.endTime)
  if (start === null || end === null) {
    throw new Error('recurringSchedule: startTime/endTime w formacie HH:MM')
  }
  if (start === end) {
    throw new Error('recurringSchedule: startTime i endTime nie mogą być równe')
  }
  let days: number[] | null = null
  if (o.days !== undefined && o.days !== null) {
    if (!Array.isArray(o.days)) throw new Error('recurringSchedule: days musi być listą 1..7')
    const parsed = o.days.map((d) => Number(d))
    if (parsed.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new Error('recurringSchedule: dni tygodnia to liczby 1 (pn) .. 7 (nd)')
    }
    const uniq = [...new Set(parsed)].sort((a, b) => a - b)
    // Wszystkie 7 dni = codziennie = normalizujemy do null.
    days = uniq.length === 0 || uniq.length === 7 ? null : uniq
  }
  const tz = typeof o.tz === 'string' && o.tz.trim() ? o.tz.trim() : DEFAULT_GUEST_TZ
  return {
    days,
    startTime: String(o.startTime).trim(),
    endTime: String(o.endTime).trim(),
    tz,
  }
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
}

/**
 * Lokalna „ściana zegara" w strefie tz dla danego momentu — ISO weekday +
 * minuty od północy. Intl obsługuje DST (2:00→3:00 w marcu itd.) poprawnie.
 */
export function localClock(atMs: number, tz: string): { isoWeekday: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = fmt.formatToParts(new Date(atMs))
  let weekday = 'Mon'
  let hour = 0
  let minute = 0
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value
    else if (p.type === 'hour') hour = Number(p.value)
    else if (p.type === 'minute') minute = Number(p.value)
  }
  // hourCycle h23 daje 00-23; defensywnie: 24 → 0 (stare ICU potrafiło h24).
  if (hour === 24) hour = 0
  return { isoWeekday: WEEKDAY_TO_ISO[weekday] ?? 1, minutes: hour * 60 + minute }
}

/**
 * Czy moment `atMs` mieści się w harmonogramie cyklicznym?
 *
 * Semantyka:
 *   • days: null/pusta = codziennie; inaczej lista ISO weekday 1..7,
 *   • start < end  → okno w obrębie doby: day∈days && start ≤ t < end,
 *   • end ≤ start  → okno PRZEZ PÓŁNOC (np. 22:00-06:00): pasuje gdy
 *     (t ≥ start && day∈days) LUB (t < end && poprzedni-dzień∈days) —
 *     dzień przypisujemy do STARTU okna (pt 22:00-06:00 = pt wieczór → sb rano).
 *
 * `schedule=null` → zawsze true (brak harmonogramu).
 */
export function isWithinSchedule(
  schedule: RecurringSchedule | null | undefined,
  atMs: number = Date.now(),
): boolean {
  if (!schedule) return true
  const start = parseHHMM(schedule.startTime)
  const end = parseHHMM(schedule.endTime)
  if (start === null || end === null) return true // uszkodzone dane → fail-open na okno validFrom..validTo
  const tz = schedule.tz && schedule.tz.trim() ? schedule.tz : DEFAULT_GUEST_TZ
  let clock: { isoWeekday: number; minutes: number }
  try {
    clock = localClock(atMs, tz)
  } catch {
    clock = localClock(atMs, DEFAULT_GUEST_TZ)
  }
  const days = schedule.days && schedule.days.length > 0 ? schedule.days : null
  const dayOk = (isoDay: number) => !days || days.includes(isoDay)

  if (start < end) {
    return dayOk(clock.isoWeekday) && clock.minutes >= start && clock.minutes < end
  }
  // Okno przez północ.
  if (clock.minutes >= start) return dayOk(clock.isoWeekday)
  if (clock.minutes < end) {
    const prevDay = clock.isoWeekday === 1 ? 7 : clock.isoWeekday - 1
    return dayOk(prevDay)
  }
  return false
}

/** Wpis allowlisty dla danego AP; null = AP niedozwolone; `unrestricted` gdy brak allowlisty. */
export function allowedEntryFor(
  allowed: AllowedAccessPointEntry[] | null | undefined,
  apId: number,
): { allowed: boolean; maxUses: number | null; approvalRequired: boolean; explicit: boolean } {
  if (!allowed || allowed.length === 0) {
    return { allowed: true, maxUses: null, approvalRequired: false, explicit: false }
  }
  const entry = allowed.find((e) => e.apId === apId)
  if (!entry) return { allowed: false, maxUses: null, approvalRequired: false, explicit: false }
  return {
    allowed: true,
    maxUses: entry.maxUses ?? null,
    approvalRequired: entry.approvalRequired === true,
    explicit: true,
  }
}

const DAY_LABELS_PL = ['', 'pn', 'wt', 'śr', 'czw', 'pt', 'sb', 'nd']

/** „Codziennie 6:00–7:00" / „pn, śr, pt 6:00–7:00" — do UI portalu/iOS/paneli. */
export function describeSchedulePl(schedule: RecurringSchedule | null | undefined): string | null {
  if (!schedule) return null
  const fmt = (t: string) => {
    const m = parseHHMM(t)
    if (m === null) return t
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
  }
  const days = schedule.days && schedule.days.length > 0 ? schedule.days : null
  const daysTxt = !days
    ? 'Codziennie'
    : days.map((d) => DAY_LABELS_PL[d] ?? String(d)).join(', ')
  return `${daysTxt} ${fmt(schedule.startTime)}–${fmt(schedule.endTime)}`
}
