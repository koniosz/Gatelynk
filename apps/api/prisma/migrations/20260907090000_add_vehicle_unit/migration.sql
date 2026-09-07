-- Pojazd przypisany do LOKALU (2026-09-07). Dotąd pojazd mógł mieć tylko
-- mieszkańca (residentId), a lokal był wyliczany z unit_residents. Teraz
-- administrator / konsjerż może przypisać tablicę bezpośrednio do lokalu
-- (dom na osiedlu, mieszkanie bez konta w apce, auto „wspólne" gospodarstwa).
-- residentId i unitId są niezależne — dla kind=RESIDENT aplikacja wymaga
-- co najmniej jednego z nich. Usunięcie lokalu odpina pojazd (SET NULL),
-- nie kasuje go.
ALTER TABLE "vehicles" ADD COLUMN "unitId" INTEGER;
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "vehicles_buildingId_unitId_idx" ON "vehicles"("buildingId", "unitId");
