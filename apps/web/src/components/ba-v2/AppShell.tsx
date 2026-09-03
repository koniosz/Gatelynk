"use client";
// AppShell — kompozyt Sidebar + Topbar + content (PropertyHeader + Tabs +
// children) + ConciergePanel/FAB. Renderowany przez layout (ba-v2).
import { ReactNode, useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { PropertyHeader, type BuildingLite } from "./PropertyHeader";
import { ConciergePanel } from "./ConciergePanel";
import { ConciergeProvider } from "./ConciergeContext";
import { LangProvider } from "./LangProvider";
import { BaThemeProvider, useBaTheme } from "./ThemeProvider";

interface Counts {
  residents?: number;
  units?: number;
  vehicles?: number;
  guests?: number;
  issues?: number;
  payments?: number;
  notifications?: number;
  security?: number;
  devices?: number;
  courierVisits?: number;
}

interface Me {
  initials: string;
  name: string;
}

interface AppShellProps {
  building: BuildingLite;
  buildings?: BuildingLite[];
  counts?: Counts;
  me?: Me;
  buildingMeta?: string;
  // FAZA b (2026-06-02) — przekazywane do PropertyHeader żeby pokazać badge
  // „Osiedle domów" / „Budynek wielorodzinny" obok nazwy. Source z
  // BuildingFeaturesProvider w layout-cie.
  objectType?: string;
  children: ReactNode;
}

export function AppShell(props: AppShellProps) {
  return (
    <LangProvider>
      <BaThemeProvider>
        <ConciergeProvider>
          <AppShellInner {...props} />
        </ConciergeProvider>
      </BaThemeProvider>
    </LangProvider>
  );
}

function AppShellInner({ building, buildings, me, buildingMeta, objectType, children }: AppShellProps) {
  const { theme } = useBaTheme();
  // FAZA polish (h) — mobile burger menu state. `mobileNavOpen` widoczne tylko
  // gdy < 768px (sidebar hidden by default na tej szerokości — patrz CSS).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Zamykamy nav przy zmianie route-a (children się zmieni). Nasłuchujemy też
  // ESC dla a11y.
  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileNavOpen]);

  return (
    <div
      className="ba-v2"
      data-theme={theme}
      data-mobile-nav={mobileNavOpen ? "open" : "closed"}
      style={{
        display: "grid",
        gridTemplateColumns: "var(--sidebar-w) 1fr",
        minHeight: "100vh",
      }}
    >
      <Sidebar
        buildingId={building.id}
        buildingName={building.name}
        buildingMeta={buildingMeta}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />
      {/* Overlay backdrop tylko gdy mobile nav open */}
      {mobileNavOpen ? (
        <div
          className="ba-mobile-overlay"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Topbar
          buildingName={building.name}
          userInitials={me?.initials}
          userName={me?.name}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />
        <main style={{ padding: "20px 24px 60px", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <PropertyHeader building={building} buildings={buildings} objectType={objectType} />
          {/* 2026-07-21 (decyzja Konrada): TabBar usunięty — nawigację po
              funkcjach obiektu przejęło drzewko w Sidebar. */}
          <div style={{ minWidth: 0 }}>{children}</div>
        </main>
      </div>
      <ConciergePanel buildingId={building.id} buildingName={building.name} />
    </div>
  );
}
