/**
 * Hikvision DeepinView ANPR — mapping of `<vehicleLogoRecog>` numeric IDs
 * to human-readable brand names.
 *
 * The camera (V5.7+ firmware) reports the recognised brand as an integer
 * from its internal logo-recognition dictionary, not a string. There is no
 * stable, publicly documented table — entries are discovered by observing
 * live events and matching the on-screen OSD overlay against the ID.
 *
 * How to extend:
 *   1. Let a vehicle pass the camera.
 *   2. Inspect `~/gatelynk-edge/data/lpr-snapshots/<ts>_<plate>.xml` for
 *      `<vehicleLogoRecog>NNNN</vehicleLogoRecog>`.
 *   3. Open the matching `.jpg` — the camera paints the detected brand on
 *      the image as OSD text.
 *   4. Add `NNNN: 'BrandName'` below, rebuild Edge, redeploy.
 *
 * Keep names in their common Polish market spelling (`Škoda` → `Skoda`
 * for UI simplicity; ASCII only, matches how DB + logs render).
 *
 * Unknown IDs fall back to `"#NNNN"` in the UI so the operator can see
 * the raw code and decide whether it's worth mapping.
 */
export const HIKVISION_BRAND_ID_MAP: Record<number, string> = {
  // Discovered on-site — populated as we see real traffic.
  //
  // ⚠️ KRYTYCZNE: Hikvision `<vehicleLogoRecog>` to ID **marki fabrycznej**
  // pojazdu (Toyota/VW/Skoda/MB), NIE operator kurierski. Wcześniej (commit
  // 2026-05-22) wpisałem `1044: 'DPD'` po obserwacji jednego vana DPD —
  // 2026-05-24 user zauważył, że 4 zwykłe samochody (HN1440G, WZ3286J,
  // WD5405V, BSE12FM) zostały błędnie sklasyfikowane jako DPD. Wszystkie
  // miały brand ID 1044 — to po prostu marka modelu pojazdu (prob. VW lub
  // MB Sprinter), nie kurier. Mapping wycofany, ID 1044 pokazujemy jako
  // surowe "#1044" do zmapowania.
  //
  // ZASADA: Identyfikacja kuriera (DPD/DHL/InPost/Bolt) wyłącznie przez
  // OCR napisu na boku vana (EasyOCR pipeline w `yolo-vision`), NIE przez
  // Hikvision brand ID.
  //
  // ── TODO: top niezmapowane kody (Villa Natura b9, ostatnie 7 dni) ───
  // #1037 (233 hits) — najczęstszy, prob. Toyota/VW/Skoda
  // #1028 (192), #1036 (106), #1030 (75), #1053 (66),
  // #1064 (59), #1107 (44), #1144 (37), #1060 (33), #1128 (28)
  // #1044 — prob. VW Crafter / MB Sprinter (występuje na vanach i zwykłych autach)
  // Aby zmapować: otwórz `~/gatelynk-edge/data/lpr-snapshots/<ts>_<plate>.jpg`,
  // kamera maluje brand OSD na obrazie — odczytaj i dopisz.
}

/**
 * Resolve a Hikvision brand ID to a display string.
 *
 * - `id <= 0` or `null` → `null` (no brand recognised by camera)
 * - Known ID            → mapped name (e.g. `"Audi"`)
 * - Unknown positive ID → `"#NNNN"` placeholder so we can learn it later
 */
export function resolveHikvisionBrand(id: number | null | undefined): string | null {
  if (id == null || !Number.isFinite(id) || id <= 0) return null
  const known = HIKVISION_BRAND_ID_MAP[id]
  if (known) return known
  return `#${id}`
}
