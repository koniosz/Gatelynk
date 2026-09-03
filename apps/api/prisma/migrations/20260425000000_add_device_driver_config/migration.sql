-- Dodaje uniwersalny słownik konfiguracji urządzeń: każdy intercom (a w
-- przyszłości kamera/LPR) wskazuje `driverId` z katalogu @gatelynk/device-drivers
-- i trzyma pełen konfig w `config` JSONB. Stare kolumny (ipAddress/login/...)
-- pozostają dla wstecznej kompatybilności — nowy kod czyta z `config`, ale
-- migrator może zachować starą zawartość.

ALTER TABLE "stairwell_intercoms" ADD COLUMN IF NOT EXISTS "driverId" TEXT;
ALTER TABLE "stairwell_intercoms" ADD COLUMN IF NOT EXISTS "config"   JSONB;
