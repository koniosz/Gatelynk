// ── Cloud → Edge ──────────────────────────────────────────────────────────────
export interface CloudCommand {
  type: 'CMD'
  id: string
  action: TunnelAction
  payload?: Record<string, any>
}

export interface CloudPing {
  type: 'PING'
  ts: number
}

export type CloudMessage = CloudCommand | CloudPing

// ── Edge → Cloud ──────────────────────────────────────────────────────────────
export interface EdgeEvent {
  type: 'EVT'
  event: string
  deviceId?: string
  data: Record<string, any>
  ts: number
}

export interface EdgeAck {
  type: 'ACK'
  id: string
  success: boolean
  data?: any
  error?: string
}

export interface EdgeStatus {
  type: 'STATUS'
  uptime: number
  version: string
  queueSize: number
  devices: DeviceStatusEntry[]
  ts: number
}

export interface EdgePong {
  type: 'PONG'
  ts: number
}

// ── Faza B-2 (Wizard sync, 2026-05-13): Edge → Cloud device sync ─────────────
//
// Edge wysyła te wiadomości żeby chmurowy mirror (`edge_device_mirror`) był
// zsynchronizowany ze stanem w sqlite Edge. Cloud nie przechowuje haseł —
// `EdgeGateway.sanitizeDeviceConfig` filtruje password/token/secret PRZED
// upsertem (patrz apps/api/src/edge/edge.gateway.ts).
//
// DEVICE_UPSERT  — pojedyncze urządzenie dodane/zmienione w wizardzie.
// DEVICE_DELETE  — usunięcie z Edge sqlite.
// DEVICE_SYNC_ALL — pełna lista (reconnect WS, defense-in-depth: chwytamy
//                   zmiany które wpadły gdy Edge był offline).

export interface EdgeDeviceUpsert {
  type: 'DEVICE_UPSERT'
  deviceUuid: string   // UUID urządzenia w Edge sqlite
  deviceType: string   // INTERCOM | CAMERA | LPR_CAMERA | SWITCH | KNX_BRIDGE | …
  driverId?: string | null
  config: Record<string, any>
  ts: number
}

export interface EdgeDeviceDelete {
  type: 'DEVICE_DELETE'
  deviceUuid: string
  ts: number
}

export interface EdgeDeviceSyncAll {
  type: 'DEVICE_SYNC_ALL'
  devices: Array<{
    deviceUuid: string
    deviceType: string
    driverId?: string | null
    config: Record<string, any>
  }>
  ts: number
}

export type EdgeMessage = EdgeEvent | EdgeAck | EdgeStatus | EdgePong
                       | EdgeDeviceUpsert | EdgeDeviceDelete | EdgeDeviceSyncAll

