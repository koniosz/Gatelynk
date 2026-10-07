"""
SQL templates whitelist — sqlite dialect, mapowane na Edge `lpr_reads` table.

**Schema mapping (Edge produkcja):**

  vehicle_events (prototype spec)   →   lpr_reads (Edge real schema)
  ───────────────────────────────────────────────────────────────────
  plate                              →   plate
  color                              →   vehicle_color
  tags TEXT[]                        →   vehicle_tags (JSON-string TEXT)
  direction ('in'|'out')             →   direction ('forward'|'reverse')
  event_ts TIMESTAMPTZ               →   ts (epoch milliseconds INTEGER)

**Direction mapping:**
  in     ↔ 'forward'   (kamera wjazdowa)
  out    ↔ 'reverse'   (kamera wyjazdowa)
  NULL   ↔ matchuj wszystko (skip filter)

**Today window (sqlite):**
  ts >= unixepoch('now','localtime','start of day','utc') * 1000
  ts <  unixepoch('now','localtime','start of day','+1 day','utc') * 1000

**Tag membership (JSON array w TEXT column):**
  EXISTS (SELECT 1 FROM json_each(vehicle_tags)
           WHERE LOWER(value) = LOWER(?))

Każdy template:
  • Tylko SELECT (egzekwowane też w db.execute_safe)
  • Placeholders `?` (positional, sqlite syntax — Python aiosqlite wstrzykuje)
  • Każdy SELECT zwracający listę MUSI mieć LIMIT
  • Optional filter args: `(? IS NULL OR column = ?)` — pojedynczy param
    pojawia się 2x w SQL, więc duplikujemy w app.py mapper.

Dla optional `direction` w app.py używamy "param-twice" pattern: jeśli
intent ma `direction` jako optional, parametr pojawia się 2x w params list,
pierwszy raz dla `(? IS NULL` check, drugi dla `direction = ?`. Konwersja
PL→sqlite ('in'→'forward', 'out'→'reverse') jest w app.py mapper.
"""
from __future__ import annotations

from typing import TypedDict


class Template(TypedDict):
    sql: str
    # Kolejność = kolejność placeholderów `?, ?, ?`.
    # Każdy element to nazwa parametru z intencji LUB '_' dla literal None.
    # Nazwa może wystąpić wielokrotnie (np. ["direction","direction"]
    # dla `(? IS NULL OR direction = ?)`).
    params: list[str]


# Skrót dla today-window (powtarzane w wielu templates).
# 2026-08-15 — Event Intelligence §4 (temporal engine): okno domyślne = DZIŚ,
# ale explicit okno z pytania („wczoraj", „w tym tygodniu", „rano") nadpisuje
# je przez since_ms/until_ms (COALESCE). Każdy template z tym fragmentem MUSI
# mieć w params ["since_ms","until_ms"] na pozycji fragmentu.
# 2026-08-24 — kolejność modyfikatorów sqlite MA znaczenie: poprawny idiom
# lokalnej północy to 'now','localtime','start of day','utc'. Poprzednie
# 'now','start of day','localtime' ucinało dobę w UTC i przesuwało wynik —
# koło północy „dziś" łapało wczorajsze odczyty od ~04:00.
TODAY_WINDOW = """
  AND ts >= COALESCE(?, unixepoch('now','localtime','start of day','utc') * 1000)
  AND ts <  COALESCE(?, unixepoch('now','localtime','start of day','+1 day','utc') * 1000)
"""

# Skrót dla optional direction filter — sqlite-style placeholder twice.
# Caller musi przekazać direction 2x (None lub 'in'/'out').
# 2026-08-16 — DWA pokolenia wartości w lpr_reads.direction: stare wiersze
# 'forward'/'reverse' (konwencja Hikvision), nowe od 2026-08-14 'IN'/'OUT'
# (semantyczny kierunek liczony na Edge). Normalizujemy w SQL do 'in'/'out' —
# bez tego filtry kierunkowe pomijały wszystkie nowe odczyty.
DIRECTION_NORM = (
    "CASE WHEN direction IN ('forward','IN') THEN 'in' "
    "WHEN direction IN ('reverse','OUT') THEN 'out' END"
)
OPTIONAL_DIRECTION = f"AND (? IS NULL OR {DIRECTION_NORM} = ?)"


# 2026-08-15 — Event Intelligence §15: forma kanoniczna text_raw. `canon_ocr`
# to funkcja SQL rejestrowana per-połączenie w db.execute_safe (lustro
# intent_classifier.canonical_ocr: diakrytyki→ASCII, lower, cyfry-sobowtóry
# 0→o/1→i/5→s/8→b, bez spacji i interpunkcji). Dzięki temu „REM0NDIS",
# „D H L", „inp0st." matchują deterministycznie. Poprzednia wersja jako
# zagnieżdżony łańcuch replace() przekraczała stos parsera sqlite.
CANON_TEXT_RAW = "canon_ocr(COALESCE(v.text_raw, ''))"


