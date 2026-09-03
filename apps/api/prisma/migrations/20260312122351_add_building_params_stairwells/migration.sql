-- AlterTable
ALTER TABLE "buildings" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "entranceCount" INTEGER,
ADD COLUMN     "hasBanquetHall" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasCctv" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasElevator" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasGym" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasIntercom" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasLobby" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasLprSystem" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasPlayroom" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasPool" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasSauna" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "intercomManufacturer" TEXT,
ADD COLUMN     "intercomModel" TEXT,
ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lprManufacturer" TEXT,
ADD COLUMN     "lprModel" TEXT,
ADD COLUMN     "numberOfFloors" INTEGER,
ADD COLUMN     "packageHandling" TEXT;

-- CreateTable
CREATE TABLE "stairwells" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stairwells_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "stairwells" ADD CONSTRAINT "stairwells_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
