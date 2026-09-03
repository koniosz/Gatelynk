/**
 * Testy graniczne walidacji harmonogramu/limitu gościa (2026-07-08).
 *
 * Uruchamianie (bez jest-a w Edge — node:test na skompilowanym dist):
 *   pnpm --filter @gatelynk/edge build
 *   node --test apps/edge/dist/devices/intercom/guest-restrictions.util.spec.js
 *
 * Pokrycie: północ (granice okna), okno przechodzące przez dobę (22-06),
 * DST (zmiana czasu marzec/październik, Europe/Warsaw), dni tygodnia,
 * limity użyć (allowedEntryFor), parsowanie.
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  isWithinSchedule,
  allowedEntryFor,
  parseAllowedAccessPoints,
  parseRecurringSchedule,
  describeSchedulePl,
  localClock,
  type RecurringSchedule,
} from './guest-restrictions.util'

/** Moment „ściana zegara" w Europe/Warsaw → epoch ms (offset podany jawnie). */
function warsaw(iso: string, offset: '+01:00' | '+02:00'): number {
  return new Date(`${iso}${offset}`).getTime()
}

const s = (o: Partial<RecurringSchedule> & { startTime: string; endTime: string }): RecurringSchedule => ({
  tz: 'Europe/Warsaw',
  days: null,
  ...o,
})

// ── Podstawowe okno dzienne 06:00–07:00 ─────────────────────────────────────
test('okno 06-07: przed, start-inclusive, w środku, end-exclusive, po', () => {
  const sch = s({ startTime: '06:00', endTime: '07:00' })
  // 2026-07-08 to środa, lato = +02:00
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-08T05:59:59', '+02:00')), false)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-08T06:00:00', '+02:00')), true)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-08T06:30:00', '+02:00')), true)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-08T06:59:59', '+02:00')), true)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-08T07:00:00', '+02:00')), false)
})

test('brak harmonogramu (null) = zawsze OK', () => {
  assert.equal(isWithinSchedule(null, Date.now()), true)
  assert.equal(isWithinSchedule(undefined, Date.now()), true)
})

// ── Dni tygodnia ─────────────────────────────────────────────────────────────
test('dni tygodnia: tylko pn/śr — wt odrzucony', () => {
  const sch = s({ days: [1, 3], startTime: '06:00', endTime: '07:00' })
  // 2026-07-06 = poniedziałek, 07 = wtorek, 08 = środa
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-06T06:30:00', '+02:00')), true)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-07T06:30:00', '+02:00')), false)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-08T06:30:00', '+02:00')), true)
})

test('pusta lista dni = codziennie', () => {
  const sch = s({ days: [], startTime: '06:00', endTime: '07:00' })
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-12T06:30:00', '+02:00')), true) // niedziela
})

// ── Północ / okno przez dobę ────────────────────────────────────────────────
test('okno przez północ 22:00-06:00: wieczór i ranek OK, południe NIE', () => {
  const sch = s({ startTime: '22:00', endTime: '06:00' })
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-08T23:30:00', '+02:00')), true)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-09T00:00:00', '+02:00')), true)  // dokładnie północ
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-09T05:59:59', '+02:00')), true)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-09T06:00:00', '+02:00')), false)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-08T12:00:00', '+02:00')), false)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-08T21:59:59', '+02:00')), false)
})

test('okno przez północ + dni: dzień przypisany do STARTU (pt 22 → sb 05 OK, sb 23 NIE)', () => {
  // days=[5] (piątek), 22:00-06:00 → pt wieczór i sb nad ranem należą do okna.
  const sch = s({ days: [5], startTime: '22:00', endTime: '06:00' })
  // 2026-07-10 = piątek, 11 = sobota
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-10T22:30:00', '+02:00')), true)  // pt wieczór
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-11T05:30:00', '+02:00')), true)  // sb rano (kontynuacja pt)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-11T22:30:00', '+02:00')), false) // sb wieczór — poza days
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-10T05:30:00', '+02:00')), false) // pt rano (kontynuacja czw)
})

test('okno przez północ pon 22-06: pon rano (kontynuacja nd) odrzucone, wt rano OK', () => {
  const sch = s({ days: [1], startTime: '22:00', endTime: '06:00' })
  // 2026-07-06 = poniedziałek
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-06T05:00:00', '+02:00')), false) // pon rano = okno niedzielne
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-06T23:00:00', '+02:00')), true)
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-07T05:00:00', '+02:00')), true)  // wt rano = kontynuacja pon
})

// ── DST (Europe/Warsaw) ─────────────────────────────────────────────────────
test('DST wiosna (2026-03-29, 02:00→03:00): harmonogram liczy czas LOKALNY', () => {
  const sch = s({ startTime: '06:00', endTime: '07:00' })
  // Noc zmiany czasu: 2026-03-29. O 06:30 lokalnego (już +02:00) OK.
  assert.equal(isWithinSchedule(sch, warsaw('2026-03-29T06:30:00', '+02:00')), true)
  // Ten sam epoch co 05:30 lokalnie → poza oknem.
  assert.equal(isWithinSchedule(sch, warsaw('2026-03-29T05:30:00', '+02:00')), false)
  // Dzień przed zmianą (zima, +01:00) — 06:30 lokalnie OK.
  assert.equal(isWithinSchedule(sch, warsaw('2026-03-28T06:30:00', '+01:00')), true)
})

