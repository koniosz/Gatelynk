-- CreateTable
CREATE TABLE "edge_devices" (
    "id" TEXT NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'EDGE',
    "name" TEXT,
    "activationCode" TEXT,
    "activationCodeExpiresAt" TIMESTAMP(3),
    "isActivated" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "version" TEXT,
    "machineInfo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "edge_devices_activationCode_key" ON "edge_devices"("activationCode");

-- AddForeignKey
ALTER TABLE "edge_devices" ADD CONSTRAINT "edge_devices_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