# 2026-10-07 — odczyty tablic w oknie wokół klatki wizji `v` (5 min przed,
# 2 min po): pojazd marki widziany na osiedlu zwykle mija kamerę LPR przy
# wjeździe chwilę przed kamerami wizji. JSON-array dla response buildera,
# który wybiera tablicę WIZYTY (odczyty pojazdów mieszkańców/gości odrzuca —
# to nie van dostawcy, a ich tablic nie pokazujemy innym mieszkańcom).
# `tags` służą tylko do dopasowania marki, nigdy do treści odpowiedzi
# (zawierają nazwy właścicieli — lekcja 8.h.23).
LPR_NEAR_VISION = """(
    SELECT json_group_array(json_object(
             'plate', r.plate,
             'ts', r.ts,
             'dir', CASE WHEN r.direction IN ('forward','IN','in') THEN 'in'
                         WHEN r.direction IN ('reverse','OUT','out') THEN 'out' END,
             'kind', r.vehicle_kind,
             'tags', r.vehicle_tags,
             'type', r.vehicle_type,
             'cam', COALESCE((SELECT json_extract(rc.config, '$.name')
                                FROM device_config rc
                               WHERE rc.device_id = r.camera_device_id),
                             r.camera_device_id)))
      FROM lpr_reads r
     WHERE r.ts BETWEEN v.ts - 300000 AND v.ts + 120000
  )"""


