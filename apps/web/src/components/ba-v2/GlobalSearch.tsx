"use client";
// Globalna wyszukiwarka (Topbar BA v2) — bez global-search endpointu, więc
// client-side: przy pierwszym focusie ładujemy równolegle residents/vehicles/
// units i cache-ujemy w state na czas sesji (nie re-fetch przy każdym znaku).
//
// Dropdown grupuje wyniki: Mieszkańcy / Pojazdy / Lokale (max 5 per grupa).
// Klik → router.push do odpowiedniej zakładki (mieszkaniec z deep-linkiem
// ?open=<rId>). Klawiatura: ↑/↓ + Enter; Esc / klik poza zamyka.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Car, Home, Search, Users } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";

interface Props {
  buildingId: number;
  placeholder: string;
}

// ── Surowe shape-y z BA api ──────────────────────────────────────────────────
interface RawResident {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  unitResidents?: { unit?: { number?: string | null } | null }[];
}
interface RawVehicle {
  id: number;
  licensePlate: string;
  make: string;
  model: string | null;
  resident: { firstName: string; lastName: string } | null;
  serviceName: string | null;
}
interface RawUnit {
  id: number;
  number: string;
  unitType?: { name?: string | null } | null;
}

// ── Znormalizowany wynik ──────────────────────────────────────────────────────
type ResultKind = "resident" | "vehicle" | "unit";
interface SearchResult {
  kind: ResultKind;
  id: number;
  primary: string;
  secondary: string;
  haystack: string; // lowercase, do matchowania
}

