"use client";
// Generyczna karta urządzenia (domofon / kamera). Pokazuje nazwę, IP, model,
// status online/offline. Status online dziedziczony z Edge (LAN reachable).
import type { LucideIcon } from "lucide-react";

interface Props {
  name: string;
  subtitle?: string | null;
  ipAddress: string | null;
  online: boolean;
  icon: LucideIcon;
  extras?: { label: string; value: string }[];
}

export function DeviceCard({ name, subtitle, ipAddress, online, icon: Icon, extras }: Props) {
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
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: online ? "var(--green-50)" : "var(--bg-2)",
            color: online ? "var(--green)" : "var(--muted)",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <Icon size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {name}
          </div>
          {subtitle ? (
            <div style={{ fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {subtitle}
            </div>
          ) : null}
        </div>
        <span className={`ba-pill ${online ? "green" : ""}`} style={{ flexShrink: 0 }}>
          {online ? (
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
          gap: 6,
          fontSize: 11.5,
          color: "var(--muted)",
        }}
      >
        <div>
          <span style={{ textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>IP: </span>
          <span className="ba-mono" style={{ color: "var(--ink-2)" }}>
            {ipAddress ?? "—"}
          </span>
        </div>
        {extras?.map((x) => (
          <div key={x.label}>
            <span style={{ textTransform: "uppercase", fontWeight: 600, letterSpacing: "0.05em" }}>
              {x.label}:{" "}
            </span>
            <span style={{ color: "var(--ink-2)" }}>{x.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
