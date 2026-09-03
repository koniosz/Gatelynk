"use client";
// Grupy kontaktowe (2026-07-30) — BA grupuje lokale (np. „Budynek 1",
// „ulica Komfortowa") na potrzeby ekranu domofonu Akuvox.
//
// Endpointy:
//   GET    /building-admin/buildings/:id/contact-groups        → { groups, unassignedUnits }
//   POST   /building-admin/buildings/:id/contact-groups        { name }
//   PATCH  /building-admin/buildings/:id/contact-groups/:gid   { name?, sortOrder? }
//   DELETE /building-admin/buildings/:id/contact-groups/:gid
//   PATCH  /building-admin/buildings/:id/contact-groups/:gid/units { unitIds } (replace-all)
//   GET    /building-admin/buildings/:id/intercom-phonebook-info    → { token, path, edgeLanIp }
//   GET    /building-admin/buildings/:id/akuvox-userdata.tgz        → plik dla E18C
//
// Zasady: lokal należy do maks. 1 grupy; usunięcie grupy NIE kasuje lokali
// (wracają do „bez grupy"). UI pod osoby starsze: duże przyciski, czytelne
// etykiety, potwierdzenie przy usuwaniu.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  BookUser,
  Check,
  Copy,
  Download,
  Home,
  Pencil,
  Phone,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { compareNatural } from "@/lib/natural-sort";

interface UnitLite {
  id: number;
  number: string;
  street?: string | null;
}
interface ContactGroup {
  id: number;
  name: string;
  sortOrder: number;
  units: UnitLite[];
}
interface GroupsResponse {
  groups: ContactGroup[];
  unassignedUnits: UnitLite[];
}
interface PhonebookInfo {
  buildingId: number;
  token: string;
  path: string;
  edgeLanIp: string | null;
}

const unitLabel = (u: UnitLite) => (u.street ? `${u.street} ${u.number}` : u.number);

