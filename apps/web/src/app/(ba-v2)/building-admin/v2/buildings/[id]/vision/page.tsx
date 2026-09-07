"use client";
/**
 * Wizja AI — BA v2 (2026-07-23).
 *
 * Migracja legacy strony `(building-admin-dashboard)/.../vision/page.tsx`
 * do nowego designu ba-v2 (tokeny ba-tokens.css, dark mode). Dashboard
 * detekcji YOLO z Edge (`vision_detections` w Edge sqlite, proxy przez Cloud).
 *
 * Endpointy (identyczne jak legacy):
 *   GET /building-admin/buildings/:id/vision/detections?since_hours&camera_id&class&limit
 *   GET /building-admin/buildings/:id/vision/stats?since_hours
 *   GET /building-admin/buildings/:id/vision/cameras
 *   GET /building-admin/buildings/:id/vision/frame/:filename  (obrazek, JWT Bearer
 *       — <img src> nie zadziała, fetch blob przez axios; miniatury LAZY przez
 *       LazyLprThumbnail: IntersectionObserver + semafor max 4 fetche)
 *
 * Filtry brand / napisy OCR / śmieciarki są CLIENT-SIDE (backend nie ma tych
 * paramów — brand i textRaw pochodzą z EasyOCR). Klasa "Zwierzęta" też
 * client-side (backend przyjmuje jedną klasę, a zwierzęta = dog|cat).
 *
 * Gdy lokalny Cloud nie ma połączenia z Edge → czytelny stan offline
 * (banner + zera w kaflach), bez crashy. Historyczne detekcje z Edge sqlite
 * mogą dalej przychodzić mimo AI offline — wtedy banner + lista.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  Car,
  Package,
  RefreshCw,
  ScanEye,
  Search,
  Trash2,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { buildingAdminApi } from "@/lib/building-admin-api";
import { buildingDate, buildingDayKey, buildingTime } from "@/lib/building-time";
import { LazyLprThumbnail } from "@/components/LazyLprThumbnail";
import { LprViewer } from "@/components/LprViewer";
import type { LprRead } from "@/lib/lpr";
import { useBuildingFeatures } from "@/components/ba-v2/BuildingFeaturesContext";

// ── Typy (struktura identyczna z legacy vision page) ─────────────────────────
interface Detection {
  id: number;
  cameraDeviceId: string;
  ts: number; // ms epoch
  inferenceMs: number | null;
  summary: Record<string, number>;
  imagePath: string | null;
  llmSummary?: string | null;
  brandDetected?: string | null;
  wasteCategory?: string | null;
  anomalyType?: string | null;
  fallLikelihood?: number | null;
  textRaw?: string[] | null;
  // 2026-08-14 — atrybuty pojazdu z VLM (typ semantyczny, marka, kolor).
  vehicleKind?: string | null;
  vehicleMake?: string | null;
  vehicleColor?: string | null;
  // 2026-08-15 — korelacja z rejestrem tablic (pojazd osiedla / gość).
  plateMatched?: string | null;
  plateMatchLabel?: string | null;
}

// 2026-08-15 — sugestie rozpoznań: powtarzające się NIEZAREJESTROWANE tablice.
interface PlateSuggestion {
  plate: string;
  reads: number;
  activeDays: number;
  spanDays: number;
  ins: number;
  outs: number;
  firstSeen: number;
  lastSeen: number;
  typicalInHour: string | null;
  typicalOutHour: string | null;
  verdict: "RESIDENT_LIKE" | "FREQUENT";
  suggestion: string;
}

/** Minimalny kształt odczytu LPR na potrzeby siatki snapshotów sugestii. */
interface LprReadLite {
  id: number;
  cameraDeviceId: string;
  plate: string;
  direction: string | null;
  ts: string; // ISO
}

const VEHICLE_KIND_LABELS: Record<string, string> = {
  osobowy: "Osobowy",
  dostawczy: "Dostawczy",
  ciezarowka: "Ciężarówka",
  bus: "Autobus",
  maszyna: "Maszyna bud.",
  inny: "Pojazd",
};

interface DetectionsResp {
  detections: Detection[];
  total: number;
}

interface StatsResp {
  sinceHours: number;
  totalFrames: number;
  byCamera: Record<string, Record<string, number>>;
  byClass: Record<string, number>;
}

interface CameraInfo {
  deviceId: string;
  type: string;
  name: string | null;
  ipAddress: string | null;
  manufacturer: string | null;
}

// ── Polskie odmiany ──────────────────────────────────────────────────────────
function plPlural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n);
  if (abs === 1) return forms[0];
  const m10 = abs % 10;
  const m100 = abs % 100;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
  return forms[2];
}

const PL_FORMS: Record<string, [string, string, string]> = {
  person: ["osoba", "osoby", "osób"],
  car: ["samochód", "samochody", "samochodów"],
  truck: ["ciężarówka", "ciężarówki", "ciężarówek"],
  bus: ["autobus", "autobusy", "autobusów"],
  motorcycle: ["motocykl", "motocykle", "motocykli"],
  bicycle: ["rower", "rowery", "rowerów"],
  dog: ["pies", "psy", "psów"],
  cat: ["kot", "koty", "kotów"],
  backpack: ["plecak", "plecaki", "plecaków"],
  handbag: ["torebka", "torebki", "torebek"],
  suitcase: ["walizka", "walizki", "walizek"],
  umbrella: ["parasolka", "parasolki", "parasolek"],
};

/** „2 osoby, 1 samochód" — czytelne podsumowanie klas po polsku. */
function plSummary(summary: Record<string, number>): string {
  const parts = Object.entries(summary)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([cls, n]) => {
      const forms = PL_FORMS[cls];
      return forms ? `${n} ${plPlural(n, forms)}` : `${n}× ${cls}`;
    });
  return parts.join(", ");
}

