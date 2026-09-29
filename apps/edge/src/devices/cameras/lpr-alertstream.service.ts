import { forwardRef, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { createHash, randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { requestWithDigest } from '../http-digest'
import { matchPlates } from './plate-matcher'
import { PassAccumulator, type PassCandidate } from './lpr-pass'
import { matchBrand } from './brand-matcher'
import * as nativeOcr from './native-ocr'
import { HikvisionLprService } from './hikvision-lpr.service'

/**
 * Odczyt tablic dla kamer, które NIE oddają ich własnym API.
 *
 * Powód istnienia (VN, 2026-08-05): Hikvision DS-2CD4A26FWD-IZS/P
 * (DeepinView 4A, fw V5.4.5) rozpoznaje tablice wyłącznie na własny użytek —
 * porównuje z listą w pamięci i zwiera swój przekaźnik. Na zewnątrz wysyła
 * jedynie gołe zdarzenie „wykryto pojazd", bez numeru. Dane ANPR wychodzą
 * tylko przez zamknięte SDK producenta, a linia jest wycofana z produkcji
 * (potwierdzone w dokumentacji integracyjnej Hikvision).
 *
 * Rozwiązanie: kamera daje WYZWALACZ, my dajemy ODCZYT.
 *
 *   1. Trzymamy otwarty strumień zdarzeń kamery (`/ISAPI/Event/notification/
 *      alertStream`) — to kamera pcha do nas, my tylko słuchamy.
 *   2. Na `vehicledetection` pobieramy kilka zrzutów pod rząd.
 *   3. Czytamy tablicę lokalnie (natywny Vision na ANE — patrz `native-ocr`).
 *   4. Głosujemy między klatkami i oddajemy wynik do zwykłej ścieżki
 *      `handleAnprEvent`, więc dalej wygląda to identycznie jak odczyt
 *      z kamery natywnej (ten sam zapis, ten sam podgląd, ten sam sync).
 *
 * Celowo NIE zależymy od Mac Studio: cała ścieżka działa na Edge, więc
 * odczyt przeżyje awarię tunelu (zasada offline-first platformy).
 *
 * ⚠️ Świadome ograniczenie: nie dorównamy dedykowanej kamerze ANPR w nocy,
 * przy dużej prędkości i brudnej tablicy — ona ma migawkę i doświetlenie IR
 * zsynchronizowane pod tablicę, my pracujemy na zwykłej klatce. Dlatego
 * KAŻDY odczyt niesie `confidence`, a decyzję o progu podejmuje warstwa wyżej.
 */

interface StreamState {
  req?: http.ClientRequest
  stopped: boolean
  retryMs: number
  lastEventAt: number
  busy: boolean
  /** Ostatni JAKIKOLWIEK bajt ze strumienia (heartbeat też) — dla watchdoga. */
  lastDataAt: number
  /** Kiedy zaplanowano ostatni retry — watchdog nie dubluje żywego retry. */
  retryAt: number
  /** Ostatnia seria zakończona DECYZJĄ (otwarcie / wpis) — po niej 8 s ciszy. */
  lastDecisionAt: number
  /** Koniec ostatniej serii (dowolny wynik). */
  lastPassEndAt: number
  /** Start ostatniej serii wyzwolonej ruchem (VMD) — ruch bez auta nie może mielić OCR bez końca. */
  lastMotionPassAt: number
  /** Kolejne serie bez decyzji — po kilku wymuszamy ciszę (auto stoi w polu bez czytelnej tablicy). */
  failStreak: number
}

/**
 * Seria klatek (2026-09-29): klatki lecą BEZ przerw (pobranie z kamery trwa
 * ~200 ms, więc ~4–5 klatek/s), każda jest czytana od razu po pobraniu,
 * a decyzja zapada w trakcie — patrz `lpr-pass.ts`. Dawniej: 5 klatek co 500 ms
 * i wspólny OCR na końcu = ~3,7 s do decyzji, a tablica czytelna tylko na 2 z 5.
 */
const MAX_PASS_MS = 3_500
const MAX_FRAMES_PER_PASS = 14
/** Minimalna przerwa między pobraniami — auto ma się przesunąć choć trochę. */
const MIN_FRAME_GAP_MS = 60
/** Ile klatek może być czytanych równolegle (ANE + spawn procesu). */
const MAX_OCR_IN_FLIGHT = 2
/** Po serii bez decyzji kolejne zdarzenie może zacząć nową serię już po tej przerwie. */
const RETRY_GAP_MS = 300
/** Serie z ruchu (VMD, przed „vehicledetection") nie częściej niż co tyle. */
const MOTION_PASS_MIN_GAP_MS = 2_500
/** Tyle serii bez decyzji z rzędu → 8 s ciszy (auto stoi w polu, tablicy nie widać). */
const MAX_FAIL_STREAK = 4
/**
 * Jedno auto wyzwala serię zdarzeń (kamera raportuje je co ~sekundę, dopóki
 * pojazd jest w polu). Bez tego progu OCR-owalibyśmy ten sam samochód
 * kilkanaście razy i zaśmiecili historię.
 */
const PASS_DEBOUNCE_MS = 8_000
/** Poniżej tego progu odczyt trafia do logu jako niepewny, ale NIE do dopasowania. */
const MIN_CONFIDENCE = 0.55
/**
 * Ile klatek musi zgodnie wskazać tę samą tablicę.
 *
 * To najmocniejszy dostępny sygnał poprawności — mocniejszy niż pewność
 * samego OCR. Pomiar na VN (2026-08-07): odczyt potwierdzony zdjęciem miał
 * zgodność 3/3, a odczyt z kadru, na którym tablicy w ogóle nie widać —
 * tylko 1/3 i 2/3. Pojedyncza klatka to zbyt słaba podstawa, żeby wpisać
 * tablicę do historii wjazdów.
 */
const MIN_AGREED_FRAMES = 2

const RETRY_MIN_MS = 3_000
const RETRY_MAX_MS = 60_000

type LprHost = {
  getDeviceIds(): string[]
  getConfig(cameraDeviceId: string): any | undefined
  handleAnprEvent(
    cameraDeviceId: string,
    plate: string,
    extra?: Record<string, any>,
  ): Promise<any>
  /** 2026-09-15 — odczyt niepotwierdzony (1 klatka / poniżej progu). */
  handleUncertainRead?(
    cameraDeviceId: string,
    plate: string,
    extra: Record<string, any>,
  ): Promise<any>
  /** 2026-09-29 — tablica z rejestru kamery (ścisłe/OCR-fuzzy) dla decyzji w trakcie serii. */
  resolveWhitelistPlate?(cameraDeviceId: string, plate: string): string | null
}

/**
 * Niepotwierdzony odczyt czeka tyle, zanim trafi do `handleUncertainRead` —
 * jeśli w tym czasie ta sama kamera da PEWNY odczyt (drugi alert tego samego
 * przejazdu), niepotwierdzony jest anulowany zamiast dublować wpis.
 */
const UNCERTAIN_HOLD_MS = 8_000

@Injectable()
export class LprAlertStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LprAlertStreamService.name)
  private readonly streams = new Map<string, StreamState>()
  private host?: LprHost
  /** Wstrzymane niepotwierdzone odczyty per kamera (patrz UNCERTAIN_HOLD_MS). */
  private readonly pendingUncertain = new Map<string, NodeJS.Timeout>()

  /**
   * Zależność jest JEDNOKIERUNKOWA: my znamy serwis LPR, on nas nie —
   * dostaje referencję setterem (`setAlertStream`). Dzięki temu nie ma cyklu
   * modułowego, na który Nest reaguje `UnknownDependenciesException`
   * (pułapka #8 w CLAUDE.md).
   */
  constructor(
    @Inject(forwardRef(() => HikvisionLprService))
    private readonly lpr: HikvisionLprService,
  ) {}

  onModuleInit() {
    this.setHost(this.lpr as unknown as LprHost)
    this.lpr.setAlertStream(this)
  }

  setHost(host: LprHost) {
    this.host = host
  }

  /** Włącza nasłuch dla kamery. Idempotentne — ponowne wywołanie nie duplikuje. */
  start(cameraDeviceId: string) {
    if (this.streams.get(cameraDeviceId)?.stopped === false) return
    this.streams.set(cameraDeviceId, {
      stopped: false, retryMs: RETRY_MIN_MS, lastEventAt: 0, busy: false,
      lastDataAt: Date.now(), retryAt: 0,
      lastDecisionAt: 0, lastPassEndAt: 0, lastMotionPassAt: 0, failStreak: 0,
    })
    this.connect(cameraDeviceId)
  }

  stop(cameraDeviceId: string) {
    const st = this.streams.get(cameraDeviceId)
    if (!st) return
    st.stopped = true
    try { st.req?.destroy() } catch { /* już zamknięty */ }
    this.streams.delete(cameraDeviceId)
  }

  onModuleDestroy() {
    for (const id of [...this.streams.keys()]) this.stop(id)
    for (const id of [...this.pendingUncertain.keys()]) this.cancelUncertain(id)
  }

  // ── Połączenie ze strumieniem ───────────────────────────────────────────

  private connect(cameraDeviceId: string) {
    const st = this.streams.get(cameraDeviceId)
    const cfg = this.host?.getConfig(cameraDeviceId)
    if (!st || st.stopped || !cfg) return

    const port = cfg.httpPort || 80
    const pathUrl = '/ISAPI/Event/notification/alertStream'
    const user = cfg.rtspLogin ?? cfg.login ?? 'admin'
    const pass = cfg.password ?? ''

    // Strumień jest długożyjący, więc digest robimy ręcznie: najpierw
    // wyzwalamy 401 po to, by wyciągnąć challenge, potem otwieramy właściwe,
    // nieprzerwane połączenie. Zwykły klient HTTP tego nie utrzyma.
    const challenge = http.request(
      { host: cfg.ipAddress, port, path: pathUrl, method: 'GET' },
      (res) => {
        const wwwAuth = String(res.headers['www-authenticate'] ?? '')
        res.resume()
        if (res.statusCode !== 401 || !wwwAuth) {
          this.logger.warn(`[${cameraDeviceId}] alertStream: brak challenge (HTTP ${res.statusCode})`)
          return this.scheduleRetry(cameraDeviceId)
        }
        this.openStream(cameraDeviceId, cfg, pathUrl, user, pass, wwwAuth)
      },
    )
    challenge.on('error', (e) => {
      this.logger.warn(`[${cameraDeviceId}] alertStream niedostępny: ${e.message}`)
      this.scheduleRetry(cameraDeviceId)
    })
    // INCYDENT 2026-08-29 (VN): destroy() BEZ argumentu nie emituje 'error',
    // więc timeout challenge'a (LAN w trakcie restartu = SYN w czarną dziurę)
    // zabijał połączenie PO CICHU — bez scheduleRetry stream był martwy na
    // zawsze, a start() (idempotentny po `stopped:false`) już go nie wskrzesił.
    // 2 dni zero odczytów ANPR. destroy(err) → handler 'error' → retry.
    challenge.setTimeout(8000, () => challenge.destroy(new Error('challenge timeout (8s)')))
    challenge.end()
  }

  private openStream(
    cameraDeviceId: string, cfg: any, pathUrl: string,
    user: string, pass: string, wwwAuth: string,
  ) {
    const st = this.streams.get(cameraDeviceId)
    if (!st || st.stopped) return

    const auth = this.buildDigest(wwwAuth, 'GET', pathUrl, user, pass)
    const req = http.request(
      {
        host: cfg.ipAddress, port: cfg.httpPort || 80, path: pathUrl,
        method: 'GET', headers: { Authorization: auth },
      },
      (res) => {
        if (res.statusCode !== 200) {
          this.logger.warn(`[${cameraDeviceId}] alertStream HTTP ${res.statusCode}`)
          res.resume()
          return this.scheduleRetry(cameraDeviceId)
        }
        this.logger.log(`[${cameraDeviceId}] nasłuch zdarzeń kamery aktywny (odczyt tablic lokalnie)`)
        st.retryMs = RETRY_MIN_MS   // udane połączenie zeruje narastanie

        st.lastDataAt = Date.now()
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          st.lastDataAt = Date.now()
          buffer += chunk
          // Strumień to sklejone bloki XML. Tniemy po zamknięciu bloku, a
          // bufor przycinamy, żeby nie puchł przy długim działaniu.
          let idx: number
          while ((idx = buffer.indexOf('</EventNotificationAlert>')) !== -1) {
            const block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + '</EventNotificationAlert>'.length)
            this.onEventBlock(cameraDeviceId, block)
          }
          if (buffer.length > 64_000) buffer = buffer.slice(-8_000)
        })
        res.on('end', () => this.scheduleRetry(cameraDeviceId))
        res.on('error', () => this.scheduleRetry(cameraDeviceId))
      },
    )
    req.on('error', (e) => {
      this.logger.warn(`[${cameraDeviceId}] alertStream zerwany: ${e.message}`)
      this.scheduleRetry(cameraDeviceId)
    })
    req.end()
    st.req = req
  }

  private scheduleRetry(cameraDeviceId: string) {
    const st = this.streams.get(cameraDeviceId)
    if (!st || st.stopped) return
    const delay = st.retryMs
    st.retryMs = Math.min(RETRY_MAX_MS, Math.round(st.retryMs * 1.8))
    st.retryAt = Date.now()
    setTimeout(() => this.connect(cameraDeviceId), delay).unref?.()
  }

  /**
   * Watchdog (2026-08-31, incydent VN): strumień może umrzeć bez 'error' ani
   * 'end' (kamera restartuje bez zamknięcia TCP, cichy destroy) — wtedy żaden
   * handler nie zaplanuje retry. Hikvision śle w alertStreamie ciągły
   * heartbeat (videoloss co kilka sekund), więc 3 minuty CISZY = martwe
   * połączenie. destroy(err) przechodzi ścieżką 'error' → scheduleRetry;
   * gdy nie ma nawet requestu i retry dawno przepadł — connect() wprost.
   */
  @Interval(60_000)
  watchdog() {
    const now = Date.now()
    for (const [id, st] of this.streams) {
      if (st.stopped) continue
      if (now - st.lastDataAt < 180_000) continue
      const silentSec = Math.round((now - st.lastDataAt) / 1000)
      if (st.req && !st.req.destroyed) {
        this.logger.warn(`[${id}] alertStream: cisza ${silentSec}s — wymuszam reconnect`)
        st.lastDataAt = now // nie strzelaj co minutę, daj reconnectowi czas
        try { st.req.destroy(new Error('watchdog: brak heartbeatu 3 min')) } catch { /* noop */ }
      } else if (now - st.retryAt > 120_000) {
        this.logger.warn(`[${id}] alertStream: brak połączenia i retry (cisza ${silentSec}s) — wymuszam connect`)
        st.lastDataAt = now
        st.retryMs = RETRY_MIN_MS
        this.connect(id)
      }
    }
  }

  // ── Reakcja na zdarzenie ────────────────────────────────────────────────

  private onEventBlock(cameraDeviceId: string, block: string) {
    const type = block.match(/<eventType>([^<]*)</i)?.[1]?.toLowerCase()
    const state = block.match(/<eventState>([^<]*)</i)?.[1]?.toLowerCase()
    if (state !== 'active') return
    // 2026-09-29: RUCH (VMD) jako wczesny wyzwalacz. Kamera zgłasza
    // „vehicledetection" dopiero, gdy auto wjedzie w jej strefę ANPR — na VN
    // tablica bywała czytelna ~3 s wcześniej (widział ją próbkujący VisionDetect).
    // Detekcja ruchu jest włączona na kamerach wjazd/wyjazd; jeśli kamera nie
    // wysyła VMD w alertStream, nic się nie zmienia.
    const trigger = type === 'vehicledetection' ? 'vehicle' : type === 'vmd' ? 'motion' : null
    if (!trigger) return

    const st = this.streams.get(cameraDeviceId)
    if (!st || st.busy) return
    const now = Date.now()
    // Po serii ZAKOŃCZONEJ DECYZJĄ (otwarcie/wpis) — 8 s ciszy, jak dotąd
    // (kamera raportuje to samo auto co ~1 s). Po serii BEZ decyzji — krótka
    // przerwa i kolejna próba: auto podjeżdża, tablica robi się czytelna.
    if (now - st.lastDecisionAt < PASS_DEBOUNCE_MS) return
    if (now - st.lastPassEndAt < RETRY_GAP_MS) return
    if (trigger === 'motion' && now - st.lastMotionPassAt < MOTION_PASS_MIN_GAP_MS) return
    st.lastEventAt = now
    if (trigger === 'motion') st.lastMotionPassAt = now
    st.busy = true

    void this.readPlateForPass(cameraDeviceId, trigger)
      .then((outcome) => {
        st.lastPassEndAt = Date.now()
        if (outcome === 'decided') {
          st.lastDecisionAt = Date.now()
          st.failStreak = 0
        } else if (++st.failStreak >= MAX_FAIL_STREAK) {
          st.lastDecisionAt = Date.now()   // cisza, jak po decyzji
          st.failStreak = 0
        }
      })
      .catch((e) => {
        st.lastPassEndAt = Date.now()
        this.logger.warn(`[${cameraDeviceId}] odczyt tablicy nieudany: ${e?.message ?? e}`)
      })
      .finally(() => { st.busy = false })
  }

  /**
   * Seria klatek z decyzją W TRAKCIE (2026-09-29).
   *
   * Pętla: pobierz klatkę → od razu OCR (równolegle z pobieraniem następnej)
   * → dołóż głosy → jeśli JEDNA tablica z rejestru ma już dwie zgodne klatki
   * (albo jedną bardzo pewną) → otwieraj natychmiast, nie czekając na resztę.
   * Bez decyzji do końca okna → dawne reguły (≥2 zgodne klatki i próg pewności
   * → wpis; inaczej odczyt niepotwierdzony po 8 s).
   *
   * Zwraca 'decided' (otwarcie lub wpis do historii) albo 'none' — od tego
   * zależy, czy kolejne zdarzenie kamery może od razu zacząć nową serię.
   */
  private async readPlateForPass(
    cameraDeviceId: string,
    trigger: 'vehicle' | 'motion',
  ): Promise<'decided' | 'none'> {
    if (!nativeOcr.isAvailable()) {
      this.logger.warn(
        `[${cameraDeviceId}] brak natywnego czytnika OCR — zbuduj: ` +
        `swiftc -O -o native/gatelynk-ocr native/gatelynk-ocr.swift`,
      )
      return 'none'
    }

    const t0 = Date.now()
    const acc = new PassAccumulator()
    const resolve = (p: string) => this.host?.resolveWhitelistPlate?.(cameraDeviceId, p) ?? null
    const frames: Buffer[] = []
    const perFrame: PassCandidate[][] = []
    const perFrameText: Array<Array<[string, number]>> = []
    const tmpFiles: string[] = []
    const inFlight = new Set<Promise<void>>()
    let ocrMs = 0
    let engine = 'apple-vision'
    let decision: ReturnType<PassAccumulator['earlyDecision']> = null
    let decidedAtFrame = -1
    let fetchFails = 0

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gatelynk-anpr-'))
    try {
      const deadline = t0 + MAX_PASS_MS
      while (!decision && frames.length < MAX_FRAMES_PER_PASS && Date.now() < deadline) {
        const fetchedAt = Date.now()
        const buf = await this.grabFrame(cameraDeviceId)
        if (!buf) {
          if (++fetchFails >= 3 && frames.length === 0) break
          await new Promise((r) => setTimeout(r, 200))
          continue
        }
        const idx = frames.length
        frames.push(buf)
        const file = path.join(dir, `${idx}-${randomBytes(3).toString('hex')}.jpg`)
        await fs.writeFile(file, buf)
        tmpFiles.push(file)

        const task = nativeOcr.readText([file], 6_000).then((ocr) => {
          ocrMs += ocr.ms
          engine = ocr.engine
          perFrameText[idx] = ocr.perFile[0] ?? []
          const cands = matchPlates(perFrameText[idx])
          perFrame[idx] = cands
          acc.add(idx, cands, resolve)
          if (!decision) {
            decision = acc.earlyDecision()
            if (decision) decidedAtFrame = idx
          }
        }).finally(() => { inFlight.delete(task) })
        inFlight.add(task)
        // Nie więcej niż 2 odczyty naraz — kolejna klatka czeka na wolny slot.
        if (inFlight.size >= MAX_OCR_IN_FLIGHT) await Promise.race(inFlight)

        const gap = MIN_FRAME_GAP_MS - (Date.now() - fetchedAt)
        if (gap > 0 && !decision) await new Promise((r) => setTimeout(r, gap))
      }
      await Promise.all(inFlight)
      if (!decision) {
        decision = acc.earlyDecision()
        if (decision) decidedAtFrame = frames.length - 1
      }

      if (!frames.length) {
        this.logger.debug(`[${cameraDeviceId}] pojazd wykryty, ale nie udało się pobrać klatek`)
        return 'none'
      }

      // Marka z burty (DPD, InPost, Frisco…) — z TEGO SAMEGO tekstu OCR, bez
      // dodatkowego kosztu. Kosztowny przebieg kafelkowy TYLKO, gdy nie ma
      // otwarcia z rejestru (kurierzy nie są w rejestrze) — nie opóźnia bramy.
      let brand = matchBrand(perFrameText.flat())
      const elapsed = () => Date.now() - t0

      if (decision) {
        const bestIdx = this.bestFrameFor(decision.plate, perFrame, frames.length, resolve)
        this.logger.log(
          `[${cameraDeviceId}] 🚗 tablica ${decision.plate} ` +
          `(pewność ${decision.confidence.toFixed(2)}, zgodnych klatek ${decision.frames}/${frames.length}, ` +
          `decyzja po ${elapsed()} ms od zdarzenia [${trigger}], klatka ${decidedAtFrame + 1}, OCR ${ocrMs} ms)`,
        )
        this.cancelUncertain(cameraDeviceId)
        await this.host?.handleAnprEvent(cameraDeviceId, decision.plate, {
          confidence: decision.confidence,
          image: frames[bestIdx],
          vehicleBrand: brand?.brand,
          source: 'edge-ocr',
          ocrEngine: engine,
          agreedFrames: decision.frames,
          candidates: acc.final().candidates.map((c) => `${c.plate}:${c.confidence.toFixed(2)}`),
          trigger,
          decisionMs: elapsed(),
          framesTotal: frames.length,
        })
        return 'decided'
      }

      const { best, agreedFrames, candidates } = acc.final()
      if (!brand && best && tmpFiles.length) {
        const bestIdx = this.bestFrameFor(best.plate, perFrame, frames.length, resolve)
        const tiled = await nativeOcr.readText([tmpFiles[bestIdx]], 20_000, { tiles: true })
        brand = matchBrand(tiled.perFile.flat())
      }
      if (brand) {
        this.logger.log(
          `[${cameraDeviceId}] 📦 rozpoznano markę: ${brand.brand} ` +
          `(z napisu „${brand.matchedText.slice(0, 40)}")`,
        )
      }

      if (!best) {
        this.logger.debug(`[${cameraDeviceId}] pojazd wykryty [${trigger}], tablicy nie odczytano (${frames.length} klatek, ${elapsed()} ms)`)
        return 'none'
      }

      const image = frames[this.bestFrameFor(best.plate, perFrame, frames.length, resolve)]
      // 2026-09-15: odczyty niepotwierdzone NIE giną — po 8 s trafiają do
      // `handleUncertainRead` (rejestr: dopasowanie łagodne → „prawdopodobny",
      // inaczej wpis „niepotwierdzony"). Bramy to nie otwiera.
      if (agreedFrames < MIN_AGREED_FRAMES) {
        this.logger.log(
          `[${cameraDeviceId}] odczyt z jednej klatki: ${best.plate} ` +
          `(pewność ${best.confidence.toFixed(2)}, ${frames.length} klatek, ${elapsed()} ms) — za mało potwierdzeń, wstrzymany jako niepotwierdzony`,
        )
        this.scheduleUncertain(cameraDeviceId, best, agreedFrames, candidates, { image, vehicleBrand: brand?.brand })
        return 'none'
      }
      if (best.confidence < MIN_CONFIDENCE) {
        this.logger.log(
          `[${cameraDeviceId}] odczyt poniżej progu: ${best.plate} ` +
          `(pewność ${best.confidence.toFixed(2)}, ${agreedFrames}/${frames.length} klatek) — wstrzymany jako niepotwierdzony`,
        )
        this.scheduleUncertain(cameraDeviceId, best, agreedFrames, candidates, { image, vehicleBrand: brand?.brand })
        return 'none'
      }

      this.logger.log(
        `[${cameraDeviceId}] 🚗 tablica ${best.plate} ` +
        `(pewność ${best.confidence.toFixed(2)}, zgodnych klatek ${agreedFrames}/${frames.length}, ${elapsed()} ms, OCR ${ocrMs} ms)`,
      )
      this.cancelUncertain(cameraDeviceId)
      await this.host?.handleAnprEvent(cameraDeviceId, best.plate, {
        confidence: best.confidence,
        image,
        vehicleBrand: brand?.brand,
        source: 'edge-ocr',
        ocrEngine: engine,
        agreedFrames,
        candidates: candidates.map((c) => `${c.plate}:${c.confidence.toFixed(2)}`),
        trigger,
        decisionMs: elapsed(),
        framesTotal: frames.length,
      })
      return 'decided'
    } finally {
      await Promise.all(tmpFiles.map((f) => fs.unlink(f).catch(() => {})))
      await fs.rmdir(dir).catch(() => {})
    }
  }

  /** Wstrzymuje niepotwierdzony odczyt; poprzedni wstrzymany z tej kamery zastępuje. */
  private scheduleUncertain(
    cameraDeviceId: string,
    best: { plate: string; confidence: number },
    agreedFrames: number,
    candidates: Array<{ plate: string; confidence: number }>,
    extra: { image?: Buffer | null; vehicleBrand?: string },
  ) {
    if (!this.host?.handleUncertainRead) return
    this.cancelUncertain(cameraDeviceId)
    const timer = setTimeout(() => {
      this.pendingUncertain.delete(cameraDeviceId)
      this.host?.handleUncertainRead?.(cameraDeviceId, best.plate, {
        confidence: best.confidence,
        agreedFrames,
        candidates: candidates.map((c) => c.plate),
        image: extra.image ?? null,
        vehicleBrand: extra.vehicleBrand,
        source: 'edge-ocr',
      }).catch((e: any) => this.logger.warn(`[${cameraDeviceId}] niepotwierdzony odczyt nieobsłużony: ${e?.message ?? e}`))
    }, UNCERTAIN_HOLD_MS)
    this.pendingUncertain.set(cameraDeviceId, timer)
  }

  private cancelUncertain(cameraDeviceId: string) {
    const t = this.pendingUncertain.get(cameraDeviceId)
    if (t) {
      clearTimeout(t)
      this.pendingUncertain.delete(cameraDeviceId)
    }
  }

  /**
   * Która klatka ma trafić do historii jako dowód odczytu.
   *
   * Zgłoszenie Konrada (2026-08-07): przy odczycie zapisywała się OSTATNIA
   * klatka serii — czyli auto najbliżej kamery. W praktyce oznaczało to
   * maskę albo błotnik zamiast tablicy, bo pojazd zdążył podjechać za blisko
   * albo wysunąć się poza kadr. Operator dostawał wpis „WU2355N" ze zdjęciem,
   * na którym tablicy w ogóle nie widać — bezużyteczny do weryfikacji.
   *
   * Wybieramy więc klatkę, z której tablicę FAKTYCZNIE odczytano, z najwyższą
   * pewnością. To z definicji ujęcie, na którym tablica jest widoczna i ostra —
   * dokładnie takie, jakiego oczekuje człowiek sprawdzający wpis.
   */
  private bestFrameFor(
    plate: string,
    perFrame: Array<Array<{ plate: string; confidence: number }>>,
    frameCount: number,
    resolve?: (p: string) => string | null,
  ): number {
    let bestIdx = -1
    let bestConf = -1
    perFrame.forEach((candidates, idx) => {
      if (!candidates) return
      const hit = candidates.find((c) => c.plate === plate || (resolve && resolve(c.plate) === plate))
      if (hit && hit.confidence > bestConf) {
        bestConf = hit.confidence
        bestIdx = idx
      }
    })
    // Gdyby (teoretycznie) żadna klatka nie zawierała zwycięskiej tablicy —
    // np. po zmianie logiki głosowania — wracamy do ostatniej klatki.
    return bestIdx >= 0 ? bestIdx : Math.max(0, frameCount - 1)
  }

  /** Jeden zrzut z kamery (ISAPI picture, ~200 ms) — materiał do serii. */
  private async grabFrame(cameraDeviceId: string): Promise<Buffer | null> {
    const cfg = this.host?.getConfig(cameraDeviceId)
    if (!cfg) return null
    const port = cfg.httpPort ? `:${cfg.httpPort}` : ''
    const user = cfg.rtspLogin ?? cfg.login ?? 'admin'
    const urls = [
      `http://${cfg.ipAddress}${port}/ISAPI/Streaming/channels/101/picture`,
      `http://${cfg.ipAddress}${port}/ISAPI/Streaming/channels/1/picture`,
    ]
    for (const url of urls) {
      try {
        const res = await requestWithDigest('GET', url, user, cfg.password, {
          responseType: 'arraybuffer',
          timeout: 3000,
          validateStatus: (s: number) => s === 200,
        })
        const buf = Buffer.from(res.data as ArrayBuffer)
        // Sanity: prawdziwy JPEG i sensowny rozmiar (odsiewa strony błędów).
        if (buf.length > 5_000 && buf[0] === 0xff && buf[1] === 0xd8) return buf
      } catch { /* następny URL */ }
    }
    return null
  }

  // ── Digest dla długożyjącego strumienia ─────────────────────────────────

  private buildDigest(
    wwwAuth: string, method: string, uri: string, username: string, password: string,
  ): string {
    const md5 = (s: string) => createHash('md5').update(s).digest('hex')
    const get = (k: string) => wwwAuth.match(new RegExp(`${k}="?([^",]+)"?`))?.[1] ?? ''
    const realm = get('realm')
    const nonce = get('nonce')
    const qop = get('qop').split(',')[0]?.trim()
    const opaque = get('opaque')
    const cnonce = randomBytes(8).toString('hex')
    const nc = '00000001'

    const ha1 = md5(`${username}:${realm}:${password}`)
    const ha2 = md5(`${method}:${uri}`)
    const response = qop
      ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : md5(`${ha1}:${nonce}:${ha2}`)

    const parts = [
      `username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`,
      `uri="${uri}"`, `response="${response}"`,
    ]
    if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
    if (opaque) parts.push(`opaque="${opaque}"`)
    return 'Digest ' + parts.join(', ')
  }
}
