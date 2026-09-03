-- CreateTable
CREATE TABLE "building_admins" (
    "id" SERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "building_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "building_admin_assignments" (
    "buildingAdminId" INTEGER NOT NULL,
    "buildingId" INTEGER NOT NULL,

    CONSTRAINT "building_admin_assignments_pkey" PRIMARY KEY ("buildingAdminId","buildingId")
);

-- CreateTable
CREATE TABLE "concierges" (
    "id" SERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concierges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "building_admins_email_key" ON "building_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "concierges_email_key" ON "concierges"("email");

-- AddForeignKey
ALTER TABLE "building_admins" ADD CONSTRAINT "building_admins_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building_admin_assignments" ADD CONSTRAINT "building_admin_assignments_buildingAdminId_fkey" FOREIGN KEY ("buildingAdminId") REFERENCES "building_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building_admin_assignments" ADD CONSTRAINT "building_admin_assignments_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierges" ADD CONSTRAINT "concierges_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concierges" ADD CONSTRAINT "concierges_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
