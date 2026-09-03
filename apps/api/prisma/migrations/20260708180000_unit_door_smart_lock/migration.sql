-- 2026-07-08 — Nuki Smart Lock (UNIT_DOOR):
--   1. AccessPoint.unitId — AP przypisany do lokalu (widoczny tylko dla
--      mieszkańców tego lokalu przez unit_residents).
--   2. guest_open_nonces — konsumpcja jednorazowych nonce'ów strony Guest Pass
--      (INSERT z unique(nonceHash) = atomowa jednorazowość, race-safe).
--   3. guest_approval_requests — tryb zatwierdzania otwarcia przez hosta.

-- 1. AccessPoint.unitId
ALTER TABLE "access_points" ADD COLUMN "unitId" INTEGER;
ALTER TABLE "access_points"
  ADD CONSTRAINT "access_points_unitId_fkey"
  FOREIGN KEY ("unitId") REFERENCES "units"(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "access_points_buildingId_unitId_idx" ON "access_points" ("buildingId", "unitId");

-- 2. guest_open_nonces
CREATE TABLE "guest_open_nonces" (
  id              BIGSERIAL PRIMARY KEY,
  "guestId"       INTEGER NOT NULL REFERENCES "guests"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "accessPointId" INTEGER REFERENCES "access_points"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "nonceHash"     VARCHAR(64) NOT NULL,
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "consumedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "guest_open_nonces_nonceHash_key" ON "guest_open_nonces" ("nonceHash");
CREATE INDEX "guest_open_nonces_expiresAt_idx" ON "guest_open_nonces" ("expiresAt");

-- 3. guest_approval_requests
CREATE TABLE "guest_approval_requests" (
  id              BIGSERIAL PRIMARY KEY,
  "buildingId"    INTEGER NOT NULL REFERENCES "buildings"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "guestId"       INTEGER NOT NULL REFERENCES "guests"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "accessPointId" INTEGER NOT NULL REFERENCES "access_points"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "residentId"    INTEGER NOT NULL REFERENCES "residents"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  status          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "gateOpened"    BOOLEAN NOT NULL DEFAULT false,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "respondedAt"   TIMESTAMP(3),
  meta            JSONB
);
CREATE INDEX "guest_approval_requests_residentId_status_expiresAt_idx"
  ON "guest_approval_requests" ("residentId", status, "expiresAt");
CREATE INDEX "guest_approval_requests_guestId_accessPointId_status_idx"
  ON "guest_approval_requests" ("guestId", "accessPointId", status);
