-- Guest events log — historia zdarzeń związanych z gośćmi do widoku
-- "Historia gości" w panelu admina/konsjerża i jako źródło pushy first-use.
--
-- Zakres na razie: tylko PORTAL_OPEN (kliknięcie w portalu /g/<token>).
-- Matche LPR-owe gości NIE lądują tutaj — siedzą w `lpr_reads` z `matched=true`,
-- a endpoint historii UNION-uje oba źródła. Nie chcemy podwajać zapisów na
-- ścieżce LPR (już teraz INSERT per-frame z Edge).
--
-- onDelete: SetNull dla guest/resident/access_point — usunięcie gościa lub
-- mieszkańca nie kasuje historii (audit-friendly), wpis zostaje z null-em.
-- Cascade tylko na buildingu (gdy budynek znika, znikają wszystkie eventy).

CREATE TABLE "guest_events" (
  "id"             SERIAL       PRIMARY KEY,
  "buildingId"     INTEGER      NOT NULL,
  "guestId"        INTEGER,
  "residentId"     INTEGER,
  "via"            VARCHAR(32)  NOT NULL,
  "accessPointId"  INTEGER,
  "actorIp"        VARCHAR(64),
  "ts"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "guest_events_buildingId_fkey"    FOREIGN KEY ("buildingId")    REFERENCES "buildings"     ("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "guest_events_guestId_fkey"       FOREIGN KEY ("guestId")       REFERENCES "guests"        ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "guest_events_residentId_fkey"    FOREIGN KEY ("residentId")    REFERENCES "residents"     ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "guest_events_accessPointId_fkey" FOREIGN KEY ("accessPointId") REFERENCES "access_points" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Główny query path: "ostatnie zdarzenia w budynku X" (panel historii). DESC żeby
-- ORDER BY ts DESC LIMIT N nie wymagał sortu.
CREATE INDEX "guest_events_buildingId_ts_idx"  ON "guest_events" ("buildingId", "ts" DESC);
-- "Wszystkie zdarzenia konkretnego gościa" (drill-down z listy gości).
CREATE INDEX "guest_events_guestId_ts_idx"     ON "guest_events" ("guestId",    "ts" DESC);
-- "Moje zdarzenia" (iOS resident — feed pushy + historia własnych gości).
CREATE INDEX "guest_events_residentId_ts_idx"  ON "guest_events" ("residentId", "ts" DESC);
