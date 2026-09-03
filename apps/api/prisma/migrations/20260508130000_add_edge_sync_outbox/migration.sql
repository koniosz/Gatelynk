-- Faza 7.6 — Persistent Edge sync queue (outbox pattern).
--
-- Problem: `EdgeGateway.sendCommand/sendToBuilding` jest fire-and-forget. Gdy
-- Edge offline w momencie wysyłania (np. PLATE_UPSERT dla nowego gościa,
-- PIN_UPSERT przy create), payload przepada bezpowrotnie. Periodic
-- `syncAccessPoints` co 5min ratuje plate-allowlist (czyta z bazy), ale
-- guest PIN-y oraz vehicle plate sync NIE są w cron-ie — dochodzi tylko
-- przez WS event przy create/update.
--
-- Rozwiązanie: outbox. Każda wiadomość Cloud→Edge zapisywana w bazie ze
-- statusem (pending/delivered/failed), przy reconnect Edge dostaje wszystkie
-- pending. Cron co 1 min retry-uje dla device-ów online z lost ACK-iem.
--
-- Model id: TEXT (random 8 znaków) — używamy go jako WS message id, żeby
-- przy ACK z tego id móc znaleźć row w O(1).

CREATE TABLE "edge_sync_outbox" (
  id              TEXT PRIMARY KEY,
  "buildingId"    INT NOT NULL REFERENCES "buildings"(id) ON DELETE CASCADE,
  -- Gdy NULL — broadcast do wszystkich Edge w budynku. Zwykle wpisujemy konkretne id,
  -- nawet dla broadcast-ów (1 row per Edge), żeby ACK / retry był per-device.
  "edgeDeviceId"  TEXT REFERENCES "edge_devices"(id) ON DELETE CASCADE,
  -- Akcja jak `sendCommand(action, payload)`: PLATE_UPSERT, PLATE_DELETE,
  -- PIN_UPSERT, PIN_DELETE, RESTART, etc.
  "action"        TEXT NOT NULL,
  "payload"       JSONB NOT NULL DEFAULT '{}'::jsonb,
  "attempts"      INT NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "lastError"     TEXT,
  "deliveredAt"   TIMESTAMP(3),
  -- Po N nieudanych próbach (10) → deadletter. Alert dla admina.
  "failedAt"      TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT NOW()
);

-- Pending dla konkretnego Edge — używane w `pendingForDevice()` przy reconnect.
CREATE INDEX "edge_sync_outbox_device_pending_idx"
  ON "edge_sync_outbox" ("edgeDeviceId", "createdAt" ASC)
 WHERE "deliveredAt" IS NULL AND "failedAt" IS NULL;

-- Pending w budynku — UI (BA dashboard "X pending" badge per Edge) używa tego.
CREATE INDEX "edge_sync_outbox_building_pending_idx"
  ON "edge_sync_outbox" ("buildingId", "createdAt" ASC)
 WHERE "deliveredAt" IS NULL AND "failedAt" IS NULL;

-- Cleanup helper — delivered starsze niż 30 dni można usunąć cron-em
-- (osobny task, nie tu). Index po deliveredAt żeby DELETE był szybki.
CREATE INDEX "edge_sync_outbox_delivered_idx"
  ON "edge_sync_outbox" ("deliveredAt")
 WHERE "deliveredAt" IS NOT NULL;
