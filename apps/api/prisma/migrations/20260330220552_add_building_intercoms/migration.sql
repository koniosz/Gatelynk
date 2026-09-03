-- CreateTable
CREATE TABLE "building_intercoms" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "ipAddress" TEXT,
    "sipServer" TEXT,
    "sipAccount" TEXT,
    "sipPassword" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "building_intercoms_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "building_intercoms" ADD CONSTRAINT "building_intercoms_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
