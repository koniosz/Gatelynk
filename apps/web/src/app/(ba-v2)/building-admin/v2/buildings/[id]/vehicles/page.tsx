"use client";
// Vehicles tab — kafelki-kategorie (Wszystkie aktywne / Mieszkańcy / Kurierzy /
// Śmieciarki / Inne usługi / Goście / Zablokowane), drawer szczegółów z pełną
// edycją danych pojazdu (PATCH /vehicles/:id), bulk approve/reject, search.
// Kategoria pojazdu jest wyliczana z kind + serviceName/tags (heurystyka —
// backend nie ma pola "kategoria"; np. śmieciarka to SERVICE z serviceName
// "MPO"/"Remondis" albo tagiem "wywóz odpadów").
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CarFront,
  Check,
  CheckSquare,
  CircleDashed,
  History,
  Package,
  Pencil,
  Plus,
  Search,
  ShieldOff,
  Siren,
  Square,
  Trash2,
  Truck,
  UserRound,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { ResidentDrawer } from "@/components/ba-v2/ResidentDrawer";
import { TagPicker } from "@/components/TagPicker";
import { LazyLprThumbnail } from "@/components/LazyLprThumbnail";
import { BUILDING_TZ } from "@/lib/building-time";
import { formatUnitLabel } from "@/lib/unit-label";

type VehicleStatus = "PENDING" | "APPROVED" | "REJECTED" | "BLOCKED" | "EXPIRED";
type VehicleKind = "RESIDENT" | "SERVICE" | "DELIVERY" | "EMERGENCY" | "PUBLIC";

interface Vehicle {
  id: number;
  licensePlate: string;
  make?: string | null;
  model?: string | null;
  color?: string | null;
  status?: VehicleStatus | null;
  rejectionReason?: string | null;
  resident?: { id: number; firstName: string; lastName: string } | null;
  residentId?: number | null;
  // 2026-09-07 — lokal przypisany WPROST do pojazdu (obok/zamiast mieszkańca).
  unitId?: number | null;
  unit?: { id: number; number: string; label?: string | null } | null;
  kind?: VehicleKind | null;
  serviceName?: string | null;
  notes?: string | null;
  validTo?: string | null;
  tags?: string[];
  // Ręcznie dodane zdjęcie pojazdu (data URI, jak avatary) — może być null.
  photo?: string | null;
}

interface Resident {
  id: number;
  firstName: string;
  lastName: string;
}

/** Lokal do pickera (GET /units zwraca pełny obiekt — bierzemy minimum). */
interface UnitLite {
  id: number;
  number: string;
  street?: string | null;
  stairwell?: { name: string } | null;
}

interface GuestLite {
  id: number;
  name: string;
  vehiclePlate?: string | null;
  status: string;
  validFrom: string;
  validTo: string;
  resident?: { id: number; firstName: string; lastName: string } | null;
}

const STATUS_LABEL: Record<VehicleStatus, { label: string; tone: "amber" | "green" | "red" | "default" }> = {
  PENDING: { label: "Oczekuje", tone: "amber" },
  APPROVED: { label: "Aktywny", tone: "green" },
  REJECTED: { label: "Odrzucony", tone: "red" },
  BLOCKED: { label: "Zablokowany", tone: "red" },
  EXPIRED: { label: "Wygasł", tone: "default" },
};
const STATUS_SORT: Record<VehicleStatus, number> = {
  PENDING: 0,
  BLOCKED: 1,
  APPROVED: 2,
  REJECTED: 3,
  EXPIRED: 4,
};

const KIND_LABEL: Record<VehicleKind, string> = {
  RESIDENT: "Mieszkaniec",
  SERVICE: "Usługa / serwis",
  DELIVERY: "Kurier / dostawa",
  EMERGENCY: "Służby ratunkowe",
  PUBLIC: "Komunalny / publiczny",
};

// ── Kategoryzacja pojazdu do kafelków ───────────────────────────────────────
// Śmieciarka/kurier bywa w bazie jako kind=SERVICE (np. serviceName "DHL",
// "MPO"), więc dopasowanie po nazwie firmy i tagach ma pierwszeństwo przed
// samym kind. Dla kind=RESIDENT nie zgadujemy — to zawsze auto mieszkańca.
type VehicleCategory = "RESIDENT" | "COURIER" | "WASTE" | "EMERGENCY" | "OTHER";

const WASTE_RE =
  /(śmiec|smiec|odpad|wywóz|wywoz|komunal|\bmpo\b|remondis|suez|veolia|eneris|fbserwis|lekaro|jarper|tonsmeier|czyst)/i;
const COURIER_RE =
  /(kurier|dostaw|paczk|\bdpd\b|\bdhl\b|inpost|\bgls\b|\bups\b|fedex|glovo|wolt|uber eats|bolt food|pyszne|poczta|allegro)/i;
const EMERGENCY_RE =
  /(policj|straż|straz pożarna|straz pozarna|pogotow|ambulans|karetka|ratownic|ratunk)/i;

function categoryOf(v: Vehicle): VehicleCategory {
  if ((v.kind ?? "RESIDENT") === "RESIDENT") return "RESIDENT";
  const hay = [v.serviceName ?? "", ...(v.tags ?? [])].join(" ");
  if (v.kind === "EMERGENCY" || EMERGENCY_RE.test(hay)) return "EMERGENCY";
  if (WASTE_RE.test(hay)) return "WASTE";
  if (v.kind === "DELIVERY" || COURIER_RE.test(hay)) return "COURIER";
  return "OTHER";
}

type Filter =
  | "ACTIVE"
  | "PENDING"
  | "RESIDENT"
  | "COURIER"
  | "WASTE"
  | "EMERGENCY"
  | "OTHER"
  | "GUESTS"
  | "BLOCKED";

