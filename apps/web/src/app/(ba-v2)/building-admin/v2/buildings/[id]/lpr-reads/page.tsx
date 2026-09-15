"use client";
/**
 * Odczyty tablic (LPR) — BA v2 (sprint 2026-06-12).
 *
 * Migracja legacy strony `(building-admin-dashboard)/.../lpr-reads/page.tsx`
 * do nowego designu ba-v2 (tokeny ba-tokens.css, działa w data-theme="dark").
 * Co innego niż w legacy:
 *   • stat cards: Dziś / Rozpoznane / Nieznane / Z otwarciem bramy,
 *   • filtry chip: Wszystkie / Rozpoznane / Nieznane / Otwarte,
 *   • miniaturki LAZY (`LazyLprThumbnail` — IntersectionObserver + semafor
 *     max 4 równoczesne fetche + retry; fix zatkanego łącza Cloud→Edge),
 *   • tab widoczny tylko gdy `hasBaFeature('lpr_audit')` (TabBar filtruje,
 *     ale strona też się broni — deep-link bez permission dostaje notkę).
 *
 * Wyszukiwanie + paginacja są server-side (`?q&offset&limit&matched`) — jak
 * w legacy. Klik w miniaturę / wiersz otwiera istniejący `LprViewer`
 * (reuse, NIE przepisany — to on pilnuje POST vs PATCH przy identyfikacji,
 * pułapka #6: edycja istniejącego pojazdu MUSI iść PATCH-em po vehicleId,
 * inaczej powstaje duplikat wpisu z tą samą tablicą).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  CalendarDays,
  Camera,
  DoorOpen,
  HelpCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import {
  LprRead,
  brandLabel,
  colorLabel,
  colorSwatch,
  formatReadTs,
  ownerDisplay,
  vehicleTypePl,
} from "@/lib/lpr";
import { LprViewer } from "@/components/LprViewer";
import { LazyLprThumbnail } from "@/components/LazyLprThumbnail";
import { usePagination, useDebouncedValue } from "@/components/Pagination";
import { useBuildingFeatures } from "@/components/ba-v2/BuildingFeaturesContext";

type FilterKey = "all" | "matched" | "unknown" | "opened";

/**
 * Backend filtruje po `matched` (tablica na whiteliście w momencie odczytu).
 * "Otwarte" nie ma server-side filtra (brak `gateOpened` w API) — zawężamy
 * server-side do matched=true i doszlifowujemy lokalnie po `gateOpened`
 * w obrębie strony (ten sam wzorzec co legacy residents/services).
 */
const FILTER_PARAM: Record<FilterKey, Record<string, string>> = {
  all: {},
  matched: { matched: "true" },
  unknown: { matched: "false" },
  opened: { matched: "true" },
};

const FILTER_LABEL: Record<FilterKey, string> = {
  all: "Wszystkie",
  matched: "Rozpoznane",
  unknown: "Nieznane",
  opened: "Otwarte",
};

/**
 * Data → `YYYY-MM-DD` w czasie LOKALNYM (nie UTC — `toISOString()` przesunęłoby
 * o strefę i wieczorem dałoby jutrzejszą datę). Używane jako wartość `<input
 * type=date>` i parametr `?day=` (backend porównuje w Europe/Warsaw).
 */
function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface LprStats {
  today: number;
  matched: number;
  unknown: number;
  opened: number;
  /** Ile wierszy objęła próbka (Dziś / Z otwarciem liczone z próbki). */
  sampleSize: number;
  total: number;
}

