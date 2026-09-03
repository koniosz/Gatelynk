-- LPR camera whitelist-mode configuration
-- See apps/edge/src/devices/cameras/hikvision-lpr.service.ts for semantics.

-- Where the plate whitelist lives + who opens the gate:
--   'edge'   — Edge (SQLite) holds plates, opens via linked intercom relay (default)
--   'camera' — plates live in the camera, camera fires its own relay
--   'hybrid' — both, with a 30s per-plate cooldown on the Edge side
ALTER TABLE "lpr_cameras" ADD COLUMN "whitelistMode" TEXT NOT NULL DEFAULT 'edge';

-- Only for 'camera' / 'hybrid': 'isapi' or 'manual_csv'
ALTER TABLE "lpr_cameras" ADD COLUMN "cameraListSyncMethod" TEXT;

-- Only for 'edge' / 'hybrid': Edge UUID of the linked intercom and its relay index
ALTER TABLE "lpr_cameras" ADD COLUMN "linkedIntercomEdgeId" TEXT;
ALTER TABLE "lpr_cameras" ADD COLUMN "linkedRelayIndex" INTEGER;
