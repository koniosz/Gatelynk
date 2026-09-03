-- Vehicle kinds: partition the fleet into residents vs recurring services.
--
-- Until now every row in `vehicles` was a resident's car. Adding a typology
-- lets us also whitelist building-level vehicles (garbage collection, postal
-- couriers, utility services, emergency) without faking a resident owner.
--
-- A building-wide service has kind != RESIDENT and residentId = NULL; a
-- resident-owned car keeps kind = RESIDENT and residentId set. A resident
-- may also flag one of their own vehicles as SERVICE (e.g. "my cleaning
-- person") — the residentId stays, we use `kind` just for display.
--
-- `serviceName` is free-form ("Glovo", "Poczta Polska", "MPO Odpady"). The
-- (buildingId, kind, serviceName) index powers autocomplete in the panel
-- without loading the whole vehicle list.
--
-- Time-windowed access (allowedDays/From/To) is deferred to a later change.

CREATE TYPE "VehicleKind" AS ENUM (
  'RESIDENT',
  'SERVICE',
  'DELIVERY',
  'EMERGENCY',
  'PUBLIC'
);

ALTER TABLE "vehicles"
  ADD COLUMN "kind"        "VehicleKind" NOT NULL DEFAULT 'RESIDENT',
  ADD COLUMN "serviceName" TEXT,
  ADD COLUMN "notes"       TEXT;

-- Residents column becomes optional: building-wide services have no resident.
ALTER TABLE "vehicles" ALTER COLUMN "residentId" DROP NOT NULL;

-- Autocomplete + filter index. The service name is used as a case-insensitive
-- LIKE target, so we keep it plain text (no functional index — rows are small
-- enough that a sequential scan within a single building is fine).
CREATE INDEX "vehicles_building_kind_idx"
  ON "vehicles" ("buildingId", "kind");
