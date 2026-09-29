/**
 * Styl powiadomień push (2026-09-29, uwaga właściciela: „wyglądają
 * niepoważnie — jakieś ikonki auta"). Zasady:
 *   • zero emoji/piktogramów — w tytule, podtytule i treści (także w tekstach
 *     generowanych przez AI, np. Kronika dnia) — to jedyny punkt wyjścia
 *     wszystkich pushy, więc filtr jest tu, a nie w każdym wywołaniu;
 *   • tytuł = krótka nazwa zdarzenia (rzeczownik), treść = pełne zdanie
 *     z konkretem (kto, gdzie, o której), bez wykrzykników i potocznych zwrotów;
 *   • jeden wątek (thread-id) per rodzaj zdarzenia — iOS grupuje pushe
 *     o pojazdach, gościach, przesyłkach osobno zamiast jednej długiej listy.
 */

/** Usuwa emoji, piktogramy, selektory wariantów i ZWJ; porządkuje spacje. */
export function sanitizePushText(text: string | null | undefined): string {
  if (!text) return ''
  return text
    // Zakresy: piktogramy i emoji (1F000–1FAFF), symbole techniczne i zegary
    // (2300–23FF, np. ⏱), kształty (25A0–25FF), dingbaty (2600–27BF), strzałki
    // i symbole (2B00–2BFF), flagi, selektory wariantów, ZWJ, keycap.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s\-–—:·•]+/, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .trim()
}

/** Wątek grupowania na iOS — po `type`/`kind` z payloadu. */
export function pushThreadId(data?: Record<string, unknown>): string | undefined {
  const kind = String((data?.kind ?? data?.type ?? '') as string).toUpperCase()
  if (!kind) return undefined
  if (kind.startsWith('VEHICLE')) return 'vehicles'
  if (kind.startsWith('GUEST')) return 'guests'
  if (kind === 'PARCEL') return 'parcels'
  if (kind === 'TICKET_REPLY') return 'tickets'
  if (kind === 'NOTIFICATION') return 'announcements'
  if (kind === 'PAYMENT_REMINDER') return 'payments'
  if (kind === 'ANOMALY' || kind === 'COURIER_VISIT' || kind === 'OVERSTAY') return 'security'
  if (kind === 'MORNING-BRIEF' || kind === 'EVENING-CHRONICLE' || kind === 'WASTE-REMINDER') return 'daily'
  return kind.toLowerCase()
}

/** „17:22" w czasie osiedla (Europe/Warsaw) — do treści pushy o zdarzeniach. */
export function warsawTime(ts: number | Date = Date.now()): string {
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit',
  }).format(ts instanceof Date ? ts : new Date(ts))
}
