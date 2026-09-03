-- Domownicy (2026-08-09): mieszkaniec zaprasza domownika ze swojej aplikacji.
-- Domownik dostaje pełnoprawne konto Resident przypięte pivotem unit_residents
-- do TEGO SAMEGO lokalu. Migracja idempotentna (IF NOT EXISTS / guarded DO).

-- 1. Enum statusu zaproszenia domownika (osobny od InvitationStatus — ma CANCELLED).
DO $$ BEGIN
  CREATE TYPE "HouseholdInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'CANCELLED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Audyt pochodzenia konta: kto zaprosił tego mieszkańca (NULL = admin/import).
ALTER TABLE "residents" ADD COLUMN IF NOT EXISTS "invitedByResidentId" INTEGER;

DO $$ BEGIN
  ALTER TABLE "residents"
    ADD CONSTRAINT "residents_invitedByResidentId_fkey"
    FOREIGN KEY ("invitedByResidentId") REFERENCES "residents"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Tabela zaproszeń domowników.
--    `token` jawny (wzór Guest.urlToken) — re-share z listy w aplikacji;
--    krótkotrwały (7 dni), jednorazowy, unieważnialny z apki.
CREATE TABLE IF NOT EXISTS "household_invitations" (
  "id"                  SERIAL PRIMARY KEY,
  "buildingId"          INTEGER NOT NULL,
  "unitId"              INTEGER NOT NULL,
  "invitedByResidentId" INTEGER NOT NULL,
  "inviteeName"         TEXT NOT NULL,
  "relationLabel"       TEXT,
  "token"               TEXT NOT NULL,
  "status"              "HouseholdInvitationStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"           TIMESTAMP(3) NOT NULL,
  "acceptedAt"          TIMESTAMP(3),
  "acceptedResidentId"  INTEGER,
  CONSTRAINT "household_invitations_buildingId_fkey"
    FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "household_invitations_unitId_fkey"
    FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "household_invitations_invitedByResidentId_fkey"
    FOREIGN KEY ("invitedByResidentId") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "household_invitations_acceptedResidentId_fkey"
    FOREIGN KEY ("acceptedResidentId") REFERENCES "residents"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "household_invitations_token_key"
  ON "household_invitations"("token");
CREATE INDEX IF NOT EXISTS "household_invitations_unitId_status_idx"
  ON "household_invitations"("unitId", "status");
CREATE INDEX IF NOT EXISTS "household_invitations_invitedByResidentId_status_idx"
  ON "household_invitations"("invitedByResidentId", "status");
