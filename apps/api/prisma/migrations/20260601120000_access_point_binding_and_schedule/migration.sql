-- 2026-06-01 — Access Point refactor: device→output binding + cron schedules.
--
-- Cel: oddzielić "logiczny" access point (Wjazd LPR / Furtka) od fizycznego
-- driveru wyjścia. Dziś LPR open-door waliduje wszystko po `linkedRelayIndex`
-- w configu kamery LPR a manual remote-open uderza prosto w Akuvox doorIndex.
-- Po refactorze AccessPoint trzyma binding device→output, a admin może łatwo
-- zmienić, że Wjazd LPR otwiera teraz drugi przekaźnik Hikvision zamiast
-- doorIndex 0 Akuvox-a. Dodatkowo każdy AP może mieć N cron-owanych
-- harmonogramów (np. otwarcie szlabanu w godz. 17–20 codziennie).
--
-- Migracja idempotentna — może być re-runowana bez efektów ubocznych.

-- 1) AccessPoint: nowe kolumny binding/scope/duration.
ALTER TABLE "access_points"
  ADD COLUMN IF NOT EXISTS "outputDeviceId" TEXT;
ALTER TABLE "access_points"
  ADD COLUMN IF NOT EXISTS "outputIndex" INTEGER;
ALTER TABLE "access_points"
  ADD COLUMN IF NOT EXISTS "durationMs" INTEGER NOT NULL DEFAULT 800;
ALTER TABLE "access_points"
  ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'RESIDENT';

-- 2) Schedules (cron-owe auto-open).
CREATE TABLE IF NOT EXISTS "access_point_schedules" (
  "id"              SERIAL PRIMARY KEY,
  "accessPointId"   INTEGER NOT NULL REFERENCES "access_points"("id") ON DELETE CASCADE,
  "cronExpr"        TEXT NOT NULL,                -- standardowy 5-pól cron, np. "0 18 * * *"
  "label"           TEXT,
  "enabled"         BOOLEAN NOT NULL DEFAULT TRUE,
  "lastFiredAt"     TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Filtr „wszystkie enabled per AP" — używany w cron loop na Edge przez sync.
CREATE INDEX IF NOT EXISTS "access_point_schedules_accessPointId_enabled_idx"
  ON "access_point_schedules" ("accessPointId", "enabled");

-- 3) AccessEventType enum: nowa wartość SCHEDULED_OPEN dla audytu cron triggera.
DO $$
BEGIN
  ALTER TYPE "AccessEventType" ADD VALUE IF NOT EXISTS 'SCHEDULED_OPEN';
EXCEPTION WHEN duplicate_object THEN
  -- enum value już istnieje, nic nie robimy
  NULL;
END $$;

-- 4) Backfill: outputDeviceId = deviceId, outputIndex = relayIndex
--    dla wszystkich AP sprzed migracji (1:1 mapping). Po backfill-u Edge
--    może resolveować driver przez binding od razu, bez fallback-u na legacy.
UPDATE "access_points"
   SET "outputDeviceId" = "deviceId",
       "outputIndex"    = "relayIndex"
 WHERE "outputDeviceId" IS NULL
   AND "deviceId" IS NOT NULL
   AND "relayIndex" IS NOT NULL;