export default function ContactGroupsPage() {
  const params = useParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);

  const [data, setData] = useState<GroupsResponse | null>(null);
  const [phonebook, setPhonebook] = useState<PhonebookInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dodawanie grupy
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);

  // Edycja nazwy (inline per grupa)
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  // Modale
  const [assignGroup, setAssignGroup] = useState<ContactGroup | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<ContactGroup | null>(null);

  const load = useCallback(() => {
    if (!Number.isFinite(buildingId)) return;
    buildingAdminApi
      .get<GroupsResponse>(`/building-admin/buildings/${buildingId}/contact-groups`)
      .then((res) => setData(res.data))
      .catch((err: unknown) => {
        const e2 = err as { response?: { data?: { message?: string } } };
        setError(e2.response?.data?.message ?? "Błąd ładowania grup kontaktowych");
      })
      .finally(() => setLoading(false));
  }, [buildingId]);

  useEffect(() => {
    load();
    if (!Number.isFinite(buildingId)) return;
    buildingAdminApi
      .get<PhonebookInfo>(`/building-admin/buildings/${buildingId}/intercom-phonebook-info`)
      .then((res) => setPhonebook(res.data))
      .catch(() => setPhonebook(null));
  }, [load, buildingId]);

  const createGroup = async () => {
    const name = newName.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/contact-groups`, {
        name,
      });
      setNewName("");
      setShowAdd(false);
      load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? "Nie udało się utworzyć grupy");
    } finally {
      setSaving(false);
    }
  };

  const renameGroup = async (g: ContactGroup) => {
    const name = editName.trim();
    if (!name || name === g.name) {
      setEditingId(null);
      return;
    }
    try {
      await buildingAdminApi.patch(
        `/building-admin/buildings/${buildingId}/contact-groups/${g.id}`,
        { name },
      );
      setEditingId(null);
      load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? "Nie udało się zmienić nazwy");
    }
  };

  const confirmDelete = async () => {
    if (!deleteGroup) return;
    try {
      await buildingAdminApi.delete(
        `/building-admin/buildings/${buildingId}/contact-groups/${deleteGroup.id}`,
      );
      setDeleteGroup(null);
      load();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? "Nie udało się usunąć grupy");
    }
  };

  if (loading) {
    return (
      <div className="ba-panel">
        <div className="ba-empty">Ładowanie grup kontaktowych…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="ba-panel">
        <div className="ba-empty">
          <div className="ico">
            <BookUser size={22} />
          </div>
          <h4>Błąd</h4>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const groups = data?.groups ?? [];
  const unassigned = data?.unassignedUnits ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── Nagłówek + dodawanie grupy ── */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <BookUser size={16} />
            Grupy kontaktowe
            <span className="pill">{groups.length}</span>
          </div>
          <div className="ba-panel-tools">
            <button
              type="button"
              className="ba-btn primary"
              style={{ padding: "10px 18px", fontSize: 14 }}
              onClick={() => setShowAdd((v) => !v)}
            >
              <Plus size={16} />
              Dodaj grupę
            </button>
          </div>
        </div>
        <div style={{ padding: "12px 14px", fontSize: 13, color: "var(--muted)" }}>
          Pogrupuj lokale tak, jak mają być widoczne na ekranie domofonu — np. „Budynek 1",
          „Budynek 2", „ulica Komfortowa". Każdy lokal może należeć do jednej grupy.
        </div>
        {showAdd ? (
          <div
            style={{
              padding: "0 14px 14px",
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <input
              className="ba-input"
              style={{ maxWidth: 320, fontSize: 14 }}
              placeholder="Nazwa grupy, np. Budynek 1"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createGroup();
              }}
              autoFocus
            />
            <button
              type="button"
              className="ba-btn primary"
              style={{ padding: "10px 18px", fontSize: 14 }}
              onClick={createGroup}
              disabled={saving || !newName.trim()}
            >
              <Check size={16} />
              Zapisz
            </button>
            <button
              type="button"
              className="ba-btn"
              style={{ padding: "10px 14px", fontSize: 14 }}
              onClick={() => {
                setShowAdd(false);
                setNewName("");
              }}
            >
              <X size={16} />
              Anuluj
            </button>
          </div>
        ) : null}

        {groups.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <BookUser size={22} />
            </div>
            <h4>Brak grup kontaktowych</h4>
            <p>
              Kliknij „Dodaj grupę", aby utworzyć pierwszą grupę (np. „Budynek 1"), a potem
              przypisz do niej lokale.
            </p>
          </div>
        ) : (
          <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
            {groups.map((g) => (
              <div
                key={g.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {editingId === g.id ? (
                    <>
                      <input
                        className="ba-input"
                        style={{ maxWidth: 260, fontSize: 14 }}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") renameGroup(g);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        autoFocus
                      />
                      <button
                        type="button"
                        className="ba-btn primary sm"
                        onClick={() => renameGroup(g)}
                      >
                        <Check size={14} />
                        Zapisz
                      </button>
                      <button type="button" className="ba-btn sm" onClick={() => setEditingId(null)}>
                        Anuluj
                      </button>
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: 15, fontWeight: 700 }}>{g.name}</span>
                      <span className="ba-pill blue">
                        {g.units.length}{" "}
                        {g.units.length === 1 ? "lokal" : g.units.length < 5 ? "lokale" : "lokali"}
                      </span>
                      <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="ba-btn"
                          style={{ padding: "8px 14px", fontSize: 13.5 }}
                          onClick={() => setAssignGroup(g)}
                        >
                          <Home size={15} />
                          Przypisz lokale
                        </button>
                        <button
                          type="button"
                          className="ba-btn"
                          style={{ padding: "8px 12px", fontSize: 13.5 }}
                          onClick={() => {
                            setEditingId(g.id);
                            setEditName(g.name);
                          }}
                        >
                          <Pencil size={14} />
                          Zmień nazwę
                        </button>
                        <button
                          type="button"
                          className="ba-btn danger"
                          style={{ padding: "8px 12px", fontSize: 13.5 }}
                          onClick={() => setDeleteGroup(g)}
                        >
                          <Trash2 size={14} />
                          Usuń
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {g.units.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                    Brak przypisanych lokali — kliknij „Przypisz lokale".
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {g.units.map((u) => (
                      <span key={u.id} className="ba-pill">
                        {unitLabel(u)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Lokale bez grupy ── */}
      <div className="ba-panel">
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <Home size={16} />
            Lokale bez grupy
            <span className="pill">{unassigned.length}</span>
          </div>
        </div>
        {unassigned.length === 0 ? (
          <div style={{ padding: 14, fontSize: 13, color: "var(--muted)" }}>
            Wszystkie lokale są przypisane do grup.
          </div>
        ) : (
          <div style={{ padding: 14, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {unassigned.map((u) => (
              <span key={u.id} className="ba-pill">
                {unitLabel(u)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Synchronizacja z domofonem ── */}
      <SyncSection buildingId={buildingId} phonebook={phonebook} />

      {/* ── Modale ── */}
      {assignGroup ? (
        <AssignUnitsModal
          buildingId={buildingId}
          group={assignGroup}
          allGroups={groups}
          unassigned={unassigned}
          onClose={() => setAssignGroup(null)}
          onSaved={() => {
            setAssignGroup(null);
            load();
          }}
        />
      ) : null}

      {deleteGroup ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,17,20,0.4)",
            backdropFilter: "blur(2px)",
            zIndex: 70,
            display: "grid",
            placeItems: "center",
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteGroup(null);
          }}
        >
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 14,
              padding: 20,
              width: "100%",
              maxWidth: 420,
              display: "grid",
              gap: 14,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700 }}>Usunąć grupę „{deleteGroup.name}"?</div>
            <p style={{ fontSize: 13.5, color: "var(--ink-2)", margin: 0 }}>
              Lokale z tej grupy ({deleteGroup.units.length}) <strong>nie zostaną usunięte</strong>{" "}
              — wrócą do listy „Lokale bez grupy".
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="ba-btn"
                style={{ padding: "10px 16px", fontSize: 14 }}
                onClick={() => setDeleteGroup(null)}
              >
                Anuluj
              </button>
              <button
                type="button"
                className="ba-btn danger"
                style={{ padding: "10px 16px", fontSize: 14 }}
                onClick={confirmDelete}
              >
                <Trash2 size={15} />
                Usuń grupę
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Modal przypisywania lokali (checkboxy + licznik) ─────────────────────────
function AssignUnitsModal({
  buildingId,
  group,
  allGroups,
  unassigned,
  onClose,
  onSaved,
}: {
  buildingId: number;
  group: ContactGroup;
  allGroups: ContactGroup[];
  unassigned: UnitLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Pełna lista lokali budynku = lokale tej grupy + innych grup + bez grupy.
  // Lokal z innej grupy można zaznaczyć — zostanie PRZENIESIONY (pokazujemy
  // z jakiej grupy pochodzi, żeby to było jawne).
  const rows = useMemo(() => {
    const list: { unit: UnitLite; currentGroup: string | null }[] = [];
    for (const g of allGroups) {
      for (const u of g.units) list.push({ unit: u, currentGroup: g.id === group.id ? null : g.name });
    }
    for (const u of unassigned) list.push({ unit: u, currentGroup: null });
    // currentGroup === null dla lokali tej grupy też — rozróżniamy przez selected
    return list.sort((a, b) => compareNatural(unitLabel(a.unit), unitLabel(b.unit)));
  }, [allGroups, unassigned, group.id]);

  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(group.units.map((u) => u.id)),
  );
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const toggle = (unitId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      await buildingAdminApi.patch(
        `/building-admin/buildings/${buildingId}/contact-groups/${group.id}/units`,
        { unitIds: [...selected] },
      );
      onSaved();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      alert(e2.response?.data?.message ?? "Nie udało się zapisać przypisania");
      setBusy(false);
    }
  };

  const visible = rows.filter((r) =>
    unitLabel(r.unit).toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,17,20,0.4)",
        backdropFilter: "blur(2px)",
        zIndex: 70,
        display: "grid",
        placeItems: "center",
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 20,
          width: "100%",
          maxWidth: 520,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            Przypisz lokale do grupy „{group.name}"
          </div>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 2 }}>
            Zaznaczone: <strong>{selected.size}</strong> z {rows.length}. Lokal może należeć tylko
            do jednej grupy — zaznaczenie lokalu z innej grupy przenosi go tutaj.
          </div>
        </div>

        <input
          className="ba-input"
          placeholder="Szukaj lokalu…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ fontSize: 14 }}
        />

        <div
          style={{
            overflowY: "auto",
            minHeight: 120,
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {visible.length === 0 ? (
            <div style={{ padding: 14, fontSize: 13, color: "var(--muted)" }}>Brak lokali.</div>
          ) : (
            visible.map(({ unit, currentGroup }) => {
              const checked = selected.has(unit.id);
              return (
                <label
                  key={unit.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 10px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: checked ? "var(--blue-50)" : "transparent",
                    fontSize: 14,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(unit.id)}
                    style={{ width: 18, height: 18, accentColor: "var(--blue-600, #2563eb)" }}
                  />
                  <span style={{ fontWeight: 600 }}>{unitLabel(unit)}</span>
                  {currentGroup && !checked ? (
                    <span className="ba-pill amber" style={{ marginLeft: "auto" }}>
                      {currentGroup}
                    </span>
                  ) : null}
                  {currentGroup && checked ? (
                    <span className="ba-pill blue" style={{ marginLeft: "auto" }}>
                      przeniesiony z: {currentGroup}
                    </span>
                  ) : null}
                </label>
              );
            })
          )}
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            type="button"
            className="ba-btn"
            style={{ padding: "10px 16px", fontSize: 14 }}
            onClick={onClose}
            disabled={busy}
          >
            Anuluj
          </button>
          <button
            type="button"
            className="ba-btn primary"
            style={{ padding: "10px 18px", fontSize: 14 }}
            onClick={save}
            disabled={busy}
          >
            <Check size={15} />
            {busy ? "Zapisywanie…" : `Zapisz (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sekcja „Synchronizacja z domofonem" ──────────────────────────────────────
function SyncSection({
  buildingId,
  phonebook,
}: {
  buildingId: number;
  phonebook: PhonebookInfo | null;
}) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null);

  // Publiczny URL Remote Phonebook — base z konfiguracji axios (NEXT_PUBLIC_API_URL).
  const phonebookUrl = useMemo(() => {
    if (!phonebook) return null;
    const base = (buildingAdminApi.defaults.baseURL ?? "").replace(/\/$/, "");
    const host = phonebook.edgeLanIp ? `&host=${phonebook.edgeLanIp}` : "";
    return `${base}${phonebook.path}?b=${phonebook.buildingId}&t=${phonebook.token}${host}`;
  }, [phonebook]);

  const copyUrl = async () => {
    if (!phonebookUrl) return;
    try {
      await navigator.clipboard.writeText(phonebookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard niedostępny — user może zaznaczyć ręcznie */
    }
  };

  const downloadTgz = async () => {
    setDownloading(true);
    setDownloadMsg(null);
    try {
      const res = await buildingAdminApi.get(
        `/building-admin/buildings/${buildingId}/akuvox-userdata.tgz`,
        { responseType: "blob" },
      );
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "UserData.tgz";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadMsg("Pobrano UserData.tgz — zaimportuj na stacji: Directory → User → Import.");
    } catch {
      setDownloadMsg("Nie udało się pobrać pliku.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="ba-panel">
      <div className="ba-panel-head">
        <div className="ba-panel-title">
          <Phone size={16} />
          Synchronizacja z domofonem
        </div>
      </div>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* R29 — Remote Phonebook */}
        <div>
          <div className="ba-section-label" style={{ marginBottom: 6 }}>
            Stacja z ekranem (Akuvox R29) — Remote Phonebook
          </div>
          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "0 0 8px" }}>
            Stacja pobiera listę kontaktów (z grupami) sama, z poniższego adresu. Adres wkleja się
            RAZ w konfiguracji stacji (<em>Contacts → Remote Phonebook / Phone Book URL</em>) —
            potem stacja odświeża listę automatycznie co ustawiony interwał. Po zmianie grup nie
            trzeba nic robić.
          </p>
          {phonebookUrl ? (
            <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap" }}>
              <code
                className="ba-mono"
                style={{
                  flex: "1 1 320px",
                  fontSize: 12,
                  padding: "10px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  background: "var(--surface-2)",
                  overflowX: "auto",
                  whiteSpace: "nowrap",
                }}
              >
                {phonebookUrl}
              </code>
              <button
                type="button"
                className="ba-btn"
                style={{ padding: "10px 16px", fontSize: 14 }}
                onClick={copyUrl}
              >
                {copied ? <Check size={15} /> : <Copy size={15} />}
                {copied ? "Skopiowano" : "Kopiuj adres"}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>
              Nie udało się pobrać adresu książki adresowej.
            </div>
          )}
          {phonebook && !phonebook.edgeLanIp ? (
            <p style={{ fontSize: 12, color: "var(--amber, #b45309)", margin: "6px 0 0" }}>
              Uwaga: brak adresu IP huba Edge w bazie — adres nie zawiera parametru „host".
              Stacja musi mieć skonfigurowane konto SIP / outbound proxy.
            </p>
          ) : null}
          {phonebook?.edgeLanIp ? (
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 0" }}>
              Parametr „host" ({phonebook.edgeLanIp}) to adres huba Edge zapisany w systemie —
              powinien być adresem w sieci lokalnej stacji (zwykle 192.168.x.x). Jeśli jest inny,
              popraw go przy wklejaniu lub skontaktuj się z integratorem.
            </p>
          ) : null}
        </div>

        {/* E18 — UserData.tgz */}
        <div>
          <div className="ba-section-label" style={{ marginBottom: 6 }}>
            Stacja bez Remote Phonebook (Akuvox E18) — import pliku
          </div>
          <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "0 0 8px" }}>
            Ta stacja nie pobiera listy sama — po każdej zmianie grup lub mieszkańców pobierz plik
            i zaimportuj go na stacji: <strong>Directory → User → Import</strong>. Grupy pojawią
            się na ekranie stacji jako zakładki listy mieszkańców.
          </p>
          <button
            type="button"
            className="ba-btn primary"
            style={{ padding: "10px 18px", fontSize: 14 }}
            onClick={downloadTgz}
            disabled={downloading}
          >
            <Download size={15} />
            {downloading ? "Generuję…" : "Pobierz listę (UserData.tgz)"}
          </button>
          {downloadMsg ? (
            <p style={{ fontSize: 12.5, color: "var(--ink-2)", margin: "8px 0 0" }}>{downloadMsg}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
