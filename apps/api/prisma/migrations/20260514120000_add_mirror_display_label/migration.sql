-- Faza B-4 (2026-05-14): displayLabel dla `edge_device_mirror`.
--
-- Cel: rozdzielić TECHNICZNĄ nazwę urządzenia (config.name z wizarda Edge — np.
-- „Akuvox R29 wjazd główny") od nazwy WYŚWIETLANEJ w aplikacji mieszkańca i
-- panelu BA (np. „Wjazd główny" — krótsze, czytelne).
--
-- Hierarchia ról (z dnia 2026-05-14):
--   1. Integrator dodaje urządzenie w Edge wizard → config.name = nazwa techniczna
--   2. Edge push DEVICE_UPSERT → Cloud INSERT → displayLabel = config.name (init)
--   3. Building Admin może edytować displayLabel inline → updatedBy = 'building-admin'
--   4. Mieszkaniec / portier widzą displayLabel
--
-- Reguła: po edycji przez BA/Integrator displayLabel NIE jest nadpisywany przez
-- kolejne DEVICE_UPSERT z Edge (logic w `EdgeService.mirrorUpsertDevice` —
-- `COALESCE(existing.displayLabel, new.displayLabel)`).

ALTER TABLE "edge_device_mirror"
  ADD COLUMN "displayLabel"    TEXT,
  ADD COLUMN "labelUpdatedBy"  TEXT,
  ADD COLUMN "labelUpdatedAt"  TIMESTAMP(3);

-- Backfill — istniejące mirrory dostają displayLabel z config.name (jeśli jest).
-- Source 'edge-init' oznacza że to było bootstrap, BA może swobodnie nadpisać.
UPDATE "edge_device_mirror"
   SET "displayLabel"   = NULLIF(TRIM(config->>'name'), ''),
       "labelUpdatedBy" = 'edge-init',
       "labelUpdatedAt" = "createdAt"
 WHERE "displayLabel" IS NULL
   AND config->>'name' IS NOT NULL;
