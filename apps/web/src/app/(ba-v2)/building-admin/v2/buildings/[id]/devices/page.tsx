"use client";
// Devices tab — pełna migracja z legacy:
//   • (building-admin-dashboard)/.../devices/page.tsx — Edge / Intercom / Camera
//   • (building-admin-dashboard)/.../access-points/page.tsx — drag-drop sort APs
//
// Endpointy:
//   GET  /building-admin/buildings/:id/devices    → DevicesResponse
//   GET  /building-admin/buildings/:id/access-points
//   POST /building-admin/buildings/:id/devices/:edgeDeviceId/ping
//   POST /building-admin/buildings/:id/devices/:edgeDeviceId/restart (= REBOOT)
//   PATCH /building-admin/buildings/:id/access-points/reorder
//   PATCH /building-admin/buildings/:id/access-points/:apId
//
// 4 sekcje pionowe:
//   1. Edge hubs (z outbox badge-ami pending/failed)
//   2. Domofony Akuvox
//   3. Kamery LPR (Hikvision)
//   4. Punkty dostępu z drag-drop
//
// Polling co 15s (status online/offline + outbox count).
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Camera, Cpu, Phone } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { EdgeCard } from "./components/EdgeCard";
import { DeviceCard } from "./components/DeviceCard";
import { LprCameraCard } from "./components/LprCameraCard";
import { AccessPointList } from "./components/AccessPointList";
import type { AccessPoint, DevicesResponse } from "./components/types";
import { AkuvoxStationCard } from "@/components/AkuvoxStationCard";

export default function DevicesPage() {
  const params = useParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);

  const [data, setData] = useState<DevicesResponse | null>(null);
  // 2026-06-02 — accessPoints osobno żeby LprCameraCard mógł zaproponować
  // dropdown bez czekania na AccessPointList. AccessPointList nadal sam
  // ładuje + zapisuje (re-fetch po edit), tu tylko wystawiamy listę dla
  // kamer LPR.
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!Number.isFinite(buildingId)) return;
    Promise.all([
      buildingAdminApi.get<DevicesResponse>(`/building-admin/buildings/${buildingId}/devices`),
      buildingAdminApi
        .get<AccessPoint[]>(`/building-admin/buildings/${buildingId}/access-points`)
        .catch(() => ({ data: [] as AccessPoint[] })),
    ])
      .then(([devRes, apRes]) => {
        setData(devRes.data);
        setAccessPoints(apRes.data ?? []);
      })
      .catch((err: unknown) => {
        const e2 = err as { response?: { data?: { message?: string } } };
        setError(e2.response?.data?.message ?? "Błąd ładowania urządzeń");
      })
      .finally(() => setLoading(false));
  }, [buildingId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) {
    return (
      <div className="ba-panel">
        <div className="ba-empty">Ładowanie urządzeń…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ba-panel">
        <div className="ba-empty">
          <div className="ico">
            <Cpu size={22} />
          </div>
          <h4>Błąd</h4>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const edges = data?.edges ?? [];
  const intercoms = data?.intercoms ?? [];
  const cameras = data?.cameras ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Sekcja 1: Edge Hubs */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <Cpu size={16} />
            Edge Hubs
            <span className="pill">{edges.length}</span>
          </div>
        </div>
        {edges.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <Cpu size={22} />
            </div>
            <h4>Brak Edge Hubów</h4>
            <p>Aktywuj Edge na Mac Mini w sieci LAN obiektu, aby się tutaj pojawił.</p>
          </div>
        ) : (
          <div
            style={{
              padding: 14,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 12,
            }}
          >
            {edges.map((edge) => (
              <EdgeCard key={edge.id} edge={edge} buildingId={buildingId} onRefresh={load} />
            ))}
          </div>
        )}
      </div>

      {/* Sekcja 2: Domofony Akuvox */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <Phone size={16} />
            Domofony
            <span className="pill">{intercoms.length}</span>
          </div>
        </div>
        {intercoms.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <Phone size={22} />
            </div>
            <h4>Brak domofonów</h4>
            <p>Domofony Akuvox są wykrywane przez Edge w sieci LAN.</p>
          </div>
        ) : (
          <div
            style={{
              padding: 14,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 12,
            }}
          >
            {intercoms.map((d) => (
              <DeviceCard
                key={d.id}
                name={d.name}
                subtitle={d.model}
                ipAddress={d.ipAddress}
                online={d.online}
                icon={Phone}
                extras={d.model ? [{ label: "Model", value: d.model }] : undefined}
              />
            ))}
          </div>
        )}
      </div>

      {/* Sekcja 3: Kamery LPR */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <Camera size={16} />
            Kamery LPR
            <span className="pill">{cameras.length}</span>
          </div>
        </div>
        {cameras.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <Camera size={22} />
            </div>
            <h4>Brak kamer LPR</h4>
            <p>Kamery Hikvision DeepinView sparowane z Edge pojawią się tutaj.</p>
          </div>
        ) : (
          <div
            style={{
              padding: 14,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 12,
            }}
          >
            {cameras.map((d) => (
              <LprCameraCard
                key={d.id}
                camera={d}
                accessPoints={accessPoints}
                buildingId={buildingId}
                onSaved={load}
              />
            ))}
          </div>
        )}
      </div>

      {/* Sekcja 4: Punkty dostępu */}
      <AccessPointList buildingId={buildingId} />

      {/* Sekcja 5: Eksport listy mieszkańców do domofonu Akuvox */}
      <div style={{ marginTop: 16 }}>
        <AkuvoxStationCard
          api={buildingAdminApi}
          exportUrl={`/building-admin/buildings/${buildingId}/akuvox-userdata.tgz`}
        />
      </div>
    </div>
  );
}
