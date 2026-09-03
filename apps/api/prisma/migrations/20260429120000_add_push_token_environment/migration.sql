-- Add `environment` to push_tokens so Cloud może routować pusha do właściwego
-- endpointu APNs (production vs sandbox). Mismatch sandbox/prod dawał
-- BadDeviceToken, co PushService traktował jako Unregistered token i kasował
-- — stąd 0 tokenów w produkcji mimo działającej rejestracji z iOS.
ALTER TABLE "push_tokens"
  ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'production';
