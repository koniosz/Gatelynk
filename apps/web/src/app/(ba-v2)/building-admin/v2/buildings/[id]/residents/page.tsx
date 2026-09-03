"use client";
// Residents tab — lista mieszkańców + drawer ze szczegółami.
//   • Dodawanie: 3-krokowy AddResidentWizard (komponent ba-v2) w drawerze.
//   • Szczegóły: ResidentDetails (Profil/Lokale/Pojazdy/Aktywność/Płatności),
//     footer z akcjami „Ustaw hasło" + „Usuń mieszkańca".
//   • Deep-link: ?open=<residentId> otwiera drawer (z globalnej wyszukiwarki).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Mail, Phone, Plus, Search, Trash2, Users } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { ResidentDrawer } from "@/components/ba-v2/ResidentDrawer";
import { AddResidentWizard } from "@/components/ba-v2/AddResidentWizard";
import { ResidentDetails, type ResidentDetail } from "@/components/ba-v2/ResidentDetails";

interface UnitResident {
  unit?: { id: number; number: string } | null;
}
interface Resident {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  avatarBase64?: string | null;
  createdAt?: string | null;
  unitResidents?: UnitResident[];
}

export default function ResidentsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);

  const [residents, setResidents] = useState<Resident[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  // Drawer szczegółów
  const [sel, setSel] = useState<ResidentDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  // Drawer dodawania (wizard)
  const [addOpen, setAddOpen] = useState(false);

  // Edycja danych mieszkańca (2026-07-21) — PATCH residents/:rId.
  const [editOpen, setEditOpen] = useState(false);
  const [eFirst, setEFirst] = useState("");
  const [eLast, setELast] = useState("");
  const [eEmail, setEEmail] = useState("");
  const [ePhone, setEPhone] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);

  // Akcje w footer
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [pwRepeat, setPwRepeat] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const load = useCallback(async () => {
    if (!Number.isFinite(buildingId)) return;
    setLoading(true);
    try {
      const r = await buildingAdminApi.get<Resident[]>(`/building-admin/buildings/${buildingId}/residents`);
      setResidents(r.data);
    } finally {
      setLoading(false);
    }
  }, [buildingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return residents;
    return residents.filter((r) => {
      const txt = `${r.firstName} ${r.lastName} ${r.email} ${r.phone ?? ""}`.toLowerCase();
      return txt.includes(q);
    });
  }, [residents, query]);

  // Pełny szczegół z osobnego endpointu (zawiera unitResidents z rolą/sinceDate).
  const openDetail = useCallback(
    async (residentId: number) => {
      setDetailOpen(true);
      setDetailLoading(true);
      setPwOpen(false);
      setConfirmDelete(false);
      try {
        const r = await buildingAdminApi.get<ResidentDetail>(
          `/building-admin/buildings/${buildingId}/residents/${residentId}`,
        );
        setSel(r.data);
      } catch {
        // Fallback: minimalny rekord z listy, żeby drawer się nie zaciął.
        const lite = residents.find((x) => x.id === residentId);
        if (lite) setSel(lite as ResidentDetail);
      } finally {
        setDetailLoading(false);
      }
    },
    [buildingId, residents],
  );

  const closeDetail = useCallback(() => {
    setDetailOpen(false);
    // Wyczyść deep-link query gdy zamykamy (żeby refresh nie otwierał ponownie).
    if (searchParams.get("open")) {
      router.replace(`/building-admin/v2/buildings/${buildingId}/residents`);
    }
    // Drawer animuje 280ms — pozwól zniknąć zanim wyczyścimy state.
    setTimeout(() => {
      setSel(null);
      setPwOpen(false);
      setEditOpen(false);
      setConfirmDelete(false);
      setPw("");
      setPwRepeat("");
      setPwErr(null);
    }, 320);
  }, [searchParams, router, buildingId]);

  // Deep-link: ?open=<rId> z globalnej wyszukiwarki. Czekamy aż lista się
  // załaduje (żeby fallback miał z czego skorzystać), potem otwieramy raz.
  const handledOpenRef = useRef<string | null>(null);
  useEffect(() => {
    const openId = searchParams.get("open");
    if (!openId || loading) return;
    if (handledOpenRef.current === openId) return;
    handledOpenRef.current = openId;
    const n = Number(openId);
    if (Number.isFinite(n)) void openDetail(n);
  }, [searchParams, loading, openDetail]);

  const onDelete = useCallback(async () => {
    if (!sel) return;
    setDeleteBusy(true);
    try {
      await buildingAdminApi.delete(`/building-admin/buildings/${buildingId}/residents/${sel.id}`);
      closeDetail();
      showToast("Usunięto mieszkańca");
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      showToast(e2.response?.data?.message ?? "Nie udało się usunąć mieszkańca");
    } finally {
      setDeleteBusy(false);
    }
  }, [sel, buildingId, closeDetail, showToast, load]);

  const onSetPassword = useCallback(async () => {
    if (!sel) return;
    setPwErr(null);
    if (pw.length < 6) {
      setPwErr("Hasło musi mieć min. 6 znaków.");
      return;
    }
    if (pw !== pwRepeat) {
      setPwErr("Hasła nie są identyczne.");
      return;
    }
    setPwBusy(true);
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/residents/${sel.id}/set-password`, {
        password: pw,
      });
      setPwOpen(false);
      setPw("");
      setPwRepeat("");
      showToast("Hasło ustawione");
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setPwErr(e2.response?.data?.message ?? "Nie udało się ustawić hasła");
    } finally {
      setPwBusy(false);
    }
  }, [sel, buildingId, pw, pwRepeat, showToast]);

  const onWizardDone = useCallback(async () => {
    setAddOpen(false);
    showToast("Dodano mieszkańca");
    await load();
  }, [showToast, load]);

  const openEdit = useCallback(() => {
    if (!sel) return;
    setEFirst(sel.firstName ?? "");
    setELast(sel.lastName ?? "");
    setEEmail(sel.email ?? "");
    setEPhone(sel.phone ?? "");
    setEditErr(null);
    setEditOpen(true);
  }, [sel]);

  const onSaveEdit = useCallback(async () => {
    if (!sel) return;
    setEditBusy(true);
    setEditErr(null);
    try {
      await buildingAdminApi.patch(`/building-admin/buildings/${buildingId}/residents/${sel.id}`, {
        firstName: eFirst,
        lastName: eLast,
        email: eEmail,
        phone: ePhone || undefined,
      });
      setEditOpen(false);
      showToast("Zapisano zmiany");
      await openDetail(sel.id);
      await load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setEditErr(e2.response?.data?.message ?? "Nie udało się zapisać zmian");
    } finally {
      setEditBusy(false);
    }
  }, [sel, buildingId, eFirst, eLast, eEmail, ePhone, showToast, openDetail, load]);

  return (
    <>
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <Users size={16} />
            Mieszkańcy
            <span className="pill">{residents.length}</span>
          </div>
          <div className="ba-panel-tools">
            <div className="ba-search" style={{ width: 280 }}>
              <Search size={14} />
              <input placeholder="Szukaj…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button type="button" className="ba-btn primary sm" onClick={() => setAddOpen(true)}>
              <Plus size={13} /> Dodaj
            </button>
          </div>
        </div>

        {loading ? (
          <div className="ba-empty">Ładowanie…</div>
        ) : filtered.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <Users size={22} />
            </div>
            <h4>Brak mieszkańców</h4>
            <p>Dodaj pierwszego mieszkańca, aby zacząć.</p>
          </div>
        ) : (
          <div>
            {filtered.map((r) => {
              const initials = `${r.firstName?.[0] ?? ""}${r.lastName?.[0] ?? ""}`.toUpperCase();
              const unitNumbers = (r.unitResidents ?? []).map((ur) => ur.unit?.number).filter(Boolean) as string[];
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => openDetail(r.id)}
                  className="ba-row"
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: 0,
                    borderBottom: "1px solid var(--border)",
                    gridTemplateColumns: "32px 1.6fr 1fr 0.6fr",
                  }}
                >
                  <div className="ba-av">{initials || "??"}</div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                      {r.firstName} {r.lastName}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
                      <Mail size={11} />
                      {r.email}
                      {r.phone ? (
                        <>
                          <span style={{ width: 3, height: 3, borderRadius: 99, background: "var(--muted-2)" }} />
                          <Phone size={11} /> {r.phone}
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {unitNumbers.length > 0 ? unitNumbers.join(", ") : "—"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted-2)", textAlign: "right" }}>→</div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Drawer: dodawanie (wizard) ── */}
      <ResidentDrawer open={addOpen} onClose={() => setAddOpen(false)} title="Nowy mieszkaniec">
        {addOpen ? (
          <AddResidentWizard buildingId={buildingId} onDone={onWizardDone} onCancel={() => setAddOpen(false)} />
        ) : null}
      </ResidentDrawer>

      {/* ── Drawer: szczegóły ── */}
      <ResidentDrawer
        open={detailOpen}
        onClose={closeDetail}
        title={sel ? `${sel.firstName} ${sel.lastName}` : "Mieszkaniec"}
        footer={
          sel ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
              {pwOpen ? (
                <div style={{ display: "grid", gap: 8, width: "100%" }}>
                  {pwErr ? <span style={{ fontSize: 11.5, color: "var(--red)" }}>{pwErr}</span> : null}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <input
                      className="ba-input"
                      type="password"
                      placeholder="Nowe hasło"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      autoComplete="new-password"
                    />
                    <input
                      className="ba-input"
                      type="password"
                      placeholder="Powtórz hasło"
                      value={pwRepeat}
                      onChange={(e) => setPwRepeat(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="ba-btn primary sm" onClick={onSetPassword} disabled={pwBusy}>
                      {pwBusy ? "Zapisywanie…" : "Zapisz hasło"}
                    </button>
                    <button type="button" className="ba-btn sm" onClick={() => setPwOpen(false)} disabled={pwBusy}>
                      Anuluj
                    </button>
                  </div>
                </div>
              ) : confirmDelete ? (
                <div style={{ display: "grid", gap: 8, width: "100%" }}>
                  <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                    Na pewno usunąć mieszkańca {sel.firstName} {sel.lastName}? Operacja jest nieodwracalna.
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="ba-btn danger sm" onClick={onDelete} disabled={deleteBusy}>
                      {deleteBusy ? "Usuwanie…" : "Tak, usuń"}
                    </button>
                    <button
                      type="button"
                      className="ba-btn sm"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleteBusy}
                    >
                      Anuluj
                    </button>
                  </div>
                </div>
              ) : editOpen ? (
                <div style={{ display: "grid", gap: 8, width: "100%" }}>
                  {editErr ? <span style={{ fontSize: 11.5, color: "var(--red)" }}>{editErr}</span> : null}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <input className="ba-input" placeholder="Imię" value={eFirst} onChange={(e) => setEFirst(e.target.value)} />
                    <input className="ba-input" placeholder="Nazwisko" value={eLast} onChange={(e) => setELast(e.target.value)} />
                    <input className="ba-input" type="email" placeholder="Email" value={eEmail} onChange={(e) => setEEmail(e.target.value)} />
                    <input className="ba-input" placeholder="Telefon" value={ePhone} onChange={(e) => setEPhone(e.target.value)} />
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" className="ba-btn primary sm" onClick={onSaveEdit} disabled={editBusy}>
                      {editBusy ? "Zapisywanie…" : "Zapisz zmiany"}
                    </button>
                    <button type="button" className="ba-btn sm" onClick={() => setEditOpen(false)} disabled={editBusy}>
                      Anuluj
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, width: "100%" }}>
                  <button type="button" className="ba-btn" onClick={openEdit}>
                    Edytuj dane
                  </button>
                  <button type="button" className="ba-btn" onClick={() => setPwOpen(true)}>
                    Ustaw hasło
                  </button>
                  <div style={{ flex: 1 }} />
                  <button type="button" className="ba-btn danger" onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={13} /> Usuń mieszkańca
                  </button>
                </div>
              )}
            </div>
          ) : null
        }
      >
        {detailLoading || !sel ? (
          <div className="ba-empty">Ładowanie…</div>
        ) : (
          <ResidentDetails buildingId={buildingId} resident={sel} />
        )}
      </ResidentDrawer>

      {/* Toast */}
      {toast ? (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--ink)",
            color: "var(--surface)",
            padding: "10px 18px",
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            zIndex: 90,
            boxShadow: "var(--shadow-2)",
          }}
        >
          {toast}
        </div>
      ) : null}
    </>
  );
}