// ── Actions ───────────────────────────────────────────────────────────────────
export type TunnelAction =
  | 'GET_STATUS'
  | 'OPEN_DOOR'
  | 'CLOSE_DOOR'
  | 'OPEN_GATE'
  | 'ELEVATOR_CALL'
  | 'LIGHTS_ON'
  | 'LIGHTS_OFF'
  | 'LIGHTS_DIM'
  | 'CAMERA_SNAPSHOT'
  | 'DEVICE_CONFIG_UPDATE'
  | 'REBOOT'
  | 'PLATE_UPSERT'
  | 'PLATE_DELETE'
  // FAZA 8.h.25 (2026-06-12) — pełen replace-all whitelisty tablic przy
  // reconnect Edge (wzorzec 8.h.2/CAMERA_SYNC_ALL). Cloud wysyła w
  // `pushAccessPointSync` KOMPLETNY stan: APPROVED vehicles + aktywni
  // goście z vehiclePlate. Edge robi lprReplaceAll per KAŻDA kamera LPR
  // (lpr_plates keyed (camera_device_id, plate)).
  // Payload: { items: Array<{ plate, owner?, kind?, tags?, unitLabel?,
  //            validFrom?, validUntil? }> } (`plates` — legacy alias).
  | 'PLATE_SYNC_ALL'
  | 'PIN_UPSERT'
  | 'PIN_DELETE'
  | 'PIN_SYNC_ALL'
  // 2026-06-02 — RESIDENT_PIN: stały PIN mieszkańca (nie wygasa).
  // Payload UPSERT: { residentId, pin, residentName }
  // Payload DELETE: { residentId }
  // Payload SYNC_ALL: { items: Array<{residentId, pin, residentName, buildingId}> }
  | 'RESIDENT_PIN_UPSERT'
  | 'RESIDENT_PIN_DELETE'
  | 'RESIDENT_PIN_SYNC_ALL'
  // Knowledge base (RAG, 2026-05-18): Cloud → Edge sync dokumentów wgranych
  // przez Building Admin. Edge embeduje + indeksuje dla LLM search.
  | 'KNOWLEDGE_UPSERT'
  | 'KNOWLEDGE_DELETE'
  // Faza F-2 (2026-05-14): hold-open dla intercomu — kurier/ekipa.
  // Payload: { deviceId, seconds, doorIndex? }
  | 'HOLD_OPEN'
  | 'CANCEL_HOLD_OPEN'
  // ── Access Points refactor (2026-06-01) ────────────────────────────────
  // Cloud syncuje AccessPoint i AccessPointSchedule rzędy do Edge SQLite.
  // Edge sam routuje LPR/PIN/manual przez `AccessPointExecutorService`.
  //
  // AP_UPSERT      — pojedynczy AP dodany/zmieniony w BA panelu.
  // AP_DELETE      — usunięty.
  // AP_SYNC_ALL    — pełna lista (reconnect WS, defense-in-depth).
  // SCHEDULE_UPSERT/DELETE/SYNC_ALL — analogicznie dla cron-ów.
  // AP_TEST_FIRE   — admin-only: test pulse z BA panelu (audyt jako MANUAL).
  | 'AP_UPSERT'
  | 'AP_DELETE'
  | 'AP_SYNC_ALL'
  | 'SCHEDULE_UPSERT'
  | 'SCHEDULE_DELETE'
  | 'SCHEDULE_SYNC_ALL'
  | 'AP_TEST_FIRE'
  // FAZA c (2026-06-02) — multi-LPR per AP. 1 kamera może być powiązana
  // z wieloma AP, każdy link ma direction (IN/OUT). Edge tabela
  // `lpr_camera_ap_links` jest mirror-em z Postgres.
  | 'LPR_AP_LINK_UPSERT'
  | 'LPR_AP_LINK_DELETE'
  | 'LPR_AP_LINK_SYNC_ALL'
  // FAZA b (2026-06-02) — Building config: objectType + features.
  // Edge zapisuje do KV (encrypted) — przyszłe service (kurier flow) czytają.
  | 'BUILDING_CONFIG_UPDATE'
  // FAZA 8.g (2026-06-03) — AI Engine config (URL/healthPath/model/enabled).
  // Edge zapisuje w `ai_engines` table; VisionDetectService czyta dynamicznie.
  // Payload: { buildingId, url, healthPath?, model?, enabled? }
  | 'AI_ENGINE_CONFIG_UPDATE'
  // FAZA 8.g (2026-06-03) — test connection do AI Engine. Edge robi GET na
  // <url><healthPath>, mierzy ms, zwraca result event `AI_ENGINE_TEST_RESULT`.
  // Payload (opcjonalny override): { urlOverride?, healthPathOverride? }
  | 'AI_ENGINE_TEST'
  | 'LPR_SNAPSHOT_GET'   // miniatura odczytu tablicy przez tunel (2026-08-07)
  // FAZA 8.h (2026-06-03) — per-camera config update.
  // Cloud → Edge gdy Integrator zmieni role (STANDARD↔LPR) albo
  // aiAnalysisEnabled. Edge zapisuje do `device_config.role` /
  // `device_config.ai_analysis_enabled`. VisionDetectService filtruje
  // listę kamer dynamicznie przy każdym cyklu.
  // Payload: { cameraDeviceId: string, role?: 'STANDARD' | 'LPR',
  //            aiAnalysisEnabled?: boolean }
  // Partial update — pola undefined są pomijane.
  | 'CAMERA_CONFIG_UPDATE'
  // FAZA 8.h.2 (2026-06-05) — pełen replace-all sync wszystkich kamer
  // w budynku. Wysyłane przy reconnect Edge (`handleConnection`) — analogicznie
  // do AP_SYNC_ALL i LPR_AP_LINK_SYNC_ALL. Defense-in-depth: gdy backfill
  // SQL na Cloud nie przejdzie przez tunel (np. migracja na produkcji),
  // przy następnym reconnect Edge dostaje aktualny stan.
  // Payload: { items: Array<{ cameraDeviceId, role, aiAnalysisEnabled }> }
  | 'CAMERA_SYNC_ALL'
  // FAZA 8.h.6 (2026-06-05) — Edge → Cloud sync dla AI Engine config.
  // Edge wysyła przy każdym WS reconnect ORAZ po PUT z Edge UI (lokalna
  // edycja URL/model). Cloud robi INSERT ON CONFLICT DO NOTHING — user-set
  // z Cloud Integrator panel ZAWSZE wygrywa. Defense-in-depth dla auto-
  // migracji z env var YOLO_URL (która dotąd była niewidoczna w Cloud UI).
  // EVT (Edge→Cloud), nie CMD.
  // Payload: { url, healthPath, model, enabled, sourceBuildingId }
  | 'AI_ENGINE_REPORT'
  // FAZA 8.h.8 (2026-06-08) — test Ollama LLM. Cloud → Edge command,
  // Edge robi GET /api/tags na Ollama, zwraca EVT `LLM_TEST_RESULT` z
  // listą faktycznie zainstalowanych modeli. Pozwala integratorowi
  // zobaczyć co jest pulled przed wyborem z presetów.
  // CMD payload (Cloud→Edge): { urlOverride? }
  // EVT payload (Edge→Cloud, LLM_TEST_RESULT): { ok, ms, statusCode,
  //   error, url, availableModels: string[] }
  | 'LLM_TEST'
  // ── Domofon: SIP↔WebRTC call bridge (2026-06-13) ────────────────────────
  // Pełen projekt: docs/intercom-akuvox-call.md. Cała grupa za flagą env
  // INTERCOM_CALL_ENABLED (default false) — bez niej Edge ignoruje te CMD-y,
  // a IntercomCallService nie rejestruje się przy bootstrapie.
  //
  // INTERCOM_CALL_INVITE  — Edge→Cloud (EVT). Akuvox zadzwonił SIP-em, Janus
  //   terminuje, Edge rozwiązał kogo wołać (deviceId→unit→residenci).
  //   Payload: { sessionId, intercomDeviceId, intercomName?, unitId?,
  //              unitLabel?, residentIds: number[], snapshotUrl? }
  // INTERCOM_CALL_ANSWER  — Cloud→Edge (CMD). Mieszkaniec odebrał; Edge zleca
  //   media serverowi przygotowanie WebRTC peera.
  //   Payload: { sessionId, residentId }
  // INTERCOM_CALL_DECLINE — Cloud→Edge (CMD). Odrzucenie / timeout. Edge
  //   wysyła SIP reject/BYE do Akuvoxa.  Payload: { sessionId, residentId }
  // INTERCOM_SIGNAL       — dwukierunkowo. WebRTC SDP/ICE między iOS a Janusem
  //   przekazywany przez Cloud relay.
  //   Payload: { sessionId, kind: 'offer'|'answer'|'ice', sdp?, candidate?,
  //              from: 'edge'|'app' }
  // INTERCOM_CALL_HANGUP  — Cloud→Edge (CMD). Rozłączenie z apki/systemu.
  //   Payload: { sessionId, by: 'app'|'caller'|'system' }
  // INTERCOM_CALL_ENDED   — Edge→Cloud (EVT). Janus/Akuvox zakończył.
  //   Payload: { sessionId, endReason }
  | 'INTERCOM_CALL_INVITE'
  | 'INTERCOM_CALL_ANSWER'
  | 'INTERCOM_CALL_DECLINE'
  | 'INTERCOM_SIGNAL'
  | 'INTERCOM_CALL_HANGUP'
  | 'INTERCOM_CALL_STATION'
  | 'INTERCOM_CALL_ENDED'
  // ── Multi-station (2026-07-05) ─────────────────────────────────────────
  // INTERCOM_SYNC_ALL — Cloud→Edge (CMD). Pełen rejestr stacji budynku
  //   (mirror building_intercoms → sqlite intercom_bridge). Wysyłany przy
  //   reconnect (pushAccessPointSync) + live po edycji w panelu Integratora.
  //   Payload: { items: [{ intercomId, buildingId, name, edgeDeviceId,
  //              ipAddress, bridgeEnabled }] }
  // INTERCOM_STATION_BUSY — Edge→Cloud (EVT). Janus (1 handle SIP = 1
  //   aktywne połączenie na budynek) odrzucił równoległe wywołanie z innej
  //   stacji (486 Busy / missed_call). Payload: { fromUri }
  | 'INTERCOM_SYNC_ALL'
  | 'INTERCOM_STATION_BUSY'

// ── Device status ─────────────────────────────────────────────────────────────
export interface DeviceStatusEntry {
  id: string
  type: 'INTERCOM' | 'CAMERA' | 'ELEVATOR' | 'LIGHTING' | 'MQTT'
  label: string
  status: 'online' | 'offline' | 'unknown'
  lastSeen?: number
}
