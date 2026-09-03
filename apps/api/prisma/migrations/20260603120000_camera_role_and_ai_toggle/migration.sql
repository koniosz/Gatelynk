-- FAZA 8.h (2026-06-03) — rozdzielenie typu kamery (STANDARD vs LPR) +
-- per-camera flaga `aiAnalysisEnabled`.
--
-- Dotąd każda kamera w `lpr_cameras` była traktowana jak LPR (rozpoznawanie
-- tablic + opcjonalne wyzwalanie domofonu/przekaźnika). Klient dodaje teraz
-- kamery wizyjne (CCTV / vision AI) które nie powinny być bindowane do AP.
--
-- `role` = STANDARD | LPR (enum-like via TEXT; CHECK constraint defense-in-depth).
-- `aiAnalysisEnabled` = czy VisionDetectService ma robić snapshot+detect na tej
-- kamerze co 60s. Default true (backwards-compat dla istniejących integracji).
--
-- Backfill: wszystkie istniejące kamery są LPR (założenie historyczne — przed
-- 8.h `lpr_cameras` zawierał wyłącznie LPR-y).

ALTER TABLE "lpr_cameras"
  ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'LPR';

ALTER TABLE "lpr_cameras"
  ADD COLUMN IF NOT EXISTS "aiAnalysisEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Backfill defensywny: w razie gdyby DEFAULT nie złapał (np. szybka kolejność
-- ADD COLUMN + UPDATE na replice), upewniamy się że nie ma pustych wartości.
UPDATE "lpr_cameras" SET "role" = 'LPR' WHERE "role" IS NULL OR "role" = '';

-- CHECK constraint — Postgres nie ma natywnych enum-ów dla nowych kolumn bez
-- dedykowanego ENUM type (wybraliśmy TEXT żeby uniknąć migracji enum-ów).
-- IF NOT EXISTS w ALTER TABLE ADD CONSTRAINT nie istnieje w PG — owrap w DO.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lpr_cameras_role_check'
  ) THEN
    ALTER TABLE "lpr_cameras"
      ADD CONSTRAINT "lpr_cameras_role_check"
      CHECK ("role" IN ('STANDARD', 'LPR'));
  END IF;
END $$;
