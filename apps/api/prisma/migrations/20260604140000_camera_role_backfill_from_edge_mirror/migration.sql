-- FAZA 8.h.1 (2026-06-04) — drugi backfill `lpr_cameras.role` na podstawie
-- typu z Edge mirror.
--
-- Pierwsza migracja (`20260603120000_camera_role_and_ai_toggle`) ustawiła
-- wszystkim role='LPR' — bo nie miała JOIN-a z `edge_device_mirror`.
-- W praktyce Edge raportuje TYP `'CAMERA'` dla zwykłych kamer wizyjnych
-- (np. Kamera HikV — Hikvision ColorVu bez ANPR) i `'LPR_CAMERA'` dla
-- Hikvision DeepinView z rozpoznawaniem tablic.
--
-- Idempotentne: aktualizujemy TYLKO te wpisy które:
--   1. Mają edgeDeviceId (czyli faktycznie powiązane z Edge — Cloud-only
--      pozostają jako 'LPR' bo nie wiemy bez Edge).
--   2. Ich Edge mirror mówi `type='CAMERA'` — czyli AKTYWNY mismatch.
--   3. Mają obecne role='LPR' — nie nadpisujemy świadomych user-set zmian.

UPDATE "lpr_cameras" lc
   SET "role" = 'STANDARD'
  FROM "edge_device_mirror" m
 WHERE m."edgeDeviceId" = lc."edgeDeviceId"
   AND m."type" = 'CAMERA'
   AND lc."role" = 'LPR';
