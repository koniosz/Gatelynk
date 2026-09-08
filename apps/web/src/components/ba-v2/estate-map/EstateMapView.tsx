"use client";
/**
 * Interaktywna mapa osiedla (2026-09-08) — render + klikalne obszary domów.
 *
 * Obszary z konfiguracji są w pikselach canvasu; tu przeliczamy na procenty,
 * więc mapa skaluje się z szerokością kolumny. Zoom = szerokość „plane"
 * jako wielokrotność viewportu (przewijanie natywne, bez transformów) —
 * po powiększeniu wybrany dom jest dosuwany do środka.
 *
 * Komponent NIE zna przypisań poza licznikami/flagami per część — logika
 * zapisu żyje na stronie (`map/page.tsx`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Minus, Plus, Maximize2, MapPin } from "lucide-react";
import styles from "./estate-map.module.css";
import type { EstateMapBuildingArea, EstateMapConfig, EstateSlotKey } from "@/lib/estate-map";
import { areaTitle } from "@/lib/estate-map";

const GATE_COLORS: Record<string, string> = { in: "#198457", out: "#305ad5", fire: "#b4473e" };

export interface EstateMapViewProps {
  config: EstateMapConfig;
  /** `${mapBuildingId}:${slot}` → true gdy część ma lokal. */
  assignedParts: Set<string>;
  selectedId: string | null;
  selectedSlot: EstateSlotKey;
  onSelect: (buildingId: string, slot: EstateSlotKey) => void;
  showLabels: boolean;
  onToggleLabels: () => void;
  /** Podsumowanie do stopki: przypisane / wszystkie części. */
  assignedCount: number;
  totalSlots: number;
}

export function EstateMapView({
  config, assignedParts, selectedId, selectedSlot, onSelect, showLabels, onToggleLabels, assignedCount, totalSlots,
}: EstateMapViewProps) {
  const [zoom, setZoom] = useState(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const { width: W, height: H } = config.canvas;

  const byId = useMemo(() => new Map(config.buildings.map((b) => [b.id, b])), [config.buildings]);

  // Po zmianie zoomu / wyboru — dosuń wybrany dom do środka viewportu.
  useEffect(() => {
    if (!selectedId || zoom <= 1) return;
    const vp = viewportRef.current;
    const b = byId.get(selectedId);
    if (!vp || !b) return;
    const planeW = vp.clientWidth * zoom;
    const planeH = planeW * (H / W);
    vp.scrollTo({
      left: (b.x / W) * planeW - vp.clientWidth / 2,
      top: (b.y / H) * planeH - vp.clientHeight / 2,
      behavior: "smooth",
    });
  }, [zoom, selectedId, byId, W, H]);

  const focusSelected = () => {
    if (!selectedId) return;
    setZoom((z) => (z < 2.5 ? 2.5 : z));
  };

  const pct = (v: number, base: number) => `${(v / base) * 100}%`;

  const houseStyle = (b: EstateMapBuildingArea): React.CSSProperties => ({
    left: pct(b.x - b.w / 2, W),
    top: pct(b.y - b.h / 2, H),
    width: pct(b.w, W),
    height: pct(b.h, H),
    ["--angle" as string]: `${b.a}deg`,
  });

  return (
    <section className={styles.mapCard} aria-label="Interaktywny widok osiedla">
      <div className={styles.toolbar}>
        <div className={styles.toolbarTitle}>
          <MapPin size={15} />
          {config.name}
        </div>
        <div className={styles.tools}>
          <button type="button" className="ba-btn sm" aria-pressed={showLabels} onClick={onToggleLabels}>
            Numery domów
          </button>
          <button
            type="button"
            className="ba-btn sm"
            aria-label="Oddal mapę"
            disabled={zoom <= 1}
            onClick={() => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(1)))}
          >
            <Minus size={13} />
          </button>
          <span className={styles.zoomLabel}>{zoom.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}×</span>
          <button
            type="button"
            className="ba-btn sm"
            aria-label="Przybliż mapę"
            disabled={zoom >= 3.5}
            onClick={() => setZoom((z) => Math.min(3.5, +(z + 0.5).toFixed(1)))}
          >
            <Plus size={13} />
          </button>
          <button type="button" className="ba-btn sm" onClick={() => setZoom(1)} title="Dopasuj do okna">
            <Maximize2 size={13} /> Dopasuj
          </button>
          <button type="button" className="ba-btn sm" onClick={focusSelected} disabled={!selectedId} title="Przybliż wybrany budynek">
            <Crosshair size={13} /> Wybrany
          </button>
        </div>
      </div>

      <div className={styles.viewport} ref={viewportRef} aria-label="Plan osiedla — wybierz budynek">
        <div
          className={styles.plane}
          data-labels={showLabels ? "true" : "false"}
          style={{
            width: `${zoom * 100}%`,
            ["--canvas-w" as string]: String(W),
            ["--canvas-h" as string]: String(H),
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={config.imageUrl} alt="" width={W} height={H} draggable={false} />

          {config.streets.map((s) => (
            <span key={s.label} className={styles.street} style={{ left: pct(s.x, W), top: pct(s.y, H) }}>
              {s.label}
            </span>
          ))}

          {config.gates.map((g) => (
            <span
              key={g.id}
              className={styles.gate}
              title={g.name}
              style={{ left: `${g.x * 100}%`, top: `${g.y * 100}%`, ["--gate-color" as string]: GATE_COLORS[g.id] ?? "#555" }}
            />
          ))}

          {config.buildings.map((b) => {
            const selected = b.id === selectedId;
            const n = b.slots.filter((s) => assignedParts.has(`${b.id}:${s}`)).length;
            return (
              <button
                key={b.id}
                type="button"
                className={styles.house}
                style={houseStyle(b)}
                aria-pressed={selected}
                aria-label={`${areaTitle(b)}; przypisano ${n} z ${b.unitCount} lokali`}
                onClick={(e) => {
                  const part = (e.target as HTMLElement).closest("[data-slot]") as HTMLElement | null;
                  const slot = (part?.dataset.slot as EstateSlotKey | undefined) ?? "A";
                  onSelect(b.id, b.slots.includes(slot) ? slot : "A");
                }}
              >
                {b.slots.map((s) => (
                  <span
                    key={s}
                    className={styles.part}
                    data-slot={s}
                    data-assigned={assignedParts.has(`${b.id}:${s}`) ? "true" : "false"}
                    data-active={selected && selectedSlot === s ? "true" : "false"}
                  >
                    <span className={styles.partLabel}>{b.unitCount === 1 ? "1" : s}</span>
                  </span>
                ))}
                <span className={styles.houseNumber}>{b.number ? `${b.street ? "" : "nr "}${b.number}` : "?"}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.mapFooter}>
        <div className={styles.legend}>
          <span><span className={styles.legendDot} style={{ background: "#2fbf7a" }} />część z lokalem</span>
          <span><span className={styles.legendDot} style={{ background: "#6ea4ff" }} />wybrana część</span>
          <span>Przypisano {assignedCount} / {totalSlots}</span>
        </div>
        <div className={styles.legend} aria-label="Bramy osiedla">
          {config.gates.map((g) => (
            <span key={g.id} className={styles.gateChip} style={{ ["--gate-color" as string]: GATE_COLORS[g.id] ?? "#555" }}>
              {g.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
