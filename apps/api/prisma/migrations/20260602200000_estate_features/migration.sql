-- 2026-06-02 — FAZA d: Estate-specific features.
--
-- 1. Unit dostaje `street` (TEXT, nullable) + `houseType` (TEXT, default
--    'APARTMENT'). Dla bloku zostaje number="15A" + street=NULL +
--    houseType='APARTMENT'. Dla osiedla typowy use case: number="5",
--    street="Kwiatowa", houseType='HOUSE'.
-- 2. Nowa tabela `courier_visits` — kurier wpisuje 4-cyfrowy kod na klawiaturze
--    przy bramie, Edge tworzy wpis PENDING, Cloud broadcastuje push do
--    mieszkancow osiedla → "wpusc"/"nie znam" → fire AP.

-- 1. Unit columns
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "street" TEXT;
ALTER TABLE "units" ADD COLUMN IF NOT EXISTS "houseType" TEXT NOT NULL DEFAULT 'APARTMENT';

-- 2. CourierVisit
CREATE TABLE IF NOT EXISTS "courier_visits" (
  "id"            SERIAL PRIMARY KEY,
  "buildingId"    INTEGER NOT NULL REFERENCES "buildings"("id") ON DELETE CASCADE,
  "code"          VARCHAR(4) NOT NULL,
  "courierBrand"  TEXT,
  "targetUnitId"  INTEGER REFERENCES "units"("id") ON DELETE SET NULL,
  "status"        TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"    TIMESTAMP(3),
  "resolvedBy"    INTEGER,
  "expiresAt"     TIMESTAMP(3) NOT NULL
);

CREATE INDEX IF NOT EXISTS "courier_visits_buildingId_status_idx" ON "courier_visits" ("buildingId", "status");
CREATE INDEX IF NOT EXISTS "courier_visits_code_idx" ON "courier_visits" ("code");
