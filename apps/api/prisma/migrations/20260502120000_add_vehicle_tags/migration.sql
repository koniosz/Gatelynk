-- Tagi pojazdu — multi-select chipsów wpisywanych ręcznie przez admina/konsjerża
-- w panelu identyfikacji LPR. Słownik tagów jest po stronie front-endu (lib/
-- vehicle-tags.ts), backend trzyma to jako TEXT[] żeby zapytania `tags && ARRAY[...]`
-- były szybkie. GIN index sprawia, że filtr po jednym tagu na całej tabeli
-- (np. „pokaż wszystkie auta tagowane Glovo w budynku") robi się w O(log n).

ALTER TABLE "vehicles" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';

-- Sam GIN na tablicy tagów; po `buildingId` filtrujemy istniejącymi btree-ami,
-- Postgres potrafi przeciąć indeksy. (`btree_gin` extension nie jest tu
-- potrzebne i niepotrzebnie dorzucałoby zależność.)
CREATE INDEX "vehicles_tags_gin_idx" ON "vehicles" USING gin ("tags");
