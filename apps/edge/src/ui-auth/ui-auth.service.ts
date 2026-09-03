import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { StoreService } from '../store/store.service'
import { EventLogService } from '../event-log/event-log.service'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/**
 * PR-2 (2026-07) — PIN/hasło do Edge UI (P0 bezpieczeństwo).
 *
 * Problem: Edge HTTP :4000 nie miał ŻADNEJ autoryzacji — każdy w LAN mógł
 * otwierać bramy i kasować urządzenia z przeglądarki. Ten serwis trzyma:
 *   • hash PIN-u (scrypt) w Edge sqlite KV store (`ui.pinHash`) — KV jest
 *     szyfrowane AES-256-GCM kluczem maszynowym, więc hash nie leży plaintext
 *   • sesje przeglądarkowe in-memory (token → expiry, TTL 8 h) — restart Edge
 *     wylogowuje wszystkich (świadomy trade-off, brak nowej tabeli)
 *   • rate-limit prób logowania (10 nieudanych / 15 min per IP)
 *
 * Kill-switch: env `EDGE_UI_AUTH_ENABLED=false` przywraca stare zachowanie
 * (brak autoryzacji). Default = włączone.
 *
 * Awaryjny reset PIN-u (instalator zapomniał):
 *   1. env `EDGE_UI_PIN_RESET=1` przy starcie procesu, ALBO
 *   2. plik `<dataDir>/reset-ui-pin` (obok store.db) — Edge przy starcie
 *      kasuje hash i usuwa plik. Wymaga SSH/fizycznego dostępu do maszyny,
 *      czyli wyższego poziomu zaufania niż sam LAN.
 *
 * Pułapka #18 (CLAUDE.md): StoreService.db jest gotowy dopiero w
 * onModuleInit — dlatego reset-check żyje w onModuleInit, nie w konstruktorze.
 */

const PIN_HASH_KEY = 'ui.pinHash'
const SESSION_TTL_MS = 8 * 60 * 60 * 1000 // 8 h
const MAX_SESSIONS = 50
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000
const LOGIN_FAIL_LIMIT = 10

const SCRYPT_KEYLEN = 32

@Injectable()
export class UiAuthService implements OnModuleInit {
  private readonly logger = new Logger(UiAuthService.name)

  /** token → absolute expiry (epoch ms) */
  private readonly sessions = new Map<string, number>()
  /** ip → timestamps nieudanych logowań */
  private readonly loginFails = new Map<string, number[]>()

  constructor(
    private store: StoreService,
    private config: ConfigService,
    private eventLog: EventLogService,
  ) {}

  onModuleInit() {
    // ── Awaryjny reset PIN-u ────────────────────────────────────────────
    const envReset = process.env.EDGE_UI_PIN_RESET
    if (envReset && envReset !== '0' && envReset.toLowerCase() !== 'false') {
      this.clearPin()
      this.logger.warn('EDGE_UI_PIN_RESET set — PIN Edge UI został skasowany (ustaw nowy przy pierwszym wejściu)')
      this.eventLog.warn('SYSTEM', 'PIN Edge UI zresetowany przez env EDGE_UI_PIN_RESET')
    }
    try {
      const resetFile = path.join(path.dirname(this.config.get<string>('storePath') ?? './data/store.db'), 'reset-ui-pin')
      if (fs.existsSync(resetFile)) {
        this.clearPin()
        fs.unlinkSync(resetFile)
        this.logger.warn(`Plik ${resetFile} znaleziony — PIN Edge UI skasowany, plik usunięty`)
        this.eventLog.warn('SYSTEM', 'PIN Edge UI zresetowany przez plik reset-ui-pin')
      }
    } catch (err: any) {
      this.logger.warn(`Reset-file check failed: ${err.message}`)
    }

    if (!this.isEnabled()) {
      this.logger.warn('EDGE_UI_AUTH_ENABLED=false — autoryzacja Edge UI WYŁĄCZONA (kill-switch)')
    } else if (!this.isPinSet()) {
      this.logger.warn('Edge UI: PIN nie jest ustawiony — panel działa w trybie bootstrap (bez logowania). Ustaw PIN w /auth/login.')
    }
  }

