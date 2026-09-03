/**
 * Messenger JSON parser (Facebook Data Download format).
 *
 * Facebook eksportuje pliki w katalogu `messages/inbox/<thread_id>/`:
 *   message_1.json, message_2.json, ... (chunkowane przy bardzo długich rozmowach)
 *
 * Format messages_N.json:
 *   {
 *     "participants": [{"name": "..."}],
 *     "messages": [
 *       {"sender_name": "...", "timestamp_ms": 1234567, "content": "...",
 *        "type": "Generic" | "Share" | "Subscribe" | ...,
 *        "is_unsent": false, "is_geoblocked_for_viewer": false}
 *     ],
 *     "title": "Sąsiedzi Niewinna 11",
 *     "is_still_participant": true,
 *     "thread_path": "inbox/..."
 *   }
 *
 * **CRITICAL BUG w FB export:** Polish/Unicode chars są ENCODED jako Latin-1
 * bytes traktowane jako UTF-8. Czyli "Ż" → 0xC5 0xBB UTF-8 bytes → spuszczone
 * przez ASCII filter → escaped jako "Å»" w JSON. Trzeba **double-decode**:
 *
 *   1. JSON.parse — daje string "Å»" (sequencja 2 chars z high byte)
 *   2. Reinterpret jako UTF-8 bytes: chars → buffer (latin-1 picks bytes 1:1) → UTF-8 decode
 *
 * Implementacja `fixMojibake()` poniżej. Bez tego pl plates jak "Żuławy" wyglądają
 * jak "Å»uÅ‚awy" w panelu i nie da się szukać po polsku.
 */

export interface MessengerMessage {
  senderName: string
  /** Epoch milliseconds. */
  ts: number
  content: string
  type: string
}

export interface ParsedMessengerThread {
  title: string
  participants: string[]
  messages: MessengerMessage[]
  /** Epoch ms — oldest message ts. */
  startTs: number
  /** Epoch ms — newest message ts. */
  endTs: number
  /** Per-participant message count dla statystyk. */
  perSenderCount: Record<string, number>
}

/**
 * Fix mojibake (Latin-1 jako UTF-8) z FB Messenger exportu.
 * "Å»uÅ‚awy" → "Żuławy"
 *
 * Algorytm:
 *  1. Każdy char input traktujemy jako Latin-1 byte (charCodeAt < 256)
 *  2. Składamy bytes w Buffer
 *  3. Dekodujemy buffer jako UTF-8
 *
 * Jeśli string ma char >255 (już poprawny Unicode), zostaw bez zmian — fragment
 * exportu z prawidłowym kodowaniem.
 */
export function fixMojibake(s: string): string {
  if (!s) return s
  // Quick check: są w stringu chars z latin-1 range 128-255 (mojibake markers)?
  // Polish poprawnie zakodowane ma chars >255 (np. Ż=379). Mojibake ma sekwencje
  // chars w 192-255 range (typowe high bytes UTF-8).
  let hasMojibakeMarker = false
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 192 && c <= 255) {
      hasMojibakeMarker = true
      break
    }
    if (c > 255) {
      // Mamy już prawidłowy Unicode > 255 — to nie mojibake
      return s
    }
  }
  if (!hasMojibakeMarker) return s

  // Reconstruct: each char as Latin-1 byte → Buffer → decode as UTF-8
  const bytes = Buffer.alloc(s.length)
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i) & 0xff
  }
  try {
    return bytes.toString('utf8')
  } catch {
    return s
  }
}

interface RawMessengerFile {
  participants?: Array<{ name?: string }>
  messages?: Array<{
    sender_name?: string
    timestamp_ms?: number
    content?: string
    type?: string
    is_unsent?: boolean
  }>
  title?: string
}

/**
 * Parse pojedynczy plik messages_N.json. Może być wywoływany wielokrotnie
 * (FB chunkuje długie rozmowy w 10K-message pliki) — wyniki merge-uj po stronie
 * caller-a.
 */