export default function BaV2LprReadsPage() {
  const params = useParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);
  const { hasBaFeature } = useBuildingFeatures();

  const [reads, setReads] = useState<LprRead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<LprStats | null>(null);

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [filter, setFilter] = useState<FilterKey>("all");
  // Filtr po konkretnym dniu (YYYY-MM-DD, czas lokalny). "" = całe 30-dniowe okno.
  const [day, setDay] = useState("");
  const { page, pageSize, offset, setPage, setPageSize, resetToFirstPage } = usePagination(50);

  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  // Granice kalendarza: od (dziś − 30 dni) do dziś — poza tym oknem i tak nie ma
  // danych (retencja 30 dni), więc nie pozwalamy wybrać pustego zakresu.
  const todayIso = useMemo(() => isoDay(new Date()), []);
  const minIso = useMemo(() => isoDay(new Date(Date.now() - 30 * 86_400_000)), []);

  // Reset do strony 1 przy zmianie filtrów / wyszukiwarki / dnia.
  useEffect(() => {
    resetToFirstPage();
  }, [debouncedSearch, filter, day, resetToFirstPage]);

  const loadReads = useCallback(() => {
    if (!Number.isFinite(buildingId) || buildingId <= 0) return;
    setLoading(true);
    const qs = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
    });
    if (debouncedSearch.trim()) qs.set("q", debouncedSearch.trim());
    if (day) qs.set("day", day);
    Object.entries(FILTER_PARAM[filter]).forEach(([k, v]) => qs.set(k, v));

    buildingAdminApi
      .get<{ reads: LprRead[]; total?: number }>(
        `/building-admin/buildings/${buildingId}/lpr-reads?${qs.toString()}`,
      )
      .then((res) => {
        setReads(res.data.reads);
        setTotal(res.data.total ?? 0);
      })
      .catch((err) => {
        if (err?.response?.status !== 401) console.error(err);
      })
      .finally(() => setLoading(false));
  }, [buildingId, pageSize, offset, debouncedSearch, filter, day]);

  useEffect(() => {
    loadReads();
  }, [loadReads]);

  /**
   * Stat cards — niezależne od search/filtra (zawsze pełne 30-dniowe okno).
   * API nie ma endpointu stats, więc liczymy z dwóch lekkich zapytań:
   *   • `?limit=500` → próbka (Dziś + Z otwarciem) + dokładny `total`,
   *   • `?limit=1&matched=true` → dokładny licznik rozpoznanych (z COUNT).
   * Przy >500 odczytach Dziś/Z otwarciem liczone z 500 NAJNOWSZYCH — w
   * praktyce wystarczająco (Dziś jest zawsze na początku okna DESC).
   */
  const loadStats = useCallback(() => {
    if (!Number.isFinite(buildingId) || buildingId <= 0) return;
    Promise.all([
      buildingAdminApi.get<{ reads: LprRead[]; total?: number }>(
        `/building-admin/buildings/${buildingId}/lpr-reads?limit=500&offset=0`,
      ),
      buildingAdminApi.get<{ reads: LprRead[]; total?: number }>(
        `/building-admin/buildings/${buildingId}/lpr-reads?limit=1&offset=0&matched=true`,
      ),
    ])
      .then(([sampleRes, matchedRes]) => {
        const sample = sampleRes.data.reads ?? [];
        const allTotal = sampleRes.data.total ?? sample.length;
        const matchedTotal = matchedRes.data.total ?? 0;
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const midnightMs = midnight.getTime();
        let today = 0;
        let opened = 0;
        for (const r of sample) {
          if (new Date(r.ts).getTime() >= midnightMs) today += 1;
          if (r.gateOpened) opened += 1;
        }
        setStats({
          today,
          matched: matchedTotal,
          unknown: Math.max(0, allTotal - matchedTotal),
          opened,
          sampleSize: sample.length,
          total: allTotal,
        });
      })
      .catch((err) => {
        if (err?.response?.status !== 401) console.error(err);
      });
  }, [buildingId]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const refreshAll = () => {
    loadReads();
    loadStats();
  };

  // Lokalny refine dla "Otwarte" — patrz komentarz przy FILTER_PARAM.
  const visible = useMemo(
    () => (filter === "opened" ? reads.filter((r) => r.gateOpened) : reads),
    [reads, filter],
  );

  const openViewer = (read: LprRead) => {
    const idx = visible.findIndex((r) => r.id === read.id);
    if (idx >= 0) setViewerIndex(idx);
  };

  // Deep-link bez permission `feat_lpr_audit` → notka zamiast danych
  // (TabBar i tak chowa zakładkę; to defense-in-depth jak w courier-visits).
  if (!hasBaFeature("lpr_audit")) {
    return (
      <div style={{ padding: 24, color: "var(--muted)" }}>
        Ta zakładka jest niedostępna — integrator wyłączył audyt LPR
        (lpr_audit) dla tego obiektu.
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="ba-panel">
      {/* Head: tytuł + search + odśwież */}
      <div className="ba-panel-head">
        <div className="ba-panel-title">
          <Camera size={16} />
          Odczyty tablic
          <span className="pill">{total}</span>
        </div>
        <div className="ba-panel-tools" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "var(--card, var(--surface))",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "4px 10px",
              minWidth: 240,
            }}
          >
            <Search size={13} color="var(--muted)" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Szukaj: tablica, mieszkaniec, marka, lokal…"
              className="ba-input"
              style={{
                border: 0,
                background: "transparent",
                outline: "none",
                fontSize: 13,
                width: "100%",
                padding: 0,
              }}
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Wyczyść"
                style={{
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                  color: "var(--muted)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <X size={13} />
              </button>
            ) : null}
          </label>
          {/* Wybór dnia z kalendarza — pokazuje odczyty tylko z tej daty
              (czas lokalny). Pusty = całe 30-dniowe okno. Granice min/max =
              okno retencji, żeby nie dało się wybrać pustego zakresu. */}
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "var(--card, var(--surface))",
              border: "1px solid var(--border)",
              borderColor: day ? "var(--blue)" : "var(--border)",
              borderRadius: 8,
              padding: "4px 10px",
            }}
            title="Pokaż odczyty z konkretnego dnia"
          >
            <CalendarDays size={13} color={day ? "var(--blue-600)" : "var(--muted)"} />
            <input
              type="date"
              value={day}
              min={minIso}
              max={todayIso}
              onChange={(e) => setDay(e.target.value)}
              className="ba-input"
              aria-label="Dzień odczytów"
              style={{
                border: 0,
                background: "transparent",
                outline: "none",
                fontSize: 13,
                padding: 0,
                color: day ? "var(--ink)" : "var(--muted)",
                colorScheme: "dark light",
              }}
            />
            {day ? (
              <button
                type="button"
                onClick={() => setDay("")}
                aria-label="Wyczyść dzień"
                style={{
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                  color: "var(--muted)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <X size={13} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setDay(todayIso)}
                title="Pokaż tylko dzisiejsze"
                style={{
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                  color: "var(--muted)",
                  fontSize: 11.5,
                  whiteSpace: "nowrap",
                }}
              >
                Dziś
              </button>
            )}
          </label>
          <button type="button" className="ba-btn sm" onClick={refreshAll} title="Odśwież">
            <RefreshCw size={13} /> Odśwież
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 10,
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <StatCard icon={<CalendarDays size={16} />} label="Dziś" value={stats?.today} />
        <StatCard
          icon={<BadgeCheck size={16} />}
          label="Rozpoznane (30 dni)"
          value={stats?.matched}
          tone="green"
        />
        <StatCard
          icon={<HelpCircle size={16} />}
          label="Nieznane (30 dni)"
          value={stats?.unknown}
          tone="amber"
        />
        <StatCard
          icon={<DoorOpen size={16} />}
          label="Z otwarciem bramy"
          value={stats?.opened}
          tone="blue"
        />
      </div>

      {/* Filtry chip */}
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {(Object.keys(FILTER_LABEL) as FilterKey[]).map((key) => {
          const active = filter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className="ba-btn sm"
              style={
                active
                  ? {
                      background: "var(--blue-50)",
                      color: "var(--blue-600)",
                      borderColor: "var(--blue)",
                      fontWeight: 600,
                    }
                  : undefined
              }
            >
              {FILTER_LABEL[key]}
            </button>
          );
        })}
        {filter === "opened" ? (
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
            filtr zawęża wyniki w obrębie strony (brak filtra serwerowego)
          </span>
        ) : null}
      </div>

      {/* Lista */}
      {loading ? (
        <div className="ba-empty">Ładowanie odczytów…</div>
      ) : visible.length === 0 ? (
        <div className="ba-empty">
          <div className="ico">
            <Camera size={22} />
          </div>
          <h4>
            {debouncedSearch.trim()
              ? `Brak wpisów dla zapytania „${debouncedSearch}"`
              : day
                ? `Brak odczytów z dnia ${day}`
                : "Brak odczytów dla wybranych filtrów"}
          </h4>
          <p>
            Przejazdy z kamer LPR z ostatnich 30 dni. Możesz przypisać nieznane
            auto do mieszkańca albo zarejestrować usługę (np. dostawę, śmieciarkę).
          </p>
        </div>
      ) : (
        <div>
          {/* Nagłówek tabeli */}
          <div
            className="ba-row"
            style={{
              gridTemplateColumns: "72px 120px 1.4fr 1.2fr 150px 130px auto",
              cursor: "default",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--muted)",
              textTransform: "uppercase",
              letterSpacing: 0.4,
              background: "var(--surface-2)",
            }}
          >
            <div>Zdjęcie</div>
            <div>Tablica</div>
            <div>Pojazd</div>
            <div>Właściciel</div>
            <div>Czas / kierunek</div>
            <div>Brama</div>
            <div />
          </div>
          {visible.map((r) => (
            <ReadRow key={r.id} read={r} buildingId={buildingId} onOpenViewer={() => openViewer(r)} />
          ))}
        </div>
      )}

      {/* Paginacja — token-based (Tailwind-owy <Pagination/> gryzie się z dark
          mode ba-v2, więc rysujemy lekki pager na ba-btn). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap",
          padding: "10px 16px",
          borderTop: "1px solid var(--border)",
          fontSize: 13,
          color: "var(--muted)",
        }}
      >
        <span>
          {total === 0
            ? "Brak wyników"
            : `Pokazane ${offset + 1}–${Math.min(offset + pageSize, total)} z ${total}`}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            Wierszy:
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="ba-input"
              style={{ padding: "3px 8px", fontSize: 13 }}
            >
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="ba-btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ‹ Poprzednia
          </button>
          <span style={{ whiteSpace: "nowrap" }}>
            Strona {Math.min(page, totalPages)} z {totalPages}
          </span>
          <button
            type="button"
            className="ba-btn sm"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Następna ›
          </button>
        </div>
      </div>

      {/* Fullscreen viewer — reuse legacy komponentu. `buildVehicleUrl` (PATCH)
          obok `buildVehiclesUrl` (POST) jest kluczowe — pułapka #6. */}
      {viewerIndex !== null && visible[viewerIndex] && (
        <LprViewer
          reads={visible}
          initialIndex={viewerIndex}
          apiClient={buildingAdminApi}
          buildImageUrl={(id) => `/building-admin/buildings/${buildingId}/lpr-reads/${id}/image`}
          buildVehiclesUrl={() => `/building-admin/buildings/${buildingId}/vehicles`}
          buildVehicleUrl={(id) => `/building-admin/buildings/${buildingId}/vehicles/${id}`}
          buildResidentsUrl={() => `/building-admin/buildings/${buildingId}/residents`}
          buildUnitsUrl={() => `/building-admin/buildings/${buildingId}/units`}
          buildServiceNamesUrl={() => `/building-admin/buildings/${buildingId}/vehicle-service-names`}
          buildVehicleTagsUrl={() => `/building-admin/buildings/${buildingId}/vehicle-tags`}
          onClose={() => setViewerIndex(null)}
          onSaved={refreshAll}
        />
      )}
    </div>
  );
}