  // ── Konfiguracja ───────────────────────────────────────────────────────────
  /** Kill-switch: default WŁĄCZONE; `EDGE_UI_AUTH_ENABLED=false|0` wyłącza. */
  isEnabled(): boolean {
    const v = (process.env.EDGE_UI_AUTH_ENABLED ?? 'true').toLowerCase()
    return v !== 'false' && v !== '0'
  }

  isPinSet(): boolean {
    return !!this.store.get(PIN_HASH_KEY)
  }

  // ── PIN ─────────────────────────────────────────────────────────────────────
  /** Waliduje i zapisuje nowy PIN (min. 4, max 64 znaki, bez whitespace). */
  setPin(pin: string): void {
    const trimmed = (pin ?? '').trim()
    if (trimmed.length < 4 || trimmed.length > 64) {
      throw new Error('PIN musi mieć od 4 do 64 znaków')
    }
    const salt = crypto.randomBytes(16)
    const hash = crypto.scryptSync(trimmed, salt, SCRYPT_KEYLEN)
    this.store.set(PIN_HASH_KEY, `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`)
    // Zmiana PIN-u unieważnia wszystkie sesje (poza tą która zaraz powstanie)
    this.sessions.clear()
    this.eventLog.info('SYSTEM', 'PIN Edge UI ustawiony/zmieniony')
  }

  clearPin(): void {
    this.store.delete(PIN_HASH_KEY)
    this.sessions.clear()
  }

  verifyPin(pin: string): boolean {
    const stored = this.store.get(PIN_HASH_KEY)
    if (!stored) return false
    const [scheme, saltHex, hashHex] = stored.split('$')
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
    const expected = Buffer.from(hashHex, 'hex')
    const actual = crypto.scryptSync((pin ?? '').trim(), Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN)
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  }

  // ── Logowanie / sesje ───────────────────────────────────────────────────────
  /**
   * Próba logowania. Zwraca token sesji albo null (zły PIN).
   * Rzuca Error('THROTTLED') gdy IP przekroczyło limit nieudanych prób.
   */
  login(pin: string, ip: string): string | null {
    const fails = this.pruneFails(ip)
    if (fails.length >= LOGIN_FAIL_LIMIT) {
      this.logger.warn(`Edge UI login throttled — ip=${ip} (${fails.length} nieudanych prób w 15 min)`)
      throw new Error('THROTTLED')
    }

    if (!this.verifyPin(pin)) {
      fails.push(Date.now())
      this.loginFails.set(ip, fails)
      this.eventLog.warn('SYSTEM', `Nieudane logowanie do Edge UI (ip=${ip})`)
      return null
    }

    this.loginFails.delete(ip)
    const token = crypto.randomBytes(32).toString('base64url')
    // Cap liczby sesji — najstarsza wypada (Map iteruje w insertion order)
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest) this.sessions.delete(oldest)
    }
    this.sessions.set(token, Date.now() + SESSION_TTL_MS)
    this.eventLog.info('SYSTEM', `Zalogowano do Edge UI (ip=${ip})`)
    return token
  }

  validateSession(token: string | undefined | null): boolean {
    if (!token) return false
    const expiry = this.sessions.get(token)
    if (!expiry) return false
    if (Date.now() > expiry) {
      this.sessions.delete(token)
      return false
    }
    return true
  }

  logout(token: string | undefined | null): void {
    if (token) this.sessions.delete(token)
  }

  sessionTtlMs(): number {
    return SESSION_TTL_MS
  }

  private pruneFails(ip: string): number[] {
    const cutoff = Date.now() - LOGIN_FAIL_WINDOW_MS
    const arr = (this.loginFails.get(ip) ?? []).filter((t) => t >= cutoff)
    if (arr.length === 0) this.loginFails.delete(ip)
    else this.loginFails.set(ip, arr)
    return arr
  }
}
