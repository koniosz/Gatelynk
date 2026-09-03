"use client";
// PropertyHeader — duży banner z nazwą/adresem osiedla + szybkie akcje.
// W MVP picker budynku (gdy admin ma >1) renderuje się tylko jeśli przekazano
// `buildings` — w innym razie wybór jest implicit przez URL `[id]`.
import Link from "next/link";
import { ArrowLeft, DoorOpen, MapPin } from "lucide-react";
import { useBaLang } from "./LangProvider";
import { EntranceQuickActions } from "./EntranceQuickActions";

export interface BuildingLite {
  id: number;
  name: string;
  address?: string;
  district?: string;
}

interface Props {
  building: BuildingLite;
  /** Lista innych budynków do switcher-a (gdy admin ma >1). */
  buildings?: BuildingLite[];
  /** FAZA b — pokazywany jako badge obok nazwy (np. „Osiedle domów"). */
  objectType?: string;
}

// FAZA b (2026-06-02) — labels dla object type badge. Stała statyczna —
// duplikat z `BuildingFeaturesContext.OBJECT_TYPE_LABELS` żeby uniknąć
// importu kontextu w komponencie czysto wizualnym.
const OBJECT_TYPE_BADGE: Record<string, string> = {
  BUILDING: "Budynek wielorodzinny",
  HOUSING_ESTATE: "Osiedle domów",
  MIXED_USE: "Wielofunkcyjny",
  CAMPUS: "Kampus",
  PARKING: "Tylko parking",
};

export function PropertyHeader({ building, buildings, objectType }: Props) {
  const { t } = useBaLang();
  const showSwitcher = buildings && buildings.length > 1;
  const typeBadge = objectType ? OBJECT_TYPE_BADGE[objectType] ?? objectType : null;

  return (
    <section className="ba-prop-header">
      <div className="ba-prop-thumb">
        <DoorOpen size={26} strokeWidth={1.5} />
      </div>
      <div style={{ flex: "1 1 320px", minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
          <Link href="/building-admin/buildings" style={{ color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <ArrowLeft size={12} />
            {t.backToProps}
          </Link>
          <span style={{ color: "var(--muted-2)" }}>·</span>
          <span className="ba-mono">#{building.id}</span>
        </div>
        <h1 className="ba-prop-name">
          {showSwitcher ? (
            <select
              defaultValue={building.id}
              onChange={(e) => {
                const next = e.target.value;
                if (next) window.location.href = `/building-admin/v2/buildings/${next}/overview`;
              }}
              style={{
                font: "inherit",
                color: "inherit",
                background: "transparent",
                border: 0,
                outline: 0,
                cursor: "pointer",
              }}
            >
              {buildings!.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          ) : (
            building.name
          )}
          <span className="badge">
            <span className="live-dot" /> {t.livePill}
          </span>
          {typeBadge && (
            <span
              className="badge"
              style={{
                background: "var(--bg-muted, rgba(255,255,255,0.06))",
                color: "var(--ink-2, rgba(255,255,255,0.8))",
                marginLeft: 8,
                fontSize: 11,
                fontWeight: 500,
              }}
              title="Typ obiektu — ustawiany przez integratora"
            >
              {typeBadge}
            </span>
          )}
        </h1>
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          <MapPin size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
          {[building.address, building.district].filter(Boolean).join(" · ")}
        </div>
      </div>

      {/* 2026-07-23: zamiast linków Punkty dostępu / Urządzenia / Odczyty
          tablic (dublowały sidebar) — przyciski wejść: podgląd z kamery
          domofonu + otwieranie, dostępne z każdej zakładki. */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginLeft: "auto",
          position: "relative",
          zIndex: 1,
        }}
      >
        <EntranceQuickActions buildingId={building.id} />
      </div>
    </section>
  );
}