// ── Wiersz odczytu ────────────────────────────────────────────────────────────
function ReadRow({
  read: r,
  buildingId,
  onOpenViewer,
}: {
  read: LprRead;
  buildingId: number;
  onOpenViewer: () => void;
}) {
  const brand = brandLabel(r) || "—";
  const color = colorLabel(r);
  const swatch = colorSwatch(r.vehicleColorStored ?? r.vehicleColor);
  const type = vehicleTypePl(r.vehicleType);
  const owner = ownerDisplay(r);

  return (
    <div
      className="ba-row"
      style={{ gridTemplateColumns: "72px 120px 1.4fr 1.2fr 150px 130px auto" }}
      onClick={onOpenViewer}
    >
      {/* Zdjęcie — LAZY (IntersectionObserver + semafor max 4 fetche). */}
      <div onClick={(e) => e.stopPropagation()}>
        {r.hasImage ? (
          <LazyLprThumbnail
            apiClient={buildingAdminApi}
            url={`/building-admin/buildings/${buildingId}/lpr-reads/${r.id}/image`}
            onClick={onOpenViewer}
            style={{ width: 64, height: 48, borderRadius: 6 }}
          />
        ) : (
          <div
            style={{
              width: 64,
              height: 48,
              borderRadius: 6,
              background: "var(--bg-2)",
              display: "grid",
              placeItems: "center",
              color: "var(--muted-2)",
              fontSize: 11,
            }}
          >
            —
          </div>
        )}
      </div>

      {/* Plate badge — czarne tło / żółta ramka / mono (czytelne w dark mode). */}
      <div>
        <span
          className="ba-mono"
          style={{
            display: "inline-block",
            background: "#0b0f14",
            border: "1.5px solid #eab308",
            color: "#fde68a",
            borderRadius: 5,
            padding: "2px 8px",
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: 0.8,
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          {r.plate}
        </span>
      </div>

      {/* Pojazd */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {swatch ? (
            <span
              style={{
                display: "inline-block",
                width: 10,
                height: 10,
                borderRadius: "50%",
                border: "1px solid var(--border-strong)",
                background: swatch,
                flexShrink: 0,
              }}
            />
          ) : null}
          <span
            style={
              brand === "—"
                ? { color: "var(--muted-2)", fontSize: 13 }
                : { fontWeight: 600, fontSize: 13 }
            }
          >
            {brand}
          </span>
        </div>
        {(type || color) && (
          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
            {[type, color].filter(Boolean).join(" · ")}
          </div>
        )}
        {r.vehicleTags && r.vehicleTags.length > 0 ? (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
            {r.vehicleTags.slice(0, 3).map((t) => (
              <span
                key={t}
                style={{
                  fontSize: 10,
                  padding: "1px 7px",
                  borderRadius: 999,
                  background: "var(--bg-2)",
                  color: "var(--ink-2)",
                  border: "1px solid var(--border)",
                }}
              >
                {t}
              </span>
            ))}
            {r.vehicleTags.length > 3 ? (
              <span style={{ fontSize: 10, color: "var(--muted-2)" }}>
                +{r.vehicleTags.length - 3}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Właściciel / kategoria */}
      <div style={{ minWidth: 0 }}>
        {owner ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}>
              {owner.icon ? <span style={{ fontSize: 12 }}>{owner.icon}</span> : null}
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {owner.primary}
              </span>
            </div>
            {owner.secondary ? (
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{owner.secondary}</div>
            ) : null}
          </>
        ) : (
          <span style={{ fontSize: 12, color: "var(--muted-2)", fontStyle: "italic" }}>
            nieznany
          </span>
        )}
      </div>

      {/* Czas + kierunek */}
      <div style={{ fontSize: 12.5, whiteSpace: "nowrap" }}>
        <div>{formatReadTs(r.ts)}</div>
        {r.direction === "IN" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--green)", fontSize: 11.5 }}>
            <ArrowDownLeft size={12} /> wjazd
          </div>
        ) : r.direction === "OUT" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--muted)", fontSize: 11.5 }}>
            <ArrowUpRight size={12} /> wyjazd
          </div>
        ) : null}
      </div>

      {/* Brama */}
      <div>
        {r.gateOpened ? (
          <span className="ba-pill green">✓ otwarta</span>
        ) : r.reason === "probable_match" ? (
          // 2026-09-15: odczyt niepewny (1 klatka / niski próg) dopasowany do
          // rejestru na Edge — brama celowo NIE otwierana, ale przejazd jest.
          <span className="ba-pill blue" title="Odczyt niepewny dopasowany do rejestru — brama nieotwierana">
            prawdopodobny · nie otwarto
          </span>
        ) : r.reason === "unconfirmed" ? (
          <span className="ba-pill amber" title="Tablica z jednej klatki lub poniżej progu, bez dopasowania do rejestru">
            odczyt niepotwierdzony
          </span>
        ) : r.matched ? (
          <span className="ba-pill amber">nie otwarto</span>
        ) : (
          <span style={{ color: "var(--muted-2)", fontSize: 12 }}>—</span>
        )}
      </div>

      {/* Akcja */}
      <div onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={"ba-btn sm" + (r.vehicleId ? "" : " primary")}
          onClick={onOpenViewer}
        >
          {r.vehicleId ? "Podgląd" : "Identyfikuj…"}
        </button>
      </div>
    </div>
  );
}

// ── StatCard — ten sam wzorzec co vehicles/page.tsx ───────────────────────────
function StatCard({
  icon,
  label,
  value,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  tone?: "default" | "amber" | "green" | "blue";
}) {
  const toneStyle: Record<string, React.CSSProperties> = {
    default: { borderColor: "var(--border)", background: "var(--card, var(--surface))" },
    amber: { borderColor: "var(--amber)", background: "var(--amber-50)" },
    green: { borderColor: "var(--green)", background: "var(--green-50)" },
    blue: { borderColor: "var(--blue)", background: "var(--blue-50)" },
  };
  const ts = toneStyle[tone];
  return (
    <div
      style={{
        ...ts,
        border: "1px solid",
        borderRadius: 10,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "var(--muted)",
          fontSize: 11.5,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {icon}
        <span>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: "var(--ink)" }}>{value ?? "…"}</div>
    </div>
  );
}
