-- FAZA 8.h.25 (2026-06-12) — log pytań/odpowiedzi GateLynk AI + ocena.
--
-- Tymczasowy panel w Integratorze: każde pytanie do asystenta (resident
-- przez iOS, BA przez panel) zapisujemy z odpowiedzią. Integrator ocenia
-- checkboxem OK / NIE OK — ocenione pary Q/A staną się datasetem do
-- dostrojenia LLM (eval catalog 8.h.21 + przyszły fine-tuning Bielika).
--
-- Append-only, fire-and-forget z controllerów (błąd zapisu nie blokuje
-- odpowiedzi userowi). Retention: do ręcznego czyszczenia (panel tymczasowy).

CREATE TABLE IF NOT EXISTS "assistant_query_logs" (
  "id"          SERIAL PRIMARY KEY,
  "buildingId"  INTEGER NOT NULL REFERENCES "buildings"("id") ON DELETE CASCADE,
  "role"        TEXT NOT NULL,            -- 'RESIDENT' | 'BUILDING_ADMIN'
  "userId"      INTEGER,                  -- residentId / buildingAdminId
  "question"    TEXT NOT NULL,
  "answer"      TEXT NOT NULL,
  "intent"      TEXT,
  "totalMs"     INTEGER,
  "model"       TEXT,                     -- np. bielik / qwen2.5 / local-cloud
  "smart"       BOOLEAN NOT NULL DEFAULT TRUE,
  -- Ocena integratora: NULL = nieocenione, TRUE = OK, FALSE = NIE OK
  "ratingOk"    BOOLEAN,
  "ratedAt"     TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "assistant_query_logs_building_created_idx"
  ON "assistant_query_logs" ("buildingId", "createdAt" DESC);
-- Filtr "nieocenione" — najczęstszy widok panelu.
CREATE INDEX IF NOT EXISTS "assistant_query_logs_unrated_idx"
  ON "assistant_query_logs" ("buildingId", "createdAt" DESC)
  WHERE "ratingOk" IS NULL;
