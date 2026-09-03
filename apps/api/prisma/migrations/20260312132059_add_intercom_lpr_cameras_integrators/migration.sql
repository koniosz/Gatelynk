-- CreateTable
CREATE TABLE "integrators" (
    "id" SERIAL NOT NULL,
    "adminId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stairwell_intercoms" (
    "id" SERIAL NOT NULL,
    "stairwellId" INTEGER NOT NULL,
    "manufacturer" TEXT NOT NULL DEFAULT 'Akuvox',
    "model" TEXT,
    "ipAddress" TEXT,
    "login" TEXT,
    "password" TEXT,
    "relays" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stairwell_intercoms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lpr_cameras" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT,
    "ipAddress" TEXT,
    "login" TEXT,
    "password" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lpr_cameras_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integrators_email_key" ON "integrators"("email");

-- CreateIndex
CREATE UNIQUE INDEX "stairwell_intercoms_stairwellId_key" ON "stairwell_intercoms"("stairwellId");

-- AddForeignKey
ALTER TABLE "integrators" ADD CONSTRAINT "integrators_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stairwell_intercoms" ADD CONSTRAINT "stairwell_intercoms_stairwellId_fkey" FOREIGN KEY ("stairwellId") REFERENCES "stairwells"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lpr_cameras" ADD CONSTRAINT "lpr_cameras_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