export function GlobalSearch({ buildingId, placeholder }: Props) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const [residents, setResidents] = useState<RawResident[] | null>(null);
  const [vehicles, setVehicles] = useState<RawVehicle[] | null>(null);
  const [units, setUnits] = useState<RawUnit[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const loadingRef = useRef(false);

  const rootRef = useRef<HTMLDivElement>(null);

  // Pierwszy focus → załaduj indeks raz (cache na sesję).
  const ensureLoaded = useCallback(async () => {
    if (loaded || loadingRef.current || !Number.isFinite(buildingId)) return;
    loadingRef.current = true;
    try {
      const [rRes, vRes, uRes] = await Promise.allSettled([
        buildingAdminApi.get<RawResident[]>(`/building-admin/buildings/${buildingId}/residents`),
        buildingAdminApi.get<RawVehicle[]>(`/building-admin/buildings/${buildingId}/vehicles`),
        buildingAdminApi.get<RawUnit[]>(`/building-admin/buildings/${buildingId}/units`),
      ]);
      if (rRes.status === "fulfilled") setResidents(rRes.value.data ?? []);
      if (vRes.status === "fulfilled") setVehicles(vRes.value.data ?? []);
      if (uRes.status === "fulfilled") setUnits(uRes.value.data ?? []);
      setLoaded(true);
    } finally {
      loadingRef.current = false;
    }
  }, [loaded, buildingId]);

  // Normalizacja do jednolitych SearchResult.
  const residentResults = useMemo<SearchResult[]>(() => {
    return (residents ?? []).map((r) => {
      const unit = r.unitResidents?.map((ur) => ur.unit?.number).filter(Boolean)[0];
      const name = `${r.firstName} ${r.lastName}`.trim();
      return {
        kind: "resident" as const,
        id: r.id,
        primary: name,
        secondary: unit ? `Lokal ${unit}` : r.email,
        haystack: `${name} ${r.email}`.toLowerCase(),
      };
    });
  }, [residents]);

  const vehicleResults = useMemo<SearchResult[]>(() => {
    return (vehicles ?? []).map((v) => {
      const owner = v.resident
        ? `${v.resident.firstName} ${v.resident.lastName}`.trim()
        : v.serviceName || "Pojazd serwisowy";
      return {
        kind: "vehicle" as const,
        id: v.id,
        primary: v.licensePlate,
        secondary: owner,
        haystack: `${v.licensePlate} ${owner} ${v.make ?? ""} ${v.model ?? ""}`.toLowerCase(),
      };
    });
  }, [vehicles]);

  const unitResults = useMemo<SearchResult[]>(() => {
    return (units ?? []).map((u) => ({
      kind: "unit" as const,
      id: u.id,
      primary: `Lokal ${u.number}`,
      secondary: u.unitType?.name ?? "",
      haystack: `${u.number} ${u.unitType?.name ?? ""}`.toLowerCase(),
    }));
  }, [units]);

  const term = q.trim().toLowerCase();

  // Match + cap 5 per grupa. Flat list (do nawigacji klawiaturą) zachowuje
  // kolejność grup: residents → vehicles → units.
  const groups = useMemo(() => {
    if (term.length === 0) return { residents: [], vehicles: [], units: [] };
    const m = (arr: SearchResult[]) => arr.filter((r) => r.haystack.includes(term)).slice(0, 5);
    return {
      residents: m(residentResults),
      vehicles: m(vehicleResults),
      units: m(unitResults),
    };
  }, [term, residentResults, vehicleResults, unitResults]);

  const flat = useMemo(
    () => [...groups.residents, ...groups.vehicles, ...groups.units],
    [groups],
  );

  const hasResults = flat.length > 0;
  const showDropdown = open && term.length > 0;

  // Reset podświetlenia gdy zmienia się lista wyników.
  useEffect(() => {
    setActiveIdx(0);
  }, [term]);

  const navigate = useCallback(
    (res: SearchResult) => {
      setOpen(false);
      setQ("");
      const base = `/building-admin/v2/buildings/${buildingId}`;
      if (res.kind === "resident") {
        router.push(`${base}/residents?open=${res.id}`);
      } else if (res.kind === "vehicle") {
        router.push(`${base}/vehicles`);
      } else {
        router.push(`${base}/units`);
      }
    },
    [router, buildingId],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (!showDropdown) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const sel = flat[activeIdx];
        if (sel) navigate(sel);
      }
    },
    [showDropdown, flat, activeIdx, navigate],
  );

  // Klik poza zamyka.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Renderer pojedynczej grupy. `offset` to indeks startowy w `flat`,
  // żeby podświetlenie klawiaturowe pasowało globalnie.
  const renderGroup = (
    title: string,
    Icon: typeof Users,
    items: SearchResult[],
    offset: number,
  ) => {
    if (items.length === 0) return null;
    return (
      <div style={{ padding: "6px 0" }}>
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            fontWeight: 700,
            color: "var(--muted)",
            padding: "4px 12px",
          }}
        >
          {title}
        </div>
        {items.map((res, i) => {
          const globalIdx = offset + i;
          const active = globalIdx === activeIdx;
          return (
            <button
              key={`${res.kind}-${res.id}`}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                navigate(res);
              }}
              onMouseEnter={() => setActiveIdx(globalIdx)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                textAlign: "left",
                padding: "8px 12px",
                border: 0,
                cursor: "pointer",
                background: active ? "var(--blue-50)" : "transparent",
              }}
            >
              <span style={{ color: active ? "var(--blue-600)" : "var(--muted)", display: "flex" }}>
                <Icon size={14} />
              </span>
              <span
                className={res.kind === "vehicle" ? "ba-mono" : undefined}
                style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}
              >
                {res.primary}
              </span>
              {res.secondary ? (
                <span style={{ fontSize: 12, color: "var(--muted)" }}>· {res.secondary}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div ref={rootRef} style={{ width: 320, position: "relative" }}>
      <div className="ba-search">
        <Search size={15} />
        <input
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            void ensureLoaded();
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {showDropdown ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-2)",
            boxShadow: "var(--shadow-2)",
            zIndex: 40,
            maxHeight: 420,
            overflowY: "auto",
          }}
        >
          {!loaded ? (
            <div style={{ padding: "14px 12px", fontSize: 12.5, color: "var(--muted)" }}>Ładowanie…</div>
          ) : !hasResults ? (
            <div style={{ padding: "14px 12px", fontSize: 12.5, color: "var(--muted)" }}>Brak wyników</div>
          ) : (
            <>
              {renderGroup("Mieszkańcy", Users, groups.residents, 0)}
              {renderGroup("Pojazdy", Car, groups.vehicles, groups.residents.length)}
              {renderGroup(
                "Lokale",
                Home,
                groups.units,
                groups.residents.length + groups.vehicles.length,
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
