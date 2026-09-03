-- Backfill `driverId` na `stairwell_intercoms` dla legacy rekordów
-- (istniejących przed migracją 20260425000000_add_device_driver_config).
--
-- Strategia: idempotentne UPDATE-y po `manufacturer` (case-insensitive) →
-- mapowanie na driver z katalogu `@gatelynk/device-drivers`. Jeśli producent
-- ma więcej niż jeden driver dla typu INTERCOM (np. Hikvision: intercom vs LPR
-- vs camera), bierzemy ten oznaczony jako INTERCOM. Dla nieznanych producentów
-- `driverId` zostaje NULL — runtime Edge dalej działa via legacy fallback
-- (`legacyOpenDoorUrl` / `legacyRestartUrl`).
--
-- Mapping (musi być spójny z `guessDriverId()` w packages/device-drivers/src/index.ts):
--   Akuvox    → akuvox-smartplus
--   Hikvision → hikvision-intercom
--   2N        → 2n-helios
--   Dnake     → dnake-intercom
--   Comelit   → comelit-intercom
--
-- Również uzupełniamy `config` jeśli jest NULL — kopiujemy „kanoniczne" pola
-- (ipAddress/login/password/model + opcjonalnie relays) do JSONB, żeby Edge
-- mógł je wyrenderować przez templates URL.

UPDATE stairwell_intercoms
SET "driverId" = CASE
  WHEN LOWER(manufacturer) LIKE '%akuvox%'    THEN 'akuvox-smartplus'
  WHEN LOWER(manufacturer) LIKE '%hikvision%' THEN 'hikvision-intercom'
  WHEN LOWER(manufacturer)  =   '2n'
    OR LOWER(manufacturer) LIKE '%2n %'
    OR LOWER(manufacturer) LIKE '2n %'        THEN '2n-helios'
  WHEN LOWER(manufacturer) LIKE '%dnake%'     THEN 'dnake-intercom'
  WHEN LOWER(manufacturer) LIKE '%comelit%'   THEN 'comelit-intercom'
  ELSE NULL
END
WHERE "driverId" IS NULL
  AND manufacturer IS NOT NULL;

-- Mirror legacy kolumn → JSONB `config` (tylko gdy config jest NULL).
-- Format zgodny z tym, co `intercom.service.ts` oczekuje w runtime
-- (ipAddress/login/password + opcjonalnie model/relays).
UPDATE stairwell_intercoms
SET config = jsonb_strip_nulls(jsonb_build_object(
  'ipAddress', "ipAddress",
  'login',     login,
  'password',  password,
  'model',     model,
  'relays',    CASE
    WHEN relays IS NOT NULL AND jsonb_typeof(relays) = 'array' THEN relays
    ELSE NULL
  END
))
WHERE config IS NULL
  AND "ipAddress" IS NOT NULL;
