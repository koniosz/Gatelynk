"use client";
// Overview 2026-07-23 — deck kafelków nawigacyjnych: Lokale, Mieszkańcy,
// Pojazdy, Goście, Płatności, Zgłoszenia, Przesyłki, Rezerwacje, Ogłoszenia.
// Sekcja WEJŚCIA (podgląd z kamery + otwieranie) przeniesiona do nagłówka
// panelu (EntranceQuickActions w PropertyHeader) — dostępna z każdej
// zakładki, nie tylko z Przeglądu. Projektowane pod czytelność dla
// starszych osób — duże ikony, duże liczby, jedna akcja per kafelek.
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Building2,
  CalendarDays,
  Car,
  CreditCard,
  Megaphone,
  MessageCircle,
  Package,
  Sparkles,
  Users,
} from "lucide-react";
import { useConcierge } from "@/components/ba-v2/ConciergeContext";
import { buildingAdminApi } from "@/lib/building-admin-api";

interface PortfolioProperty {
  id: number;
  units: number;
  residents: number;
  tickets: number;
  inProgress: number;
  overdueAmount: number;
  unitsInArrears: number;
  activeGuests: number;
  pendingVehicles: number;
}

const fmtZl = (n: number) =>
  n.toLocaleString("pl-PL", { maximumFractionDigits: 0 }) + " zł";

export default function OverviewPage() {
  const params = useParams();
  const router = useRouter();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);
  const { askQuestion } = useConcierge();
  const [question, setQuestion] = useState("");

  const [prop, setProp] = useState<PortfolioProperty | null>(null);

  useEffect(() => {
    if (!Number.isFinite(buildingId)) return;
    let cancelled = false;
    const load = () => {
      buildingAdminApi
        .get<{ properties: PortfolioProperty[] }>("/building-admin/my-buildings-overview")
        .then((r) => {
          if (cancelled) return;
          const p = (r.data?.properties ?? []).find((x) => x.id === buildingId);
          if (p) setProp(p);
        })
        .catch(() => {});
    };
    load();
    // Live badge (zgłoszenie 2026-08-14): nowe zgłoszenie/pojazd ma zapalić
    // czerwone kółko BEZ odświeżania strony. Polling co 25 s (wzorzec
    // devices/issues w tym panelu) + natychmiastowy refetch, gdy admin wraca
    // do karty przeglądarki — wtedy świeżość liczy się najbardziej.
    const timer = setInterval(load, 25_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [buildingId]);

  const go = (tab: string) => router.push(`/building-admin/v2/buildings/${buildingId}/${tab}`);

  const submit = () => {
    const q = question.trim();
    if (!q) return;
    askQuestion(q);
    setQuestion("");
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "8px 0 40px" }}>
      {/* ── Kafelki nawigacyjne ── */}
      <SectionLabel>Zarządzanie osiedlem</SectionLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(215px, 1fr))",
          gap: 14,
          marginBottom: 32,
        }}
      >
        <NavTile
          icon={<Building2 size={26} />}
          label="Lokale"
          value={prop ? String(prop.units) : "…"}
          sub="wszystkie lokale"
          onClick={() => go("units")}
        />
        <NavTile
          icon={<Users size={26} />}
          label="Mieszkańcy"
          value={prop ? String(prop.residents) : "…"}
          sub="zarejestrowani"
          onClick={() => go("residents")}
        />
        <NavTile
          icon={<Car size={26} />}
          label="Pojazdy"
          alert={prop?.pendingVehicles ?? 0}
          badge={prop && prop.pendingVehicles > 0 ? `${prop.pendingVehicles} do zatwierdzenia` : undefined}
          badgeTone="amber"
          sub={prop && prop.pendingVehicles > 0 ? "wymagają Twojej decyzji" : "wszystkie zatwierdzone"}
          onClick={() => go("vehicles")}
        />
        <NavTile
          icon={<Users size={26} />}
          label="Goście"
          value={prop ? String(prop.activeGuests) : "…"}
          sub="aktywne zaproszenia"
          onClick={() => go("guests")}
        />
        <NavTile
          icon={<CreditCard size={26} />}
          label="Płatności"
          alert={prop?.unitsInArrears ?? 0}
          badge={prop && prop.overdueAmount > 0 ? `zaległości ${fmtZl(prop.overdueAmount)}` : undefined}
          badgeTone="red"
          sub={
            prop && prop.overdueAmount > 0
              ? `${prop.unitsInArrears} ${prop.unitsInArrears === 1 ? "lokal zalega" : "lokali zalega"}`
              : "brak zaległości"
          }
          onClick={() => go("payments")}
        />
        <NavTile
          icon={<MessageCircle size={26} />}
          label="Zgłoszenia"
          alert={prop?.tickets ?? 0}
          badge={prop && prop.tickets > 0 ? `${prop.tickets} bez odpowiedzi` : undefined}
          badgeTone="blue"
          sub={
            prop && prop.tickets > 0
              ? prop.inProgress > 0
                ? `${prop.inProgress} w toku`
                : "czekają na odpowiedź"
              : "wszystkie obsłużone"
          }
          onClick={() => go("issues")}
        />
        <NavTile
          icon={<Package size={26} />}
          label="Przesyłki"
          sub="obsługa w panelu konsjerża"
          comingSoon
        />
        <NavTile
          icon={<CalendarDays size={26} />}
          label="Rezerwacje"
          sub="części wspólne"
          comingSoon
        />
        <NavTile
          icon={<Megaphone size={26} />}
          label="Ogłoszenia"
          sub="komunikaty do mieszkańców"
          onClick={() => go("notifications")}
        />
      </div>

      {/* ── Pytanie do asystenta ── */}
      <SectionLabel>Masz pytanie?</SectionLabel>
      <div className="ba-ov3-ask" style={{ maxWidth: "none" }}>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            background: "linear-gradient(135deg,#2c6dff,#1f4fcf)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <Sparkles size={16} />
        </span>
        <textarea
          rows={1}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Zapytaj, np. kiedy ostatnio był kurier?"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Zadaj pytanie asystentowi"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!question.trim()}
          className="ba-btn primary sm"
          style={{ opacity: question.trim() ? 1 : 0.5 }}
        >
          Zapytaj
        </button>
      </div>

    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.07em",
        color: "var(--muted)",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

