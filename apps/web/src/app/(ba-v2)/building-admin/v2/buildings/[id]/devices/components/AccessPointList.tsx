"use client";
// Lista punktów dostępu z drag-drop sortowaniem + edit modal.
// Przeniesione z `(building-admin-dashboard)/.../access-points/page.tsx`,
// dopasowane do designu ba-v2 (ba-pill, ba-btn, ba-input).
import { useCallback, useEffect, useState } from "react";
import { DoorOpen, Edit3, GripVertical } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import {
  ACCESS_POINT_ICONS,
  AccessPointIcon,
  ICON_EMOJI,
  ICON_LABEL,
  emojiFor,
} from "@/lib/access-point-icons";
import type { AccessPoint, AccessPointSchedule } from "./types";
import { BUILDING_TZ } from "@/lib/building-time";

interface Props {
  buildingId: number;
}

export function AccessPointList({ buildingId }: Props) {
  const [items, setItems] = useState<AccessPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    buildingAdminApi
      .get<AccessPoint[]>(`/building-admin/buildings/${buildingId}/access-points`)
      .then((r) => setItems(r.data))
      .catch((err: unknown) => {
        const e2 = err as { response?: { data?: { message?: string } } };
        setError(e2.response?.data?.message ?? "Błąd ładowania");
      })
      .finally(() => setLoading(false));
  }, [buildingId]);

  useEffect(() => {
    load();
  }, [load]);

  const persistOrder = async (newOrder: AccessPoint[]) => {
    setSaving(true);
    try {
      await buildingAdminApi.patch(
        `/building-admin/buildings/${buildingId}/access-points/reorder`,
        { ids: newOrder.map((x) => x.id) },
      );
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setError(e2.response?.data?.message ?? "Błąd zapisu kolejności");
      load();
    } finally {
      setSaving(false);
    }
  };

  const onDragStart = (e: React.DragEvent<HTMLLIElement>, id: number) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(id));
  };
  const onDragOver = (e: React.DragEvent<HTMLLIElement>, overId: number) => {
    e.preventDefault();
    if (overId !== hoverId) setHoverId(overId);
  };
  const onDrop = async (e: React.DragEvent<HTMLLIElement>, targetId: number) => {
    e.preventDefault();
    if (draggingId === null || draggingId === targetId) {
      setDraggingId(null);
      setHoverId(null);
      return;
    }
    const fromIdx = items.findIndex((x) => x.id === draggingId);
    const toIdx = items.findIndex((x) => x.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...items];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    setItems(next);
    setDraggingId(null);
    setHoverId(null);
    await persistOrder(next);
  };
  const onDragEnd = () => {
    setDraggingId(null);
    setHoverId(null);
  };

  return (
    <div className="ba-panel">
      <div className="ba-panel-head">
        <div className="ba-panel-title">
          <DoorOpen size={16} />
          Punkty dostępu
          <span className="pill">{items.length}</span>
        </div>
        <div className="ba-panel-tools">
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
            Przeciągnij, aby zmienić kolejność widoczną dla mieszkańców
          </span>
        </div>
      </div>

      {error ? (
        <div className="ba-pill red" style={{ display: "block", margin: 12, padding: "8px 12px" }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="ba-empty">Ładowanie…</div>
      ) : items.length === 0 ? (
        <div className="ba-empty">
          <div className="ico">
            <DoorOpen size={22} />
          </div>
          <h4>Brak punktów dostępu</h4>
          <p>Edge nie zsynchronizował jeszcze urządzeń — sprawdź czy jest online powyżej.</p>
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((ap) => {
            const isDragging = draggingId === ap.id;
            const isHover = hoverId === ap.id && draggingId !== null && draggingId !== ap.id;
            return (
              <li
                key={ap.id}
                draggable
                onDragStart={(e) => onDragStart(e, ap.id)}
                onDragOver={(e) => onDragOver(e, ap.id)}
                onDrop={(e) => onDrop(e, ap.id)}
                onDragEnd={onDragEnd}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 32px 1fr auto auto",
                  gap: 10,
                  alignItems: "center",
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--border)",
                  cursor: "grab",
                  background: isHover ? "var(--blue-50)" : "transparent",
                  opacity: isDragging ? 0.4 : 1,
                  transition: "background 0.1s",
                }}
              >
                <GripVertical size={14} style={{ color: "var(--muted-2)" }} />
                <span style={{ fontSize: 22, lineHeight: 1, textAlign: "center" }}>{emojiFor(ap.icon)}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{ap.label}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }} className="ba-mono">
                    relay {ap.relayIndex} · {ap.deviceId.slice(0, 16)}…
                  </div>
                </div>
                {!ap.isActive ? (
                  <span className="ba-pill amber">Ukryty</span>
                ) : (
                  <span className="ba-pill green">Widoczny</span>
                )}
                <button
                  type="button"
                  className="ba-btn sm"
                  onClick={() => setEditingId(ap.id)}
                >
                  <Edit3 size={12} /> Edytuj
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {saving ? (
        <div style={{ padding: "8px 14px", fontSize: 11.5, color: "var(--muted)", background: "var(--surface-2)" }}>
          Zapisywanie kolejności…
        </div>
      ) : null}

      {editingId !== null ? (
        <EditModal
          ap={items.find((x) => x.id === editingId)!}
          buildingId={buildingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function EditModal({
  ap,
  buildingId,
  onClose,
  onSaved,
}: {
  ap: AccessPoint;
  buildingId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(ap.label);
  const [icon, setIcon] = useState<AccessPointIcon>((ap.icon as AccessPointIcon) || "door");
  const [isActive, setIsActive] = useState(ap.isActive);
  // 2026-06-02 — binding read-only po stronie BA (techniczna konfiguracja
  // jest w panelu integratora). Trzymamy wartości żeby je wyświetlić, ale
  // nie wysyłamy w PATCH (Cloud zachowuje stan przy nieobecnych polach).
  const outputDeviceId = ap.outputDeviceId ?? ap.deviceId ?? "";
  const outputIndex = ap.outputIndex ?? ap.relayIndex ?? 0;
  const durationMs = ap.durationMs ?? 800;
  const [scope, setScope] = useState<NonNullable<AccessPoint["scope"]>>(ap.scope ?? "RESIDENT");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setError("Nazwa nie może być pusta");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // BA wysyła tylko logiczne pola — binding (outputDeviceId/outputIndex/durationMs)
      // zostaje w gestii integratora. Backend zachowuje istniejące wartości
      // przy nieobecnych polach w PATCH.
      await buildingAdminApi.patch(`/building-admin/buildings/${buildingId}/access-points/${ap.id}`, {
        label: label.trim(),
        icon,
        isActive,
        scope,
      });
      onSaved();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setError(e2.response?.data?.message ?? "Błąd zapisu");
    } finally {
      setSaving(false);
    }
  };

  const testFire = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/access-points/${ap.id}/test-fire`,
      );
      setTestResult("✓ Komenda wysłana");
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      setTestResult(`✗ ${e2.response?.data?.message ?? "Błąd"}`);
    } finally {
      setTesting(false);
    }
  };

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
      <form
        onSubmit={save}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 20,
          width: "100%",
          maxWidth: 440,
          display: "grid",
          gap: 14,
        }}
      >
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Edytuj punkt dostępu</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }} className="ba-mono">
            relay {ap.relayIndex} · {ap.deviceId}
          </div>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>Nazwa</span>
          <input
            className="ba-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="np. Wjazd główny"
            autoFocus
          />
        </label>

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 6 }}>Ikona</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
            {ACCESS_POINT_ICONS.map((ic) => {
              const sel = icon === ic;
              return (
                <button
                  key={ic}
                  type="button"
                  onClick={() => setIcon(ic)}
                  className="ba-btn"
                  style={{
                    flexDirection: "column",
                    padding: "10px 6px",
                    gap: 4,
                    background: sel ? "var(--blue-50)" : "var(--surface)",
                    borderColor: sel ? "var(--blue)" : "var(--border)",
                    color: sel ? "var(--blue-600)" : "var(--ink-2)",
                  }}
                  title={ICON_LABEL[ic]}
                >
                  <span style={{ fontSize: 22, lineHeight: 1 }}>{ICON_EMOJI[ic]}</span>
                  <span style={{ fontSize: 10 }}>{ICON_LABEL[ic]}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ── 2026-06-02: binding jest READ-ONLY w BA. ── */}
        {/* Konfiguracja techniczna (które urządzenie / wyjście / czas impulsu)
            należy do integratora (`/integrator/buildings/:id/devices`). BA widzi
            tylko status, żeby wiedzieć "co jest podłączone" przy diagnostyce. */}
        <div style={{
          display: "grid", gap: 4,
          padding: 10,
          borderRadius: 8,
          background: "var(--bg-2)",
          border: "1px solid var(--border)",
        }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Powiązane wyjście
          </span>
          <div style={{ fontSize: 13, color: "var(--ink)" }}>
            {outputDeviceId
              ? <>
                  <span className="ba-mono" style={{ fontSize: 12 }}>{outputDeviceId.slice(0, 8)}…</span>
                  {" · wyjście "}
                  <strong>{outputIndex}</strong>
                  {" · impuls "}
                  <strong>{durationMs}ms</strong>
                </>
              : <span style={{ color: "var(--muted)" }}>Niepowiązane (fallback legacy)</span>}
          </div>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            Konfiguracja techniczna w <a href={`/integrator/buildings/${buildingId}/devices`} style={{ color: "var(--blue)" }}>panelu integratora</a>
          </span>
        </div>

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
            Widoczność
          </span>
          <select
            className="ba-input"
            value={scope}
            onChange={(e) => setScope(e.target.value as NonNullable<AccessPoint["scope"]>)}
          >
            <option value="RESIDENT">Mieszkańcy</option>
            <option value="PUBLIC">Publiczny</option>
            <option value="ADMIN_ONLY">Tylko admin</option>
          </select>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            style={{ width: 16, height: 16 }}
          />
          <span style={{ fontSize: 13 }}>Pokazuj mieszkańcom w aplikacji</span>
        </label>

        {/* Test pulse */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>Test</span>
          <button
            type="button"
            className="ba-btn"
            onClick={testFire}
            disabled={testing}
          >
            🔧 Test pulse
          </button>
        </div>
        {testResult ? (
          <div style={{ fontSize: 12, color: testResult.startsWith("✓") ? "var(--emerald-700, #047857)" : "var(--red-700, #b91c1c)" }}>
            {testResult}
          </div>
        ) : null}

        {/* Schedules */}
        <SchedulesSection buildingId={buildingId} apId={ap.id} />

        {error ? (
          <div className="ba-pill red" style={{ display: "block", padding: "8px 12px" }}>
            {error}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="ba-btn" onClick={onClose}>
            Anuluj
          </button>
          <button type="submit" className="ba-btn primary" disabled={saving}>
            {saving ? "Zapisywanie…" : "Zapisz"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Schedules subsection (cron auto-open) ──────────────────────────────────
//
// Refactor 2026-06-01. Endpoint-y:
//   GET    /building-admin/buildings/:bid/access-points/:apId/schedules
//   POST   /building-admin/buildings/:bid/access-points/:apId/schedules
//   PATCH  /building-admin/buildings/:bid/schedules/:scheduleId
//   DELETE /building-admin/buildings/:bid/schedules/:scheduleId
function SchedulesSection({ buildingId, apId }: { buildingId: number; apId: number }) {
  const [items, setItems] = useState<AccessPointSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [newCron, setNewCron] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    buildingAdminApi
      .get<AccessPointSchedule[]>(`/building-admin/buildings/${buildingId}/access-points/${apId}/schedules`)
      .then((r) => setItems(r.data))
      .catch((e: unknown) => {
        const e2 = e as { response?: { data?: { message?: string } } };
        setErr(e2.response?.data?.message ?? "Błąd");
      })
      .finally(() => setLoading(false));
  }, [buildingId, apId]);

  useEffect(() => { load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCron.trim()) return;
    setBusy(true); setErr(null);
    try {
      await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/access-points/${apId}/schedules`,
        { cronExpr: newCron.trim(), label: newLabel.trim() || undefined, enabled: true },
      );
      setNewCron(""); setNewLabel("");
      load();
    } catch (e: unknown) {
      const e2 = e as { response?: { data?: { message?: string } } };
      setErr(e2.response?.data?.message ?? "Błąd");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: AccessPointSchedule) => {
    setBusy(true);
    try {
      await buildingAdminApi.patch(`/building-admin/buildings/${buildingId}/schedules/${s.id}`, { enabled: !s.enabled });
      load();
    } catch (e: unknown) {
      const e2 = e as { response?: { data?: { message?: string } } };
      setErr(e2.response?.data?.message ?? "Błąd");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: AccessPointSchedule) => {
    if (!confirm(`Usunąć harmonogram „${s.label ?? s.cronExpr}"?`)) return;
    setBusy(true);
    try {
      await buildingAdminApi.delete(`/building-admin/buildings/${buildingId}/schedules/${s.id}`);
      load();
    } catch (e: unknown) {
      const e2 = e as { response?: { data?: { message?: string } } };
      setErr(e2.response?.data?.message ?? "Błąd");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 6, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)" }}>
          Harmonogramy (cron)
        </span>
        <span style={{ fontSize: 11, color: "var(--muted)" }} className="ba-mono">
          min h dz mies dzTyg
        </span>
      </div>
      {loading ? (
        <span style={{ fontSize: 12, color: "var(--muted)" }}>Ładowanie…</span>
      ) : items.length === 0 ? (
        <span style={{ fontSize: 12, color: "var(--muted)" }}>Brak — dodaj poniżej.</span>
      ) : (
        <ul style={{ display: "grid", gap: 4, listStyle: "none", margin: 0, padding: 0 }}>
          {items.map((s) => (
            <li key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={() => toggle(s)}
                disabled={busy}
                style={{ width: 14, height: 14 }}
                title={s.enabled ? "Aktywny" : "Wyłączony"}
              />
              <code className="ba-mono" style={{ background: "var(--gray-50, #f3f4f6)", padding: "1px 6px", borderRadius: 4, fontSize: 11 }}>
                {s.cronExpr}
              </code>
              <span style={{ flex: 1, color: "var(--ink-2)" }}>{s.label ?? "—"}</span>
              {s.lastFiredAt ? (
                <span style={{ fontSize: 10, color: "var(--muted)" }} title="Ostatnio">
                  ⏱ {new Date(s.lastFiredAt).toLocaleString("pl-PL", { timeZone: BUILDING_TZ })}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => remove(s)}
                disabled={busy}
                className="ba-btn"
                style={{ fontSize: 11, padding: "2px 8px" }}
              >
                Usuń
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <input
          className="ba-input ba-mono"
          style={{ width: 130, fontSize: 12 }}
          value={newCron}
          onChange={(e) => setNewCron(e.target.value)}
          placeholder="0 18 * * *"
        />
        <input
          className="ba-input"
          style={{ flex: 1, fontSize: 12 }}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Etykieta (opcj.)"
        />
        <button
          type="submit"
          className="ba-btn primary"
          disabled={busy || !newCron.trim()}
          style={{ fontSize: 12 }}
        >
          + Dodaj
        </button>
      </form>
      {err ? <span style={{ fontSize: 11, color: "var(--red-700, #b91c1c)" }}>{err}</span> : null}
    </div>
  );
}
