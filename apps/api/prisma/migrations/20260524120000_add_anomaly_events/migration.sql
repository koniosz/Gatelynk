-- 2026-05-24 — fall detection (Etap 3): Cloud persistence + push notify.
-- Edge AI (YOLOv8-pose w `yolo-vision`) wysyła `EVT { event: 'ANOMALY_DETECTED' }`
-- po wykryciu upadku → Cloud persyst-uje tutaj + push do BA/Konsjerża + opt-in
-- mieszkańców.

-- Opt-in flag dla mieszkańca. Domyślnie OFF — user świadomie włącza w iOS.
ALTER TABLE "residents"
  ADD COLUMN IF NOT EXISTS "notifyAnomalies" BOOLEAN NOT NULL DEFAULT FALSE;

-- Główna tabela.
CREATE TABLE IF NOT EXISTS "anomaly_events" (
  "id"             BIGSERIAL PRIMARY KEY,
  "buildingId"     INTEGER NOT NULL REFERENCES "buildings"("id") ON DELETE CASCADE,
  "cameraDeviceId" TEXT NOT NULL,
  "ts"             TIMESTAMP(3) NOT NULL,
  "type"           TEXT NOT NULL,                 -- 'FALL' | (przyszłość: 'FIRE','INTRUSION')
  "likelihood"     DOUBLE PRECISION NOT NULL,     -- 0.0–1.0
  "indicators"     JSONB NOT NULL,                -- ["horizontal_bbox", ...]
  "imageFilename"  TEXT,                          -- jpeg w Edge `/vision/frame/:filename`
  "resolvedAt"     TIMESTAMP(3),
  "resolvedBy"     TEXT,                          -- "BA:<id>" / "CONCIERGE:<id>"
  "falsePositive"  BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Chronologiczny listing (feed) per budynek — DESC sort dla reverse-scan tańszy.
CREATE INDEX IF NOT EXISTS "anomaly_events_buildingId_ts_idx"
  ON "anomaly_events" ("buildingId", "ts" DESC);

-- Filtr "tylko nieobsłużone" — używany w stat-cards BA dashboard.
CREATE INDEX IF NOT EXISTS "anomaly_events_buildingId_resolvedAt_idx"
  ON "anomaly_events" ("buildingId", "resolvedAt");
