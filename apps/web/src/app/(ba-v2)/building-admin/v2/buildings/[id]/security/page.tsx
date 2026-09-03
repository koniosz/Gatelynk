"use client";
// Security tab — bucket: anomaly events (fall detection) + access events
// (LPR/PIN/REMOTE) + link do strony Vision (kamery).
//
// Anomaly section reuse-uje istniejący komponent <AnomalyEventsFeed> —
// jest już dopracowany i ma resolve/false-positive (Faza 3+4 fall detection).
// Wrap w nowym ba-panel żeby zharmonizować styl.
//
// Access events to mini-feed (ostatnie 50) — link „Wszystkie" wskazuje na
// stary panel concierge (`/concierge/building/access-events`) który ma pełne
// filtrowanie. W kolejnej iteracji można porzucić tę optikę i napisać własną
// stronę v2.
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Camera, DoorOpen, ScanLine, ShieldCheck } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { formatBuildingTime } from "@/lib/time";
import { AnomalyEventsFeed } from "@/components/AnomalyEventsFeed";

interface AccessEvent {
  id: string;
  ts: string;
  type: string;
  direction?: string | null;
  gateOpened?: boolean | null;
  reason?: string | null;
  plate?: string | null;
  residentName?: string | null;
  guestName?: string | null;
  accessPointLabel?: string | null;
  openedByName?: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  LPR_MATCH: "LPR — dopasowanie",
  LPR_NO_MATCH: "LPR — brak dopasowania",
  PIN_USED: "PIN gościa",
  REMOTE_OPEN: "Otwarcie zdalne",
  MANUAL_OPEN: "Otwarcie ręczne",
  INTERCOM_CALL: "Wezwanie domofonu",
};

export default function SecurityPage() {
  const params = useParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);

  const [events, setEvents] = useState<AccessEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!Number.isFinite(buildingId)) return;
    setLoading(true);
    try {
      const r = await buildingAdminApi.get<AccessEvent[]>(
        `/building-admin/buildings/${buildingId}/access-events?limit=50`,
      );
      setEvents(Array.isArray(r.data) ? r.data : []);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [buildingId]);

  useEffect(() => {
    void load();
    // polling co 30s zgodnie z MVP-decyzją z handoff §8
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Quick-links do dedykowanych podstron — kamery (vision), LPR reads. */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <ShieldCheck size={16} />
            Bezpieczeństwo
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1, background: "var(--border)" }}>
          <Link
            href={`/building-admin/buildings/${buildingId}/vision`}
            className="ba-row"
            style={{ background: "var(--surface)", gridTemplateColumns: "32px 1fr auto" }}
          >
            <div className="ba-av" style={{ background: "var(--blue-50)", color: "var(--blue-600)" }}>
              <Camera size={14} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Wizja kamer</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Detekcje YOLO, snapshoty, OCR kurierów</div>
            </div>
            <ArrowRight size={14} style={{ color: "var(--muted)" }} />
          </Link>
          <Link
            href={`/building-admin/buildings/${buildingId}/lpr-reads`}
            className="ba-row"
            style={{ background: "var(--surface)", gridTemplateColumns: "32px 1fr auto" }}
          >
            <div className="ba-av" style={{ background: "var(--amber-50)", color: "var(--amber)" }}>
              <ScanLine size={14} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Odczyty tablic (LPR)</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Pełna historia + klasyfikacja kuriera</div>
            </div>
            <ArrowRight size={14} style={{ color: "var(--muted)" }} />
          </Link>
          <Link
            href={`/building-admin/buildings/${buildingId}/anomaly-events`}
            className="ba-row"
            style={{ background: "var(--surface)", gridTemplateColumns: "32px 1fr auto" }}
          >
            <div className="ba-av" style={{ background: "var(--red-50)", color: "var(--red)" }}>
              <ShieldCheck size={14} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>Alerty anomalii</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>Fall detection — pełen widok</div>
            </div>
            <ArrowRight size={14} style={{ color: "var(--muted)" }} />
          </Link>
        </div>
      </div>

      {/* Anomaly events — inline embed pełnego feed-a z istniejącego komponentu. */}
      <div className="ba-panel" style={{ padding: 0 }}>
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <ShieldCheck size={16} />
            Alerty bezpieczeństwa
          </div>
        </div>
        <div style={{ padding: 16, background: "var(--surface-2)" }}>
          {/* AnomalyEventsFeed jest z Tailwind-em z starego designu — pakujemy go
              w container z background-em żeby się nie kłócił z palettą BA v2. */}
          <AnomalyEventsFeed
            apiClient={buildingAdminApi}
            listPath={`/building-admin/buildings/${buildingId}/anomaly-events`}
            itemPath={(id) => `/building-admin/anomaly-events/${id}`}
            canResolve
          />
        </div>
      </div>

      {/* Access events — mini feed. */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <DoorOpen size={16} />
            Ostatnia aktywność na bramach
            <span className="pill">{events.length}</span>
          </div>
        </div>
        {loading ? (
          <div className="ba-empty">Ładowanie…</div>
        ) : events.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <DoorOpen size={22} />
            </div>
            <h4>Brak zdarzeń</h4>
            <p>Otwarcia bram pojawią się tutaj.</p>
          </div>
        ) : (
          <div>
            {events.slice(0, 30).map((ev) => (
              <div
                key={ev.id}
                className="ba-row"
                style={{ gridTemplateColumns: "32px 1.6fr 1fr auto", cursor: "default" }}
              >
                <div
                  className="ba-av"
                  style={{
                    background: ev.gateOpened ? "var(--green-50)" : "var(--bg-2)",
                    color: ev.gateOpened ? "var(--green)" : "var(--muted)",
                  }}
                >
                  <DoorOpen size={14} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                    {TYPE_LABEL[ev.type] ?? ev.type}
                    {ev.plate ? (
                      <>
                        {" · "}
                        <span className="ba-mono">{ev.plate}</span>
                      </>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {[
                      ev.accessPointLabel,
                      ev.residentName ?? ev.guestName,
                      ev.openedByName,
                      ev.reason,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  <span className={`ba-pill ${ev.gateOpened ? "green" : ""}`}>
                    {ev.gateOpened ? "Otwarto" : "Audyt"}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted-2)" }}>
                  {formatBuildingTime(ev.ts, "short")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
