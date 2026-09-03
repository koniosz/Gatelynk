"use client";
// Topbar 56px — breadcrumbs + globalna wyszukiwarka + lang toggle +
// ikony Bell/Settings + user-chip.
import { Bell, Building2, ChevronRight, Menu, Moon, Search, Settings, Sun } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useBaLang } from "./LangProvider";
import { useBaTheme } from "./ThemeProvider";
import { GlobalSearch } from "./GlobalSearch";

interface TopbarProps {
  /** Tytuł obiektu wyświetlany jako breadcrumb-leaf. */
  buildingName: string;
  /** Inicjały usera dla awatara (np. "JM"). */
  userInitials?: string;
  userName?: string;
  /** FAZA polish (h) — burger menu opener (visible <768px). */
  onOpenMobileNav?: () => void;
}

export function Topbar({ buildingName, userInitials = "JM", userName = "Jan Marciniak", onOpenMobileNav }: TopbarProps) {
  const { lang, setLang, t } = useBaLang();
  const { theme, toggle: toggleTheme } = useBaTheme();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const params = useParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);

  return (
    <header
      className="ba-topbar"
      style={{
        height: "var(--header-h)",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 24px",
        position: "sticky",
        top: 0,
        zIndex: 30,
      }}
    >
      {/* Burger — visible only <768px (CSS) */}
      {onOpenMobileNav ? (
        <button
          type="button"
          className="ba-icon-btn ba-topbar-burger"
          aria-label="Menu"
          onClick={onOpenMobileNav}
        >
          <Menu size={18} />
        </button>
      ) : null}

      <div
        className="ba-topbar-breadcrumbs"
        style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 13 }}
      >
        <Building2 size={15} />
        <span className="ba-topbar-breadcrumb-root">{t.breadcrumb}</span>
        <ChevronRight size={13} style={{ color: "var(--muted-2)" }} />
        <span style={{ color: "var(--ink)", fontWeight: 600 }}>{buildingName}</span>
      </div>

      <div style={{ flex: 1 }} />

      {Number.isFinite(buildingId) ? (
        <>
          {/* Search inline (desktop). On mobile pokazujemy ikonę. */}
          <div className="ba-topbar-search-inline">
            <GlobalSearch buildingId={buildingId} placeholder={t.search} />
          </div>
          <button
            type="button"
            className="ba-icon-btn ba-topbar-search-toggle"
            aria-label="Szukaj"
            onClick={() => setMobileSearchOpen((v) => !v)}
          >
            <Search size={16} />
          </button>
          {mobileSearchOpen ? (
            <div className="ba-topbar-search-mobile">
              <GlobalSearch buildingId={buildingId} placeholder={t.search} />
            </div>
          ) : null}
        </>
      ) : null}

      <div className="ba-lang-toggle" role="group" aria-label="Language">
        <button type="button" className={lang === "pl" ? "on" : ""} onClick={() => setLang("pl")}>
          PL
        </button>
        <button type="button" className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>
          EN
        </button>
      </div>

      <button
        type="button"
        className="ba-icon-btn"
        aria-label={theme === "dark" ? "Włącz motyw jasny" : "Włącz motyw ciemny"}
        title={theme === "dark" ? "Motyw jasny" : "Motyw ciemny"}
        onClick={toggleTheme}
      >
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button type="button" className="ba-icon-btn" aria-label="Notifications">
        <Bell size={16} />
        <span className="dot" />
      </button>
      <button type="button" className="ba-icon-btn" aria-label="Settings">
        <Settings size={16} />
      </button>

      <div className="ba-user-chip">
        <div className="av">{userInitials}</div>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{userName}</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>{t.role}</div>
        </div>
      </div>
    </header>
  );
}
