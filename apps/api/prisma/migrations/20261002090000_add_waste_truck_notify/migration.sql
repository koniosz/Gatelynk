-- Powiadomienie o przyjeździe śmieciarki (2026-10-02).
-- buildings.wasteTruckNotifyAll — administrator włącza powiadomienie dla
--   wszystkich mieszkańców osiedla (domyślnie wyłączone).
-- residents.notifyWasteTruck — wybór mieszkańca w aplikacji: NULL = jak
--   ustawił administrator, true/false = własna decyzja (ma pierwszeństwo).
ALTER TABLE "buildings" ADD COLUMN "wasteTruckNotifyAll" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "residents" ADD COLUMN "notifyWasteTruck" BOOLEAN;
