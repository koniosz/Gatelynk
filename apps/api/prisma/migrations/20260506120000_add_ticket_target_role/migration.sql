-- Faza 4 — Concierge ticket replies
--
-- `Ticket.type` (target audience): mieszkaniec wybiera komu adresuje zgłoszenie.
--   ADMIN     → trafia do administratora osiedla (BuildingAdmin) — domyślny.
--   CONCIERGE → trafia do konsjerża budynku — np. „nie odebrałem paczki".
-- `TicketReply.authorId` — id konkretnego admina/concierge'a, który odpowiedział.
--   Dla resident-replies zostaje NULL (i tak wiemy z `ticket.residentId`).
--   iOS używa go żeby pokazać avatar/imię konsjerża obok odpowiedzi.
--
-- Backwards-compat: istniejące tickety dostają type='ADMIN' (default), więc
-- dotychczasowy flow admin-replies dalej działa bez żadnych zmian po stronie iOS.

ALTER TABLE "tickets"
  ADD COLUMN "type" TEXT NOT NULL DEFAULT 'ADMIN';

ALTER TABLE "ticket_replies"
  ADD COLUMN "authorId" INTEGER;

-- Index dla concierge listing — szybki filtr po (buildingId, type='CONCIERGE').
CREATE INDEX "tickets_buildingId_type_idx"
  ON "tickets" ("buildingId", "type");