export function parseMessengerFile(raw: string | RawMessengerFile): ParsedMessengerThread {
  const data: RawMessengerFile = typeof raw === 'string' ? JSON.parse(raw) : raw

  const title = fixMojibake(data.title ?? 'Bez tytułu')
  const participants = (data.participants ?? [])
    .map((p) => fixMojibake(p.name ?? ''))
    .filter((n) => n.length > 0)

  const messages: MessengerMessage[] = []
  const perSenderCount: Record<string, number> = {}
  let startTs = Infinity
  let endTs = 0

  for (const m of data.messages ?? []) {
    if (m.is_unsent) continue // user deleted, skip
    const content = fixMojibake(m.content ?? '').trim()
    if (!content) continue // skip empty (np. share/reaction-only)
    const senderName = fixMojibake(m.sender_name ?? 'Nieznany')
    const ts = typeof m.timestamp_ms === 'number' ? m.timestamp_ms : 0

    messages.push({
      senderName,
      ts,
      content,
      type: m.type ?? 'Generic',
    })

    perSenderCount[senderName] = (perSenderCount[senderName] ?? 0) + 1
    if (ts < startTs) startTs = ts
    if (ts > endTs) endTs = ts
  }

  // FB exportuje w odwróconej kolejności (newest first) — odwracamy do
  // chronologicznej dla RAG (LLM lepiej śledzi flow).
  messages.sort((a, b) => a.ts - b.ts)

  return {
    title,
    participants,
    messages,
    startTs: startTs === Infinity ? 0 : startTs,
    endTs,
    perSenderCount,
  }
}

/**
 * Merge multiple message files (gdy FB exportuje > 10K messages w jednym threadzie
 * jako message_1.json + message_2.json + ...). Zachowuje participants + title
 * z pierwszego, łączy messages chronologicznie.
 */
export function mergeMessengerFiles(threads: ParsedMessengerThread[]): ParsedMessengerThread {
  if (threads.length === 0) {
    return { title: '', participants: [], messages: [], startTs: 0, endTs: 0, perSenderCount: {} }
  }
  if (threads.length === 1) return threads[0]

  const merged: ParsedMessengerThread = {
    title: threads[0].title,
    participants: Array.from(new Set(threads.flatMap((t) => t.participants))),
    messages: threads.flatMap((t) => t.messages).sort((a, b) => a.ts - b.ts),
    startTs: Math.min(...threads.map((t) => t.startTs).filter((t) => t > 0)),
    endTs: Math.max(...threads.map((t) => t.endTs)),
    perSenderCount: {},
  }
  for (const t of threads) {
    for (const [sender, count] of Object.entries(t.perSenderCount)) {
      merged.perSenderCount[sender] = (merged.perSenderCount[sender] ?? 0) + count
    }
  }
  return merged
}

/**
 * Format parsed thread jako pojedynczy plain-text dokument dla RAG.
 * Każda wiadomość: "[YYYY-MM-DD HH:MM] Imię: treść\n"
 *
 * Date headers co dzień ułatwiają LLM-owi orientację w chronologii:
 *   "==== 2024-03-15 ===="
 *   "[14:23] Anna: Czy jutro będzie wywóz śmieci?"
 *   "[14:31] Marek: Nie, w sobotę jest wolne"
 */
export function formatThreadAsText(thread: ParsedMessengerThread): string {
  const lines: string[] = []
  lines.push(`# ${thread.title}`)
  lines.push(`Uczestnicy: ${thread.participants.join(', ')}`)
  if (thread.startTs > 0 && thread.endTs > 0) {
    const start = new Date(thread.startTs).toISOString().slice(0, 10)
    const end = new Date(thread.endTs).toISOString().slice(0, 10)
    lines.push(`Zakres: ${start} → ${end} (${thread.messages.length} wiadomości)`)
  }
  lines.push('')

  let lastDate = ''
  for (const m of thread.messages) {
    const d = new Date(m.ts)
    const dateStr = d.toISOString().slice(0, 10)
    const timeStr = d.toTimeString().slice(0, 5)
    if (dateStr !== lastDate) {
      lines.push('')
      lines.push(`==== ${dateStr} ====`)
      lastDate = dateStr
    }
    lines.push(`[${timeStr}] ${m.senderName}: ${m.content}`)
  }
  return lines.join('\n')
}
