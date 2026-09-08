"use client";
/**
 * Mapa osiedla — BA v2 (2026-09-08).
 *
 * Render osiedla z klikalnymi domami + panel przypisywania ISTNIEJĄCYCH
 * lokali z bazy do części budynku (A/B; „Budynek 16" ma jedną). Zgodnie
 * z paczką „gatelynk-mapa-villa-natura":
 *   • klucz = ID lokalu, adres tylko do wyświetlania/wyszukiwania,
 *   • A/B to części na rysunku, nie numery /1 i /2 — decyduje administrator,
 *   • zapis dopiero po potwierdzeniu serwera; błąd nigdy nie wygląda jak sukces,
 *   • konflikt (ktoś inny zmienił miejsce) → 409 → odświeżenie stanu + komunikat.
 *
 * Dane: GET/PUT/DELETE /building-admin/buildings/:id/estate-map[/slots/:b/:s].
 * Bez mapy w bazie: ekran startowy pozwala wgrać konfigurację z paczki
 * (bundlowana `/estate-maps/villa-natura.json`) albo własny JSON.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Map as MapIcon, RefreshCw, Upload } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import {
  areaTitle,
  normalizePl,
  slotKey,
  unitMatchesArea,
  type EstateMapAssignment,
  type EstateMapConfig,
  type EstateMapResponse,
  type EstateMapUnit,
  type EstateSlotKey,
} from "@/lib/estate-map";
import { EstateMapView } from "@/components/ba-v2/estate-map/EstateMapView";
import styles from "@/components/ba-v2/estate-map/estate-map.module.css";

type Status = { kind: "ok" | "pending" | "error"; text: string } | null;

interface ApiError {
  response?: { status?: number; data?: { code?: string; message?: string | string[] } };
}

function errMessage(err: unknown, fallback: string): string {
  const e = err as ApiError;
  const m = e.response?.data?.message;
  if (Array.isArray(m)) return m.join(", ");
  return m || fallback;
}

export default function EstateMapPage() {
  const params = useParams<{ id: string }>();
  const buildingId = Number(params.id);
  const base = `/building-admin/buildings/${buildingId}/estate-map`;

  const [data, setData] = useState<EstateMapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [slot, setSlot] = useState<EstateSlotKey>("A");
  const [pendingUnitId, setPendingUnitId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Ładowanie ────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!Number.isFinite(buildingId)) return;
    setLoadError(null);
    try {
      const res = await buildingAdminApi.get<EstateMapResponse>(base);
      setData(res.data);
      setSelectedId((cur) => cur ?? res.data.map?.buildings[0]?.id ?? null);
    } catch (err: unknown) {
      setLoadError(errMessage(err, "Nie udało się pobrać mapy osiedla"));
    } finally {
      setLoading(false);
    }
  }, [base, buildingId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Pochodne ─────────────────────────────────────────────────────────────
  const config: EstateMapConfig | null = data?.map ?? null;
  const units: EstateMapUnit[] = useMemo(() => data?.units ?? [], [data]);
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const areaById = useMemo(() => new Map((config?.buildings ?? []).map((b) => [b.id, b])), [config]);
  const current = selectedId ? areaById.get(selectedId) ?? null : null;

  const assignmentByKey = useMemo(() => {
    const m = new Map<string, EstateMapAssignment>();
    for (const a of data?.assignments ?? []) m.set(slotKey(a.mapBuildingId, a.slot), a);
    return m;
  }, [data]);
  const ownerByUnit = useMemo(() => {
    const m = new Map<number, EstateMapAssignment>();
    for (const a of data?.assignments ?? []) m.set(a.unitId, a);
    return m;
  }, [data]);
  const assignedParts = useMemo(() => new Set(assignmentByKey.keys()), [assignmentByKey]);
  const totalSlots = useMemo(() => (config?.buildings ?? []).reduce((s, b) => s + b.slots.length, 0), [config]);

  const currentAssignment = current ? assignmentByKey.get(slotKey(current.id, slot)) ?? null : null;

  // Wybór budynku/części → kandydat = to, co już tam jest (albo nic).
  const select = useCallback(
    (id: string, s: EstateSlotKey) => {
      const area = areaById.get(id);
      if (!area) return;
      const nextSlot: EstateSlotKey = area.slots.includes(s) ? s : "A";
      setSelectedId(id);
      setSlot(nextSlot);
      setPendingUnitId(assignmentByKey.get(slotKey(id, nextSlot))?.unitId ?? null);
      setSearch("");
      setStatus(null);
      const hasAddressMatches = units.some((u) => unitMatchesArea(u, area));
      setShowAll(!hasAddressMatches);
    },
    [areaById, assignmentByKey, units],
  );

  // Po pierwszym załadowaniu ustaw kandydata zgodnie z aktualnym miejscem.
  useEffect(() => {
    if (!current) return;
    setPendingUnitId(assignmentByKey.get(slotKey(current.id, slot))?.unitId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Kandydaci: wyszukiwanie > „pod tym adresem" > wszystkie.
  const candidates = useMemo(() => {
    if (!current) return [] as EstateMapUnit[];
    const q = normalizePl(search);
    const matchesAddr = (u: EstateMapUnit) => unitMatchesArea(u, current);
    const sorted = [...units].sort((a, b) => {
      const first = Number(matchesAddr(b)) - Number(matchesAddr(a));
      return first || a.label.localeCompare(b.label, "pl", { numeric: true });
    });
    if (q) return sorted.filter((u) => normalizePl(u.label).includes(q));
    return showAll ? sorted : sorted.filter(matchesAddr);
  }, [current, units, search, showAll]);

  const remainingCount = useMemo(
    () => (current ? units.filter((u) => !unitMatchesArea(u, current)).length : 0),
    [current, units],
  );

  const ownerOf = (unitId: number) => ownerByUnit.get(unitId) ?? null;
  const ownerLabel = (a: EstateMapAssignment) => {
    const area = areaById.get(a.mapBuildingId);
    const title = area ? areaTitle(area) : a.mapBuildingId;
    return area && area.unitCount === 1 ? title : `${title} · część ${a.slot}`;
  };

  const pendingUnit = pendingUnitId ? unitById.get(pendingUnitId) ?? null : null;
  const pendingOwner = pendingUnitId ? ownerOf(pendingUnitId) : null;
  const pendingElsewhere =
    !!pendingOwner && current && (pendingOwner.mapBuildingId !== current.id || pendingOwner.slot !== slot);
  const canSave = !!current && !!pendingUnitId && pendingUnitId !== (currentAssignment?.unitId ?? null) && !saving;

  // ── Zapis ────────────────────────────────────────────────────────────────
  const applyAssignments = (assignments: EstateMapAssignment[]) =>
    setData((d) => (d ? { ...d, assignments } : d));

  const handleConflict = async (err: unknown, fallback: string) => {
    const e = err as ApiError;
    if (e.response?.status === 409) {
      await load();
      setStatus({ kind: "error", text: errMessage(err, "Konflikt — mapa została odświeżona.") });
      return;
    }
    setStatus({ kind: "error", text: errMessage(err, fallback) });
  };

  const save = async () => {
    if (!current || !pendingUnitId || !pendingUnit) return;
    const target = currentAssignment;
    let replace = false;
    let move = false;
    if (target && target.unitId !== pendingUnitId) {
      if (!window.confirm(`W tym miejscu jest już ${target.unitLabel}. Zastąpić lokalem ${pendingUnit.label}?`)) return;
      replace = true;
    }
    if (pendingElsewhere && pendingOwner) {
      if (!window.confirm(`${pendingUnit.label} jest przypisany do: ${ownerLabel(pendingOwner)}. Przenieść tutaj?`)) return;
      move = true;
    }
    setSaving(true);
    setStatus({ kind: "pending", text: "Zapisywanie przypisania…" });
    try {
      const res = await buildingAdminApi.put<{ assignments: EstateMapAssignment[]; noop?: boolean }>(
        `${base}/slots/${encodeURIComponent(current.id)}/${slot}`,
        { unitId: pendingUnitId, expectedUnitId: target?.unitId ?? null, replace, move },
      );
      applyAssignments(res.data.assignments);
      setStatus({
        kind: "ok",
        text: `Zapisano w bazie: ${pendingUnit.label} → ${areaTitle(current)}${current.unitCount === 1 ? "" : ` · część ${slot}`}.`,
      });
    } catch (err: unknown) {
      await handleConflict(err, "Nie udało się zapisać przypisania. Spróbuj ponownie.");
    } finally {
      setSaving(false);
    }
  };

  const unlink = async () => {
    if (!current || !currentAssignment) return;
    if (!window.confirm(`Odpiąć ${currentAssignment.unitLabel} od ${areaTitle(current)}?`)) return;
    setSaving(true);
    setStatus({ kind: "pending", text: "Odpinanie…" });
    try {
      const res = await buildingAdminApi.delete<{ assignments: EstateMapAssignment[] }>(
        `${base}/slots/${encodeURIComponent(current.id)}/${slot}`,
        { data: { expectedUnitId: currentAssignment.unitId } },
      );
      applyAssignments(res.data.assignments);
      setPendingUnitId(null);
      setStatus({ kind: "ok", text: `Odpięto ${currentAssignment.unitLabel}. Lokal jest ponownie dostępny.` });
    } catch (err: unknown) {
      await handleConflict(err, "Nie udało się odpiąć lokalu.");
    } finally {
      setSaving(false);
    }
  };

  // ── Konfiguracja mapy (start / podmiana) ────────────────────────────────
  const uploadConfig = async (cfg: unknown, label: string) => {
    setBootstrapping(true);
    setStatus(null);
    try {
      await buildingAdminApi.put(base, cfg);
      await load();
      setStatus({ kind: "ok", text: `Zapisano konfigurację mapy (${label}).` });
    } catch (err: unknown) {
      setStatus({ kind: "error", text: errMessage(err, "Nie udało się zapisać konfiguracji mapy.") });
    } finally {
      setBootstrapping(false);
    }
  };

  const useBundledMap = async () => {
    try {
      const res = await fetch("/estate-maps/villa-natura.json", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      await uploadConfig(await res.json(), "Villa Natura");
    } catch {
      setStatus({ kind: "error", text: "Nie udało się wczytać wbudowanej konfiguracji Villa Natura." });
    }
  };

  const onPickFile = async (file: File | null) => {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      // Akceptujemy też surowy plik z paczki (konfiguracja-budynkow.json).
      const cfg = parsed.buildings && !parsed.imageUrl
        ? {
            name: parsed.estateLabel ?? "Osiedle",
            imageUrl: parsed.image ? `/estate-maps/${parsed.image}` : "/estate-maps/villa-natura.jpg",
            canvas: parsed.canvas,
            buildings: parsed.buildings,
            gates: (parsed.gates ?? []).map((g: { id: string; name: string; centerNormalized?: { x: number; y: number } }) => ({
              id: g.id, name: g.name, x: g.centerNormalized?.x, y: g.centerNormalized?.y,
            })),
            geometryStatus: parsed.geometryStatus,
            addressStatus: parsed.addressStatus,
          }
        : parsed;
      if (!window.confirm("Zastąpić konfigurację mapy? Przypisania do obszarów, których nie ma w nowym pliku, zostaną usunięte.")) return;
      await uploadConfig(cfg, file.name);
    } catch {
      setStatus({ kind: "error", text: "Plik nie jest poprawnym JSON-em konfiguracji mapy." });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const statusBox = status ? (
    <p
      className={`${styles.status} ${status.kind === "ok" ? styles.statusOk : status.kind === "pending" ? styles.statusPending : styles.statusError}`}
      role={status.kind === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {status.text}
    </p>
  ) : null;

  return (
    <div className="ba-panel">
      <div className="ba-panel-head">
        <div className="ba-panel-title">
          <MapIcon size={16} />
          Mapa osiedla
          {config ? <span className="pill">{data?.assignments.length ?? 0} / {totalSlots}</span> : null}
        </div>
        <div className="ba-panel-tools">
          {config ? (
            <select
              className="ba-input"
              style={{ width: 220 }}
              value={selectedId ?? ""}
              onChange={(e) => select(e.target.value, "A")}
              aria-label="Wybierz budynek z listy"
            >
              {config.buildings.map((b) => (
                <option key={b.id} value={b.id}>
                  {areaTitle(b)}{b.street ? "" : ` (${b.label})`}
                </option>
              ))}
            </select>
          ) : null}
          <button type="button" className="ba-btn sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} /> Odśwież
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
          />
          <button type="button" className="ba-btn sm" onClick={() => fileRef.current?.click()} disabled={bootstrapping}>
            <Upload size={13} /> {config ? "Zastąp konfigurację" : "Wgraj konfigurację"}
          </button>
        </div>
      </div>

      <div style={{ padding: 16 }}>
        {loading ? (
          <div className="ba-empty">Ładowanie mapy…</div>
        ) : loadError ? (
          <div className="ba-pill red" style={{ display: "block", padding: "8px 12px" }}>{loadError}</div>
        ) : !config ? (
          <div className="ba-empty" style={{ display: "grid", gap: 10, justifyItems: "start" }}>
            <div>
              To osiedle nie ma jeszcze mapy. Wgraj konfigurację obszarów budynków (JSON z paczki
              projektowej) albo użyj wbudowanej mapy Villa Natura.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="ba-btn primary sm" onClick={() => void useBundledMap()} disabled={bootstrapping}>
                {bootstrapping ? "Zapisywanie…" : "Użyj wbudowanej mapy Villa Natura"}
              </button>
              <button type="button" className="ba-btn sm" onClick={() => fileRef.current?.click()} disabled={bootstrapping}>
                <Upload size={13} /> Wgraj własny JSON
              </button>
            </div>
            {statusBox}
          </div>
        ) : (
          <div className={styles.layout}>
            <EstateMapView
              config={config}
              assignedParts={assignedParts}
              selectedId={selectedId}
              selectedSlot={slot}
              onSelect={select}
              showLabels={showLabels}
              onToggleLabels={() => setShowLabels((v) => !v)}
              assignedCount={data?.assignments.length ?? 0}
              totalSlots={totalSlots}
            />

            <aside className={styles.panel} aria-label="Przypisywanie lokali do budynku">
              {current ? (
                <>
                  <p className={styles.eyebrow}>Wybrany budynek</p>
                  <h2 className={styles.heading}>{areaTitle(current)}</h2>
                  <p className={styles.meta}>
                    {current.unitCount === 1 ? "Budynek · 1 lokal mieszkalny" : "Bliźniak · 2 lokale mieszkalne"}
                    {!current.street && current.number ? " · adres do potwierdzenia" : null}
                    {!current.number ? " · adres do przypisania" : null}
                  </p>
                  <p className={styles.progress}>
                    Przypisane lokale: {current.slots.filter((s) => assignedParts.has(slotKey(current.id, s))).length} / {current.unitCount}
                  </p>

                  <div className={`${styles.slots} ${current.unitCount === 1 ? styles.slotsSingle : ""}`} role="group" aria-label="Wybierz część budynku">
                    {current.slots.map((s) => {
                      const a = assignmentByKey.get(slotKey(current.id, s)) ?? null;
                      return (
                        <button
                          key={s}
                          type="button"
                          className={styles.slot}
                          aria-pressed={slot === s}
                          onClick={() => select(current.id, s)}
                        >
                          <span className={styles.slotName}>
                            <span className={styles.slotLetter}>{current.unitCount === 1 ? "1" : s}</span>
                            {current.unitCount === 1 ? "Lokal" : `Część ${s}`}
                          </span>
                          <span className={`${styles.slotValue} ${a ? "" : styles.slotEmpty}`}>
                            {a ? a.unitLabel : "Przypisz lokal"}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <section className={styles.section} aria-label="Wybór lokalu z bazy">
                    <label className={styles.label} htmlFor="estate-unit-search">
                      {current.unitCount === 1 ? "Wybierz lokal z bazy" : `Lokal dla części ${slot}`}
                    </label>
                    <input
                      id="estate-unit-search"
                      className="ba-input"
                      type="search"
                      autoComplete="off"
                      placeholder="Szukaj adresu lub numeru lokalu"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setStatus(null);
                      }}
                    />
                    <div className={styles.sourceRow}>
                      <span>
                        {search ? `Wyniki wyszukiwania: ${candidates.length}` : showAll ? "Lista lokali" : "Lokale pod tym adresem"}
                      </span>
                      <span>Baza osiedla · {units.length}</span>
                    </div>
                    <div className={styles.candidates} role="radiogroup" aria-label="Lokale do przypisania">
                      {candidates.map((u) => {
                        const owner = ownerOf(u.id);
                        const sameSlot = !!owner && owner.mapBuildingId === current.id && owner.slot === slot;
                        const elsewhere = !!owner && !sameSlot;
                        const checked = pendingUnitId === u.id;
                        return (
                          <label
                            key={u.id}
                            className={`${styles.candidate} ${checked ? styles.candidateChecked : ""} ${elsewhere ? styles.candidateUnavailable : ""}`}
                          >
                            <input
                              type="radio"
                              name="estate-unit"
                              value={u.id}
                              checked={checked}
                              onChange={() => {
                                setPendingUnitId(u.id);
                                setStatus(null);
                              }}
                            />
                            <span className={styles.candidateCopy}>
                              <span className={styles.candidateName}>{u.label}</span>
                              <span className={styles.candidateStatus}>
                                {sameSlot
                                  ? "Przypisany do tej części"
                                  : elsewhere && owner
                                    ? `Zajęty: ${ownerLabel(owner)} — zapis przeniesie`
                                    : "Dostępny do przypisania"}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                      {candidates.length === 0 ? (
                        <p className={styles.empty}>
                          {search ? "Brak lokali dla tego wyszukiwania." : "Brak lokali pod tym adresem — pokaż pozostałe."}
                        </p>
                      ) : null}
                    </div>
                    {!search && remainingCount > 0 && current.number ? (
                      <button type="button" className={styles.more} onClick={() => setShowAll((v) => !v)}>
                        {showAll ? "Pokaż tylko ten adres" : `Pokaż pozostałe lokale (${remainingCount})`}
                      </button>
                    ) : null}

                    <div className={styles.actions}>
                      <button type="button" className="ba-btn primary" disabled={!canSave} onClick={() => void save()}>
                        {saving
                          ? "Zapisywanie…"
                          : (currentAssignment ? "Zapisz nowe przypisanie" : "Przypisz lokal") +
                            (current.unitCount === 1 || currentAssignment ? "" : ` do części ${slot}`)}
                      </button>
                      {currentAssignment ? (
                        <button type="button" className={styles.unlink} disabled={saving} onClick={() => void unlink()}>
                          Odepnij przypisany lokal
                        </button>
                      ) : null}
                    </div>
                  </section>

                  {statusBox}
                  <p className={styles.notice}>
                    Części A i B to obszary na rysunku — nie numery /1 i /2. Przypisanie jest zapisywane w bazie
                    dopiero po potwierdzeniu serwera; jeden lokal może zajmować jedno miejsce.
                  </p>
                </>
              ) : (
                <p className={styles.empty}>Kliknij dom na mapie albo wybierz budynek z listy.</p>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
