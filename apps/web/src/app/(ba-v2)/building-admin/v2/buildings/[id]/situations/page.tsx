"use client";
/**
 * Zdarzenia sytuacyjne — BA v2 (2026-08-26).
 *
 * Feed z korelatora Edge (`situation_events`): tailgating, krążący pojazd,
 * osoba w nocy, pojazd czekający, wizyty kurierów, potwierdzone upadki —
 * SEKWENCJE sklejone ze zdjęciami dowodowymi, nie surowe klatki (od tego
 * jest zakładka Wizja AI). Na górze „Kronika dnia" — ta sama treść, którą
 * mieszkańcy dostają pushem o 21:00 (+ narracja Bielika ładowana w tle,
 * bo potrafi mielić ~20 s).
 *
 * Dane: GET /building-admin/buildings/:id/situations (proxy → Edge) i
 * GET /building-admin/buildings/:id/chronicle. Zdjęcia dowodowe przez
 * istniejące proxy /vision/frame/:filename (LazyLprThumbnail — semafor
 * + IntersectionObserver). Feature gate: `vision_dashboard` (jak Wizja AI).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Activity, BookOpen, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { LazyLprThumbnail } from "@/components/LazyLprThumbnail";
import { useBuildingFeatures } from "@/components/ba-v2/BuildingFeaturesContext";

interface SituationEvent {
  id: number;
  type: string;
  cameraDeviceId: string | null;
  startedTs: number;
  endedTs: number | null;
  confidence: string;
  title: string;
  /** VLM-detektyw (2026-09-01): jedno zdanie „co widać na kadrze". */
  vlmNote?: string | null;
  details: Record<string, unknown> | null;
  evidenceImages?: string[];
}

interface Chronicle {
  date: string | null;
  lines: string[];
  narrative: string | null;
  push_text: string | null;
}

const TYPE_META: Record<string, { icon: string; label: string }> = {
  FALL_CONFIRMED: { icon: "⚠️", label: "Upadek" },
  TAILGATING: { icon: "🚧", label: "Na ogonie" },
  VEHICLE_LOITERING: { icon: "🕵️", label: "Krążący pojazd" },
  NIGHT_PERSON: { icon: "🌙", label: "Osoba w nocy" },
  VEHICLE_WAITING: { icon: "⏳", label: "Pojazd czeka" },
  COURIER_VISIT: { icon: "📦", label: "Kurier / dostawa" },
};

const RANGES: Array<{ key: string; hours: number; label: string }> = [
  { key: "24h", hours: 24, label: "24 h" },
  { key: "3d", hours: 72, label: "3 dni" },
  { key: "7d", hours: 168, label: "7 dni" },
];

// Czas OSIEDLA (Edge/kamery), nie przeglądarki — tytuły zdarzeń Edge generuje
// w Europe/Warsaw, więc etykiety czasu muszą używać tej samej strefy, inaczej
// przy przeglądaniu z innej strefy godziny w wierszu się rozjeżdżają.
const ESTATE_TZ = "Europe/Warsaw";

/** YYYY-MM-DD w strefie osiedla — do porównania „dziś/wczoraj". */
function estateDayKey(ts: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ESTATE_TZ }).format(new Date(ts));
}

function eventWhen(startedTs: number, endedTs: number | null): string {
  const hm = (t: number) =>
    new Date(t).toLocaleTimeString("pl-PL", {
      timeZone: ESTATE_TZ,
      hour: "2-digit",
      minute: "2-digit",
    });
  const evKey = estateDayKey(startedTs);
  const dayPrefix =
    evKey === estateDayKey(Date.now())
      ? "dziś"
      : evKey === estateDayKey(Date.now() - 86_400_000)
        ? "wczoraj"
        : new Date(startedTs).toLocaleDateString("pl-PL", {
            timeZone: ESTATE_TZ,
            day: "numeric",
            month: "numeric",
          });
  const range =
    endedTs && endedTs - startedTs >= 60_000
      ? `${hm(startedTs)}–${hm(endedTs)}`
      : hm(startedTs);
  return `${dayPrefix} ${range}`;
}

interface LightboxState {
  images: string[];
  index: number;
  title: string;
  when: string;
}

/**
 * Pełnoekranowy podgląd kadru dowodowego (wzorzec z Wizji AI: blob przez
 * axios z Bearer-em → objectURL; Escape/klik-tło zamyka). Przy kilku kadrach
 * jednego zdarzenia strzałki ‹ › + klawisze ←/→ przełączają.
 */
