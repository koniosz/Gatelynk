-- FAZA e (2026-06-02) — Permissions Matrix per role.
-- Integrator decyduje per budynek + rola (BA/Concierge/Resident), które
-- system-features i AccessPoint-y są dostępne. Defaulty per objectType,
-- niezdefiniowany klucz = backend `hasPermission` zwraca `true` (defense:
-- nie blokuj features których integrator nie skonfigurował).
--
-- Shape JSON:
-- {
--   "ba":        { "feat_<key>": bool, "ap_<id>": bool, ... },
--   "concierge": { ... },
--   "resident":  { ... }
-- }
--
-- Patrz `apps/api/src/buildings/feature-permissions.constants.ts`.

ALTER TABLE "buildings"
  ADD COLUMN IF NOT EXISTS "featurePermissions" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── Backfill defaultów per `objectType` (tylko gdy puste) ─────────────────

-- HOUSING_ESTATE — osiedle domów. Brak konsjerża, kurier dochodzi do drzwi.
UPDATE "buildings"
   SET "featurePermissions" = '{
     "ba": {
       "feat_vision_ai": true,
       "feat_fall_detection": true,
       "feat_lpr_audit": true,
       "feat_guest_portal": true,
       "feat_resident_pin": true,
       "feat_courier_visits": true,
       "feat_schedules": true,
       "feat_tickets": true,
       "feat_payments": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true,
       "feat_building_branding": true
     },
     "concierge": {},
     "resident": {
       "feat_fall_detection": true,
       "feat_guest_portal": true,
       "feat_resident_pin": true,
       "feat_courier_visits": true,
       "feat_tickets": true,
       "feat_payments": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true
     }
   }'::jsonb
 WHERE "objectType" = 'HOUSING_ESTATE' AND "featurePermissions" = '{}'::jsonb;

-- BUILDING — blok wielorodzinny. Pełne wsparcie konsjerża, brak kurier flow.
UPDATE "buildings"
   SET "featurePermissions" = '{
     "ba": {
       "feat_vision_ai": true,
       "feat_fall_detection": true,
       "feat_lpr_audit": true,
       "feat_guest_portal": true,
       "feat_resident_pin": true,
       "feat_courier_visits": false,
       "feat_schedules": true,
       "feat_parcels": true,
       "feat_tickets": true,
       "feat_payments": true,
       "feat_reservations": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true,
       "feat_building_branding": true
     },
     "concierge": {
       "feat_lpr_audit": true,
       "feat_guest_portal": true,
       "feat_parcels": true,
       "feat_tickets": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true,
       "feat_reservations": true
     },
     "resident": {
       "feat_fall_detection": true,
       "feat_guest_portal": true,
       "feat_resident_pin": true,
       "feat_parcels": true,
       "feat_tickets": true,
       "feat_payments": true,
       "feat_reservations": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true
     }
   }'::jsonb
 WHERE "objectType" = 'BUILDING' AND "featurePermissions" = '{}'::jsonb;

-- MIXED_USE — sklepy + mieszkania. Jak BUILDING ale rezydent bez rezerwacji.
UPDATE "buildings"
   SET "featurePermissions" = '{
     "ba": {
       "feat_vision_ai": true,
       "feat_fall_detection": true,
       "feat_lpr_audit": true,
       "feat_guest_portal": true,
       "feat_resident_pin": true,
       "feat_courier_visits": false,
       "feat_schedules": true,
       "feat_parcels": true,
       "feat_tickets": true,
       "feat_payments": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true,
       "feat_building_branding": true
     },
     "concierge": {
       "feat_lpr_audit": true,
       "feat_guest_portal": true,
       "feat_parcels": true,
       "feat_tickets": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true
     },
     "resident": {
       "feat_fall_detection": true,
       "feat_guest_portal": true,
       "feat_resident_pin": true,
       "feat_parcels": true,
       "feat_tickets": true,
       "feat_payments": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true
     }
   }'::jsonb
 WHERE "objectType" = 'MIXED_USE' AND "featurePermissions" = '{}'::jsonb;

-- CAMPUS — wielobudynkowe. Ochrona zamiast konsjerża (concierge ma minimum).
UPDATE "buildings"
   SET "featurePermissions" = '{
     "ba": {
       "feat_vision_ai": true,
       "feat_fall_detection": true,
       "feat_lpr_audit": true,
       "feat_guest_portal": true,
       "feat_resident_pin": true,
       "feat_courier_visits": true,
       "feat_schedules": true,
       "feat_tickets": true,
       "feat_payments": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true,
       "feat_building_branding": true
     },
     "concierge": {
       "feat_lpr_audit": true,
       "feat_guest_portal": true,
       "feat_tickets": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true
     },
     "resident": {
       "feat_fall_detection": true,
       "feat_guest_portal": true,
       "feat_resident_pin": true,
       "feat_courier_visits": true,
       "feat_tickets": true,
       "feat_payments": true,
       "feat_vehicles": true,
       "feat_guests": true,
       "feat_notifications": true
     }
   }'::jsonb
 WHERE "objectType" = 'CAMPUS' AND "featurePermissions" = '{}'::jsonb;

-- PARKING — tylko parking. Minimum funkcji.
UPDATE "buildings"
   SET "featurePermissions" = '{
     "ba": {
       "feat_lpr_audit": true,
       "feat_schedules": true,
       "feat_vehicles": true,
       "feat_notifications": true
     },
     "concierge": {},
     "resident": {
       "feat_vehicles": true,
       "feat_notifications": true
     }
   }'::jsonb
 WHERE "objectType" = 'PARKING' AND "featurePermissions" = '{}'::jsonb;
