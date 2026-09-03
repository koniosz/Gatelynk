import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Podpisane, krótkożyciowe tokeny do zdjęć w powiadomieniach push (2026-08-12).
 *
 * APNs nie przenosi obrazów — push niesie tylko URL, a Notification Service
 * Extension w iOS pobiera go PRZED pokazaniem powiadomienia. Ten URL musi być
 * publiczny (rozszerzenie nie ma tokenu użytkownika), więc autoryzacją jest
 * sam token: HMAC z sekretu serwera + data ważności. Token wskazuje JEDNO
 * konkretne zdjęcie (building + edgeReadId) i wygasa — wyciek z ekranu
 * blokady nie daje dostępu do niczego więcej.
 *
 * Format: base64url("<buildingId>.<edgeReadId>.<expEpochSec>") + "." + hmac.
 * Świadomie NIE JWT — zero zależności, token krótszy (idzie w payloadzie
 * APNs, limit 4 KB).
 */

const secret = () => process.env.JWT_SECRET ?? ''

function hmac(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url')
}

export function signPushMediaToken(buildingId: number, edgeReadId: number, ttlSeconds = 2 * 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const body = Buffer.from(`${buildingId}.${edgeReadId}.${exp}`).toString('base64url')
  return `${body}.${hmac(body)}`
}

export function verifyPushMediaToken(token: string): { buildingId: number; edgeReadId: number } | null {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = hmac(body)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const parts = Buffer.from(body, 'base64url').toString('utf8').split('.')
  if (parts.length !== 3) return null
  const [buildingId, edgeReadId, exp] = parts.map(Number)
  if (!Number.isFinite(buildingId) || !Number.isFinite(edgeReadId) || !Number.isFinite(exp)) return null
  if (exp * 1000 < Date.now()) return null
  return { buildingId, edgeReadId }
}
