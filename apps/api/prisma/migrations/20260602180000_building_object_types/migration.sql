-- 2026-06-02 — Universal object types (FAZA b)
--
-- Wprowadzamy rozróżnienie BLOK vs OSIEDLE DOMÓW vs CAMPUS na poziomie modelu
-- danych. `objectType` zostaje TEXT (zachowujemy backwards-compat), ale po
-- stronie aplikacji mamy stały zestaw wartości w `OBJECT_TYPES` constant.
-- `features` JSONB trzyma per-typ flagi behavioralne (concierge, central
-- mailbox, delivery_to_door, security_guard, common_parking). Strukturę
-- zostawiamy open (JSON), żeby nowe flagi można dodawać bez migracji.

-- 1. Kolumna features JSONB (idempotent).
ALTER TABLE "buildings" ADD COLUMN IF NOT EXISTS "features" JSONB NOT NULL DEFAULT '{}';

-- 2. Backfill defaultów dla BUILDING — tylko gdy features puste (idempotent).
UPDATE "buildings" SET "features" = '{
  "has_concierge": true,
  "has_central_mailbox": true,
  "delivery_to_door": false,
  "has_security_guard": false,
  "has_common_parking": true
}'::jsonb
WHERE "objectType" = 'BUILDING' AND ("features" = '{}'::jsonb OR "features" IS NULL);

-- 3. Backfill defaultów dla HOUSING_ESTATE.
UPDATE "buildings" SET "features" = '{
  "has_concierge": false,
  "has_central_mailbox": false,
  "delivery_to_door": true,
  "has_security_guard": true,
  "has_common_parking": false
}'::jsonb
WHERE "objectType" = 'HOUSING_ESTATE' AND ("features" = '{}'::jsonb OR "features" IS NULL);

-- 4. Villa Natura (id=9) → HOUSING_ESTATE z features (delivery_to_door=true).
-- Tylko gdy nadal jest BUILDING (idempotent — re-run nie nadpisze świadomej
-- decyzji admina o zmianie).
UPDATE "buildings" SET "objectType" = 'HOUSING_ESTATE',
  "features" = '{
    "has_concierge": false,
    "has_central_mailbox": false,
    "delivery_to_door": true,
    "has_security_guard": false,
    "has_common_parking": false
  }'::jsonb
WHERE id = 9 AND "objectType" = 'BUILDING';
