/**
 * Jednorazowe podpisane nonce'y strony Guest Pass (2026-07-08, Nuki UNIT_DOOR).
 *
 * Format nonce'a: `g<guestId>.a<apId>.<expMs>.<sig>` gdzie
 *   sig = HMAC-SHA256(sekret, `g<guestId>.a<apId>.<expMs>`) hex (pełne 64 znaki).
 *
 * Właściwości:
 *   • stateless weryfikacja (podpis + TTL) — bez lookupu w DB,
 *   • jednorazowość przez tabelę `guest_open_nonces`: konsumpcja = atomowy
 *     INSERT unique(nonceHash) ON CONFLICT DO NOTHING (dokładnie jeden
 *     z równoległych requestów wygrywa — patrz GuestPortalService.consumeNonce),
 *   • nonce jest związany z (guestId, apId) — nie da się użyć nonce'a z innego
 *     zaproszenia/wejścia,
 *   • TTL 5 min — strona odświeża nonce przy każdym renderze (SSR) oraz
 *     dostaje świeży `nextNonce` w odpowiedzi na udane otwarcie.
 *
 * Sekret: `GUEST_NONCE_SECRET` env, fallback `JWT_SECRET` (żeby nie wymagać
 * nowego secreta na Fly od razu), ostateczny fallback dev-owy.
 */
import * as crypto from 'crypto'

export const GUEST_NONCE_TTL_MS = 5 * 60_000

function nonceSecret(): string {
  return (
    process.env.GUEST_NONCE_SECRET ||
    process.env.JWT_SECRET ||
    'dev-guest-nonce-secret-CHANGE-ME'
  )
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', nonceSecret()).update(payload).digest('hex')
}

/** Wystawia nowy nonce dla pary (guestId, apId). */
export function issueGuestOpenNonce(
  guestId: number,
  accessPointId: number,
  ttlMs: number = GUEST_NONCE_TTL_MS,
): string {
  const exp = Date.now() + ttlMs
  const payload = `g${guestId}.a${accessPointId}.${exp}`
  return `${payload}.${sign(payload)}`
}

export type NonceVerifyResult =
  | { ok: true; expMs: number }
  | { ok: false; reason: 'MALFORMED' | 'MISMATCH' | 'EXPIRED' | 'BAD_SIGNATURE' }

/** Weryfikuje podpis + TTL + związanie z (guestId, apId). NIE konsumuje. */
export function verifyGuestOpenNonce(
  nonce: unknown,
  guestId: number,
  accessPointId: number,
): NonceVerifyResult {
  if (typeof nonce !== 'string' || nonce.length > 200) return { ok: false, reason: 'MALFORMED' }
  const m = /^g(\d+)\.a(\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(nonce.trim())
  if (!m) return { ok: false, reason: 'MALFORMED' }
  const [, gid, aid, expStr, sig] = m
  if (Number(gid) !== guestId || Number(aid) !== accessPointId) {
    return { ok: false, reason: 'MISMATCH' }
  }
  const payload = `g${gid}.a${aid}.${expStr}`
  const expected = sign(payload)
  // timingSafeEqual wymaga równych długości — regex już to gwarantuje (64 hex).
  const sigOk = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
  if (!sigOk) return { ok: false, reason: 'BAD_SIGNATURE' }
  const expMs = Number(expStr)
  if (!Number.isFinite(expMs) || expMs <= Date.now()) return { ok: false, reason: 'EXPIRED' }
  return { ok: true, expMs }
}

/** sha256(nonce) hex — klucz jednorazowości w guest_open_nonces. */
export function guestOpenNonceHash(nonce: string): string {
  return crypto.createHash('sha256').update(nonce).digest('hex')
}
