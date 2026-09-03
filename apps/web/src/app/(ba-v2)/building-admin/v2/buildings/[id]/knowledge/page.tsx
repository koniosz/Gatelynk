"use client";
/**
 * Baza wiedzy AI — zakładka ba-v2 (2026-07-03).
 *
 * Zgłoszenie: „baza wiedzy AI zniknęła z panelu administratora" — istniała
 * TYLKO w legacy panelu (/building-admin/buildings/:id/knowledge), a ba-v2
 * nigdy nie miał do niej wejścia. Ten wrapper renderuje sprawdzony legacy
 * widok (upload/lista/usuwanie dokumentów czytanych przez GateLynk AI)
 * wewnątrz shellu v2 — bez przepisywania logiki (ten sam komponent, ten sam
 * buildingAdminApi, ten sam param [id] z URL-a).
 *
 * Legacy widok jest jasny (bg-white karty) — jasna „wyspa" na ciemnym tle
 * v2 jest świadomym kompromisem; pełny restyling na ba-tokens = osobny task.
 */
import BuildingKnowledgePage from "@/app/(building-admin-dashboard)/building-admin/buildings/[id]/knowledge/page";

export default function BaV2KnowledgePage() {
  return (
    <div
      style={{
        background: "#f7f8fb",
        borderRadius: 14,
        padding: "18px 20px",
        border: "1px solid var(--border)",
      }}
    >
      <BuildingKnowledgePage />
    </div>
  );
}
