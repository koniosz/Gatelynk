/**
 * TurnCredentialsService (Cloud) — generator krótkożyciowych credentiali TURN
 * (coturn `use-auth-secret` / TURN REST API). Projekt: docs/intercom-akuvox-call.md
 * (D7). Za flagą INTERCOM_CALL_ENABLED jak reszta funkcji domofonu.
 *
 * Mechanizm (coturn `use-auth-secret`, RFC draft uvalla "A REST API For Access
 * To TURN Services"):
 *   username = "<expiryUnix>:<residentId|sessionId>"
 *   password = base64( HMAC_SHA1( static_secret, username ) )
 *   ttl      = czas życia (s) — iOS dostaje go żeby wiedział kiedy odświeżyć.
 *
 * Secret bierzemy z env TURN_STATIC_SECRET (= `static-auth-secret` w
 * infra/intercom/coturn/turnserver.conf). `turnUrl` (per-budynek) z
 * BuildingIntercom.turnUrl — tym samym URL-em dostają creds iOS i Janus.
 *
 * Brak secretu / brak turnUrl → zwracamy SAM publiczny STUN (on-site / LAN
 * zestawi się bez TURN; off-site nie zadziała aż TURN będzie skonfigurowany).
 * Gdy coturn jest na `lt-cred-mech` (statyczne user/pass) — patrz docs: Cloud
 * NIE generuje HMAC, tylko podaje statyczne BuildingIntercom.turnUsername/Password
 * (obsłużone przez `staticTurnFromConfig`).
 */
import { Injectable, Logger } from '@nestjs/common'
import { createHmac } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service'

/** Pojedynczy ICE server w formacie zgodnym z RTCIceServer (iOS/WebRTC). */
export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

/** Pełna odpowiedź dla iOS — lista serwerów + TTL credentiali TURN. */
export interface IceServersResponse {
  iceServers: IceServer[]
  /** TTL (s) wygenerowanych TURN creds; 0 gdy brak TURN. iOS odświeża przed wygaśnięciem. */
  ttl: number
  /** Skąd wzięliśmy TURN: 'hmac' (use-auth-secret) | 'static' (lt-cred-mech) | 'none'. */
  turnSource: 'hmac' | 'static' | 'none'
}

@Injectable()
export class TurnCredentialsService {
  private readonly logger = new Logger(TurnCredentialsService.name)

  /** Domyślny TTL credentiali (s). 1h z zapasem na długie połączenia. */
  private static readonly DEFAULT_TTL_S = 3600

  /** Publiczny STUN — zawsze w odpowiedzi (darmowy fallback dla LAN/STUN). */
  private static readonly PUBLIC_STUN = 'stun:stun.l.google.com:19302'

  constructor(private readonly prisma: PrismaService) {}

  private get staticSecret(): string | undefined {
    const s = process.env.TURN_STATIC_SECRET
    return s && s.length > 0 ? s : undefined
  }

  /**
   * Zbuduj listę iceServers dla sesji. Najpierw STUN publiczny, potem (jeśli
   * skonfigurowano) TURN budynku z creds. `subject` identyfikuje allokację w
   * username (residentId albo sessionId) — coturn nie waliduje go, służy do
   * audytu po stronie TURN-a.
   */
  async iceServersForBuilding(buildingId: number, subject: string): Promise<IceServersResponse> {
    const iceServers: IceServer[] = [{ urls: [TurnCredentialsService.PUBLIC_STUN] }]

    const intercom = await this.prisma.$queryRaw<
      { turnUrl: string | null; turnUsername: string | null; turnPassword: string | null }[]
    >`
      SELECT "turnUrl", "turnUsername", "turnPassword"
        FROM "building_intercoms"
       WHERE "buildingId" = ${buildingId} AND "bridgeEnabled" = TRUE AND "turnUrl" IS NOT NULL
       ORDER BY id ASC
       LIMIT 1
    `
    const turnUrl = intercom[0]?.turnUrl ?? null

    if (!turnUrl) {
      this.logger.log(
        `iceServers [b#${buildingId}]: brak turnUrl/bridgeEnabled — tylko STUN (off-site nie zadziała)`,
      )
      return { iceServers, ttl: 0, turnSource: 'none' }
    }

    // Wariant HMAC (use-auth-secret): generujemy time-limited creds.
    if (this.staticSecret) {
      const ttl = TurnCredentialsService.DEFAULT_TTL_S
      const { username, password } = this.generateHmacCredentials(subject, ttl)
      iceServers.push({ urls: this.turnUrlVariants(turnUrl), username, credential: password })
      this.logger.log(`iceServers [b#${buildingId}]: TURN ${turnUrl} (hmac, ttl=${ttl}s)`)
      return { iceServers, ttl, turnSource: 'hmac' }
    }

    // Wariant statyczny (lt-cred-mech): podajemy zapisane user/pass z BuildingIntercom.
    const staticUser = intercom[0]?.turnUsername ?? null
    const staticPass = intercom[0]?.turnPassword ?? null
    if (staticUser && staticPass) {
      iceServers.push({ urls: this.turnUrlVariants(turnUrl), username: staticUser, credential: staticPass })
      this.logger.log(`iceServers [b#${buildingId}]: TURN ${turnUrl} (static lt-cred)`)
      return { iceServers, ttl: 0, turnSource: 'static' }
    }

    // turnUrl jest, ale brak i secretu HMAC i statycznych creds → tylko STUN.
    this.logger.warn(
      `iceServers [b#${buildingId}]: turnUrl ustawiony ale brak TURN_STATIC_SECRET ani statycznych creds — tylko STUN`,
    )
    return { iceServers, ttl: 0, turnSource: 'none' }
  }

  /**
   * Wygeneruj parę (username, password) wg coturn use-auth-secret.
   * username = "<expiryUnix>:<subject>", password = base64(HMAC-SHA1(secret, username)).
   * Eksportowane jako metoda żeby dało się przetestować bez DB.
   */
  generateHmacCredentials(subject: string, ttlSeconds: number): { username: string; password: string } {
    const secret = this.staticSecret
    if (!secret) throw new Error('TURN_STATIC_SECRET not set')
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds
    // subject sanityzujemy — bez ':' (rozdzielnik) i whitespace.
    const safeSubject = subject.replace(/[:\s]/g, '_')
    const username = `${expiry}:${safeSubject}`
    const password = createHmac('sha1', secret).update(username).digest('base64')
    return { username, password }
  }

  /**
   * Z `turn:host:3478` rób też wariant transport=udp/tcp (libwebrtc i tak je
   * negocjuje, ale jawne wpisy pomagają niektórym NAT-om). Jeśli URL już ma
   * `?transport=` — zostaw jak jest.
   */
  private turnUrlVariants(turnUrl: string): string[] {
    if (turnUrl.includes('?transport=')) return [turnUrl]
    return [`${turnUrl}?transport=udp`, `${turnUrl}?transport=tcp`]
  }
}
