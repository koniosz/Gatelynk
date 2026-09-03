"use client";
// Wspólny placeholder dla zakładek których nie zdążyliśmy migrować w MVP.
// Pokazuje krótki komunikat + link do legacy strony (gdy istnieje), tak
// żeby user nie był blockowany — może wciąż otworzyć stare UI.
import Link from "next/link";
import { ArrowRight } from "lucide-react";

interface Props {
  title: string;
  description?: string;
  legacyHref?: string;
  legacyLabel?: string;
}

export function TabPlaceholder({ title, description, legacyHref, legacyLabel = "Otwórz w klasycznym panelu" }: Props) {
  return (
    <div className="ba-panel">
      <div className="ba-panel-head">
        <div className="ba-panel-title">{title}</div>
      </div>
      <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
        <p style={{ margin: 0, color: "var(--muted)", maxWidth: 560 }}>
          {description ?? "Ta sekcja jest w trakcie migracji do nowego designu. Funkcjonalność dostępna w klasycznym panelu."}
        </p>
        {legacyHref ? (
          <Link href={legacyHref} className="ba-btn primary sm">
            {legacyLabel} <ArrowRight size={13} />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
