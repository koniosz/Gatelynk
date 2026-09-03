-- Zdjęcia w odpowiedziach na zgłoszenia (zgłoszenie 2026-08-13):
-- administrator, konsjerż i mieszkaniec mogą dołączyć zdjęcie na KAŻDYM
-- etapie rozmowy (dotąd zdjęcie miało tylko pierwotne zgłoszenie).
-- Format identyczny jak tickets.photo: data:image/...;base64 (konwencja
-- całej bazy — patrz CLAUDE.md „Zdjęcia base64"). Idempotentnie.
ALTER TABLE "ticket_replies" ADD COLUMN IF NOT EXISTS "photo" TEXT;
