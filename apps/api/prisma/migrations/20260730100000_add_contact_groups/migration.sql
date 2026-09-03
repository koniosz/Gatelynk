-- Grupy kontaktowe lokali (BA panel) — grupowanie kontaktów na ekranie
-- domofonu Akuvox. Lokal należy do maks. jednej grupy; usunięcie grupy
-- przywraca lokale do „bez grupy" (ON DELETE SET NULL).
--
-- UWAGA: migracja pisana ręcznie (scoped) — lokalna baza ma kosmetyczny drift
-- z ery raw-SQL i `prisma migrate dev` wygenerowałby destrukcyjny diff.

-- CreateTable
CREATE TABLE "contact_groups" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contact_groups_buildingId_name_key" ON "contact_groups"("buildingId", "name");

-- AddForeignKey
ALTER TABLE "contact_groups" ADD CONSTRAINT "contact_groups_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "units" ADD COLUMN "contactGroupId" INTEGER;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_contactGroupId_fkey" FOREIGN KEY ("contactGroupId") REFERENCES "contact_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
