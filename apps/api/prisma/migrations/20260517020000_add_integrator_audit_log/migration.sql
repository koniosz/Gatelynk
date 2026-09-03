-- Sesja 5 Panel Integratora — audit log każdej operacji write
-- Sprawdzane przez Settings → Historia operacji + compliance/RODO trace.

CREATE TABLE "integrator_audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "integratorId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "buildingId" INTEGER,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrator_audit_logs_pkey" PRIMARY KEY ("id")
);

-- FK z ON DELETE CASCADE — gdy integrator usunięty, jego audit historia też.
ALTER TABLE "integrator_audit_logs"
    ADD CONSTRAINT "integrator_audit_logs_integratorId_fkey"
    FOREIGN KEY ("integratorId") REFERENCES "integrators"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Indeksy DESC bo zawsze pytamy „ostatnie N":
CREATE INDEX "integrator_audit_logs_integratorId_createdAt_idx"
    ON "integrator_audit_logs"("integratorId", "createdAt" DESC);

CREATE INDEX "integrator_audit_logs_buildingId_createdAt_idx"
    ON "integrator_audit_logs"("buildingId", "createdAt" DESC);
