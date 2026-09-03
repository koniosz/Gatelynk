import { BadRequestException } from '@nestjs/common'

/**
 * Walidacja zdjęcia w zgłoszeniu/odpowiedzi (2026-08-13).
 *
 * Zdjęcia w całej bazie żyją jako data-URI base64 (konwencja z tickets.photo
 * i avatarów — patrz CLAUDE.md). Endpoint przyjmuje je w JSON, więc bez
 * walidacji ktoś mógłby wstrzyknąć dowolny tekst, który potem panel i apka
 * wyrenderują jako `src` obrazka. Wpuszczamy wyłącznie obrazy i tniemy
 * rozmiar: ~8 mln znaków base64 ≈ 6 MB binarnie (limit body to 10 MB).
 * Klienci i tak zmniejszają przed wysyłką (panel: canvas 1600 px,
 * iOS: JPEG compression) — limit jest siatką bezpieczeństwa.
 */
export function normalizeTicketPhoto(photo: unknown): string | null {
  if (photo === undefined || photo === null || photo === '') return null
  if (typeof photo !== 'string') {
    throw new BadRequestException('Nieprawidłowy format zdjęcia')
  }
  if (!/^data:image\/(jpeg|jpg|png|webp|heic|heif);base64,[A-Za-z0-9+/=]+$/.test(photo)) {
    throw new BadRequestException('Zdjęcie musi być obrazem (JPEG/PNG/WebP/HEIC)')
  }
  if (photo.length > 8_000_000) {
    throw new BadRequestException('Zdjęcie jest za duże (maksymalnie ~6 MB)')
  }
  return photo
}
