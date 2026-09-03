-- Powiadomienia o przejazdach WŁASNEGO pojazdu (2026-08-21): opt-in per
-- pojazd, push z kadrem z kamery LPR (jak notifyOnUse u gości).
ALTER TABLE "vehicles" ADD COLUMN "notifyOnUse" BOOLEAN NOT NULL DEFAULT false;