TEMPLATES: dict[str, Template] = {
    # ── Counts ────────────────────────────────────────────────────────────
    "count_vehicles_today": {
        "sql": f"""
            SELECT COUNT(*) AS count
              FROM lpr_reads
             WHERE 1=1
               {TODAY_WINDOW}
               {OPTIONAL_DIRECTION}
        """,
        "params": ["since_ms", "until_ms", "direction", "direction"],
    },

    "count_vehicles_by_color_today": {
        "sql": f"""
            SELECT COUNT(*) AS count
              FROM lpr_reads
             WHERE LOWER(vehicle_color) = LOWER(?)
               {TODAY_WINDOW}
               {OPTIONAL_DIRECTION}
        """,
        "params": ["color", "since_ms", "until_ms", "direction", "direction"],
    },

    "count_vehicles_by_tag_today": {
        # JSON tag membership. vehicle_tags może być NULL → COALESCE do pustego array.
        "sql": f"""
            SELECT COUNT(*) AS count
              FROM lpr_reads
             WHERE EXISTS (
                     SELECT 1
                       FROM json_each(COALESCE(vehicle_tags, '[]'))
                      WHERE LOWER(value) = LOWER(?)
                   )
               {TODAY_WINDOW}
               {OPTIONAL_DIRECTION}
        """,
        "params": ["tag", "since_ms", "until_ms", "direction", "direction"],
    },

    # ── Lists (z LIMIT) ───────────────────────────────────────────────────
    "courier_today": {
        # FIX 8.h.30 (2026-07-03, bug produkcyjny): poprzednio
        # `vehicle_kind IN ('DELIVERY', 'SERVICE')` — ale Cloud whitelist
        # enum to RESIDENT|SERVICE|GUEST, gdzie SERVICE = KAŻDA usługa
        # (opiekunka, ogrodnik, serwisant). Efekt: „Opiekunka Pani Halinka"
        # (SERVICE, czerwona Toyota Aygo) została przedstawiona jako kurier
        # w odpowiedzi na „A jakiegoś innego kuriera?".
        # Kurier = vehicle_kind='DELIVERY' LUB tag zawierający kurier/dostaw/
        # courier (np. ["Kurier","DPD"] / "Kurier InPost" — stąd LIKE zamiast
        # exact IN). Samo kind='SERVICE' NIGDY nie wystarcza.
        "sql": f"""
            SELECT plate,
                   vehicle_color AS color,
                   COALESCE(vehicle_tags, '[]') AS tags_json,
                   direction,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time
              FROM lpr_reads
             WHERE (
                     vehicle_kind = 'DELIVERY'
                  OR EXISTS (
                       SELECT 1 FROM json_each(COALESCE(vehicle_tags, '[]'))
                        WHERE LOWER(value) LIKE '%kurier%'
                           OR LOWER(value) LIKE '%dostaw%'
                           OR LOWER(value) LIKE '%courier%'
                     )
                   )
               {TODAY_WINDOW}
               {OPTIONAL_DIRECTION}
             ORDER BY ts DESC
             LIMIT 20
        """,
        "params": ["since_ms", "until_ms", "direction", "direction"],
    },

    # 2026-08-15 — Event Intelligence §9: surowe odczyty do parowania
    # wjazd/wyjazd w builderze (czas pobytu). ts w ms zostaje w rows —
    # builder liczy duration bez drugiego zapytania.
    "visit_duration_by_plate": {
        "sql": """
            SELECT plate,
                   direction,
                   ts,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time
              FROM lpr_reads
             WHERE UPPER(plate) = UPPER(?)
             ORDER BY ts DESC
             LIMIT 50
        """,
        "params": ["plate"],
    },

    # 2026-08-15 — Event Intelligence §5 AGGREGATION: rozkład godzin obserwacji
    # śmieciarek (180 dni). Dedup po (dzień, godzina) — jedna wizyta generuje
    # wiele klatek; bez dedupu godzina z długim postojem zawyżałaby statystykę.
    "waste_typical_time": {
        "sql": """
            SELECT hour, COUNT(*) AS hits
              FROM (
                    SELECT DISTINCT
                           strftime('%Y-%m-%d', datetime(ts/1000,'unixepoch','localtime')) AS day,
                           CAST(strftime('%H', datetime(ts/1000,'unixepoch','localtime')) AS INTEGER) AS hour
                      FROM vision_detections
                     WHERE waste_category IS NOT NULL
                       AND ts >= (strftime('%s','now') - 4320 * 3600) * 1000
                   )
             GROUP BY hour
             ORDER BY hits DESC
             LIMIT 24
        """,
        "params": [],
    },

    "vehicle_history_by_plate": {
        # Pełna historia tablicy, LIMIT 50.
        "sql": """
            SELECT plate,
                   vehicle_color AS color,
                   COALESCE(vehicle_tags, '[]') AS tags_json,
                   direction,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time
              FROM lpr_reads
             WHERE UPPER(plate) = UPPER(?)
             ORDER BY ts DESC
             LIMIT 50
        """,
        "params": ["plate"],
    },

    "last_seen_plate": {
        "sql": """
            SELECT plate,
                   vehicle_color AS color,
                   COALESCE(vehicle_tags, '[]') AS tags_json,
                   direction,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time
              FROM lpr_reads
             WHERE UPPER(plate) = UPPER(?)
             ORDER BY ts DESC
             LIMIT 1
        """,
        "params": ["plate"],
    },

    # FAZA 8.h.23 (2026-06-12) — "do kogo należy pojazd X?".
    # PRIVACY: celowo NIE selectujemy `owner` ANI `vehicle_tags` — tagi
    # zawierają nazwę właściciela (live test: WL9397W miał tags
    # ["Taxi Uber","Toyota",...] i Bielik wygadał "należy do Uber, czarny
    # kombi Toyota"). Mieszkaniec dostaje TYLKO lokal (unit_label) + typ.
    # Brak kolumny w rows = LLM fizycznie nie może jej ujawnić
    # (defense-in-depth głębsza niż prompt-instrukcja). Dodatkowo intent
    # jest w NO_SMART_INTENTS (app.py) — template answer idzie bez
    # naturalizacji. Whitelist lpr_plates ma wpisy per-camera — LIMIT 1
    # wystarcza (unit_label/kind identyczne między kamerami).
    "vehicle_owner_by_plate": {
        "sql": """
            SELECT plate,
                   unit_label,
                   vehicle_kind
              FROM lpr_plates
             WHERE UPPER(plate) = UPPER(?)
             LIMIT 1
        """,
        "params": ["plate"],
    },

    # ── Nowe intencje (2026-05-19) ────────────────────────────────────────

    # "Ile dziś otworzyło się bram?" — count zdarzeń gdzie gate_opened=1
    "count_gate_openings_today": {
        "sql": f"""
            SELECT COUNT(*) AS count
              FROM lpr_reads
             WHERE gate_opened = 1
               {TODAY_WINDOW}
               {OPTIONAL_DIRECTION}
        """,
        "params": ["since_ms", "until_ms", "direction", "direction"],
    },

    # 2026-08-24 — "Jakie samochody pojawiły się między 1 a 6 rano?" — lista
    # odczytów LPR w oknie czasowym, bez filtra koloru/tagu.
    "list_vehicles_recent": {
        "sql": f"""
            SELECT plate,
                   vehicle_color AS color,
                   COALESCE(vehicle_tags, '[]') AS tags_json,
                   direction,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time
              FROM lpr_reads
             WHERE 1=1
               {TODAY_WINDOW}
               {OPTIONAL_DIRECTION}
             ORDER BY ts DESC
             LIMIT 30
        """,
        "params": ["since_ms", "until_ms", "direction", "direction"],
    },

    # "Jakie czerwone samochody?" — lista zamiast count
    "list_vehicles_by_color_today": {
        "sql": f"""
            SELECT plate,
                   vehicle_color AS color,
                   COALESCE(vehicle_tags, '[]') AS tags_json,
                   direction,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time
              FROM lpr_reads
             WHERE LOWER(vehicle_color) = LOWER(?)
               {TODAY_WINDOW}
               {OPTIONAL_DIRECTION}
             ORDER BY ts DESC
             LIMIT 20
        """,
        "params": ["color", "since_ms", "until_ms", "direction", "direction"],
    },

    # "Ile razy był samochód WD5005P?" — count wystąpień konkretnej tablicy
    # (cała historia, bez filtru daty — user pyta o "ile razy w ogóle").
    "count_visits_by_plate": {
        "sql": """
            SELECT COUNT(*) AS count
              FROM lpr_reads
             WHERE UPPER(plate) = UPPER(?)
        """,
        "params": ["plate"],
    },

    # "Pokaż 5 ostatnich nieznanych tablic" — matched=0 (gate się nie otworzyła
    # bo plate nie w whitelist). Range default 24h.
    "list_unmatched_plates": {
        "sql": """
            SELECT plate,
                   vehicle_color AS color,
                   COALESCE(vehicle_tags, '[]') AS tags_json,
                   direction,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time,
                   COALESCE(vehicle_brand, '') AS brand,
                   COALESCE(vehicle_type, '') AS vehicle_type
              FROM lpr_reads
             WHERE matched = 0
               AND ts >= (strftime('%s','now') - ? * 3600) * 1000
             ORDER BY ts DESC
             LIMIT ?
        """,
        # range_hours (int), limit (int)
        "params": ["range_hours", "limit"],
    },

    # "Jakieś błędy w ostatniej godzinie?" — event_log table (info/warning/error)
    "list_errors_recent": {
        "sql": """
            SELECT level, category, message,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time
              FROM event_log
             WHERE ts >= (strftime('%s','now') - ? * 3600) * 1000
               AND level IN ('error', 'warning')
             ORDER BY ts DESC
             LIMIT 20
        """,
        "params": ["range_hours"],
    },

    "count_errors_recent": {
        "sql": """
            SELECT level, COUNT(*) AS count
              FROM event_log
             WHERE ts >= (strftime('%s','now') - ? * 3600) * 1000
               AND level IN ('error', 'warning')
             GROUP BY level
        """,
        "params": ["range_hours"],
    },

    # "Jakie urządzenia są podłączone?" — device_config table
    "list_devices": {
        "sql": """
            SELECT device_id, type, config, enabled
              FROM device_config
             WHERE enabled = 1
             ORDER BY type, device_id
             LIMIT 50
        """,
        "params": [],
    },

    # YOLO vision — "ile osób dziś", "ile psów w godzinie".
    # vision_detections.summary jest JSON-em typu {"person":2,"car":1}.
    # SUM-ujemy w sqlite przez json_extract — bezpośredni number z klucza,
    # 0 (coalesce z NULL) gdy klasa nie była w detekcji.
    # range_hours mapowane na okno (now - range_hours*h, now).
    "count_objects_today": {
        "sql": """
            SELECT COALESCE(SUM(json_extract(summary, '$.' || ?)), 0) AS count,
                   COUNT(*) AS frame_count
              FROM vision_detections
             WHERE ts >= COALESCE(?, (strftime('%s','now') - ? * 3600) * 1000)
               AND (? IS NULL OR ts < ?)
        """,
        "params": ["object_class", "since_ms", "range_hours", "until_ms", "until_ms"],
    },

    # "Co widziała kamera ostatnio" — ostatnie N detekcji z niezerowym summary.
    # Pomijamy rows gdzie summary='{}' (puste klatki bez COCO objects) —
    # nie ma o czym rozmawiać.
    "list_recent_detections": {
        "sql": """
            SELECT id,
                   COALESCE((SELECT json_extract(dc.config, '$.name')
                               FROM device_config dc
                              WHERE dc.device_id = camera_device_id),
                            camera_device_id) AS camera,
                   summary,
                   COALESCE(inference_ms, 0) AS inference_ms,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time
              FROM vision_detections
             WHERE ts >= COALESCE(?, (strftime('%s','now') - ? * 3600) * 1000)
               AND (? IS NULL OR ts < ?)
               AND summary IS NOT NULL
               AND summary != '{}'
             ORDER BY ts DESC
             LIMIT ?
        """,
        "params": ["since_ms", "range_hours", "until_ms", "until_ms", "limit"],
    },

    # "Czy widziałeś dziś DHL?" — vision-side brand lookup. Czyta
    # vision_detections (YOLO+EasyOCR pipeline) zamiast lpr_reads.
    # Filtruje na partial index `vision_brand_ts_idx` (brand_detected!=NULL).
    #
    # 2026-10-07 (zgłoszenie Konrada: „odpowiedź totalnie śmieciowa —
    # identyfikatory kamer nic nie mówią"): klatki to NIE wizyty — jeden van
    # widzi kilka kamer w ciągu paru minut. Zwracamy klatki z NAZWĄ kamery
    # i odczytami tablic z okna wokół klatki (`lpr_near`, JSON); response
    # builder skleja je w wizyty i wybiera tablicę pojazdu. LIMIT 300 klatek
    # (30 dni × kilka wizyt × kilka klatek), odczyty z indeksu lpr_reads_ts_idx.
    "search_by_brand_today": {
        "sql": """
            SELECT v.ts AS ts,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(v.ts/1000, 'unixepoch', 'localtime')) AS time,
                   COALESCE(json_extract(dc.config, '$.name'),
                            v.camera_device_id) AS camera,
                   v.brand_detected AS brand,
                   COALESCE(v.brand_conf, 0.0) AS brand_conf,
                   v.image_path,
                   """ + LPR_NEAR_VISION + """ AS lpr_near
              FROM vision_detections v
              LEFT JOIN device_config dc ON dc.device_id = v.camera_device_id
             WHERE v.brand_detected = ?
               AND v.ts >= COALESCE(?, (strftime('%s','now') - ? * 3600) * 1000)
               AND (? IS NULL OR v.ts < ?)
             ORDER BY v.ts DESC
             LIMIT 300
        """,
        "params": ["brand", "since_ms", "range_hours", "until_ms", "until_ms"],
    },

    # 2026-08-15 — wolne wyszukiwanie po napisach OCR ("napisem SOLID").
    # text_raw to JSON-string array wszystkich odczytanych napisów; LIKE
    # w sqlite ignoruje wielkość liter dla ASCII. Full-scan okna czasowego —
    # przy setkach wierszy/dobę to milisekundy.
    "search_by_text_today": {
        "sql": """
            SELECT COALESCE(json_extract(dc.config, '$.name'),
                            v.camera_device_id) AS camera,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(v.ts/1000, 'unixepoch', 'localtime')) AS time,
                   COALESCE(v.text_raw, '[]') AS text_raw,
                   COALESCE(v.summary, '{}') AS summary,
                   v.image_path
              FROM vision_detections v
              LEFT JOIN device_config dc ON dc.device_id = v.camera_device_id
             WHERE (v.text_raw LIKE '%' || ? || '%'
                    OR """ + CANON_TEXT_RAW + """ LIKE '%' || ? || '%')
               AND v.ts >= COALESCE(?, (strftime('%s','now') - ? * 3600) * 1000)
               AND (? IS NULL OR v.ts < ?)
             ORDER BY v.ts DESC
             LIMIT 20
        """,
        # §15: query = literalny LIKE (jak dotąd), query_canon = fuzzy po
        # znormalizowanym OCR (REM0NDIS/D H L/inp0st.).
        "params": ["query", "query_canon", "since_ms", "range_hours", "until_ms", "until_ms"],
    },

    # 2026-08-19 — pojazd opisany KOLOREM + TYPEM („biały bus") po kolumnach
    # VLM. kind IN (?, ?) — potoczne „bus" = [bus, dostawczy] (pojedynczy
    # kind zdublowany); kolor LIKE prefiksem w dwóch wariantach diakrytyków
    # (bial% / biał%). Bez fallbacku na klasy YOLO — kolor i tak jest tylko
    # z VLM, więc koniunkcja wymaga wiersza z atrybutami.
    "search_vehicle_desc": {
        "sql": """
            SELECT COALESCE(json_extract(dc.config, '$.name'),
                            v.camera_device_id) AS camera,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(v.ts/1000, 'unixepoch', 'localtime')) AS time,
                   v.vehicle_kind AS kind,
                   v.vehicle_make AS make,
                   v.vehicle_color AS color,
                   v.image_path
              FROM vision_detections v
              LEFT JOIN device_config dc ON dc.device_id = v.camera_device_id
             WHERE v.vehicle_kind IN (?, ?)
               AND (v.vehicle_color LIKE ? OR v.vehicle_color LIKE ?)
               AND v.ts >= (strftime('%s','now') - ? * 3600) * 1000
             ORDER BY v.ts DESC
             LIMIT 20
        """,
        "params": ["sql_kind_a", "sql_kind_b", "sql_color_a", "sql_color_b", "range_hours"],
    },

    # 2026-08-15 — Event Intelligence §16: pojazdy uprzywilejowane po aliasach
    # OCR na formie kanonicznej (CANON_TEXT_RAW). `kind` gate'uje grupy
    # aliasów: ambulans/policja/straz/any. Param kind pojawia się 3× (raz na
    # grupę). Odpowiedź w response_builder jest hedged — to klasyfikacja
    # WYŁĄCZNIE z OCR (spec §6/§7).
    "search_emergency_recent": {
        "sql": """
            SELECT COALESCE(json_extract(dc.config, '$.name'),
                            v.camera_device_id) AS camera,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(v.ts/1000, 'unixepoch', 'localtime')) AS time,
                   COALESCE(v.text_raw, '[]') AS text_raw,
                   COALESCE(v.summary, '{}') AS summary,
                   v.image_path
              FROM vision_detections v
              LEFT JOIN device_config dc ON dc.device_id = v.camera_device_id
             WHERE v.ts >= COALESCE(?, (strftime('%s','now') - ? * 3600) * 1000)
               AND (? IS NULL OR v.ts < ?)
               AND (
                 (? IN ('ambulans','any') AND (""" + CANON_TEXT_RAW + """ LIKE '%ambulans%'
                     OR """ + CANON_TEXT_RAW + """ LIKE '%pogotowi%'
                     OR """ + CANON_TEXT_RAW + """ LIKE '%ratownic%'
                     OR """ + CANON_TEXT_RAW + """ LIKE '%karetk%'))
                 OR (? IN ('policja','any') AND """ + CANON_TEXT_RAW + """ LIKE '%policj%')
                 OR (? IN ('straz','any') AND (""" + CANON_TEXT_RAW + """ LIKE '%strazpozarn%'
                     OR """ + CANON_TEXT_RAW + """ LIKE '%strazmiejsk%'
                     OR """ + CANON_TEXT_RAW + """ LIKE '%panstwowastraz%'))
               )
             ORDER BY v.ts DESC
             LIMIT 20
        """,
        "params": ["since_ms", "range_hours", "until_ms", "until_ms", "kind", "kind", "kind"],
    },

    # "Czy dziś odebrali szkło?" — waste-truck lookup. Czyta vision_detections
    # po kategorii odpadów (GLASS/PAPER/PLASTIC/BIO/MIXED). Korzysta z
    # partial-index `vision_waste_ts_idx` (waste_category!=NULL).
    #
    # `category` jest **opcjonalny** — gdy NULL, query zwraca ANY śmieciarkę
    # bez względu na fraction (pytanie typu „czy dziś była śmieciarka?").
    # Sztywny pattern z brand-template: parameter pojawia się 2x w SQL
    # (`(? IS NULL OR waste_category = ?)`) i tyle samo razy w params list.
    # Druga gałąź `waste_category IS NOT NULL` gwarantuje że index zostanie
    # użyty nawet gdy pierwsza gałąź jest "skip-filter" (NULL → match all).
    "search_by_waste_today": {
        "sql": """
            SELECT COALESCE((SELECT json_extract(dc.config, '$.name')
                               FROM device_config dc
                              WHERE dc.device_id = camera_device_id),
                            camera_device_id) AS camera,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time,
                   waste_category AS category,
                   COALESCE(waste_conf, 0.0) AS waste_conf,
                   waste_operator AS operator,
                   COALESCE(summary, '{}') AS summary,
                   image_path
              FROM vision_detections
             WHERE (? IS NULL OR waste_category = ?)
               AND waste_category IS NOT NULL
               AND ts >= COALESCE(?, (strftime('%s','now') - ? * 3600) * 1000)
               AND (? IS NULL OR ts < ?)
             ORDER BY ts DESC
             LIMIT 20
        """,
        # category 2x (NULL-check + equality), range_hours 1x.
        "params": ["category", "category", "since_ms", "range_hours", "until_ms", "until_ms"],
    },

    # FAZA 8.h.29 (2026-07-03) — "czy widziałeś kota?" / "kiedy ostatnio był
    # pies?". OSTATNIE wystąpienie klasy YOLO + liczba klatek w oknie.
    # summary = JSON {"person":2,"cat":1} — filtr przez json_extract.
    # DWA placeholdery klasy (OR) — pseudo-klasa `animal` = cat|dog
    # (validate() binduje wtedy 'cat','dog'; zwykła klasa = 2× ta sama
    # wartość, nieszkodliwy duplikat). Aggregate zwraca ZAWSZE 1 wiersz:
    # frame_count=0 + last_time=NULL gdy klasa nie wystąpiła.
    "last_seen_object": {
        "sql": """
            SELECT COUNT(*) AS frame_count,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(MAX(ts)/1000, 'unixepoch', 'localtime')) AS last_time
              FROM vision_detections
             WHERE (COALESCE(json_extract(summary, '$.' || ?), 0) > 0
                 OR COALESCE(json_extract(summary, '$.' || ?), 0) > 0)
               AND ts >= COALESCE(?, (strftime('%s','now') - ? * 3600) * 1000)
               AND (? IS NULL OR ts < ?)
        """,
        "params": ["sql_class_a", "sql_class_b", "since_ms", "range_hours", "until_ms", "until_ms"],
    },

    # FAZA 8.h.29 (2026-07-03) — "kiedy ostatnio była taksówka?". Pseudo-
    # kategoria TAXI: brand UBER/BOLT z EasyOCR (brand_detected) LUB napis
    # taxi/free now w surowych tokenach OCR (text_raw = JSON-string array).
    # NIE dotykamy lpr_reads.vehicle_brand (numeryczne Hikvision IDs —
    # pułapka projektu #7). ORDER BY ts DESC → rows[0] = ostatnie wystąpienie.
    "search_taxi_recent": {
        "sql": """
            SELECT v.ts AS ts,
                   COALESCE(json_extract(dc.config, '$.name'),
                            v.camera_device_id) AS camera,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(v.ts/1000, 'unixepoch', 'localtime')) AS time,
                   v.brand_detected AS brand,
                   COALESCE(v.summary, '{}') AS summary,
                   v.image_path,
                   """ + LPR_NEAR_VISION + """ AS lpr_near
              FROM vision_detections v
              LEFT JOIN device_config dc ON dc.device_id = v.camera_device_id
             WHERE (
                     v.brand_detected IN ('UBER', 'BOLT', 'FREENOW', 'FREE_NOW')
                  OR LOWER(COALESCE(v.text_raw, '')) LIKE '%taxi%'
                  OR LOWER(COALESCE(v.text_raw, '')) LIKE '%free now%'
                  OR LOWER(COALESCE(v.text_raw, '')) LIKE '%freenow%'
                   )
               AND v.ts >= COALESCE(?, (strftime('%s','now') - ? * 3600) * 1000)
               AND (? IS NULL OR v.ts < ?)
             ORDER BY v.ts DESC
             LIMIT 300
        """,
        "params": ["since_ms", "range_hours", "until_ms", "until_ms"],
    },

    # FAZA 8.h.30 (2026-07-03) — agregat KURIER: "czy był dziś jakiś kurier?",
    # "jaki kurier ostatnio?", "a jakiegoś innego kuriera?". UNION dwóch
    # niezależnych źródeł:
    #   1. vision brand_detected z marek kurierskich (EasyOCR napis na vanie;
    #      lista = przecięcie BRAND_KEYWORD_MAP z brand_matcher.py — sekcja
    #      kurierzy). NIE lpr_reads.vehicle_brand (numeryczne Hikvision IDs —
    #      pułapka projektu #7).
    #   2. lpr_reads z whitelisty: vehicle_kind='DELIVERY' LUB tag zawierający
    #      kurier/dostaw/courier — te same warunki co naprawiony courier_today.
    #      NIGDY samo vehicle_kind='SERVICE' (SERVICE = opiekunka/ogrodnik/
    #      serwisant — bug „Opiekunka Pani Halinka" jako kurier).
    # `label` = nazwa marki (vision) albo owner/tag z whitelisty (lpr).
    # ORDER BY ts DESC → rows[0] = ostatnie wystąpienie.
    "search_courier_recent": {
        "sql": """
            SELECT strftime('%Y-%m-%d %H:%M',
                            datetime(ts/1000, 'unixepoch', 'localtime')) AS time,
                   source, label, place, image_path
              FROM (
                    SELECT ts,
                           'vision' AS source,
                           brand_detected AS label,
                           camera_device_id AS place,
                           image_path
                      FROM vision_detections
                     WHERE brand_detected IN ('DHL','DPD','INPOST','FEDEX','GLS',
                                              'UPS','POCZTA','POCZTEX','ALLEGRO','DACHSER')
                       AND ts >= COALESCE(?, (strftime('%s','now') - ? * 3600) * 1000)
                       AND (? IS NULL OR ts < ?)
                    UNION ALL
                    SELECT ts,
                           'lpr' AS source,
                           COALESCE(NULLIF(owner, ''), 'kurier (biała lista)') AS label,
                           plate AS place,
                           NULL AS image_path
                      FROM lpr_reads
                     WHERE (
                             vehicle_kind = 'DELIVERY'
                          OR EXISTS (
                               SELECT 1 FROM json_each(COALESCE(vehicle_tags, '[]'))
                                WHERE LOWER(value) LIKE '%kurier%'
                                   OR LOWER(value) LIKE '%dostaw%'
                                   OR LOWER(value) LIKE '%courier%'
                             )
                           )
                       AND ts >= COALESCE(?, (strftime('%s','now') - ? * 3600) * 1000)
                       AND (? IS NULL OR ts < ?)
                   )
             ORDER BY ts DESC
             LIMIT 20
        """,
        # okno 4 param, 2x — raz per gałąź UNION.
        "params": ["since_ms", "range_hours", "until_ms", "until_ms", "since_ms", "range_hours", "until_ms", "until_ms"],
    },

    # FAZA 8.h.32 (2026-07-05) — "Ile Mercedesów w 12 godzinach?" / "Czy
    # widziałeś jakąś Toyotę?". Dwustopniowo w JEDNYM query:
    #   1. subquery wp: tablice z whitelisty lpr_plates których tag zawiera
    #      markę (pad-token match: ' '||REPLACE(LOWER(value),'-',' ')||' '
    #      LIKE '% marka %' — word-boundary bez REGEXP, nie łapie substrings
    #      typu 'man' w 'Romanowski'). GROUP BY plate bo whitelist ma wpisy
    #      per-camera (8.h.25).
    #   2. LEFT JOIN lpr_reads w oknie — wiersze z time=NULL to pojazdy
    #      z whitelisty BEZ przejazdu (builder odróżnia "nie ma marki na
    #      liście" od "jest, ale nie przejeżdżała").
    # PRIVACY (8.h.23): NIE selectujemy owner ANI vehicle_tags (tagi
    # zawierają nazwę właściciela/serwisu). unit_label wolno podać.
    # NIGDY lpr_reads.vehicle_brand (numeryczne Hikvision IDs — pułapka #7).
    "search_by_vehicle_make": {
        "sql": """
            SELECT wp.plate,
                   wp.unit_label,
                   r.direction,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(r.ts/1000, 'unixepoch', 'localtime')) AS time
              FROM (
                    SELECT UPPER(plate) AS plate,
                           MAX(COALESCE(unit_label, '')) AS unit_label
                      FROM lpr_plates
                     WHERE EXISTS (
                             SELECT 1
                               FROM json_each(COALESCE(vehicle_tags, '[]'))
                              WHERE ' ' || REPLACE(LOWER(value), '-', ' ') || ' '
                                    LIKE '% ' || ? || ' %'
                                 OR ' ' || REPLACE(LOWER(value), '-', ' ') || ' '
                                    LIKE '% ' || ? || ' %'
                           )
                     GROUP BY UPPER(plate)
                   ) wp
              LEFT JOIN lpr_reads r
                ON UPPER(r.plate) = wp.plate
               AND r.ts >= (strftime('%s','now') - ? * 3600) * 1000
             ORDER BY (r.ts IS NULL), r.ts DESC
             LIMIT 50
        """,
        # sql_make_a / sql_make_b — aliasy z CAR_MAKE_SQL_ALIASES (validate()),
        # np. Volkswagen = ('volkswagen', 'vw'); zwykła marka = 2× to samo.
        "params": ["sql_make_a", "sql_make_b", "range_hours"],
    },

    # "Czy było taxi?" / "Czy była dostawa sushi?" — free-form keyword search
    # po owner, vehicle_tags, vehicle_brand. Wyszukiwanie LIKE — łapie też
    # częściowe matche (np. "Kimi" matchuje "Kimi Sushi").
    # 2026-08-15 — agregat DWÓCH źródeł. "Czy widziałeś Solid?" ma znaleźć
    # WSZYSTKO związane z tym słowem, nie tylko pojazdy z rejestru: rejestr
    # (owner/brand/tagi z odczytów LPR) UNION napisy OCR z kamer
    # (vision_detections.text_raw). Wiersze rozróżnia kolumna `source`.
    "search_vehicles_today": {
        "sql": f"""
            SELECT u.*,
                   strftime('%Y-%m-%d %H:%M',
                            datetime(u.ts/1000, 'unixepoch', 'localtime')) AS time
              FROM (
                SELECT ts,
                       'lpr' AS source,
                       plate,
                       vehicle_color AS color,
                       COALESCE(vehicle_tags, '[]') AS tags_json,
                       direction,
                       owner,
                       vehicle_kind,
                       NULL AS text_raw,
                       NULL AS summary,
                       NULL AS camera
                  FROM lpr_reads
                 WHERE (
                         LOWER(COALESCE(owner, '')) LIKE '%' || LOWER(?) || '%'
                      OR LOWER(COALESCE(vehicle_brand, '')) LIKE '%' || LOWER(?) || '%'
                      OR EXISTS (
                           SELECT 1 FROM json_each(COALESCE(vehicle_tags, '[]'))
                            WHERE LOWER(value) LIKE '%' || LOWER(?) || '%'
                         )
                       )
                   {TODAY_WINDOW}
                   {OPTIONAL_DIRECTION}
                UNION ALL
                SELECT v.ts,
                       'vision' AS source,
                       NULL AS plate,
                       NULL AS color,
                       '[]' AS tags_json,
                       NULL AS direction,
                       NULL AS owner,
                       NULL AS vehicle_kind,
                       COALESCE(v.text_raw, '[]') AS text_raw,
                       COALESCE(v.summary, '{{}}') AS summary,
                       COALESCE(json_extract(dc.config, '$.name'),
                                v.camera_device_id) AS camera
                  FROM vision_detections v
                  LEFT JOIN device_config dc ON dc.device_id = v.camera_device_id
                 WHERE v.text_raw LIKE '%' || ? || '%'
                   AND v.ts >= COALESCE(?, unixepoch('now','localtime','start of day','utc') * 1000)
                   AND v.ts <  COALESCE(?, unixepoch('now','localtime','start of day','+1 day','utc') * 1000)
              ) u
             ORDER BY u.ts DESC
             LIMIT 20
        """,
        # keyword 3× (owner/brand/tagi) + direction 2× + keyword 1× (text_raw)
        "params": ["keyword", "keyword", "keyword", "since_ms", "until_ms", "direction", "direction", "keyword", "since_ms", "until_ms"],
    },
}


def get_template(intent: str) -> Template | None:
    """None gdy intent nie ma template-u (np. 'unknown')."""
    return TEMPLATES.get(intent)
