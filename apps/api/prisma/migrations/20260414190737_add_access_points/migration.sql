-- CreateTable
CREATE TABLE "access_points" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'door',
    "edgeDeviceId" TEXT,
    "deviceId" TEXT NOT NULL,
    "relayIndex" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_points_buildingId_deviceId_relayIndex_key" ON "access_points"("buildingId", "deviceId", "relayIndex");

-- AddForeignKey
ALTER TABLE "access_points" ADD CONSTRAINT "access_points_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
