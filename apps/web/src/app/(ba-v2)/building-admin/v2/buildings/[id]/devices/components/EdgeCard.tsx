"use client";
// Pojedyncza karta Edge Hub-a. Pokazuje status online/offline + outbox badge-y
// + akcje Ping/Restart. Status pill ma animated pulse gdy online.
import { Cpu, RefreshCw, Zap } from "lucide-react";
import { useState } from "react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import type { EdgeDevice } from "./types";

interface Props {
  edge: EdgeDevice;
  buildingId: number;
  onRefresh: () => void;
}

const fmtRelative = (iso: string | null): string => {
  if (!iso) return "nigdy";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "teraz";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} sek temu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min temu`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} godz temu`;
  const day = Math.floor(hr / 24);
  return `${day} dni temu`;
};

export function EdgeCard({ edge, buildingId, onRefresh }: Props) {
  const [busy, setBusy] = useState<"ping" | "restart" | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const ping = async () => {
    setBusy("ping");
    try {
      const res = await buildingAdminApi.post<{ online: boolean; lastSeenAt: string | null; ipAddress: string | null }>(
        `/building-admin/buildings/${buildingId}/devices/${edge.id}/ping`,
      );
      showToast(
        res.data.online
          ? `Online${res.data.ipAddress ? ` · ${res.data.ipAddress}` : ""}`
          : `Offline · ${fmtRelative(res.data.lastSeenAt)}`,
      );
      onRefresh();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      showToast(e2.response?.data?.message ?? "Błąd ping");
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    if (!window.confirm("Wysłać REBOOT do tego Edge? Restart zajmie ~30s.")) return;
    setBusy("restart");
    try {
      await buildingAdminApi.post(`/building-admin/buildings/${buildingId}/devices/${edge.id}/restart`);
      showToast("Komenda REBOOT wysłana");
      onRefresh();
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { message?: string } } };
      showToast(e2.response?.data?.message ?? "Błąd restart");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        borderRadius: 12,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: edge.online ? "var(--green-50)" : "var(--bg-2)",
            color: edge.online ? "var(--green)" : "var(--muted)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Cpu size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{edge.name ?? `Edge ${edge.id.slice(0, 8)}`}</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)" }} className="ba-mono">
            {edge.id}
          </div>
        </div>
        <span className={`ba-pill ${edge.online ? "green" : ""}`}>
          {edge.online ? (
            <>
              <span className="live-dot" />
              Online
            </>
          ) : (
            "Offline"
          )}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          fontSize: 12,
          color: "var(--muted)",
        }}
      >
        <div>
          <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>IP</div>
          <div className="ba-mono" style={{ color: "var(--ink-2)" }}>
            {edge.ipAddress ?? "—"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
            Ostatnio
          </div>
          <div style={{ color: "var(--ink-2)" }}>{fmtRelative(edge.lastSeenAt)}</div>
        </div>
        {edge.version ? (
          <div>
            <div
              style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}
            >
              Wersja
            </div>
            <div className="ba-mono" style={{ color: "var(--ink-2)" }}>
              {edge.version}
            </div>
          </div>
        ) : null}
        <div>
          <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
            Aktywowany
          </div>
          <div style={{ color: edge.isActivated ? "var(--green)" : "var(--amber)" }}>
            {edge.isActivated ? "Tak" : "Nie"}
          </div>
        </div>
      </div>

      {/* Outbox badges */}
      {edge.outbox.pending > 0 || edge.outbox.failed > 0 ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {edge.outbox.pending > 0 ? (
            <span className="ba-pill amber" title="Pending — czekają na dostarczenie do Edge">
              {edge.outbox.pending} pending
            </span>
          ) : null}
          {edge.outbox.failed > 0 ? (
            <span className="ba-pill red" title="Failed — 10× nieudana próba, deadletter">
              {edge.outbox.failed} failed
            </span>
          ) : null}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button type="button" className="ba-btn sm" disabled={busy !== null} onClick={ping}>
          <Zap size={13} /> {busy === "ping" ? "Ping…" : "Ping"}
        </button>
        <button
          type="button"
          className="ba-btn sm"
          disabled={busy !== null || !edge.online}
          onClick={restart}
          title={edge.online ? "Wyślij REBOOT przez WS" : "Edge offline — restart niemożliwy"}
        >
          <RefreshCw size={13} /> Restart
        </button>
      </div>

      {toast ? (
        <div
          style={{
            fontSize: 12,
            padding: "6px 10px",
            background: "var(--bg-2)",
            borderRadius: 6,
            color: "var(--ink-2)",
          }}
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
