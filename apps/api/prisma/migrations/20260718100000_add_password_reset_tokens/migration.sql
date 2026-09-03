-- Reset hasła przez link e-mail (Panel Administratora, 2026-07-18).
-- Tabela generyczna per rola — w przyszłości CONCIERGE / INTEGRATOR używają
-- tej samej struktury. Przechowujemy TYLKO sha256(token) — plaintext idzie
-- wyłącznie w linku mailowym.
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
    "id"        SERIAL PRIMARY KEY,
    "role"      TEXT NOT NULL,
    "userId"    INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_tokenHash_key"
    ON "password_reset_tokens"("tokenHash");
CREATE INDEX IF NOT EXISTS "password_reset_tokens_role_userId_idx"
    ON "password_reset_tokens"("role", "userId");
