-- Opcjonalne zdjęcie pojazdu (2026-07-16) — base64 data URI (jak
-- tickets.photo / residents.avatar), dodawane przez mieszkańca w iOS.
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "photo" TEXT;
