import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { StoreService } from '../../store/store.service'
import { VisionDetectService } from './vision-detect.service'

/**
 * SituationCorrelatorService (2026-08-26) — warstwa zdarzeń sytuacyjnych.
 *
 * Pojedyncze klatki wizji i odczyty LPR nie mają pamięci — każda żyje osobno.
 * Ten serwis co 60 s rekonstruuje SEKWENCJE z okna wstecz i skleja je w
 * zdarzenia zapisywane do `situation_events`:
 *
 *   TAILGATING       — drugi (nieznany) pojazd przejechał ≤20 s za pojazdem,
 *                      który otworzył bramę, na to samo otwarcie. [OBSERVED]
 *   VEHICLE_LOITERING— nieznana tablica ≥3 odczyty w klastrze bez wjazdu.
 *                      [OBSERVED]
 *   NIGHT_PERSON     — osoba w kadrze między 23:00 a 05:00 (epizody per
 *                      kamera, przerwa >10 min zamyka epizod). [OBSERVED]
 *   VEHICLE_WAITING  — pojazd ciągle w kadrze ≥8 min bez przejazdu, po ≥10
 *                      min pustki przed epizodem. [INFERRED — interpretacja]
 *   COURIER_VISIT    — klatki z brand_detected sklejone w wizytę od–do
 *                      (przerwa >12 min = nowa wizyta). [OBSERVED]
 *   FALL_CONFIRMED   — anomaly FALL z likelihood ≥0.5 w ≥2 klatkach ≤3 min —
 *                      pojedyncza klatka to false positive. [INFERRED]
 *
 * Idempotencja: każde zdarzenie ma dedup_key pochodny od stabilnego początku
 * epizodu; INSERT OR IGNORE sprawia, że kolejne ticki (i restart z backfill)
 * nie duplikują wpisów. Epizody „jeszcze trwające" (ostatnia klatka świeższa
 * niż próg przerwy) są pomijane — dopisze je następny tick po domknięciu.
 * Epizod zaczynający się tuż przy krawędzi okna jest pomijany (może być
 * ucięty — jego prawdziwy początek, a więc i dedup_key, byłby inny).
 */

const MIN = 60_000

interface VisionFrame {
  id: number
  cameraDeviceId: string
  ts: number
  summary: string
  brandDetected: string | null
  anomalyType: string | null
  fallLikelihood: number | null
}

interface LprRead {
  id: number
  cameraDeviceId: string
  plate: string
  matched: number
  gateOpened: number
  direction: string | null
  ts: number
}

interface Episode<T> {
  items: T[]
  startTs: number
  endTs: number
}

/** Skleja posortowane rosnąco elementy w epizody: przerwa > gapMs = nowy. */
function episodes<T extends { ts: number }>(items: T[], gapMs: number): Array<Episode<T>> {
  const out: Array<Episode<T>> = []
  for (const it of items) {
    const last = out[out.length - 1]
    if (last && it.ts - last.endTs <= gapMs) {
      last.items.push(it)
      last.endTs = it.ts
    } else {
      out.push({ items: [it], startTs: it.ts, endTs: it.ts })
    }
  }
  return out
}

