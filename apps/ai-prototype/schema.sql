-- GateLynk AI prototype — Postgres schema + seed data.
--
-- Tabela `vehicle_events` jest jedynym source-of-truth dla zdarzeń wjazdu/
-- wyjazdu. Każdy wiersz = pojedynczy ANPR read (LPR camera trigger).
--
-- Indexy:
--   • event_ts DESC — wszystkie list/count queries idą "newest first"
--   • UPPER(plate) — case-insensitive lookup plate
--   • GIN(tags)   — szybki "X = ANY(tags)" filter
--   • LOWER(color) — case-insensitive filter koloru

CREATE TABLE IF NOT EXISTS vehicle_events (
  id         SERIAL       PRIMARY KEY,
  plate      TEXT         NOT NULL,
  color      TEXT,
  tags       TEXT[]       NOT NULL DEFAULT '{}',
  direction  TEXT         CHECK (direction IN ('in', 'out')),
  event_ts   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vehicle_events_ts_idx
  ON vehicle_events (event_ts DESC);

CREATE INDEX IF NOT EXISTS vehicle_events_plate_idx
  ON vehicle_events (UPPER(plate));

CREATE INDEX IF NOT EXISTS vehicle_events_tags_gin
  ON vehicle_events USING GIN (tags);

CREATE INDEX IF NOT EXISTS vehicle_events_color_idx
  ON vehicle_events (LOWER(color));


-- ─── Seed dla smoke-testu (idempotentne — TRUNCATE przed wstawką) ─────────
TRUNCATE vehicle_events RESTART IDENTITY;

INSERT INTO vehicle_events (plate, color, tags, direction, event_ts) VALUES
  -- Kurierzy dziś
  ('WE12345', 'white', ARRAY['kurier','dostawa'], 'in',  NOW() - INTERVAL '2 hours'),
  ('WE12345', 'white', ARRAY['kurier','dostawa'], 'out', NOW() - INTERVAL '90 minutes'),
  ('PO99888', 'white', ARRAY['kurier','dostawa'], 'in',  NOW() - INTERVAL '6 hours'),
  ('PO99888', 'white', ARRAY['kurier','dostawa'], 'out', NOW() - INTERVAL '5 hours 30 minutes'),

  -- Mieszkańcy
  ('WX67890', 'black',  ARRAY['mieszkaniec'], 'in',  NOW() - INTERVAL '5 hours'),
  ('WA22244', 'silver', ARRAY['mieszkaniec'], 'out', NOW() - INTERVAL '15 minutes'),
  ('WA22244', 'silver', ARRAY['mieszkaniec'], 'in',  NOW() - INTERVAL '4 hours'),

  -- Goście / inne dziś
  ('KR00111', 'red',  ARRAY['gosc'], 'in',  NOW() - INTERVAL '30 minutes'),
  ('LX55554', 'gray', ARRAY[]::TEXT[], 'in',  NOW() - INTERVAL '20 minutes'),

  -- Historyczne (wczoraj — NIE powinno trafiać w "dziś" queries)
  ('WE12345', 'white', ARRAY['kurier','dostawa'], 'in',  NOW() - INTERVAL '26 hours'),
  ('WX67890', 'black', ARRAY['mieszkaniec'], 'in',  NOW() - INTERVAL '28 hours');

-- Quick verify (rozkład tagów dziś)
-- SELECT unnest(tags) AS tag, COUNT(*)
--   FROM vehicle_events
--  WHERE event_ts >= date_trunc('day', NOW())
--  GROUP BY 1 ORDER BY 2 DESC;
