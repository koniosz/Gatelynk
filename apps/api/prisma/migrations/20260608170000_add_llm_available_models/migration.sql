-- FAZA 8.h.8 (2026-06-08) — cache listy zainstalowanych modeli Ollama.
-- Po teście LLM Edge zwraca `availableModels: string[]` (z GET /api/tags),
-- EdgeGateway zapisuje do tej kolumny. Frontend pokazuje listę żeby
-- integrator wybrał z faktycznie pulled modeli.
--
-- Cache invaliduje się przy każdym kolejnym teście. JSON array stringów.
ALTER TABLE "ai_engines"
  ADD COLUMN IF NOT EXISTS "llmAvailableModels" JSONB;
