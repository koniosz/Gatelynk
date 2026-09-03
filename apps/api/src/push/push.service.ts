import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

// apn is loaded dynamically so the app starts even without the package installed
// Install with: npm install apn && npm install --save-dev @types/apn
let apn: any = null
try {
  apn = require('apn')
} catch {
  // will warn in onModuleInit
}

type Env = 'production' | 'development'

/// Okno throttle dla powiadomień „gość skorzystał z wejścia" (2026-07-15) —
/// wspólne dla ścieżek PIN / LPR / Guest Portal (klucz `guest-use-<id>`).
export const GUEST_USE_PUSH_THROTTLE_MS = 5 * 60_000

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name)
  // Trzymamy ZAWSZE dwóch providerów (production + sandbox) bo:
  //  - Build z Xcode (debug, kabel USB, TestFlight w stanie internal-testing)
  //    ma `aps-environment=development` w entitlements → device dostaje
  //    sandbox token → akceptowany tylko przez api.sandbox.push.apple.com
  //  - Release / App Store ma `aps-environment=production` → token akcepto-
  //    wany tylko przez api.push.apple.com
  // Kiedyś wybieraliśmy provider per-NODE_ENV co dawało mismatch i 100% pushy
  // wracało jako BadDeviceToken, a kod kasował tokeny → push w ogóle nie szedł.
  // Każdy zapisany token niesie kolumnę `environment` ustawianą przez iOS przy
  // rejestracji, a `send()` routuje per-token do odpowiedniego providera.
  private prodProvider: any = null
  private sandboxProvider: any = null
  private bundleId: string | null = null

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (!apn) {
      this.logger.warn('apn package not installed — push notifications disabled. Run: npm install apn')
      return
    }

    const keyId    = process.env.APN_KEY_ID
    const teamId   = process.env.APN_TEAM_ID
    const keyPath  = process.env.APN_KEY_PATH   // path to .p8 file  OR
    const keyData  = process.env.APN_KEY         // raw .p8 content
    this.bundleId  = process.env.APN_BUNDLE_ID ?? null

    if (!keyId || !teamId || (!keyPath && !keyData) || !this.bundleId) {
      this.logger.warn(
        'APNs env vars not set (APN_KEY_ID, APN_TEAM_ID, APN_KEY_PATH or APN_KEY, APN_BUNDLE_ID) — push disabled',
      )
      return
    }

    const tokenCfg = {
      key:    keyData ?? keyPath,
      keyId,
      teamId,
    }

    this.prodProvider    = new apn.Provider({ token: tokenCfg, production: true  })
    this.sandboxProvider = new apn.Provider({ token: tokenCfg, production: false })

    this.logger.log('APNs providers ready (production + sandbox)')
  }

  // ── Public API ────────────────────────────────────────────────────────────

  // UWAGA: poniżej używamy `$queryRaw` / `$executeRaw` zamiast Prisma client
  // API. Powód: w monorepo `prisma generate` sypie się ("Cannot convert
  // undefined or null to object") więc typy klienta nie wiedzą o nowej
  // kolumnie `environment` — patrz CLAUDE.md, sekcja "Znany problem z Prismą".
  // Raw SQL omija problem i jest typesafe przez generic argument.

  /** Send to a single resident (all their devices) */
  async sendToResident(residentId: number, title: string, body: string, data?: Record<string, unknown>) {
    if (!this.prodProvider) return
    // Pobieramy razem tokeny + nazwę budynku w jednym round-tripie. Nazwa idzie
    // jako APNs `title`, a oryginalny `title` ląduje w `subtitle` — patrz
    // sendBatch. Mieszkaniec wie z którego budynku/obiektu (Villa Natura,
    // Chłodna itp.) dostaje powiadomienie bez patrzenia w treść.
    const rows = await this.prisma.$queryRaw<
      { token: string; environment: string; bundleId: string | null; buildingName: string }[]
    >`
      SELECT pt.token, pt.environment, pt."bundleId", b.name AS "buildingName"
      FROM push_tokens pt
      JOIN residents r  ON r.id  = pt."residentId"
      JOIN buildings b  ON b.id  = r."buildingId"
      WHERE pt."residentId" = ${residentId}
    `
    if (!rows.length) return
    // Wszystkie urządzenia mieszkańca są w tym samym budynku — bierzemy z
    // pierwszego rzędu.
    await this.send(rows, rows[0].buildingName, title, body, data)
  }

  // ── Throttled push (2026-07-15) ─────────────────────────────────────────
  //
  // Powiadomienia „gość skorzystał z wejścia" idą przy KAŻDYM użyciu, ale
  // wspólny klucz per gość (guest-use-<id>) + okno czasowe chronią przed
  // zalewem duplikatów: LPR łapiący tablicę na 2 kamerach, gość cofający
  // przez bramę, PIN + tablica milisekundy po sobie. In-memory per instancja
  // API (Fly: 1 machine) — po restarcie okno startuje od zera, co najwyżej
  // jeden push „za dużo".
  private readonly throttleLast = new Map<string, number>()

  async sendToResidentThrottled(
    throttleKey: string,
    minIntervalMs: number,
    residentId: number,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ) {
    const now = Date.now()
    const last = this.throttleLast.get(throttleKey) ?? 0
    if (now - last < minIntervalMs) {
      this.logger.debug(`Throttled push '${throttleKey}' (${now - last}ms < ${minIntervalMs}ms)`)
      return
    }
    this.throttleLast.set(throttleKey, now)
    // Sprzątanie starych wpisów — mapa nie rośnie bez końca.
    if (this.throttleLast.size > 5000) {
      for (const [k, t] of this.throttleLast) {
        if (now - t > 3_600_000) this.throttleLast.delete(k)
      }
    }
    await this.sendToResident(residentId, title, body, data)
  }

  /** Send to all residents in a building */
  async sendToBuilding(buildingId: number, title: string, body: string, data?: Record<string, unknown>) {
    if (!this.prodProvider) return
    const building = await this.prisma.$queryRaw<{ name: string }[]>`
      SELECT name FROM buildings WHERE id = ${buildingId} LIMIT 1
    `
    const buildingName = building[0]?.name ?? ''
    const rows = await this.prisma.$queryRaw<
      { token: string; environment: string; bundleId: string | null }[]
    >`
      SELECT pt.token, pt.environment, pt."bundleId"
      FROM push_tokens pt
      JOIN residents r ON r.id = pt."residentId"
      WHERE r."buildingId" = ${buildingId}
    `
    if (!rows.length) return
    await this.send(rows, buildingName, title, body, data)
  }

  /**
   * Register / update a device token for a resident.
   *
   * `environment` mówi nam czy token został wystawiony przez Apple sandbox
   * (Xcode debug / dev build) czy production (App Store / TestFlight). To samo
   * urządzenie po przejściu z dev → release dostaje NOWY token, więc upsert po
   * `token` zadziała poprawnie (stary zostanie unregistered z iOS).
   */
  async registerToken(
    residentId: number,
    token: string,
    environment: Env = 'production',
    bundleId?: string | null,
  ) {
    // bundleId (2026-07-15): apka wysyła swój Bundle.main.bundleIdentifier —
    // GateLynk / Glass / Gamma mają różne bundle, a topic APNs musi się
    // zgadzać z bundlem tokenu. COALESCE zachowuje wcześniej zapisany bundle,
    // gdyby starsza wersja apki wysłała body bez pola.
    await this.prisma.$executeRaw`
      INSERT INTO push_tokens ("residentId", token, environment, "bundleId")
      VALUES (${residentId}, ${token}, ${environment}, ${bundleId ?? null})
      ON CONFLICT (token) DO UPDATE
        SET "residentId" = EXCLUDED."residentId",
            environment  = EXCLUDED.environment,
            "bundleId"   = COALESCE(EXCLUDED."bundleId", push_tokens."bundleId")
    `
    return { residentId, token, environment, bundleId: bundleId ?? null }
  }

  /** Unregister a device token (on logout) */
  async unregisterToken(token: string) {
    await this.prisma.$executeRaw`DELETE FROM push_tokens WHERE token = ${token}`
  }

  // ── VoIP push (PushKit) — domofon-połączenia ────────────────────────────────
  //
  // 2026-06-13 — docs/intercom-akuvox-call.md. Za flagą INTERCOM_CALL_ENABLED.
  // VoIP push to OSOBNY kanał od zwykłego alert-push:
  //   • osobny token (iOS PKPushRegistry typ .voip) — zapisywany z kind='voip'
  //   • osobny topic APNs = <bundleId>.voip  (note.topic)
  //   • apns-push-type: voip                 (note.pushType)
  // Ten sam Auth Key (.p8) działa dla obu kanałów — różnica jest w topicu i
  // push-type. iOS MUSI po odebraniu VoIP push natychmiast zgłosić CallKit
  // (wymóg Apple od iOS 13), inaczej system ubije apkę i zablokuje VoIP push.

  /** Register / update a VoIP (PushKit) token for a resident. */
  async registerVoipToken(
    residentId: number,
    token: string,
    environment: Env = 'production',
    bundleId?: string | null,
  ) {
    await this.prisma.$executeRaw`
      INSERT INTO push_tokens ("residentId", token, environment, kind, "bundleId")
      VALUES (${residentId}, ${token}, ${environment}, 'voip', ${bundleId ?? null})
      ON CONFLICT (token) DO UPDATE
        SET "residentId" = EXCLUDED."residentId",
            environment  = EXCLUDED.environment,
            kind         = 'voip',
            "bundleId"   = COALESCE(EXCLUDED."bundleId", push_tokens."bundleId")
    `
    return { residentId, token, environment, kind: 'voip' as const }
  }

  /**
   * Wyślij VoIP push do mieszkańca (wszystkie jego urządzenia z tokenem voip).
   *
   * `data` MUSI zawierać `sessionId` (IntercomCallSession.id) — iOS używa go do
   * dociągnięcia szczegółów połączenia i zestawienia WebRTC. CallKit pokazuje
   * `callerName`/`unitLabel` z payloadu zanim apka dociągnie resztę.
   *
   * TODO (Faza C): zweryfikować na sprzęcie że:
   *   - provisioning profile ma Push Notifications + (PushKit) capability,
   *   - APN_BUNDLE_ID + '.voip' jest poprawnym topikiem (= App ID),
   *   - note.pushType='voip' jest akceptowany przez używaną wersję `apn`.
   */
  async sendVoipToResident(residentId: number, data: Record<string, unknown>) {
    if (process.env.INTERCOM_CALL_ENABLED !== 'true') return
    if (!this.prodProvider) {
      this.logger.warn('sendVoipToResident: APNs provider not configured — skip')
      return
    }
    const rows = await this.prisma.$queryRaw<
      { token: string; environment: string; bundleId: string | null }[]
    >`
      SELECT token, environment, "bundleId"
        FROM push_tokens
       WHERE "residentId" = ${residentId} AND kind = 'voip'
    `
    if (!rows.length) {
      this.logger.warn(`sendVoipToResident(${residentId}): brak voip tokenów`)
      return
    }
    // Grupowanie po (env, bundle) — jak w send(); topic VoIP = <bundle>.voip.
    const groups = new Map<string, { env: Env; topic: string; tokens: string[] }>()
    for (const r of rows) {
      const env: Env = r.environment === 'development' ? 'development' : 'production'
      const topic = r.bundleId || this.bundleId
      if (!topic) continue
      const key = `${env}|${topic}`
      const g = groups.get(key) ?? { env, topic, tokens: [] }
      g.tokens.push(r.token)
      groups.set(key, g)
    }
    await Promise.all(
      [...groups.values()].map((g) =>
        this.sendVoipBatch(
          g.env === 'development' ? this.sandboxProvider : this.prodProvider,
          g.tokens, g.topic, data, g.env,
        ),
      ),
    )
  }

  private async sendVoipBatch(
    provider: any,
    tokens: string[],
    topic: string,
    data: Record<string, unknown>,
    env: Env,
  ) {
    if (!provider || !tokens.length || !apn) return
    const note = new apn.Notification()
    // VoIP push: brak alert/sound/badge — payload jest data-only, iOS budzi
    // PKPushRegistry i sam zgłasza CallKit.
    note.topic = `${topic}.voip`
    // `apn` ustawia push-type przez `pushType`; gdy wersja pakietu tego nie
    // wspiera, fallback do nagłówka. Oba bezpieczne.
    ;(note as any).pushType = 'voip'
    note.expiry = 0 // VoIP push nie powinien być kolejkowany — dostarcz albo porzuć
    note.payload = data
    try {
      const result = await provider.send(note, tokens)
      if (result.failed?.length) {
        this.logger.warn(`VoIP[${env}] failed tokens: ${JSON.stringify(result.failed)}`)
        const invalidTokens: string[] = result.failed
          .filter((f: any) => f.response?.reason === 'BadDeviceToken' || f.response?.reason === 'Unregistered')
          .map((f: any) => f.device)
        if (invalidTokens.length) {
          await this.prisma.$executeRaw`
            DELETE FROM push_tokens WHERE token = ANY(${invalidTokens}::text[])
          `
          this.logger.log(`Removed ${invalidTokens.length} invalid VoIP token(s) from ${env}`)
        }
      }
    } catch (err) {
      this.logger.error(`VoIP[${env}] send error`, err)
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async send(
    rows: { token: string; environment: string; bundleId?: string | null }[],
    buildingName: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ) {
    // Grupujemy tokeny po (environment, topic) — środowisko wybiera provider
    // (prod vs sandbox endpoint APNs), a topic MUSI się zgadzać z bundlem
    // apki, która wystawiła token (2026-07-15: GateLynk / Glass / Gamma to
    // różne bundle — jeden globalny topic gubił pushe dla pozostałych apek).
    // bundleId NULL (legacy token) → fallback do env APN_BUNDLE_ID.
    const groups = new Map<string, { env: Env; topic: string; tokens: string[] }>()
    for (const r of rows) {
      const env: Env = r.environment === 'development' ? 'development' : 'production'
      const topic = r.bundleId || this.bundleId
      if (!topic) continue
      const key = `${env}|${topic}`
      const g = groups.get(key) ?? { env, topic, tokens: [] }
      g.tokens.push(r.token)
      groups.set(key, g)
    }

    await Promise.all(
      [...groups.values()].map((g) =>
        this.sendBatch(
          g.env === 'development' ? this.sandboxProvider : this.prodProvider,
          g.tokens, g.topic, buildingName, title, body, data, g.env,
        ),
      ),
    )
  }

  private async sendBatch(
    provider: any,
    tokens: string[],
    topic: string,
    buildingName: string,
    title: string,
    body: string,
    data: Record<string, unknown> | undefined,
    env: Env,
  ) {
    if (!provider || !tokens.length) return

    const note = new apn.Notification()
    note.expiry = Math.floor(Date.now() / 1000) + 3600 // 1h TTL
    note.badge = 1
    note.sound = 'default'
    // Layout APNs alert na lock screenie iOS:
    //   GateLynk           ← app name (auto)
    //   Villa Natura       ← title       (nazwa budynku)
    //   🔔 Awaria windy    ← subtitle    (oryginalny title z call-site)
    //   Wymagana wymiana…  ← body
    // Jeśli buildingName jest pusty (edge case — np. budynek bez nazwy),
    // wracamy do prostego layoutu title+body żeby nie pokazać pustej linii.
    note.alert = buildingName
      ? { title: buildingName, subtitle: title, body }
      : { title, body }
    note.topic = topic
    if (data) note.payload = data
    // Zdjęcie w powiadomieniu (2026-08-12): mutable-content budzi
    // Notification Service Extension w iOS, które pobiera `imageUrl`
    // i dokleja obraz. Bez rozszerzenia w apce flaga jest neutralna.
    if ((data as any)?.imageUrl) note.mutableContent = 1

    try {
      const result = await provider.send(note, tokens)
      if (result.failed?.length) {
        this.logger.warn(`APNs[${env}] failed tokens: ${JSON.stringify(result.failed)}`)
        // Remove invalid tokens (BadDeviceToken, Unregistered).
        // Uwaga: BadDeviceToken NIE oznacza już automatycznie wrong-environment
        // (od momentu wprowadzenia per-token routingu) — to faktycznie zły
        // token. Bezpiecznie kasujemy.
        const invalidTokens: string[] = result.failed
          .filter((f: any) => f.response?.reason === 'BadDeviceToken' || f.response?.reason === 'Unregistered')
          .map((f: any) => f.device)
        if (invalidTokens.length) {
          // Raw SQL — zob. komentarz przy `sendToResident` (typy Prisma client
          // pre-generate nie znają nowych pól).
          await this.prisma.$executeRaw`
            DELETE FROM push_tokens WHERE token = ANY(${invalidTokens}::text[])
          `
          this.logger.log(`Removed ${invalidTokens.length} invalid APNs token(s) from ${env}`)
        }
      }
    } catch (err) {
      this.logger.error(`APNs[${env}] send error`, err)
    }
  }
}
