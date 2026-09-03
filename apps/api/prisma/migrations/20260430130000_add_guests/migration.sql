-- Goście (Faza 2 bety Villa Natura).
--
-- Mieszkaniec zaprasza gościa na okno czasowe (`validFrom..validTo`).
-- Gość dostaje 6-cyfrowy PIN (do domofonu Akuvox — Faza 2D) i opcjonalnie
-- może podać tablicę (idzie do allowlist LPR na czas pobytu).
--
-- Cykl życia:
--   ACTIVE     — walidny (cron ustawi EXPIRED po validTo)
--   EXPIRED    — czas się skończył; tablica usunięta z LPR allowlisty
--   CANCELLED  — mieszkaniec lub admin odwołał ręcznie
--
-- Index `(buildingId, pin)` jest dla szybkiego lookupu z webhooka Akuvox
-- (kiedy gość wpisuje PIN na klawiaturze domofonu, Edge pyta Cloud czy
-- ten PIN jest aktywny w tym budynku — `WHERE buildingId = ? AND pin = ?`).
-- Nie unique, bo różne budynki mogą mieć ten sam PIN (`buildingId` decyduje).

CREATE TYPE "GuestStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

CREATE TABLE "guests" (
  "id"            SERIAL          PRIMARY KEY,
  "buildingId"    INTEGER         NOT NULL,
  "residentId"    INTEGER         NOT NULL,
  "name"          TEXT            NOT NULL,
  "phone"         TEXT,
  "vehiclePlate"  TEXT,
  "pin"           VARCHAR(6)      NOT NULL,
  "validFrom"     TIMESTAMP(3)    NOT NULL,
  "validTo"       TIMESTAMP(3)    NOT NULL,
  "status"        "GuestStatus"   NOT NULL DEFAULT 'ACTIVE',
  "usedAt"        TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guests_buildingId_fkey"
    FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE,
  CONSTRAINT "guests_residentId_fkey"
    FOREIGN KEY ("residentId") REFERENCES "residents"("id") ON DELETE CASCADE
);

CREATE INDEX "guests_buildingId_status_idx"   ON "guests"("buildingId", "status");
CREATE INDEX "guests_buildingId_validTo_idx"  ON "guests"("buildingId", "validTo");
CREATE INDEX "guests_buildingId_pin_idx"      ON "guests"("buildingId", "pin");
