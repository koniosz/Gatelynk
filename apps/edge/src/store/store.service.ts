import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as Database from 'better-sqlite3'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ── AccessPoint typings (shared with AccessPointExecutor / TunnelService) ────
export interface AccessPointRow {
  id: number
  buildingId: number
  label: string
  icon: string | null
  scope: string
  // FAZA c (2026-06-02) — semantyczna kategoria (MAIN_ENTRY/FIRE_ESCAPE/...).
  // Sterowanie zachowaniem (np. domyślny scope dla FIRE_ESCAPE w UI).
  category: string
  outputDeviceUuid: string | null
  outputIndex: number | null
  durationMs: number
  isActive: boolean
  sortOrder: number
  legacyDeviceId: string | null
  legacyRelayIndex: number | null
  updatedAt: number
}

// FAZA c — LPR camera ↔ AccessPoint link row.
export interface LprCameraApLinkRow {
  id: number
  cameraDeviceUuid: string
  accessPointId: number
  direction: string  // 'IN' | 'OUT'
  buildingId: number
  updatedAt: number
}

export interface AccessPointScheduleRow {
  id: number
  accessPointId: number
  cronExpr: string
  label: string | null
  enabled: boolean
  lastFiredAt: number | null
  updatedAt: number
}

function mapApRow(r: any): AccessPointRow {
  return {
    id: r.id,
    buildingId: r.building_id,
    label: r.label,
    icon: r.icon ?? null,
    scope: r.scope ?? 'RESIDENT',
    category: r.category ?? 'MAIN_ENTRY',
    outputDeviceUuid: r.output_device_uuid ?? null,
    outputIndex: r.output_index ?? null,
    durationMs: r.duration_ms ?? 800,
    isActive: r.is_active !== 0,
    sortOrder: r.sort_order ?? 0,
    legacyDeviceId: r.legacy_device_id ?? null,
    legacyRelayIndex: r.legacy_relay_index ?? null,
    updatedAt: r.updated_at ?? 0,
  }
}

function mapLprApLinkRow(r: any): LprCameraApLinkRow {
  return {
    id: r.id,
    cameraDeviceUuid: r.camera_device_uuid,
    accessPointId: r.access_point_id,
    direction: r.direction ?? 'IN',
    buildingId: r.building_id,
    updatedAt: r.updated_at ?? 0,
  }
}

function mapApScheduleRow(r: any): AccessPointScheduleRow {
  return {
    id: r.id,
    accessPointId: r.access_point_id,
    cronExpr: r.cron_expr,
    label: r.label ?? null,
    enabled: r.enabled !== 0,
    lastFiredAt: r.last_fired_at ?? null,
    updatedAt: r.updated_at ?? 0,
  }
}

@Injectable()
export class StoreService implements OnModuleInit {
  private readonly logger = new Logger(StoreService.name)
  private db: Database.Database
  private encKey: Buffer

  constructor(private config: ConfigService) {}

  onModuleInit() {
    const dbPath = this.config.get<string>('storePath')
    const dir = path.dirname(dbPath)

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      this.logger.log(`Created store directory: ${dir}`)
    }

