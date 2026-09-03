-- Guest Portal (Faza 2D / pivot bezkontaktowy).
--
-- UX problem z Akuvoxem: domofon lokalnie odgrywa „błędny kod" zanim Edge
-- zdąży zweryfikować PIN i otworzyć przekaźnik. Skompromitowany Akuvox
-- firmware blokuje synchronizację publicznych kodów (POST /web/* zwraca
-- 403). Pivot: gość dostaje URL do mikroportalu (gatelynk.com/g/<token>)
-- z przyciskami „otwórz wjazd / wyjazd" — bezkontaktowo, bez klawiatury.
--
-- Pola:
--   urlToken    — 64-hex (32 random bytes) — używany w URL portalu;
--                 unikalny globalnie; null dla gości legacy (tylko PIN).
--   email       — adres mailowy gościa (Resend wysyła tu link); opcjonalny,
--                 SMS leci lokalnie z telefonu mieszkańca przez iMessage.
--   emailSentAt — kiedy wysłaliśmy email z linkiem; null jeśli nie wysłano.
--
-- Migracja additive — istniejący goście (urlToken=NULL) nadal działają
-- przez PIN na klawiaturze; tylko nowi dostają portal.

ALTER TABLE "guests" ADD COLUMN "urlToken"    VARCHAR(64);
ALTER TABLE "guests" ADD COLUMN "email"       VARCHAR(255);
ALTER TABLE "guests" ADD COLUMN "emailSentAt" TIMESTAMP(3);

-- Unikalność tokenu — globalnie, nie per-building (URL bez kontekstu
-- buildingu — token sam w sobie identyfikuje gościa). Partial index żeby
-- legacy NULL-e nie konfliktowały.
CREATE UNIQUE INDEX "guests_urlToken_key"
  ON "guests" ("urlToken")
  WHERE "urlToken" IS NOT NULL;
