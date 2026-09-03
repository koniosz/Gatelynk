-- AlterTable: dodaj 3 nowe pola do `integrators` dla Panel Integratora Sesja 3.
--   company           — wyświetlane w karcie integratora w Sidebarze
--   notificationPrefs — JSONB z preferencjami powiadomień (offline alerts, FW updates, etc.)
--   updatedAt         — standardowy audit field, default CURRENT_TIMESTAMP

ALTER TABLE "integrators"
  ADD COLUMN IF NOT EXISTS "company" TEXT,
  ADD COLUMN IF NOT EXISTS "notificationPrefs" JSONB,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
