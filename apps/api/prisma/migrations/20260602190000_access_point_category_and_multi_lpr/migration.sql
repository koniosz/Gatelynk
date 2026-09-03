-- 2026-06-02 — FAZA c: AccessPoint.category + multi-LPR per AP.
--
-- 1. AccessPoint dostaje semantyczną kategorię (główna brama / pożarowa /
--    pieszy / garaż / serwisowa). Default 'MAIN_ENTRY' dla istniejących —
--    integrator może je przeklasyfikować w panelu.
-- 2. Nowa tabela `lpr_camera_ap_links` (many-to-many) — pozwala 1 kamerze być
--    powiązaną z wieloma AP (np. ta sama brama: wjazdowa+wyjazdowa) i 1 AP
--    mieć wiele kamer. `direction` (IN/OUT) rozróżnia stronę. Backfill:
--    `edge_device_mirror.config.linkedAccessPointId` (legacy single-link) →
--    1 row per kamerę z direction='IN'.

-- 1. AccessPoint.category
ALTER TABLE "access_points" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'MAIN_ENTRY';

-- 2. lpr_camera_ap_links
CREATE TABLE IF NOT EXISTS "lpr_camera_ap_links" (
  "id"                SERIAL PRIMARY KEY,
  "cameraDeviceUuid"  TEXT NOT NULL,
  "accessPointId"     INTEGER NOT NULL REFERENCES "access_points"("id") ON DELETE CASCADE,
  "direction"         TEXT NOT NULL DEFAULT 'IN',
  "buildingId"        INTEGER NOT NULL REFERENCES "buildings"("id") ON DELETE CASCADE,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("cameraDeviceUuid", "accessPointId")
);
CREATE INDEX IF NOT EXISTS "lpr_camera_ap_links_apId_idx" ON "lpr_camera_ap_links" ("accessPointId");
CREATE INDEX IF NOT EXISTS "lpr_camera_ap_links_buildingId_idx" ON "lpr_camera_ap_links" ("buildingId");

-- 3. Backfill — dla każdej LPR_CAMERA w edge_device_mirror gdzie
--    config.linkedAccessPointId jest int, utwórz link direction='IN'.
--    Idempotent przez ON CONFLICT.
INSERT INTO "lpr_camera_ap_links" ("cameraDeviceUuid", "accessPointId", "direction", "buildingId")
SELECT
  m."deviceUuid",
  (m."config" ->> 'linkedAccessPointId')::int AS "accessPointId",
  'IN' AS direction,
  m."buildingId"
FROM "edge_device_mirror" m
WHERE m."type" = 'LPR_CAMERA'
  AND (m."config" ->> 'linkedAccessPointId') IS NOT NULL
  AND (m."config" ->> 'linkedAccessPointId') ~ '^[0-9]+$'
ON CONFLICT DO NOTHING;
