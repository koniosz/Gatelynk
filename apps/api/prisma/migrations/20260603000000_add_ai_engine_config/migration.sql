-- FAZA 8.g (2026-06-03) — AI Engine jako first-class device per budynek.
--
-- AI Engine to zewnętrzny YOLO/Vision service (typowo na MacBooku M1) z którym
-- Edge gada przez HTTP POST /detect. Dotąd URL siedział w `process.env.YOLO_URL`,
-- co znaczyło że integrator musiał ręcznie edytować pliki konfiguracyjne na
-- Mac Mini Edge. Teraz konfiguracja jest pełnowartościowa "device-like" —
-- jeden wpis per budynek (single AI engine per building w MVP), edytowalny
-- z panelu Integratora w Cloud, syncowany do Edge przez tunel + outbox.
--
-- 1 budynek = 1 AI Engine (UNIQUE buildingId). MVP założenie — w przyszłości
-- można rozszerzyć do N (np. dwa serwery dla redundancji / load split).
--
-- Schema:
--   `url`           — np. http://192.168.1.109:8080 (bez trailing slash)
--   `healthPath`    — typowo /health
--   `model`         — yolov8n / yolov8s / yolov8m / yolov11n / inne
--   `enabled`       — czy Edge ma używać tego silnika
--   `lastTestAt`    — kiedy BA/Integrator klikał "Testuj"
--   `lastTestOk`    — wynik (TRUE = health OK, FALSE = failed/timeout)
--   `lastTestMs`    — latency w ms (null gdy failed)
--   `lastTestErr`   — error message gdy failed
--   `lastTestCode`  — HTTP status code gdy znany

CREATE TABLE IF NOT EXISTS "ai_engines" (
  "id"             SERIAL PRIMARY KEY,
  "buildingId"     INTEGER NOT NULL UNIQUE
                   REFERENCES "buildings"("id") ON DELETE CASCADE,
  "url"            TEXT NOT NULL,
  "healthPath"     TEXT NOT NULL DEFAULT '/health',
  "model"          TEXT NOT NULL DEFAULT 'yolov8n',
  "enabled"        BOOLEAN NOT NULL DEFAULT TRUE,
  "lastTestAt"     TIMESTAMP(3),
  "lastTestOk"     BOOLEAN,
  "lastTestMs"     INTEGER,
  "lastTestErr"    TEXT,
  "lastTestCode"   INTEGER,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ai_engines_buildingId_idx"
  ON "ai_engines"("buildingId");
