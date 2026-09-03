-- Faza B-2 (Wizard Edge → Cloud sync, 2026-05-13)
--
-- Tabela `edge_device_mirror` — Cloud-side mirror urządzeń z Edge sqlite.
-- Edge wysyła DEVICE_UPSERT/DELETE/SYNC_ALL przez WS tunnel; Cloud zapisuje tu.
-- Source of truth = Edge sqlite. Cloud panel BA czyta z tej tabeli zamiast
-- z legacy `building_intercoms` / `lpr_cameras`.
--
-- Backfill: dotychczasowe wpisy w BuildingIntercom + LprCamera (które mają
-- `edgeDeviceId` — czyli są podpięte do realnego Edge) są skopiowane do
-- mirror-a. Pozostają w starych tabelach jako legacy. Po Edge reconnect (i
-- DEVICE_SYNC_ALL) wpisy w mirror zostaną zaktualizowane pełnym configiem
-- ze sqlite Edge (z hasłami itp.).

CREATE TABLE "edge_device_mirror" (
    "id"            SERIAL PRIMARY KEY,
    "buildingId"    INTEGER NOT NULL,
    "edgeDeviceId"  TEXT,
    "deviceUuid"    TEXT NOT NULL,
    "type"          TEXT NOT NULL,
    "driverId"      TEXT,
    "config"        JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_device_mirror_buildingId_fkey"
        FOREIGN KEY ("buildingId") REFERENCES "buildings"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "edge_device_mirror_edgeDeviceId_fkey"
        FOREIGN KEY ("edgeDeviceId") REFERENCES "edge_devices"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "edge_device_mirror_buildingId_deviceUuid_key"
    ON "edge_device_mirror"("buildingId", "deviceUuid");

CREATE INDEX "edge_device_mirror_buildingId_type_idx"
    ON "edge_device_mirror"("buildingId", "type");

-- ── Backfill 1: BuildingIntercom ─────────────────────────────────────────────
-- bi.edgeDeviceId to UUID urządzenia w Edge sqlite (mylące pole — w Cloud
-- AccessPoint to ten sam typ string i nazywa się tak samo).
INSERT INTO "edge_device_mirror" ("buildingId", "deviceUuid", "type", "config", "lastSyncedAt", "createdAt")
SELECT
    bi."buildingId",
    bi."edgeDeviceId",
    'INTERCOM',
    jsonb_strip_nulls(jsonb_build_object(
        'name',         bi.name,
        'model',        bi.model,
        'ipAddress',    bi."ipAddress",
        'sipServer',    bi."sipServer",
        'sipAccount',   bi."sipAccount",
        'sipPassword',  bi."sipPassword"
    )),
    bi."updatedAt",
    bi."createdAt"
FROM "building_intercoms" bi
WHERE bi."edgeDeviceId" IS NOT NULL
ON CONFLICT ("buildingId", "deviceUuid") DO NOTHING;

-- ── Backfill 2: LprCamera ────────────────────────────────────────────────────
INSERT INTO "edge_device_mirror" ("buildingId", "deviceUuid", "type", "config", "lastSyncedAt", "createdAt")
SELECT
    lc."buildingId",
    lc."edgeDeviceId",
    'LPR_CAMERA',
    jsonb_strip_nulls(jsonb_build_object(
        'name',                  lc.name,
        'manufacturer',          lc.manufacturer,
        'model',                 lc.model,
        'ipAddress',             lc."ipAddress",
        'login',                 lc.login,
        'password',              lc.password,
        'whitelistMode',         lc."whitelistMode",
        'cameraListSyncMethod',  lc."cameraListSyncMethod",
        'linkedIntercomEdgeId',  lc."linkedIntercomEdgeId",
        'linkedRelayIndex',      lc."linkedRelayIndex"
    )),
    lc."updatedAt",
    COALESCE(lc."updatedAt", CURRENT_TIMESTAMP)
FROM "lpr_cameras" lc
WHERE lc."edgeDeviceId" IS NOT NULL
ON CONFLICT ("buildingId", "deviceUuid") DO NOTHING;
