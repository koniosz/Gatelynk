import { forwardRef, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Interval } from '@nestjs/schedule'
import { createHash, randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { requestWithDigest } from '../http-digest'
import { matchPlates, voteAcrossFrames } from './plate-matcher'
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
}

/**
 * Ile klatek na jeden przejazd.
 *
 * Tablica jest czytelna tylko przez moment: przy podjeździe auto najpierw
 * jest za daleko, a chwilę później za blisko (maska wypełnia kadr, tablica
 * wypada poza obiektyw — widać to na materiale z VN). Seria musi objąć to
 * wąskie okno, więc rozciągamy ją na ~2,5 s zamiast 1 s.
 *
 * Koszt jest niewielki: odczyt jednej klatki to ~110 ms na akceleratorze,
 * a serię i tak przetwarzamy po przejeździe, nie w czasie rzeczywistym.
 */
const FRAMES_PER_PASS = 5
/** Odstęp między klatkami: auto ma się przesunąć, ale nie zdążyć wyjechać z kadru. */
const FRAME_INTERVAL_MS = 500
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
    if (type !== 'vehicledetection' || state !== 'active') return

    const st = this.streams.get(cameraDeviceId)
    if (!st || st.busy) return
    const now = Date.now()
    if (now - st.lastEventAt < PASS_DEBOUNCE_MS) return
    st.lastEventAt = now
    st.busy = true

    void this.readPlateForPass(cameraDeviceId)
      .catch((e) => this.logger.warn(`[${cameraDeviceId}] odczyt tablicy nieudany: ${e?.message ?? e}`))
      .finally(() => { st.busy = false })
  }

  /** Pobiera klatki, czyta tablicę i oddaje wynik do zwykłej ścieżki LPR. */
  private async readPlateForPass(cameraDeviceId: string) {
    if (!nativeOcr.isAvailable()) {
      this.logger.warn(
        `[${cameraDeviceId}] brak natywnego czytnika OCR — zbuduj: ` +
        `swiftc -O -o native/gatelynk-ocr native/gatelynk-ocr.swift`,
      )
      return
    }

    const frames = await this.grabFrames(cameraDeviceId, FRAMES_PER_PASS)
    if (!frames.length) {
      this.logger.debug(`[${cameraDeviceId}] pojazd wykryty, ale nie udało się pobrać klatek`)
      return
    }

    const tmpFiles: string[] = []
    try {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gatelynk-anpr-'))
      for (const buf of frames) {
        const f = path.join(dir, `${randomBytes(4).toString('hex')}.jpg`)
        await fs.writeFile(f, buf)
        tmpFiles.push(f)
      }

      const ocr = await nativeOcr.readText(tmpFiles)
      const perFrame = ocr.perFile.map((pairs) => matchPlates(pairs))
      const { best, agreedFrames, candidates } = voteAcrossFrames(perFrame)

      // Marka z burty (DPD, InPost, Frisco…) — z TEGO SAMEGO tekstu OCR, więc
      // bez dodatkowego kosztu. Napis firmowy jest wielokrotnie większy niż
      // tablica, więc bywa czytelny nawet wtedy, gdy tablicy nie da się odczytać.
      // Marka z NAJLEPSZEJ klatki, czytanej kafelkowo. Zwykły przebieg po całym
      // kadrze gubi logo kuriera: pomiar na obiekcie VN (2026-08-09, DPD) —
      // „dpd" na masce było wyraźnie widoczne, a mimo to nieodczytane, dopóki
      // nie podzieliliśmy kadru na kafelki. Robimy to RAZ na przejazd, nie na
      // każdej z pięciu klatek, żeby nie mnożyć kosztu.
      let brand = matchBrand(ocr.perFile.flat())
      if (!brand && tmpFiles.length) {
        const bestIdx = best ? this.bestFrameFor(best.plate, perFrame, frames.length) : 0
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
        this.logger.debug(`[${cameraDeviceId}] pojazd wykryty, tablicy nie odczytano (${ocr.ms} ms)`)
        return
      }

      // 2026-09-15: odczyty niepotwierdzone NIE giną — po 8 s trafiają do
      // `handleUncertainRead` (rejestr: dopasowanie łagodne → „prawdopodobny",
      // inaczej wpis „niepotwierdzony"). Bramy to nie otwiera.
      if (agreedFrames < MIN_AGREED_FRAMES) {
        this.logger.log(
          `[${cameraDeviceId}] odczyt z jednej klatki: ${best.plate} ` +
          `(pewność ${best.confidence.toFixed(2)}) — za mało potwierdzeń, wstrzymany jako niepotwierdzony`,
        )
        this.scheduleUncertain(cameraDeviceId, best, agreedFrames, candidates, {
          image: frames[this.bestFrameFor(best.plate, perFrame, frames.length)],
          vehicleBrand: brand?.brand,
        })
        return
      }

      if (best.confidence < MIN_CONFIDENCE) {
        this.logger.log(
          `[${cameraDeviceId}] odczyt poniżej progu: ${best.plate} ` +
          `(pewność ${best.confidence.toFixed(2)}, ${agreedFrames}/${frames.length} klatek) — wstrzymany jako niepotwierdzony`,
        )
        this.scheduleUncertain(cameraDeviceId, best, agreedFrames, candidates, {
          image: frames[this.bestFrameFor(best.plate, perFrame, frames.length)],
          vehicleBrand: brand?.brand,
        })
        return
      }

      this.logger.log(
        `[${cameraDeviceId}] 🚗 tablica ${best.plate} ` +
        `(pewność ${best.confidence.toFixed(2)}, zgodnych klatek ${agreedFrames}/${frames.length}, ${ocr.ms} ms)`,
      )

      // Pewny odczyt unieważnia wstrzymany niepotwierdzony z tej kamery.
      this.cancelUncertain(cameraDeviceId)

      await this.host?.handleAnprEvent(cameraDeviceId, best.plate, {
        confidence: best.confidence,
        image: frames[this.bestFrameFor(best.plate, perFrame, frames.length)],
        vehicleBrand: brand?.brand,
        source: 'edge-ocr',
        ocrEngine: ocr.engine,
        agreedFrames,
        candidates: candidates.map((c) => `${c.plate}:${c.confidence.toFixed(2)}`),
      })
    } finally {
      await Promise.all(tmpFiles.map((f) => fs.unlink(f).catch(() => {})))
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
  ): number {
    let bestIdx = -1
    let bestConf = -1
    perFrame.forEach((candidates, idx) => {
      const hit = candidates.find((c) => c.plate === plate)
      if (hit && hit.confidence > bestConf) {
        bestConf = hit.confidence
        bestIdx = idx
      }
    })
    // Gdyby (teoretycznie) żadna klatka nie zawierała zwycięskiej tablicy —
    // np. po zmianie logiki głosowania — wracamy do ostatniej klatki.
    return bestIdx >= 0 ? bestIdx : Math.max(0, frameCount - 1)
  }

  /** Kilka zrzutów pod rząd — materiał do głosowania między klatkami. */
  private async grabFrames(cameraDeviceId: string, count: number): Promise<Buffer[]> {
    const cfg = this.host?.getConfig(cameraDeviceId)
    if (!cfg) return []
    const port = cfg.httpPort ? `:${cfg.httpPort}` : ''
    const user = cfg.rtspLogin ?? cfg.login ?? 'admin'
    const urls = [
      `http://${cfg.ipAddress}${port}/ISAPI/Streaming/channels/101/picture`,
      `http://${cfg.ipAddress}${port}/ISAPI/Streaming/channels/1/picture`,
    ]

    const out: Buffer[] = []
    for (let i = 0; i < count; i++) {
      for (const url of urls) {
        try {
          const res = await requestWithDigest('GET', url, user, cfg.password, {
            responseType: 'arraybuffer',
            timeout: 4000,
            validateStatus: (s: number) => s === 200,
          })
          const buf = Buffer.from(res.data as ArrayBuffer)
          // Sanity: prawdziwy JPEG i sensowny rozmiar (odsiewa strony błędów).
          if (buf.length > 5_000 && buf[0] === 0xff && buf[1] === 0xd8) {
            out.push(buf)
            break
          }
        } catch { /* następny URL / następna klatka */ }
      }
      if (i < count - 1) await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS))
    }
    return out
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
