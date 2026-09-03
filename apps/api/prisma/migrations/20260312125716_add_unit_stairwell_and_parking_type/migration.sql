-- AlterTable
ALTER TABLE "buildings" ADD COLUMN     "objectType" TEXT NOT NULL DEFAULT 'BUILDING';

-- AlterTable
ALTER TABLE "units" ADD COLUMN     "stairwellId" INTEGER;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_stairwellId_fkey" FOREIGN KEY ("stairwellId") REFERENCES "stairwells"("id") ON DELETE SET NULL ON UPDATE CASCADE;
