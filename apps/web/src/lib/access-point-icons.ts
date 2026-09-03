/**
 * Mapowanie kanonicznych ikon AccessPoint (string enum w schema.prisma) na
 * emoji do wyświetlenia w UI. Wspólne dla web (BA + concierge + resident
 * iOS — w przyszłości) żeby nie musieć powtarzać tego mapowania.
 *
 * Backend zna te 5 stringów (ACCESS_POINT_ICONS w building-admin.service.ts);
 * dodanie nowej ikony wymaga zmiany w obu miejscach + walidacji
 * `BaUpdateAccessPointDto.icon` (whitelist).
 */

export const ACCESS_POINT_ICONS = ['door', 'garage', 'gate', 'elevator', 'barrier'] as const
export type AccessPointIcon = typeof ACCESS_POINT_ICONS[number]

export const ICON_EMOJI: Record<AccessPointIcon, string> = {
  door:     '🚪',
  garage:   '🚗',
  gate:     '🛂',
  elevator: '🛗',
  barrier:  '🚧',
}

export const ICON_LABEL: Record<AccessPointIcon, string> = {
  door:     'Drzwi',
  garage:   'Garaż',
  gate:     'Brama / furtka',
  elevator: 'Winda',
  barrier:  'Szlaban',
}

export function emojiFor(icon: string): string {
  return ICON_EMOJI[icon as AccessPointIcon] ?? '🚪'
}
