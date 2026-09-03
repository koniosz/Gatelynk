-- CreateEnum
CREATE TYPE "CourierType" AS ENUM ('DHL', 'INPOST', 'ALLEGRO', 'OTHER');

-- CreateEnum
CREATE TYPE "ParcelStatus" AS ENUM ('RECEIVED', 'ISSUED');

-- CreateTable
CREATE TABLE "parcels" (
    "id" SERIAL NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "courier" "CourierType" NOT NULL,
    "status" "ParcelStatus" NOT NULL DEFAULT 'RECEIVED',
    "unitId" INTEGER NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "conciergeId" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedAt" TIMESTAMP(3),
    "issuedPhotoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parcels_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_conciergeId_fkey" FOREIGN KEY ("conciergeId") REFERENCES "concierges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
