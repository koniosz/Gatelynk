-- Vehicle approval flow (Faza 1 bety Villa Natura).
--
-- Cykl życia pojazdu:
--   PENDING   — zarejestrowany przez mieszkańca, czeka na decyzję admina
--   APPROVED  — aktywny, synchronizowany do allowlisty LPR
--   REJECTED  — admin odmówił, podaje powód w `rejectionReason`
--   BLOCKED   — admin tymczasowo zablokował aktywny pojazd
--   EXPIRED   — guest car po terminie `validTo` (cron job ustawi w fazie 2)
--
-- Default APPROVED dla istniejących rzędów żeby nie wywalić działającego
-- LPR sync — historyczne pojazdy nie powinny nagle wpaść w "do zatwierdzenia".
-- Tylko nowe pojazdy tworzone przez resident-a będą jawnie ustawiać PENDING
-- na poziomie aplikacji (resident.service.ts).

CREATE TYPE "VehicleStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'BLOCKED', 'EXPIRED');

ALTER TABLE "vehicles"
  ADD COLUMN "status"          "VehicleStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "validFrom"       TIMESTAMP(3),
  ADD COLUMN "validTo"         TIMESTAMP(3),
  ADD COLUMN "approvedById"    INTEGER,
  ADD COLUMN "approvedByType"  TEXT,
  ADD COLUMN "approvedAt"      TIMESTAMP(3),
  ADD COLUMN "rejectionReason" TEXT;

CREATE INDEX "vehicles_buildingId_status_idx" ON "vehicles"("buildingId", "status");