// ── Kafelek nawigacyjny ──────────────────────────────────────────────────────
function NavTile({
  icon,
  label,
  value,
  badge,
  badgeTone,
  alert,
  sub,
  onClick,
  comingSoon,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  badge?: string;
  badgeTone?: "amber" | "red" | "blue";
  /** Liczba spraw CZEKAJĄCYCH NA CZŁOWIEKA (zgłoszenie 2026-08-13) —
   *  czerwone kółko w rogu kafelka, jak nieprzeczytane na ikonie w iOS.
   *  0/undefined = brak kółka. Chip tekstowy (badge) zostaje — kółko
   *  przyciąga wzrok, chip wyjaśnia. */
  alert?: number;
  sub: string;
  onClick?: () => void;
  comingSoon?: boolean;
}) {
  const tones: Record<string, { bg: string; color: string }> = {
    amber: { bg: "#fffbeb", color: "#b45309" },
    red: { bg: "#fef2f2", color: "#b91c1c" },
    blue: { bg: "#eff6ff", color: "#1d4ed8" },
  };
  const t = badgeTone ? tones[badgeTone] : null;
  return (
    <button
      type="button"
      onClick={comingSoon ? undefined : onClick}
      disabled={comingSoon}
      style={{
        position: "relative",
        textAlign: "left",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: "16px 18px",
        cursor: comingSoon ? "default" : "pointer",
        opacity: comingSoon ? 0.6 : 1,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 118,
      }}
    >
      {alert && alert > 0 ? (
        <span
          aria-label={`${alert} spraw do podjęcia`}
          style={{
            position: "absolute",
            top: -8,
            right: -8,
            minWidth: 24,
            height: 24,
            padding: "0 7px",
            borderRadius: 999,
            background: "#ef4444",
            color: "#fff",
            fontSize: 13,
            fontWeight: 800,
            display: "grid",
            placeItems: "center",
            border: "2px solid var(--surface)",
            boxShadow: "0 2px 6px rgba(0,0,0,.2)",
            lineHeight: 1,
          }}
        >
          {alert > 99 ? "99+" : alert}
        </span>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: "var(--bg, #f4f6fb)",
            border: "1px solid var(--border)",
            display: "grid",
            placeItems: "center",
            color: "var(--ink-2, #39424f)",
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em", flex: 1 }}>
          {label}
        </span>
        {comingSoon ? (
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              letterSpacing: "0.05em",
              padding: "3px 8px",
              borderRadius: 999,
              background: "var(--bg, #f4f6fb)",
              border: "1px solid var(--border)",
              color: "var(--muted)",
            }}
          >
            WKRÓTCE
          </span>
        ) : value !== undefined ? (
          <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}>{value}</span>
        ) : null}
      </div>
      {badge && t ? (
        <span
          style={{
            alignSelf: "flex-start",
            fontSize: 13,
            fontWeight: 700,
            padding: "4px 10px",
            borderRadius: 999,
            background: t.bg,
            color: t.color,
          }}
        >
          {badge}
        </span>
      ) : null}
      <span style={{ fontSize: 13, color: "var(--muted)" }}>{sub}</span>
    </button>
  );
}