function summaryCounts(summary: string): Record<string, number> {
  try {
    const o = JSON.parse(summary)
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

function hhmm(ts: number): string {
  return new Date(ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
}

function isOutDirection(d: string | null): boolean {
  return d === 'out' || d === 'OUT' || d === 'reverse'
}

function brandLabel(brand: string): string {
  return brand.replace(/_/g, ' ')
}

@Injectable()
export class SituationCorrelatorService implements OnModuleInit {
  private readonly logger = new Logger(SituationCorrelatorService.name)
  private running = false
  private readonly disabled = process.env.SITUATION_CORRELATOR_DISABLED === 'true'

  constructor(
    private readonly store: StoreService,
    // VLM-detektyw (2026-09-01): pytania o kadr dowodowy + bramka upadków.
    private readonly vision: VisionDetectService,
  ) {}

  onModuleInit() {
    if (this.disabled) {
      this.logger.log('Situation correlator DISABLED (env)')
      return
    }
    // Bootstrap-backfill 24 h po starcie (walidacja reguł na realnych danych
    // + Kronika ma komplet dnia po restarcie). Pułapka #18: store.db żyje
    // dopiero po onModuleInit — dodatkowo 15 s zwłoki na ustabilizowanie.
    setTimeout(() => void this.tick(24 * 60 * MIN), 15_000)
    this.logger.log('Situation correlator ON (tick 60 s, bootstrap 24 h za 15 s)')
  }

  @Interval(60_000)
  async intervalTick(): Promise<void> {
    if (this.disabled) return
    await this.tick(2 * 60 * MIN)
  }

  private async tick(lookbackMs: number): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = Date.now()
      const since = now - lookbackMs
      const frames = this.store.situationVisionFrames(since)
      const reads = this.store.situationLprReads(since)

      let inserted = 0
      inserted += this.detectTailgating(reads)
      inserted += this.detectLoitering(reads, since, now)
      inserted += this.detectNightPerson(frames, since, now)
      inserted += this.detectVehicleWaiting(frames, reads, since, now)
      inserted += this.detectCourierVisits(frames, since, now)
      inserted += await this.detectFallConfirmed(frames, since, now)

      if (inserted > 0)
        this.logger.log(
          `situation tick: +${inserted} event(s) (frames=${frames.length}, reads=${reads.length}, lookback=${Math.round(lookbackMs / MIN)}min)`,
        )
    } catch (err: any) {
      this.logger.warn(`situation tick failed: ${err?.message}`)
    } finally {
      this.running = false
    }
  }

  // ── TAILGATING — para odczytów ≤20 s na jedno otwarcie ────────────────
  private detectTailgating(reads: LprRead[]): number {
    let inserted = 0
    const byCam = new Map<string, LprRead[]>()
    for (const r of reads) {
      const arr = byCam.get(r.cameraDeviceId) ?? []
      arr.push(r)
      byCam.set(r.cameraDeviceId, arr)
    }
    for (const [cam, list] of byCam) {
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1]
        const b = list[i]
        if (
          b.ts - a.ts <= 20_000 &&
          a.gateOpened === 1 &&
          b.gateOpened === 0 &&
          b.matched === 0 &&
          b.plate !== a.plate &&
          !isOutDirection(b.direction)
        ) {
          const sec = Math.max(1, Math.round((b.ts - a.ts) / 1000))
          const ok = this.store.situationInsert({
            type: 'TAILGATING',
            cameraDeviceId: cam,
            startedTs: b.ts,
            endedTs: b.ts,
            confidence: 'OBSERVED',
            title: `Przejazd „na ogonie": ${b.plate} przejechał ${sec} s za ${a.plate} na jedno otwarcie bramy (${hhmm(b.ts)})`,
            details: { plateOpened: a.plate, plateFollower: b.plate, deltaSec: sec },
            evidence: [
              { src: 'lpr', id: a.id },
              { src: 'lpr', id: b.id },
            ],
            dedupKey: `TAILGATE:${cam}:${b.id}`,
          })
          if (ok) inserted++
        }
      }
    }
    return inserted
  }

  // ── VEHICLE_LOITERING — nieznana tablica ≥3× w klastrze, zero wjazdów ─
  private detectLoitering(reads: LprRead[], since: number, now: number): number {
    let inserted = 0
    const byPlate = new Map<string, LprRead[]>()
    for (const r of reads) {
      if (r.matched !== 0) continue
      const arr = byPlate.get(r.plate) ?? []
      arr.push(r)
      byPlate.set(r.plate, arr)
    }
    for (const [plate, list] of byPlate) {
      // Klaster = odczyty z przerwami ≤20 min; ≥3 odczyty i żaden nie
      // otworzył bramy = pojazd krąży / czeka pod bramą.
      for (const ep of episodes(list, 20 * MIN)) {
        if (ep.items.length < 3) continue
        if (ep.items.some((r) => r.gateOpened === 1)) continue
        if (now - ep.endTs < 20 * MIN) continue // epizod może jeszcze trwać
        if (ep.startTs - since <= 20 * MIN) continue // krawędź okna — możliwe ucięcie
        const minutes = Math.max(1, Math.round((ep.endTs - ep.startTs) / MIN))
        const ok = this.store.situationInsert({
          type: 'VEHICLE_LOITERING',
          cameraDeviceId: ep.items[0].cameraDeviceId,
          startedTs: ep.startTs,
          endedTs: ep.endTs,
          confidence: 'OBSERVED',
          title: `Nieznany pojazd ${plate} pojawił się ${ep.items.length}× w ciągu ${minutes} min bez wjazdu (od ${hhmm(ep.startTs)})`,
          details: { plate, sightings: ep.items.length, minutes },
          evidence: ep.items.slice(0, 10).map((r) => ({ src: 'lpr', id: r.id })),
          dedupKey: `LOITER:${plate}:${Math.floor(ep.startTs / MIN)}`,
        })
        if (ok) inserted++
      }
    }
    return inserted
  }

  // ── NIGHT_PERSON — osoba w kadrze 23:00–05:00 ─────────────────────────
  private detectNightPerson(frames: VisionFrame[], since: number, now: number): number {
    let inserted = 0
    const GAP = 10 * MIN
    const byCam = new Map<string, VisionFrame[]>()
    for (const f of frames) {
      const h = new Date(f.ts).getHours()
      if (h < 23 && h >= 5) continue
      if ((summaryCounts(f.summary).person ?? 0) < 1) continue
      const arr = byCam.get(f.cameraDeviceId) ?? []
      arr.push(f)
      byCam.set(f.cameraDeviceId, arr)
    }
    for (const [cam, list] of byCam) {
      for (const ep of episodes(list, GAP)) {
        if (now - ep.endTs < GAP) continue // epizod jeszcze otwarty
        if (ep.startTs - since <= 2 * GAP) continue // możliwe ucięcie przy krawędzi okna
        const minutes = Math.round((ep.endTs - ep.startTs) / MIN)
        const durSuffix = minutes >= 2 ? ` (obecna ~${minutes} min)` : ''
        const ok = this.store.situationInsert({
          type: 'NIGHT_PERSON',
          cameraDeviceId: cam,
          startedTs: ep.startTs,
          endedTs: ep.endTs,
          confidence: 'OBSERVED',
          title: `Osoba na terenie w nocy o ${hhmm(ep.startTs)}${durSuffix}`,
          details: { frames: ep.items.length, minutes },
          evidence: ep.items.slice(0, 5).map((f) => ({ src: 'vision', id: f.id })),
          dedupKey: `NIGHT:${cam}:${Math.floor(ep.startTs / MIN)}`,
        })
        if (ok) inserted++
      }
    }
    return inserted
  }

  // ── VEHICLE_WAITING — pojazd ciągle w kadrze ≥8 min bez przejazdu ─────
  private detectVehicleWaiting(
    frames: VisionFrame[],
    reads: LprRead[],
    since: number,
    now: number,
  ): number {
    let inserted = 0
    const GAP = 3 * MIN
    const byCam = new Map<string, { vehicle: VisionFrame[]; all: VisionFrame[] }>()
    for (const f of frames) {
      const rec = byCam.get(f.cameraDeviceId) ?? { vehicle: [], all: [] }
      rec.all.push(f)
      const c = summaryCounts(f.summary)
      if ((c.car ?? 0) + (c.truck ?? 0) + (c.bus ?? 0) >= 1) rec.vehicle.push(f)
      byCam.set(f.cameraDeviceId, rec)
    }
    for (const [cam, rec] of byCam) {
      for (const ep of episodes(rec.vehicle, GAP)) {
        const minutes = (ep.endTs - ep.startTs) / MIN
        if (minutes < 8 || ep.items.length < 5) continue
        if (now - ep.endTs < GAP) continue // jeszcze trwa
        if (ep.startTs - since <= 10 * MIN) continue // krawędź okna — możliwe ucięcie
        // Przed epizodem ≥10 min bez pojazdu w kadrze (to NOWY przybysz,
        // nie stale zaparkowane tło).
        const before = rec.vehicle.some(
          (f) => f.ts < ep.startTs && f.ts >= ep.startTs - 10 * MIN,
        )
        if (before) continue
        // Żaden przejazd z otwarciem bramy na tej kamerze w trakcie epizodu.
        const gateOpen = reads.some(
          (r) =>
            r.cameraDeviceId === cam &&
            r.gateOpened === 1 &&
            r.ts >= ep.startTs &&
            r.ts <= ep.endTs,
        )
        if (gateOpen) continue
        const ok = this.store.situationInsert({
          type: 'VEHICLE_WAITING',
          cameraDeviceId: cam,
          startedTs: ep.startTs,
          endedTs: ep.endTs,
          confidence: 'INFERRED',
          title: `Pojazd stał w polu kamery ~${Math.round(minutes)} min bez przejazdu (od ${hhmm(ep.startTs)})`,
          details: { minutes: Math.round(minutes), frames: ep.items.length },
          evidence: ep.items.slice(0, 5).map((f) => ({ src: 'vision', id: f.id })),
          dedupKey: `WAIT:${cam}:${Math.floor(ep.startTs / MIN)}`,
        })
        if (ok) inserted++
      }
    }
    return inserted
  }

  // ── COURIER_VISIT — klatki z brandem sklejone w wizytę od–do ──────────
  private detectCourierVisits(frames: VisionFrame[], since: number, now: number): number {
    let inserted = 0
    const GAP = 12 * MIN
    const byBrand = new Map<string, VisionFrame[]>()
    for (const f of frames) {
      if (!f.brandDetected) continue
      const arr = byBrand.get(f.brandDetected) ?? []
      arr.push(f)
      byBrand.set(f.brandDetected, arr)
    }
    for (const [brand, list] of byBrand) {
      for (const ep of episodes(list, GAP)) {
        if (now - ep.endTs < GAP) continue // wizyta może jeszcze trwać
        if (ep.startTs - since <= 2 * GAP) continue // krawędź okna
        const label = brandLabel(brand)
        const range =
          ep.endTs - ep.startTs >= MIN
            ? `${hhmm(ep.startTs)}–${hhmm(ep.endTs)}`
            : hhmm(ep.startTs)
        const ok = this.store.situationInsert({
          type: 'COURIER_VISIT',
          cameraDeviceId: ep.items[0].cameraDeviceId,
          startedTs: ep.startTs,
          endedTs: ep.endTs,
          confidence: 'OBSERVED',
          title: `Wizyta ${label}: ${range}`,
          details: { brand, frames: ep.items.length },
          evidence: ep.items.slice(0, 5).map((f) => ({ src: 'vision', id: f.id })),
          dedupKey: `BRAND:${brand}:${Math.floor(ep.startTs / MIN)}`,
        })
        if (ok) inserted++
      }
    }
    return inserted
  }

  // ── FALL_CONFIRMED — ≥2 klatki FALL ≥0.5 w ≤3 min + bramka VLM ────────
  //
  // 2026-09-01: heurystyka pose daje false positives (schylanie się, cień,
  // wózek), więc przed alarmem pytamy VLM o kadr: „czy osoba faktycznie
  // leży?". Potwierdzenie → confidence OBSERVED + PUSH KRYTYCZNY do
  // mieszkańców (sąsiedzi to najszybsza pomoc na osiedlu bez obsługi).
  // Brak potwierdzenia / VLM niedostępny → zdarzenie zostaje w feedzie
  // jako INFERRED, ale BEZ pusha (cisza > fałszywy alarm o upadku).
  private async detectFallConfirmed(
    frames: VisionFrame[],
    since: number,
    now: number,
  ): Promise<number> {
    let inserted = 0
    const GAP = 3 * MIN
    const byCam = new Map<string, VisionFrame[]>()
    for (const f of frames) {
      if (f.anomalyType !== 'FALL' || (f.fallLikelihood ?? 0) < 0.5) continue
      const arr = byCam.get(f.cameraDeviceId) ?? []
      arr.push(f)
      byCam.set(f.cameraDeviceId, arr)
    }
    for (const [cam, list] of byCam) {
      for (const ep of episodes(list, GAP)) {
        if (ep.items.length < 2) continue // pojedyncza klatka = false positive
        if (now - ep.endTs < GAP) continue
        if (ep.startTs - since <= 2 * GAP) continue

        const evidence = ep.items.slice(0, 5).map((f) => ({ src: 'vision', id: f.id }))
        const image = await this.loadEvidenceImage(evidence)
        const vlm = image ? await this.vision.sceneQuestion(image, 'fall_confirm') : null
        const confirmed = vlm?.confirmed === true

        const id = this.store.situationInsert({
          type: 'FALL_CONFIRMED',
          cameraDeviceId: cam,
          startedTs: ep.startTs,
          endedTs: ep.endTs,
          confidence: confirmed ? 'OBSERVED' : 'INFERRED',
          title: `⚠️ Możliwy upadek osoby o ${hhmm(ep.startTs)} (${ep.items.length} ujęcia)`,
          details: {
            frames: ep.items.length,
            maxLikelihood: Math.max(...ep.items.map((f) => f.fallLikelihood ?? 0)),
            vlmConfirmed: vlm ? vlm.confirmed : null,
          },
          evidence,
          dedupKey: `FALL:${cam}:${Math.floor(ep.startTs / MIN)}`,
        })
        if (id == null) continue
        inserted++
        if (vlm?.answer) {
          this.store.situationSetVlmNote(
            id,
            confirmed ? vlm.answer : `VLM nie potwierdza upadku: ${vlm.answer}`,
          )
        }
        if (confirmed) {
          const sent = this.vision.emitSituationAlert({
            kind: 'FALL_CONFIRMED',
            title: '⚠️ Możliwy upadek osoby na osiedlu',
            body: `${hhmm(ep.startTs)} — ${vlm!.answer} Sprawdź okolicę lub podgląd kamer w aplikacji.`,
            ts: ep.startTs,
          })
          this.logger.warn(
            `FALL_CONFIRMED potwierdzony przez VLM (${hhmm(ep.startTs)}) — push ${sent ? 'wysłany' : 'NIE wysłany (tunel offline)'}`,
          )
        }
      }
    }
    return inserted
  }

  // ── VLM-detektyw — opis sceny dla zdarzeń z kadrem (2026-09-01) ───────
  //
  // Co 45 s dopisuje do świeżych zdarzeń NIGHT_PERSON / VEHICLE_WAITING
  // jedno zdanie z VLM „co widać na kadrze". Budżet 3 zdarzenia/tick —
  // qwen2.5vl liczy ~1-3 s/kadr, a Studio obsługuje też inne obiekty.
  private vlmBusy = false

  @Interval(45_000)
  async vlmDescribeTick(): Promise<void> {
    if (this.disabled || this.vlmBusy) return
    this.vlmBusy = true
    try {
      const pending = this.store.situationsNeedingVlm(
        ['NIGHT_PERSON', 'VEHICLE_WAITING'],
        Date.now() - 6 * 60 * MIN,
        3,
      )
      for (const ev of pending) {
        const evidence = safeEvidence(ev.evidenceJson)
        const image = await this.loadEvidenceImage(evidence)
        if (!image) {
          // Brak pliku (retencja / kamera bez zapisu) — oznacz, żeby nie
          // wracać do tego zdarzenia co tick.
          this.store.situationSetVlmNote(ev.id, '—')
          continue
        }
        const mode = ev.type === 'NIGHT_PERSON' ? 'night_person' : 'vehicle_waiting'
        const vlm = await this.vision.sceneQuestion(image, mode)
        if (!vlm?.answer) break // silnik AI leży — spróbujemy następnym tickiem
        this.store.situationSetVlmNote(ev.id, vlm.answer)
        this.logger.log(`VLM opis dla zdarzenia #${ev.id} (${ev.type}): ${vlm.answer.slice(0, 100)}`)
      }
    } catch (err: any) {
      this.logger.warn(`vlmDescribeTick failed: ${err?.message}`)
    } finally {
      this.vlmBusy = false
    }
  }

  /** Pierwszy kadr dowodowy zdarzenia jako Buffer (null gdy brak pliku). */
  private async loadEvidenceImage(
    evidence: Array<{ src: string; id: number }>,
  ): Promise<Buffer | null> {
    const visionId = evidence.find((e) => e.src === 'vision')?.id
    if (visionId == null) return null
    const imagePath = this.store.situationVisionImagePaths([visionId]).get(visionId)
    if (!imagePath) return null
    try {
      return await fsp.readFile(join(this.store.visionFramesDir(), imagePath))
    } catch {
      return null
    }
  }
}

function safeEvidence(json: string | null): Array<{ src: string; id: number }> {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
