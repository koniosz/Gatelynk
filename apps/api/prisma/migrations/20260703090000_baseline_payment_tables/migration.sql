-- 2026-07-03 — BASELINE: payment_configs / payment_entries / enum PaymentType.
--
-- Te struktury istnieją na produkcji i w lokalnych bazach dev od dawna, ale
-- zostały utworzone RĘCZNYM SQL-em (okres driftu Prisma 5.22/7.5) i nigdy nie
-- trafiły do historii migracji. Ta migracja jest w pełni IDEMPOTENTNA:
--   • na bazach które już mają te tabele — no-op,
--   • na świeżych bazach (shadow DB, CI, staging) — tworzy je 1:1 z tym co
--     jest na produkcji (timestamptz — celowo, żeby nie zmieniać typów na prod).

-- Enum PaymentType (CHARGE / PAYMENT / CORRECTION)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentType') THEN
    CREATE TYPE "PaymentType" AS ENUM ('CHARGE', 'PAYMENT', 'CORRECTION');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "payment_configs" (
    id SERIAL PRIMARY KEY,
    "unitId" INTEGER NOT NULL,
    "monthlyRent" NUMERIC(10,2) NOT NULL,
    "dueDay" INTEGER NOT NULL DEFAULT 10,
    "openingBalance" NUMERIC(10,2) NOT NULL DEFAULT 0,
    "openingDate" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "payment_entries" (
    id SERIAL PRIMARY KEY,
    "unitId" INTEGER NOT NULL,
    amount NUMERIC(10,2) NOT NULL,
    type "PaymentType" NOT NULL,
    date TIMESTAMPTZ NOT NULL,
    description TEXT,
    reference TEXT,
    source TEXT DEFAULT 'admin',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique + indexes (idempotentne)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_configs_unitId_key') THEN
    ALTER TABLE "payment_configs" ADD CONSTRAINT "payment_configs_unitId_key" UNIQUE ("unitId");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_entries_date ON "payment_entries" (date);
CREATE INDEX IF NOT EXISTS idx_payment_entries_unit ON "payment_entries" ("unitId");

-- Foreign keys (idempotentne)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_configs_unitId_fkey') THEN
    ALTER TABLE "payment_configs"
      ADD CONSTRAINT "payment_configs_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_entries_unitId_fkey') THEN
    ALTER TABLE "payment_entries"
      ADD CONSTRAINT "payment_entries_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"(id);
  END IF;
END $$;
