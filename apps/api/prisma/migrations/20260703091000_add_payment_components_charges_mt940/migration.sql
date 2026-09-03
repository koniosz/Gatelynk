-- 2026-07-03 — System zarządzania opłatami (składowe czynszu, naliczenia
-- miesięczne, import MT940). Wszystko ADDYTYWNE — backward-compatible.
--
--   • payment_settings   — dueDay per budynek (default termin wymagalności)
--   • payment_components — składowe opłaty (budynkowe unitId=NULL / per lokal)
--   • payment_charges    — naliczenie per lokal per miesiąc (snapshot + suma + termin)
--   • mt940_imports      — audit trail importów wyciągów + dedup po hashu
--   • payment_entries    +chargeId +mt940ImportId (nullable, legacy wpisy bez zmian)

-- AlterTable
ALTER TABLE "payment_entries" ADD COLUMN "chargeId" INTEGER,
ADD COLUMN "mt940ImportId" INTEGER;

-- CreateTable
CREATE TABLE "payment_settings" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "dueDay" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_components" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "unitId" INTEGER,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "calcType" TEXT NOT NULL DEFAULT 'FIXED',
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_charges" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "unitId" INTEGER NOT NULL,
    "period" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mt940_imports" (
    "id" SERIAL NOT NULL,
    "buildingId" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "accountNumber" TEXT,
    "statementNumber" TEXT,
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    "savedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mt940_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_settings_buildingId_key" ON "payment_settings"("buildingId");

-- CreateIndex
CREATE INDEX "payment_components_buildingId_idx" ON "payment_components"("buildingId");

-- CreateIndex
CREATE INDEX "payment_charges_buildingId_period_idx" ON "payment_charges"("buildingId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "payment_charges_unitId_period_key" ON "payment_charges"("unitId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "mt940_imports_buildingId_fileHash_key" ON "mt940_imports"("buildingId", "fileHash");

-- CreateIndex
CREATE INDEX "payment_entries_chargeId_idx" ON "payment_entries"("chargeId");

-- AddForeignKey
ALTER TABLE "payment_entries" ADD CONSTRAINT "payment_entries_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "payment_charges"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_entries" ADD CONSTRAINT "payment_entries_mt940ImportId_fkey" FOREIGN KEY ("mt940ImportId") REFERENCES "mt940_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_settings" ADD CONSTRAINT "payment_settings_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_components" ADD CONSTRAINT "payment_components_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_components" ADD CONSTRAINT "payment_components_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_charges" ADD CONSTRAINT "payment_charges_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_charges" ADD CONSTRAINT "payment_charges_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
