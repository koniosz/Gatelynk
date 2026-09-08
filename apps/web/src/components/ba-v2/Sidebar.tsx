"use client";
// Sidebar 232px (handoff sekcja 5).
// FAZA polish (h):
//   - <1024px: collapsed (60px, icon-only) — sterowane CSS media query,
//   - <768px: hidden by default, otwiera się jako overlay z lewej po
//     kliknięciu burgera w Topbar (`mobileOpen` prop).
//
// 2026-07-21 (decyzja Konrada): „Obiekty" to już NIE link do legacy listy,
// tylko rozwijane DRZEWKO — wszystkie obiekty admina, a pod każdym jego
// funkcje (Lokale, Mieszkańcy, Pojazdy, Goście, Zgłoszenia, Płatności,
// Powiadomienia, Odczyty tablic). Klik w nazwę obiektu → przegląd obiektu.
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Building2,
  Users,
  ClipboardList,
  Settings,
  LogOut,
  X,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  Car,
  CreditCard,
  MessageCircle,
  Megaphone,
  ScanLine,
  ScanEye,
  Home,
  ShieldCheck,
  Cpu,
  Truck,
  BookOpen,
  BookUser,
  Map as MapIcon,
} from "lucide-react";
import { useBaLang } from "./LangProvider";
import { buildingAdminApi, clearBaToken } from "@/lib/building-admin-api";

interface SidebarProps {
  buildingId: number;
  buildingName?: string;
  buildingMeta?: string;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}

interface TreeBuilding {
  id: number;
  name: string;
}

// Funkcje obiektu w drzewku — kolejność wg decyzji Konrada (2026-07-21).
const BUILDING_FUNCTIONS: { tab: string; label: string; icon: typeof Home }[] = [
  { tab: "overview", label: "Przegląd", icon: Home },
  { tab: "units", label: "Lokale", icon: LayoutGrid },
  // Mapa osiedla (2026-09-08) — render + przypisania lokali do domów na mapie.
  { tab: "map", label: "Mapa osiedla", icon: MapIcon },
  // Grupy kontaktowe (2026-07-30) — grupowanie lokali na ekran domofonu Akuvox.
  { tab: "contact-groups", label: "Grupy kontaktowe", icon: BookUser },
  { tab: "residents", label: "Mieszkańcy", icon: Users },
  { tab: "vehicles", label: "Pojazdy", icon: Car },
  { tab: "guests", label: "Goście", icon: Users },
  { tab: "issues", label: "Zgłoszenia", icon: MessageCircle },
  { tab: "payments", label: "Płatności", icon: CreditCard },
  { tab: "notifications", label: "Powiadomienia", icon: Megaphone },
  { tab: "lpr-reads", label: "Odczyty tablic", icon: ScanLine },
  // Wizja AI (2026-07-23) — dashboard detekcji YOLO. Strona sama broni się
  // feature-gate `vision_dashboard` (Sidebar nie filtruje po permissions).
  { tab: "vision", label: "Wizja AI", icon: ScanEye },
  // Zdarzenia sytuacyjne (2026-08-26) — feed korelatora Edge + Kronika dnia.
  // Feature-gate `vision_dashboard` egzekwuje sama strona (jak Wizja AI).
  { tab: "situations", label: "Zdarzenia", icon: Activity },
  // Funkcje przeniesione z usuniętego TabBar (2026-07-21) — bez nich nie
  // byłoby żadnej nawigacji do tych stron.
  { tab: "security", label: "Bezpieczeństwo", icon: ShieldCheck },
  { tab: "devices", label: "Urządzenia", icon: Cpu },
  { tab: "courier-visits", label: "Wizyty kurierów", icon: Truck },
  { tab: "knowledge", label: "Baza wiedzy", icon: BookOpen },
];

