-- Add snapshot + vehicle-attribute columns to lpr_reads.
--
-- Context: Hikvision DeepinView ANPR events carry vehicle colour, brand
-- (logo library), type (car/SUV/truck…) and a JPEG snapshot alongside the
-- plate. Edge already persists these locally; the Cloud copy mirrors them
-- so admin panels + the resident "My passes" view can surface them.
--
-- image_path is just a filename relative to the Edge's lpr-snapshots dir
-- (e.g. "1737750000000_WA12345.jpg"). The Cloud doesn't store the JPEG —
-- it exposes a read endpoint that proxies bytes through to the Edge.

ALTER TABLE "lpr_reads"
  ADD COLUMN IF NOT EXISTS "imagePath"      TEXT,
  ADD COLUMN IF NOT EXISTS "vehicleColor"   TEXT,
  ADD COLUMN IF NOT EXISTS "vehicleBrand"   TEXT,
  ADD COLUMN IF NOT EXISTS "vehicleType"    TEXT,
  ADD COLUMN IF NOT EXISTS "vehicleSubtype" TEXT,
  ADD COLUMN IF NOT EXISTS "hasImage"       BOOLEAN NOT NULL DEFAULT FALSE;
