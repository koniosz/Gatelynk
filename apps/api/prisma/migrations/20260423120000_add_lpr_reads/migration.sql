-- LPR reads: historic log of ANPR detections pushed from Edge.
-- Retention: 30 days (swept nightly). No plate images stored.
-- See apps/edge/src/store/store.service.ts for the Edge-local copy.

CREATE TABLE "lpr_reads" (
    "id"             SERIAL PRIMARY KEY,
    "buildingId"     INTEGER NOT NULL,
    "cameraDeviceId" TEXT    NOT NULL,
    "plate"          TEXT    NOT NULL,
    "matched"        BOOLEAN NOT NULL,
    "owner"          TEXT,
    "gateOpened"     BOOLEAN NOT NULL,
    "reason"         TEXT,
    "confidence"     DOUBLE PRECISION,
    "direction"      TEXT,
    "edgeReadId"     INTEGER,
    "ts"             TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lpr_reads_buildingId_fkey"
        FOREIGN KEY ("buildingId") REFERENCES "buildings"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "lpr_reads_buildingId_ts_idx"       ON "lpr_reads" ("buildingId", "ts" DESC);
CREATE INDEX "lpr_reads_buildingId_plate_ts_idx" ON "lpr_reads" ("buildingId", "plate", "ts" DESC);
CREATE INDEX "lpr_reads_cameraDeviceId_ts_idx"   ON "lpr_reads" ("cameraDeviceId", "ts" DESC);
CREATE INDEX "lpr_reads_plate_idx"               ON "lpr_reads" ("plate");
