-- Edge → Cloud LPR backfill deduplication.
--
-- Edge buforuje wszystkie ANPR-y w lokalnym `lpr_reads` z kolumną
-- `synced_to_cloud`. Po reconnect (WS upadł, API restart, etc.) Edge wysyła
-- backfill: wszystkie rekordy z `synced_to_cloud = 0` przelatują przez tunel
-- jako `LPR_READ`. Bez tego indeksu duplikaty (te 4 ostatnie odczyty, które
-- już były w Cloud przed restartem) wpadałyby do bazy ponownie.
--
-- `edgeReadId` jest stabilnym identyfikatorem nadanym przez SQLite na Edge,
-- więc razem z `(buildingId, cameraDeviceId)` jednoznacznie identyfikuje
-- pojedynczy odczyt. Index jest partial — historyczne wiersze z
-- `edgeReadId IS NULL` (przed wprowadzeniem kolumny lub źle przesłane) nie
-- powinny blokować INSERT-ów. PostgreSQL i tak traktowałby NULL-e w UNIQUE
-- jako różne, ale partial index jest tańszy.
CREATE UNIQUE INDEX "lpr_reads_buildingId_cameraDeviceId_edgeReadId_uq"
  ON "lpr_reads" ("buildingId", "cameraDeviceId", "edgeReadId")
  WHERE "edgeReadId" IS NOT NULL;
