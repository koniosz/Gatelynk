/**
 * Curated dictionary of suggested vehicle tags shown in the TagPicker. The
 * dictionary lives on the front-end (no server round-trip) — backend stores
 * tags as an opaque TEXT[] and doesn't validate against this list. Adding a
 * new chip here is enough to surface it in the picker; admins can also type
 * their own free-form tags ("opiekunka Aniela", "Tesla 3 sąsiad").
 *
 * Why groups? Quickly pickable categories without an overwhelming flat list.
 * The order matters — most-used groups come first.
 *
 * Pamiętaj: tagi są case-sensitive na backendzie (DISTINCT po unnest), więc
 * trzymamy tu jeden kanoniczny zapis każdego z popularnych tagów.
 */
export interface TagGroup {
  /** Heading shown above the chip group in the picker. */
  label: string
  /** Optional short helper text under the heading. */
  hint?: string
  tags: string[]
}

export const VEHICLE_TAG_GROUPS: TagGroup[] = [
  {
    label: 'Nadwozie',
    hint: 'Typ/styl auta — szybki filtr po wyglądzie.',
    tags: ['kabrio', 'SUV', 'sedan', 'kombi', 'hatchback', 'pickup', 'van', 'sportowy', 'elektryczny'],
  },
  {
    label: 'Kolor',
    hint: 'Kiedy kamera pomyliła kolor albo trzeba doprecyzować odcień.',
    tags: ['biały', 'czarny', 'srebrny', 'szary', 'czerwony', 'niebieski', 'zielony', 'żółty', 'pomarańczowy', 'beżowy', 'złoty'],
  },
  {
    label: 'Firma / aplikacja',
    hint: 'Pomocne, gdy w bazie jest kilku kierowców z tej samej firmy.',
    tags: ['Glovo', 'Bolt Food', 'Wolt', 'Uber Eats', 'Pyszne.pl', 'DPD', 'InPost', 'DHL', 'GLS', 'UPS', 'FedEx', 'Allegro One Box', 'Poczta Polska'],
  },
  {
    label: 'Funkcja / cel wizyty',
    hint: 'Po co przyjeżdża — pomaga AI odpowiadać na pytania mieszkańców.',
    tags: ['taxi', 'Uber', 'Bolt', 'opiekunka', 'obsługa basenu', 'sprzątanie', 'ogrodnik', 'serwis', 'wywóz odpadów', 'budowa', 'gość'],
  },
  {
    label: 'Inne',
    tags: ['VIP', 'priorytet', 'zgłoszenie', 'do weryfikacji'],
  },
]

/** Flat list of all curated tags, useful for autocomplete dedup. */
export const ALL_CURATED_TAGS: string[] = VEHICLE_TAG_GROUPS.flatMap(g => g.tags)

/**
 * Łączy curated dictionary z tagami już użytymi w danym budynku (z
 * autocomplete endpointu). Curated idą pierwsze (kolejność dictionary),
 * potem custom tagi alfabetycznie. Bez duplikatów (case-sensitive — tak
 * jak w bazie).
 */
export function mergeTagSuggestions(
  used: string[] | null | undefined,
): { groups: TagGroup[]; custom: string[] } {
  const usedClean = (used ?? []).map(t => t.trim()).filter(Boolean)
  const curatedSet = new Set(ALL_CURATED_TAGS)
  const custom = Array.from(new Set(usedClean.filter(t => !curatedSet.has(t)))).sort((a, b) =>
    a.localeCompare(b, 'pl'),
  )
  return { groups: VEHICLE_TAG_GROUPS, custom }
}

/**
 * Sanitization mirror of `sanitizeTags()` w api/building-admin.service —
 * trzymamy te same limity, żeby UI nie wysyłał niczego, co backend i tak
 * obetnie. To prewencyjna walidacja; backend i tak waliduje sam.
 */
export const TAG_MAX_COUNT = 32
export const TAG_MAX_LENGTH = 64

export function normalizeTagInput(raw: string): string {
  return raw.trim().slice(0, TAG_MAX_LENGTH)
}
