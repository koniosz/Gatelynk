-- Ograniczenia dostępu gościa (2026-07-08):
--   • guests.allowedAccessPoints JSONB — [{apId, maxUses?}]; NULL = bez ograniczeń
--   • guests.recurringSchedule   JSONB — {days,startTime,endTime,tz}; NULL = całe okno
--   • guest_access_uses — append-only zużycie limitowanych otwarć (PORTAL/PIN/LPR)
--     z dedupKey (uuid z Edge) dla idempotentnego dosyncu po offline.

ALTER TABLE "guests" ADD COLUMN "allowedAccessPoints" JSONB;
ALTER TABLE "guests" ADD COLUMN "recurringSchedule" JSONB;

CREATE TABLE "guest_access_uses" (
    "id" BIGSERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "guestId" INTEGER NOT NULL,
    "accessPointId" INTEGER,
    "source" VARCHAR(16) NOT NULL,
    "dedupKey" VARCHAR(64),
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_access_uses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guest_access_uses_dedupKey_key" ON "guest_access_uses"("dedupKey");
CREATE INDEX "guest_access_uses_guestId_accessPointId_idx" ON "guest_access_uses"("guestId", "accessPointId");

ALTER TABLE "guest_access_uses" ADD CONSTRAINT "guest_access_uses_buildingId_fkey"
    FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guest_access_uses" ADD CONSTRAINT "guest_access_uses_guestId_fkey"
    FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "guest_access_uses" ADD CONSTRAINT "guest_access_uses_accessPointId_fkey"
    FOREIGN KEY ("accessPointId") REFERENCES "access_points"("id") ON DELETE SET NULL ON UPDATE CASCADE;
