-- FAZA 8.h.7 (2026-06-08) — rozszerzenie `ai_engines` o LLM config.
--
-- AI Engine to YOLO/Vision (object detection). LLM to OSOBNY service
-- (Ollama) który generuje PL narratives dla notable frames przez
-- `VisionLlmSummarizerService`. Dotąd LLM był konfigurowany tylko env-var,
-- niewidoczny w UI i nieedytowalny bez SSH na Edge.
--
-- Decyzja: 1 budynek = 1 AI Engine row = 1 YOLO + 1 LLM (oba opcjonalne).
-- Alternatywa "osobna tabela llm_engines" odrzucona — semantycznie zawsze
-- razem (YOLO bez LLM jest user useful, LLM bez YOLO nie ma sensu — nie ma
-- klatek do podsumowania), więc 1 row z 2 sekcjami jest cleaner.

ALTER TABLE "ai_engines"
  ADD COLUMN IF NOT EXISTS "llmUrl"          TEXT,
  ADD COLUMN IF NOT EXISTS "llmModel"        TEXT NOT NULL DEFAULT 'qwen2.5:14b',
  ADD COLUMN IF NOT EXISTS "llmEnabled"      BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "llmLastTestAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "llmLastTestOk"   BOOLEAN,
  ADD COLUMN IF NOT EXISTS "llmLastTestMs"   INTEGER,
  ADD COLUMN IF NOT EXISTS "llmLastTestErr"  TEXT,
  ADD COLUMN IF NOT EXISTS "llmLastTestCode" INTEGER;