function EvidenceLightbox({
  buildingId,
  state,
  onNavigate,
  onClose,
}: {
  buildingId: number;
  state: LightboxState;
  onNavigate: (index: number) => void;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const img = state.images[state.index];
  const many = state.images.length > 1;

  useEffect(() => {
    setSrc(null);
    setFailed(false);
    let cancelled = false;
    let objectUrl: string | null = null;
    buildingAdminApi
      .get(
        `/building-admin/buildings/${buildingId}/vision/frame/${encodeURIComponent(img)}`,
        { responseType: "blob" },
      )
      .then((res) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data as Blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [buildingId, img]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (many && e.key === "ArrowLeft")
        onNavigate((state.index - 1 + state.images.length) % state.images.length);
      if (many && e.key === "ArrowRight") onNavigate((state.index + 1) % state.images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate, many, state.index, state.images.length]);

  const navBtn = (dir: -1 | 1) => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onNavigate((state.index + dir + state.images.length) % state.images.length);
      }}
      aria-label={dir === -1 ? "Poprzedni kadr" : "Następny kadr"}
      style={{
        background: "rgba(255,255,255,0.14)",
        border: "1px solid rgba(255,255,255,0.35)",
        color: "#fff",
        borderRadius: 999,
        width: 40,
        height: 40,
        display: "grid",
        placeItems: "center",
        cursor: "pointer",
      }}
    >
      {dir === -1 ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
    </button>
  );

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        background: "rgba(10, 12, 16, 0.82)",
        display: "grid",
        placeItems: "center",
        padding: 24,
        cursor: "zoom-out",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          maxWidth: "min(94vw, 1200px)",
        }}
      >
        {many ? navBtn(-1) : null}
        <div style={{ display: "grid", gap: 10, justifyItems: "center", minWidth: 0 }}>
          {failed ? (
            <div style={{ color: "#fff", fontSize: 14, padding: 40 }}>
              Nie udało się załadować zdjęcia.
            </div>
          ) : src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={state.title}
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: "100%",
                maxHeight: "78vh",
                borderRadius: 12,
                boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
                cursor: "default",
              }}
            />
          ) : (
            <div style={{ color: "#fff", fontSize: 14, padding: 40 }}>Ładowanie zdjęcia…</div>
          )}
          <div
            style={{
              color: "#fff",
              fontSize: 13.5,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              justifyContent: "center",
              textAlign: "center",
            }}
          >
            <span>
              {state.title} · {state.when}
              {many ? ` · kadr ${state.index + 1}/${state.images.length}` : ""}
            </span>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "rgba(255,255,255,0.14)",
                border: "1px solid rgba(255,255,255,0.35)",
                color: "#fff",
                borderRadius: 999,
                padding: "6px 14px",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Zamknij
            </button>
          </div>
        </div>
        {many ? navBtn(1) : null}
      </div>
    </div>
  );
}

