-- Day Summary v2 pushe (2026-08-17): opt-out porannego briefu per mieszkaniec.
ALTER TABLE "residents" ADD COLUMN "morningBriefEnabled" BOOLEAN NOT NULL DEFAULT true;
