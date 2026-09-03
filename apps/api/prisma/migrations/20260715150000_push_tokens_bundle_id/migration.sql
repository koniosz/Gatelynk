-- Push per-bundle topic (2026-07-15). GateLynk ma 3 apki iOS o różnych
-- bundle ID (com.gatelynk.app / .glass / .gamma), a APNs wymaga topicu
-- zgodnego z bundlem tokenu. Dotąd PushService używał JEDNEGO globalnego
-- APN_BUNDLE_ID — pushe do tokenów z innych apek (np. Glass) były
-- odrzucane przez APNs i kasowane jako "invalid". NULL = legacy token
-- sprzed migracji → fallback do env APN_BUNDLE_ID.
ALTER TABLE "push_tokens" ADD COLUMN IF NOT EXISTS "bundleId" TEXT;
