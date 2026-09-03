-- 2026-06-02 — RESIDENT_PIN: stały PIN mieszkańca do klawiatury Akuvox.
-- Analogiczny do Guest.pin ale nie wygasa — mieszkaniec ustawia raz w iOS Profile,
-- może zmieniać. Edge cache (resident_pins) sync przez tunnel.

ALTER TABLE "residents"
  ADD COLUMN IF NOT EXISTS "intercomPin" VARCHAR(6);

-- Unique partial index — pozwala wielu mieszkańcom mieć NULL (=brak PIN), ale
-- 2 mieszkańców w tym samym budynku NIE może mieć tego samego PIN.
-- Walidacja vs Guest.pin (active) jest aplikacyjna — guest PIN-y są w innej
-- tabeli, partial index ich nie obejmuje.
CREATE UNIQUE INDEX IF NOT EXISTS "residents_buildingId_intercomPin_key"
  ON "residents" ("buildingId", "intercomPin")
  WHERE "intercomPin" IS NOT NULL;