/**
 * Ludzki czas: „dziś o 14:32", „wczoraj o 20:49", „poniedziałek, 21 lipca o 09:15".
 * ZAWSZE w strefie osiedla (2026-08-15) — panel oglądany z innej strefy
 * czasowej pokazywał czasy przeglądarki; „dziś/wczoraj" też liczymy po
 * dniach kalendarzowych osiedla, nie widza.
 */
function humanTs(ms: number): string {
  const time = buildingTime(ms);
  const key = buildingDayKey(ms);
  if (key === buildingDayKey(Date.now())) return `dziś o ${time}`;
  if (key === buildingDayKey(Date.now() - 86_400_000)) return `wczoraj o ${time}`;
  return `${buildingDate(ms, { weekday: "long", day: "numeric", month: "long" })} o ${time}`;
}

// ── Filtry ───────────────────────────────────────────────────────────────────
const TIME_RANGES: { hours: string; label: string }[] = [
  { hours: "24", label: "24 godz." },
  { hours: "72", label: "3 dni" },
  { hours: "168", label: "7 dni" },
];

/** Klasy obiektów jako chipsy. „animal" = dog|cat, filtrowane lokalnie. */
const CLASS_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "Wszystkie" },
  { key: "person", label: "Osoby" },
  { key: "car", label: "Auta" },
  { key: "truck", label: "Ciężarówki" },
  { key: "bicycle", label: "Rowery" },
  { key: "animal", label: "Zwierzęta" },
];

/**
 * Sygnały „śmieciarka" w napisach OCR — logika WASTE_KEYWORDS z legacy.
 * EasyOCR mocno zniekształca napisy na ruchomych pojazdach, stąd fuzzy
 * regexy (krótkie prefixy frakcji, zniekształcone „MPO" itd.).
 */
const WASTE_REGEX: RegExp[] = [
  // Frakcje (krótkie prefixy — tolerancja literówek)
  /szk[lł]/i, /papie?/i, /pap[ij]/i, /plastik/i, /tworzyw/i, /metal/i,
  /zmiesz/i, /zmies/i, /\bbio\b/i, /zielone/i, /komunal/i,
  // Odpady — fuzzy
  /\bo[dt][a-z]{2,5}[yu]\b/i, /odpad/i, /odp[a-z]{2}y/i,
  /śmieci/i, /smieci/i, /wyw[oó]z/i,
  // Operatorzy
  /remond/i, /stena/i, /amest/i, /fbserwis/i, /\bmpgk\b/i, /\bmpo\b/i,
  /suez/i, /\bsita\b/i, /veolia/i, /tonsmeier/i, /eneris/i, /\bby[śs]\b/i,
  /\bfcc\b/i, /lemar/i, /ekosystem/i, /eko\s*system/i, /\bzgk\b/i,
  /\bpuk\b/i, /\bzuk\b/i,
  // MPO Warszawa — fuzzy
  /\b[mn][pf][od0]\b/i, /\b[mn][ef][eo]\b/i,
  /s\w*greg/i, /segreg/i, /[wm][ao]rsz[ao]w[ao]/i,
];

function isWasteDetection(d: Detection): boolean {
  if (d.wasteCategory) return true;
  return (d.textRaw ?? []).some((t) => WASTE_REGEX.some((re) => re.test(t)));
}

const PAGE_STEP = 60;
const POLL_MS = 30_000;

