-- Systemowy typ lokalu „Dom" — dla obiektów typu HOUSING_ESTATE.
--
-- Zgłoszenie 2026-08-09: przy dodawaniu lokalu na osiedlu domów jedynym
-- sensownym wyborem było „Mieszkanie". To nieprawda merytoryczna, która
-- przenosi się dalej — do aplikacji mieszkańca, do etykiet lokalu w historii
-- wjazdów i do odpowiedzi asystenta.
--
-- Typy lokali żyją w BAZIE, nie w kodzie (`unit_types`, `buildingId = NULL`
-- oznacza typ systemowy dostępny dla każdego obiektu). Seed je tworzy, ale na
-- produkcji przy wdrożeniu uruchamiane są WYŁĄCZNIE migracje — sam wpis
-- w `seed.ts` nie dotarłby więc na żaden działający obiekt.
--
-- Idempotentne: `WHERE NOT EXISTS` pozwala bezpiecznie puścić to ponownie
-- i nie koliduje z seedem, który dla istniejącego kodu robi UPDATE.
INSERT INTO "unit_types" ("buildingId", "code", "name", "icon", "isSystem", "isCommonArea")
SELECT NULL, 'house', 'Dom', 'house', true, false
WHERE NOT EXISTS (
  SELECT 1 FROM "unit_types" WHERE "isSystem" = true AND "code" = 'house'
);
