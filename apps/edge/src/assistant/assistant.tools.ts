/**
 * Tool definitions for Edge AI Assistant.
 *
 * Każde tool to:
 *  • `name`         — unique id, LLM używa go w `tool_calls`
 *  • `description`  — co tool robi, PO ANGIELSKU (system prompt do LLM-a jest EN)
 *  • `parameters`   — JSON Schema args; LLM generuje payload zgodny z tym schema
 *  • `run`          — implementacja: dostaje args + StoreService → zwraca JSON-able payload
 *
 * Cel: dać Qwen 2.5 zestaw deterministycznych zapytań SQL nad sqlite Edge.
 * Wszystko co LLM zwraca usera musi przejść przez tool — tym samym chronimy
 * przed halucynacją liczb i nazwisk.
 *
 * Privacy: żaden tool nie zwraca `owner` (imię/nazwisko) z lpr_reads — tylko
 * `unitLabel` (np. „Niewinna 6/1"). Patrz docstring kolumny `unit_label` w
 * `store.service.ts`.
 */
import type { StoreService } from '../store/store.service'

export interface ToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, {
      type: 'string' | 'number' | 'boolean' | 'array'
      description: string
      enum?: string[]
      items?: { type: string }
    }>
    required?: string[]
  }
  run(args: Record<string, any>, ctx: ToolContext): Promise<unknown> | unknown
}

export interface ToolContext {
  store: StoreService
  /** Optional — wstrzykiwane w AssistantService. Tool `search_knowledge` korzysta. */
  knowledge?: import('../knowledge/knowledge.service').KnowledgeService
}

/**
 * Parser `range` stringa „24h" / „3d" / „1h" → millisekundy.
 * Defensywny — limit 30 dni (sqlite retention 30d dla lpr_reads, 7d dla event_log).
 */
function parseRangeMs(range: string | undefined, defaultHours = 24): number {
  if (!range) return defaultHours * 3600_000
  const m = range.match(/^(\d+)([hd])$/)
  if (!m) return defaultHours * 3600_000
  const n = parseInt(m[1], 10)
  const unit = m[2]
  const ms = unit === 'd' ? n * 24 * 3600_000 : n * 3600_000
  return Math.min(Math.max(ms, 0), 30 * 24 * 3600_000)
}

/** Format ts as ISO YYYY-MM-DDTHH:MM:SS (UTC) — LLM-friendly. */
function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
}

/**
 * Mapowanie polskich nazw kolorów na ich angielskie odpowiedniki (i odwrotnie).
 * Hikvision firmware zwraca po angielsku ('black', 'white', 'silver') —
 * user pyta po polsku. Zwracamy LISTĘ aliasów żeby `matchesColor` mogło
 * porównać oba kierunki.
 */
const COLOR_ALIASES: Record<string, string[]> = {
  // EN canonical → [EN, PL, variants]
  black:  ['black',  'czarny',  'czarne',  'czarna'],
  white:  ['white',  'bialy',   'biały',   'białe',  'biała'],
  red:    ['red',    'czerwony','czerwone','czerwona'],
  blue:   ['blue',   'niebieski','niebieskie','niebieska','granatowy','granatowe'],
  green:  ['green',  'zielony', 'zielone', 'zielona'],
  yellow: ['yellow', 'zolty',   'żółty',   'żółte',  'żółta'],
  gray:   ['gray',   'grey',    'szary',   'szare',  'szara'],
  silver: ['silver', 'srebrny', 'srebrne', 'srebrna'],
  brown:  ['brown',  'brazowy', 'brązowy', 'brązowe','brązowa'],
  orange: ['orange', 'pomaranczowy','pomarańczowy','pomarańczowe'],
}

function normalizeColor(input: string | undefined): string[] {
  if (!input) return []
  const q = input.toLowerCase().trim()
  // Spróbuj dopasować do canonical przez aliasy
  for (const [, aliases] of Object.entries(COLOR_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase() === q)) return aliases
  }
  // Fallback — surowy substring (np. „cz" → matches czarny)
  return [q]
}

function matchesColor(stored: string | null | undefined, aliases: string[]): boolean {
  if (!stored) return false
  const s = stored.toLowerCase()
  return aliases.some((a) => s.includes(a.toLowerCase()))
}

// ── Tool definitions ───────────────────────────────────────────────────────