export default function VehiclesPage() {
  const params = useParams();
  const router = useRouter();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [units, setUnits] = useState<UnitLite[]>([]);
  const [guests, setGuests] = useState<GuestLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState<Filter>("ACTIVE");

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  // Drawer szczegółów/edycji
  const [sel, setSel] = useState<Vehicle | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isFinite(buildingId)) return;
    setLoading(true);
    try {
      const [vRes, rRes, gRes, uRes] = await Promise.all([
        buildingAdminApi.get<Vehicle[]>(`/building-admin/buildings/${buildingId}/vehicles`),
        buildingAdminApi.get<Resident[]>(`/building-admin/buildings/${buildingId}/residents`),
        buildingAdminApi
          .get<GuestLite[]>(`/building-admin/buildings/${buildingId}/guests`)
          .catch(() => ({ data: [] as GuestLite[] })),
        buildingAdminApi
          .get<UnitLite[]>(`/building-admin/buildings/${buildingId}/units`)
          .catch(() => ({ data: [] as UnitLite[] })),
      ]);
      setVehicles(vRes.data);
      setResidents(rRes.data);
      setGuests(gRes.data);
      setUnits(uRes.data);
      return vRes.data;
    } finally {
      setLoading(false);
    }
  }, [buildingId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Aktywni goście z tablicą — kafelek „Goście". Zarządzanie gośćmi zostaje
  // w zakładce Goście; tu tylko podgląd „jakie obce auta mają dziś wjazd".
  const guestCars = useMemo(
    () => guests.filter((g) => g.status === "ACTIVE" && (g.vehiclePlate ?? "").trim()),
    [guests],
  );

  const counts = useMemo(() => {
    const c = { ACTIVE: 0, PENDING: 0, RESIDENT: 0, COURIER: 0, WASTE: 0, EMERGENCY: 0, OTHER: 0, BLOCKED: 0 };
    for (const v of vehicles) {
      const s = (v.status ?? "APPROVED") as VehicleStatus;
      if (s === "APPROVED" || s === "PENDING") c.ACTIVE += 1;
      if (s === "PENDING") c.PENDING += 1;
      if (s === "BLOCKED" || s === "REJECTED" || s === "EXPIRED") c.BLOCKED += 1;
      c[categoryOf(v)] += 1;
    }
    return c;
  }, [vehicles]);

  const matchesFilter = useCallback((v: Vehicle, f: Filter): boolean => {
    const s = (v.status ?? "APPROVED") as VehicleStatus;
    switch (f) {
      case "ACTIVE":
        return s === "APPROVED" || s === "PENDING";
      case "PENDING":
        return s === "PENDING";
      case "BLOCKED":
        return s === "BLOCKED" || s === "REJECTED" || s === "EXPIRED";
      case "GUESTS":
        return false; // goście renderowani osobno
      default:
        return categoryOf(v) === f;
    }
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vehicles.filter((v) => {
      if (!matchesFilter(v, filter)) return false;
      if (!q) return true;
      const haystack = [
        v.licensePlate,
        v.make ?? "",
        v.model ?? "",
        v.color ?? "",
        v.serviceName ?? "",
        v.resident ? `${v.resident.firstName} ${v.resident.lastName}` : "",
        (v.tags ?? []).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [vehicles, query, filter, matchesFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const sa = STATUS_SORT[(a.status ?? "APPROVED") as VehicleStatus] ?? 99;
      const sb = STATUS_SORT[(b.status ?? "APPROVED") as VehicleStatus] ?? 99;
      if (sa !== sb) return sa - sb;
      return (a.licensePlate || "").localeCompare(b.licensePlate || "");
    });
  }, [filtered]);

  const filteredGuestCars = useMemo(() => {
    if (filter !== "GUESTS") return [];
    const q = query.trim().toLowerCase();
    if (!q) return guestCars;
    return guestCars.filter((g) =>
      [g.vehiclePlate ?? "", g.name, g.resident ? `${g.resident.firstName} ${g.resident.lastName}` : ""]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [filter, guestCars, query]);

  // ── Bulk selection (tylko PENDING) ────────────────────────────────────────
  const selectablePending = useMemo(
    () => sorted.filter((v) => (v.status ?? "APPROVED") === "PENDING").map((v) => v.id),
    [sorted],
  );
  const selectedPending = useMemo(
    () => sorted.filter((v) => selected.has(v.id) && (v.status ?? "APPROVED") === "PENDING"),
    [sorted, selected],
  );

  const toggleAll = () => {
    if (selected.size > 0) setSelected(new Set());
    else setSelected(new Set(selectablePending));
  };
  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const openDrawer = (v: Vehicle) => {
    setSel(v);
    setDrawerOpen(true);
  };
  const closeDrawer = () => {
    setDrawerOpen(false);
    setTimeout(() => setSel(null), 320);
  };

  const refreshSel = async (vehicleId: number) => {
    const fresh = await load();
    const nv = (fresh ?? []).find((x) => x.id === vehicleId) ?? null;
    setSel(nv);
    if (!nv) closeDrawer();
  };

  const onDelete = async (vehicleId: number) => {
    if (!window.confirm("Usunąć ten pojazd?")) return;
    await buildingAdminApi.delete(`/building-admin/buildings/${buildingId}/vehicles/${vehicleId}`);
    closeDrawer();
    await load();
  };

  const onAction = async (
    vehicleId: number,
    action: "approve" | "reject" | "block" | "unblock",
    reason?: string,
  ) => {
    try {
      await buildingAdminApi.patch(`/building-admin/buildings/${buildingId}/vehicles/${vehicleId}/status`, {
        action,
        reason,
      });
      if (drawerOpen && sel?.id === vehicleId) await refreshSel(vehicleId);
      else await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? "Nie udało się zmienić statusu pojazdu");
    }
  };

  const bulkAction = async (action: "approve" | "reject", reason?: string) => {
    if (selectedPending.length === 0) return;
    setBulkBusy(true);
    setBulkProgress({ done: 0, total: selectedPending.length });
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < selectedPending.length; i++) {
      const v = selectedPending[i];
      try {
        await buildingAdminApi.patch(`/building-admin/buildings/${buildingId}/vehicles/${v.id}/status`, {
          action,
          reason,
        });
        ok += 1;
      } catch (err) {
        console.error("bulk vehicle action error", err);
        fail += 1;
      }
      setBulkProgress({ done: i + 1, total: selectedPending.length });
    }
    setBulkBusy(false);
    setBulkProgress(null);
    setSelected(new Set());
    await load();
    if (fail > 0) alert(`Wykonano: ${ok}, błędy: ${fail}`);
  };

  const TILES: { key: Filter; label: string; icon: React.ReactNode; count: number; tone?: "amber" | "red" }[] = [
    { key: "ACTIVE", label: "Wszystkie aktywne", icon: <CarFront size={16} />, count: counts.ACTIVE },
    { key: "RESIDENT", label: "Mieszkańcy", icon: <UserRound size={16} />, count: counts.RESIDENT },
    { key: "COURIER", label: "Kurierzy", icon: <Package size={16} />, count: counts.COURIER },
    { key: "WASTE", label: "Śmieciarki", icon: <Truck size={16} />, count: counts.WASTE },
    { key: "EMERGENCY", label: "Uprzywilejowane", icon: <Siren size={16} />, count: counts.EMERGENCY },
    { key: "OTHER", label: "Inne usługi", icon: <Wrench size={16} />, count: counts.OTHER },
    { key: "GUESTS", label: "Goście", icon: <Users size={16} />, count: guestCars.length },
    { key: "BLOCKED", label: "Zablokowane", icon: <ShieldOff size={16} />, count: counts.BLOCKED, tone: "red" },
  ];
  if (counts.PENDING > 0) {
    TILES.splice(1, 0, {
      key: "PENDING",
      label: "Oczekujące",
      icon: <CircleDashed size={16} />,
      count: counts.PENDING,
      tone: "amber",
    });
  }

  return (
    <div className="ba-panel">
      <div className="ba-panel-head">
        <div className="ba-panel-title">
          <CarFront size={16} />
          Pojazdy
          <span className="pill">{vehicles.length}</span>
        </div>
        <div className="ba-panel-tools" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "4px 10px",
              minWidth: 240,
            }}
          >
            <Search size={13} color="var(--muted)" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Szukaj: tablica, marka, kolor, mieszkaniec…"
              className="ba-input"
              style={{ border: 0, background: "transparent", outline: "none", fontSize: 13, width: "100%", padding: 0 }}
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--muted)", display: "grid", placeItems: "center" }}
                aria-label="Wyczyść"
              >
                <X size={13} />
              </button>
            ) : null}
          </label>
          {!showAdd ? (
            <button type="button" className="ba-btn primary sm" onClick={() => setShowAdd(true)}>
              <Plus size={13} /> Dodaj pojazd
            </button>
          ) : null}
        </div>
      </div>

      {/* Kafelki-filtry */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {TILES.map((t) => (
          <FilterTile
            key={t.key}
            icon={t.icon}
            label={t.label}
            value={t.count}
            tone={t.tone}
            active={filter === t.key}
            onClick={() => {
              setFilter(t.key);
              setSelected(new Set());
            }}
          />
        ))}
      </div>

      {/* Sticky bulk action bar — dla widocznych PENDING */}
      {filter !== "GUESTS" && (selectablePending.length > 0 || selected.size > 0) && (
        <div
          style={{
            position: "sticky",
            top: 4,
            zIndex: 5,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "10px 16px",
            background: "var(--amber-50)",
            borderBottom: "1px solid var(--border)",
            fontSize: 13,
          }}
        >
          <button type="button" onClick={toggleAll} className="ba-btn sm" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {selected.size > 0 ? <CheckSquare size={13} /> : <Square size={13} />}
            {selected.size > 0
              ? `Wybrane: ${selected.size} z ${selectablePending.length}`
              : `Zaznacz wszystkie oczekujące (${selectablePending.length})`}
          </button>
          <div style={{ flex: 1 }} />
          {bulkProgress ? (
            <span style={{ color: "var(--amber)", fontWeight: 600 }}>
              Przetwarzanie {bulkProgress.done}/{bulkProgress.total}…
            </span>
          ) : (
            <>
              <button
                type="button"
                className="ba-btn sm"
                disabled={bulkBusy || selectedPending.length === 0}
                style={{ background: "var(--green-50)", color: "var(--green)", borderColor: "var(--green)" }}
                onClick={() => bulkAction("approve")}
              >
                <Check size={13} /> Zatwierdź zaznaczone ({selectedPending.length})
              </button>
              <button
                type="button"
                className="ba-btn sm"
                disabled={bulkBusy || selectedPending.length === 0}
                style={{ color: "var(--red)", borderColor: "var(--red)" }}
                onClick={() => {
                  const reason = window.prompt("Powód odmowy (jeden dla wszystkich wybranych):");
                  if (reason && reason.trim()) bulkAction("reject", reason.trim());
                }}
              >
                <X size={13} /> Odrzuć zaznaczone ({selectedPending.length})
              </button>
              {selected.size > 0 && (
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--muted)", fontSize: 12 }}
                >
                  Wyczyść
                </button>
              )}
            </>
          )}
        </div>
      )}

      {showAdd ? (
        <AddVehicleForm
          buildingId={buildingId}
          residents={residents}
          units={units}
          onDone={async () => {
            setShowAdd(false);
            await load();
          }}
          onCancel={() => setShowAdd(false)}
        />
      ) : null}

      {loading ? (
        <div className="ba-empty">Ładowanie…</div>
      ) : filter === "GUESTS" ? (
        filteredGuestCars.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <Users size={22} />
            </div>
            <h4>Brak aktywnych aut gości</h4>
            <p>Samochody gości pojawiają się tu, gdy zaproszenie z tablicą rejestracyjną jest aktywne.</p>
          </div>
        ) : (
          <div>
            <div
              style={{ padding: "8px 16px", fontSize: 12, color: "var(--muted)", borderBottom: "1px solid var(--border)" }}
            >
              Auta gości z aktywnym zaproszeniem. Zarządzanie zaproszeniami — w zakładce{" "}
              <button
                type="button"
                onClick={() => router.push(`/building-admin/v2/buildings/${buildingId}/guests`)}
                style={{ background: "transparent", border: 0, padding: 0, color: "var(--blue)", cursor: "pointer", fontWeight: 600, textDecoration: "underline" }}
              >
                Goście
              </button>
              .
            </div>
            {filteredGuestCars.map((g) => (
              <div key={g.id} className="ba-row" style={{ gridTemplateColumns: "32px 1.6fr 1fr 1fr", cursor: "default" }}>
                <div className="ba-av">
                  <Users size={14} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                    <span className="ba-mono">{g.vehiclePlate}</span> · {g.name}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {g.resident ? `Gospodarz: ${g.resident.firstName} ${g.resident.lastName}` : null}
                  </div>
                </div>
                <div>
                  <span className="ba-pill green">Aktywny</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>
                  do {new Date(g.validTo).toLocaleString("pl-PL", { timeZone: BUILDING_TZ, dateStyle: "short", timeStyle: "short" })}
                </div>
              </div>
            ))}
          </div>
        )
      ) : sorted.length === 0 ? (
        <div className="ba-empty">
          <div className="ico">
            <CarFront size={22} />
          </div>
          <h4>{query ? "Brak pojazdów pasujących do wyszukiwania" : "Brak pojazdów w tej kategorii"}</h4>
          <p>
            {query
              ? "Spróbuj innej frazy — szukamy po tablicy, marce, modelu, kolorze i mieszkańcu."
              : "Wybierz inny kafelek powyżej albo dodaj pojazd."}
          </p>
        </div>
      ) : (
        <div>
          {sorted.map((v) => {
            const status = (v.status ?? "APPROVED") as VehicleStatus;
            const meta = STATUS_LABEL[status];
            const isPending = status === "PENDING";
            const isSelected = selected.has(v.id);
            const cat = categoryOf(v);
            return (
              <div
                key={v.id}
                className="ba-row"
                onClick={() => openDrawer(v)}
                style={{
                  gridTemplateColumns: "28px 32px 1.6fr 1fr 1fr auto",
                  cursor: "pointer",
                  background: isSelected ? "var(--blue-50, #eff6ff)" : undefined,
                }}
              >
                <div style={{ display: "grid", placeItems: "center" }} onClick={(e) => e.stopPropagation()}>
                  {isPending ? (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(v.id)}
                      aria-label={`Zaznacz ${v.licensePlate}`}
                    />
                  ) : null}
                </div>
                <div className="ba-av">
                  {cat === "COURIER" ? (
                    <Package size={14} />
                  ) : cat === "WASTE" ? (
                    <Truck size={14} />
                  ) : cat === "EMERGENCY" ? (
                    <Siren size={14} />
                  ) : cat === "OTHER" ? (
                    <Wrench size={14} />
                  ) : (
                    <CarFront size={14} />
                  )}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                    <span className="ba-mono">{v.licensePlate}</span>
                    {[v.make, v.model].filter(Boolean).length ? ` · ${[v.make, v.model].filter(Boolean).join(" ")}` : null}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {v.color}
                    {v.resident ? ` · ${v.resident.firstName} ${v.resident.lastName}` : null}
                    {v.unit ? ` · lokal ${v.unit.label ?? v.unit.number}` : null}
                    {v.serviceName ? ` · ${v.serviceName}` : null}
                    {v.validTo ? ` · do ${new Date(v.validTo).toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ })}` : null}
                  </div>
                  {status === "REJECTED" && v.rejectionReason ? (
                    <div style={{ fontSize: 11.5, color: "var(--red)", marginTop: 2 }}>Powód: {v.rejectionReason}</div>
                  ) : null}
                </div>
                <div>
                  <span className={`ba-pill ${meta.tone === "default" ? "" : meta.tone}`}>{meta.label}</span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
                  {isPending ? (
                    <>
                      <button
                        type="button"
                        className="ba-btn sm"
                        style={{ background: "var(--green-50)", color: "var(--green)", borderColor: "var(--green)" }}
                        onClick={() => onAction(v.id, "approve")}
                      >
                        <Check size={13} /> Zatwierdź
                      </button>
                      <button
                        type="button"
                        className="ba-btn sm"
                        style={{ color: "var(--red)", borderColor: "var(--red)" }}
                        onClick={() => {
                          const reason = window.prompt("Podaj powód odmowy (widoczny dla mieszkańca):");
                          if (reason && reason.trim()) onAction(v.id, "reject", reason.trim());
                        }}
                      >
                        <X size={13} /> Odrzuć
                      </button>
                    </>
                  ) : null}
                  <button type="button" className="ba-btn sm" onClick={() => openDrawer(v)}>
                    <Pencil size={13} /> Szczegóły
                  </button>
                </div>
                <div />
              </div>
            );
          })}
        </div>
      )}

      {/* ── Drawer szczegółów / edycji ── */}
      <ResidentDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        title={sel ? `Pojazd ${sel.licensePlate}` : "Pojazd"}
        footer={
          sel ? (
            <VehicleFooter
              vehicle={sel}
              onAction={(a, reason) => void onAction(sel.id, a, reason)}
              onDelete={() => void onDelete(sel.id)}
            />
          ) : null
        }
      >
        {sel ? (
          <VehicleDetails
            key={sel.id}
            buildingId={buildingId}
            vehicle={sel}
            residents={residents}
            units={units}
            onSaved={() => void refreshSel(sel.id)}
          />
        ) : null}
      </ResidentDrawer>
    </div>
  );
}

