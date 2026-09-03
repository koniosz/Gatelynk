"use client";
/**
 * Courier visits (FAZA d — 2026-06-02).
 *
 * Widoczne tylko gdy `features.delivery_to_door=true` (HOUSING_ESTATE etc).
 * Pokazuje stats dzisiaj + listę ostatnich wizyt z kodem, brand-em kuriera,
 * statusem i czasem rozwiązania.
 *
 * Endpointy:
 *   GET /building-admin/buildings/:id/courier-visits[?status=]
 *   GET /building-admin/buildings/:id/courier-visits/stats
 */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { useBuildingFeatures } from "@/components/ba-v2/BuildingFeaturesContext";
import { BUILDING_TZ } from "@/lib/building-time";

interface CourierVisitRow {
  id: number;
  code: string;
  courierBrand: string | null;
  targetUnitId: number | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: number | null;
  expiresAt: string;
}

interface CourierStats {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  expired: number;
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Oczekuje",
  ACCEPTED: "Wpuszczony",
  REJECTED: "Odrzucony",
  EXPIRED: "Wygasl",
};

const STATUS_COLOR: Record<string, { bg: string; fg: string; border: string }> = {
  PENDING: { bg: "#fef3c7", fg: "#92400e", border: "#fcd34d" },
  ACCEPTED: { bg: "#ecfdf5", fg: "#065f46", border: "#a7f3d0" },
  REJECTED: { bg: "#fef2f2", fg: "#b91c1c", border: "#fca5a5" },
  EXPIRED: { bg: "#f3f4f6", fg: "#6b7280", border: "#e5e7eb" },
};

export default function CourierVisitsPage() {
  const params = useParams();
  const id = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(id);
  const { features } = useBuildingFeatures();

  const [visits, setVisits] = useState<CourierVisitRow[]>([]);
  const [stats, setStats] = useState<CourierStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!features.delivery_to_door) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [visitsRes, statsRes] = await Promise.all([
          buildingAdminApi.get<CourierVisitRow[]>(`/building-admin/buildings/${buildingId}/courier-visits`),
          buildingAdminApi.get<CourierStats>(`/building-admin/buildings/${buildingId}/courier-visits/stats`),
        ]);
        if (cancelled) return;
        setVisits(visitsRes.data);
        setStats(statsRes.data);
      } catch (err: any) {
        if (!cancelled) setError(err?.response?.data?.message ?? err.message ?? "Blad ladowania");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildingId, features.delivery_to_door]);

  if (!features.delivery_to_door) {
    return (
      <div style={{ padding: 24, color: "var(--muted)" }}>
        Ta zakladka jest dostepna tylko dla obiektow z dostawami pod dom (HOUSING_ESTATE).
        Integrator moze wlaczyc ja w ustawieniach typu obiektu.
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <header>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: "var(--ink)" }}>
          Wizyty kurierow
        </h1>
        <p style={{ fontSize: 13, color: "var(--muted)", margin: "4px 0 0 0" }}>
          Kurierzy wpisuja 4-cyfrowy kod przy bramie. Mieszkancy otrzymuja push z opcja
          „Wpusc" / „Nie znam".
        </p>
      </header>

      {/* Stats dzisiaj */}
      {stats && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 12,
          }}
        >
          <StatCard label="Dzisiaj lacznie" value={stats.total} />
          <StatCard label="Oczekuje" value={stats.pending} color="#92400e" />
          <StatCard label="Wpuszczeni" value={stats.accepted} color="#065f46" />
          <StatCard label="Odrzuceni" value={stats.rejected} color="#b91c1c" />
          <StatCard label="Wygasle" value={stats.expired} color="#6b7280" />
        </div>
      )}

      {error && (
        <div style={{ padding: 12, background: "#fef2f2", color: "#b91c1c", borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
          Ladowanie…
        </div>
      ) : visits.length === 0 ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
          Brak wizyt kurierow.
        </div>
      ) : (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  background: "var(--bg-muted, rgba(0,0,0,0.03))",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                <th style={{ padding: "10px 14px" }}>Kod</th>
                <th style={{ padding: "10px 14px" }}>Kurier</th>
                <th style={{ padding: "10px 14px" }}>Status</th>
                <th style={{ padding: "10px 14px" }}>Czas</th>
                <th style={{ padding: "10px 14px" }}>Resolution</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => {
                const colors = STATUS_COLOR[v.status] ?? STATUS_COLOR.EXPIRED;
                const resolutionMs = v.resolvedAt
                  ? new Date(v.resolvedAt).getTime() - new Date(v.createdAt).getTime()
                  : null;
                return (
                  <tr key={v.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 14, fontWeight: 600 }}>
                      {v.code}
                    </td>
                    <td style={{ padding: "10px 14px" }}>{v.courierBrand ?? "—"}</td>
                    <td style={{ padding: "10px 14px" }}>
                      <span
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 4,
                          background: colors.bg,
                          color: colors.fg,
                          border: `1px solid ${colors.border}`,
                        }}
                      >
                        {STATUS_LABEL[v.status] ?? v.status}
                      </span>
                    </td>
                    <td style={{ padding: "10px 14px", color: "var(--muted)", fontSize: 12 }}>
                      {new Date(v.createdAt).toLocaleString("pl-PL", { timeZone: BUILDING_TZ, hour12: false })}
                    </td>
                    <td style={{ padding: "10px 14px", color: "var(--muted)", fontSize: 12 }}>
                      {v.resolvedBy ? (
                        <>
                          rezydent #{v.resolvedBy}
                          {resolutionMs != null && (
                            <span style={{ marginLeft: 6, color: "var(--muted-2, #9ca3af)" }}>
                              ({Math.round(resolutionMs / 1000)}s)
                            </span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 12,
      }}
    >
      <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: color ?? "var(--ink)" }}>
        {value}
      </div>
    </div>
  );
}
