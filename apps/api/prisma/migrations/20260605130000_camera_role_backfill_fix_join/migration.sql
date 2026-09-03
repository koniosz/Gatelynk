-- FAZA 8.h.2 (2026-06-05) — naprawiony backfill role po prawidłowym JOIN.
--
-- Poprzednia migracja `20260604140000_camera_role_backfill_from_edge_mirror`
-- robiła JOIN po `m.edgeDeviceId = lc.edgeDeviceId` — semantycznie ZŁE.
-- `EdgeDeviceMirror.edgeDeviceId` to cuid serwera Edge (Mac Mini), a
-- `LprCamera.edgeDeviceId` to UUID konkretnego urządzenia w Edge sqlite
-- (= `EdgeDeviceMirror.deviceUuid`). Stąd 0 rows updated.
--
-- Ta migracja JOIN-uje po prawidłowym kluczu: `m.deviceUuid = lc.edgeDeviceId`.
-- Idempotentna: aktualizuje tylko wpisy z mismatch (mirror.type='CAMERA' ale
-- lc.role='LPR'). Nie nadpisuje świadomych user-set 'STANDARD'.

UPDATE "lpr_cameras" lc
   SET "role" = 'STANDARD'
  FROM "edge_device_mirror" m
 WHERE m."deviceUuid" = lc."edgeDeviceId"
   AND m."buildingId" = lc."buildingId"
   AND m."type" = 'CAMERA'
   AND lc."role" = 'LPR';
