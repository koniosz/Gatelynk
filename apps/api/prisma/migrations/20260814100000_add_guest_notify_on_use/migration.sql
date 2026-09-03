-- Przełącznik powiadomień o aktywności gościa (zgłoszenie 2026-08-14):
-- mieszkaniec decyduje per zaproszenie, czy wjazdy/wyjazdy/użycia PIN-u
-- tego gościa mają wysyłać mu push. Domyślnie TAK (dotychczasowe
-- zachowanie); wyłączenie dotyczy WYŁĄCZNIE powiadomień o aktywności —
-- prośby o otwarcie drzwi (GUEST_APPROVAL) zawsze dochodzą, bo wymagają
-- decyzji mieszkańca. Idempotentnie.
ALTER TABLE "guests" ADD COLUMN IF NOT EXISTS "notifyOnUse" BOOLEAN NOT NULL DEFAULT true;
