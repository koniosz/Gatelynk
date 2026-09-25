-- Przełącznik mieszkańca (2026-09-25): czy rozpoznanie tablicy przez kamerę
-- LPR ma otwierać bramę/szlaban. Domyślnie TRUE — zachowanie dotychczasowe
-- (zatwierdzony pojazd = automatyczny wjazd). FALSE zostawia tablicę na
-- białej liście Edge (odczyt, historia, powiadomienia), ale Edge nie
-- wyzwala przekaźnika. Egzekwowane offline na Edge (lpr_plates.auto_open).
ALTER TABLE "vehicles" ADD COLUMN "autoOpen" BOOLEAN NOT NULL DEFAULT true;
