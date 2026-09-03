-- Akuvox Directory Sync v2 (2026-07-30) — docs/akuvox-directory-v2-analysis.md
-- Rejestr urządzeń Akuvox (cele synchronizacji katalogu) + template'y formatu
-- importu + historia synchronizacji. Migracja CZYSTO ADDYTYWNA (3 nowe tabele,
-- zero zmian w istniejących).
--
-- UWAGA: migracja pisana ręcznie (scoped) — lokalna baza ma zastany drift
-- z ery raw-SQL i `prisma migrate dev` wygenerowałby destrukcyjny diff
-- (m.in. DROP COLUMN lpr_reads."vehicleBrand"). Wzorzec: 20260730100000.

-- CreateTable
CREATE TABLE "akuvox_devices" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "intercomId" INTEGER,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "firmwareVersion" TEXT,
    "hardwareVersion" TEXT,
    "syncMode" TEXT NOT NULL DEFAULT 'MANUAL_EXPORT',
    "contactAuthority" TEXT NOT NULL DEFAULT 'GATELYNK',
    "adapter" TEXT NOT NULL DEFAULT 'directory-user',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "capabilitiesOverride" JSONB,
    "credentialUser" TEXT,
    "credentialEnc" TEXT,
    "lastDeviceSnapshot" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncChecksum" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "akuvox_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "akuvox_import_templates" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "firmwareVersion" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "rawFile" BYTEA NOT NULL,
    "parsedSpec" JSONB NOT NULL,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "akuvox_import_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "akuvox_sync_runs" (
    "id" SERIAL NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "operator" TEXT,
    "summary" JSONB,
    "warnings" JSONB,
    "errors" JSONB,
    "directoryChecksum" TEXT,
    "fileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "akuvox_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "akuvox_devices_buildingId_idx" ON "akuvox_devices"("buildingId");

-- CreateIndex
CREATE UNIQUE INDEX "akuvox_import_templates_model_firmwareVersion_format_key" ON "akuvox_import_templates"("model", "firmwareVersion", "format");

-- CreateIndex
CREATE INDEX "akuvox_sync_runs_deviceId_createdAt_idx" ON "akuvox_sync_runs"("deviceId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "akuvox_devices" ADD CONSTRAINT "akuvox_devices_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "akuvox_devices" ADD CONSTRAINT "akuvox_devices_intercomId_fkey" FOREIGN KEY ("intercomId") REFERENCES "building_intercoms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "akuvox_import_templates" ADD CONSTRAINT "akuvox_import_templates_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "akuvox_sync_runs" ADD CONSTRAINT "akuvox_sync_runs_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "akuvox_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
