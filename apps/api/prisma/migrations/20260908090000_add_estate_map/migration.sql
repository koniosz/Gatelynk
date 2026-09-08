-- Mapa osiedla + przypisania lokali do miejsc na mapie (2026-09-08).
--
-- estate_maps      — 1 mapa per osiedle (Building): render + konfiguracja
--                    obszarów budynków (id, etykieta, obszar x/y/w/h/a,
--                    liczba lokali 1|2, części A/B) i bram. Klucz obszaru
--                    (`buildings[].id`) jest trwale związany z tym osiedlem.
-- estate_map_slots — przypisanie: (osiedle, obszar, część) → lokal z bazy.
--                    Klucz = id lokalu, nigdy adres. Dwa UNIQUE realizują
--                    „max 1 lokal w miejscu" i „max 1 miejsce per lokal"
--                    także przy równoczesnej edycji dwóch administratorów.
CREATE TABLE "estate_maps" (
  "id"           SERIAL PRIMARY KEY,
  "buildingId"   INTEGER NOT NULL,
  "name"         TEXT NOT NULL,
  "imageUrl"     TEXT NOT NULL,
  "canvasWidth"  INTEGER NOT NULL,
  "canvasHeight" INTEGER NOT NULL,
  "config"       JSONB NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "estate_maps_buildingId_fkey" FOREIGN KEY ("buildingId")
    REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "estate_maps_buildingId_key" ON "estate_maps"("buildingId");

CREATE TABLE "estate_map_slots" (
  "id"            SERIAL PRIMARY KEY,
  "buildingId"    INTEGER NOT NULL,
  "mapBuildingId" TEXT NOT NULL,
  "slot"          TEXT NOT NULL,
  "unitId"        INTEGER NOT NULL,
  "assignedById"  INTEGER,
  "assignedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "estate_map_slots_buildingId_fkey" FOREIGN KEY ("buildingId")
    REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "estate_map_slots_unitId_fkey" FOREIGN KEY ("unitId")
    REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "estate_map_slots_unitId_key" ON "estate_map_slots"("unitId");
CREATE UNIQUE INDEX "estate_map_slots_buildingId_mapBuildingId_slot_key"
  ON "estate_map_slots"("buildingId", "mapBuildingId", "slot");
CREATE INDEX "estate_map_slots_buildingId_idx" ON "estate_map_slots"("buildingId");
