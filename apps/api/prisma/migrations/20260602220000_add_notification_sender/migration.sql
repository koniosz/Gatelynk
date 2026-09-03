-- FAZA polish (f) — Notifications history.
--
-- Notifications dotąd nie wiedziały kto je wysłał (BA / system / cron). Dodajemy
-- opcjonalny `senderBaId` żeby BA UI mógł wyświetlić „kto wysłał" w historii
-- broadcastów. Nullable, bo:
--   - istniejące wpisy mają NULL (backfill nie ma jak ustalić),
--   - jeśli notification poszło z innego źródła (np. push z guests-validation),
--     też zostaje NULL.
--
-- Index po (buildingId, sentAt DESC) bo historia jest „ostatnie N w budynku".

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "senderBaId" INTEGER REFERENCES "building_admins"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "notifications_buildingId_sentAt_idx"
  ON "notifications" ("buildingId", "sentAt" DESC);
