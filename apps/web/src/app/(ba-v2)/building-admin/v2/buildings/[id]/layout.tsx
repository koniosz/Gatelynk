"use client";
// Layout per-budynek dla BA v2. Ten plik:
//  - sprawdza auth (gdy brak `gl_ba_token` lub 401 z /buildings/:id, redirect
//    do /building-admin/login)
//  - pobiera dane building-a + listę building-ów (dla switcher-a)
//  - pobiera counts dla TabBar
//  - renderuje AppShell wokół children (each tab)
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { AppShell } from "@/components/ba-v2/AppShell";
import type { BuildingLite } from "@/components/ba-v2/PropertyHeader";
import {
  BuildingFeaturesProvider,
  normalizeFeatures,
  normalizeFeaturePermissions,
  normalizeObjectType,
  type BuildingFeatures,
  type FeaturePermissions,
  type ObjectType,
} from "@/components/ba-v2/BuildingFeaturesContext";

interface RawBuilding {
  id: number;
  name: string;
  address?: string | null;
  district?: string | null;
  // FAZA b (2026-06-02) — Universal object types
  objectType?: string | null;
  features?: unknown;
  // FAZA e (2026-06-02) — spłaszczone permissions dla BA roli.
  featurePermissions?: unknown;
  _count?: { residents?: number; units?: number };
  stairwells?: unknown[];
}

interface CountsState {
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

export default function BaV2BuildingLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const router = useRouter();
  const idParam = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idParam);

  const [building, setBuilding] = useState<BuildingLite | null>(null);
  const [buildings, setBuildings] = useState<BuildingLite[]>([]);
  const [counts, setCounts] = useState<CountsState>({});
  const [me, setMe] = useState<{ initials: string; name: string } | undefined>(undefined);
  const [objectType, setObjectType] = useState<ObjectType>("BUILDING");
  const [features, setFeatures] = useState<BuildingFeatures>(() => normalizeFeatures(null));
  const [featurePermissions, setFeaturePermissions] = useState<FeaturePermissions>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isFinite(buildingId) || buildingId <= 0) {
      setErr("Nieprawidłowy ID budynku");
      setLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const [bRes, listRes] = await Promise.all([
          buildingAdminApi.get<RawBuilding>(`/building-admin/buildings/${buildingId}`),
          buildingAdminApi.get<RawBuilding[]>(`/building-admin/buildings`).catch(() => ({ data: [] as RawBuilding[] })),
        ]);
        if (cancelled) return;

        const b = bRes.data;
        const lite: BuildingLite = {
          id: b.id,
          name: b.name,
          address: b.address ?? undefined,
          district: b.district ?? undefined,
        };
        setBuilding(lite);
        // FAZA b — Universal object types. Backend zwraca już znormalizowane
        // `objectType` + `features` (patrz BuildingAdminService.getBuilding).
        // Defaulty per typ w `BuildingFeaturesContext` zostają jako fallback.
        const ot = normalizeObjectType(b.objectType);
        setObjectType(ot);
        setFeatures(normalizeFeatures(b.features));
        setFeaturePermissions(normalizeFeaturePermissions(b.featurePermissions));
        setBuildings(
          (listRes.data ?? []).map((x) => ({
            id: x.id,
            name: x.name,
            address: x.address ?? undefined,
          })),
        );

        // Counts — best-effort, każdy endpoint może nie odpowiedzieć.
        // Wszystko fire-and-forget, error w jednym nie psuje pozostałych.
        const settled = await Promise.allSettled([
          buildingAdminApi.get(`/building-admin/buildings/${buildingId}/residents`),
          buildingAdminApi.get(`/building-admin/buildings/${buildingId}/units`),
          buildingAdminApi.get(`/building-admin/buildings/${buildingId}/vehicles`),
          buildingAdminApi.get(`/building-admin/buildings/${buildingId}/guests`),
          buildingAdminApi.get(`/building-admin/buildings/${buildingId}/tickets`),
          buildingAdminApi.get(`/building-admin/buildings/${buildingId}/devices`).catch(() => null),
          // FAZA polish (a) — courier visits pending counter
          buildingAdminApi
            .get<{ pending?: number }>(`/building-admin/buildings/${buildingId}/courier-visits/stats`)
            .catch(() => null),
        ]);
        if (cancelled) return;
        const len = (i: number) => {
          const r = settled[i];
          if (r?.status === "fulfilled") {
            const d = (r.value as { data?: unknown })?.data;
            return Array.isArray(d) ? d.length : undefined;
          }
          return undefined;
        };
        const courierStats = settled[6];
        let courierPending: number | undefined;
        if (courierStats?.status === "fulfilled") {
          const d = (courierStats.value as { data?: { pending?: number } } | null)?.data;
          if (d && typeof d.pending === "number") courierPending = d.pending;
        }
        // Devices endpoint zwraca obiekt z 3 listami — nie liczymy do TabBar w MVP
        setCounts({
          residents: len(0),
          units: len(1),
          vehicles: len(2),
          guests: len(3),
          issues: len(4),
          courierVisits: courierPending,
        });

        // User-info z /me — endpoint zwraca { id, name, email, buildingIds }.
        // Best-effort: gdy padnie, zostawiamy fallback "BA" żeby UI się nie wywalił.
        try {
          const meRes = await buildingAdminApi.get<{ id: number; name: string; email: string }>(
            "/building-admin/me",
          );
          if (cancelled) return;
          const fullName = meRes.data.name?.trim() || meRes.data.email || "Admin";
          const initials = fullName
            .split(/\s+/)
            .map((w) => w[0]?.toUpperCase() ?? "")
            .slice(0, 2)
            .join("") || "BA";
          setMe({ initials, name: fullName });
        } catch {
          setMe({ initials: "BA", name: "Administrator" });
        }
      } catch (e: unknown) {
        const errObj = e as { response?: { status?: number }; message?: string };
        if (errObj.response?.status === 401) {
          router.push("/building-admin/login");
          return;
        }
        setErr(errObj.message ?? "Nie udało się pobrać danych budynku");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [buildingId, router]);

  if (loading) {
    return (
      <div
        className="ba-v2"
        style={{ display: "grid", placeItems: "center", minHeight: "100vh", color: "var(--muted)" }}
      >
        Ładowanie panelu…
      </div>
    );
  }
  if (err || !building) {
    return (
      <div
        className="ba-v2"
        style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 24, color: "var(--red)" }}
      >
        {err ?? "Błąd"}
      </div>
    );
  }

  return (
    <BuildingFeaturesProvider
      objectType={objectType}
      features={features}
      featurePermissions={featurePermissions}
    >
      <AppShell
        building={building}
        buildings={buildings.length > 0 ? buildings : undefined}
        counts={counts}
        me={me}
        objectType={objectType}
      >
        {children}
      </AppShell>
    </BuildingFeaturesProvider>
  );
}