export const TOOLS: ToolDef[] = [
  {
    name: 'list_lpr_reads',
    description:
      'List recent license plate reads from LPR cameras with vehicle attributes (color, brand, type) ' +
      'detected by the Hikvision/Dahua camera itself — works for ANY plate, matched or unmatched. ' +
      'Use this when user asks about color/brand/type of vehicles, including unknown plates. ' +
      'For pure counts use count_lpr_reads instead.',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'Time window like "1h", "24h", "3d". For "today" use "24h".' },
        plate: { type: 'string', description: 'Optional plate substring filter (case-insensitive).' },
        matched: { type: 'boolean', description: 'true=only allowlist matches, false=only unknowns. Omit for all reads.' },
        color: {
          type: 'string',
          description: 'Filter by camera-detected vehicle color, case-insensitive substring (e.g. "black", "czarny", "white", "biały"). Matches accept both EN and PL names.',
        },
        vehicleType: {
          type: 'string',
          description: 'Filter by camera-detected vehicle type (e.g. "car", "van", "truck", "motorcycle").',
        },
        limit: { type: 'number', description: 'Max rows, default 10, max 30.' },
      },
    },
    async run(args, { store }) {
      const sinceMs = Date.now() - parseRangeMs(args.range)
      // Większy raw pool gdy filtrujemy po kolorze — żeby po post-filtrze
      // zostały sensowne liczby. Camera color tag-uje ok 60-80% odczytów,
      // więc pobieramy do 200 i tnijemy do limitu.
      const rawLimit = (args.color || args.vehicleType) ? 200 : Math.min(Math.max(args.limit ?? 10, 1), 30)
      const rows = store.lprListRecentAll({
        plate: args.plate,
        matched: typeof args.matched === 'boolean' ? args.matched : undefined,
        limit: rawLimit,
      })
      const colorQ = normalizeColor(args.color)
      const typeQ  = (args.vehicleType ?? '').toLowerCase().trim()
      const filtered = rows
        .filter((r) => r.ts >= sinceMs)
        // BUGFIX 2026-05-18: poprzednio `!colorQ` — pusta tablica `[]` jest
        // truthy, więc `![]` zawsze false → filter wykluczał WSZYSTKIE wiersze
        // gdy color filter był pusty. Wszystkie no-color calls list_lpr_reads
        // zwracały 0. Sprawdzaj .length jawnie.
        .filter((r) => colorQ.length === 0 || matchesColor(r.vehicleColor, colorQ))
        .filter((r) => !typeQ  || (r.vehicleType ?? '').toLowerCase().includes(typeQ))
        .slice(0, Math.min(Math.max(args.limit ?? 10, 1), 30))
      return {
        count: filtered.length,
        reads: filtered.map((r) => ({
          ts: fmtTs(r.ts),
          plate: r.plate,
          unitLabel: r.unitLabel,        // privacy-safe, never owner name
          matched: r.matched,
          gateOpened: r.gateOpened,
          // Camera-derived attributes — z Hikvision ANPR XML (`<vehicleColor>`,
          // `<vehicleType>`, `<vehicleBrand>`). Działa dla matched + unmatched.
          color: r.vehicleColor ?? null,
          vehicleType: r.vehicleType ?? null,
          brand: r.vehicleBrand ?? null,
        })),
      }
    },
  },

  {
    name: 'count_lpr_reads',
    description:
      'Count plate reads in a time window. Faster than list_lpr_reads — use this when user just needs ' +
      'a number ("how many", "ile", "czy są jakieś"). Returns total + matched/unmatched breakdown.',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'Time window like "1h", "24h", "3d". For "today" use "24h".' },
      },
    },
    async run(args, { store }) {
      const sinceMs = Date.now() - parseRangeMs(args.range)
      const rows = store.lprListRecentAll({ limit: 1000 })
      const inWindow = rows.filter((r) => r.ts >= sinceMs)
      const matched   = inWindow.filter((r) => r.matched).length
      const unmatched = inWindow.length - matched
      return {
        total: inWindow.length,
        matched,
        unmatched,
        sinceMs: fmtTs(sinceMs),
      }
    },
  },

  {
    name: 'list_relay_triggers',
    description:
      'List recent relay triggers from intercoms (PIN entry, panel/app HTTP, hold-open cycle). ' +
      'Does NOT include LPR-driven gate openings — for those use list_gate_openings or list_lpr_reads(matched=true). ' +
      'IMPORTANT: this table was added 2026-05-15, so PIN history from earlier dates is not available here.',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'Time window like "24h", "3d", "7d". Default "24h".' },
        source: {
          type: 'string',
          description: 'Filter by trigger source: HTTP (panel/app), PIN (guest), HOLD_OPEN, OTHER.',
          enum: ['HTTP', 'PIN', 'HOLD_OPEN', 'OTHER'],
        },
        limit: { type: 'number', description: 'Max rows, default 50, max 200.' },
      },
    },
    async run(args, { store }) {
      const sinceMs = Date.now() - parseRangeMs(args.range)
      const rows = store.relayTriggerListRecent({
        sinceMs,
        source: args.source,
        limit: Math.min(Math.max(args.limit ?? 50, 1), 200),
      })
      return {
        count: rows.length,
        triggers: rows.map((r) => ({
          ts: fmtTs(r.ts),
          deviceName: r.deviceName,
          deviceType: r.deviceType,
          relayIndex: r.relayIndex,
          source: r.source,
        })),
      }
    },
  },

  {
    name: 'list_gate_openings',
    description:
      'Comprehensive summary of gate openings in the window: PIN/HTTP/HOLD_OPEN from intercoms PLUS ' +
      'LPR auto-open events. Use for generic questions: "was there a courier", "kto wszedł", "ile bram". ' +
      'Returns compact counts + up to 10 courier visits with plate+tags. KEEP THE RESPONSE BRIEF — ' +
      'list at most 5 entries unless user explicitly asks for more. ' +
      'WHEN USER NAMES A CARRIER ("kurier DHL", "tylko InPost", "Glovo w tygodniu") ' +
      'YOU MUST pass `carrier` argument; otherwise you return wrong data.',
    parameters: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          description:
            'Time window. PARSE TIME WORDS LITERALLY: "dziś"/"today"="24h", ' +
            '"wczoraj"/"yesterday"="48h", "w tygodniu"/"w ciągu tygodnia"/"week"="7d", ' +
            '"miesiąc"/"month"="30d", "w poprzednich dniach"/"previous days"="7d". ' +
            'Default "24h" ONLY if user gives no time hint.',
        },
        carrier: {
          type: 'string',
          description:
            'Filter courier visits by carrier name (case-insensitive substring on tags). ' +
            'Examples: "DHL", "InPost", "Glovo", "DPD", "Poczta", "FedEx", "UPS", "Allegro". ' +
            'Use this WHENEVER user names a specific courier. Omit for "wszyscy kurierzy".',
        },
        vehicleKind: {
          type: 'string',
          description:
            'Filter by category. Allowed: "COURIER" (DELIVERY+SERVICE, default for "kurier"), ' +
            '"DELIVERY", "SERVICE", "RESIDENT" (mieszkańcy), "GUEST". Omit for full breakdown.',
          enum: ['COURIER', 'DELIVERY', 'SERVICE', 'RESIDENT', 'GUEST'],
        },
      },
    },
    async run(args, { store }) {
      const sinceMs = Date.now() - parseRangeMs(args.range)

      const relayRows = store.relayTriggerListRecent({ sinceMs, limit: 500 })
      // Edge ma snapshot vehicle metadata w `lpr_reads` (kind/tags zapisane
      // przy match-u). ALE dla historycznych eventów sprzed C1 deploy te pola
      // są NULL. Rozwiązanie: JOIN z aktualnym `lpr_plates` żeby dostać
      // żywe (aktualne) tagi/kind. Patrz: `lprListRecentAll` zwraca już snapshot,
      // ale tu też dociągamy current plate state z whitelist.
      const lprRowsRaw = store
        .lprListRecentAll({ matched: true, limit: 1000 })
        .filter((r) => r.gateOpened && r.ts >= sinceMs)

      // Whitelist lookup: plate → current {kind, tags, unitLabel}
      const cameraIds = new Set(lprRowsRaw.map((r) => r.cameraDeviceId))
      const whitelistByPlate = new Map<string, { kind: string | null; tags: string[]; unitLabel: string | null }>()
      for (const cid of cameraIds) {
        for (const p of store.lprListPlates(cid)) {
          whitelistByPlate.set(p.plate, { kind: p.kind, tags: p.tags, unitLabel: p.unitLabel })
        }
      }

      // Merge: snapshot z lpr_reads jest authoritative gdy nie-pusty, fallback
      // do whitelist current state.
      const lprRows = lprRowsRaw.map((r) => {
        const wl = whitelistByPlate.get(r.plate)
        return {
          ...r,
          kind: r.kind || wl?.kind || null,
          tags: r.tags.length > 0 ? r.tags : (wl?.tags ?? []),
          unitLabel: r.unitLabel || wl?.unitLabel || null,
        }
      })

      // Kategoryzacja na bazie `kind` z Cloud VehicleKind enum:
      //   RESIDENT  — mieszkaniec
      //   DELIVERY  — kurier (Glovo, InPost, DPD, DHL, Poczta, FedEx, UPS…)
      //   SERVICE   — usługa cykliczna (sprzątanie, konserwacja, utility)
      // Pytania o „kuriera"/„courier" obejmują DELIVERY + SERVICE (oba są
      // gośćmi-zawodowymi, użytkownik nie odróżnia ich w mowie potocznej).
      const deliveryOpenings = lprRows.filter((r) => r.kind === 'DELIVERY')
      const serviceOpenings  = lprRows.filter((r) => r.kind === 'SERVICE')
      const residentOpenings = lprRows.filter((r) => r.kind === 'RESIDENT')
      const guestOpenings    = lprRows.filter((r) => r.kind === 'GUEST')
      const untaggedOpenings = lprRows.filter((r) => !r.kind)
      let courierOpenings  = [...deliveryOpenings, ...serviceOpenings]
        .sort((a, b) => b.ts - a.ts)

      // vehicleKind filter — narrow scope if user asked for specific category.
      // Domyślnie: zwracamy kurierów (DELIVERY+SERVICE razem) — to najczęstszy
      // case-use. User explicit "tylko delivery" / "service" / "resident" /
      // "guest" → reset courierOpenings na właściwą podgrupę.
      const vehicleKind = typeof args.vehicleKind === 'string' ? args.vehicleKind.toUpperCase() : null
      if (vehicleKind === 'DELIVERY')      courierOpenings = [...deliveryOpenings].sort((a, b) => b.ts - a.ts)
      else if (vehicleKind === 'SERVICE')  courierOpenings = [...serviceOpenings].sort((a, b) => b.ts - a.ts)
      else if (vehicleKind === 'RESIDENT') courierOpenings = [...residentOpenings].sort((a, b) => b.ts - a.ts)
      else if (vehicleKind === 'GUEST')    courierOpenings = [...guestOpenings].sort((a, b) => b.ts - a.ts)
      // COURIER / brak → już ustawione na delivery+service.

      // carrier filter — case-insensitive substring na tags. "DHL" → tylko rekordy
      // gdzie tags zawierają tag matching "DHL" (np. ["DHL", "Mercedes", "biały"]).
      // Idempotentny: brak/empty string = nie filtruj.
      const carrierFilter = typeof args.carrier === 'string' ? args.carrier.trim().toLowerCase() : ''
      if (carrierFilter) {
        courierOpenings = courierOpenings.filter((r) =>
          r.tags.some((t) => t.toLowerCase().includes(carrierFilter)),
        )
      }

      // Per-plate stats — show top 10 most-frequent plates with their tags+kind.
      // To pozwala asystentowi powiedzieć „Kurier DPD (PO6MM84) wjechał 4 razy"
      // zamiast halucynować na podstawie message-tekstu.
      const perPlate = new Map<string, { count: number; tags: Set<string>; kind: string | null; unitLabel: string | null; latestTs: number }>()
      for (const r of lprRows) {
        const e = perPlate.get(r.plate) ?? { count: 0, tags: new Set<string>(), kind: r.kind, unitLabel: r.unitLabel, latestTs: r.ts }
        e.count++
        for (const t of r.tags) e.tags.add(t)
        if (r.ts > e.latestTs) {
          e.latestTs = r.ts
          e.unitLabel = r.unitLabel
          e.kind = r.kind
        }
        perPlate.set(r.plate, e)
      }
      const plates = [...perPlate.entries()]
        .sort(([, a], [, b]) => b.count - a.count)
        .slice(0, 10)
        .map(([plate, info]) => ({
          plate,
          count: info.count,
          kind: info.kind,
          tags: [...info.tags],
          unitLabel: info.unitLabel,
          latestTs: fmtTs(info.latestTs),
        }))

      const pinRows = relayRows.filter((r) => r.source === 'PIN')
      const pinHighlights = pinRows.slice(0, 3).map((r) => ({
        ts: fmtTs(r.ts),
        device: r.deviceName,
      }))

      // Legacy fallback — event_log parsing (jedyny sposób gdy whitelist data
      // sprzed E1 migracji, brak `kind`/`tags`). Pozostaje jako safety net.
      const allEvents = store.eventLogQuery({ sinceMs, limit: 1000 })
      const lprMessageHints = allEvents
        .filter((e) => e.category === 'LPR' && e.level === 'success' && /opened/i.test(e.message))
        .slice(-15)
        .map((e) => ({ ts: fmtTs(e.ts), msg: e.message }))

      // Flat structure żeby Qwen 2.5 3B nie halucynował "byKind" / "couriers"
      // jako dodatkowe narzędzia do wywołania. Mniej zagnieżdżeń = mniej myślenia.
      const courierList = courierOpenings.slice(0, 10).map((r) => {
        const tagStr = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : ''
        return `${fmtTs(r.ts)} ${r.plate}${tagStr}`
      })

      return {
        windowHours: Math.round(parseRangeMs(args.range) / 3600_000),
        gateOpeningsTotal: relayRows.length + lprRows.length,
        gateOpeningsByMethod: `${lprRows.length} LPR auto-open, ${pinRows.length} guest PIN, ${relayRows.filter((r) => r.source === 'HTTP').length} from panel/app, ${relayRows.filter((r) => r.source === 'HOLD_OPEN').length} hold-open cycle`,

        // === KURIERZY (DELIVERY + SERVICE razem) ===
        // Jeśli user pyta "był kurier" — to jest authoritative count.
        courierVisits: courierOpenings.length,
        courierList,    // ["2026-05-15 09:30 PO6MM84 [DPD, van]", ...]

        // === Pozostałe kategorie ===
        residentVisits: residentOpenings.length,
        guestVisits: guestOpenings.length,
        untaggedVisits: untaggedOpenings.length,

        // === Legacy fallback ===
        legacyMessageHints: lprMessageHints.slice(0, 5).map((m) => m.msg),

        // === Filter introspection ===
        // Pozwala modelowi powiedzieć: "Po filtrze DHL znalazłem 3 wizyty"
        // zamiast halucynować że jest ich więcej. NULL = brak filtra.
        filtersApplied: {
          carrier: carrierFilter || null,
          vehicleKind: vehicleKind || null,
        },

        // Jak czytać:
        instructions:
          carrierFilter
            ? `Filtered by carrier "${carrierFilter}". courierVisits and courierList contain ONLY matching entries. If courierVisits=0 → tell user explicitly "Brak wizyt ${carrierFilter} w tym okresie".`
            : 'For "courier"/"kurier" → use courierVisits + courierList. For "resident"/"mieszkaniec" → residentVisits. For total gate openings → gateOpeningsTotal.',
      }
    },
  },

  {
    name: 'list_event_log',
    description:
      'List system events from the audit log. Use this to answer questions about errors, warnings, ' +
      'tunnel state changes, restart events, or "what happened recently". Categories include TUNNEL, ' +
      'LPR, RELAY, HTTP, SYSTEM, RESTART, DND, HOLD_OPEN. Levels: info / success / warning / error / debug.',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'Time window like "24h", "3d", "7d". Default "24h".' },
        levels: {
          type: 'array',
          description: 'Filter levels e.g. ["error","warning"]. Default: all.',
          items: { type: 'string' },
        },
        category: { type: 'string', description: 'Filter by category e.g. "TUNNEL" or "LPR".' },
        limit: { type: 'number', description: 'Max rows, default 100, max 500.' },
      },
    },
    async run(args, { store }) {
      const sinceMs = Date.now() - parseRangeMs(args.range)
      const rows = store.eventLogQuery({
        sinceMs,
        levels: Array.isArray(args.levels) ? args.levels : undefined,
        limit: Math.min(Math.max(args.limit ?? 100, 1), 500),
      })
      const filtered = args.category
        ? rows.filter((r) => r.category.toLowerCase() === String(args.category).toLowerCase())
        : rows
      return {
        count: filtered.length,
        events: filtered.map((r) => ({
          ts: fmtTs(r.ts),
          level: r.level,
          category: r.category,
          message: r.message,
        })),
      }
    },
  },

  {
    name: 'count_relay_triggers',
    description:
      'Count intercom-driven gate openings (PIN/HTTP/HOLD_OPEN). Does NOT include LPR auto-open. ' +
      'Returns total + per-source counts. For complete gate-openings stat use list_gate_openings.',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'Time window like "24h", "3d", "7d". Default "24h".' },
      },
    },
    async run(args, { store }) {
      const sinceMs = Date.now() - parseRangeMs(args.range)
      const rows = store.relayTriggerListRecent({ sinceMs, limit: 1000 })
      const bySource: Record<string, number> = {}
      for (const r of rows) {
        bySource[r.source] = (bySource[r.source] ?? 0) + 1
      }
      return {
        total: rows.length,
        bySource,
        sinceMs: fmtTs(sinceMs),
        note: 'Intercom triggers only. LPR auto-openings are NOT included — use list_gate_openings for combined view.',
      }
    },
  },

  {
    name: 'list_devices',
    description:
      'List all devices configured on this Edge (intercoms, cameras, LPR cameras, switches). ' +
      'Returns device name, type, manufacturer/model, IP, and last-seen timestamp. ' +
      'Use this to answer "what devices are connected" or "is camera X online".',
    parameters: { type: 'object', properties: {} },
    async run(_args, { store }) {
      const configs = store.getDeviceConfigs()
      return {
        count: configs.length,
        devices: configs.map((d) => ({
          name: (d.config as any)?.name ?? null,
          type: d.type,
          manufacturer: (d.config as any)?.manufacturer ?? null,
          model: (d.config as any)?.model ?? null,
          ipAddress: (d.config as any)?.ipAddress ?? null,
          enabled: d.enabled,
        })),
      }
    },
  },

  {
    name: 'current_time',
    description:
      'Get the current Edge server time (ISO 8601, UTC). Use this before computing time ranges if ' +
      'the user asks about "today", "this morning", "last hour", etc. — anchor relative phrases to now.',
    parameters: { type: 'object', properties: {} },
    async run() {
      return { now: fmtTs(Date.now()), tzOffsetMin: -new Date().getTimezoneOffset() }
    },
  },

  {
    name: 'search_knowledge',
    description:
      'Semantic search w bazie wiedzy budynku — uchwały, regulaminy, rozmowy z Messengera ' +
      'mieszkańców, kontakty serwisowe, inne notatki. Używaj GDY user pyta o sprawy ' +
      'administracyjne ("co mówi uchwała o psach", "kto jest hydraulikiem", "co pisali sąsiedzi ' +
      'o hałasie"). Zwraca top-K chunków z metadata (typ doc, tytuł, score). ' +
      'NIE używaj dla LPR/bram/kurierów — to dane z systemu (inne narzędzia).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language query po polsku albo angielsku. Bge-m3 jest multilingual.',
        },
        type: {
          type: 'string',
          description: 'Optional filter po typie dokumentu.',
          enum: ['UCHWALA', 'REGULAMIN', 'MESSENGER_CHAT', 'KONTAKT', 'INNE'],
        },
        limit: { type: 'number', description: 'Max top-K hits, default 5, max 20.' },
      },
      required: ['query'],
    },
    async run(args, ctx) {
      if (!ctx.knowledge) {
        return { hits: [], error: 'Knowledge service nie skonfigurowany na Edge.' }
      }
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        return { hits: [], error: 'Wymagany `query`.' }
      }
      const hits = await ctx.knowledge.search(args.query, {
        type: args.type,
        limit: args.limit,
      })
      return {
        query: args.query,
        hitCount: hits.length,
        hits: hits.map((h) => ({
          docId: h.cloudId,
          type: h.type,
          title: h.title,
          score: Math.round(h.score * 1000) / 1000,
          text: h.text,
        })),
        instructions: hits.length === 0
          ? 'Brak match w bazie wiedzy. Powiedz user-owi że temat nie jest udokumentowany.'
          : 'Cytuj fragmenty z `text`, podaj źródło (title + type). Jeśli pytanie dotyczy ' +
            'konkretnej kwestii (np. § uchwały), wskaż ten fragment dosłownie.',
      }
    },
  },
]

/** Lookup tool by name; throws if missing (LLM wymyślił nazwę). */
export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name)
}

/** Render tools jako JSON spec dla Ollama tools API (function calling). */
export function toolsAsOllamaSpec() {
  return TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}
