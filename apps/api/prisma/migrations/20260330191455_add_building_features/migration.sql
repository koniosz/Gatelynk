-- AlterTable
ALTER TABLE "buildings" ADD COLUMN     "hasEdgeAI" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasLightingControl" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasPhotovoltaics" BOOLEAN NOT NULL DEFAULT false;