// ── Drawer: szczegóły + edycja ──────────────────────────────────────────────
function VehicleDetails({
  buildingId,
  vehicle,
  residents,
  units,
  onSaved,
}: {
  buildingId: number;
  vehicle: Vehicle;
  residents: Resident[];
  units: UnitLite[];
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [eKind, setEKind] = useState<VehicleKind>((vehicle.kind ?? "RESIDENT") as VehicleKind);
  const [eResidentId, setEResidentId] = useState(String(vehicle.resident?.id ?? vehicle.residentId ?? ""));
  const [eUnitId, setEUnitId] = useState(String(vehicle.unit?.id ?? vehicle.unitId ?? ""));
  const [eServiceName, setEServiceName] = useState(vehicle.serviceName ?? "");
  const [eMake, setEMake] = useState(vehicle.make ?? "");
  const [eModel, setEModel] = useState(vehicle.model ?? "");
  const [eColor, setEColor] = useState(vehicle.color ?? "");
  const [ePlate, setEPlate] = useState(vehicle.licensePlate);
  const [eNotes, setENotes] = useState(vehicle.notes ?? "");
  const [eTags, setETags] = useState<string[]>(vehicle.tags ?? []);

  const status = (vehicle.status ?? "APPROVED") as VehicleStatus;
  const meta = STATUS_LABEL[status];
  const cat = categoryOf(vehicle);
  const catLabel =
    cat === "RESIDENT"
      ? "Mieszkaniec"
      : cat === "COURIER"
        ? "Kurier"
        : cat === "WASTE"
          ? "Śmieciarka"
          : cat === "EMERGENCY"
            ? "Uprzywilejowany"
            : "Inna usługa";

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (eKind === "RESIDENT" && !eResidentId && !eUnitId) {
      setError("Samochód mieszkańca wymaga wskazania mieszkańca lub lokalu");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await buildingAdminApi.patch(`/building-admin/buildings/${buildingId}/vehicles/${vehicle.id}`, {
        kind: eKind,
        residentId: eKind === "RESIDENT" && eResidentId ? Number(eResidentId) : null,
        // null = odpięcie lokalu (undefined zostawiłoby stary).
        unitId: eUnitId ? Number(eUnitId) : null,
        make: eMake.trim() || "—",
        model: eModel.trim() || undefined,
        color: eColor.trim() || "—",
        licensePlate: ePlate.trim().toUpperCase(),
        serviceName: eKind === "RESIDENT" ? "" : eServiceName.trim(),
        notes: eNotes.trim(),
        tags: eTags,
      });
      setEditing(false);
      onSaved();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setError(e2.response?.data?.message ?? "Nie udało się zapisać zmian");
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <form onSubmit={onSave} style={{ display: "grid", gap: 12 }}>
        {error ? (
          <div className="ba-pill red" style={{ display: "block", padding: "8px 12px" }}>
            {error}
          </div>
        ) : null}
        <Field label="Typ pojazdu">
          <select className="ba-input" value={eKind} onChange={(e) => setEKind(e.target.value as VehicleKind)}>
            {(Object.keys(KIND_LABEL) as VehicleKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        {eKind === "RESIDENT" ? (
          <Field label="Mieszkaniec">
            <select className="ba-input" value={eResidentId} onChange={(e) => setEResidentId(e.target.value)}>
              <option value="">— brak (auto przypisane tylko do lokalu) —</option>
              {residents.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.firstName} {r.lastName}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Nazwa firmy / usługi">
            <input
              className="ba-input"
              value={eServiceName}
              onChange={(e) => setEServiceName(e.target.value)}
              placeholder="np. MPO, DHL, Ogrodnicy"
            />
          </Field>
        )}
        {/* 2026-09-07 — lokal: dla auta mieszkańca wymagany, gdy brak mieszkańca;
            dla usług opcjonalne dopełnienie („sprzątaczka lokalu 5"). */}
        <Field label={eKind === "RESIDENT" ? "Lokal" : "Lokal (opcjonalnie)"}>
          <select className="ba-input" value={eUnitId} onChange={(e) => setEUnitId(e.target.value)}>
            <option value="">— brak —</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {formatUnitLabel(u)}
              </option>
            ))}
          </select>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="Tablica">
            <input
              className="ba-input ba-mono"
              required
              value={ePlate}
              onChange={(e) => setEPlate(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Kolor">
            <input className="ba-input" value={eColor} onChange={(e) => setEColor(e.target.value)} />
          </Field>
          <Field label="Marka">
            <input className="ba-input" value={eMake} onChange={(e) => setEMake(e.target.value)} />
          </Field>
          <Field label="Model">
            <input className="ba-input" value={eModel} onChange={(e) => setEModel(e.target.value)} />
          </Field>
        </div>
        <Field label="Notatki">
          <textarea className="ba-input" rows={2} value={eNotes} onChange={(e) => setENotes(e.target.value)} />
        </Field>
        <Field label="Tagi">
          <TagPicker
            value={eTags}
            onChange={setETags}
            apiClient={buildingAdminApi}
            buildSuggestionsUrl={() => `/building-admin/buildings/${buildingId}/vehicle-tags`}
            ariaLabel="Tagi pojazdu"
          />
        </Field>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" className="ba-btn primary" disabled={busy}>
            {busy ? "Zapisywanie…" : "Zapisz zmiany"}
          </button>
          <button type="button" className="ba-btn" disabled={busy} onClick={() => setEditing(false)}>
            Anuluj
          </button>
        </div>
      </form>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* ── Zdjęcia: ręczne + miniatury z kamery LPR ── */}
      <VehiclePhotos buildingId={buildingId} plate={vehicle.licensePlate} photo={vehicle.photo ?? null} />

      <div className="ba-kv-grid">
        <div className="ba-kv">
          <div className="k">Tablica</div>
          <div className="v ba-mono">{vehicle.licensePlate}</div>
        </div>
        <div className="ba-kv">
          <div className="k">Status</div>
          <div className="v">
            <span className={`ba-pill ${meta.tone === "default" ? "" : meta.tone}`}>{meta.label}</span>
          </div>
        </div>
        <div className="ba-kv">
          <div className="k">Kategoria</div>
          <div className="v">{catLabel}</div>
        </div>
        <div className="ba-kv">
          <div className="k">Typ</div>
          <div className="v">{KIND_LABEL[(vehicle.kind ?? "RESIDENT") as VehicleKind]}</div>
        </div>
        <div className="ba-kv">
          <div className="k">Marka / model</div>
          <div className="v">{[vehicle.make, vehicle.model].filter(Boolean).join(" ") || "—"}</div>
        </div>
        <div className="ba-kv">
          <div className="k">Kolor</div>
          <div className="v">{vehicle.color || "—"}</div>
        </div>
        {vehicle.resident ? (
          <div className="ba-kv">
            <div className="k">Mieszkaniec</div>
            <div className="v">
              {vehicle.resident.firstName} {vehicle.resident.lastName}
            </div>
          </div>
        ) : null}
        {vehicle.unit ? (
          <div className="ba-kv">
            <div className="k">Lokal</div>
            <div className="v">{vehicle.unit.label ?? vehicle.unit.number}</div>
          </div>
        ) : null}
        {vehicle.serviceName ? (
          <div className="ba-kv">
            <div className="k">Firma / usługa</div>
            <div className="v">{vehicle.serviceName}</div>
          </div>
        ) : null}
        {vehicle.validTo ? (
          <div className="ba-kv">
            <div className="k">Ważny do</div>
            <div className="v">{new Date(vehicle.validTo).toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ })}</div>
          </div>
        ) : null}
      </div>
      {vehicle.rejectionReason ? (
        <div className="ba-pill red" style={{ display: "block", padding: "8px 12px" }}>
          Powód odmowy: {vehicle.rejectionReason}
        </div>
      ) : null}
      {vehicle.notes ? (
        <div>
          <div className="ba-section-label">Notatki</div>
          <div style={{ fontSize: 13 }}>{vehicle.notes}</div>
        </div>
      ) : null}
      {(vehicle.tags ?? []).length > 0 ? (
        <div>
          <div className="ba-section-label">Tagi</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(vehicle.tags ?? []).map((t) => (
              <span key={t} className="ba-pill">
                {t}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <button type="button" className="ba-btn" onClick={() => setEditing(true)}>
        <Pencil size={14} /> Edytuj dane pojazdu
      </button>

      {/* ── Historia przejazdów (access_events po tablicy) ── */}
      <VehicleHistory buildingId={buildingId} plate={vehicle.licensePlate} />
    </div>
  );
}

// Ostatnie przejazdy pojazdu przez bramy osiedla — czytane z access_events
// (LPR ma 30-dniowy TTL na surowe odczyty, ale access_events żyją dłużej).
interface AccessEventLite {
  id: string;
  ts: string;
  type: string;
  direction: string | null;
  gateOpened: boolean;
  reason: string | null;
  accessPointLabel: string | null;
}

// ── Zdjęcia pojazdu: ręczne (vehicle.photo) + odczyty z kamery LPR ──────────
// Surowe odczyty LPR (ze zdjęciem) żyją 30 dni — pokazujemy do 4 ostatnich
// miniatur; klik powiększa w prostym lightboxie (bez pełnego LprViewer —
// admin chce tu tylko ZOBACZYĆ auto, identyfikacja jest w Odczytach tablic).
interface LprReadLite {
  id: number;
  ts: string;
  hasImage: boolean;
  direction: string | null;
}

function VehiclePhotos({
  buildingId,
  plate,
  photo,
}: {
  buildingId: number;
  plate: string;
  photo: string | null;
}) {
  const [reads, setReads] = useState<LprReadLite[] | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; caption: string } | null>(null);
  const [lightboxBusy, setLightboxBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReads(null);
    buildingAdminApi
      .get<{ reads: LprReadLite[]; total: number }>(`/building-admin/buildings/${buildingId}/lpr-reads`, {
        params: { plate: plate.toUpperCase(), limit: 8 },
      })
      .then((res) => {
        if (cancelled) return;
        setReads(res.data.reads.filter((r) => r.hasImage).slice(0, 4));
      })
      .catch(() => {
        if (!cancelled) setReads([]);
      });
    return () => {
      cancelled = true;
    };
  }, [buildingId, plate]);

  // Zwolnij object-URL po zamknięciu lightboxa.
  useEffect(() => {
    return () => {
      if (lightbox?.src.startsWith("blob:")) URL.revokeObjectURL(lightbox.src);
    };
  }, [lightbox]);

  const openRead = async (r: LprReadLite) => {
    if (lightboxBusy) return;
    setLightboxBusy(true);
    try {
      const res = await buildingAdminApi.get(
        `/building-admin/buildings/${buildingId}/lpr-reads/${r.id}/image`,
        { responseType: "blob" },
      );
      const src = URL.createObjectURL(res.data as Blob);
      const dt = new Date(r.ts);
      setLightbox({
        src,
        caption: `${plate} · ${r.direction === "OUT" ? "Wyjazd" : "Wjazd"} · ${dt.toLocaleString("pl-PL", { timeZone: BUILDING_TZ, dateStyle: "short", timeStyle: "short" })}`,
      });
    } catch {
      alert("Nie udało się pobrać zdjęcia (mogło już wygasnąć — zdjęcia są przechowywane 30 dni).");
    } finally {
      setLightboxBusy(false);
    }
  };

  const hasAnything = photo || (reads !== null && reads.length > 0);

  return (
    <div>
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo}
          alt={`Zdjęcie pojazdu ${plate}`}
          onClick={() => setLightbox({ src: photo, caption: `${plate} · zdjęcie dodane ręcznie` })}
          style={{ width: "100%", maxHeight: 200, objectFit: "cover", borderRadius: 12, cursor: "zoom-in", border: "1px solid var(--border)" }}
        />
      ) : null}

      <div className="ba-section-label" style={{ marginTop: photo ? 10 : 0 }}>
        Zdjęcia z kamery LPR
      </div>
      {reads === null ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Ładowanie…</div>
      ) : reads.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          {hasAnything ? "Brak odczytów z kamery z ostatnich 30 dni." : "Brak zdjęć — odczyty z kamery są przechowywane 30 dni."}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {reads.map((r) => {
            const dt = new Date(r.ts);
            return (
              <div key={r.id} style={{ display: "grid", gap: 3, justifyItems: "center" }}>
                <LazyLprThumbnail
                  apiClient={buildingAdminApi}
                  url={`/building-admin/buildings/${buildingId}/lpr-reads/${r.id}/image`}
                  onClick={() => void openRead(r)}
                  style={{ width: 96, height: 72, borderRadius: 8, cursor: "zoom-in" }}
                  alt={`${plate} — ${dt.toLocaleString("pl-PL", { timeZone: BUILDING_TZ })}`}
                />
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  {dt.toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ, day: "2-digit", month: "2-digit" })}{" "}
                  {dt.toLocaleTimeString("pl-PL", { timeZone: BUILDING_TZ, hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Lightbox — nad drawerem (60), pod czatem (75+). */}
      {lightbox ? (
        <div
          onClick={() => setLightbox(null)}
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
          <div style={{ display: "grid", gap: 10, justifyItems: "center", maxWidth: "min(92vw, 1100px)" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox.src}
              alt={lightbox.caption}
              style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: 12, boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}
            />
            <div style={{ color: "#fff", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 10 }}>
              {lightbox.caption}
              <button
                type="button"
                onClick={() => setLightbox(null)}
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
        </div>
      ) : null}
    </div>
  );
}

// Surowe kody z Edge (reason w access_events) → czytelny polski opis.
// Nieznane kody pokazujemy bez zmian.
const REASON_LABEL: Record<string, string> = {
  not_whitelisted: "tablica nie była wtedy na białej liście",
  plate_not_in_allowlist: "tablica nie była wtedy na białej liście",
  expired: "ważność pojazdu minęła",
  blocked: "pojazd był zablokowany",
  // 2026-07-30 — przepustka wyjazdowa (docs/exit-grace-pass.md)
  exit_pass: "wyjazd na przepustce",
  overstay: "przekroczony czas pobytu (wyjazd otwarty)",
  overstay_denied: "przekroczony czas pobytu — wyjazd zablokowany",
};

function VehicleHistory({ buildingId, plate }: { buildingId: number; plate: string }) {
  const [events, setEvents] = useState<AccessEventLite[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setFailed(false);
    buildingAdminApi
      .get<{ events: AccessEventLite[]; total: number }>(
        `/building-admin/buildings/${buildingId}/access-events`,
        { params: { plate: plate.toUpperCase(), limit: 10 } },
      )
      .then((res) => {
        if (cancelled) return;
        setEvents(res.data.events);
        setTotal(res.data.total);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [buildingId, plate]);

  return (
    <div>
      <div className="ba-section-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <History size={13} /> Historia przejazdów
        {events && total > 0 ? (
          <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
            (ostatnie {events.length} z {total})
          </span>
        ) : null}
      </div>
      {failed ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Nie udało się pobrać historii przejazdów.</div>
      ) : events === null ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>Ładowanie…</div>
      ) : events.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          Brak zarejestrowanych przejazdów tego pojazdu przez bramy osiedla.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 0, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          {events.map((e) => {
            const dt = new Date(e.ts);
            const isOut = e.direction === "OUT";
            const denied = !e.gateOpened;
            return (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 12px",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 13,
                  background: "var(--surface)",
                }}
              >
                <span
                  style={{
                    display: "grid",
                    placeItems: "center",
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    flexShrink: 0,
                    background: denied ? "var(--red-50)" : "var(--green-50)",
                    color: denied ? "var(--red)" : "var(--green)",
                  }}
                >
                  {isOut ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {isOut ? "Wyjazd" : "Wjazd"}
                    {e.accessPointLabel ? ` · ${e.accessPointLabel}` : ""}
                    {denied ? " · brama nie otwarta" : ""}
                  </div>
                  {denied && e.reason ? (
                    <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                      {REASON_LABEL[e.reason] ?? e.reason}
                    </div>
                  ) : null}
                </div>
                <div style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}>
                  {dt.toLocaleDateString("pl-PL", { timeZone: BUILDING_TZ, day: "2-digit", month: "2-digit" })}{" "}
                  {dt.toLocaleTimeString("pl-PL", { timeZone: BUILDING_TZ, hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VehicleFooter({
  vehicle,
  onAction,
  onDelete,
}: {
  vehicle: Vehicle;
  onAction: (a: "approve" | "reject" | "block" | "unblock", reason?: string) => void;
  onDelete: () => void;
}) {
  const status = (vehicle.status ?? "APPROVED") as VehicleStatus;
  return (
    <>
      {status === "PENDING" ? (
        <>
          <button
            type="button"
            className="ba-btn"
            style={{ background: "var(--green-50)", color: "var(--green)", borderColor: "var(--green)" }}
            onClick={() => onAction("approve")}
          >
            <Check size={14} /> Zatwierdź
          </button>
          <button
            type="button"
            className="ba-btn danger"
            onClick={() => {
              const reason = window.prompt("Podaj powód odmowy (widoczny dla mieszkańca):");
              if (reason && reason.trim()) onAction("reject", reason.trim());
            }}
          >
            <X size={14} /> Odrzuć
          </button>
        </>
      ) : null}
      {status === "APPROVED" ? (
        <button
          type="button"
          className="ba-btn danger"
          onClick={() => {
            if (window.confirm(`Zablokować pojazd ${vehicle.licensePlate}? Zostanie usunięty z allowlisty LPR.`))
              onAction("block");
          }}
        >
          <ShieldOff size={14} /> Zablokuj
        </button>
      ) : null}
      {status === "BLOCKED" ? (
        <button
          type="button"
          className="ba-btn"
          style={{ background: "var(--green-50)", color: "var(--green)", borderColor: "var(--green)" }}
          onClick={() => onAction("unblock")}
        >
          <Check size={14} /> Odblokuj
        </button>
      ) : null}
      <button type="button" className="ba-btn danger" onClick={onDelete}>
        <Trash2 size={14} /> Usuń pojazd
      </button>
    </>
  );
}

// ── Formularz dodawania (kind-aware) ────────────────────────────────────────
function AddVehicleForm({
  buildingId,
  residents,
  units,
  onDone,
  onCancel,
}: {
  buildingId: number;
  residents: Resident[];
  units: UnitLite[];
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<VehicleKind>("RESIDENT");
  const [residentId, setResidentId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [color, setColor] = useState("");
  const [plate, setPlate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (kind === "RESIDENT" && !residentId && !unitId) {
      setError("Wybierz mieszkańca lub lokal");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/vehicles`, {
        kind,
        residentId: kind === "RESIDENT" && residentId ? Number(residentId) : undefined,
        unitId: unitId ? Number(unitId) : undefined,
        serviceName: kind !== "RESIDENT" && serviceName.trim() ? serviceName.trim() : undefined,
        make: make.trim() || "—",
        model: model.trim() || undefined,
        color: color.trim() || "—",
        licensePlate: plate.toUpperCase(),
      });
      await onDone();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setError(e2.response?.data?.message ?? "Błąd dodawania pojazdu");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onAdd} style={{ padding: 16, borderBottom: "1px solid var(--border)", display: "grid", gap: 10 }}>
      {error ? (
        <div className="ba-pill red" style={{ display: "block", padding: "8px 12px" }}>
          {error}
        </div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Typ pojazdu">
          <select className="ba-input" value={kind} onChange={(e) => setKind(e.target.value as VehicleKind)}>
            {(Object.keys(KIND_LABEL) as VehicleKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        {kind === "RESIDENT" ? (
          <Field label="Mieszkaniec">
            <select className="ba-input" value={residentId} onChange={(e) => setResidentId(e.target.value)}>
              <option value="">— brak (tylko lokal) —</option>
              {residents.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.firstName} {r.lastName}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Nazwa firmy / usługi">
            <input
              className="ba-input"
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              placeholder="np. MPO, DHL, Ogrodnicy"
            />
          </Field>
        )}
        <Field label={kind === "RESIDENT" ? "Lokal" : "Lokal (opcjonalnie)"}>
          <select className="ba-input" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">— brak —</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {formatUnitLabel(u)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tablica">
          <input
            required
            value={plate}
            onChange={(e) => setPlate(e.target.value.toUpperCase())}
            className="ba-input ba-mono"
            placeholder="WA12345"
          />
        </Field>
        <Field label="Kolor">
          <input value={color} onChange={(e) => setColor(e.target.value)} className="ba-input" placeholder="Srebrny" />
        </Field>
        <Field label="Marka">
          <input value={make} onChange={(e) => setMake(e.target.value)} className="ba-input" placeholder="Toyota" />
        </Field>
        <Field label="Model">
          <input value={model} onChange={(e) => setModel(e.target.value)} className="ba-input" placeholder="Corolla" />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" disabled={busy} className="ba-btn primary">
          {busy ? "Dodawanie…" : "Dodaj pojazd"}
        </button>
        <button type="button" className="ba-btn" onClick={onCancel}>
          Anuluj
        </button>
      </div>
    </form>
  );
}

function FilterTile({
  icon,
  label,
  value,
  active,
  onClick,
  tone = undefined,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  active: boolean;
  onClick: () => void;
  tone?: "amber" | "red";
}) {
  const toneStyle: React.CSSProperties = active
    ? { borderColor: "var(--blue)", background: "color-mix(in oklab, var(--blue) 10%, var(--surface))", boxShadow: "0 0 0 1px var(--blue)" }
    : tone === "amber"
      ? { borderColor: "var(--amber)", background: "var(--amber-50)" }
      : tone === "red"
        ? { borderColor: "var(--red)", background: "var(--red-50, #fef2f2)" }
        : { borderColor: "var(--border)", background: "var(--card)" };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        ...toneStyle,
        border: "1px solid",
        borderRadius: 10,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        cursor: "pointer",
        textAlign: "left",
        font: "inherit",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: active ? "var(--blue)" : "var(--muted)",
          fontSize: 11.5,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          fontWeight: active ? 700 : 500,
        }}
      >
        {icon}
        <span>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: active ? "var(--blue)" : undefined }}>{value}</div>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}