export function Sidebar({ buildingId, buildingName, buildingMeta, mobileOpen = false, onCloseMobile }: SidebarProps) {
  const { t } = useBaLang();
  const router = useRouter();
  const pathname = usePathname();

  const [treeOpen, setTreeOpen] = useState(true);
  const [buildings, setBuildings] = useState<TreeBuilding[] | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([buildingId]));

  // Aktualnie oglądany obiekt zawsze rozwinięty (np. po przełączeniu
  // z PropertyHeader).
  useEffect(() => {
    setExpanded((prev) => {
      if (prev.has(buildingId)) return prev;
      const next = new Set(prev);
      next.add(buildingId);
      return next;
    });
  }, [buildingId]);

  useEffect(() => {
    let cancelled = false;
    buildingAdminApi
      .get<{ properties: { id: number; name: string }[] }>("/building-admin/my-buildings-overview")
      .then((r) => {
        if (cancelled) return;
        setBuildings((r.data?.properties ?? []).map((p) => ({ id: p.id, name: p.name })));
      })
      .catch(() => {
        if (!cancelled) setBuildings([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleBuilding = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleLogout = () => {
    clearBaToken();
    router.push("/building-admin/login");
  };

  return (
    <aside
      className={`ba-sidebar ${mobileOpen ? "is-mobile-open" : ""}`}
      style={{
        background: "var(--surface)",
        borderRight: "1px solid var(--border)",
        padding: "20px 14px",
        gap: 18,
        position: "sticky",
        top: 0,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        width: "var(--sidebar-w)",
      }}
    >
      <div className="ba-sidebar-header" style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px 4px" }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "linear-gradient(135deg,#2c6dff 0%,#1f4fcf 100%)",
            display: "grid",
            placeItems: "center",
            boxShadow: "0 4px 10px -2px rgba(37,99,235,0.4), inset 0 1px 0 rgba(255,255,255,0.25)",
            color: "#fff",
            flexShrink: 0,
          }}
        >
          <Building2 size={16} strokeWidth={2.2} />
        </div>
        <div className="ba-sidebar-brand">
          <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.01em" }}>GateLynk</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: -2 }}>{t.panelTitle}</div>
        </div>
        {onCloseMobile ? (
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Zamknij menu"
            className="ba-sidebar-close"
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: 0,
              color: "var(--muted)",
              cursor: "pointer",
              display: "none",
              padding: 6,
            }}
          >
            <X size={18} />
          </button>
        ) : null}
      </div>

      <nav
        className="ba-sidebar-nav"
        style={{ display: "flex", flexDirection: "column", gap: 2, overflowY: "auto", minHeight: 0, flex: 1 }}
      >
        <div className="ba-side-label">{t.panelTitle}</div>

        {/* ── Drzewko obiektów ── */}
        <button
          type="button"
          className="ba-side-item"
          style={{ width: "100%", background: "transparent", border: 0, cursor: "pointer" }}
          onClick={() => setTreeOpen((o) => !o)}
          aria-expanded={treeOpen}
          title={t.nav.properties}
        >
          <Building2 size={16} />
          <span className="ba-side-item-label" style={{ flex: 1, textAlign: "left" }}>{t.nav.properties}</span>
          <span className="ba-side-item-label" style={{ display: "inline-flex" }}>
            {treeOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        </button>

        {treeOpen ? (
          buildings === null ? (
            <div className="ba-side-item-label" style={{ padding: "4px 10px 4px 30px", fontSize: 12, color: "var(--muted)" }}>
              Ładowanie…
            </div>
          ) : buildings.length === 0 ? (
            <div className="ba-side-item-label" style={{ padding: "4px 10px 4px 30px", fontSize: 12, color: "var(--muted)" }}>
              Brak obiektów
            </div>
          ) : (
            buildings.map((b) => {
              const isExpanded = expanded.has(b.id);
              const isCurrent = b.id === buildingId;
              return (
                <div key={b.id} className="ba-side-item-label" style={{ display: "block" }}>
                  {/* Wiersz obiektu: chevron rozwija, nazwa → przegląd */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      marginLeft: 10,
                      borderRadius: 8,
                      background: isCurrent && !isExpanded ? "var(--surface-2)" : "transparent",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleBuilding(b.id)}
                      aria-label={isExpanded ? "Zwiń obiekt" : "Rozwiń obiekt"}
                      aria-expanded={isExpanded}
                      style={{
                        background: "transparent",
                        border: 0,
                        cursor: "pointer",
                        color: "var(--muted)",
                        padding: "6px 2px 6px 4px",
                        display: "grid",
                        placeItems: "center",
                      }}
                    >
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setExpanded((prev) => new Set(prev).add(b.id));
                        router.push(`/building-admin/v2/buildings/${b.id}/overview`);
                        onCloseMobile?.();
                      }}
                      title={b.name}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        background: "transparent",
                        border: 0,
                        cursor: "pointer",
                        textAlign: "left",
                        padding: "7px 8px 7px 0",
                        fontSize: 13,
                        fontWeight: isCurrent ? 700 : 500,
                        color: isCurrent ? "var(--ink, inherit)" : "var(--ink-2, inherit)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "block",
                      }}
                    >
                      {b.name}
                    </button>
                  </div>

                  {/* Funkcje obiektu */}
                  {isExpanded ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 1, margin: "1px 0 4px" }}>
                      {BUILDING_FUNCTIONS.map((f) => {
                        const href = `/building-admin/v2/buildings/${b.id}/${f.tab}`;
                        const active = pathname === href;
                        const Icon = f.icon;
                        return (
                          <Link
                            key={f.tab}
                            href={href}
                            onClick={onCloseMobile}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              marginLeft: 30,
                              padding: "6px 10px",
                              borderRadius: 8,
                              fontSize: 12.5,
                              fontWeight: active ? 700 : 500,
                              color: active ? "var(--blue, #2563eb)" : "var(--ink-2, inherit)",
                              background: active ? "var(--blue-50, #eff6ff)" : "transparent",
                              textDecoration: "none",
                            }}
                          >
                            <Icon size={14} />
                            <span>{f.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )
        ) : null}

        <div className="ba-side-label" style={{ marginTop: 8 }}>
          Inne
        </div>
        <span className="ba-side-item" style={{ opacity: 0.5, cursor: "default" }} title={t.nav.reports}>
          <ClipboardList size={16} />
          <span className="ba-side-item-label">{t.nav.reports}</span>
        </span>
        <span className="ba-side-item" style={{ opacity: 0.5, cursor: "default" }} title={t.nav.settings}>
          <Settings size={16} />
          <span className="ba-side-item-label">{t.nav.settings}</span>
        </span>
      </nav>

      {buildingName ? (
        <div
          className="ba-sidebar-building"
          style={{
            marginTop: "auto",
            padding: 12,
            borderRadius: "var(--r-2)",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--bg-2)",
              display: "grid",
              placeItems: "center",
              color: "var(--ink-2)",
              flexShrink: 0,
            }}
          >
            <Building2 size={16} />
          </div>
          <div className="ba-sidebar-building-text" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{buildingName}</div>
            {buildingMeta ? <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{buildingMeta}</div> : null}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        onClick={handleLogout}
        className="ba-btn sm ba-sidebar-logout"
        style={{ marginTop: 8, justifyContent: "center" }}
        title="Wyloguj"
      >
        <LogOut size={13} />
        <span className="ba-sidebar-logout-label">Wyloguj</span>
      </button>
    </aside>
  );
}
