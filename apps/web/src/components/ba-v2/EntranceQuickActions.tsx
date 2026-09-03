"use client";
// EntranceQuickActions — kompaktowe przyciski wejść w nagłówku panelu
// (2026-07-23, prośba Konrada: zamiast linków „Punkty dostępu / Urządzenia /
// Odczyty tablic" w pasku górnym mają być przyciski domofonu i podglądu
// z kamer). Jeden przycisk = jedno wejście; klik otwiera modal z podglądem
// NA ŻYWO (snapshot z domofonu co 2 s) i dużym „Otwórz wejście" — czyli
// pełny domofon w jednym przepływie. Logika przeniesiona 1:1 z karty
// Przegląd (CameraModal), żeby działała na KAŻDEJ zakładce.
import { useEffect, useState } from "react";
import { Check, DoorOpen, Video, X } from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { emojiFor } from "@/lib/access-point-icons";

export interface AccessPointRow {
  id: number;
  label: string;
  icon?: string | null;
  category?: string | null;
  unitId?: number | null;
  isActive?: boolean;
}

type OpenState = "idle" | "confirm" | "opening" | "done" | "error";

export function EntranceQuickActions({ buildingId }: { buildingId: number }) {
  const [aps, setAps] = useState<AccessPointRow[]>([]);
  const [cameraAp, setCameraAp] = useState<AccessPointRow | null>(null);

  useEffect(() => {
    if (!Number.isFinite(buildingId)) return;
    let cancelled = false;
    buildingAdminApi
      .get<AccessPointRow[]>(`/building-admin/buildings/${buildingId}/access-points`)
      .then((r) => {
        if (cancelled || !Array.isArray(r.data)) return;
        // UNIT_DOOR (prywatne zamki lokali, np. Nuki) nie są wejściami
        // wspólnymi — admin ich nie widzi i nie otwiera.
        setAps(
          r.data.filter(
            (a) => a.isActive !== false && a.category !== "UNIT_DOOR" && !a.unitId,
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setAps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [buildingId]);

  if (aps.length === 0) return null;

  return (
    <>
      {aps.map((ap) => (
        <button
          key={ap.id}
          type="button"
          className="ba-btn"
          onClick={() => setCameraAp(ap)}
          title={`Podgląd z kamery i otwieranie — ${ap.label}`}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>{emojiFor(ap.icon ?? "door")}</span>
          {ap.label}
          <Video size={13} style={{ opacity: 0.65 }} />
        </button>
      ))}
      {cameraAp ? (
        <CameraModal
          ap={cameraAp}
          buildingId={buildingId}
          onClose={() => setCameraAp(null)}
        />
      ) : null}
    </>
  );
}

// ── Modal kamery: snapshot z domofonu odświeżany co 2 s + „Otwórz wejście" ──
export function CameraModal({
  ap,
  buildingId,
  onClose,
}: {
  ap: AccessPointRow;
  buildingId: number;
  onClose: () => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [openState, setOpenState] = useState<OpenState>("idle");

  useEffect(() => {
    let cancelled = false;
    let currentUrl: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchFrame = async (live: boolean) => {
      try {
        const r = await buildingAdminApi.get(
          `/building-admin/buildings/${buildingId}/access-points/${ap.id}/snapshot`,
          { params: live ? { live: 1 } : {}, responseType: "blob" },
        );
        if (cancelled) return;
        const url = URL.createObjectURL(r.data as Blob);
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = url;
        setImgUrl(url);
        setError(false);
      } catch {
        if (!cancelled && !currentUrl) setError(true);
      }
      if (!cancelled) timer = setTimeout(() => void fetchFrame(true), 2000);
    };

    // Pierwsza klatka z cache Edge (szybka), kolejne live.
    void fetchFrame(false);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [ap.id, buildingId]);

  const doOpen = async () => {
    setOpenState("opening");
    try {
      await buildingAdminApi.post(
        `/building-admin/buildings/${buildingId}/access-points/${ap.id}/open`,
      );
      setOpenState("done");
      setTimeout(() => setOpenState("idle"), 3500);
    } catch {
      setOpenState("error");
      setTimeout(() => setOpenState("idle"), 3500);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(10,14,25,0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface, #fff)",
          borderRadius: 18,
          width: "min(720px, 100%)",
          overflow: "hidden",
          boxShadow: "0 30px 80px rgba(0,0,0,0.45)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: 22 }}>{emojiFor(ap.icon ?? "door")}</span>
          <div style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>
            {ap.label} — podgląd z kamery
          </div>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              fontWeight: 700,
              color: "var(--red, #dc2626)",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "var(--red, #dc2626)",
              }}
            />
            NA ŻYWO
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij podgląd"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "transparent",
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div
          style={{
            background: "#0b0f1a",
            aspectRatio: "4 / 3",
            display: "grid",
            placeItems: "center",
          }}
        >
          {error ? (
            <div style={{ color: "#9aa4b8", fontSize: 15, textAlign: "center", padding: 24 }}>
              Brak podglądu z kamery dla tego wejścia.
            </div>
          ) : imgUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgUrl}
              alt={`Podgląd z kamery — ${ap.label}`}
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          ) : (
            <div style={{ color: "#9aa4b8", fontSize: 14 }}>Łączenie z kamerą…</div>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, padding: "14px 18px" }}>
          <button
            type="button"
            onClick={doOpen}
            disabled={openState === "opening"}
            style={{
              flex: 1,
              padding: "12px 16px",
              borderRadius: 12,
              border: "none",
              background:
                openState === "done"
                  ? "var(--green, #059669)"
                  : openState === "error"
                    ? "var(--red, #dc2626)"
                    : "#2563eb",
              color: "#fff",
              fontSize: 15.5,
              fontWeight: 700,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            {openState === "done" ? <Check size={17} /> : <DoorOpen size={17} />}
            {openState === "opening"
              ? "Otwieranie…"
              : openState === "done"
                ? "Otwarto"
                : openState === "error"
                  ? "Nie udało się — spróbuj ponownie"
                  : "Otwórz wejście"}
          </button>
        </div>
      </div>
    </div>
  );
}
