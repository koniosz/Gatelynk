"use client";
// Karta kamery LPR — READ-ONLY w panelu BA. Pokazuje status + powiązanie
// z AccessPoint-em (tylko display, bez edycji).
//
// 2026-06-02: edycja `linkedAccessPointId` przeniesiona do panelu Integratora
// (`/integrator/buildings/:id/devices`). BA widzi tylko „co jest powiązane",
// żeby wiedzieć przy diagnostyce („LPR Wjazd → szlaban Wjazd"). Wiring
// techniczny zostaje w gestii integratora — ekipy która instalowała.
import { Camera } from "lucide-react";
import type { CameraDevice, AccessPoint } from "./types";

interface Props {
  camera: CameraDevice;
  accessPoints: AccessPoint[];
  buildingId: number;
  onSaved: () => void;
}

export function LprCameraCard({ camera, accessPoints, buildingId }: Props) {
  const linked = camera.linkedAccessPointId ?? null;
  const linkedLabel = linked != null
    ? accessPoints.find((a) => a.id === linked)?.label ?? `AP #${linked}`
    : null;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        borderRadius: 12,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: camera.online ? "var(--green-50)" : "var(--bg-2)",
            color: camera.online ? "var(--green)" : "var(--muted)",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <Camera size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {camera.name}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {camera.manufacturer}{camera.model ? ` · ${camera.model}` : ""}
          </div>
        </div>
        <span className={`ba-pill ${camera.online ? "green" : ""}`} style={{ flexShrink: 0 }}>
          {camera.online ? (
            <>
              <span className="live-dot" />
              Online
            </>
          ) : (
            "Offline"
          )}
        </span>
      </div>

      {/* IP + Whitelist */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 11.5, color: "var(--muted)" }}>
        <div>
          <span style={{ textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>IP: </span>
          <span className="ba-mono" style={{ color: "var(--ink-2)" }}>{camera.ipAddress ?? "—"}</span>
        </div>
        <div>
          <span style={{ textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>Whitelist: </span>
          <span style={{ color: "var(--ink-2)" }}>{camera.whitelistMode}</span>
        </div>
      </div>

      {/* Linked AP — READ-ONLY badge. Edycja w integratorze. */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 2 }}>
        <div style={{ fontSize: 10, color: "var(--muted-2)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>
          Powiązany punkt dostępu
        </div>
        {linkedLabel ? (
          <div style={{ fontSize: 13, color: "var(--ink)" }}>
            <strong>{linkedLabel}</strong>
            <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 6 }}>
              · LPR match → executor
            </span>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            Niepowiązane — używa fallback legacy
          </div>
        )}
        <a
          href={`/integrator/buildings/${buildingId}/devices`}
          style={{
            display: "inline-block",
            fontSize: 11,
            color: "var(--muted)",
            marginTop: 6,
            textDecoration: "underline",
          }}
        >
          Zmień w panelu integratora →
        </a>
      </div>
    </div>
  );
}
