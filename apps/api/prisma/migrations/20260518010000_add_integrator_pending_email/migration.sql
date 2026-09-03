-- Sesja 6 — email change flow z weryfikacją.
-- User wpisuje nowy email → backend zapisuje go w pendingEmail z tokenem.
-- Email z linkiem `/integrator/verify-email?token=X` (TTL 24h) idzie na NOWY adres.
-- Klik w link → swap email + clear pending fields.

ALTER TABLE "integrators"
  ADD COLUMN IF NOT EXISTS "pendingEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingEmailToken" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingEmailExpiresAt" TIMESTAMP(3);

-- Unique constraint na token (one active change request per user).
-- Partial index — pozwala wielu integratorom mieć NULL token (default).
CREATE UNIQUE INDEX IF NOT EXISTS "integrators_pendingEmailToken_key"
  ON "integrators"("pendingEmailToken")
  WHERE "pendingEmailToken" IS NOT NULL;