// ── Strona ───────────────────────────────────────────────────────────────────
export default function BaV2VisionPage() {
  const params = useParams();
  const idStr = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const buildingId = Number(idStr);
  const { hasBaFeature } = useBuildingFeatures();

  const [detections, setDetections] = useState<Detection[]>([]);
  const [stats, setStats] = useState<StatsResp | null>(null);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  // 403 = token nie obejmuje tego budynku (np. konto zalogowane na inne
  // osiedle) — to NIE jest awaria serwera AI i banner musi mówić prawdę.
  const [forbidden, setForbidden] = useState(false);

  // Filtry server-side
  const [sinceHours, setSinceHours] = useState("24");
  // 2026-08-21 — własny zakres dat/godzin (datetime-local); gdy oba ustawione,
  // wygrywa z chipami Okres (since_ts/until_ts w epoce ms).
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  // Nieskończone przewijanie: kolejne strony doklejane kursorem before_ts
  // (keyset po ts), w ramach wybranego zakresu.
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const pagedRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [filterCamera, setFilterCamera] = useState("");
  const [filterClass, setFilterClass] = useState("");
  const [limit, setLimit] = useState(PAGE_STEP);
  // Filtry client-side (brand/textRaw z EasyOCR — backend nie ma paramów)
  const [filterBrand, setFilterBrand] = useState("");
  const [filterText, setFilterText] = useState("");
  const [filterWaste, setFilterWaste] = useState(false);
  // 2026-08-15 — wyszukiwanie napisów SERWEROWO po całej historii:
  // filterText filtruje natychmiast to, co załadowane, a po 400 ms debounce
  // idzie do Edge jako `q` (bez okna czasowego) i lista zostaje ZASTĄPIONA
  // wynikami z pełnej historii.
  const [searchQuery, setSearchQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(filterText.trim()), 400);
    return () => clearTimeout(t);
  }, [filterText]);

  const [lightbox, setLightbox] = useState<Detection | null>(null);

  // 2026-08-15 — sugestie rozpoznań (powtarzające się niezarejestrowane
  // tablice). Ładowane raz na wejście; sekcja zwinięta domyślnie.
  const [suggestions, setSuggestions] = useState<PlateSuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  // Rozwinięcie pojedynczej sugestii (2026-08-15): wszystkie odczyty tej
  // tablicy ze zdjęciami z kamer + data/godzina pod każdym kadrem.
  const [expandedPlate, setExpandedPlate] = useState<string | null>(null);
  const [plateReads, setPlateReads] = useState<Record<string, LprReadLite[] | "loading">>({});
  // 2026-08-21 — „Identyfikuj" jak w Odczytach tablic: ostatnie odczyty
  // tablicy → ten sam LprViewer (POST nowy pojazd / PATCH istniejący,
  // pułapka #6). Otwierane z sugestii i z chipa 📋 na karcie detekcji.
  const [identifyReads, setIdentifyReads] = useState<LprRead[] | null>(null);
  const [identifyBusy, setIdentifyBusy] = useState<string | null>(null);

  const openIdentify = useCallback(
    (plate: string) => {
      setIdentifyBusy(plate);
      buildingAdminApi
        .get<{ reads: LprRead[] }>(
          `/building-admin/buildings/${buildingId}/lpr-reads?plate=${encodeURIComponent(plate)}&limit=12`,
        )
        .then((r) => {
          const reads = r.data.reads ?? [];
          if (reads.length > 0) setIdentifyReads(reads);
        })
        .finally(() => setIdentifyBusy(null));
    },
    [buildingId],
  );

  const refreshSuggestions = useCallback(() => {
    buildingAdminApi
      .get<{ suggestions: PlateSuggestion[] }>(
        `/building-admin/buildings/${buildingId}/vision/plate-suggestions?since_days=30`,
      )
      .then((r) => setSuggestions(r.data.suggestions ?? []))
      .catch(() => {});
  }, [buildingId]);

  const togglePlate = useCallback(
    (plate: string) => {
      setExpandedPlate((cur) => (cur === plate ? null : plate));
      setPlateReads((cur) => {
        if (cur[plate]) return cur;
        buildingAdminApi
          .get<{ reads: LprReadLite[] }>(
            `/building-admin/buildings/${buildingId}/lpr-reads?plate=${encodeURIComponent(plate)}&limit=24`,
          )
          .then((r) => setPlateReads((p) => ({ ...p, [plate]: r.data.reads ?? [] })))
          .catch(() => setPlateReads((p) => ({ ...p, [plate]: [] })));
        return { ...cur, [plate]: "loading" };
      });
    },
    [buildingId],
  );
  useEffect(() => {
    if (!Number.isFinite(buildingId) || buildingId <= 0) return;
    buildingAdminApi
      .get<{ suggestions: PlateSuggestion[] }>(
        `/building-admin/buildings/${buildingId}/vision/plate-suggestions?since_days=30`,
      )
      .then((r) => setSuggestions(r.data.suggestions ?? []))
      .catch(() => setSuggestions([]));
  }, [buildingId]);

  const visibleRef = useRef(true);

  const cameraNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cameras) m.set(c.deviceId, c.name ?? c.deviceId.slice(0, 8));
    return m;
  }, [cameras]);

  const load = useCallback(
    async (silent = false) => {
      if (!Number.isFinite(buildingId) || buildingId <= 0) return;
      // Silent refresh (polling) po doklejeniu stron zresetowałby przewinięte
      // wyniki do pierwszej strony — pomijamy go, dopóki user jest "w głębi".
      if (silent && pagedRef.current) return;
      if (!silent) setLoading(true);
      // Przy aktywnym wyszukiwaniu NIE wysyłamy since_hours — Edge przeszukuje
      // wtedy całą historię. Własny zakres dat (Od/Do) wygrywa ze wszystkim.
      const qs = new URLSearchParams({ limit: String(limit) });
      if (searchQuery) qs.set("q", searchQuery);
      const fromMs = customFrom ? Date.parse(customFrom) : NaN;
      const toMs = customTo ? Date.parse(customTo) : NaN;
      if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
        qs.set("since_ts", String(fromMs));
        qs.set("until_ts", String(toMs));
      } else if (!searchQuery) {
        qs.set("since_hours", sinceHours);
      }
      if (filterCamera) qs.set("camera_id", filterCamera);
      if (filterClass && filterClass !== "animal") qs.set("class", filterClass);

      // Osobne catch-e: detections z Edge sqlite mogą przyjść nawet gdy AI
      // offline (dane historyczne) — nie wiążemy losu listy z resztą.
      const [detRes, statsRes, camRes] = await Promise.allSettled([
        buildingAdminApi.get<DetectionsResp>(
          `/building-admin/buildings/${buildingId}/vision/detections?${qs.toString()}`,
        ),
        buildingAdminApi.get<StatsResp>(
          `/building-admin/buildings/${buildingId}/vision/stats?since_hours=${sinceHours}`,
        ),
        buildingAdminApi.get<{ cameras: CameraInfo[] }>(
          `/building-admin/buildings/${buildingId}/vision/cameras`,
        ),
      ]);

      if (detRes.status === "fulfilled") {
        const fresh = detRes.value.data.detections ?? [];
        setDetections(fresh);
        setHasMore(fresh.length >= limit);
        pagedRef.current = false;
      } else {
        setDetections([]);
        setHasMore(false);
      }
      if (statsRes.status === "fulfilled") setStats(statsRes.value.data);
      else setStats(null);
      if (camRes.status === "fulfilled") setCameras(camRes.value.data.cameras ?? []);

      const isForbidden = (r: PromiseSettledResult<unknown>) =>
        r.status === "rejected" &&
        (r.reason as { response?: { status?: number } })?.response?.status === 403;
      const anyForbidden = [detRes, statsRes, camRes].some(isForbidden);
      setForbidden(anyForbidden);
      setOffline(
        !anyForbidden && (detRes.status === "rejected" || statsRes.status === "rejected"),
      );
      if (!silent) setLoading(false);
    },
    [buildingId, sinceHours, limit, filterCamera, filterClass, searchQuery, customFrom, customTo],
  );

  // 2026-08-21 — kolejna strona: te same filtry + before_ts (ts < ostatni).
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || loading || detections.length === 0) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_STEP) });
      if (searchQuery) qs.set("q", searchQuery);
      const fromMs = customFrom ? Date.parse(customFrom) : NaN;
      const toMs = customTo ? Date.parse(customTo) : NaN;
      if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
        qs.set("since_ts", String(fromMs));
        qs.set("until_ts", String(toMs));
      } else if (!searchQuery) {
        qs.set("since_hours", sinceHours);
      }
      if (filterCamera) qs.set("camera_id", filterCamera);
      if (filterClass && filterClass !== "animal") qs.set("class", filterClass);
      qs.set("before_ts", String(detections[detections.length - 1].ts));
      const r = await buildingAdminApi.get<DetectionsResp>(
        `/building-admin/buildings/${buildingId}/vision/detections?${qs.toString()}`,
      );
      const next = r.data.detections ?? [];
      if (next.length > 0) {
        pagedRef.current = true;
        setDetections((cur) => [...cur, ...next]);
      }
      setHasMore(next.length >= PAGE_STEP);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [buildingId, detections, hasMore, loading, loadingMore, searchQuery, sinceHours, filterCamera, filterClass, customFrom, customTo]);

  // Sentinel na dole listy — wejście w viewport dokleja kolejną stronę.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void loadMore(); },
      { rootMargin: "600px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore]);

  useEffect(() => {
    void load();
  }, [load]);

  // Cichy refresh co 30 s — pauzuje gdy tab nieaktywny.
  useEffect(() => {
    const onVis = () => {
      visibleRef.current = document.visibilityState === "visible";
    };
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(() => {
      if (visibleRef.current) void load(true);
    }, POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(t);
    };
  }, [load]);

  // Marki w bieżącym oknie — liczone PRZED filtrem brand, żeby dało się
  // przełączać między markami.
  const brandCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of detections) {
      if (d.brandDetected) m.set(d.brandDetected, (m.get(d.brandDetected) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [detections]);

  const visible = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    // Gdy serwer już przefiltrował po `q` (searchQuery === wpisany tekst),
    // nie filtrujemy drugi raz — serwer matchuje też tablicę/markę/etykietę,
    // których może nie być w textRaw i client-side odsiałby trafienia.
    const serverFiltered = q !== "" && searchQuery.toLowerCase() === q;
    const matchesText = (d: Detection) =>
      (d.textRaw ?? []).some((t) => t.toLowerCase().includes(q)) ||
      (d.plateMatched ?? "").toLowerCase().includes(q) ||
      (d.plateMatchLabel ?? "").toLowerCase().includes(q) ||
      (d.vehicleMake ?? "").toLowerCase().includes(q) ||
      (d.brandDetected ?? "").toLowerCase().includes(q);
    return detections.filter((d) => {
      if (filterClass === "animal" && !(d.summary?.dog || d.summary?.cat)) return false;
      if (filterBrand && d.brandDetected !== filterBrand) return false;
      if (q && !serverFiltered && !matchesText(d)) return false;
      if (filterWaste && !isWasteDetection(d)) return false;
      return true;
    });
  }, [detections, filterClass, filterBrand, filterText, filterWaste, searchQuery]);

  // Kafle — zera zamiast NaN gdy stats niedostępne (offline).
  const tiles = useMemo(() => {
    const byClass = stats?.byClass ?? {};
    const n = (k: string) => (Number.isFinite(byClass[k]) ? byClass[k] : 0);
    return {
      frames: stats?.totalFrames ?? 0,
      vehicles: n("car") + n("truck") + n("bus") + n("motorcycle"),
      people: n("person"),
      brands: brandCounts.length,
    };
  }, [stats, brandCounts]);

  const rangeLabel = TIME_RANGES.find((r) => r.hours === sinceHours)?.label ?? "24 godz.";

  // Deep-link bez uprawnienia `feat_vision_dashboard` → notka, nie crash.
  if (!hasBaFeature("vision_dashboard")) {
    return (
      <div style={{ padding: 24, color: "var(--muted)" }}>
        Ta zakładka jest niedostępna — integrator wyłączył podgląd Wizji AI
        (vision_dashboard) dla tego obiektu.
      </div>
    );
  }

  return (
    <>
      {/* ── Kafle statystyk ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <StatCard
          icon={<ScanEye size={16} />}
          label={`Detekcje (${rangeLabel})`}
          value={tiles.frames}
          hint="klatki przeanalizowane przez AI"
        />
        <StatCard
          icon={<Car size={16} />}
          label="Pojazdy"
          value={tiles.vehicles}
          tone={tiles.vehicles > 0 ? "green" : "default"}
          hint="samochody, ciężarówki, autobusy"
        />
        <StatCard
          icon={<Users size={16} />}
          label="Osoby"
          value={tiles.people}
          tone={tiles.people > 0 ? "blue" : "default"}
          hint="piesi w kadrze kamer"
        />
        <StatCard
          icon={<Package size={16} />}
          label="Rozpoznane marki"
          value={tiles.brands}
          tone={tiles.brands > 0 ? "amber" : "default"}
          hint="firmy z napisów na pojazdach"
        />
      </div>

      <div className="ba-panel">
        {/* ── Nagłówek panelu ── */}
        <div className="ba-panel-head">
          <div className="ba-panel-title">
            <ScanEye size={16} />
            Wizja AI — co widzą kamery
            <span className="pill">{visible.length}</span>
          </div>
          <div className="ba-panel-tools" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" className="ba-btn sm" onClick={() => void load()} title="Odśwież">
              <RefreshCw size={13} /> Odśwież
            </button>
          </div>
        </div>

        {/* ── Banner brak dostępu (403 — token z innego osiedla) ── */}
        {forbidden ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
              background: "var(--amber-50)",
              color: "var(--ink)",
              fontSize: 13.5,
            }}
          >
            <AlertTriangle size={18} style={{ color: "var(--amber)", flexShrink: 0 }} />
            <span>
              <strong>Brak dostępu do tego obiektu</strong> — zalogowane konto nie ma
              uprawnień do tego budynku (to nie awaria serwera AI).{" "}
              <a href="/building-admin/login" style={{ fontWeight: 600 }}>
                Zaloguj się ponownie
              </a>{" "}
              na konto z dostępem.
            </span>
          </div>
        ) : null}

        {/* ── Banner offline ── */}
        {offline ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
              background: "var(--amber-50)",
              color: "var(--ink)",
              fontSize: 13.5,
            }}
          >
            <WifiOff size={18} style={{ color: "var(--amber)", flexShrink: 0 }} />
            <span>
              <strong>Serwer AI jest offline</strong> — detekcje pojawią się po jego
              uruchomieniu. Poniżej ostatnie zarejestrowane zdarzenia.
            </span>
          </div>
        ) : null}

        {/* ── Sugestie rozpoznań (2026-08-15) ── */}
        {suggestions.length > 0 ? (
          <div style={{ borderBottom: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => setSuggestionsOpen((o) => !o)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "10px 16px",
                background: "transparent",
                border: 0,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ink)",
                textAlign: "left",
              }}
            >
              💡 Sugestie rozpoznań
              <span className="ba-pill blue">{suggestions.length}</span>
              <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 12 }}>
                — powtarzające się tablice spoza rejestru osiedla (30 dni)
              </span>
              <span style={{ marginLeft: "auto", color: "var(--muted)" }}>
                {suggestionsOpen ? "zwiń ▴" : "rozwiń ▾"}
              </span>
            </button>
            {suggestionsOpen ? (
              <div style={{ padding: "0 16px 12px", display: "grid", gap: 8 }}>
                {suggestions.map((s) => {
                  const expanded = expandedPlate === s.plate;
                  const reads = plateReads[s.plate];
                  return (
                    <div
                      key={s.plate}
                      style={{
                        borderRadius: 10,
                        border: "1px solid var(--border)",
                        background:
                          s.verdict === "RESIDENT_LIKE" ? "var(--amber-50)" : "var(--bg-2)",
                        overflow: "hidden",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center" }}>
                      <button
                        type="button"
                        onClick={() => togglePlate(s.plate)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          flex: 1,
                          minWidth: 0,
                          padding: "8px 12px",
                          background: "transparent",
                          border: 0,
                          cursor: "pointer",
                          fontSize: 13,
                          flexWrap: "wrap",
                          textAlign: "left",
                          color: "inherit",
                        }}
                      >
                        <span className="ba-mono" style={{ fontWeight: 700, fontSize: 14 }}>
                          {s.plate}
                        </span>
                        <span
                          className={`ba-pill ${s.verdict === "RESIDENT_LIKE" ? "amber" : "blue"}`}
                        >
                          {s.verdict === "RESIDENT_LIKE"
                            ? "Prawdopodobnie mieszkaniec"
                            : "Częsty pojazd"}
                        </span>
                        <span style={{ color: "var(--ink-2)" }}>{s.suggestion}</span>
                        <span
                          style={{ color: "var(--muted)", fontSize: 12, whiteSpace: "nowrap" }}
                        >
                          {s.ins}× wjazd{s.typicalInHour ? ` (${s.typicalInHour})` : ""} ·{" "}
                          {s.outs}× wyjazd{s.typicalOutHour ? ` (${s.typicalOutHour})` : ""} ·{" "}
                          {s.reads} odczytów
                        </span>
                        <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 12 }}>
                          {expanded ? "zwiń ▴" : "zdjęcia ▾"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ba-btn"
                        onClick={() => openIdentify(s.plate)}
                        disabled={identifyBusy === s.plate}
                        title="Otwórz identyfikację — dodaj pojazd do rejestru osiedla"
                        style={{ margin: "0 10px", whiteSpace: "nowrap", fontSize: 12.5 }}
                      >
                        {identifyBusy === s.plate ? "Otwieram…" : "🪪 Identyfikuj"}
                      </button>
                      </div>
                      {expanded ? (
                        <div style={{ padding: "0 12px 12px" }}>
                          {reads === "loading" || reads == null ? (
                            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                              Ładuję odczyty…
                            </div>
                          ) : reads.length === 0 ? (
                            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                              Brak odczytów ze zdjęciami dla tej tablicy.
                            </div>
                          ) : (
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns:
                                  "repeat(auto-fill, minmax(150px, 1fr))",
                                gap: 10,
                              }}
                            >
                              {reads.map((r) => (
                                <figure key={r.id} style={{ margin: 0 }}>
                                  <LazyLprThumbnail
                                    apiClient={buildingAdminApi}
                                    url={`/building-admin/buildings/${buildingId}/lpr-reads/${r.id}/image`}
                                    alt={`${s.plate} — ${r.ts}`}
                                    style={{
                                      width: "100%",
                                      aspectRatio: "4 / 3",
                                      objectFit: "cover",
                                      borderRadius: 8,
                                      border: "1px solid var(--border)",
                                      background: "var(--bg-3)",
                                    }}
                                  />
                                  <figcaption
                                    style={{
                                      fontSize: 11,
                                      color: "var(--ink-2)",
                                      marginTop: 3,
                                      display: "flex",
                                      gap: 6,
                                      alignItems: "baseline",
                                      flexWrap: "wrap",
                                    }}
                                  >
                                    <span style={{ fontWeight: 600 }}>
                                      {buildingDate(new Date(r.ts).getTime(), {
                                        day: "2-digit",
                                        month: "2-digit",
                                      })}{" "}
                                      {buildingTime(new Date(r.ts).getTime())}
                                    </span>
                                    <span style={{ color: "var(--muted)" }}>
                                      {r.direction === "OUT"
                                        ? "wyjazd"
                                        : r.direction === "IN"
                                          ? "wjazd"
                                          : ""}
                                      {cameraNameMap.get(r.cameraDeviceId)
                                        ? ` · ${cameraNameMap.get(r.cameraDeviceId)}`
                                        : ""}
                                    </span>
                                  </figcaption>
                                </figure>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                  Pojazd dodasz do rejestru w zakładce „Pojazdy". Statystyka pomija tablice
                  już zarejestrowane i aktywnych gości.
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ── Filtry: zakres czasu + kamera ── */}
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {/* 2026-08-21 (feedback): wyszukiwarka po LEWEJ, wyraźna — nie
              schowana w prawym rogu nagłówka. */}
          <div
            className="ba-search"
            style={{
              width: 300,
              minWidth: 220,
              padding: "7px 10px",
              border: "1.5px solid var(--blue)",
              borderRadius: 9,
              background: "var(--bg-1)",
            }}
          >
            <Search size={15} />
            <input
              placeholder="Szukaj: napis, tablica, marka, „biały bus”…"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{ fontSize: 13.5 }}
            />
            {filterText ? (
              <button
                type="button"
                onClick={() => setFilterText("")}
                aria-label="Wyczyść"
                style={{
                  background: "transparent", border: 0, cursor: "pointer",
                  color: "var(--muted)", display: "grid", placeItems: "center",
                }}
              >
                <X size={13} />
              </button>
            ) : null}
          </div>
          {searchQuery ? (
            <span style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap" }}>
              przeszukuję całą historię
            </span>
          ) : null}
          <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginRight: 2, marginLeft: 6 }}>
            Okres:
          </span>
          {TIME_RANGES.map((r) => {
            const active = sinceHours === r.hours;
            return (
              <button
                key={r.hours}
                type="button"
                className="ba-btn sm"
                onClick={() => {
                  setSinceHours(r.hours);
                  setCustomFrom("");
                  setCustomTo("");
                  setLimit(PAGE_STEP);
                }}
                style={
                  active && !(customFrom && customTo)
                    ? {
                        background: "var(--blue-50)",
                        color: "var(--blue-600)",
                        borderColor: "var(--blue)",
                        fontWeight: 600,
                      }
                    : undefined
                }
              >
                {r.label}
              </button>
            );
          })}

          {/* 2026-08-21 — własny zakres dat i godzin (wygrywa z chipami). */}
          <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginLeft: 8 }}>
            lub zakres:
          </span>
          <input
            type="datetime-local"
            value={customFrom}
            max={customTo || undefined}
            onChange={(e) => setCustomFrom(e.target.value)}
            title="Początek zakresu"
            style={{
              fontSize: 12, padding: "4px 6px", borderRadius: 7,
              border: customFrom && customTo ? "1.5px solid var(--blue)" : "1px solid var(--border)",
              background: "var(--bg-1)", color: "inherit",
            }}
          />
          <span style={{ color: "var(--muted)", fontSize: 12 }}>→</span>
          <input
            type="datetime-local"
            value={customTo}
            min={customFrom || undefined}
            onChange={(e) => setCustomTo(e.target.value)}
            title="Koniec zakresu"
            style={{
              fontSize: 12, padding: "4px 6px", borderRadius: 7,
              border: customFrom && customTo ? "1.5px solid var(--blue)" : "1px solid var(--border)",
              background: "var(--bg-1)", color: "inherit",
            }}
          />
          {customFrom || customTo ? (
            <button
              type="button"
              className="ba-btn sm"
              onClick={() => { setCustomFrom(""); setCustomTo(""); }}
              title="Wyczyść zakres dat"
            >
              <X size={12} />
            </button>
          ) : null}

          {cameras.length > 1 ? (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginLeft: "auto",
                fontSize: 12.5,
                color: "var(--muted)",
              }}
            >
              <Camera size={14} />
              <select
                value={filterCamera}
                onChange={(e) => setFilterCamera(e.target.value)}
                className="ba-input"
                style={{ padding: "4px 8px", fontSize: 13 }}
                aria-label="Kamera"
              >
                <option value="">Wszystkie kamery ({cameras.length})</option>
                {cameras.map((c) => (
                  <option key={c.deviceId} value={c.deviceId}>
                    {c.name ?? c.deviceId.slice(0, 8)}
                    {c.ipAddress ? ` (${c.ipAddress})` : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {/* ── Filtry: klasa obiektu + śmieciarki ── */}
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {CLASS_FILTERS.map((f) => {
            const active = filterClass === f.key;
            return (
              <button
                key={f.key}
                type="button"
                className="ba-btn sm"
                onClick={() => {
                  setFilterClass(f.key);
                  setLimit(PAGE_STEP);
                }}
                style={
                  active
                    ? { background: "var(--ink)", color: "var(--surface)", borderColor: "var(--ink)" }
                    : undefined
                }
              >
                {f.label}
              </button>
            );
          })}
          <button
            type="button"
            className="ba-btn sm"
            onClick={() => setFilterWaste((v) => !v)}
            title={
              filterWaste
                ? "Kliknij, aby wyłączyć filtr śmieciarek"
                : "Pokaż tylko detekcje z napisami śmieciarki (SZKŁO / PAPIER / MPO itd.)"
            }
            style={
              filterWaste
                ? {
                    background: "var(--amber-50)",
                    color: "var(--amber)",
                    borderColor: "var(--amber)",
                    fontWeight: 700,
                    marginLeft: 6,
                  }
                : { marginLeft: 6 }
            }
          >
            <Trash2 size={13} /> Tylko śmieciarki
          </button>
        </div>

        {/* ── Marki (klik = filtr) ── */}
        {brandCounts.length > 0 ? (
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              alignItems: "center",
              padding: "10px 16px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600, marginRight: 2 }}>
              Marki:
            </span>
            {brandCounts.map(([brand, n]) => {
              const active = filterBrand === brand;
              return (
                <button
                  key={brand}
                  type="button"
                  className="ba-btn sm"
                  onClick={() => setFilterBrand(active ? "" : brand)}
                  title={
                    active
                      ? `Aktywny filtr: ${brand} — kliknij, aby wyłączyć`
                      : `${n} detekcji z marką ${brand} — kliknij, aby filtrować`
                  }
                  style={
                    active
                      ? {
                          background: "var(--blue-600)",
                          color: "#fff",
                          borderColor: "var(--blue-600)",
                          fontWeight: 600,
                        }
                      : undefined
                  }
                >
                  <Package size={12} /> {brand}
                  <span
                    style={{
                      fontSize: 11,
                      padding: "1px 6px",
                      borderRadius: 999,
                      background: active ? "rgba(255,255,255,0.25)" : "var(--bg-2)",
                      marginLeft: 2,
                    }}
                  >
                    {n}
                  </span>
                </button>
              );
            })}
            {filterBrand ? (
              <button
                type="button"
                onClick={() => setFilterBrand("")}
                style={{
                  background: "transparent",
                  border: 0,
                  cursor: "pointer",
                  fontSize: 12,
                  color: "var(--muted)",
                  textDecoration: "underline",
                }}
              >
                wyczyść
              </button>
            ) : null}
          </div>
        ) : null}

        {/* ── Lista detekcji ── */}
        {loading ? (
          <div className="ba-empty">Ładowanie detekcji…</div>
        ) : visible.length === 0 ? (
          <div className="ba-empty">
            <div className="ico">
              <ScanEye size={22} />
            </div>
            <h4>
              {offline
                ? "Brak zarejestrowanych zdarzeń"
                : filterBrand
                  ? `Brak detekcji z marką „${filterBrand}"`
                  : "Brak detekcji w wybranym okresie"}
            </h4>
            <p>
              {offline
                ? "Detekcje z kamer pojawią się tutaj, gdy serwer AI będzie znów dostępny."
                : "Spróbuj poszerzyć zakres czasu lub zresetować filtry."}
            </p>
          </div>
        ) : (
          <div>
            {visible.map((d) => (
              <DetectionRow
                onIdentify={openIdentify}
                key={d.id}
                d={d}
                buildingId={buildingId}
                cameraName={cameraNameMap.get(d.cameraDeviceId) ?? d.cameraDeviceId.slice(0, 8)}
                onOpen={() => setLightbox(d)}
              />
            ))}
          </div>
        )}

        {/* 2026-08-21 — nieskończone przewijanie: sentinel na dole listy
            dokleja kolejną stronę (before_ts) w ramach wybranego zakresu. */}
        {!loading && detections.length > 0 ? (
          <div
            ref={sentinelRef}
            style={{
              padding: "14px 16px",
              borderTop: "1px solid var(--border)",
              textAlign: "center",
              fontSize: 12.5,
              color: "var(--muted)",
            }}
          >
            {loadingMore
              ? "Doładowuję starsze zdarzenia…"
              : hasMore
                ? "Przewiń, aby doładować starsze zdarzenia"
                : "To już wszystkie zdarzenia w wybranym zakresie."}
          </div>
        ) : null}
      </div>

      {/* ── Identyfikacja tablicy (2026-08-21) — ten sam LprViewer co
          w Odczytach tablic: POST nowy pojazd / PATCH istniejący. ── */}
      {identifyReads && identifyReads.length > 0 ? (
        <LprViewer
          reads={identifyReads}
          initialIndex={0}
          apiClient={buildingAdminApi}
          buildImageUrl={(id) => `/building-admin/buildings/${buildingId}/lpr-reads/${id}/image`}
          buildVehiclesUrl={() => `/building-admin/buildings/${buildingId}/vehicles`}
          buildVehicleUrl={(id) => `/building-admin/buildings/${buildingId}/vehicles/${id}`}
          buildResidentsUrl={() => `/building-admin/buildings/${buildingId}/residents`}
          buildUnitsUrl={() => `/building-admin/buildings/${buildingId}/units`}
          buildServiceNamesUrl={() => `/building-admin/buildings/${buildingId}/vehicle-service-names`}
          buildVehicleTagsUrl={() => `/building-admin/buildings/${buildingId}/vehicle-tags`}
          onClose={() => setIdentifyReads(null)}
          onSaved={() => {
            setIdentifyReads(null);
            refreshSuggestions();
          }}
        />
      ) : null}

      {/* ── Lightbox ── */}
      {lightbox ? (
        <VisionLightbox
          detection={lightbox}
          buildingId={buildingId}
          cameraName={
            cameraNameMap.get(lightbox.cameraDeviceId) ?? lightbox.cameraDeviceId.slice(0, 8)
          }
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </>
  );
}

// ── Wiersz detekcji ──────────────────────────────────────────────────────────
function DetectionRow({
  d,
  buildingId,
  cameraName,
  onOpen,
  onIdentify,
}: {
  d: Detection;
  buildingId: number;
  cameraName: string;
  onOpen: () => void;
  /** 2026-08-21 — otwiera LprViewer (identyfikacja) dla tablicy z korelacji. */
  onIdentify: (plate: string) => void;
}) {
  const summaryText = plSummary(d.summary);
  const isFall = d.anomalyType === "FALL";
  const ocrChips = (d.textRaw ?? []).slice(0, 8);

  return (
    <div
      className="ba-row"
      onClick={onOpen}
      style={{
        gridTemplateColumns: "104px minmax(0, 1fr) 190px",
        alignItems: "flex-start",
        padding: "12px 16px",
        cursor: d.imagePath ? "zoom-in" : "pointer",
        ...(isFall ? { background: "var(--red-50, rgba(220,38,38,0.06))" } : null),
      }}
    >
      {/* Miniatura — LAZY (IntersectionObserver + semafor max 4 fetche) */}
      <div>
        {d.imagePath ? (
          <LazyLprThumbnail
            apiClient={buildingAdminApi}
            url={`/building-admin/buildings/${buildingId}/vision/frame/${encodeURIComponent(d.imagePath)}`}
            onClick={onOpen}
            style={{ width: 96, height: 72, borderRadius: 8 }}
            alt={summaryText || "detekcja"}
          />
        ) : (
          <div
            style={{
              width: 96,
              height: 72,
              borderRadius: 8,
              background: "var(--bg-2)",
              display: "grid",
              placeItems: "center",
              color: "var(--muted-2)",
              fontSize: 11,
            }}
          >
            brak zdjęcia
          </div>
        )}
      </div>

      {/* Treść */}
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>
            {summaryText || <span style={{ color: "var(--muted)", fontWeight: 500 }}>nic nie wykryto</span>}
          </span>
          {isFall ? (
            <span className="ba-pill red" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
              <AlertTriangle size={11} />
              Możliwy upadek
              {d.fallLikelihood != null ? ` (${Math.round(d.fallLikelihood * 100)}%)` : ""}
            </span>
          ) : null}
          {d.brandDetected ? (
            <span className="ba-pill green" title={`Rozpoznana marka: ${d.brandDetected}`}>
              <Package size={11} style={{ verticalAlign: "-1.5px", marginRight: 3 }} />
              {d.brandDetected}
            </span>
          ) : null}
          {d.wasteCategory ? (
            <span className="ba-pill amber" title={`Frakcja odpadów: ${d.wasteCategory}`}>
              <Trash2 size={11} style={{ verticalAlign: "-1.5px", marginRight: 3 }} />
              {d.wasteCategory}
            </span>
          ) : null}
          {/* 2026-08-15 — tablica z rejestru osiedla w kadrze (korelacja z LPR). */}
          {d.plateMatched ? (
            <button
              type="button"
              className="ba-pill green"
              onClick={(e) => {
                e.stopPropagation();
                if (d.plateMatched) onIdentify(d.plateMatched);
              }}
              title="Tablica z rejestru osiedla — kliknij, aby otworzyć identyfikację / zmienić klasyfikację"
              style={{
                display: "inline-flex", alignItems: "center", gap: 3,
                border: 0, cursor: "pointer", font: "inherit",
              }}
            >
              🪪 {d.plateMatched}
              {d.plateMatchLabel ? ` — ${d.plateMatchLabel}` : ""}
            </button>
          ) : null}
          {/* 2026-08-14 — atrybuty pojazdu z VLM: typ / marka / kolor. */}
          {d.vehicleKind || d.vehicleMake || d.vehicleColor ? (
            <span
              className="ba-pill blue"
              title="Rozpoznanie pojazdu (AI): typ, marka, kolor"
              style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
            >
              <Car size={11} />
              {[
                d.vehicleMake,
                d.vehicleColor,
                d.vehicleKind ? (VEHICLE_KIND_LABELS[d.vehicleKind] ?? d.vehicleKind) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : null}
        </div>

        {d.llmSummary ? (
          <div style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.45 }}>{d.llmSummary}</div>
        ) : null}

        {ocrChips.length > 0 ? (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 10.5, color: "var(--muted-2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
              Napisy
            </span>
            {ocrChips.map((t, i) => (
              <span
                key={`${i}-${t}`}
                className="ba-mono"
                title={t}
                style={{
                  fontSize: 11,
                  padding: "1px 7px",
                  borderRadius: 6,
                  background: "var(--bg-2)",
                  border: "1px solid var(--border)",
                  color: "var(--ink-2)",
                  whiteSpace: "nowrap",
                }}
              >
                {t.length > 22 ? t.slice(0, 20) + "…" : t}
              </span>
            ))}
            {(d.textRaw?.length ?? 0) > 8 ? (
              <span style={{ fontSize: 10.5, color: "var(--muted-2)" }}>
                +{(d.textRaw?.length ?? 0) - 8} więcej
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Czas + kamera */}
      <div style={{ fontSize: 13, textAlign: "right" }}>
        <div style={{ fontWeight: 600, color: "var(--ink-2)" }}>{humanTs(d.ts)}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end", marginTop: 2 }}>
          <Camera size={11} />
          {cameraName}
        </div>
      </div>
    </div>
  );
}

// ── Lightbox — duże zdjęcie (blob fetch z Bearer JWT jak w legacy) ──────────
function VisionLightbox({
  detection,
  buildingId,
  cameraName,
  onClose,
}: {
  detection: Detection;
  buildingId: number;
  cameraName: string;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!detection.imagePath) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    buildingAdminApi
      .get(
        `/building-admin/buildings/${buildingId}/vision/frame/${encodeURIComponent(detection.imagePath)}`,
        { responseType: "blob" },
      )
      .then((res) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data as Blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [buildingId, detection.imagePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const caption = [plSummary(detection.summary) || "detekcja", cameraName, humanTs(detection.ts)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      onClick={onClose}
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
        {failed ? (
          <div style={{ color: "#fff", fontSize: 14, padding: 40 }}>
            Nie udało się załadować zdjęcia.
          </div>
        ) : src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={caption}
            style={{
              maxWidth: "100%",
              maxHeight: "80vh",
              borderRadius: 12,
              boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
            }}
          />
        ) : (
          <div style={{ color: "#fff", fontSize: 14, padding: 40 }}>Ładowanie zdjęcia…</div>
        )}
        <div style={{ color: "#fff", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
          {caption}
          <button
            type="button"
            onClick={onClose}
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
        {detection.llmSummary ? (
          <div
            style={{
              color: "rgba(255,255,255,0.85)",
              fontSize: 13.5,
              maxWidth: 640,
              textAlign: "center",
              lineHeight: 1.5,
            }}
          >
            {detection.llmSummary}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── StatCard — wzorzec z lpr-reads/vehicles ──────────────────────────────────
function StatCard({
  icon,
  label,
  value,
  tone = "default",
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: "default" | "amber" | "green" | "blue";
  hint?: string;
}) {
  // Pełny `border` per tone (bez miksu shorthand + borderColor — React
  // ostrzega przy zmianie tonu podczas rerenderu).
  const toneStyle: Record<string, React.CSSProperties> = {
    default: { border: "1px solid var(--border)", background: "var(--card, var(--surface))" },
    amber: { border: "1px solid var(--amber)", background: "var(--amber-50)" },
    green: { border: "1px solid var(--green)", background: "var(--green-50)" },
    blue: { border: "1px solid var(--blue)", background: "var(--blue-50)" },
  };
  const ts = toneStyle[tone];
  return (
    <div
      style={{
        ...ts,
        borderRadius: 14,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "var(--muted)",
          fontSize: 11.5,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          fontWeight: 600,
        }}
      >
        {icon}
        <span>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: "var(--ink)", letterSpacing: "-0.01em" }}>
        {Number.isFinite(value) ? value : 0}
      </div>
      {hint ? <div style={{ fontSize: 12, color: "var(--muted)" }}>{hint}</div> : null}
    </div>
  );
}
