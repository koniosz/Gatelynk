-- Domofon: dwukierunkowe audio + jednokierunkowe wideo Akuvox ↔ iOS
-- (SIP↔WebRTC bridge na Edge). Pełen projekt: docs/intercom-akuvox-call.md.
--
-- Cała funkcja jest za flagą env INTERCOM_CALL_ENABLED (default false). Ta
-- migracja dodaje tylko SCHEMAT (tabela sesji + pola mostu) — nie zmienia
-- żadnego istniejącego zachowania ani danych. Bezpieczna na produkcji.

-- ── Sesje połączeń domofonowych ──────────────────────────────────────────────
-- id (uuid) = sessionId używany w tunelu (INTERCOM_CALL_*), VoIP push i WebRTC.
CREATE TABLE IF NOT EXISTS "intercom_call_sessions" (
  "id"               TEXT PRIMARY KEY,                -- uuid (Prisma @default(uuid))
  "buildingId"       INTEGER NOT NULL REFERENCES "buildings"("id") ON DELETE CASCADE,
  "intercomDeviceId" TEXT,                            -- Edge device UUID domofonu
  "intercomName"     TEXT,                            -- snapshot nazwy panelu
  "unitId"           INTEGER,                         -- do którego lokalu dzwoniono
  "unitLabel"        TEXT,                            -- snapshot "Klatka A/15A"
  "answeredById"     INTEGER,                         -- resident który odebrał; NULL = MISSED
  "state"            TEXT NOT NULL DEFAULT 'INCOMING',-- INCOMING|RINGING|ACTIVE|ENDED|MISSED
  "startedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ringingAt"        TIMESTAMP(3),
  "answeredAt"       TIMESTAMP(3),
  "endedAt"          TIMESTAMP(3),
  "endReason"        TEXT,                            -- ANSWERED_HANGUP|CALLER_HANGUP|TIMEOUT|DECLINED|ERROR|NO_DEVICE
  "meta"             JSONB,                           -- snapshotUrl, kodeki, turnUsed...
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Najczęstsze zapytania: "ostatnie połączenia budynku" + filtr po stanie
-- (aktywne/dzwoniące) gdy push zgubiony.
CREATE INDEX IF NOT EXISTS "intercom_call_sessions_building_started_idx"
  ON "intercom_call_sessions" ("buildingId", "startedAt" DESC);
CREATE INDEX IF NOT EXISTS "intercom_call_sessions_state_idx"
  ON "intercom_call_sessions" ("state");

-- ── Pola konfiguracyjne mostu na BuildingIntercom ────────────────────────────
-- sipServer/sipAccount/sipPassword już istnieją (nieużywane do dziś). Tu
-- dochodzi reszta: domena SIP + ICE/TURN dla strony WebRTC + master-toggle.
ALTER TABLE "building_intercoms"
  ADD COLUMN IF NOT EXISTS "sipDomain"     TEXT,
  ADD COLUMN IF NOT EXISTS "turnUrl"       TEXT,
  ADD COLUMN IF NOT EXISTS "turnUsername"  TEXT,
  ADD COLUMN IF NOT EXISTS "turnPassword"  TEXT,
  ADD COLUMN IF NOT EXISTS "bridgeEnabled" BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Kanał push (apns vs voip) ────────────────────────────────────────────────
-- VoIP push (PushKit) budzi apkę na połączenie domofonowe; ma osobny token i
-- topic <bundleId>.voip. Default 'apns' = istniejące tokeny bez zmian.
ALTER TABLE "push_tokens"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'apns';
