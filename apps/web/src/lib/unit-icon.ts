/**
 * Mapowanie wartości pola `icon` z bazy danych (nazwy ikonek) na emoji.
 * Systemowe typy lokali mają przechowywane nazwy ikonek (np. "home", "waves"),
 * natomiast typy niestandardowe mogą mieć już emoji wpisane przez użytkownika.
 */
const ICON_MAP: Record<string, string> = {
  home:           '🏠',
  car:            '🚗',
  archive:        '🗄️',
  waves:          '🏊',
  dumbbell:       '💪',
  flame:          '🧖',
  gamepad:        '🎮',
  'party-popper': '🎉',
}

/**
 * Zwraca emoji dla danego pola `icon` lub `code` z UnitType.
 * Jeśli `iconField` jest w mapowaniu → zwraca emoji.
 * Jeśli nie (np. użytkownik wpisał własne emoji) → zwraca `iconField` bez zmian.
 */
export function unitIconEmoji(iconField?: string | null, code?: string | null): string {
  if (iconField && ICON_MAP[iconField]) return ICON_MAP[iconField]
  if (iconField) return iconField   // własne emoji użytkownika
  return '🏠'
}