    this.db = new (Database as any)(dbPath)
    this.encKey = this.deriveKey()
    this.initSchema()
    this.logger.log(`Store initialized at ${dbPath}`)
  }

  // ── Derive encryption key from machine identifiers ──────────────────────────
  // In Docker: set MACHINE_ID env var to a stable string — it takes priority.
  // Without it, key is derived from hostname+platform+CPU (fine on bare metal,
  // unstable in containers where these values can change on recreate).
  private deriveKey(): Buffer {
    const machineId = process.env.MACHINE_ID
    if (machineId) {
      return crypto.createHash('sha256').update(`gatelynk-edge:${machineId}`).digest()
    }
    const hostname = os.hostname()
    const platform = os.platform()
    const cpus = os.cpus()[0]?.model ?? 'unknown'
    const seed = `gatelynk-edge:${hostname}:${platform}:${cpus}`
    return crypto.createHash('sha256').update(seed).digest()
  }

  // ── Schema ───────────────────────────────────────────────────────────────────
  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_queue (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts   INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS device_config (
        device_id TEXT PRIMARY KEY,
        type      TEXT NOT NULL,
        config    TEXT NOT NULL,
        enabled   INTEGER DEFAULT 1,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lpr_plates (
        camera_device_id TEXT NOT NULL,
        plate            TEXT NOT NULL,
        owner            TEXT,
        valid_from       INTEGER,
        valid_until      INTEGER,
        updated_at       INTEGER NOT NULL,
        PRIMARY KEY (camera_device_id, plate)
      );

      CREATE INDEX IF NOT EXISTS lpr_plates_plate_idx ON lpr_plates (plate);

      -- LPR reads: every ANPR detection the camera reports, whether matched or not.
      -- Local buffer + source of truth for the Edge diagnostic panel; also async-
      -- synced to Cloud via tunnel.sendEvent('LPR_READ', …) with offline queue.
      -- Nightly cleanup keeps last 30 days (see sweepOldLprReads()).
      CREATE TABLE IF NOT EXISTS lpr_reads (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_device_id TEXT NOT NULL,
        plate            TEXT NOT NULL,        -- normalized: uppercase, [A-Z0-9]+
        matched          INTEGER NOT NULL,     -- 0/1: was on whitelist at read time
        owner            TEXT,                 -- snapshot at read time (matched only)
        gate_opened      INTEGER NOT NULL,     -- 0/1: did Edge actually trigger the relay
        reason           TEXT,                 -- 'ok' | 'not_whitelisted' | 'cooldown' |
                                               -- 'no_linked_intercom' | 'gate_error' |
                                               -- 'auto_open_disabled' | …
        confidence       REAL,
        direction        TEXT,                 -- 'in' | 'out' | null
        ts               INTEGER NOT NULL,     -- epoch ms
        synced_to_cloud  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS lpr_reads_plate_ts_idx   ON lpr_reads (plate, ts DESC);
      CREATE INDEX IF NOT EXISTS lpr_reads_cam_ts_idx     ON lpr_reads (camera_device_id, ts DESC);
      CREATE INDEX IF NOT EXISTS lpr_reads_matched_ts_idx ON lpr_reads (matched, ts DESC);
      CREATE INDEX IF NOT EXISTS lpr_reads_ts_idx         ON lpr_reads (ts);

      -- Goście (Faza 2B/3 Villa Natura). Cloud syncuje PIN-y zaproszonych
      -- gości tutaj przez tunel (PIN_UPSERT/PIN_DELETE), żeby Edge mógł sam
      -- walidować kod przy domofonie nawet w trybie offline. PIN jest
      -- skopny w obrębie budynku — różne budynki mogą mieć ten sam kod,
      -- ale w obrębie pojedynczego Edge zawsze unikalny (Cloud
      -- generateUniqueGuestPin gwarantuje unikalność per buildingId, a
      -- jeden Edge obsługuje jeden budynek).
      CREATE TABLE IF NOT EXISTS guest_pins (
        pin          TEXT PRIMARY KEY,
        guest_id     INTEGER NOT NULL,
        guest_name   TEXT,
        valid_from   INTEGER,
        valid_until  INTEGER,
        updated_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS guest_pins_guest_id_idx ON guest_pins (guest_id);

      -- ── Zużycie limitowanych otwarć gościa (2026-07-08) ──────────────────
      -- Edge liczy lokalnie użycia PIN/LPR (offline-first) — jedna linia na
      -- każde faktyczne otwarcie bramy przez gościa. Limit = COUNT(lokalne)
      -- + snapshot użyć portalowych z Cloud (guest_pins.cloud_uses).
      -- dedup_key (uuid) jedzie w evencie GUEST_ACCESS_USED do Cloud —
      -- retry z offline queue nie dubluje licznika po stronie Cloud.
      CREATE TABLE IF NOT EXISTS guest_uses (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        guest_id        INTEGER NOT NULL,
        access_point_id INTEGER,
        source          TEXT NOT NULL,          -- 'PIN' | 'LPR'
        dedup_key       TEXT UNIQUE,
        ts              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS guest_uses_guest_ap_idx ON guest_uses (guest_id, access_point_id);

      -- 2026-06-02 — RESIDENT_PIN: stały PIN mieszkańca (analogiczny do
      -- guest_pins ale nie wygasa). Mieszkaniec ustawia w iOS Profile, Edge
      -- cache otrzymuje przez tunnel RESIDENT_PIN_UPSERT. Lookup po pin
      -- (PRIMARY KEY) — keypad event musi szybko sprawdzić oba: guest_pins
      -- + resident_pins (kolejność: guest najpierw, resident drugi).
      CREATE TABLE IF NOT EXISTS resident_pins (
        pin            TEXT PRIMARY KEY,
        resident_id    INTEGER NOT NULL,
        resident_name  TEXT,
        updated_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resident_pins_resident_id_idx ON resident_pins (resident_id);

      -- ── Intercom bridge stations (multi-station, 2026-07-05) ─────────────
      -- Mirror rejestru stacji z Cloud (building_intercoms). Konfiguracja
      -- płynie WYŁĄCZNIE tunelem (INTERCOM_SYNC_ALL przy reconnect + live push
      -- z panelu Integratora) — żadnych ręcznych plików na Edge.
      -- IntercomCallService używa jej do:
      --   (a) mapowania SIP fromUri (IP Akuvoxa) → edge_device_id + nazwa
      --       stacji przy przychodzącym INVITE (Cloud dostaje UUID, nie URI),
      --   (b) rozwiązania IP stacji przy outbound (fallback po device_config),
      --   (c) filtrowania stacji bez aktywnego mostu (bridge_enabled=0).
      CREATE TABLE IF NOT EXISTS intercom_bridge (
        intercom_id     INTEGER PRIMARY KEY,   -- cloud building_intercoms.id (1:1)
        building_id     INTEGER NOT NULL,
        name            TEXT NOT NULL,
        edge_device_id  TEXT,                   -- device_config.device_id (UUID)
        ip_address      TEXT,                   -- LAN IP Akuvoxa (fallback gdy brak device_config)
        bridge_enabled  INTEGER NOT NULL DEFAULT 0,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS intercom_bridge_device_idx ON intercom_bridge (edge_device_id);

      -- ── Access Points (refactor 2026-06-01) ─────────────────────────────
      -- Mirror modelu AccessPoint z Cloud (Postgres). Edge dotąd nie miał
      -- własnej tabeli — punkty były wyłącznie konstruktem Cloud, a Edge
      -- routował LPR/PIN/manual open prosto do device-specific drivera
      -- (intercom.execute('OPEN_DOOR', ...)). Po refactorze AccessPoint to
      -- pierwsza klasa na Edge: trzyma binding output_device_uuid+output_index
      -- + scope + duration. AccessPointExecutor service rezolvuje driver przez
      -- OutputDriverRegistry (per device type) i wywołuje pulse.
      --
      -- id i building_id przychodzą z Cloud (1:1 mapping), żeby AccessEvent
      -- audit hook umiał odnieść się do tego samego ID na obu stronach.
      --
      -- Cloud syncuje przez AP_UPSERT / AP_DELETE / AP_SYNC_ALL message-types
      -- (tunnel). Przy reconnect WS Cloud wysyła pełny SYNC_ALL.
      CREATE TABLE IF NOT EXISTS access_points (
        id                  INTEGER PRIMARY KEY,            -- cloud AccessPoint.id (1:1)
        building_id         INTEGER NOT NULL,
        label               TEXT NOT NULL,
        icon                TEXT,
        scope               TEXT DEFAULT 'RESIDENT',        -- PUBLIC | RESIDENT | ADMIN_ONLY
        output_device_uuid  TEXT,                            -- device_config.device_id; NULL = AP nie skonfigurowany
        output_index        INTEGER,                         -- 0/1 dla Akuvox doorIndex, 1..n dla Hikvision I/O
        duration_ms         INTEGER DEFAULT 800,
        is_active           INTEGER DEFAULT 1,
        sort_order          INTEGER DEFAULT 0,
        legacy_device_id    TEXT,                            -- snapshot z fallback resolverem
        legacy_relay_index  INTEGER,
        updated_at          INTEGER NOT NULL
      );

      -- Listing dla executora i UI: aktywne, w kolejności sortOrder.
      CREATE INDEX IF NOT EXISTS access_points_active_sort_idx
        ON access_points (is_active, sort_order);

      -- ── Access Point Schedules (cron auto-open) ─────────────────────────
      -- Edge ScheduleService co minutę robi pełny scan enabled rzędów +
      -- parsuje cronExpr przez cron-parser. Drift > 2 min = nie wykonujemy
      -- retroaktywnie (cron jest "best effort", a nie task queue).
      --
      -- last_fired_at chroni przed double-fire w jednej minucie (ID-em okna
      -- jest pełna minuta — cron.nextOccurrence(lastFiredAt, now+5s)).
      CREATE TABLE IF NOT EXISTS access_point_schedules (
        id                INTEGER PRIMARY KEY,               -- cloud Schedule.id (1:1)
        access_point_id   INTEGER NOT NULL,
        cron_expr         TEXT NOT NULL,
        label             TEXT,
        enabled           INTEGER DEFAULT 1,
        last_fired_at     INTEGER,
        updated_at        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS access_point_schedules_enabled_idx
        ON access_point_schedules (enabled);
      CREATE INDEX IF NOT EXISTS access_point_schedules_ap_idx
        ON access_point_schedules (access_point_id);

      -- ── LPR Camera ↔ AccessPoint links (FAZA c, 2026-06-02) ─────────────
      -- Many-to-many: 1 kamera moze otwierac N punktow (rzadkie), a 1 punkt
      -- moze miec N kamer (typowo: jedna wjazdowa + jedna wyjazdowa dla tej
      -- samej bramy). direction rozroznia IN/OUT.
      --
      -- Cloud syncuje przez tunnel: LPR_AP_LINK_UPSERT / LPR_AP_LINK_DELETE /
      -- LPR_AP_LINK_SYNC_ALL. id przychodzi z Cloud (1:1 mapping z Postgres
      -- lpr_camera_ap_links.id) zeby audit/diagnostics byly spojne.
      --
      -- Edge HikvisionLprService przy match: szuka linkow po camera_device_uuid,
      -- iteruje liste i fire-uje kazdy AP (zwykle 1). Fallback na legacy
      -- (config.linkedAccessPointId) gdy brak linkow dla kamery.
      CREATE TABLE IF NOT EXISTS lpr_camera_ap_links (
        id                  INTEGER PRIMARY KEY,            -- cloud id (1:1)
        camera_device_uuid  TEXT NOT NULL,                   -- device_uuid z edge_device_mirror
        access_point_id     INTEGER NOT NULL,
        direction           TEXT NOT NULL DEFAULT 'IN',      -- 'IN' | 'OUT'
        building_id         INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        UNIQUE (camera_device_uuid, access_point_id)
      );

      CREATE INDEX IF NOT EXISTS lpr_cam_ap_links_camera_idx
        ON lpr_camera_ap_links (camera_device_uuid);
      CREATE INDEX IF NOT EXISTS lpr_cam_ap_links_ap_idx
        ON lpr_camera_ap_links (access_point_id);

      -- ── AI Engine config (FAZA 8.g, 2026-06-03) ──────────────────────────
      -- Single row per Edge (MVP założenie: 1 AI Engine per budynek = per Edge).
      -- Cloud syncuje przez AI_ENGINE_CONFIG_UPDATE tunnel command. Mirror
      -- konfiguracji jest niezbędny żeby VisionDetectService działał gdy Cloud
      -- jest offline (offline-first, jak guest_pins).
      --
      -- Auto-migration: przy starcie Edge, jeśli env YOLO_URL istnieje
      -- i tabela jest pusta — VisionDetectService inserts row z YOLO_URL.
      --
      -- Multi-engine w przyszłości — zdjąć INT PRIMARY KEY na fixed=1
      -- i dodać id FK do vision_detections.
      CREATE TABLE IF NOT EXISTS ai_engines (
        id              INTEGER PRIMARY KEY,         -- always 1 w MVP
        building_id     INTEGER NOT NULL,
        url             TEXT NOT NULL,                -- np. http://192.168.1.109:8080
        health_path     TEXT NOT NULL DEFAULT '/health',
        model           TEXT NOT NULL DEFAULT 'yolov8n',
        enabled         INTEGER NOT NULL DEFAULT 1,
        updated_at      INTEGER NOT NULL
      );

      -- Relay triggers: persistent log każdego wyzwolenia przekaźnika (otwarcia
      -- bramy/drzwi przez intercom). Source of truth dla wykresu „Triggery
      -- przekaźników (60 min)" + listy „ostatnie otwarcia" w panelu Monitoring.
      --
      -- Wcześniej liczyliśmy to w-pamięci w \`relay-counter.ts\` ale pm2 reload
      -- resetował licznik, przez co sparkline pokazywał mniej trigerów niż
      -- LPR reads (które są w sqlite od początku). Persystencja zrównuje
      -- semantykę z lpr_reads — oba przetrwają restart Edge.
      --
      -- 30-dniowe retention (analogicznie do lpr_reads, patrz sweepOldRelayTriggers).
      CREATE TABLE IF NOT EXISTS relay_triggers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id   TEXT NOT NULL,
        relay_index INTEGER NOT NULL,
        source      TEXT NOT NULL,       -- HTTP | PIN | HOLD_OPEN | LPR | OTHER
        ts          INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS relay_triggers_ts_idx          ON relay_triggers (ts);
      CREATE INDEX IF NOT EXISTS relay_triggers_device_ts_idx   ON relay_triggers (device_id, ts DESC);

      -- Event log (persistent business event audit trail). Wcześniej EventLogService
      -- trzymał tylko 500 wpisów w-pamięci i tracił je przy każdym pm2 reload.
      -- Teraz każde wywołanie eventLog.info/warn/… robi też INSERT tutaj, dzięki
      -- czemu panel /ui/logs ma „Pobierz logi z ostatnich 24h / 3d / 7d" działający
      -- przez restart Edge.
      --
      -- 7-dniowe retention (sweepOldEventLog) — wystarczy do diagnostyki + audytu;
      -- dłuższe archiwum trzyma Cloud (przez EventLog sync, jeśli będzie wdrożony).
      CREATE TABLE IF NOT EXISTS event_log (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       INTEGER NOT NULL,
        level    TEXT NOT NULL,        -- info | success | warning | error | debug
        category TEXT NOT NULL,        -- TUNNEL | RELAY | LPR | SYSTEM | HTTP | …
        message  TEXT NOT NULL,
        detail   TEXT                  -- JSON-stringified extras (truncated to 4 KB)
      );

      CREATE INDEX IF NOT EXISTS event_log_ts_idx       ON event_log (ts);
      CREATE INDEX IF NOT EXISTS event_log_level_ts_idx ON event_log (level, ts DESC);

      -- ────────────────────────────────────────────────────────────────
      -- Knowledge base (2026-05-18) — RAG repozytorium dla Edge LLM.
      -- Cloud syncuje docs przez KNOWLEDGE_UPSERT, Edge chunkuje + embeduje
      -- (bge-m3, 1024-dim) i zapisuje. LLM search tool przeszukuje semantycznie.
      -- ────────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        cloud_id      INTEGER PRIMARY KEY,         -- BuildingKnowledgeDoc.id z Cloud
        type          TEXT NOT NULL,                -- MESSENGER_CHAT | UCHWALA | REGULAMIN | KONTAKT | INNE
        title         TEXT NOT NULL,
        parsed_text   TEXT NOT NULL,                -- pełny content (po parsowaniu w Cloud)
        metadata      TEXT,                          -- JSON: participants/sections/itp.
        indexed_at    INTEGER,                       -- epoch ms gdy chunks+embeddings zostały wygenerowane
        chunk_count   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS knowledge_documents_type_idx ON knowledge_documents (type);

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id        INTEGER NOT NULL REFERENCES knowledge_documents(cloud_id) ON DELETE CASCADE,
        chunk_idx     INTEGER NOT NULL,             -- 0,1,2... w obrębie doc-a
        text          TEXT NOT NULL,                 -- fragmencik (~300 tokens / ~1200 znaków)
        embedding     BLOB NOT NULL,                 -- Float32Array packed: 1024 × 4 bytes = 4096 bytes
        UNIQUE(doc_id, chunk_idx)
      );
      CREATE INDEX IF NOT EXISTS knowledge_chunks_doc_idx ON knowledge_chunks (doc_id);

      -- ────────────────────────────────────────────────────────────────
      -- Vision detections (2026-05-19) — output z YOLO service na MacBook.
      -- Edge VisionDetectService co 60s robi snapshot każdej kamery, POST do
      -- http://192.168.1.109:11500/detect, summary trafia tutaj. Assistant
      -- (apps/ai-prototype) odpytuje tę tabelę dla pytań typu „ile osób dziś",
      -- „były psy w ostatniej godzinie".
      -- ────────────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS vision_detections (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        camera_device_id TEXT NOT NULL,         -- z device_config
        ts               INTEGER NOT NULL,       -- epoch ms gdy snapshot został wzięty
        inference_ms     INTEGER,                -- raw inference time z YOLO (debug/SLO)
        -- Summary: {"person":2,"car":1,"dog":1} — most queries pivot off this.
        -- Idziemy z JSON-string-em zamiast pivot-tabeli bo COCO ma 80 klas
        -- i ~75% snapshotów ma 0-2 unique klas — pivot byłby sparse.
        summary          TEXT NOT NULL,
        -- Pełna lista detekcji (lista boxes) — dla future use (heat-maps,
        -- per-class confidence sweeps). Czytane rzadko, więc TEXT nie BLOB.
        detections_json  TEXT,
        -- Optional: ścieżka do persisted frame (relative do visionFramesDir).
        -- Zachowywany TYLKO gdy summary zawiera person|dog (notable events) —
        -- inne klatki nie są warte miejsca.
        image_path       TEXT
      );

      CREATE INDEX IF NOT EXISTS vision_detections_ts_idx     ON vision_detections (ts DESC);
      CREATE INDEX IF NOT EXISTS vision_detections_cam_ts_idx ON vision_detections (camera_device_id, ts DESC);
    `)

    // SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS, so we
    // introspect the current schema and ADD columns only if missing. Keeps
    // initSchema() idempotent across upgrades.
    this.ensureColumns('lpr_reads', [
      { name: 'image_path',      ddl: 'TEXT' },  // path relative to lprSnapshotsDir() — '<ts>_<plate>.jpg'
      { name: 'vehicle_color',   ddl: 'TEXT' },  // white|black|red|blue|gray|yellow|green|brown|silver|…
      { name: 'vehicle_brand',   ddl: 'TEXT' },  // Audi|BMW|Toyota|…  (Hikvision logo library)
      { name: 'vehicle_type',    ddl: 'TEXT' },  // smallCar|SUV|van|truck|bus|motorcycle
      { name: 'vehicle_subtype', ddl: 'TEXT' },  // optional finer-grained type (firmware-dependent)
      // Privacy: kolumna unit_label trzyma adres lokalu (np. "Niewinna 6/1") zamiast
      // imienia i nazwiska mieszkańca. Cloud wysyła ją w PLATE_UPSERT payloadzie i
      // Edge kopiuje do lpr_reads przy match-u. To wartość, którą widzi instalator
      // w panelu Edge — bez danych osobowych. Pełne imię i nazwisko mieszkańca
      // pozostaje w Cloud DB i widać je tylko adminowi/konsjerżowi w panelu Cloud.
      { name: 'unit_label',      ddl: 'TEXT' },
      // Faza E1 (2026-05-15): metadata vehicle z Cloud Vehicle model.
      // `kind`  — 'RESIDENT' | 'SERVICE' | 'GUEST' (string enum, Edge nie validuje)
      // `tags`  — JSON string-array, np. '["Kurier","DPD","niebieski VAN"]'.
      //           Edge nie normalizuje ani nie filtruje — Cloud jest źródłem prawdy.
      //           Asystent AI używa tych tagów do odróżnienia kuriera od mieszkańca
      //           bez polegania na parse-owaniu legacy event_log message tekstów.
      { name: 'vehicle_kind',    ddl: 'TEXT' },
      { name: 'vehicle_tags',    ddl: 'TEXT' },
    ])
    // Ten sam pattern dla lpr_plates — przechowuje metadata per plate.
    // Pole `owner` (full name) zostaje w schemie żeby nie zerwać backwards-compat
    // z starym PLATE_UPSERT, ale Edge UI go już NIE pokazuje (privacy).
    this.ensureColumns('lpr_plates', [
      { name: 'unit_label',      ddl: 'TEXT' },
      { name: 'vehicle_kind',    ddl: 'TEXT' },
      { name: 'vehicle_tags',    ddl: 'TEXT' },     // JSON string-array
      // 2026-07-08 — tablica GOŚCIA: id gościa z Cloud. Flow LPR sprawdza
      // po nim ograniczenia (harmonogram/limit/allowlista AP) w guest_pins.
      // NULL = pojazd mieszkańca/serwisu (bez ograniczeń gościa).
      { name: 'guest_id',        ddl: 'INTEGER' },
      // 2026-09-25 — przełącznik mieszkańca „otwieraj bramę po rozpoznaniu".
      // 0 = tablica ZNANA (odczyt, historia, push), ale Edge NIE wyzwala
      // przekaźnika (reason `auto_open_disabled`). NULL/1 = otwieraj
      // (stare wpisy i Cloud bez pola zachowują się jak dotąd).
      { name: 'auto_open',       ddl: 'INTEGER' },
    ])
    // ── Ograniczenia dostępu gościa (2026-07-08) — kolumny na guest_pins ──
    // Cloud śle w PIN_UPSERT/PIN_SYNC_ALL; Edge waliduje OFFLINE:
    //   allowed_aps — JSON [{apId, maxUses?}] lub NULL (bez ograniczeń)
    //   schedule    — JSON {days,startTime,endTime,tz} lub NULL (całe okno)
    //   cloud_uses  — JSON {"<apId>": n} — snapshot użyć PORTALOWYCH z Cloud
    //                 (użycia PIN/LPR liczymy lokalnie w guest_uses).
    this.ensureColumns('guest_pins', [
      { name: 'allowed_aps', ddl: 'TEXT' },
      { name: 'schedule',    ddl: 'TEXT' },
      { name: 'cloud_uses',  ddl: 'TEXT' },
    ])

    // ── Brand detection (2026-05-19) ────────────────────────────────────
    // YOLO + EasyOCR pipeline na MacBook zwraca top-level brand detected.
    // Edge zapisuje per detection-row żeby Assistant mógł zapytać „czy
    // widziałeś dziś DHL". Sparse — większość frame'ów brand_detected=NULL.
    this.ensureColumns('vision_detections', [
      { name: 'brand_detected', ddl: 'TEXT' },     // canonical UPPERCASE: DHL/DPD/…
      { name: 'brand_conf',     ddl: 'REAL' },     // 0..1 z EasyOCR
      { name: 'text_raw',       ddl: 'TEXT' },     // JSON string-array (wszystkie OCR boxes)
    ])
    // Partial index — sparse, tylko brand!=NULL rows (ok 1-5% wszystkich
    // detections w typowym dniu wg POC). Drastycznie tańszy niż full index
    // bo Assistant queries zawsze filtrują `brand_detected = ?`.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS vision_brand_ts_idx
        ON vision_detections (brand_detected, ts DESC)
        WHERE brand_detected IS NOT NULL;
    `)

    // ── Waste-truck detection (2026-05-19) ──────────────────────────────
    // Polish municipal collection — same EasyOCR pipeline jako brand, ale
    // szukamy napisów SZKŁO / ZMIESZANE / PAPIER / PLASTIK / BIO + operator
    // (REMONDIS/STENA/…). YOLO klasyfikuje śmieciarki jako 'truck' (COCO
    // nie ma dedykowanej klasy), więc match-ujemy tylko truck-bbox-y.
    // Mieszkańcy pytają np. „czy odebrali dziś szkło?" — query po
    // waste_category. Ekstremalnie sparse — typowo 0-2 rows/dzień na budynek
    // (śmieciarka przyjeżdża 1-2x dziennie), więc partial index per category.
    this.ensureColumns('vision_detections', [
      { name: 'waste_category', ddl: 'TEXT' },     // GLASS|PAPER|PLASTIC|BIO|MIXED
      { name: 'waste_conf',     ddl: 'REAL' },     // 0..1 z EasyOCR
      { name: 'waste_operator', ddl: 'TEXT' },     // REMONDIS|STENA|ZGOK|… lub NULL
    ])
    // Partial index — analogicznie do brand. Filtrowanie po
    // waste_category jest jedyną drogą zapytań Asystenta, więc index
    // pokrywa też porządkowanie (waste_category, ts DESC).
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS vision_waste_ts_idx
        ON vision_detections (waste_category, ts DESC)
        WHERE waste_category IS NOT NULL;
    `)

    // ── Anomaly detection (fall / niebezpieczne) — 2026-05-23 ──────────
    // YOLOv8-pose heurystyka geometryczna na keypoints (głowa/biodra/ramiona).
    // Sparse: typowo 0-5 wpisów/dzień z anomaly_type != NULL. Partial index
    // gwarantuje że list-anomalies query (np. "ostatnie upadki") nie scanuje
    // tysięcy normalnych klatek.
    this.ensureColumns('vision_detections', [
      // 'FALL' (upadek) | NULL. Future: 'VIOLENCE' | 'INTRUSION' | 'CROWD'
      { name: 'anomaly_type', ddl: 'TEXT' },
      // 0.0-1.0 likelihood z heurystyki. Threshold dla alarmu zwykle ≥0.5
      // (≥2 z 4 indikatorów — horizontal_bbox + head_below_hips, itp.).
      { name: 'fall_likelihood', ddl: 'REAL' },
      // Lista indikatorów które się odpaliły (JSON: ["horizontal_bbox","head_below_hips"]).
      // Pomocne w debugowaniu false-positive ("dlaczego AI uznał że ktoś leży?").
      { name: 'anomaly_indicators', ddl: 'TEXT' },
    ])
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS vision_anomaly_ts_idx
        ON vision_detections (ts DESC)
        WHERE anomaly_type IS NOT NULL;
    `)

    // ── LLM summary per notable frame (2026-05-22) ──────────────────────
    // Krótka polska narracja generowana przez LLM (Ollama qwen2.5:14b) tylko
    // dla NOTABLE detection rows: person/dog w summary, lub brand_detected
    // != NULL, lub waste_category != NULL. Większość klatek (puste / tylko
    // car/truck bez brand) ma NULL — workier nie woła Ollama, oszczędza ~3s
    // per skip.
    //
    // Zapisywane przez VisionLlmSummarizerService cron co 30s. UI BA Vision
    // page wyświetla w kolumnie „Summary" obok thumbnail-a.
    //
    // Sparse — typowo 5-20 rows/h, więc partial index po (ts DESC) gdy
    // llm_summary NOT NULL daje fast "pokaż 10 ostatnich z opisem".
    this.ensureColumns('vision_detections', [
      { name: 'llm_summary', ddl: 'TEXT' },
    ])
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS vision_llm_summary_ts_idx
        ON vision_detections (ts DESC)
        WHERE llm_summary IS NOT NULL;
    `)

    // 2026-08-14 — atrybuty pojazdu z VLM (qwen2.5vl na Mac Studio): typ
    // semantyczny (osobowy/dostawczy/ciezarowka/bus/maszyna), marka i kolor
    // głównego pojazdu w klatce. Leczy mylenie klas COCO (van→bus, SUV→truck).
    this.ensureColumns('vision_detections', [
      { name: 'vehicle_kind', ddl: 'TEXT' },
      { name: 'vehicle_make', ddl: 'TEXT' },
      { name: 'vehicle_color', ddl: 'TEXT' },
    ])

    // 2026-08-15 — korelacja wizji z rejestrem tablic: OCR wizji złapał
    // tablicę znaną osiedlu (pojazd/gość) → zapisujemy tablicę + etykietę.
    this.ensureColumns('vision_detections', [
      { name: 'plate_matched', ddl: 'TEXT' },
      { name: 'plate_match_label', ddl: 'TEXT' },
    ])

    // ── Zdarzenia sytuacyjne (2026-08-26) ───────────────────────────────
    // Warstwa korelacji NAD pojedynczymi klatkami/odczytami: sekwencje
    // sklejane w zdarzenia (tailgating, krążący pojazd, osoba w nocy,
    // wizyta kuriera od–do, potwierdzony upadek). Wypełnia
    // SituationCorrelatorService tick co 60 s; czyta panel/asystent/Kronika.
    // dedup_key gwarantuje idempotencję ticków (INSERT OR IGNORE) —
    // korelator za każdym razem rekonstruuje epizody z okna wstecz.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS situation_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        type             TEXT NOT NULL,       -- TAILGATING|VEHICLE_LOITERING|VEHICLE_WAITING|NIGHT_PERSON|COURIER_VISIT|FALL_CONFIRMED
        camera_device_id TEXT,
        started_ts       INTEGER NOT NULL,    -- epoch ms początku epizodu
        ended_ts         INTEGER,             -- epoch ms końca (zdarzenia punktowe = started_ts)
        confidence       TEXT NOT NULL DEFAULT 'OBSERVED',  -- OBSERVED|INFERRED
        title            TEXT NOT NULL,       -- deterministyczny opis PL
        details_json     TEXT,                -- plate/brand/kind/color/counts…
        evidence_json    TEXT,                -- [{src:'vision'|'lpr', id}] max ~10
        dedup_key        TEXT,                -- np. 'TAILGATE:<cam>:<readId>'
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS situation_events_ts_idx
        ON situation_events (started_ts DESC);
      CREATE INDEX IF NOT EXISTS situation_events_type_ts_idx
        ON situation_events (type, started_ts DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS situation_events_dedup_idx
        ON situation_events (dedup_key)
        WHERE dedup_key IS NOT NULL;
    `)
    // 2026-09-01 — „VLM-detektyw": krótki opis sceny z qwen2.5vl (Mac Studio)
    // dla zdarzeń z kadrem dowodowym; przy upadkach niesie też werdykt bramki.
    this.ensureColumns('situation_events', [
      { name: 'vlm_note', ddl: 'TEXT' },
    ])

    // FAZA c (2026-06-02) — AccessPoint.category. Idempotent — istniejące
    // Edge bez tej kolumny dostaną 'MAIN_ENTRY' default po migracji.
    this.ensureColumns('access_points', [
      { name: 'category', ddl: "TEXT NOT NULL DEFAULT 'MAIN_ENTRY'" },
    ])

    // FAZA 8.h (2026-06-03) — Camera role + per-camera AI toggle. Cloud
    // wysyła przez `CAMERA_CONFIG_UPDATE`. Edge filtruje vision-detect cycle
    // po `ai_analysis_enabled = 1` (default ON). `role` to STANDARD|LPR;
    // używane głównie przez UI Cloud, Edge nie zmienia behaviour-u (LPR ANPR
    // i tak nie odpala się gdy kamera nie raportuje plate eventów).
    //
    // Domyślne wartości backwards-compat: AI ON + LPR (wszystkie istniejące
    // wpisy device_config były „LPR-like").
    // FAZA 8.h.7 (2026-06-08) — LLM config w ai_engines (rozszerzenie 8.g).
    // LLM (Ollama) jest niezależny od YOLO ale konfigurowany razem (1 row
    // per Edge = 1 YOLO + 1 LLM). VisionLlmSummarizerService czyta dynamicznie.
    this.ensureColumns('ai_engines', [
      { name: 'llm_url',       ddl: 'TEXT' },
      { name: 'llm_model',     ddl: "TEXT NOT NULL DEFAULT 'qwen2.5:14b'" },
      { name: 'llm_enabled',   ddl: 'INTEGER NOT NULL DEFAULT 1' },
    ])
    this.ensureColumns('device_config', [
      { name: 'ai_analysis_enabled', ddl: 'INTEGER NOT NULL DEFAULT 1' },
      { name: 'role',                ddl: "TEXT NOT NULL DEFAULT 'LPR'" },
    ])

    // ── Przepustki wyjazdowe (exit grace pass, 2026-07-30) ───────────────
    // docs/exit-grace-pass.md. Pojazd SPOZA whitelisty który wjechał (kamera
    // IN, no-match) dostaje efemeryczną przepustkę na wyjazd (okno z
    // Building.features.exitGrace, default 15 min). Kamera OUT przy no-match
    // konsumuje ją (single-use). Edge obsługuje 1 budynek → plate PK
    // wystarcza; nowy wjazd tej samej tablicy nadpisuje starszy pass
    // (INSERT OR REPLACE). RODO: wiersze efemeryczne — zużyte/wygasłe
    // sprzątane po 24 h (exitPassSweep w retentionSweep cron).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exit_passes (
        plate_norm        TEXT PRIMARY KEY,     -- normalized: uppercase, [A-Z0-9]+
        entered_at        INTEGER NOT NULL,     -- epoch ms wjazdu (LPR no-match dir=IN)
        expires_at        INTEGER NOT NULL,     -- entered_at + okno (minutes z configu)
        camera_device_id  TEXT NOT NULL,        -- kamera IN która widziała wjazd
        used_at           INTEGER,              -- epoch ms zużycia przy wyjeździe (NULL = aktywna)
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS exit_passes_expires_idx ON exit_passes (expires_at);
    `)
  }

  /**
   * Add missing columns to `table`. `better-sqlite3` lets us query PRAGMA
   * synchronously so this runs on boot with no extra round-trips. Used as a
   * tiny migration helper until we outgrow hand-rolled schemas.
   */
  private ensureColumns(table: string, cols: { name: string; ddl: string }[]) {
    const existing = new Set<string>(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(r => r.name),
    )
    for (const c of cols) {
      if (!existing.has(c.name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${c.name} ${c.ddl}`)
        this.logger.log(`Schema: added ${table}.${c.name}`)
      }
    }
  }

  /**
   * Absolute path to the directory where ANPR snapshots are stored. Sits next
   * to store.db (same `data/` dir) so `pm2 reload` / container restarts keep
   * them. Created on demand — callers don't need to ensure it themselves.
   */
  lprSnapshotsDir(): string {
    const dbPath = this.config.get<string>('storePath')
    const dir = path.join(path.dirname(dbPath), 'lpr-snapshots')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  /**
   * Where VisionDetectService stores notable frames (person|dog detected).
   * Lives next to store.db so reloads keep history. Same on-demand mkdir
   * pattern as `lprSnapshotsDir()`.
   */
  visionFramesDir(): string {
    const dbPath = this.config.get<string>('storePath')
    const dir = path.join(path.dirname(dbPath), 'vision-frames')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  /**
   * Bezpieczna kopia sqlite (live DB) do osobnego pliku.
   *
   * `VACUUM INTO` to sqlite-native sposób eksportu spójnej kopii — nie wymaga
   * zatrzymywania zapisów ani close-open cykli. Działa równolegle z normalnymi
   * INSERT/SELECT z Edge service'ów.
   *
   * Używane przez `/api/system/backup` endpoint — backup ma być on-demand,
   * stateless, bez konieczności ubijania pm2 procesu.
   */
  exportBackup(destPath: string): void {
    // Defensive — usuń ewentualny stary plik z poprzedniej iteracji
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath) } catch { /* ignore */ }
    this.db.prepare(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`).run()
  }

  /** Path do source store.db (np. żeby tar tworzyć ścieżki relatywne). */
  storePath(): string {
    return this.config.get<string>('storePath')
  }

  // ── LPR plates (local whitelist) ─────────────────────────────────────────────
  /**
   * Upsert plate w lokalnej whitelist. Cloud wysyła pełne metadata przez
   * PLATE_UPSERT — Edge zapisuje 1:1 do `lpr_plates`. Pola:
   *   `owner`     — legacy (PII), Edge UI nie pokazuje, zostawione dla compat
   *   `unitLabel` — adres lokalu np. „Niewinna 6/1" (privacy-safe)
   *   `kind`      — RESIDENT | SERVICE | GUEST
   *   `tags`      — JSON string-array (np. `["Kurier","DPD"]`)
   */
  lprUpsertPlate(
    cameraDeviceId: string,
    plate: string,
    opts: {
      owner?: string | null
      validFrom?: number | null
      validUntil?: number | null
      unitLabel?: string | null
      kind?: string | null
      tags?: string[] | null
      /** 2026-07-08 — id gościa (Cloud) dla tablic gości; NULL dla pojazdów. */
      guestId?: number | null
      /** 2026-09-25 — false = rozpoznaj, ale NIE otwieraj. Brak pola = otwieraj. */
      autoOpen?: boolean | null
    } = {},
  ) {
    const tagsJson = Array.isArray(opts.tags) && opts.tags.length > 0
      ? JSON.stringify(opts.tags)
      : null
    this.db
      .prepare(
        `INSERT OR REPLACE INTO lpr_plates
          (camera_device_id, plate, owner, valid_from, valid_until, unit_label,
           vehicle_kind, vehicle_tags, guest_id, auto_open, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cameraDeviceId, plate,
        opts.owner ?? null,
        opts.validFrom ?? null,
        opts.validUntil ?? null,
        opts.unitLabel ?? null,
        opts.kind ?? null,
        tagsJson,
        opts.guestId ?? null,
        opts.autoOpen === false ? 0 : 1,
        Date.now(),
      )
  }

  lprDeletePlate(cameraDeviceId: string, plate: string): number {
    const info = this.db
      .prepare('DELETE FROM lpr_plates WHERE camera_device_id = ? AND plate = ?')
      .run(cameraDeviceId, plate)
    return info.changes
  }

  /**
   * Wipe every plate associated with a camera — called when a camera is
   * removed from the device registry so its whitelist doesn't linger as
   * orphaned rows. Returns number of rows removed.
   */
  lprDeleteAllForCamera(cameraDeviceId: string): number {
    const info = this.db
      .prepare('DELETE FROM lpr_plates WHERE camera_device_id = ?')
      .run(cameraDeviceId)
    return info.changes
  }

  lprListPlates(cameraDeviceId: string): {
    plate: string
    /** Privacy-safe identyfikator lokalu (np. "Niewinna 6/1"). */
    unitLabel: string | null
    /** RESIDENT | SERVICE | GUEST | null (legacy data). */
    kind: string | null
    /** Tagi z panelu Cloud BA (np. ["Kurier","DPD"]). */
    tags: string[]
    validFrom: number | null
    validUntil: number | null
    /** false = mieszkaniec wyłączył automatyczne otwieranie dla tej tablicy. */
    autoOpen: boolean
  }[] {
    // PRIVACY: kolumna `owner` celowo nie jest selektowana — Edge UI nie powinno
    // pokazywać imienia/nazwiska mieszkańca instalatorowi.
    const rows = this.db
      .prepare(
        `SELECT plate, valid_from, valid_until, unit_label, vehicle_kind, vehicle_tags, auto_open
           FROM lpr_plates WHERE camera_device_id = ? ORDER BY plate`,
      )
      .all(cameraDeviceId) as any[]
    return rows.map(r => ({
      plate: r.plate,
      unitLabel: r.unit_label,
      kind: r.vehicle_kind,
      tags: parseTags(r.vehicle_tags),
      validFrom: r.valid_from,
      validUntil: r.valid_until,
      autoOpen: autoOpenFromRow(r.auto_open),
    }))
  }

  /**
   * Match plate against the whitelist for this camera. Returns the matching row
   * with full metadata, or null if not found / expired / not yet valid.
   */
  lprMatchPlate(cameraDeviceId: string, plate: string): {
    plate: string
    owner: string | null
    unitLabel: string | null
    kind: string | null
    tags: string[]
    /** id gościa (Cloud) — flow LPR sprawdza po nim ograniczenia gościa. */
    guestId: number | null
    /** 2026-09-25 — false = tablica znana, ale mieszkaniec wyłączył
     *  automatyczne otwieranie (Edge NIE wyzwala przekaźnika). */
    autoOpen: boolean
  } | null {
    const row = this.db
      .prepare(
        `SELECT plate, owner, valid_from, valid_until, unit_label, vehicle_kind, vehicle_tags, guest_id, auto_open
           FROM lpr_plates WHERE camera_device_id = ? AND plate = ?`,
      )
      .get(cameraDeviceId, plate) as any
    if (!row) return null
    const now = Date.now()
    if (row.valid_from && now < row.valid_from) return null
    if (row.valid_until && now > row.valid_until) return null
    return {
      plate: row.plate,
      owner: row.owner,
      unitLabel: row.unit_label,
      kind: row.vehicle_kind,
      tags: parseTags(row.vehicle_tags),
      guestId: row.guest_id ?? null,
      autoOpen: autoOpenFromRow(row.auto_open),
    }
  }

  /**
   * Wpis rejestru dla tablicy NIEZALEŻNIE od kamery (2026-08-15) —
   * `lpr_plates` jest duplikowane per kamera LPR, a korelacja wizji pyta
   * „czy osiedle ZNA tę tablicę" (kamera wizyjna nie ma własnej whitelisty).
   * Respektuje okno ważności (goście).
   */
  plateInfoAnyCamera(plate: string): {
    plate: string
    owner: string | null
    unitLabel: string | null
    kind: string | null
    guestId: number | null
  } | null {
    const row = this.db
      .prepare(
        `SELECT plate, owner, valid_from, valid_until, unit_label, vehicle_kind, guest_id
           FROM lpr_plates WHERE plate = ? LIMIT 1`,
      )
      .get(plate) as any
    if (!row) return null
    const now = Date.now()
    if (row.valid_from && now < row.valid_from) return null
    if (row.valid_until && now > row.valid_until) return null
    return {
      plate: row.plate,
      owner: row.owner,
      unitLabel: row.unit_label,
      kind: row.vehicle_kind,
      guestId: row.guest_id ?? null,
    }
  }

  /**
   * Statystyki powtarzalności NIEZAREJESTROWANYCH tablic (2026-08-15) —
   * baza pod sugestie „to prawdopodobnie mieszkaniec". Grupujemy odczyty
   * z ostatnich `sinceDays` dni po tablicy, POMIJAJĄC tablice obecne
   * w rejestrze (lpr_plates = pojazdy + aktywni goście). Dni liczone
   * w strefie lokalnej Edge'a (Mac Mini stoi na osiedlu).
   */
  lprPlateSuggestionStats(opts: { sinceDays?: number; minActiveDays?: number } = {}): Array<{
    plate: string
    reads: number
    activeDays: number
    ins: number
    outs: number
    firstSeen: number
    lastSeen: number
    avgInHour: number | null
    avgOutHour: number | null
  }> {
    const sinceDays = Math.min(Math.max(opts.sinceDays ?? 30, 3), 90)
    const minActiveDays = Math.min(Math.max(opts.minActiveDays ?? 3, 2), 30)
    const sinceMs = Date.now() - sinceDays * 86_400_000
    return this.db
      .prepare(
        `SELECT plate,
                COUNT(*) AS reads,
                COUNT(DISTINCT date(ts/1000,'unixepoch','localtime')) AS activeDays,
                SUM(CASE WHEN direction = 'IN' THEN 1 ELSE 0 END) AS ins,
                SUM(CASE WHEN direction = 'OUT' THEN 1 ELSE 0 END) AS outs,
                MIN(ts) AS firstSeen,
                MAX(ts) AS lastSeen,
                AVG(CASE WHEN direction = 'IN'
                    THEN CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER)
                    END) AS avgInHour,
                AVG(CASE WHEN direction = 'OUT'
                    THEN CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER)
                    END) AS avgOutHour
           FROM lpr_reads
          WHERE ts >= ?
            AND length(plate) >= 5
            -- Placeholdery kamer gdy tablica nieodczytana — to nie pojazdy.
            AND plate NOT IN ('UNKNOWN', 'NOLICENSE', 'NOPLATE', 'NONE')
            AND plate NOT IN (SELECT DISTINCT plate FROM lpr_plates)
          GROUP BY plate
         HAVING activeDays >= ?
          ORDER BY activeDays DESC, reads DESC
          LIMIT 50`,
      )
      .all(sinceMs, minActiveDays) as any[]
  }

  lprReplaceAll(cameraDeviceId: string, plates: {
    plate: string
    owner?: string | null
    validFrom?: number | null
    validUntil?: number | null
    unitLabel?: string | null
    kind?: string | null
    tags?: string[] | null
    guestId?: number | null
    autoOpen?: boolean | null
  }[]) {
    const tx = this.db.transaction((rows: typeof plates) => {
      this.db.prepare('DELETE FROM lpr_plates WHERE camera_device_id = ?').run(cameraDeviceId)
      const stmt = this.db.prepare(
        `INSERT INTO lpr_plates
           (camera_device_id, plate, owner, valid_from, valid_until, unit_label,
            vehicle_kind, vehicle_tags, guest_id, auto_open, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const now = Date.now()
      for (const r of rows) {
        const tagsJson = Array.isArray(r.tags) && r.tags.length > 0 ? JSON.stringify(r.tags) : null
        stmt.run(
          cameraDeviceId, r.plate,
          r.owner ?? null,
          r.validFrom ?? null,
          r.validUntil ?? null,
          r.unitLabel ?? null,
          r.kind ?? null,
          tagsJson,
          r.guestId ?? null,
          r.autoOpen === false ? 0 : 1,
          now,
        )
      }
    })
    tx(plates)
  }

  // ── Guest PINs (lokalne źródło prawdy dla domofonu) ─────────────────────────
  /**
   * Upsert PIN-u gościa. Wywoływane gdy z Cloud przyjdzie `PIN_UPSERT` przez
   * tunel (mieszkaniec/portier dodał albo zedytował zaproszenie). Stare okno
   * czasowe nadpisujemy — Cloud i tak resyncuje pełen stan po `PIN_SYNC_ALL`
   * przy reconnect.
   */
  guestPinUpsert(
    pin: string,
    guestId: number,
    guestName: string | null,
    validFrom: number | null,
    validUntil: number | null,
    restrictions?: {
      /** JSON string [{apId, maxUses?}] lub null. */
      allowedAps?: string | null
      /** JSON string {days,startTime,endTime,tz} lub null. */
      schedule?: string | null
      /** JSON string {"<apId>": n} — snapshot użyć PORTALOWYCH z Cloud. */
      cloudUses?: string | null
    },
  ) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO guest_pins
           (pin, guest_id, guest_name, valid_from, valid_until,
            allowed_aps, schedule, cloud_uses, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pin, guestId, guestName ?? null, validFrom ?? null, validUntil ?? null,
        restrictions?.allowedAps ?? null,
        restrictions?.schedule ?? null,
        restrictions?.cloudUses ?? null,
        Date.now(),
      )
  }

  /**
   * Skasowanie PIN-u — wywoływane gdy Cloud wyśle `PIN_DELETE` (gość
   * skasowany / anulowany / wygaszony przez crona). Brak rzędu = no-op,
   * zwracamy `false`, żeby caller mógł zalogować "nic do skasowania".
   */
  guestPinDelete(pin: string): boolean {
    // Sprzątamy też lokalne liczniki użyć (gość skasowany/anulowany).
    const row = this.db.prepare('SELECT guest_id FROM guest_pins WHERE pin = ?').get(pin) as any
    const info = this.db.prepare('DELETE FROM guest_pins WHERE pin = ?').run(pin)
    if (row?.guest_id) this.guestUsesDeleteByGuest(row.guest_id)
    return info.changes > 0
  }

  /**
   * Skasowanie po `guestId` — używane gdy Cloud wyśle DELETE bez znajomości
   * starego PIN-u (np. cron expiry zna tylko id). Zwraca liczbę usuniętych
   * (zwykle 0 lub 1, ale teoretycznie wiele jeśli backfill miał duplikaty).
   */
  guestPinDeleteByGuest(guestId: number): number {
    const info = this.db.prepare('DELETE FROM guest_pins WHERE guest_id = ?').run(guestId)
    this.guestUsesDeleteByGuest(guestId)
    return info.changes
  }

  /**
   * Lookup PIN-u — używane przez controller `/akuvox/event` po naciśnięciu
   * kodu na klawiaturze domofonu. Zwraca `null` gdy:
   *   • PIN nie istnieje
   *   • PIN jest poza oknem `valid_from..valid_until`
   * Jeśli rzeczywiście jest valid → zwracamy guestId/guestName, żeby Edge
   * mógł wysłać `GUEST_PIN_USED` event do Cloud (audyt + push do mieszkańca).
   */
  guestPinMatch(pin: string): {
    guestId: number
    guestName: string | null
    allowedAps: string | null
    schedule: string | null
    cloudUses: string | null
  } | null {
    const row = this.db
      .prepare(
        `SELECT guest_id, guest_name, valid_from, valid_until,
                allowed_aps, schedule, cloud_uses
           FROM guest_pins WHERE pin = ?`,
      )
      .get(pin) as any
    if (!row) return null
    const now = Date.now()
    if (row.valid_from && now < row.valid_from) return null
    if (row.valid_until && now > row.valid_until) return null
    return {
      guestId: row.guest_id,
      guestName: row.guest_name,
      allowedAps: row.allowed_aps ?? null,
      schedule: row.schedule ?? null,
      cloudUses: row.cloud_uses ?? null,
    }
  }

  /**
   * Ograniczenia gościa po guestId — używane w flow LPR (tablica gościa ma
   * `lpr_plates.guest_id`, a ograniczenia żyją na guest_pins; 1 gość = 1 PIN).
   * NULL gdy gość nieznany (np. PIN skasowany) — wtedy traktujemy jak brak
   * ograniczeń żeby nie blokować legacy flow.
   */
  guestRestrictionsByGuestId(guestId: number): {
    allowedAps: string | null
    schedule: string | null
    cloudUses: string | null
  } | null {
    const row = this.db
      .prepare('SELECT allowed_aps, schedule, cloud_uses FROM guest_pins WHERE guest_id = ? LIMIT 1')
      .get(guestId) as any
    if (!row) return null
    return {
      allowedAps: row.allowed_aps ?? null,
      schedule: row.schedule ?? null,
      cloudUses: row.cloud_uses ?? null,
    }
  }

  // ── Guest uses (lokalne zliczanie limitowanych otwarć, 2026-07-08) ──────────

  /** Zapis użycia (PIN/LPR). dedupKey = uuid — jedzie też do Cloud w evencie. */
  guestUseRecord(guestId: number, accessPointId: number | null, source: 'PIN' | 'LPR', dedupKey: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO guest_uses (guest_id, access_point_id, source, dedup_key, ts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(guestId, accessPointId ?? null, source, dedupKey, Date.now())
  }

  /**
   * Ile razy gość użył danego AP lokalnie (PIN+LPR na tym Edge).
   * `accessPointId=null` → wszystkie użycia gościa (fallback gdy AP nieznany).
   */
  guestUseCountLocal(guestId: number, accessPointId: number | null): number {
    if (accessPointId === null) {
      const r = this.db
        .prepare('SELECT COUNT(*) AS c FROM guest_uses WHERE guest_id = ?')
        .get(guestId) as any
      return r.c as number
    }
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM guest_uses WHERE guest_id = ? AND access_point_id = ?')
      .get(guestId, accessPointId) as any
    return r.c as number
  }

  /** Sprzątanie po skasowanym gościu (PIN_DELETE) — liczniki nie wiszą wiecznie. */
  guestUsesDeleteByGuest(guestId: number): number {
    const info = this.db.prepare('DELETE FROM guest_uses WHERE guest_id = ?').run(guestId)
    return info.changes
  }

  /**
   * Lista wszystkich PIN-ów — używane do pełnego resync (PIN_SYNC_ALL diff)
   * i do panelu diagnostycznego "ile gości ma aktywne kody".
   */
  guestPinList(): Array<{ pin: string; guestId: number; guestName: string | null; validFrom: number | null; validUntil: number | null }> {
    const rows = this.db
      .prepare('SELECT pin, guest_id, guest_name, valid_from, valid_until FROM guest_pins ORDER BY pin')
      .all() as any[]
    return rows.map(r => ({
      pin: r.pin,
      guestId: r.guest_id,
      guestName: r.guest_name,
      validFrom: r.valid_from,
      validUntil: r.valid_until,
    }))
  }

  /**
   * Atomicznie zastępuje cały zestaw PIN-ów — używane przy `PIN_SYNC_ALL`
   * po reconnect tunelu. Gwarantuje że Edge nie ma „zostałych po starym
   * stanie" PIN-ów których Cloud już skasowała przy offline.
   */
  guestPinReplaceAll(rows: Array<{
    pin: string
    guestId: number
    guestName?: string | null
    validFrom?: number | null
    validUntil?: number | null
    allowedAps?: string | null
    schedule?: string | null
    cloudUses?: string | null
  }>) {
    const tx = this.db.transaction((items: typeof rows) => {
      this.db.prepare('DELETE FROM guest_pins').run()
      const stmt = this.db.prepare(
        `INSERT INTO guest_pins
           (pin, guest_id, guest_name, valid_from, valid_until,
            allowed_aps, schedule, cloud_uses, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const now = Date.now()
      for (const r of items) {
        stmt.run(
          r.pin, r.guestId, r.guestName ?? null, r.validFrom ?? null, r.validUntil ?? null,
          r.allowedAps ?? null, r.schedule ?? null, r.cloudUses ?? null, now,
        )
      }
      // Goście spoza nowego stanu → ich lokalne liczniki użyć są martwe.
      this.db.prepare(
        'DELETE FROM guest_uses WHERE guest_id NOT IN (SELECT guest_id FROM guest_pins)',
      ).run()
    })
    tx(rows)
  }

  guestPinCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM guest_pins').get() as any).c as number
  }

  // ── Resident PINs (2026-06-02 — stały PIN mieszkańca) ──────────────────────
  /**
   * Upsert/replace PIN-u mieszkańca. Tunnel `RESIDENT_PIN_UPSERT` wywołuje to
   * po tym jak mieszkaniec zapisze nowy PIN w iOS Profile. Trzymamy PIN jako
   * PRIMARY KEY żeby lookup był O(1) — keypad event sprawdza guest_pins +
   * resident_pins w jednym Akuvox callbacku.
   *
   * Jeśli mieszkaniec ZMIENIA PIN: Cloud najpierw wysyła RESIDENT_PIN_DELETE
   * dla starego (gdy known), potem RESIDENT_PIN_UPSERT z nowym. W praktyce
   * Cloud może wysłać tylko UPSERT z nowym PIN — wtedy stary może wisieć
   * jako orphan. Dlatego DELETE po `resident_id` (niżej) usuwa wszystkie
   * stare wpisy.
   */
  residentPinUpsert(pin: string, residentId: number, residentName: string | null) {
    // Najpierw usuń stary PIN tego mieszkańca (gdy zmienił PIN).
    this.db.prepare('DELETE FROM resident_pins WHERE resident_id = ?').run(residentId)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO resident_pins
           (pin, resident_id, resident_name, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(pin, residentId, residentName ?? null, Date.now())
  }

  /** Usunięcie wszystkich PIN-ów mieszkańca (przy DELETE z Cloud). */
  residentPinDeleteByResident(residentId: number): number {
    const info = this.db.prepare('DELETE FROM resident_pins WHERE resident_id = ?').run(residentId)
    return info.changes
  }

  /**
   * Lookup — wywoływane z AkuvoxEventController po naciśnięciu PIN-u na
   * klawiaturze. Zwraca null gdy PIN nieznany.
   */
  residentPinMatch(pin: string): { residentId: number; residentName: string | null } | null {
    const row = this.db
      .prepare('SELECT resident_id, resident_name FROM resident_pins WHERE pin = ?')
      .get(pin) as any
    if (!row) return null
    return { residentId: row.resident_id, residentName: row.resident_name }
  }

  /** Pełen sync — wywołuje TunnelService z RESIDENT_PIN_SYNC_ALL przy reconnect. */
  residentPinReplaceAll(rows: Array<{ pin: string; residentId: number; residentName?: string | null }>) {
    const tx = this.db.transaction((items: typeof rows) => {
      this.db.prepare('DELETE FROM resident_pins').run()
      const stmt = this.db.prepare(
        `INSERT INTO resident_pins (pin, resident_id, resident_name, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      const now = Date.now()
      for (const r of items) {
        stmt.run(r.pin, r.residentId, r.residentName ?? null, now)
      }
    })
    tx(rows)
  }

  residentPinCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM resident_pins').get() as any).c as number
  }

  // ── Intercom bridge stations (multi-station, 2026-07-05) ────────────────────

  /** Kształt wiersza rejestru stacji (mirror building_intercoms z Cloud). */
  intercomBridgeList(): Array<{
    intercomId: number
    buildingId: number
    name: string
    edgeDeviceId: string | null
    ipAddress: string | null
    bridgeEnabled: boolean
  }> {
    const rows = this.db
      .prepare('SELECT * FROM intercom_bridge ORDER BY intercom_id ASC')
      .all() as any[]
    return rows.map((r) => ({
      intercomId: r.intercom_id,
      buildingId: r.building_id,
      name: r.name,
      edgeDeviceId: r.edge_device_id ?? null,
      ipAddress: r.ip_address ?? null,
      bridgeEnabled: r.bridge_enabled === 1,
    }))
  }

  /**
   * Pełen replace rejestru stacji — wywołuje TunnelService z INTERCOM_SYNC_ALL
   * (reconnect + live push po edycji w panelu Integratora). Transakcja
   * DELETE+INSERT jak residentPinReplaceAll.
   */
  intercomBridgeReplaceAll(rows: Array<{
    intercomId: number
    buildingId?: number
    name?: string | null
    edgeDeviceId?: string | null
    ipAddress?: string | null
    bridgeEnabled?: boolean
  }>) {
    const tx = this.db.transaction((items: typeof rows) => {
      this.db.prepare('DELETE FROM intercom_bridge').run()
      const stmt = this.db.prepare(
        `INSERT INTO intercom_bridge
           (intercom_id, building_id, name, edge_device_id, ip_address, bridge_enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      const now = Date.now()
      for (const r of items) {
        if (!Number.isFinite(r.intercomId) || r.intercomId <= 0) continue
        stmt.run(
          r.intercomId,
          r.buildingId ?? 0,
          r.name ?? `Domofon #${r.intercomId}`,
          r.edgeDeviceId ?? null,
          r.ipAddress ?? null,
          r.bridgeEnabled ? 1 : 0,
          now,
        )
      }
    })
    tx(rows)
  }

  // ── Access Points (refactor 2026-06-01) ─────────────────────────────────────
  /**
   * Upsert AccessPoint row z Cloud. Wywołanie z TunnelService po
   * AP_UPSERT / AP_SYNC_ALL. ID przychodzi z Cloud — 1:1 mapping, żeby
   * AccessEvent audit hook umiał odnieść się do tego samego apId
   * z Cloud DB.
   */
  apsUpsert(row: {
    id: number
    buildingId: number
    label: string
    icon?: string | null
    scope?: string | null
    category?: string | null
    outputDeviceUuid?: string | null
    outputIndex?: number | null
    durationMs?: number | null
    isActive?: boolean | number | null
    sortOrder?: number | null
    legacyDeviceId?: string | null
    legacyRelayIndex?: number | null
  }) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO access_points
           (id, building_id, label, icon, scope, category, output_device_uuid, output_index,
            duration_ms, is_active, sort_order, legacy_device_id, legacy_relay_index, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.buildingId,
        row.label,
        row.icon ?? null,
        row.scope ?? 'RESIDENT',
        row.category ?? 'MAIN_ENTRY',
        row.outputDeviceUuid ?? null,
        row.outputIndex ?? null,
        row.durationMs ?? 800,
        row.isActive === false ? 0 : 1,
        row.sortOrder ?? 0,
        row.legacyDeviceId ?? null,
        row.legacyRelayIndex ?? null,
        Date.now(),
      )
  }

  apsDelete(id: number): boolean {
    const info = this.db.prepare('DELETE FROM access_points WHERE id = ?').run(id)
    // kaskadowo czyścimy schedules (FK constraints nie używamy w sqlite tutaj)
    this.db.prepare('DELETE FROM access_point_schedules WHERE access_point_id = ?').run(id)
    return info.changes > 0
  }

  apsGetById(id: number): AccessPointRow | null {
    const row = this.db
      .prepare(
        `SELECT id, building_id, label, icon, scope, category, output_device_uuid, output_index,
                duration_ms, is_active, sort_order, legacy_device_id, legacy_relay_index, updated_at
           FROM access_points WHERE id = ?`,
      )
      .get(id) as any
    if (!row) return null
    return mapApRow(row)
  }

  apsList(): AccessPointRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, building_id, label, icon, scope, category, output_device_uuid, output_index,
                duration_ms, is_active, sort_order, legacy_device_id, legacy_relay_index, updated_at
           FROM access_points
          ORDER BY sort_order ASC, id ASC`,
      )
      .all() as any[]
    return rows.map(mapApRow)
  }

  /**
   * Atomicznie zastępuje cały zestaw AP — używane przy AP_SYNC_ALL po
   * reconnect tunelu. Gwarantuje że Edge nie ma „zostałych po starym
   * stanie" rzędów których Cloud już skasowała.
   */
  apsReplaceAll(rows: Array<Parameters<StoreService['apsUpsert']>[0]>) {
    const tx = this.db.transaction((items: typeof rows) => {
      this.db.prepare('DELETE FROM access_points').run()
      for (const r of items) {
        this.apsUpsert(r)
      }
    })
    tx(rows)
  }

  // ── Access Point Schedules ─────────────────────────────────────────────────
  /**
   * Upsert harmonogramu. Cloud syncuje przez SCHEDULE_UPSERT.
   * `lastFiredAt` jest opcjonalne (Cloud może je nadpisać po explicit reset
   * przez admina, ale standardowo zostawia jak jest — Edge sam zarządza).
   */
  apsScheduleUpsert(row: {
    id: number
    accessPointId: number
    cronExpr: string
    label?: string | null
    enabled?: boolean | number | null
    lastFiredAt?: number | null
  }) {
    // Lokalnie zachowujemy stary lastFiredAt jeśli Cloud go nie wysyła
    // (Cloud nie przesyła tego pola w standardowym sync, bo to lokalna
    // semantyka Edge). Dlatego jeśli `lastFiredAt` jest undefined w argumencie
    // → czytamy ze starego rzędu.
    let lastFired: number | null = row.lastFiredAt ?? null
    if (row.lastFiredAt === undefined) {
      const old = this.db
        .prepare('SELECT last_fired_at FROM access_point_schedules WHERE id = ?')
        .get(row.id) as any
      lastFired = old?.last_fired_at ?? null
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO access_point_schedules
           (id, access_point_id, cron_expr, label, enabled, last_fired_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.accessPointId,
        row.cronExpr,
        row.label ?? null,
        row.enabled === false ? 0 : 1,
        lastFired,
        Date.now(),
      )
  }

  apsScheduleDelete(id: number): boolean {
    const info = this.db
      .prepare('DELETE FROM access_point_schedules WHERE id = ?')
      .run(id)
    return info.changes > 0
  }

  apsScheduleListEnabled(): AccessPointScheduleRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, access_point_id, cron_expr, label, enabled, last_fired_at, updated_at
           FROM access_point_schedules
          WHERE enabled = 1`,
      )
      .all() as any[]
    return rows.map(mapApScheduleRow)
  }

  apsScheduleListByAp(accessPointId: number): AccessPointScheduleRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, access_point_id, cron_expr, label, enabled, last_fired_at, updated_at
           FROM access_point_schedules
          WHERE access_point_id = ?
          ORDER BY id ASC`,
      )
      .all(accessPointId) as any[]
    return rows.map(mapApScheduleRow)
  }

  apsMarkScheduleFired(id: number, ts: number) {
    this.db
      .prepare(
        `UPDATE access_point_schedules
            SET last_fired_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(ts, Date.now(), id)
  }

  /**
   * Atomicznie zastępuje cały zestaw schedules — używane przy
   * SCHEDULE_SYNC_ALL po reconnect tunelu. Zachowujemy lastFiredAt
   * dla każdego id które już mamy (per-row, nie globalnie), żeby
   * reconnect nie powodował podwójnego odpalenia cron-a.
   */
  apsScheduleReplaceAll(rows: Array<Parameters<StoreService['apsScheduleUpsert']>[0]>) {
    const tx = this.db.transaction((items: typeof rows) => {
      // Snapshot starych lastFiredAt → przeniesiemy do nowych rzędów
      const oldLastFired = new Map<number, number | null>(
        (this.db.prepare('SELECT id, last_fired_at FROM access_point_schedules').all() as any[])
          .map(r => [r.id as number, (r.last_fired_at as number | null) ?? null]),
      )
      this.db.prepare('DELETE FROM access_point_schedules').run()
      for (const r of items) {
        const preserved = oldLastFired.get(r.id)
        this.apsScheduleUpsert({
          ...r,
          lastFiredAt: r.lastFiredAt !== undefined ? r.lastFiredAt : (preserved ?? null),
        })
      }
    })
    tx(rows)
  }

  // ── LPR Camera → AccessPoint links (FAZA c, 2026-06-02) ─────────────────────
  /**
   * Upsert linka kamera→AP. Cloud syncuje przez LPR_AP_LINK_UPSERT — id z Cloud.
   */
  lprApLinkUpsert(row: {
    id: number
    cameraDeviceUuid: string
    accessPointId: number
    direction?: string | null
    buildingId: number
  }) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO lpr_camera_ap_links
           (id, camera_device_uuid, access_point_id, direction, building_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.cameraDeviceUuid,
        row.accessPointId,
        row.direction ?? 'IN',
        row.buildingId,
        Date.now(),
      )
  }

  lprApLinkDelete(id: number): boolean {
    const info = this.db
      .prepare('DELETE FROM lpr_camera_ap_links WHERE id = ?')
      .run(id)
    return info.changes > 0
  }

  /**
   * Semantyczny kierunek odczytu LPR: 'IN' (wjazd) / 'OUT' (wyjazd) / null.
   *
   * Cloud używa go m.in. do pushy „gość wjechał/wyjechał" — natywny kierunek
   * z kamery (forward/reverse) jest względem OBIEKTYWU, nie bramy, a na
   * kamerach bez ANPR (Edge-OCR) nie ma go wcale. Kolejność źródeł:
   *   1. linki kamera→AP (lpr_camera_ap_links.direction) — jeśli wszystkie
   *      linki kamery mają TEN SAM kierunek, jest autorytatywny;
   *   2. natywny forward/reverse: domyślnie forward=IN (pojazd zbliża się
   *      do kamery przy wjeździe), reverse=OUT; jeśli montaż jest odwrotny,
   *      w configu kamery można ustawić `directionForwardIsOut: true`;
   *   3. nazwa kamery („Kamera wyjazd" → OUT, „Kamera Wjazd" → IN) — tak
   *      instalator nazywa kamery na osiedlach z osobną kamerą per brama;
   *   4. null — Cloud traktuje jak dotychczas (bez rozróżnienia).
   */
  lprSemanticDirection(cameraDeviceUuid: string, nativeDirection?: string | null): 'IN' | 'OUT' | null {
    const links = this.lprApLinksForCamera(cameraDeviceUuid)
    const dirs = [...new Set(links.map((l) => String(l.direction ?? '').toUpperCase()).filter((d) => d === 'IN' || d === 'OUT'))]
    if (dirs.length === 1) return dirs[0] as 'IN' | 'OUT'

    const cfg = (this.getDeviceConfigs().find((c) => c.deviceId === cameraDeviceUuid)?.config ?? {}) as any

    const native = String(nativeDirection ?? '').toLowerCase()
    if (native === 'forward' || native === 'reverse') {
      const forwardIsOut = cfg.directionForwardIsOut === true
      const forward: 'IN' | 'OUT' = forwardIsOut ? 'OUT' : 'IN'
      const reverse: 'IN' | 'OUT' = forwardIsOut ? 'IN' : 'OUT'
      return native === 'forward' ? forward : reverse
    }

    const name = String(cfg.name ?? '').toLowerCase()
    if (/wyjazd|exit/.test(name)) return 'OUT'
    if (/wjazd|wjezd|entry/.test(name)) return 'IN'
    return null
  }

  /**
   * Lista linków dla danej kamery — używana przy match LPR.
   * `HikvisionLprService` iteruje po wyniku i fire-uje każdy AP.
   */
  lprApLinksForCamera(cameraDeviceUuid: string): LprCameraApLinkRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, camera_device_uuid, access_point_id, direction, building_id, updated_at
           FROM lpr_camera_ap_links
          WHERE camera_device_uuid = ?
          ORDER BY id ASC`,
      )
      .all(cameraDeviceUuid) as any[]
    return rows.map(mapLprApLinkRow)
  }

  lprApLinksAll(): LprCameraApLinkRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, camera_device_uuid, access_point_id, direction, building_id, updated_at
           FROM lpr_camera_ap_links
          ORDER BY id ASC`,
      )
      .all() as any[]
    return rows.map(mapLprApLinkRow)
  }

  /** Atomicznie zastępuje wszystkie linki (LPR_AP_LINK_SYNC_ALL po reconnect). */
  lprApLinksReplaceAll(rows: Array<Parameters<StoreService['lprApLinkUpsert']>[0]>) {
    const tx = this.db.transaction((items: typeof rows) => {
      this.db.prepare('DELETE FROM lpr_camera_ap_links').run()
      for (const r of items) {
        this.lprApLinkUpsert(r)
      }
    })
    tx(rows)
  }

  // ── Exit passes — przepustki wyjazdowe (2026-07-30) ─────────────────────────
  //
  // docs/exit-grace-pass.md. CRUD wołany WYŁĄCZNIE z HikvisionLprService
  // (ścieżka no-match) — żadnych odczytów w konstruktorach (pułapka #18).

  /**
   * Upsert przepustki przy wjeździe (LPR no-match, kamera z linkami dir=IN).
   * INSERT OR REPLACE — nowy wjazd tej samej tablicy nadpisuje starszy pass
   * (w tym zużyty: used_at wraca do NULL, okno liczy się od nowa).
   */
  exitPassUpsert(plateNorm: string, enteredAt: number, expiresAt: number, cameraDeviceId: string) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO exit_passes
           (plate_norm, entered_at, expires_at, camera_device_id, used_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(plateNorm, enteredAt, expiresAt, cameraDeviceId, Date.now())
  }

  /** Pass dla tablicy (dokładne dopasowanie po normalizacji) albo null. */
  exitPassGet(plateNorm: string): {
    plate: string
    enteredAt: number
    expiresAt: number
    cameraDeviceId: string
    usedAt: number | null
  } | null {
    const row = this.db
      .prepare(
        `SELECT plate_norm, entered_at, expires_at, camera_device_id, used_at
           FROM exit_passes WHERE plate_norm = ?`,
      )
      .get(plateNorm) as any
    if (!row) return null
    return {
      plate: row.plate_norm,
      enteredAt: row.entered_at,
      expiresAt: row.expires_at,
      cameraDeviceId: row.camera_device_id,
      usedAt: row.used_at ?? null,
    }
  }

  /** Oznacz pass jako zużyty (single-use). Zwraca true gdy wiersz istniał. */
  exitPassMarkUsed(plateNorm: string, usedAtMs: number): boolean {
    const info = this.db
      .prepare('UPDATE exit_passes SET used_at = ?, updated_at = ? WHERE plate_norm = ?')
      .run(usedAtMs, Date.now(), plateNorm)
    return info.changes > 0
  }

  /**
   * Tablice AKTYWNYCH przepustek (nie zużyte) — do near-miss warninga
   * (Levenshtein 1, tylko log). Tabela jest malutka (sprzątana po 24 h),
   * pełny SELECT jest tani.
   */
  exitPassActivePlates(): string[] {
    const rows = this.db
      .prepare('SELECT plate_norm FROM exit_passes WHERE used_at IS NULL')
      .all() as any[]
    return rows.map((r) => r.plate_norm as string)
  }

  /**
   * Sprzątanie: kasuje passy wygasłe LUB zużyte przed `cutoffMs`
   * (typowo now-24h — RODO: wpisy efemeryczne). Zwraca liczbę usuniętych.
   */
  exitPassSweep(cutoffMs: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM exit_passes
          WHERE expires_at < ?
             OR (used_at IS NOT NULL AND used_at < ?)`,
      )
      .run(cutoffMs, cutoffMs)
    return info.changes
  }

  // ── Building config (BUILDING_CONFIG_UPDATE consumer, 2026-07-30) ───────────
  /**
   * Konfiguracja budynku zapisana przez tunnel `BUILDING_CONFIG_UPDATE`
   * (kv key `building:<id>:config`, encrypted). Edge obsługuje 1 budynek —
   * bierzemy pierwszy pasujący klucz. Zwraca sparsowany `{objectType,
   * features}` albo null (brak wpisu / klucz z innej maszyny — patrz
   * poisonedKeys w `get`).
   *
   * Pierwszy realny konsument tego payloadu: HikvisionLprService czyta
   * `features.exitGrace` (przepustka wyjazdowa).
   */
  buildingConfigGet(): { objectType?: string; features?: Record<string, any> } | null {
    const rows = this.db
      .prepare(`SELECT key FROM kv WHERE key LIKE 'building:%:config' ORDER BY key LIMIT 5`)
      .all() as Array<{ key: string }>
    for (const r of rows) {
      const raw = this.get(r.key)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') return parsed
      } catch {
        this.logger.warn(`buildingConfigGet: invalid JSON under ${r.key} — ignoring`)
      }
    }
    return null
  }

  // ── AI Engine config (FAZA 8.g, 2026-06-03) ─────────────────────────────────
  /**
   * Pobierz aktualnie skonfigurowany AI Engine. Zwraca null jeśli nie ma
   * żadnej konfiguracji — wywołujący (VisionDetectService) zwraca wtedy
   * `false` z runCycle bez wołania YOLO.
   */
  aiEngineGet(): {
    id: number
    buildingId: number
    url: string
    healthPath: string
    model: string
    enabled: boolean
    llmUrl: string | null
    llmModel: string
    llmEnabled: boolean
    updatedAt: number
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, building_id, url, health_path, model, enabled,
                llm_url, llm_model, llm_enabled,
                updated_at
           FROM ai_engines WHERE id = 1`,
      )
      .get() as any
    if (!row) return null
    return {
      id: row.id,
      buildingId: row.building_id,
      url: String(row.url ?? '').replace(/\/+$/, ''),
      healthPath: String(row.health_path ?? '/health'),
      model: String(row.model ?? 'yolov8n'),
      enabled: row.enabled !== 0,
      llmUrl: row.llm_url ? String(row.llm_url).replace(/\/+$/, '') : null,
      llmModel: String(row.llm_model ?? 'qwen2.5:14b'),
      llmEnabled: row.llm_enabled !== 0,
      updatedAt: row.updated_at ?? 0,
    }
  }

  /**
   * Upsert konfiguracji AI Engine. Wywoływane przez TunnelService po
   * AI_ENGINE_CONFIG_UPDATE z Cloud. Hard-coded id=1 — MVP: jeden engine
   * per Edge.
   *
   * FAZA 8.h.7 (2026-06-08) — partial update: pola undefined zachowują
   * istniejącą wartość (idempotent). Pozwala edytować TYLKO LLM bez resetu
   * URL/healthPath/model itd. (np. z Edge UI sekcja LLM).
   */
  aiEngineUpsert(row: {
    buildingId: number
    url: string
    healthPath?: string | null
    model?: string | null
    enabled?: boolean | number | null
    llmUrl?: string | null
    llmModel?: string | null
    llmEnabled?: boolean | number | null
  }) {
    const cleanedUrl = String(row.url ?? '').trim().replace(/\/+$/, '')
    if (!cleanedUrl) throw new Error('aiEngineUpsert: empty url')
    const existing = this.aiEngineGet()
    const llmUrl = row.llmUrl !== undefined
      ? (row.llmUrl ? String(row.llmUrl).trim().replace(/\/+$/, '') : null)
      : (existing?.llmUrl ?? null)
    const llmModel = row.llmModel !== undefined
      ? (String(row.llmModel).trim() || 'qwen2.5:14b')
      : (existing?.llmModel ?? 'qwen2.5:14b')
    const llmEnabled = row.llmEnabled !== undefined
      ? (row.llmEnabled === false || row.llmEnabled === 0 ? 0 : 1)
      : (existing?.llmEnabled === false ? 0 : 1)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ai_engines
           (id, building_id, url, health_path, model, enabled,
            llm_url, llm_model, llm_enabled,
            updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.buildingId,
        cleanedUrl,
        typeof row.healthPath === 'string' && row.healthPath.length > 0 ? row.healthPath : '/health',
        typeof row.model === 'string' && row.model.length > 0 ? row.model : 'yolov8n',
        row.enabled === false ? 0 : 1,
        llmUrl,
        llmModel,
        llmEnabled,
        Date.now(),
      )
  }

  /**
   * Skasowanie konfiguracji. Cloud może wysłać AI_ENGINE_CONFIG_UPDATE
   * z `enabled=false` żeby tylko wyłączyć bez kasowania URL — to jest
   * preferowana ścieżka. Delete jest tu dla testów/cleanup.
   */
  aiEngineDelete(): boolean {
    const info = this.db.prepare('DELETE FROM ai_engines WHERE id = 1').run()
    return info.changes > 0
  }

  // ── LPR reads (local audit trail) ────────────────────────────────────────────
  /**
   * Insert a single read. Called from `handleAnprEvent` after the gate decision
   * is made (i.e. we know `matched` and `gateOpened`). Returns the new row id
   * so the caller can pass it through to the Cloud sync event for dedup.
   */
  lprInsertRead(row: {
    cameraDeviceId: string
    plate: string
    matched: boolean
    owner?: string | null
    gateOpened: boolean
    reason?: string | null
    confidence?: number | null
    direction?: string | null
    imagePath?: string | null
    vehicleColor?: string | null
    vehicleBrand?: string | null
    vehicleType?: string | null
    vehicleSubtype?: string | null
    /** Privacy-safe identyfikator lokalu z `lpr_plates.unit_label` (np. "Niewinna 6/1"). */
    unitLabel?: string | null
    /** Snapshot z lpr_plates.vehicle_kind (RESIDENT/SERVICE/GUEST). */
    kind?: string | null
    /** Snapshot z lpr_plates.vehicle_tags (np. ["Kurier","DPD"]). */
    tags?: string[] | null
    ts?: number
  }): number {
    const ts = row.ts ?? Date.now()
    const tagsJson = Array.isArray(row.tags) && row.tags.length > 0 ? JSON.stringify(row.tags) : null
    const info = this.db
      .prepare(
        `INSERT INTO lpr_reads
           (camera_device_id, plate, matched, owner, gate_opened, reason,
            confidence, direction, ts,
            image_path, vehicle_color, vehicle_brand, vehicle_type, vehicle_subtype,
            unit_label, vehicle_kind, vehicle_tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.cameraDeviceId,
        row.plate,
        row.matched ? 1 : 0,
        row.owner ?? null,
        row.gateOpened ? 1 : 0,
        row.reason ?? null,
        row.confidence ?? null,
        row.direction ?? null,
        ts,
        row.imagePath ?? null,
        row.vehicleColor ?? null,
        row.vehicleBrand ?? null,
        row.vehicleType ?? null,
        row.vehicleSubtype ?? null,
        row.unitLabel ?? null,
        row.kind ?? null,
        tagsJson,
      )
    return Number(info.lastInsertRowid)
  }

  /**
   * Retrieve a single read by id — used by `GET /lpr/reads/:id/image` to look
   * up the stored snapshot filename. Kept separate from `lprListReads` so
   * callers don't have to filter by unique id on an already-paginated query.
   */
  lprGetRead(id: number): {
    id: number; cameraDeviceId: string; plate: string; imagePath: string | null; ts: number
  } | null {
    const r = this.db
      .prepare('SELECT id, camera_device_id, plate, image_path, ts FROM lpr_reads WHERE id = ?')
      .get(id) as any
    if (!r) return null
    return { id: r.id, cameraDeviceId: r.camera_device_id, plate: r.plate, imagePath: r.image_path, ts: r.ts }
  }

  /**
   * List reads for a camera, newest first. Supports filtering by plate substring
   * (case-insensitive) and by matched/unmatched. Used by the Edge panel modal.
   */
  lprListReads(
    cameraDeviceId: string,
    opts: { plate?: string; matched?: boolean; limit?: number } = {},
  ): Array<{
    id: number; plate: string; matched: boolean;
    unitLabel: string | null;
    gateOpened: boolean; reason: string | null; confidence: number | null;
    direction: string | null; ts: number;
    imagePath: string | null; vehicleColor: string | null;
    vehicleBrand: string | null; vehicleType: string | null; vehicleSubtype: string | null
  }> {
    const limit = Math.min(opts.limit ?? 200, 1000)
    const clauses: string[] = ['camera_device_id = ?']
    const params: any[] = [cameraDeviceId]

    if (opts.plate && opts.plate.trim().length > 0) {
      // Search is intentionally substring (LIKE '%X%') — user often remembers
      // only part of a plate ("na WA123…"). Normalised to same shape as stored.
      const p = opts.plate.toUpperCase().replace(/[^A-Z0-9]/g, '')
      clauses.push('plate LIKE ?')
      params.push(`%${p}%`)
    }
    if (opts.matched !== undefined) {
      clauses.push('matched = ?')
      params.push(opts.matched ? 1 : 0)
    }
    params.push(limit)

    // PRIVACY: nie selectujemy kolumny `owner` — instalator nie powinien widzieć
    // imienia i nazwiska mieszkańca. Zamiast tego zwracamy `unit_label` (np.
    // "Niewinna 6/1"). Stara kolumna `owner` zostaje w schemie dla backwards-compat
    // z legacy syncem i danych pre-privacy, ale jest niewidoczna przez API.
    const rows = this.db
      .prepare(
        `SELECT id, plate, matched, unit_label, gate_opened, reason, confidence, direction, ts,
                image_path, vehicle_color, vehicle_brand, vehicle_type, vehicle_subtype
           FROM lpr_reads
          WHERE ${clauses.join(' AND ')}
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(...params) as any[]

    return rows.map(r => ({
      id: r.id,
      plate: r.plate,
      matched: !!r.matched,
      unitLabel: r.unit_label,
      gateOpened: !!r.gate_opened,
      reason: r.reason,
      confidence: r.confidence,
      direction: r.direction,
      ts: r.ts,
      imagePath: r.image_path,
      vehicleColor: r.vehicle_color,
      vehicleBrand: r.vehicle_brand,
      vehicleType: r.vehicle_type,
      vehicleSubtype: r.vehicle_subtype,
    }))
  }

  /**
   * Liczy LPR-odczyty w przedziale `[sinceMs, untilMs)` — używane przez
   * MetricsService do generowania sparkline „odczyty LPR" co 60s. Indeks
   * `lpr_reads_ts_idx` zapewnia O(log n) lookup.
   */
  lprCountInWindow(sinceMs: number, untilMs: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM lpr_reads WHERE ts >= ? AND ts < ?')
      .get(sinceMs, untilMs) as { c: number }
    return r?.c ?? 0
  }

  /**
   * Lista ostatnich N odczytów ze WSZYSTKICH kamer (cross-camera feed).
   *
   * Używane przez:
   *  • `GET /api/metrics/recent-lpr-reads` — lekka wersja dla Monitoring sparkline,
   *  • `GET /lpr/reads` — pełny widok zakładki „Odczyty LPR" z filtrami.
   *
   * Opcje:
   *  • `plate` — substring search (case-insensitive, non-alphanumerics stripped)
   *  • `matched` — true/false/undefined (no filter)
   *  • `cameraDeviceId` — exact match jednej kamery (gdy chcesz zawęzić)
   *  • `limit` — 1..1000 (default 50, clamped)
   */
  lprListRecentAll(opts: {
    plate?: string
    matched?: boolean
    cameraDeviceId?: string
    limit?: number
  } = {}): Array<{
    id: number
    cameraDeviceId: string
    plate: string
    matched: boolean
    /** Privacy-safe: zawsze zwracamy `unit_label` (np. "Niewinna 6/1"), nigdy
     *  `owner` (imię nazwisko). Patrz docstring kolumny `unit_label`. */
    unitLabel: string | null
    /** RESIDENT | SERVICE | GUEST | null (legacy data). Z Cloud Vehicle.kind. */
    kind: string | null
    /** Tagi z Cloud Vehicle.tags (np. ["Kurier","DPD"]). Pusty array gdy brak. */
    tags: string[]
    gateOpened: boolean
    reason: string | null
    confidence: number | null
    direction: string | null
    ts: number
    imagePath: string | null
    vehicleColor: string | null
    vehicleBrand: string | null
    vehicleType: string | null
    vehicleSubtype: string | null
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000)
    const clauses: string[] = []
    const params: any[] = []

    if (opts.cameraDeviceId) {
      clauses.push('camera_device_id = ?')
      params.push(opts.cameraDeviceId)
    }
    if (opts.plate && opts.plate.trim().length > 0) {
      const p = opts.plate.toUpperCase().replace(/[^A-Z0-9]/g, '')
      clauses.push('plate LIKE ?')
      params.push(`%${p}%`)
    }
    if (opts.matched !== undefined) {
      clauses.push('matched = ?')
      params.push(opts.matched ? 1 : 0)
    }
    params.push(limit)

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    // PRIVACY: kolumna `owner` (full name) JEST w schemie ale celowo wyłączona
    // z SELECT — instalator nie powinien jej widzieć. Patrz ADR w docstringu
    // kolumny `unit_label` w `initSchema`.
    const rows = this.db
      .prepare(
        `SELECT id, camera_device_id, plate, matched, unit_label, gate_opened, reason,
                confidence, direction, ts,
                image_path, vehicle_color, vehicle_brand, vehicle_type, vehicle_subtype,
                vehicle_kind, vehicle_tags
           FROM lpr_reads
           ${where}
           ORDER BY ts DESC
           LIMIT ?`,
      )
      .all(...params) as any[]

    return rows.map(r => ({
      id: r.id,
      cameraDeviceId: r.camera_device_id,
      plate: r.plate,
      matched: !!r.matched,
      unitLabel: r.unit_label,
      kind: r.vehicle_kind,
      tags: parseTags(r.vehicle_tags),
      gateOpened: !!r.gate_opened,
      reason: r.reason,
      confidence: r.confidence,
      direction: r.direction,
      ts: r.ts,
      imagePath: r.image_path,
      vehicleColor: r.vehicle_color,
      vehicleBrand: r.vehicle_brand,
      vehicleType: r.vehicle_type,
      vehicleSubtype: r.vehicle_subtype,
    }))
  }

  /**
   * Delete reads older than `cutoffMs`. Returns deleted count.
   * Called by the nightly cleanup cron (30-day retention on Edge).
   */
  lprSweepOldReads(cutoffMs: number): number {
    const info = this.db.prepare('DELETE FROM lpr_reads WHERE ts < ?').run(cutoffMs)
    return info.changes
  }

  // ── Relay triggers (persistent log każdego otwarcia) ─────────────────────────

  /** Zapisz jedno wyzwolenie przekaźnika. Wywołuje `IntercomService.openDoor`. */
  relayTriggerInsert(deviceId: string, relayIndex: number, source: string, ts?: number): void {
    this.db
      .prepare('INSERT INTO relay_triggers (device_id, relay_index, source, ts) VALUES (?, ?, ?, ?)')
      .run(deviceId, relayIndex, source, ts ?? Date.now())
  }

  /**
   * Liczba trigerów w oknie `[sinceMs, untilMs)`. Dla sparkline w MetricsService.
   * Indeks `relay_triggers_ts_idx` zapewnia O(log n) lookup.
   */
  relayTriggerCountInWindow(sinceMs: number, untilMs: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS c FROM relay_triggers WHERE ts >= ? AND ts < ?')
      .get(sinceMs, untilMs) as { c: number }
    return r?.c ?? 0
  }

  /**
   * Lista trigerów relay z opcjonalnym time-range i source filter, z czytelną
   * nazwą urządzenia (LEFT JOIN z `device_config`).
   *
   * Wcześniejsza wersja brała top N po `id` i filtrowała po `ts` w JS — to
   * subtelny bug: jeśli w danym dniu jest 200 LPR-triggerów, starsze (np.
   * PIN sprzed 3 dni) zostają wycięte przez LIMIT zanim filter zadziała.
   * Teraz `WHERE ts >= ?` jest w SQL → poprawnie filtruje OD RAZU.
   *
   * Performance: indeks `relay_triggers_ts_idx` zapewnia O(log n) lookup
   * przy `ts >= ? ORDER BY ts DESC`.
   */
  relayTriggerListRecent(
    optsOrLimit: number | { sinceMs?: number; untilMs?: number; source?: string; limit?: number } = 50,
  ): Array<{
    id: number
    deviceId: string
    deviceName: string | null
    deviceType: string | null
    relayIndex: number
    source: string
    ts: number
  }> {
    // Backwards-compat: starszy caller (np. UI Monitoring) wciąż wywołuje
    // `relayTriggerListRecent(50)` — wtedy zachowujemy się jak wcześniej
    // (last N po ts DESC, no time filter).
    const opts = typeof optsOrLimit === 'number'
      ? { limit: optsOrLimit }
      : optsOrLimit

    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000)
    const clauses: string[] = []
    const params: any[] = []
    if (opts.sinceMs != null) {
      clauses.push('rt.ts >= ?')
      params.push(opts.sinceMs)
    }
    if (opts.untilMs != null) {
      clauses.push('rt.ts < ?')
      params.push(opts.untilMs)
    }
    if (opts.source) {
      clauses.push('rt.source = ?')
      params.push(opts.source)
    }
    params.push(limit)
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT rt.id, rt.device_id, rt.relay_index, rt.source, rt.ts,
                dc.type AS device_type,
                dc.config AS device_config_json
           FROM relay_triggers rt
           LEFT JOIN device_config dc ON dc.device_id = rt.device_id
           ${where}
           ORDER BY rt.ts DESC
           LIMIT ?`,
      )
      .all(...params) as any[]
    return rows.map(r => {
      // Wyciąga `name` z JSON config. Defensive: gdy device został usunięty
      // (`device_config.device_id` IS NULL) — `name` = null, UI fallbackuje na
      // skrócony device_id.
      let deviceName: string | null = null
      try {
        if (r.device_config_json) {
          const cfg = JSON.parse(r.device_config_json) as { name?: string }
          deviceName = cfg.name ?? null
        }
      } catch { /* malformed config — ignore, deviceName stays null */ }
      return {
        id: r.id,
        deviceId: r.device_id,
        deviceName,
        deviceType: r.device_type ?? null,
        relayIndex: r.relay_index,
        source: r.source,
        ts: r.ts,
      }
    })
  }

  /** 30-day cleanup. Wzorowane na `lprSweepOldReads`. */
  relayTriggerSweepOld(cutoffMs: number): number {
    const info = this.db.prepare('DELETE FROM relay_triggers WHERE ts < ?').run(cutoffMs)
    return info.changes
  }

  // ── Event log (persistent audit) ─────────────────────────────────────────────

  /** Append jednego wpisu. Wywoływane przez `EventLogService.log()`. */
  eventLogInsert(row: {
    ts: number
    level: string
    category: string
    message: string
    detail?: string | null
  }): void {
    this.db
      .prepare('INSERT INTO event_log (ts, level, category, message, detail) VALUES (?, ?, ?, ?, ?)')
      .run(row.ts, row.level, row.category, row.message, row.detail ?? null)
  }

  /**
   * Query do exportu. Zwraca wpisy w przedziale `[sinceMs, untilMs)`, opcjonalnie
   * filtrowane po `level`. Sortowanie ASC żeby wyjściowy plik czytał się
   * chronologicznie (najstarszy najpierw — standardowy log format).
   *
   * Limit hard-cap 50k bo 7 dni × 2k wpisów/dzień to ~14k; trzymamy zapas.
   */
  eventLogQuery(opts: {
    sinceMs: number
    untilMs?: number
    levels?: string[]
    limit?: number
  }): Array<{ id: number; ts: number; level: string; category: string; message: string; detail: string | null }> {
    const until = opts.untilMs ?? Date.now()
    const limit = Math.min(opts.limit ?? 50_000, 100_000)
    const clauses: string[] = ['ts >= ?', 'ts < ?']
    const params: any[] = [opts.sinceMs, until]
    if (opts.levels && opts.levels.length > 0) {
      const placeholders = opts.levels.map(() => '?').join(',')
      clauses.push(`level IN (${placeholders})`)
      params.push(...opts.levels)
    }
    params.push(limit)
    const rows = this.db
      .prepare(
        `SELECT id, ts, level, category, message, detail
           FROM event_log
          WHERE ${clauses.join(' AND ')}
          ORDER BY ts ASC, id ASC
          LIMIT ?`,
      )
      .all(...params) as any[]
    return rows
  }

  /** 7-day cleanup. Wywoływany z nightly cron. */
  eventLogSweepOld(cutoffMs: number): number {
    const info = this.db.prepare('DELETE FROM event_log WHERE ts < ?').run(cutoffMs)
    return info.changes
  }

  // ── LPR reads cloud sync state ───────────────────────────────────────────────
  /**
   * Lista odczytów które jeszcze nie poszły do Cloud (`synced_to_cloud = 0`).
   * Wywoływane z `SyncService.backfillUnsyncedLprReads()` po reconnect WS.
   *
   * Sortowanie ASC po `ts`, żeby Cloud zobaczył je w kolejności chronologicznej
   * i lista w panelu nie skakała losowo gdy backfill się rozkłada na kilka
   * rund (np. WS znowu padnie po 100 wysłanych odczytach).
   *
   * Zwracamy tylko pola które trafiają do payloadu LPR_READ — bez surowych
   * binariów obrazów (image_path zostaje na Edge i Cloud sięga po niego
   * proxy-em).
   */
  lprListUnsyncedReads(limit = 500): Array<{
    id: number
    cameraDeviceId: string
    plate: string
    matched: boolean
    owner: string | null
    gateOpened: boolean
    reason: string | null
    confidence: number | null
    direction: string | null
    imagePath: string | null
    vehicleColor: string | null
    vehicleBrand: string | null
    vehicleType: string | null
    vehicleSubtype: string | null
    ts: number
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, camera_device_id, plate, matched, owner, gate_opened, reason,
                confidence, direction, image_path, vehicle_color, vehicle_brand,
                vehicle_type, vehicle_subtype, ts
           FROM lpr_reads
          WHERE synced_to_cloud = 0
          ORDER BY ts ASC
          LIMIT ?`,
      )
      .all(limit) as any[]
    return rows.map((r) => ({
      id: r.id,
      cameraDeviceId: r.camera_device_id,
      plate: r.plate,
      matched: !!r.matched,
      owner: r.owner,
      gateOpened: !!r.gate_opened,
      reason: r.reason,
      confidence: r.confidence,
      direction: r.direction,
      imagePath: r.image_path,
      vehicleColor: r.vehicle_color,
      vehicleBrand: r.vehicle_brand,
      vehicleType: r.vehicle_type,
      vehicleSubtype: r.vehicle_subtype,
      ts: r.ts,
    }))
  }

  /**
   * Oznacz pojedynczy odczyt jako wysłany do Cloud. Wywoływane natychmiast
   * po `tunnelSend('LPR_READ', …)` które zwróciło `true` (czyli WS było
   * faktycznie connected — nie kolejkowane offline).
   */
  lprMarkReadSynced(id: number): void {
    this.db.prepare('UPDATE lpr_reads SET synced_to_cloud = 1 WHERE id = ?').run(id)
  }

  /**
   * Bulk-oznaczenie zsynchronizowanych odczytów. Używane przez
   * `backfillUnsyncedLprReads` żeby nie ucinać I/O na pojedyncze UPDATE-y
   * gdy backfill leci 500 rzędów.
   */
  lprMarkReadsSynced(ids: number[]): void {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`UPDATE lpr_reads SET synced_to_cloud = 1 WHERE id IN (${placeholders})`).run(...ids)
  }

  /**
   * Liczba odczytów oczekujących na backfill — pokazywana w `STATUS`
   * heartbeacie i w `getConnectionInfo` na panelu Edge, żeby było widać
   * „ile jeszcze zostało" gdy synchronizacja po długim offline się ciągnie.
   */
  lprUnsyncedCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM lpr_reads WHERE synced_to_cloud = 0').get() as any
    return r.c as number
  }

  /**
   * Resetuje `synced_to_cloud=1 → 0` dla odczytów z ostatnich `windowMs`
   * milisekund. Wywoływane na każdy reconnect WS, żeby przeciąć problem
   * "half-open WebSocket": gdy TCP rwie się po cichu (network change, NAT
   * drop, watchdog Cloud), `ws.readyState` przez ~90s pokazuje OPEN i
   * `ws.send()` succeed-uje fire-and-forget, ale pakiety nigdy nie docierają.
   * Edge oznaczał wtedy odczyty jako synced=1, mimo że Cloud ich nie
   * dostał — i backfill ich nie wyłapywał.
   *
   * Po resecie `backfillUnsyncedLprReads` ponownie wyśle te odczyty.
   * Cloud-side partial unique index na `(buildingId, cameraDeviceId,
   * edgeReadId)` + `ON CONFLICT DO NOTHING` deduplikuje już zapisane,
   * więc nadmiarowe wysyłki to no-op.
   *
   * Zwraca liczbę zresetowanych rzędów (czysto diagnostyczne).
   */
  lprResetSyncFlagSince(cutoffMs: number): number {
    const info = this.db
      .prepare('UPDATE lpr_reads SET synced_to_cloud = 0 WHERE ts >= ? AND synced_to_cloud = 1')
      .run(cutoffMs)
    return info.changes
  }

  // ── Encrypted KV store ───────────────────────────────────────────────────────
  set(key: string, value: string) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encKey, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const stored = Buffer.concat([iv, tag, encrypted]).toString('base64')
    this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, stored)
  }

  /**
   * Decrypts a KV row. Returns null if the row is missing OR if decryption
   * fails (wrong key — happens when the store file was migrated from another
   * machine or the hostname/CPU changed since the write). The second case
   * used to be silent, which hid "why is my device not activated?" bugs for
   * an embarrassingly long time, so we now log a warning with the key name
   * and mark the row as poisoned so repeated reads don't spam the log.
   */
  private poisonedKeys = new Set<string>()
  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any
    if (!row) return null
    try {
      const buf = Buffer.from(row.value, 'base64')
      const iv = buf.subarray(0, 12)
      const tag = buf.subarray(12, 28)
      const encrypted = buf.subarray(28)
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encKey, iv)
      decipher.setAuthTag(tag)
      return decipher.update(encrypted) + decipher.final('utf8')
    } catch (err: any) {
      if (!this.poisonedKeys.has(key)) {
        this.poisonedKeys.add(key)
        this.logger.warn(
          `Cannot decrypt store key "${key}" (${err?.message ?? err}) — ` +
          `likely written with a different encryption key (hostname/CPU/MACHINE_ID changed ` +
          `between writes). Re-activate the device to replace it.`,
        )
      }
      return null
    }
  }

  delete(key: string) {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
  }

  // ── Event queue ──────────────────────────────────────────────────────────────
  enqueue(eventType: string, payload: object) {
    this.db
      .prepare('INSERT INTO event_queue (event_type, payload, created_at) VALUES (?, ?, ?)')
      .run(eventType, JSON.stringify(payload), Date.now())
  }

  dequeue(limit = 50): { id: number; eventType: string; payload: object }[] {
    const rows = this.db
      .prepare('SELECT * FROM event_queue ORDER BY id ASC LIMIT ?')
      .all(limit) as any[]
    return rows.map((r) => ({ id: r.id, eventType: r.event_type, payload: JSON.parse(r.payload) }))
  }

  ackQueue(ids: number[]) {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`DELETE FROM event_queue WHERE id IN (${placeholders})`).run(...ids)
  }

  queueSize(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM event_queue').get() as any).c
  }

  // ── Device config ────────────────────────────────────────────────────────────
  // FAZA 8.h (2026-06-03) — kolumny `role` + `ai_analysis_enabled` są pre-set
  // przez DEFAULT (patrz ensureColumns). `setDeviceConfig` NIE zmienia ich —
  // istniejący row zachowuje swoje wartości (INSERT OR REPLACE wstawia
  // domyślne tylko gdy row nie istniał). Zmiana per-kamera idzie przez
  // `setCameraRole` / `setCameraAiAnalysisEnabled` (CAMERA_CONFIG_UPDATE).
  setDeviceConfig(deviceId: string, type: string, config: object) {
    // INSERT OR REPLACE niszczyłby wcześniej ustawione role/ai_analysis_enabled.
    // Używamy UPSERT-pattern: INSERT OR IGNORE, potem UPDATE niezmieniających
    // pól.
    this.db
      .prepare(
        'INSERT OR IGNORE INTO device_config (device_id, type, config, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(deviceId, type, JSON.stringify(config), Date.now())
    this.db
      .prepare(
        'UPDATE device_config SET type = ?, config = ?, updated_at = ? WHERE device_id = ?',
      )
      .run(type, JSON.stringify(config), Date.now(), deviceId)
  }

  getDeviceConfigs(): {
    deviceId: string
    type: string
    config: object
    enabled: boolean
    role: string
    aiAnalysisEnabled: boolean
  }[] {
    const rows = this.db
      .prepare('SELECT * FROM device_config WHERE enabled = 1')
      .all() as any[]
    return rows.map((r) => ({
      deviceId: r.device_id,
      type: r.type,
      config: JSON.parse(r.config),
      enabled: r.enabled === 1,
      role: typeof r.role === 'string' && r.role.length > 0 ? r.role : 'LPR',
      // SQLite store true/false jako 1/0; default DDL = 1 (ON).
      aiAnalysisEnabled: r.ai_analysis_enabled !== 0,
    }))
  }

  deleteDeviceConfig(deviceId: string) {
    this.db.prepare('DELETE FROM device_config WHERE device_id = ?').run(deviceId)
  }

  // ── FAZA 8.h: per-camera role + AI toggle ──────────────────────────────────
  // Wywoływane przez TunnelService po `CAMERA_CONFIG_UPDATE` z Cloud. Cloud
  // jest źródłem prawdy — Edge nie modyfikuje tych pól po swojej stronie.
  // Bezpieczne dla device-id który nie istnieje (no-op).
  setCameraRole(deviceId: string, role: string) {
    if (role !== 'STANDARD' && role !== 'LPR') {
      throw new Error(`setCameraRole: invalid role '${role}' (expected STANDARD|LPR)`)
    }
    this.db
      .prepare('UPDATE device_config SET role = ?, updated_at = ? WHERE device_id = ?')
      .run(role, Date.now(), deviceId)
  }

  setCameraAiAnalysisEnabled(deviceId: string, enabled: boolean) {
    this.db
      .prepare(
        'UPDATE device_config SET ai_analysis_enabled = ?, updated_at = ? WHERE device_id = ?',
      )
      .run(enabled ? 1 : 0, Date.now(), deviceId)
  }

  // ──────────────────────────────────────────────────────────────────────
  // Vision detections (YOLO via MacBook) — 2026-05-19
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Insert one detection row. `summary` is the {class: count} dict from YOLO
   * — already JSON-stringified by the caller (we don't re-encode to avoid
   * subtle key-ordering diffs that would break downstream SQL `LIKE` checks).
   * Returns the auto-increment id so callers can correlate with files on disk.
   */
  visionInsertDetection(opts: {
    cameraDeviceId: string
    ts: number
    inferenceMs: number | null
    summary: string                 // JSON: '{"person":2,"car":1}'
    detectionsJson: string | null   // JSON: '[{class, conf, bbox},...]'
    imagePath: string | null
    // Brand detection (2026-05-19, optional — gdy YOLO service zwrócił brand):
    //   brandDetected: canonical UPPERCASE name (DHL/DPD/INPOST/…)
    //   brandConf:     OCR confidence 0..1
    //   textRaw:       JSON-stringified array wszystkich OCR boxes (debug)
    brandDetected?: string | null
    brandConf?: number | null
    textRaw?: string | null
    // Waste-truck detection (2026-05-19):
    //   wasteCategory: GLASS|PAPER|PLASTIC|BIO|MIXED — kategoria odpadów
    //                  rozpoznana z napisu na śmieciarce (np. "SZKŁO").
    //   wasteConf:     OCR confidence 0..1 dla matched category token.
    //   wasteOperator: REMONDIS|STENA|ZGOK|… — firma wywożąca (opcjonalna).
    wasteCategory?: string | null
    wasteConf?: number | null
    wasteOperator?: string | null
    // Atrybuty pojazdu z VLM (2026-08-14): typ (osobowy/dostawczy/ciezarowka/
    // bus/maszyna/inny), marka (Mercedes/BMW/…) i kolor głównego pojazdu.
    vehicleKind?: string | null
    vehicleMake?: string | null
    vehicleColor?: string | null
    // Korelacja z rejestrem tablic (2026-08-15): OCR wizji rozpoznał tablicę
    // znaną osiedlu — zapisujemy znormalizowaną tablicę + czytelną etykietę.
    plateMatched?: string | null
    plateMatchLabel?: string | null
    // Anomaly detection (2026-05-23): pole odpalone gdy YOLOv8-pose heurystyka
    // wykryła sytuację typu upadek. anomaly_type='FALL', fall_likelihood ≥0.5,
    // indicators to JSON list aktywnych indikatorów (debug).
    anomalyType?: string | null
    fallLikelihood?: number | null
    anomalyIndicators?: string | null
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO vision_detections
          (camera_device_id, ts, inference_ms, summary, detections_json, image_path,
           brand_detected, brand_conf, text_raw,
           waste_category, waste_conf, waste_operator,
           vehicle_kind, vehicle_make, vehicle_color,
           plate_matched, plate_match_label,
           anomaly_type, fall_likelihood, anomaly_indicators)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.cameraDeviceId,
        opts.ts,
        opts.inferenceMs,
        opts.summary,
        opts.detectionsJson,
        opts.imagePath,
        opts.brandDetected ?? null,
        opts.brandConf ?? null,
        opts.textRaw ?? null,
        opts.wasteCategory ?? null,
        opts.wasteConf ?? null,
        opts.wasteOperator ?? null,
        opts.vehicleKind ?? null,
        opts.vehicleMake ?? null,
        opts.vehicleColor ?? null,
        opts.plateMatched ?? null,
        opts.plateMatchLabel ?? null,
        opts.anomalyType ?? null,
        opts.fallLikelihood ?? null,
        opts.anomalyIndicators ?? null,
      )
    return Number(info.lastInsertRowid)
  }

  /**
   * List vision_detections rows for a given brand. Uses the partial index
   * `vision_brand_ts_idx` (created in initSchema) — only scans rows where
   * brand_detected IS NOT NULL, very cheap even with months of history.
   *
   * Used by Assistant `search_by_brand_today` intent. Returns max `limit`
   * rows sorted ts DESC (most recent first).
   */
  visionListByBrand(opts: {
    brand: string
    sinceMs?: number
    cameraDeviceId?: string
    limit?: number
  }): Array<{
    id: number
    cameraDeviceId: string
    ts: number
    brandDetected: string
    brandConf: number | null
    summary: string
    imagePath: string | null
  }> {
    const where: string[] = ['brand_detected = ?']
    const args: any[] = [opts.brand.toUpperCase()]
    if (opts.sinceMs != null) {
      where.push('ts >= ?')
      args.push(opts.sinceMs)
    }
    if (opts.cameraDeviceId) {
      where.push('camera_device_id = ?')
      args.push(opts.cameraDeviceId)
    }
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200)
    const rows = this.db
      .prepare(
        `SELECT id,
                camera_device_id AS cameraDeviceId,
                ts,
                brand_detected   AS brandDetected,
                brand_conf       AS brandConf,
                summary,
                image_path       AS imagePath
           FROM vision_detections
          WHERE ${where.join(' AND ')}
          ORDER BY ts DESC
          LIMIT ${limit}`,
      )
      .all(...args) as any[]
    return rows
  }

  /**
   * List vision_detections rows for a given waste category (and optionally
   * operator). Uses the partial index `vision_waste_ts_idx` — same shape as
   * brand lookup. Used by Assistant `search_by_waste_today` intent.
   *
   * `category` is optional — when omitted, returns ANY waste-truck detection
   * regardless of fraction. Useful for the generic "czy była śmieciarka?"
   * query before the user narrows down to a fraction.
   */
  visionListByWaste(opts: {
    category?: string | null
    operator?: string | null
    sinceMs?: number
    cameraDeviceId?: string
    limit?: number
  }): Array<{
    id: number
    cameraDeviceId: string
    ts: number
    wasteCategory: string
    wasteConf: number | null
    wasteOperator: string | null
    summary: string
    imagePath: string | null
  }> {
    // waste_category IS NOT NULL guarantees the partial index is selected
    // regardless of whether the caller passes a specific category.
    const where: string[] = ['waste_category IS NOT NULL']
    const args: any[] = []
    if (opts.category) {
      where.push('waste_category = ?')
      args.push(opts.category.toUpperCase())
    }
    if (opts.operator) {
      where.push('waste_operator = ?')
      args.push(opts.operator.toUpperCase())
    }
    if (opts.sinceMs != null) {
      where.push('ts >= ?')
      args.push(opts.sinceMs)
    }
    if (opts.cameraDeviceId) {
      where.push('camera_device_id = ?')
      args.push(opts.cameraDeviceId)
    }
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200)
    const rows = this.db
      .prepare(
        `SELECT id,
                camera_device_id AS cameraDeviceId,
                ts,
                waste_category   AS wasteCategory,
                waste_conf       AS wasteConf,
                waste_operator   AS wasteOperator,
                summary,
                image_path       AS imagePath
           FROM vision_detections
          WHERE ${where.join(' AND ')}
          ORDER BY ts DESC
          LIMIT ${limit}`,
      )
      .all(...args) as any[]
    return rows
  }

  /**
   * Recent detections. Used by Edge debug endpoints and (via raw sqlite
   * read) by the AI prototype on Edge. The `classes` filter matches any
   * detection whose summary JSON contains at least one of the listed
   * classes (substring-match on the JSON string is good enough because
   * COCO class names are alphanumeric and the JSON keys are quoted).
   */
  visionListRecent(opts: {
    sinceMs?: number
    cameraDeviceId?: string
    classes?: string[]
    limit?: number
    /**
     * 2026-08-15 — wyszukiwanie tekstowe po CAŁEJ historii (napisy OCR,
     * dopasowana tablica, marka pojazdu). LIKE bez indeksu — przy dziesiątkach
     * tysięcy wierszy to dalej pojedyncze milisekundy w sqlite.
     */
    textQuery?: string
    /** 2026-08-21 — koniec okna / kursor paginacji (ts < untilMs). */
    untilMs?: number
  } = {}): Array<{
    id: number
    cameraDeviceId: string
    ts: number
    inferenceMs: number | null
    summary: string
    imagePath: string | null
    // LLM summary (2026-05-22) — krótki polski opis dla notable frames.
    // NULL gdy frame nie jest notable albo summarizer jeszcze nie przetworzył.
    llmSummary: string | null
    // Brand + waste category — dla BA UI żeby pokazać badge bez dodatkowego query.
    brandDetected: string | null
    wasteCategory: string | null
    // Anomaly detection (2026-05-23) — fall_likelihood ≥0.5 odpala BA UI alert.
    anomalyType: string | null
    fallLikelihood: number | null
    // FAZA 8.h.4 (2026-06-05) — raw OCR tokens (JSON string). Parsowane
    // i filtrowane noise w controller layer.
    textRaw: string | null
    // 2026-08-14 — atrybuty pojazdu z VLM (typ/marka/kolor głównego pojazdu).
    vehicleKind: string | null
    vehicleMake: string | null
    vehicleColor: string | null
    // 2026-08-15 — korelacja z rejestrem tablic.
    plateMatched: string | null
    plateMatchLabel: string | null
  }> {
    const where: string[] = []
    const args: any[] = []
    // 2026-08-21 — górna granica okna: własny zakres dat z panelu ORAZ
    // kursor keyset-paginacji (before_ts przy nieskończonym przewijaniu).
    if (opts.untilMs != null) {
      where.push('ts < ?')
      args.push(opts.untilMs)
    }
    if (opts.sinceMs != null) {
      where.push('ts >= ?')
      args.push(opts.sinceMs)
    }
    if (opts.cameraDeviceId) {
      where.push('camera_device_id = ?')
      args.push(opts.cameraDeviceId)
    }
    if (opts.classes && opts.classes.length > 0) {
      // Match any class: OR over `summary LIKE '%"<class>":%'`. Safe because
      // class names are [a-z_] only.
      const ors = opts.classes
        .map(() => `summary LIKE ?`)
        .join(' OR ')
      where.push(`(${ors})`)
      for (const c of opts.classes) args.push(`%"${c}":%`)
    }
    if (opts.textQuery && opts.textQuery.trim()) {
      // 2026-08-19 — wyszukiwanie SEMANTYCZNE (zgłoszenie: „biały bus" → 0
      // wyników). Opis pojazdu to kolor + typ z kolumn VLM, nie napis z OCR.
      // Zapytanie tniemy na tokeny: każdy token musi trafić (AND), a trafia
      // gdy pasuje do KTÓREGOKOLWIEK pola — typ → vehicle_kind + klasa YOLO
      // w summary (starsze klatki bez VLM), kolor → vehicle_color, reszta →
      // LIKE po OCR/tablicy/marce (jak dotąd). Potocznie „bus" = też van
      // dostawczy, więc mapujemy szeroko (bus+dostawczy / bus+truck).
      const deaccent = (s: string) =>
        s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
      const KIND_TOKENS: Record<string, { kinds: string[]; coco: string[] }> = {
        bus:        { kinds: ['bus', 'dostawczy'], coco: ['bus', 'truck'] },
        autobus:    { kinds: ['bus'], coco: ['bus'] },
        van:        { kinds: ['dostawczy', 'bus'], coco: ['truck', 'bus'] },
        dostawczy:  { kinds: ['dostawczy'], coco: ['truck'] },
        dostawczak: { kinds: ['dostawczy'], coco: ['truck'] },
        ciezarowka: { kinds: ['ciezarowka'], coco: ['truck'] },
        tir:        { kinds: ['ciezarowka'], coco: ['truck'] },
        osobowy:    { kinds: ['osobowy'], coco: ['car'] },
        osobowka:   { kinds: ['osobowy'], coco: ['car'] },
        auto:       { kinds: ['osobowy'], coco: ['car'] },
        samochod:   { kinds: ['osobowy'], coco: ['car'] },
        maszyna:    { kinds: ['maszyna'], coco: ['truck'] },
        koparka:    { kinds: ['maszyna'], coco: ['truck'] },
        traktor:    { kinds: ['maszyna'], coco: ['truck'] },
      }
      // Kolor: warianty z/bez diakrytyków (VLM pisze „bialy", ale bywa „biały").
      const COLOR_TOKENS: Record<string, string[]> = {
        bialy: ['bialy', 'biały'], czarny: ['czarny'], czerwony: ['czerwony'],
        niebieski: ['niebieski'], zielony: ['zielony'], zolty: ['zolty', 'żółty'],
        szary: ['szary'], srebrny: ['srebrny'], brazowy: ['brazowy', 'brązowy'],
        granatowy: ['granatowy'], bezowy: ['bezowy', 'beżowy'],
        pomaranczowy: ['pomaranczowy', 'pomarańczowy'], fioletowy: ['fioletowy'],
        zloty: ['zloty', 'złoty'], bordowy: ['bordowy'],
      }
      // Odmiany („busa", „ciężarówki", „auta") — dopasowanie po prefiksie,
      // dłuższe klucze najpierw („autobusem" → autobus, nie auto).
      const kindKeys = Object.keys(KIND_TOKENS).sort((a, b) => b.length - a.length)
      const matchKind = (plain: string) => {
        for (const k of kindKeys) {
          if (plain === k || plain.startsWith(k) ||
              (k.length >= 4 && plain.startsWith(k.slice(0, -1)))) {
            return KIND_TOKENS[k]
          }
        }
        return undefined
      }
      const tokens = opts.textQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
      for (const tok of tokens) {
        const plain = deaccent(tok)
        // „śmieciarka/śmieciarki" — semantyka jak toggle „Tylko śmieciarki":
        // klatki z waste_category (frakcja rozpoznana z OCR operatora).
        if (plain.startsWith('smieciar')) {
          where.push(`(waste_category IS NOT NULL)`)
          continue
        }
        const kind = matchKind(plain)
        if (kind) {
          const ors = [
            `vehicle_kind IN (${kind.kinds.map(() => '?').join(',')})`,
            ...kind.coco.map(() => `summary LIKE ?`),
          ]
          where.push(`(${ors.join(' OR ')})`)
          args.push(...kind.kinds)
          for (const c of kind.coco) args.push(`%"${c}":%`)
          continue
        }
        // Kolor po prefiksie — łapie odmiany („białego", „białym").
        const colorKey = Object.keys(COLOR_TOKENS).find(
          (k) => plain.startsWith(k.slice(0, Math.max(4, k.length - 3))) && k.startsWith(plain.slice(0, 4)),
        )
        if (colorKey) {
          const variants = COLOR_TOKENS[colorKey]
          where.push(`(${variants.map(() => 'vehicle_color LIKE ?').join(' OR ')})`)
          for (const v of variants) args.push(`%${v.slice(0, 4)}%`)
          continue
        }
        // Klasy obiektów YOLO (zgłoszenie 2026-08-19: „kot/pies/rower/dzik"
        // → 0 wyników) — zwierzęta i rowery żyją w JSON-ie `summary`
        // ({"dog":1,"bicycle":2}), nie w napisach OCR. Dzikie zwierzęta
        // (dzik/sarna/lis) → szeroka grupa: YOLO nie zna tych klas i
        // klasyfikuje je jako najbliższe znane (pies/kot/koń/krowa…).
        const ANIMALS = ['dog', 'cat', 'horse', 'cow', 'sheep', 'bird', 'bear']
        const OBJECT_PATTERNS: Array<{ re: RegExp; classes: string[] }> = [
          { re: /^kot(?!ar)/, classes: ['cat'] },
          { re: /^(pies|piesk|ps[aoyeu])/, classes: ['dog'] },
          { re: /^rower/, classes: ['bicycle'] },
          { re: /^(osob|czlowiek|ludz|piesz)/, classes: ['person'] },
          { re: /^(motocykl|motork|skuter)/, classes: ['motorcycle'] },
          { re: /^zwierz/, classes: ANIMALS },
          { re: /^(dzik|sarn|lis|jelen|zajac|kun|borsuk)/, classes: ANIMALS },
        ]
        const obj = OBJECT_PATTERNS.find((p) => p.re.test(plain))
        if (obj) {
          where.push(`(${obj.classes.map(() => 'summary LIKE ?').join(' OR ')})`)
          for (const c of obj.classes) args.push(`%"${c}":%`)
          continue
        }
        // Token spoza słowników — dotychczasowe wolne wyszukiwanie.
        const like = `%${tok}%`
        where.push(
          `(text_raw LIKE ? OR plate_matched LIKE ? OR plate_match_label LIKE ?
            OR vehicle_make LIKE ? OR brand_detected LIKE ?)`,
        )
        args.push(like, like, like, like, like)
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
    const rows = this.db
      .prepare(
        `SELECT id, camera_device_id AS cameraDeviceId, ts,
                inference_ms AS inferenceMs, summary, image_path AS imagePath,
                llm_summary AS llmSummary,
                brand_detected AS brandDetected, waste_category AS wasteCategory,
                anomaly_type AS anomalyType, fall_likelihood AS fallLikelihood,
                text_raw AS textRaw,
                vehicle_kind AS vehicleKind, vehicle_make AS vehicleMake,
                vehicle_color AS vehicleColor,
                plate_matched AS plateMatched, plate_match_label AS plateMatchLabel
           FROM vision_detections
           ${whereSql}
          ORDER BY ts DESC
          LIMIT ${limit}`,
      )
      .all(...args) as any[]
    return rows
  }

  /**
   * Lista NOTABLE frames bez llm_summary — używane przez
   * `VisionLlmSummarizerService` żeby cyklicznie generować krótkie opisy.
   *
   * Definicja "notable":
   *   • summary zawiera person|dog|cat (LIKE substring match — ten sam
   *     pattern co `visionListRecent` używa dla classes filter)
   *   • LUB brand_detected != NULL (rozpoznany kurier)
   *   • LUB waste_category != NULL (rozpoznana śmieciarka)
   *
   * Ograniczenie czasowe: tylko ostatnie `maxAgeMs` ms (default 24h)
   * — żeby cron nie generował summary dla starych klatek po deployu.
   * Limit batch-a niski (5-10) żeby Ollama-cost rozłożyć w czasie.
   */
  visionListNotablePendingSummary(opts: {
    maxAgeMs?: number
    limit?: number
  } = {}): Array<{
    id: number
    cameraDeviceId: string
    ts: number
    summary: string
    brandDetected: string | null
    brandConf: number | null
    textRaw: string | null
    wasteCategory: string | null
    wasteOperator: string | null
    imagePath: string | null
  }> {
    const maxAge = opts.maxAgeMs ?? 24 * 3600 * 1000
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50)
    const sinceMs = Date.now() - maxAge
    const rows = this.db
      .prepare(
        `SELECT id, camera_device_id AS cameraDeviceId, ts,
                summary,
                brand_detected AS brandDetected, brand_conf AS brandConf, text_raw AS textRaw,
                waste_category AS wasteCategory, waste_operator AS wasteOperator,
                image_path AS imagePath
           FROM vision_detections
          WHERE llm_summary IS NULL
            AND ts >= ?
            AND (
              summary LIKE '%"person":%'
              OR summary LIKE '%"dog":%'
              OR summary LIKE '%"cat":%'
              OR brand_detected IS NOT NULL
              OR waste_category IS NOT NULL
            )
          ORDER BY ts DESC
          LIMIT ${limit}`,
      )
      .all(sinceMs) as any[]
    return rows
  }

  /**
   * Zapisz LLM-generated summary dla pojedynczego frame-a. Idempotentne —
   * UPDATE same row by id. Caller (summarizer) trzyma już id z prior SELECT.
   */
  visionUpdateLlmSummary(id: number, summary: string): void {
    this.db
      .prepare(`UPDATE vision_detections SET llm_summary = ? WHERE id = ?`)
      .run(summary, id)
  }

  // ── Zdarzenia sytuacyjne (2026-08-26) ───────────────────────────────

  /** INSERT OR IGNORE po dedup_key — zwraca rowid nowego wiersza, null gdy duplikat. */
  /** Początek ostatniego zdarzenia danego typu przed `beforeTs` (null gdy brak). */
  situationLastStartedTs(type: string, beforeTs: number): number | null {
    const row = this.db
      .prepare(`SELECT MAX(started_ts) AS ts FROM situation_events WHERE type = ? AND started_ts < ?`)
      .get(type, beforeTs) as { ts: number | null } | undefined
    return row?.ts ?? null
  }

  situationInsert(ev: {
    type: string
    cameraDeviceId?: string | null
    startedTs: number
    endedTs?: number | null
    confidence?: string
    title: string
    details?: Record<string, unknown>
    evidence?: Array<{ src: string; id: number }>
    dedupKey: string
  }): number | null {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO situation_events
           (type, camera_device_id, started_ts, ended_ts, confidence, title,
            details_json, evidence_json, dedup_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.type,
        ev.cameraDeviceId ?? null,
        ev.startedTs,
        ev.endedTs ?? null,
        ev.confidence ?? 'OBSERVED',
        ev.title,
        ev.details ? JSON.stringify(ev.details) : null,
        ev.evidence ? JSON.stringify(ev.evidence.slice(0, 10)) : null,
        ev.dedupKey,
        Date.now(),
      )
    return res.changes > 0 ? Number(res.lastInsertRowid) : null
  }

  situationList(opts: { sinceMs?: number; untilMs?: number; types?: string[]; limit?: number } = {}): Array<{
    id: number
    type: string
    cameraDeviceId: string | null
    startedTs: number
    endedTs: number | null
    confidence: string
    title: string
    detailsJson: string | null
    evidenceJson: string | null
    vlmNote: string | null
  }> {
    const where: string[] = []
    const args: any[] = []
    if (opts.sinceMs != null) {
      where.push('started_ts >= ?')
      args.push(opts.sinceMs)
    }
    if (opts.untilMs != null) {
      where.push('started_ts < ?')
      args.push(opts.untilMs)
    }
    if (opts.types?.length) {
      where.push(`type IN (${opts.types.map(() => '?').join(',')})`)
      args.push(...opts.types)
    }
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
    return this.db
      .prepare(
        `SELECT id, type, camera_device_id AS cameraDeviceId,
                started_ts AS startedTs, ended_ts AS endedTs,
                confidence, title, details_json AS detailsJson,
                evidence_json AS evidenceJson, vlm_note AS vlmNote
           FROM situation_events
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY started_ts DESC
          LIMIT ${limit}`,
      )
      .all(...args) as any[]
  }

  /** Zdarzenia z kadrem dowodowym czekające na opis VLM (vlm_note IS NULL). */
  situationsNeedingVlm(types: string[], sinceMs: number, limit = 4): Array<{
    id: number
    type: string
    evidenceJson: string | null
  }> {
    if (!types.length) return []
    return this.db
      .prepare(
        `SELECT id, type, evidence_json AS evidenceJson
           FROM situation_events
          WHERE vlm_note IS NULL
            AND started_ts >= ?
            AND type IN (${types.map(() => '?').join(',')})
          ORDER BY started_ts DESC
          LIMIT ?`,
      )
      .all(sinceMs, ...types, Math.min(Math.max(limit, 1), 10)) as any[]
  }

  situationSetVlmNote(id: number, note: string): void {
    this.db
      .prepare(`UPDATE situation_events SET vlm_note = ? WHERE id = ?`)
      .run(note.slice(0, 500), id)
  }

  /** Ścieżki obrazów klatek-dowodów (tylko te z zapisanym plikiem). */
  situationVisionImagePaths(ids: number[]): Map<number, string> {
    const out = new Map<number, string>()
    if (!ids.length) return out
    const rows = this.db
      .prepare(
        `SELECT id, image_path AS imagePath
           FROM vision_detections
          WHERE id IN (${ids.map(() => '?').join(',')})
            AND image_path IS NOT NULL`,
      )
      .all(...ids) as Array<{ id: number; imagePath: string }>
    for (const r of rows) out.set(r.id, r.imagePath)
    return out
  }

  /** Minimalne wiersze wizji dla korelatora — bez detections_json (ciężki). */
  situationVisionFrames(sinceMs: number): Array<{
    id: number
    cameraDeviceId: string
    ts: number
    summary: string
    brandDetected: string | null
    anomalyType: string | null
    fallLikelihood: number | null
    wasteCategory: string | null
    wasteConf: number | null
    wasteOperator: string | null
  }> {
    return this.db
      .prepare(
        `SELECT id, camera_device_id AS cameraDeviceId, ts, summary,
                brand_detected AS brandDetected, anomaly_type AS anomalyType,
                fall_likelihood AS fallLikelihood,
                waste_category AS wasteCategory, waste_conf AS wasteConf,
                waste_operator AS wasteOperator
           FROM vision_detections
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(sinceMs) as any[]
  }

  situationLprReads(sinceMs: number): Array<{
    id: number
    cameraDeviceId: string
    plate: string
    matched: number
    gateOpened: number
    direction: string | null
    ts: number
  }> {
    return this.db
      .prepare(
        `SELECT id, camera_device_id AS cameraDeviceId, plate, matched,
                gate_opened AS gateOpened, direction, ts
           FROM lpr_reads
          WHERE ts >= ?
          ORDER BY ts ASC`,
      )
      .all(sinceMs) as any[]
  }

  /**
   * Sum per-class counts across vision_detections rows in the window.
   * Reads summary JSON in JS — sqlite-side `json_each` over an object
   * works fine but the volume is small (~3 cameras × 60/min × 24h = 4320
   * rows/day) and in-process pivot keeps the query simple.
   */
  visionCountByClass(opts: {
    sinceMs: number
    cameraDeviceId?: string
  }): Record<string, number> {
    const where: string[] = ['ts >= ?']
    const args: any[] = [opts.sinceMs]
    if (opts.cameraDeviceId) {
      where.push('camera_device_id = ?')
      args.push(opts.cameraDeviceId)
    }
    const rows = this.db
      .prepare(
        `SELECT summary FROM vision_detections WHERE ${where.join(' AND ')}`,
      )
      .all(...args) as { summary: string }[]
    const total: Record<string, number> = {}
    for (const r of rows) {
      try {
        const obj = JSON.parse(r.summary) as Record<string, number>
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'number') total[k] = (total[k] ?? 0) + v
        }
      } catch {
        /* malformed row — skip */
      }
    }
    return total
  }

  /**
   * Retention sweep: delete detection rows older than `cutoffMs` and
   * unlink any associated image files. Called from the service-side
   * @Interval hook (24h cadence in vision-detect.service.ts).
   * Returns the number of rows deleted (image cleanup is logged separately).
   */
  visionSweepOld(cutoffMs: number): number {
    const info = this.db
      .prepare('DELETE FROM vision_detections WHERE ts < ?')
      .run(cutoffMs)
    return Number(info.changes ?? 0)
  }

  // ──────────────────────────────────────────────────────────────────────
  // Knowledge base (RAG) — 2026-05-18
  // ──────────────────────────────────────────────────────────────────────

  knowledgeUpsertDoc(opts: {
    cloudId: number
    type: string
    title: string
    parsedText: string
    metadata: string | null
  }): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_documents (cloud_id, type, title, parsed_text, metadata, chunk_count)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(cloud_id) DO UPDATE SET
           type=excluded.type,
           title=excluded.title,
           parsed_text=excluded.parsed_text,
           metadata=excluded.metadata`,
      )
      .run(opts.cloudId, opts.type, opts.title, opts.parsedText, opts.metadata)
  }

  knowledgeMarkIndexed(cloudId: number, chunkCount: number): void {
    this.db
      .prepare('UPDATE knowledge_documents SET indexed_at = ?, chunk_count = ? WHERE cloud_id = ?')
      .run(Date.now(), chunkCount, cloudId)
  }

  knowledgeDeleteDoc(cloudId: number): void {
    this.db.prepare('DELETE FROM knowledge_documents WHERE cloud_id = ?').run(cloudId)
    // chunks cascade via FK ON DELETE CASCADE
  }

  knowledgeDeleteChunks(docId: number): void {
    this.db.prepare('DELETE FROM knowledge_chunks WHERE doc_id = ?').run(docId)
  }

  knowledgeInsertChunk(opts: {
    docId: number
    chunkIdx: number
    text: string
    embedding: Buffer
  }): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_chunks (doc_id, chunk_idx, text, embedding)
         VALUES (?, ?, ?, ?)`,
      )
      .run(opts.docId, opts.chunkIdx, opts.text, opts.embedding)
  }

  /**
   * Wszystkie chunki + doc metadata (JOIN). Wczytywane do RAM dla brute-force
   * cosine. Optional `type` filter.
   */
  knowledgeListAllChunks(type?: string): Array<{
    docId: number
    type: string
    title: string
    chunkIdx: number
    text: string
    embedding: Buffer
  }> {
    const where = type ? 'WHERE d.type = ?' : ''
    const stmt = this.db.prepare(
      `SELECT d.cloud_id as docId, d.type, d.title, c.chunk_idx as chunkIdx, c.text, c.embedding
         FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.cloud_id = c.doc_id
         ${where}
        ORDER BY c.doc_id, c.chunk_idx`,
    )
    const rows = type ? stmt.all(type) : stmt.all()
    return rows as any
  }

  /**
   * Pełny `parsed_text` dla doc-ów danego typu (default INNE) — używane przez
   * structured calendar parser (FAZA 8.h.28). KnowledgeService search zwraca
   * tylko top-K chunków przyciętych do ~800 znaków, więc do deterministycznego
   * parsowania harmonogramu śmieci (wszystkie daty per frakcja) potrzebny jest
   * PEŁNY tekst dokumentu, nie chunki. Kolejność po cloud_id DESC (najnowszy
   * upload wygrywa gdy budynek ma >1 harmonogram).
   */
  knowledgeListDocTexts(type?: string): Array<{
    cloudId: number
    type: string
    title: string
    parsedText: string
  }> {
    const where = type ? 'WHERE type = ?' : ''
    const stmt = this.db.prepare(
      `SELECT cloud_id as cloudId, type, title, parsed_text as parsedText
         FROM knowledge_documents
         ${where}
        ORDER BY cloud_id DESC`,
    )
    const rows = type ? stmt.all(type) : stmt.all()
    return rows as any
  }

  /** Lista doc-ów dla admin/debug view. */
  knowledgeListDocs(): Array<{
    cloudId: number
    type: string
    title: string
    chunkCount: number
    indexedAt: number | null
  }> {
    return this.db
      .prepare(
        `SELECT cloud_id as cloudId, type, title, chunk_count as chunkCount, indexed_at as indexedAt
           FROM knowledge_documents
          ORDER BY cloud_id DESC`,
      )
      .all() as any
  }
}

/**
 * Defensive JSON parse dla `vehicle_tags` column.
 *  • null / undefined / pusty string  → []
 *  • prawidłowy JSON array of strings → array
 *  • niespodziewany kształt           → [] + log warn (silent w produkcji)
 *
 * Cloud zawsze wysyła `tags: string[]` więc nieprawidłowy kształt = data
 * corruption, nie błąd user-input-u.
 */
/** `lpr_plates.auto_open`: NULL (stary wpis / Cloud bez pola) i 1 = otwieraj; 0 = nie. */
function autoOpenFromRow(v: unknown): boolean {
  return v === null || v === undefined ? true : Number(v) !== 0
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
