-- Faza 7.5 — Unique plate per building (defense-in-depth dla bug-a z Fazy 1).
--
-- Wcześniej duplicate-guard był tylko w aplikacji (`createVehicle` w
-- BuildingAdminService + ConciergeService) — działał, ale UI mógł przed
-- naprawą Fazy 4 utworzyć duplikaty rapid-double-click-iem. W produkcji
-- (building 9) zostały 3 grupy dupes:
--   • WB8526V  (ids: 30, 31, 32)   — Seat + literówka „#1028" + Seat
--   • WW7657W  (ids: 13, 38, 39)   — Dacia × 3
--   • WWL6083P (ids: 33, 34)       — Citroen × 2
-- Plus już zafiksowane ręcznie: WU4829S (id=40 „Rangę Rover" usunięty
-- 2026-05-06 po raporcie usera).
--
-- Strategia cleanup-u: ZACHOWAJ NAJNOWSZY wpis każdej grupy (id DESC).
-- Najnowszy bo ostatnio dotykany przez admina/usera, więc najbardziej
-- prawdopodobnie ten „intencjonalny". Audit-log w `access_events` pozostaje
-- — `vehicleId` FK ma `onDelete: SetNull`, więc kasowanie pojazdu nie
-- niszczy historii wjazdów (zostają z `vehicleId=NULL` ale plate-text
-- snapshot dalej trzymany).

-- 1) Cleanup: usuń wszystkie poza najnowszym z każdej grupy (buildingId, plate).
--    Self-join + DELETE z subquery wybiera id-y do usunięcia.
DELETE FROM "vehicles" v
 WHERE EXISTS (
   SELECT 1 FROM "vehicles" v2
    WHERE v2."buildingId"   = v."buildingId"
      AND v2."licensePlate" = v."licensePlate"
      AND v2.id > v.id
 );

-- 2) Unique index — od teraz baza odrzuca każdy duplikat zanim aplikacja
--    nawet zobaczy. Defense-in-depth: UI używa PATCH, BackendService ma guard,
--    DB unique constraint to ostatnia linia obrony.
CREATE UNIQUE INDEX "vehicles_buildingId_licensePlate_key"
  ON "vehicles" ("buildingId", "licensePlate");

-- 3) Symetrycznie: PIN-y gości w obrębie budynku też powinny być unique
--    (PIN aktywnego gościa nie może kolidować z innym aktywnym, bo Edge
--    nie wie którego gościa wpuścić). `generateUniqueGuestPin` już to
--    sprawdza w `concierge.service.ts` / `resident.service.ts`, ale nie ma
--    bariery DB. Partial index (only WHERE status='ACTIVE') żeby nie blokować
--    historycznych anulowanych ticket-ów z reused-PIN-em.
CREATE UNIQUE INDEX "guests_buildingId_pin_active_key"
  ON "guests" ("buildingId", "pin")
 WHERE status = 'ACTIVE';