export default function SituationsPage() {
  const params = useParams<{ id: string }>();
  const buildingId = Number(params?.id);
  const { hasBaFeature } = useBuildingFeatures();

  const [events, setEvents] = useState<SituationEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState("24h");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [chronicle, setChronicle] = useState<Chronicle | null>(null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  const hours = RANGES.find((r) => r.key === range)?.hours ?? 24;

  const loadEvents = useCallback(
    (silent = false) => {
      if (!Number.isFinite(buildingId) || buildingId <= 0) return;
      if (!silent) setLoading(true);
      buildingAdminApi
        .get<{ events: SituationEvent[] }>(
          `/building-admin/buildings/${buildingId}/situations?since_hours=${hours}&limit=200`,
        )
        .then((res) => {
          setEvents(res.data.events ?? []);
          setError(null);
        })
        .catch((err) => {
          if (err?.response?.status !== 401)
            setError(err?.response?.data?.message ?? "Nie udało się pobrać zdarzeń");
        })
        .finally(() => setLoading(false));
    },
    [buildingId, hours],
  );

  // Kronika: najpierw szybkie fakty (smart=0), potem narracja Bielika w tle.
  const loadChronicle = useCallback(() => {
    if (!Number.isFinite(buildingId) || buildingId <= 0) return;
    buildingAdminApi
      .get<Chronicle>(`/building-admin/buildings/${buildingId}/chronicle?smart=0`)
      .then((res) => {
        setChronicle(res.data);
        setNarrativeLoading(true);
        return buildingAdminApi.get<Chronicle>(
          `/building-admin/buildings/${buildingId}/chronicle?smart=1`,
        );
      })
      .then((res) => {
        if (res?.data?.narrative) setChronicle(res.data);
      })
      .catch(() => undefined)
      .finally(() => setNarrativeLoading(false));
  }, [buildingId]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);
  useEffect(() => {
    loadChronicle();
  }, [loadChronicle]);

  // Cichy refresh feedu co 60 s (tick korelatora na Edge też ma 60 s).
  useEffect(() => {
    const t = setInterval(() => loadEvents(true), 60_000);
    return () => clearInterval(t);
  }, [loadEvents]);

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.type, (m.get(e.type) ?? 0) + 1);
    return m;
  }, [events]);

  const visible = useMemo(
    () => (typeFilter === "all" ? events : events.filter((e) => e.type === typeFilter)),
    [events, typeFilter],
  );

  if (!hasBaFeature("vision_dashboard")) {
    return (
      <div style={{ padding: 24, color: "var(--muted)" }}>
        Ta zakładka jest niedostępna — integrator wyłączył panel wizji
        (vision_dashboard) dla tego obiektu.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* ── Kronika dnia ── */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <BookOpen size={16} />
            Kronika dnia
            {chronicle?.date ? <span className="pill">{chronicle.date}</span> : null}
          </div>
          {narrativeLoading ? (
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
              AI układa narrację…
            </span>
          ) : null}
        </div>
        <div style={{ padding: "12px 16px", display: "grid", gap: 8 }}>
          {chronicle?.narrative ? (
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "var(--ink)" }}>
              {chronicle.narrative}
            </p>
          ) : null}
          {(chronicle?.lines ?? []).length ? (
            <div style={{ display: "grid", gap: 4 }}>
              {chronicle!.lines.map((line, i) => (
                <div key={i} style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
                  {line}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
              {chronicle ? "Dziś jeszcze spokojnie — brak zdarzeń." : "Ładowanie kroniki…"}
            </div>
          )}
        </div>
      </div>

      {/* ── Feed zdarzeń ── */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <Activity size={16} />
            Zdarzenia sytuacyjne
            <span className="pill">{events.length}</span>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className="ba-btn sm"
                style={
                  range === r.key
                    ? {
                        background: "var(--blue-50)",
                        color: "var(--blue-600)",
                        borderColor: "var(--blue)",
                        fontWeight: 600,
                      }
                    : undefined
                }
              >
                {r.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                loadEvents();
                loadChronicle();
              }}
              className="ba-btn sm"
              aria-label="Odśwież"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        {/* Filtry typów */}
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
          <button
            type="button"
            onClick={() => setTypeFilter("all")}
            className="ba-btn sm"
            style={
              typeFilter === "all"
                ? {
                    background: "var(--blue-50)",
                    color: "var(--blue-600)",
                    borderColor: "var(--blue)",
                    fontWeight: 600,
                  }
                : undefined
            }
          >
            Wszystkie
          </button>
          {Object.entries(TYPE_META).map(([type, meta]) => {
            const count = typeCounts.get(type) ?? 0;
            if (count === 0) return null;
            const active = typeFilter === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => setTypeFilter(active ? "all" : type)}
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
                {meta.icon} {meta.label} ({count})
              </button>
            );
          })}
        </div>

        {/* Lista */}
        <div style={{ display: "grid", gap: 0 }}>
          {loading ? (
            <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>Ładowanie…</div>
          ) : error ? (
            <div style={{ padding: 24, color: "var(--red, #d33)", fontSize: 13 }}>{error}</div>
          ) : visible.length === 0 ? (
            <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>
              Brak zdarzeń w wybranym oknie — spokojnie na osiedlu. Korelator
              analizuje klatki i przejazdy co 60 s.
            </div>
          ) : (
            visible.map((e) => {
              const meta = TYPE_META[e.type] ?? { icon: "•", label: e.type };
              return (
                <div
                  key={e.id}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-start",
                    padding: "12px 16px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={{ fontSize: 22, lineHeight: "28px" }}>{meta.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "baseline",
                        flexWrap: "wrap",
                      }}
                    >
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                        {meta.label}
                      </span>
                      <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                        {eventWhen(e.startedTs, e.endedTs)}
                      </span>
                      {e.confidence === "INFERRED" ? (
                        <span
                          style={{
                            fontSize: 10.5,
                            color: "var(--muted)",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "1px 6px",
                          }}
                          title="Zdarzenie wywnioskowane z sekwencji — nie bezpośrednia obserwacja"
                        >
                          interpretacja
                        </span>
                      ) : null}
                    </div>
                    <div style={{ fontSize: 13.5, color: "var(--ink)", marginTop: 2, lineHeight: 1.45 }}>
                      {e.title}
                    </div>
                    {e.vlmNote ? (
                      <div
                        style={{
                          fontSize: 12.5,
                          color: "var(--muted)",
                          marginTop: 4,
                          lineHeight: 1.45,
                          fontStyle: "italic",
                        }}
                      >
                        🔎 {e.vlmNote}
                      </div>
                    ) : null}
                    {e.evidenceImages && e.evidenceImages.length > 0 ? (
                      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                        {e.evidenceImages.map((img, i) => (
                          <LazyLprThumbnail
                            key={img}
                            apiClient={buildingAdminApi}
                            url={`/building-admin/buildings/${buildingId}/vision/frame/${encodeURIComponent(img)}`}
                            alt="Kadr dowodowy — kliknij, aby powiększyć"
                            onClick={() =>
                              setLightbox({
                                images: e.evidenceImages!,
                                index: i,
                                title: `${meta.icon} ${meta.label}`,
                                when: eventWhen(e.startedTs, e.endedTs),
                              })
                            }
                            style={{
                              width: 96,
                              height: 64,
                              objectFit: "cover",
                              borderRadius: 8,
                              border: "1px solid var(--border)",
                              cursor: "zoom-in",
                            }}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {lightbox ? (
        <EvidenceLightbox
          buildingId={buildingId}
          state={lightbox}
          onNavigate={(index) => setLightbox((prev) => (prev ? { ...prev, index } : prev))}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}
