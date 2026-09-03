-- Faza 3 Villa Natura: jednorazowy backfill access_events z lpr_reads.
--
-- LprRead retencja to 30 dni — wszystko co tam siedzi w momencie deployu
-- przerzucamy do access_events (typ LPR_MATCH lub LPR_NO_MATCH zależnie
-- od `matched`). AccessEvent żyje dłużej (audit), więc po 30 dniach
-- LprRead wyparuje, a wpis w access_events zostanie ze snapshotem `plate`.
--
-- Idempotentnie: WHERE NOT EXISTS gwarantuje że ponowne uruchomienie
-- (gdyby ktoś replay-ował migrację) nie podwoi wpisów.
--
-- Vehicle/Resident lookup: LEFT JOIN po (buildingId, licensePlate). Jeśli
-- pojazd już skasowany albo nigdy nie był whitelistowany, zostaje NULL.

INSERT INTO "access_events"
  ("buildingId", "accessPointId", ts, type, direction, "gateOpened", reason,
   "residentId", "vehicleId", "guestId", "lprReadId", plate,
   "openedById", "openedByType", meta)
SELECT
  lr."buildingId",
  NULL                                  AS "accessPointId",
  lr.ts                                 AS ts,
  CASE WHEN lr.matched THEN 'LPR_MATCH'::"AccessEventType"
                       ELSE 'LPR_NO_MATCH'::"AccessEventType"
  END                                   AS type,
  lr.direction                          AS direction,
  lr."gateOpened"                       AS "gateOpened",
  lr.reason                             AS reason,
  v."residentId"                        AS "residentId",
  v.id                                  AS "vehicleId",
  NULL                                  AS "guestId",
  lr.id                                 AS "lprReadId",
  lr.plate                              AS plate,
  NULL                                  AS "openedById",
  'EDGE'                                AS "openedByType",
  jsonb_build_object(
    'cameraDeviceId', lr."cameraDeviceId",
    'edgeReadId',     lr."edgeReadId",
    'confidence',     lr.confidence,
    'backfilled',     true
  )                                     AS meta
FROM "lpr_reads" lr
LEFT JOIN "vehicles" v
  ON v."buildingId" = lr."buildingId"
 AND v."licensePlate" = lr.plate
 AND lr.matched
WHERE NOT EXISTS (
  SELECT 1 FROM "access_events" ae
  WHERE ae."lprReadId" = lr.id
    AND ae.type IN ('LPR_MATCH', 'LPR_NO_MATCH')
);