test('DST wiosna: okno 02:00-03:00 w noc zmiany czasu NIE istnieje lokalnie', () => {
  const sch = s({ startTime: '02:00', endTime: '03:00' })
  // 2026-03-29: 01:59:59+01:00 → następna sekunda to 03:00+02:00.
  assert.equal(isWithinSchedule(sch, warsaw('2026-03-29T01:59:59', '+01:00')), false)
  assert.equal(isWithinSchedule(sch, warsaw('2026-03-29T03:00:00', '+02:00')), false)
  // Dzień wcześniej okno normalnie działa.
  assert.equal(isWithinSchedule(sch, warsaw('2026-03-28T02:30:00', '+01:00')), true)
})

test('DST jesień (2026-10-25, 03:00→02:00): 02:30 występuje dwa razy — oba w oknie', () => {
  const sch = s({ startTime: '02:00', endTime: '03:00' })
  // Pierwsze 02:30 (+02:00, przed cofnięciem) i drugie 02:30 (+01:00, po).
  assert.equal(isWithinSchedule(sch, warsaw('2026-10-25T02:30:00', '+02:00')), true)
  assert.equal(isWithinSchedule(sch, warsaw('2026-10-25T02:30:00', '+01:00')), true)
  // 03:30 po cofnięciu — poza oknem.
  assert.equal(isWithinSchedule(sch, warsaw('2026-10-25T03:30:00', '+01:00')), false)
})

test('localClock zwraca ISO weekday i minuty w Warszawie', () => {
  const clk = localClock(warsaw('2026-07-12T06:15:00', '+02:00'), 'Europe/Warsaw') // niedziela
  assert.equal(clk.isoWeekday, 7)
  assert.equal(clk.minutes, 6 * 60 + 15)
})

test('zła strefa czasowa → fallback do Europe/Warsaw (nie crash)', () => {
  const sch: RecurringSchedule = { days: null, startTime: '06:00', endTime: '07:00', tz: 'Not/AZone' }
  assert.equal(isWithinSchedule(sch, warsaw('2026-07-08T06:30:00', '+02:00')), true)
})

// ── Limity użyć / allowlista AP ─────────────────────────────────────────────
test('allowedEntryFor: brak allowlisty = wszystko dozwolone bez limitu', () => {
  assert.deepEqual(allowedEntryFor(null, 5), { allowed: true, maxUses: null })
  assert.deepEqual(allowedEntryFor(undefined, 5), { allowed: true, maxUses: null })
})

test('allowedEntryFor: AP spoza listy zablokowane; limit czytany z wpisu', () => {
  const allowed = [{ apId: 3, maxUses: 2 }, { apId: 7 }]
  assert.deepEqual(allowedEntryFor(allowed, 3), { allowed: true, maxUses: 2 })
  assert.deepEqual(allowedEntryFor(allowed, 7), { allowed: true, maxUses: null })
  assert.deepEqual(allowedEntryFor(allowed, 9), { allowed: false, maxUses: null })
})

// ── Parsowanie ──────────────────────────────────────────────────────────────
test('parseAllowedAccessPoints: walidacja + dedup + pusta lista → null', () => {
  assert.equal(parseAllowedAccessPoints(null), null)
  assert.equal(parseAllowedAccessPoints([]), null)
  assert.deepEqual(parseAllowedAccessPoints([{ apId: 2, maxUses: 3 }, { apId: 2, maxUses: 9 }]), [
    { apId: 2, maxUses: 3 },
  ])
  assert.throws(() => parseAllowedAccessPoints([{ apId: 0 }]))
  assert.throws(() => parseAllowedAccessPoints([{ apId: 1, maxUses: 0 }]))
  assert.throws(() => parseAllowedAccessPoints('nope' as any))
})

test('parseRecurringSchedule: format HH:MM, 7 dni → codziennie (null), równe czasy odrzucone', () => {
  assert.equal(parseRecurringSchedule(null), null)
  const p = parseRecurringSchedule({ days: [1, 2, 3, 4, 5, 6, 7], startTime: '06:00', endTime: '07:00' })
  assert.equal(p?.days, null)
  assert.equal(p?.tz, 'Europe/Warsaw')
  assert.throws(() => parseRecurringSchedule({ startTime: '6:00', endTime: '07:00' }))
  assert.throws(() => parseRecurringSchedule({ startTime: '06:00', endTime: '06:00' }))
  assert.throws(() => parseRecurringSchedule({ days: [8], startTime: '06:00', endTime: '07:00' }))
})

test('describeSchedulePl: codziennie i wybrane dni', () => {
  assert.equal(describeSchedulePl(s({ startTime: '06:00', endTime: '07:00' })), 'Codziennie 6:00–7:00')
  assert.equal(
    describeSchedulePl(s({ days: [1, 3, 5], startTime: '22:00', endTime: '06:00' })),
    'pn, śr, pt 22:00–6:00',
  )
  assert.equal(describeSchedulePl(null), null)
})
