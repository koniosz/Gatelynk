-- Faza 3 Villa Natura: ujednolicony audyt wejść.
--
-- Dotychczas mieliśmy:
--   • lpr_reads (TTL 30 dni)            — przejazdy z kamer
--   • guest_events                      — użycia PIN-u przez gości
--   • brak audytu remote-open / manual-open / domofonu
--
-- access_events to single source of truth dla „kto i jak wszedł do budynku".
-- Stare tabele zostają (są źródłem domenowym), AccessEvent to projekcja audytowa
-- żyjąca dłużej niż 30 dni (pełna historia wejść). Hook'i w serwisach LPR/PIN/
-- remote-open append-only zapisują tu nowe wpisy.

-- Enum typów eventów. Append-only — nigdy nie usuwamy wartości, tylko
-- dodajemy migracjami w razie potrzeby.
CREATE TYPE "AccessEventType" AS ENUM (
  'LPR_MATCH',       -- tablica rozpoznana, brama otwarta
  'LPR_NO_MATCH',    -- tablica nieznana / odrzucona (audyt, brama nieotwarta)
  'PIN_USED',        -- gość wpisał poprawny PIN na Akuvox
  'REMOTE_OPEN',     -- mieszkaniec/admin/concierge wcisnął „otwórz" w app
  'MANUAL_OPEN',     -- przycisk fizyczny / domofon głośnik
  'INTERCOM_CALL'    -- wezwanie domofonowe (bez otwarcia)
);

CREATE TABLE "access_events" (
  id              BIGSERIAL PRIMARY KEY,
  "buildingId"    INTEGER NOT NULL REFERENCES "buildings"(id) ON DELETE CASCADE,
  "accessPointId" INTEGER REFERENCES "access_points"(id) ON DELETE SET NULL,
  ts              TIMESTAMP(3) NOT NULL DEFAULT now(),
  type            "AccessEventType" NOT NULL,
  direction       TEXT,                   -- 'IN' / 'OUT' (głównie LPR; przy openie nieznane)
  "gateOpened"    BOOLEAN NOT NULL DEFAULT false,
  reason          TEXT,                   -- np. 'plate not in allowlist', 'PIN expired'
  "residentId"    INTEGER REFERENCES "residents"(id) ON DELETE SET NULL,
  "vehicleId"     INTEGER REFERENCES "vehicles"(id)  ON DELETE SET NULL,
  "guestId"       INTEGER REFERENCES "guests"(id)    ON DELETE SET NULL,
  "lprReadId"     INTEGER REFERENCES "lpr_reads"(id) ON DELETE SET NULL,
  plate           TEXT,                   -- snapshot — działa nawet po DELETE LprReada (TTL 30d)
  "openedById"    INTEGER,                -- residentId/adminId/conciergeId
  "openedByType"  TEXT,                   -- 'RESIDENT' / 'ADMIN' / 'CONCIERGE' / 'EDGE' / 'SYSTEM'
  meta            JSONB,                  -- ad-hoc: confidence OCR, edgeReadId, deviceId
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- Wszystkie zapytania to „ostatnie N w budynku" — DESC index daje reverse-scan.
CREATE INDEX "access_events_building_ts_idx"         ON "access_events" ("buildingId", ts DESC);
CREATE INDEX "access_events_building_type_ts_idx"    ON "access_events" ("buildingId", type, ts DESC);
CREATE INDEX "access_events_resident_ts_idx"         ON "access_events" ("residentId", ts DESC) WHERE "residentId" IS NOT NULL;
CREATE INDEX "access_events_guest_ts_idx"            ON "access_events" ("guestId", ts DESC) WHERE "guestId" IS NOT NULL;

-- Częściowy index na plate — historia po tablicy nawet po wyparowaniu LprReada.
CREATE INDEX "access_events_plate_idx"               ON "access_events" (plate) WHERE plate IS NOT NULL;
