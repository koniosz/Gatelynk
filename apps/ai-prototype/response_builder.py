"""
Response builder — buduje odpowiedź user-facing z szablonów.

WAŻNE: LLM **nie generuje** tu żadnego tekstu. To czysto deterministyczne
formatowanie f-string na podstawie wyników z bazy. To dlatego nie ma
halucynacji — odpowiedzi mają stały kształt.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any


def _parse_tags(row: dict) -> list[str]:
    """
    Edge sqlite trzyma vehicle_tags jako JSON-string TEXT. SQL templates
    aliasują kolumnę do `tags_json`. Parsujemy w response builder.
    Bezpieczne dla wszystkich edge case (NULL, pusty string, malformed).
    """
    raw = row.get("tags_json")
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        return [str(t) for t in parsed] if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _db_direction_to_intent(db_dir: str | None) -> str | None:
    """Edge: stare wiersze 'forward'/'reverse', nowe (od 2026-08-14)
    semantyczne 'IN'/'OUT'. App spec: 'in'/'out'."""
    if db_dir in ("forward", "IN"):
        return "in"
    if db_dir in ("reverse", "OUT"):
        return "out"
    return None

# Stałe komunikaty (per spec).
UNKNOWN_MSG = "Nie potrafię jeszcze odpowiedzieć na to pytanie."
NO_DATA_MSG = "Nie mam danych potwierdzających takie zdarzenie."


# ─── helpers ──────────────────────────────────────────────────────────────────

def _direction_verb_count(direction: str | None) -> str:
    """Verb dla zliczeń: wjechało / wyjechało / pojawiło się."""
    if direction == "in":
        return "wjechało"
    if direction == "out":
        return "wyjechało"
    return "pojawiło się"


def _direction_verb_single(direction: str | None) -> str:
    """Verb dla pojedynczego zdarzenia: wjechał / wyjechał."""
    if direction == "in":
        return "wjechał"
    if direction == "out":
        return "wyjechał"
    return "pojawił się"


def _plural_aut(n: int) -> str:
    """Polski plural: 1 auto, 2 auta, 5 aut, 12 aut, 22 auta..."""
    if n == 1:
        return "1 auto"
    last_two = n % 100
    last = n % 10
    if 12 <= last_two <= 14:
        return f"{n} aut"
    if 2 <= last <= 4:
        return f"{n} auta"
    return f"{n} aut"


# ─── main entry point ────────────────────────────────────────────────────────

def build(intent: str, parameters: dict, rows: list[dict]) -> dict:
    """
    Zwraca dict gotowy do JSON-serializacji do API response:
      {
        "intent":     str,
        "parameters": dict,
        "answer":     str       # user-facing tekst
        "data":       dict|None # raw payload dla debug/UI
      }
    """
    base = {"intent": intent, "parameters": parameters}

    # §4 temporal engine (2026-08-15): explicit okno z pytania niesie etykietę
    # PL ("wczoraj", "w tym tygodniu", "wczoraj wieczorem"). Odpowiedzi używają
    # jej zamiast "Dziś"/"w ostatnich N godzinach".
    _wl = str(parameters.get("window_label") or "")
    day_word = (_wl[0].upper() + _wl[1:]) if _wl else "Dziś"

    # ── unknown ──
    if intent == "unknown":
        return {**base, "answer": UNKNOWN_MSG, "data": None}

    # ── counts ──
    if intent in (
        "count_vehicles_today",
        "count_vehicles_by_color_today",
        "count_vehicles_by_tag_today",
    ):
        count = int(rows[0]["count"]) if rows else 0
        verb = _direction_verb_count(parameters.get("direction"))
        aut = _plural_aut(count)

        if intent == "count_vehicles_by_color_today":
            color = parameters.get("color", "?")
            answer = f"{day_word} {verb} {aut} w kolorze {color}."
        elif intent == "count_vehicles_by_tag_today":
            tag = parameters.get("tag", "?")
            answer = f"{day_word} {verb} {aut} z tagiem {tag}."
        else:
            answer = f"{day_word} {verb} {aut}."

        return {**base, "answer": answer, "data": {"count": count}}

    # ── count_gate_openings_today ──
    if intent == "count_gate_openings_today":
        count = int(rows[0]["count"]) if rows else 0
        # Specjalny verb dla bram — "otworzyła się"
        if count == 1:
            answer = f"{day_word} brama otworzyła się 1 raz."
        else:
            answer = f"{day_word} brama otworzyła się {count} razy."
        return {**base, "answer": answer, "data": {"count": count}}

    # ── list_vehicles_recent (2026-08-24 — „jakie samochody między 1 a 6?") ──
    if intent == "list_vehicles_recent":
        if not rows:
            return {
                **base,
                "answer": f"{day_word} nie zarejestrowałem żadnego przejazdu.",
                "data": {"count": 0, "vehicles": []},
            }
        lines = []
        vehicles = []
        for r in rows:
            tags = _parse_tags(r)
            plate = r["plate"]
            time = r["time"]
            intent_dir = _db_direction_to_intent(r.get("direction"))
            dir_str = "wjazd" if intent_dir == "in" else "wyjazd" if intent_dir == "out" else "—"
            tags_str = ", ".join(tags[:3]) if tags else ""
            tag_suffix = f" [{tags_str}]" if tags_str else ""
            lines.append(f"  • {time} — {plate} ({dir_str}){tag_suffix}")
            vehicles.append({
                "plate": plate, "color": r.get("color"), "tags": tags,
                "direction": intent_dir, "time": time,
            })
        n = len(rows)
        display = lines[:15]
        more = f"\n  ... + {n - 15} więcej" if n > 15 else ""
        # LIMIT 30 w SQL — pełna lista może być dłuższa niż zwrócone wiersze.
        cap_note = " (ostatnie 30)" if n >= 30 else ""
        answer = (
            f"{day_word} zarejestrowałem {_plural_aut(n)}{cap_note}:\n"
            + "\n".join(display) + more
        )
        return {**base, "answer": answer, "data": {"count": n, "vehicles": vehicles}}

    # ── list_vehicles_by_color_today ──
    if intent == "list_vehicles_by_color_today":
        if not rows:
            color = parameters.get("color", "?")
            return {
                **base,
                "answer": f"{day_word} nie pojawiło się żadne auto w kolorze {color}.",
                "data": {"count": 0, "vehicles": []},
            }
        color = parameters.get("color", "?")
        lines = []
        vehicles = []
        for r in rows:
            tags = _parse_tags(r)
            plate = r["plate"]
            time = r["time"]
            intent_dir = _db_direction_to_intent(r.get("direction"))
            dir_str = "wjazd" if intent_dir == "in" else "wyjazd" if intent_dir == "out" else "—"
            tags_str = ", ".join(tags[:3]) if tags else ""
            tag_suffix = f" [{tags_str}]" if tags_str else ""
            lines.append(f"  • {time} — {plate} ({dir_str}){tag_suffix}")
            vehicles.append({
                "plate": plate, "color": r.get("color"), "tags": tags,
                "direction": intent_dir, "time": time,
            })
        n = len(rows)
        display = lines[:10]
        more = f"\n  ... + {n - 10} więcej" if n > 10 else ""
        answer = (
            f"{day_word} {_plural_aut(n)} w kolorze {color}:\n"
            + "\n".join(display) + more
        )
        return {**base, "answer": answer, "data": {"count": n, "vehicles": vehicles}}

    # ── count_visits_by_plate ──
    if intent == "count_visits_by_plate":
        count = int(rows[0]["count"]) if rows else 0
        plate = parameters.get("plate", "?")
        if count == 0:
            return {**base, "answer": NO_DATA_MSG, "data": {"plate": plate, "count": 0}}
        word = "raz" if count == 1 else ("razy" if 2 <= count % 10 <= 4 and not (12 <= count % 100 <= 14) else "razy")
        # Polish: 1 raz, 2-4 razy, 5+ razy (gen pl)
        answer = f"Tablica {plate} była rejestrowana {count} {word} w bazie."
        return {**base, "answer": answer, "data": {"plate": plate, "count": count}}

    # ── visit_duration_by_plate (Event Intelligence §9, 2026-08-15) ──
    # Paruje OSTATNI wjazd (forward) z pierwszym PÓŹNIEJSZYM wyjazdem
    # (reverse) i liczy czas pobytu. Uczciwie: brak wyjazdu ≠ "nadal jest" —
    # wyjazd mógł nie zostać zarejestrowany (§6: OBSERVED ≠ INFERRED).
    if intent == "visit_duration_by_plate":
        plate = parameters.get("plate", "?")
        if not rows:
            return {
                **base,
                "answer": f"Nie mam żadnych odczytów tablicy {plate} — nie mogę policzyć czasu pobytu.",
                "data": {"plate": plate, "visits": []},
            }
        asc = sorted(rows, key=lambda r: int(r.get("ts") or 0))
        # ostatnia para wjazd→wyjazd + ewentualny otwarty wjazd na końcu
        last_in = None
        last_pair = None  # (in_row, out_row)
        for r in asc:
            d = _db_direction_to_intent(r.get("direction"))
            if d == "in":
                last_in = r
            elif d == "out" and last_in is not None:
                last_pair = (last_in, r)
                last_in = None
        def _dur(ms: int) -> str:
            mins = max(1, round(ms / 60000))
            h, m = divmod(mins, 60)
            return f"{h} godz. {m} min" if h else f"{m} min"
        parts: list[str] = []
        data: dict[str, Any] = {"plate": plate}
        if last_in is not None:  # otwarty pobyt — wjazd bez późniejszego wyjazdu
            parts.append(
                f"Pojazd {plate} wjechał {last_in.get('time') or '?'} i nie mam "
                f"zarejestrowanego wyjazdu — może wciąż być na osiedlu, albo "
                f"wyjazd nie został zarejestrowany."
            )
            data["openEntry"] = last_in.get("time")
        if last_pair is not None:
            i, o = last_pair
            dur = _dur(int(o.get("ts") or 0) - int(i.get("ts") or 0))
            parts.append(
                f"Ostatnia pełna wizyta pojazdu {plate}: wjazd {i.get('time') or '?'}, "
                f"wyjazd {o.get('time') or '?'} — na osiedlu {dur}."
            )
            data["lastVisit"] = {"in": i.get("time"), "out": o.get("time"), "duration": dur}
        if not parts:
            # są odczyty, ale np. same wyjazdy (kamera wjazdowa nie łapała)
            parts.append(
                f"Mam odczyty tablicy {plate}, ale nie potrafię sparować wjazdu "
                f"z wyjazdem — być może rejestrowany był tylko jeden kierunek."
            )
        return {**base, "answer": " ".join(parts), "data": data}

    # ── waste_typical_time (Event Intelligence §5 AGGREGATION, 2026-08-15) ──
    if intent == "waste_typical_time":
        clean = [r for r in rows if r.get("hour") is not None]
        total = sum(int(r.get("hits") or 0) for r in clean)
        if total == 0:
            return {
                **base,
                "answer": (
                    "Kamery nie mają jeszcze wystarczających obserwacji śmieciarek, "
                    "żeby policzyć typową godzinę. Sprawdź harmonogram odbiorów "
                    "w bazie wiedzy."
                ),
                "data": {"total": 0, "byHour": []},
            }
        top = max(clean, key=lambda r: int(r.get("hits") or 0))
        top_h = int(top["hour"])
        # klaster ±1 h wokół najczęstszej godziny
        cluster = sum(
            int(r.get("hits") or 0) for r in clean if abs(int(r["hour"]) - top_h) <= 1
        )
        answer = (
            f"Śmieciarka najczęściej pojawia się około {top_h}:00 — "
            f"{cluster} z {total} obserwacji z ostatnich 6 miesięcy przypada "
            f"na przedział {max(0, top_h - 1)}:00–{top_h + 1}:59. "
            f"(Statystyka z kamer — dokładne terminy wyznacza harmonogram.)"
        )
        return {
            **base,
            "answer": answer,
            "data": {
                "total": total,
                "topHour": top_h,
                "byHour": [{"hour": int(r["hour"]), "hits": int(r.get("hits") or 0)} for r in clean],
            },
        }

    # ── search_by_brand_today (vision-side brand lookup) ──
    # 2026-10-07: odpowiedź = WIZYTY pojazdu (klatki sklejone w czasie),
    # z tablicą z kamery LPR i nazwami kamer — zamiast listy klatek z UUID
    # kamer i pewnością OCR („totalnie śmieciowa" — zgłoszenie Konrada).
    if intent == "search_by_brand_today":
        brand = parameters.get("brand", "?")
        range_hours = int(parameters.get("range_hours", 24))
        range_label = _wl or _range_label(range_hours)
        label = _brand_label(brand)
        if not rows:
            return {
                **base,
                "answer": f"Kamery nie zarejestrowały pojazdu {label} {range_label}.",
                "data": {"brand": brand, "count": 0, "range_hours": range_hours, "visits": []},
            }
        visits = _group_visits(rows, brand_terms=_brand_terms(brand))
        answer = (
            f"Tak — pojazd {label} był na osiedlu {_times_pl(len(visits))} {range_label}:\n"
            + _visit_lines(visits)
        )
        return {
            **base,
            "answer": answer,
            "data": {
                "brand": brand,
                "count": len(visits),
                "range_hours": range_hours,
                "visits": [_visit_payload(v) for v in visits],
            },
        }

    # ── search_by_text_today (wolne szukanie po napisach OCR, 2026-08-15) ──
    if intent == "search_by_text_today":
        query = str(parameters.get("query") or "?")
        range_hours = int(parameters.get("range_hours", 24))
        range_label = _wl or _range_label(range_hours)
        if not rows:
            return {
                **base,
                "answer": f"Kamery nie zarejestrowały napisu „{query}” {range_label}.",
                "data": {"query": query, "count": 0, "range_hours": range_hours, "detections": []},
            }
        lines: list[str] = []
        detections: list[dict[str, Any]] = []
        for r in rows:
            time = r.get("time") or "?"
            cam = r.get("camera") or "?"
            try:
                tokens = json.loads(r.get("text_raw") or "[]")
            except (TypeError, ValueError):
                tokens = []
            hits = [str(t) for t in tokens if query.lower() in str(t).lower()][:3]
            try:
                summary = json.loads(r.get("summary") or "{}")
            except (TypeError, ValueError):
                summary = {}
            # Scena po polsku — Bielik w smart-mode zamieni to na naturalne
            # zdanie („człowiek z napisem SOLID na koszulce"), template mode
            # pokazuje surowo ale czytelnie.
            scene_map = {"person": "osoba", "car": "samochód", "truck": "ciężarówka/van",
                         "bus": "bus", "dog": "pies", "cat": "kot", "bicycle": "rower",
                         "motorcycle": "motocykl"}
            scene = ", ".join(
                f"{v}× {scene_map.get(k, k)}" if isinstance(v, int) and v > 1
                else scene_map.get(k, k)
                for k, v in summary.items()
            ) or "brak rozpoznanych obiektów"
            hit_str = f" (napis: {', '.join(hits)})" if hits else ""
            lines.append(f"  • {time} — kamera {cam}, w kadrze: {scene}{hit_str}")
            detections.append({
                "time": time,
                "camera": cam,
                "tokens": hits,
                "summary": summary,
                "image_path": r.get("image_path"),
            })
        n = len(rows)
        display = lines[:10]
        more = f"\n  ... + {n - 10} więcej" if n > 10 else ""
        answer = (
            f"Napis „{query}” pojawił się {_visits_plural(n)} {range_label}:\n"
            + "\n".join(display) + more
        )
        return {
            **base,
            "answer": answer,
            "data": {
                "query": query,
                "count": n,
                "range_hours": range_hours,
                "detections": detections,
            },
        }

    # ── search_vehicle_desc („biały bus" — kolor+typ z VLM, 2026-08-19) ──
    if intent == "search_vehicle_desc":
        kind = str(parameters.get("kind") or "?")
        color = str(parameters.get("color") or "?")
        range_hours = int(parameters.get("range_hours", 24))
        range_label = _range_label(range_hours)
        kind_label = {
            "bus": "bus/van", "dostawczy": "dostawczy", "ciezarowka": "ciężarówka",
            "maszyna": "maszyna budowlana", "osobowy": "samochód osobowy",
        }.get(kind, kind)
        desc = f"{color} {kind_label}"
        if not rows:
            return {
                **base,
                "answer": (
                    f"Kamery nie zarejestrowały pojazdu „{desc}” {range_label}. "
                    f"(Typ i kolor rozpoznaję z obrazu — pojazd częściowo "
                    f"zasłonięty mógł zostać pominięty.)"
                ),
                "data": {"kind": kind, "color": color, "count": 0,
                         "range_hours": range_hours, "detections": []},
            }
        lines: list[str] = []
        detections: list[dict[str, Any]] = []
        for r in rows:
            time = r.get("time") or "?"
            cam = r.get("camera") or "?"
            make = r.get("make")
            make_str = f", {make}" if make else ""
            lines.append(f"  • {time} — kamera {cam} ({r.get('color') or color} {r.get('kind') or kind}{make_str})")
            detections.append({
                "time": time, "camera": cam, "kind": r.get("kind"),
                "make": make, "color": r.get("color"), "image_path": r.get("image_path"),
            })
        n = len(rows)
        display = lines[:10]
        more = f"\n  ... + {n - 10} więcej" if n > 10 else ""
        answer = (
            f"Tak — pojazd „{desc}” był widziany {_visits_plural(n)} {range_label}:\n"
            + "\n".join(display) + more
        )
        return {
            **base,
            "answer": answer,
            "data": {"kind": kind, "color": color, "count": n,
                     "range_hours": range_hours, "detections": detections},
        }

    # ── search_emergency_recent (Event Intelligence §16, 2026-08-15) ──
    # Klasyfikacja pochodzi WYŁĄCZNIE z OCR — odpowiedź świadomie hedged
    # („pojazd z oznaczeniem POGOTOWIE"), nigdy „karetka była" jako pewnik
    # (spec §6/§7: OBSERVED ≠ INFERRED).
    if intent == "search_emergency_recent":
        kind = str(parameters.get("kind") or "any")
        range_hours = int(parameters.get("range_hours", 24))
        range_label = _wl or _range_label(range_hours)
        kind_label = {
            "ambulans": "karetki/pogotowia",
            "policja": "policji",
            "straz": "straży pożarnej",
            "any": "pojazdu uprzywilejowanego",
        }.get(kind, kind)
        if not rows:
            return {
                **base,
                "answer": (
                    f"Kamery nie zarejestrowały żadnego oznaczenia {kind_label} "
                    f"{range_label}. (Rozpoznaję po napisach na pojazdach — "
                    f"pojazd bez widocznego oznaczenia mógł zostać pominięty.)"
                ),
                "data": {"kind": kind, "count": 0, "range_hours": range_hours, "detections": []},
            }
        lines: list[str] = []
        detections: list[dict[str, Any]] = []
        for r in rows:
            time = r.get("time") or "?"
            cam = r.get("camera") or "?"
            try:
                tokens = json.loads(r.get("text_raw") or "[]")
            except (TypeError, ValueError):
                tokens = []
            # Pokaż tokeny które wyglądają na oznaczenie służby (dowód §6).
            sig = [
                str(t) for t in tokens
                if any(k in str(t).lower() for k in
                       ("ambulans", "pogotow", "ratownic", "karetk", "policj", "straz", "straż"))
            ][:3]
            sig_str = f" (napis: {', '.join(sig)})" if sig else ""
            lines.append(f"  • {time} — kamera {cam}{sig_str}")
            detections.append({
                "time": time, "camera": cam, "tokens": sig,
                "image_path": r.get("image_path"),
            })
        n = len(rows)
        display = lines[:10]
        more = f"\n  ... + {n - 10} więcej" if n > 10 else ""
        answer = (
            f"Widziałem pojazd z oznaczeniem {kind_label} {_visits_plural(n)} {range_label}:\n"
            + "\n".join(display) + more
        )
        return {
            **base,
            "answer": answer,
            "data": {"kind": kind, "count": n, "range_hours": range_hours, "detections": detections},
        }

    # ── search_by_waste_today (waste-truck lookup) ──
    if intent == "search_by_waste_today":
        category = parameters.get("category")  # may be None — generic „śmieciarka"
        range_hours = int(parameters.get("range_hours", 24))
        range_label = _wl or _range_label(range_hours)
        cat_label = _waste_category_label(category)

        if not rows:
            if category:
                answer = (
                    f"Nie, śmieciarka z {cat_label} nie była zarejestrowana "
                    f"{range_label}."
                )
            else:
                answer = f"Nie, żadna śmieciarka nie była zarejestrowana {range_label}."
            return {
                **base,
                "answer": answer,
                "data": {
                    "category": category,
                    "count": 0,
                    "range_hours": range_hours,
                    "detections": [],
                },
            }

        # Build detection lines + a structured payload for UI. Per-row schema
        # matches search_by_brand_today (time / camera / conf / image_path)
        # plus the operator name (when matched — often NULL).
        lines: list[str] = []
        detections: list[dict[str, Any]] = []
        for r in rows:
            time = r.get("time") or "?"
            cam = r.get("camera") or "?"
            row_cat = r.get("category") or "?"
            op = r.get("operator")
            conf = r.get("waste_conf") or 0.0
            try:
                conf_f = float(conf)
            except (TypeError, ValueError):
                conf_f = 0.0
            conf_str = f" ({conf_f:.2f})" if conf_f > 0 else ""
            op_str = f" — {op}" if op else ""
            cat_str = "" if category else f" [{row_cat}]"  # show category only in generic queries
            lines.append(f"  • {time} — kamera {cam}{cat_str}{op_str}{conf_str}")
            detections.append({
                "time": time,
                "camera": cam,
                "category": row_cat,
                "operator": op,
                "waste_conf": conf_f,
                "image_path": r.get("image_path"),
            })

        n = len(rows)
        display = lines[:10]
        more = f"\n  ... + {n - 10} więcej" if n > 10 else ""
        # FAZA 8.h.29 — rows są ORDER BY ts DESC, więc rows[0] = OSTATNIE
        # wystąpienie. Head podaje je wprost (data+godzina + operator/frakcja
        # gdy znane) — template answer ma być konkretny sam w sobie.
        last = rows[0]
        last_bits = [str(last.get("time") or "?")]
        if not category and last.get("category"):
            last_bits.append(str(last["category"]))
        if last.get("operator"):
            last_bits.append(str(last["operator"]))
        last_str = last_bits[0] + (
            f" ({', '.join(last_bits[1:])})" if len(last_bits) > 1 else ""
        )
        if category:
            head = (
                f"Tak — śmieciarka z {cat_label} ostatnio była {last_str}. "
                f"Łącznie {_visits_plural(n)} {range_label}:\n"
            )
        else:
            head = (
                f"Tak — śmieciarka ostatnio była {last_str}. "
                f"Łącznie {_visits_plural(n)} {range_label}:\n"
            )
        return {
            **base,
            "answer": head + "\n".join(display) + more,
            "data": {
                "category": category,
                "count": n,
                "range_hours": range_hours,
                "detections": detections,
            },
        }

    # ── last_seen_object (FAZA 8.h.29 — HISTORIA klas YOLO) ──
    # Aggregate query zawsze zwraca 1 wiersz: frame_count + last_time
    # (NULL gdy klasa nie wystąpiła w oknie). Zero wystąpień = poprawna,
    # konkretna odpowiedź ("nie widziałem kota w ostatnich 30 dniach"),
    # NIGDY unknown.
    if intent == "last_seen_object":
        cls = parameters.get("object_class", "?")
        range_h = int(parameters.get("range_hours", 168))
        range_label = _wl or _range_label(range_h)
        row = rows[0] if rows else {}
        try:
            frame_count = int(row.get("frame_count") or 0)
        except (TypeError, ValueError):
            frame_count = 0
        last_time = row.get("last_time")
        acc, gen = _VISION_PL_SIGHT.get(cls, (cls, cls))
        if frame_count == 0 or not last_time:
            answer = (
                f"Nie widziałem {gen} {range_label} — "
                f"kamery nie zarejestrowały tej klasy obiektów."
            )
        else:
            frames_str = _pl_plural(frame_count, "klatce", "klatkach", "klatkach")
            answer = (
                f"Tak — ostatni raz kamery zarejestrowały {acc} {last_time}. "
                f"{range_label.capitalize()} klasa pojawiła się w {frames_str}."
            )
        return {
            **base,
            "answer": answer,
            "data": {
                "object_class": cls,
                "frame_count": frame_count,
                "last_time": last_time,
                "range_hours": range_h,
            },
        }

    # ── search_taxi_recent (FAZA 8.h.29 — pseudo-kategoria TAXI) ──
    if intent == "search_taxi_recent":
        range_h = int(parameters.get("range_hours", 24))
        range_label = _wl or _range_label(range_h)
        if not rows:
            return {
                **base,
                "answer": (
                    f"{range_label.capitalize()} nie zarejestrowałem żadnej "
                    f"taksówki (Uber/Bolt/taxi)."
                ),
                "data": {"count": 0, "range_hours": range_h, "visits": []},
            }
        visits = _group_visits(rows, brand_terms=["uber", "bolt", "taxi", "free now", "freenow"])
        answer = (
            f"Tak — taksówka była na osiedlu {_times_pl(len(visits))} {range_label}:\n"
            + _visit_lines(visits, show_brand=True)
        )
        return {
            **base,
            "answer": answer,
            "data": {"count": len(visits), "range_hours": range_h,
                     "visits": [_visit_payload(v) for v in visits]},
        }

    # ── search_courier_recent (FAZA 8.h.30 — agregat marek kurierskich) ──
    # rows z UNION (ORDER BY ts DESC): time / source ('vision'|'lpr') /
    # label (marka albo owner z whitelisty) / place (kamera albo tablica).
    # Odpowiedź = ostatnie wystąpienie + zestawienie per marka z datami.
    # Zero wierszy = uczciwe „żaden kurier w N dniach", NIGDY unknown.
    if intent == "search_courier_recent":
        range_h = int(parameters.get("range_hours", 168))
        range_label = _wl or _range_label(range_h)
        if not rows:
            return {
                **base,
                "answer": (
                    f"{range_label.capitalize()} nie zarejestrowałem "
                    f"żadnego kuriera."
                ),
                "data": {"count": 0, "range_hours": range_h, "detections": []},
            }
        detections = []
        # Grupuj po label (marka/owner) — per marka: liczba + ostatnia data.
        # rows są DESC, więc pierwsze wystąpienie labela = jego najnowsze.
        by_label: dict = {}
        order: list = []
        for r in rows:
            time = r.get("time") or "?"
            label = (r.get("label") or "kurier").strip() or "kurier"
            detections.append({
                "time": time,
                "source": r.get("source"),
                "label": label,
                "place": r.get("place"),
                "image_path": r.get("image_path"),
            })
            key = label.lower()
            if key not in by_label:
                by_label[key] = {"label": label, "hits": 0, "last_time": time}
                order.append(key)
            by_label[key]["hits"] += 1
        lines = []
        for key in order[:10]:
            g = by_label[key]
            count_str = f" ×{g['hits']}" if g["hits"] > 1 else ""
            lines.append(f"  • {g['label']}{count_str} — ostatnio {g['last_time']}")
        n = len(rows)
        last = rows[0]
        last_label = (last.get("label") or "kurier").strip() or "kurier"
        answer = (
            f"Tak — ostatni kurier to {last_label}, "
            f"{last.get('time') or '?'}. "
            f"Łącznie {_visits_plural(n)} {range_label}:\n"
            + "\n".join(lines)
        )
        return {
            **base,
            "answer": answer,
            "data": {
                "count": n,
                "range_hours": range_h,
                "brands": [by_label[k] for k in order],
                "detections": detections,
            },
        }

    # ── search_by_vehicle_make (FAZA 8.h.32 — marki fabryczne) ──
    # rows z LEFT JOIN whitelist→reads (ORDER BY ts DESC, NULL-e na końcu):
    #   • 0 wierszy               → marki nie ma na białej liście (wprost!)
    #   • wiersze z time=NULL     → pojazd na liście, ale bez przejazdu w oknie
    #   • wiersze z time          → przejazdy (direction: forward=in/reverse=out)
    # PRIVACY: rows nie zawierają owner/tags — wolno podać lokal (unit_label).
    if intent == "search_by_vehicle_make":
        make = parameters.get("make", "?")
        range_h = int(parameters.get("range_hours", 24))
        range_label = _range_label(range_h)
        if not rows:
            return {
                **base,
                "answer": (
                    f"Na białej liście osiedla nie ma żadnego pojazdu "
                    f"marki {make}."
                ),
                "data": {
                    "make": make,
                    "whitelisted_plates": 0,
                    "count": 0,
                    "range_hours": range_h,
                    "detections": [],
                },
            }
        reads = [r for r in rows if r.get("time")]
        all_plates: list[str] = []
        for r in rows:
            p = r.get("plate")
            if p and p not in all_plates:
                all_plates.append(p)
        if not reads:
            n_pl = len(all_plates)
            answer = (
                f"Na białej liście osiedla: {_pl_plural(n_pl, 'pojazd', 'pojazdy', 'pojazdów')} "
                f"marki {make}, ale {range_label} żaden nie przejeżdżał przez bramę."
            )
            return {
                **base,
                "answer": answer,
                "data": {
                    "make": make,
                    "whitelisted_plates": n_pl,
                    "count": 0,
                    "range_hours": range_h,
                    "detections": [],
                },
            }
        lines: list[str] = []
        detections: list[dict[str, Any]] = []
        uniq_plates: list[str] = []
        for r in reads:
            intent_dir = _db_direction_to_intent(r.get("direction"))
            dir_str = (
                "wjazd" if intent_dir == "in"
                else "wyjazd" if intent_dir == "out"
                else "—"
            )
            unit = r.get("unit_label") or ""
            unit_str = f" [lokal {unit}]" if unit else ""
            lines.append(f"  • {r['time']} — {r['plate']} ({dir_str}){unit_str}")
            detections.append({
                "time": r["time"],
                "plate": r["plate"],
                "direction": intent_dir,
                "unitLabel": unit or None,
            })
            if r["plate"] not in uniq_plates:
                uniq_plates.append(r["plate"])
        n = len(reads)
        last = reads[0]
        last_dir = _db_direction_to_intent(last.get("direction"))
        last_dir_str = (
            "wjazd" if last_dir == "in"
            else "wyjazd" if last_dir == "out"
            else "przejazd"
        )
        last_unit = f", lokal {last['unit_label']}" if last.get("unit_label") else ""
        head = (
            f"Tak — {make} ({last['plate']}{last_unit}): ostatni {last_dir_str} "
            f"{last['time']}. Łącznie {_pl_plural(n, 'przejazd', 'przejazdy', 'przejazdów')} "
            f"({_pl_plural(len(uniq_plates), 'tablica', 'tablice', 'tablic')}) "
            f"{range_label}:\n"
        )
        display = lines[:10]
        more = f"\n  ... + {n - 10} więcej" if n > 10 else ""
        return {
            **base,
            "answer": head + "\n".join(display) + more,
            "data": {
                "make": make,
                "whitelisted_plates": len(all_plates),
                "count": n,
                "unique_plates": len(uniq_plates),
                "range_hours": range_h,
                "detections": detections,
            },
        }

    # ── search_vehicles_today ──
    if intent == "search_vehicles_today":
        # 2026-08-15 — agregat: wiersze 'lpr' (rejestr pojazdów) + 'vision'
        # (napisy OCR z kamer). "Czy widziałeś Solid?" znajduje i pojazdy,
        # i człowieka z napisem Solid na koszulce.
        keyword = parameters.get("keyword", "?")
        lpr_rows = [r for r in rows if (r.get("source") or "lpr") == "lpr"]
        vis_rows = [r for r in rows if r.get("source") == "vision"]
        if not rows:
            return {
                **base,
                "answer": (
                    f"{day_word} nie znalazłem niczego pasującego do \"{keyword}\" — "
                    "ani w rejestrze pojazdów, ani w napisach odczytanych z kamer."
                ),
                "data": {"keyword": keyword, "count": 0, "vehicles": [], "vision_hits": []},
            }
        lines = []
        vehicles = []
        seen_plates = set()  # deduplicate plate-y (ten sam pojazd może wjechać i wyjechać)
        for r in lpr_rows:
            plate = r["plate"]
            tags = _parse_tags(r)
            time = r["time"]
            intent_dir = _db_direction_to_intent(r.get("direction"))
            dir_str = "wjazd" if intent_dir == "in" else "wyjazd" if intent_dir == "out" else "—"
            owner = r.get("owner") or ""
            kind = r.get("vehicle_kind") or ""
            label = owner or (", ".join(tags[:2]) if tags else kind or "?")
            color = r.get("color") or ""
            extras = f" [{color}]" if color else ""
            lines.append(f"  • {time} — {plate} ({dir_str}) — {label}{extras}")
            if plate not in seen_plates:
                seen_plates.add(plate)
                vehicles.append({
                    "plate": plate, "color": r.get("color"), "tags": tags,
                    "owner": owner, "kind": kind, "direction": intent_dir, "time": time,
                })
        vision_lines = []
        vision_hits = []
        scene_map = {"person": "osoba", "car": "samochód", "truck": "ciężarówka/van",
                     "bus": "bus", "dog": "pies", "cat": "kot", "bicycle": "rower",
                     "motorcycle": "motocykl"}
        for r in vis_rows:
            time = r.get("time") or "?"
            cam = r.get("camera") or "?"
            try:
                tokens = json.loads(r.get("text_raw") or "[]")
            except (TypeError, ValueError):
                tokens = []
            hits = [str(t) for t in tokens if str(keyword).lower() in str(t).lower()][:3]
            try:
                summary = json.loads(r.get("summary") or "{}")
            except (TypeError, ValueError):
                summary = {}
            scene = ", ".join(scene_map.get(k, k) for k in summary) or "?"
            hit_str = f" (napis: {', '.join(hits)})" if hits else ""
            vision_lines.append(f"  • {time} — kamera {cam}, w kadrze: {scene}{hit_str}")
            vision_hits.append({"time": time, "camera": cam, "tokens": hits,
                                "summary": summary, "image_path": r.get("image_path")})
        parts = []
        if lpr_rows:
            parts.append(
                f"Pojazdy pasujące do \"{keyword}\" ({_visits_plural(len(lpr_rows))}):\n"
                + "\n".join(lines[:10])
            )
        if vis_rows:
            parts.append(
                f"Napis \"{keyword}\" w kadrze kamer ({len(vis_rows)}×):\n"
                + "\n".join(vision_lines[:10])
            )
        answer = "\n\n".join(parts)
        return {
            **base,
            "answer": answer,
            "data": {
                "keyword": keyword, "count": len(rows),
                "unique_plates": len(seen_plates), "vehicles": vehicles,
                "vision_hits": vision_hits,
            },
        }

    # ── courier_today (lista) ──
    if intent == "courier_today":
        if not rows:
            # §4: uczciwa odpowiedź w oknie ("Wczoraj wieczorem nie było
            # kuriera") zamiast generycznego NO_DATA_MSG.
            return {
                **base,
                "answer": f"{day_word} nie zarejestrowałem żadnego kuriera ani dostawy.",
                "data": {"count": 0, "visits": []},
            }
        lines = []
        visits = []
        for r in rows:
            tags = _parse_tags(r)
            color = r.get("color") or "?"
            plate = r["plate"]
            time = r["time"]
            tags_str = ", ".join(tags[:3]) if tags else "kurier"
            lines.append(f"  • {time} — {plate} [{tags_str}, {color}]")
            visits.append({
                "plate": plate,
                "color": r.get("color"),
                "tags": tags,
                "direction": _db_direction_to_intent(r.get("direction")),
                "time": time,
            })
        n = len(rows)
        answer = f"{day_word} było {_visits_plural(n)} kurierów:\n" + "\n".join(lines)
        return {**base, "answer": answer, "data": {"count": n, "visits": visits}}

    # ── vehicle_owner_by_plate (FAZA 8.h.23, 2026-06-12) ──
    # PRIVACY: nie ujawniamy właściciela (rows celowo nie zawierają kolumny
    # owner — patrz sql_templates). Odpowiadamy przypisanym lokalem.
    if intent == "vehicle_owner_by_plate":
        plate = parameters.get("plate", "?")
        if not rows:
            return {
                **base,
                "answer": (
                    f"Pojazd {plate} nie figuruje na białej liście osiedla — "
                    f"nie jest przypisany do żadnego lokalu."
                ),
                "data": {"plate": plate, "whitelisted": False},
            }
        r = rows[0]
        unit = r.get("unit_label")
        kind = r.get("vehicle_kind")
        kind_str = f" (typ: {kind})" if kind else ""
        if unit:
            answer = (
                f"Nie mogę podać danych właściciela, ale pojazd {plate} "
                f"jest przypisany do lokalu {unit}{kind_str}."
            )
        else:
            answer = (
                f"Pojazd {plate} jest na białej liście osiedla{kind_str}, "
                f"ale nie ma przypisanego lokalu. Danych właściciela nie mogę podać."
            )
        return {
            **base,
            "answer": answer,
            "data": {
                "plate": plate,
                "whitelisted": True,
                "unitLabel": unit,
                "vehicleKind": kind,
            },
        }

    # ── last_seen_plate (1 row) ──
    if intent == "last_seen_plate":
        if not rows:
            return {**base, "answer": NO_DATA_MSG, "data": None}
        r = rows[0]
        intent_dir = _db_direction_to_intent(r.get("direction"))
        verb = _direction_verb_single(intent_dir)
        color_str = f", kolor {r['color']}" if r.get("color") else ""
        tags = _parse_tags(r)
        tags_str = f", tagi: {', '.join(tags[:5])}" if tags else ""
        answer = (
            f"Tablica {r['plate']} ostatnio {verb} {r['time']}"
            f"{color_str}{tags_str}."
        )
        data = {
            "plate": r["plate"],
            "color": r.get("color"),
            "tags": tags,
            "direction": intent_dir,
            "time": r["time"],
        }
        return {**base, "answer": answer, "data": data}

    # ── vehicle_history_by_plate (lista) ──
    if intent == "vehicle_history_by_plate":
        if not rows:
            return {**base, "answer": NO_DATA_MSG, "data": None}
        plate = parameters["plate"]
        lines = []
        events = []
        for r in rows:
            intent_dir = _db_direction_to_intent(r.get("direction"))
            dir_str = (
                "wjazd" if intent_dir == "in"
                else "wyjazd" if intent_dir == "out"
                else "?"
            )
            color = r.get("color") or "?"
            tags = _parse_tags(r)
            lines.append(f"  • {r['time']} — {dir_str} [{color}]")
            events.append({
                "time": r["time"],
                "direction": intent_dir,
                "color": r.get("color"),
                "tags": tags,
            })
        n = len(rows)
        # Pokaż max 10 linii (50 events jest za dużo dla user-facing).
        lines_display = lines[:10]
        more = f"\n  ... + {len(lines) - 10} więcej" if len(lines) > 10 else ""
        answer = (
            f"Historia tablicy {plate} ({_events_plural(n)}):\n"
            + "\n".join(lines_display)
            + more
        )
        return {
            **base,
            "answer": answer,
            "data": {"plate": plate, "count": n, "events": events},
        }

    # ── list_unmatched_plates ──
    if intent == "list_unmatched_plates":
        if not rows:
            return {
                **base,
                "answer": "Brak nieznanych tablic w wybranym okresie.",
                "data": {"count": 0, "plates": []},
            }
        lines = []
        plates_data = []
        seen = set()
        for r in rows:
            plate = r["plate"]
            if plate in seen:
                continue
            seen.add(plate)
            tags = _parse_tags(r)
            color = r.get("color") or "?"
            brand = r.get("brand") or ""
            intent_dir = _db_direction_to_intent(r.get("direction"))
            dir_str = "wjazd" if intent_dir == "in" else "wyjazd" if intent_dir == "out" else "—"
            extras = f", {brand}" if brand else ""
            lines.append(f"  • {r['time']} — {plate} ({dir_str}) [{color}{extras}]")
            plates_data.append({
                "plate": plate, "color": r.get("color"), "brand": r.get("brand"),
                "tags": tags, "direction": intent_dir, "time": r["time"],
            })
        n = len(plates_data)
        range_h = parameters.get("range_hours", 24)
        scope = "dziś" if range_h == 24 else f"w ostatnich {range_h}h"
        answer = (
            f"Ostatnie {n} nieznanych tablic ({scope}):\n"
            + "\n".join(lines[:20])
        )
        return {**base, "answer": answer, "data": {"count": n, "plates": plates_data}}

    # ── list_errors_recent ──
    if intent == "list_errors_recent":
        range_h = parameters.get("range_hours", 1)
        scope = "w ostatniej godzinie" if range_h == 1 else f"w ostatnich {range_h}h"
        if not rows:
            return {
                **base,
                "answer": f"Brak błędów ani warningów {scope}. ✓",
                "data": {"count": 0, "events": []},
            }
        lines = []
        for r in rows:
            level = r.get("level", "?")
            cat = r.get("category", "?")
            msg = (r.get("message") or "")[:100]
            icon = "❌" if level == "error" else "⚠️"
            lines.append(f"  {icon} {r['time']} [{cat}] {msg}")
        n = len(rows)
        answer = f"Znalazłem {n} zdarzeń {scope}:\n" + "\n".join(lines[:15])
        return {**base, "answer": answer, "data": {"count": n, "events": rows}}

    # ── count_errors_recent ──
    if intent == "count_errors_recent":
        range_h = parameters.get("range_hours", 1)
        scope = "w ostatniej godzinie" if range_h == 1 else f"w ostatnich {range_h}h"
        if not rows:
            return {
                **base,
                "answer": f"Brak błędów ani warningów {scope}. ✓",
                "data": {"errors": 0, "warnings": 0},
            }
        breakdown = {r["level"]: int(r["count"]) for r in rows}
        errors = breakdown.get("error", 0)
        warnings = breakdown.get("warning", 0)
        answer = (
            f"{scope.capitalize()}: {errors} błędów, {warnings} ostrzeżeń."
        )
        return {
            **base,
            "answer": answer,
            "data": {"errors": errors, "warnings": warnings},
        }

    # ── list_devices ──
    if intent == "list_devices":
        if not rows:
            return {
                **base,
                "answer": "Brak skonfigurowanych urządzeń.",
                "data": {"count": 0, "devices": []},
            }
        lines = []
        devices = []
        # Grupuj po type
        by_type: dict[str, list] = {}
        for r in rows:
            t = r.get("type", "?")
            by_type.setdefault(t, []).append(r)
            devices.append({
                "device_id": r["device_id"],
                "type": t,
                "enabled": bool(r.get("enabled")),
            })
        type_labels = {
            "intercom": "Domofony", "camera": "Kamery", "lprCamera": "Kamery LPR",
            "elevator": "Windy", "lighting": "Oświetlenie", "edge": "Edge",
        }
        for t, items in sorted(by_type.items()):
            label = type_labels.get(t, t)
            ids = ", ".join(it["device_id"][:8] for it in items[:5])
            count_extra = f" (+{len(items)-5})" if len(items) > 5 else ""
            lines.append(f"  • {label}: {len(items)} — {ids}{count_extra}")
        total = len(rows)
        answer = f"Skonfigurowane urządzenia ({total}):\n" + "\n".join(lines)
        return {**base, "answer": answer, "data": {"count": total, "devices": devices}}

    # ── count_objects_today (YOLO vision) ──
    if intent == "count_objects_today":
        count = int(rows[0]["count"]) if rows else 0
        frames = int(rows[0]["frame_count"]) if rows else 0
        cls = parameters.get("object_class", "?")
        range_h = parameters.get("range_hours", 24)
        scope = _wl or ("dzisiaj" if range_h == 24 else (
            "w ostatniej godzinie" if range_h == 1 else f"w ostatnich {range_h}h"
        ))
        label_pl = _vision_label_pl(cls, count)
        if count == 0:
            answer = (
                f"Kamery nie zarejestrowały {_vision_label_pl_genitive(cls)} {scope}."
            )
        else:
            answer = (
                f"Kamery zarejestrowały {label_pl} {scope}"
                f" (w {frames} klatkach)."
            )
        return {
            **base,
            "answer": answer,
            "data": {
                "object_class": cls,
                "count": count,
                "frame_count": frames,
                "range_hours": range_h,
            },
        }

    # ── list_recent_detections (YOLO vision) ──
    if intent == "list_recent_detections":
        range_h = parameters.get("range_hours", 1)
        scope = "w ostatniej godzinie" if range_h == 1 else f"w ostatnich {range_h}h"
        if not rows:
            return {
                **base,
                "answer": f"Kamery nic ciekawego nie zobaczyły {scope}.",
                "data": {"count": 0, "detections": []},
            }
        lines = []
        detections = []
        for r in rows:
            raw_summary = r.get("summary") or "{}"
            try:
                summary_obj = json.loads(raw_summary)
            except (json.JSONDecodeError, TypeError):
                summary_obj = {}
            summary_str = (
                ", ".join(f"{k}×{v}" for k, v in summary_obj.items())
                if summary_obj
                else "—"
            )
            cam_short = (r.get("camera") or "")[:8]
            lines.append(
                f"  • {r['time']} [cam {cam_short}] {summary_str}"
            )
            detections.append({
                "id": r.get("id"),
                "camera": r.get("camera"),
                "time": r.get("time"),
                "summary": summary_obj,
                "inference_ms": r.get("inference_ms"),
            })
        n = len(rows)
        answer = (
            f"Ostatnie {n} detekcji {scope}:\n" + "\n".join(lines[:20])
        )
        return {
            **base,
            "answer": answer,
            "data": {"count": n, "detections": detections},
        }

    # Defensywny fallback — nie powinno tu trafić, bo validate() upewnia że
    # intent jest w VALID_INTENTS, a wszystkie powyżej są obsłużone.
    return {**base, "answer": UNKNOWN_MSG, "data": None}


# ── Vision helpers (Polish plural forms for COCO classes) ────────────────────

_VISION_PL_NOMINATIVE: dict[str, tuple[str, str, str]] = {
    # canonical → (1 singular, 2-4 plural, 5+ plural) — for {n} {form}
    "person":      ("1 osobę", "{n} osoby", "{n} osób"),
    "dog":         ("1 psa",   "{n} psy",   "{n} psów"),
    "cat":         ("1 kota",  "{n} koty",  "{n} kotów"),
    "bicycle":     ("1 rower", "{n} rowery","{n} rowerów"),
    "motorcycle":  ("1 motocykl", "{n} motocykle", "{n} motocykli"),
    "bus":         ("1 autobus", "{n} autobusy",   "{n} autobusów"),
    "truck":       ("1 ciężarówkę", "{n} ciężarówki", "{n} ciężarówek"),
    "backpack":    ("1 plecak", "{n} plecaki", "{n} plecaków"),
    "handbag":     ("1 torebkę", "{n} torebki", "{n} torebek"),
    "suitcase":    ("1 walizkę", "{n} walizki", "{n} walizek"),
    "umbrella":    ("1 parasol", "{n} parasole", "{n} parasoli"),
    "car":         ("1 samochód", "{n} samochody", "{n} samochodów"),
}

# FAZA 8.h.29 — formy dla last_seen_object: (biernik „widziałem X",
# dopełniacz „nie widziałem X"). Pseudo-klasa `animal` = kot|pies.
_VISION_PL_SIGHT: dict[str, tuple[str, str]] = {
    "person":     ("osobę", "żadnej osoby"),
    "dog":        ("psa", "psa"),
    "cat":        ("kota", "kota"),
    "bicycle":    ("rower", "roweru"),
    "motorcycle": ("motocykl", "motocykla"),
    "bus":        ("autobus", "autobusu"),
    "truck":      ("ciężarówkę", "ciężarówki"),
    "backpack":   ("plecak", "plecaka"),
    "handbag":    ("torebkę", "torebki"),
    "suitcase":   ("walizkę", "walizki"),
    "umbrella":   ("parasol", "parasola"),
    "car":        ("samochód", "samochodu"),
    "animal":     ("zwierzę (kot/pies)", "żadnego zwierzęcia (kot/pies)"),
}

_VISION_PL_GENITIVE: dict[str, str] = {
    "person":     "osób",
    "dog":        "psów",
    "cat":        "kotów",
    "bicycle":    "rowerów",
    "motorcycle": "motocykli",
    "bus":        "autobusów",
    "truck":      "ciężarówek",
    "backpack":   "plecaków",
    "handbag":    "torebek",
    "suitcase":   "walizek",
    "umbrella":   "parasoli",
    "car":        "samochodów",
}


def _vision_label_pl(cls: str, n: int) -> str:
    """Polish plural for the count message. Falls back to '<n> <class>' for
    classes we haven't tabulated yet."""
    forms = _VISION_PL_NOMINATIVE.get(cls)
    if not forms:
        return f"{n} {cls}"
    if n == 1:
        return forms[0]
    last_two = n % 100
    last = n % 10
    if 12 <= last_two <= 14:
        return forms[2].format(n=n)
    if 2 <= last <= 4:
        return forms[1].format(n=n)
    return forms[2].format(n=n)


def _vision_label_pl_genitive(cls: str) -> str:
    """Genitive plural for 'nie zarejestrowały żadnych <X>' clauses."""
    return _VISION_PL_GENITIVE.get(cls, cls)


def _visits_plural(n: int) -> str:
    if n == 1:
        return "1 wizyta"
    last_two = n % 100
    last = n % 10
    if 12 <= last_two <= 14:
        return f"{n} wizyt"
    if 2 <= last <= 4:
        return f"{n} wizyty"
    return f"{n} wizyt"


def _events_plural(n: int) -> str:
    if n == 1:
        return "1 zdarzenie"
    last_two = n % 100
    last = n % 10
    if 12 <= last_two <= 14:
        return f"{n} zdarzeń"
    if 2 <= last <= 4:
        return f"{n} zdarzenia"
    return f"{n} zdarzeń"


# ── Wizyty pojazdu z klatek wizji (2026-10-07) ─────────────────────────────
# Jeden van widzi kilka kamer w ciągu kilku minut — mieszkańca interesuje
# PRZYJAZD („pojazd FRISCO WX1234A, dziś 13:14"), nie lista klatek.
# Przerwa >12 min = nowa wizyta (jak COURIER_VISIT w SituationCorrelator).
VISIT_GAP_MS = 12 * 60_000
MAX_VISIT_LINES = 8
# Odczyty pojazdów mieszkańców i gości to nie van dostawcy — i nie
# pokazujemy ich tablic innym mieszkańcom.
_PRIVATE_KINDS = {"RESIDENT", "GUEST"}
_PL_MONTHS_GEN = [
    "stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca",
    "sierpnia", "września", "października", "listopada", "grudnia",
]


def _brand_label(brand: str) -> str:
    return str(brand or "?").replace("_", " ")


def _brand_terms(brand: str) -> list[str]:
    b = str(brand or "").lower()
    return sorted({b, b.replace("_", " "), b.replace("_", "")} - {""})


def _times_pl(n: int) -> str:
    return "raz" if n == 1 else f"{n} razy"


def _hhmm(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000).strftime("%H:%M")


def _when_pl(ts_ms: int, now: datetime | None = None) -> str:
    """„dziś 13:14" / „wczoraj 08:50" / „5 października 08:05" (czas lokalny Edge)."""
    dt = datetime.fromtimestamp(ts_ms / 1000)
    today = (now or datetime.now()).date()
    hm = dt.strftime("%H:%M")
    if dt.date() == today:
        return f"dziś {hm}"
    if dt.date() == today - timedelta(days=1):
        return f"wczoraj {hm}"
    return f"{dt.day} {_PL_MONTHS_GEN[dt.month - 1]} {hm}"


def _group_visits(rows: list[dict], brand_terms: list[str]) -> list[dict]:
    """Klatki (dowolna kolejność) → wizyty od najnowszej, z tablicą pojazdu."""
    frames = sorted((r for r in rows if r.get("ts") is not None), key=lambda r: int(r["ts"]))
    visits: list[dict] = []
    for r in frames:
        ts = int(r["ts"])
        if visits and ts - visits[-1]["end"] <= VISIT_GAP_MS:
            visits[-1]["end"] = ts
            visits[-1]["frames"].append(r)
        else:
            visits.append({"start": ts, "end": ts, "frames": [r]})
    for v in visits:
        cams: list[str] = []
        for f in v["frames"]:
            cam = f.get("camera")
            if cam and cam not in cams:
                cams.append(cam)
        v["cameras"] = cams
        v["brands"] = sorted({f.get("brand") for f in v["frames"] if f.get("brand")})
        v["plate"] = _visit_plate(v, brand_terms)
    visits.reverse()
    return visits


def _visit_plate(visit: dict, brand_terms: list[str]) -> dict | None:
    """Tablica pojazdu wizyty z odczytów LPR wokół klatek (`lpr_near`).

    Pewna: odczyt, którego tagi z rejestru wskazują markę (np. van Frisco
    dopisany jako pojazd serwisowy). Prawdopodobna: jedyny obcy pojazd
    w oknie albo jedyny dostawczy. Inaczej None — nie zgadujemy.
    """
    cands: dict[str, dict] = {}
    for f in visit["frames"]:
        try:
            reads = json.loads(f.get("lpr_near") or "[]")
        except (TypeError, ValueError):
            reads = []
        for rd in reads if isinstance(reads, list) else []:
            plate = (rd or {}).get("plate")
            if not plate or str(rd.get("kind") or "").upper() in _PRIVATE_KINDS:
                continue
            ts = int(rd.get("ts") or 0)
            c = cands.setdefault(plate, {"plate": plate, "ts": ts, "in_ts": None,
                                         "cam": rd.get("cam"), "branded": False, "van": False})
            c["ts"] = min(c["ts"], ts)
            if rd.get("dir") == "in":
                c["in_ts"] = ts if c["in_ts"] is None else min(c["in_ts"], ts)
                c["cam"] = rd.get("cam") or c["cam"]
            tags = str(rd.get("tags") or "").lower()
            if any(t in tags for t in brand_terms):
                c["branded"] = True
            vtype = str(rd.get("type") or "").lower()
            if any(k in vtype for k in ("van", "truck", "bus")):
                c["van"] = True
    if not cands:
        return None
    branded = [c for c in cands.values() if c["branded"]]
    if len(branded) == 1:
        return {**branded[0], "certain": True}
    if branded:
        return None
    if len(cands) == 1:
        return {**next(iter(cands.values())), "certain": False}
    vans = [c for c in cands.values() if c["van"]]
    if len(vans) == 1:
        return {**vans[0], "certain": False}
    return None


def _visit_lines(visits: list[dict], show_brand: bool = False) -> str:
    lines = []
    for v in visits[:MAX_VISIT_LINES]:
        p = v.get("plate")
        brands = f" ({', '.join(_brand_label(b) for b in v['brands'])})" if show_brand and v.get("brands") else ""
        if p:
            # Czas wjazdu z kamery LPR, gdy jest — to moment, o który pyta mieszkaniec.
            when = _when_pl(p["in_ts"] if p.get("in_ts") else v["start"])
            verb = "wjechał pojazd" if p.get("in_ts") else "pojazd"
            plate = f" {p['plate']}" if p["certain"] else f", prawdopodobnie {p['plate']}"
            lines.append(f"  • {when}{brands} — {verb}{plate}")
        else:
            cams = v.get("cameras") or []
            seen = f" (widziany: {', '.join(cams[:3])})" if cams else ""
            lines.append(f"  • {_when_pl(v['start'])}{brands} — tablicy nie udało się ustalić{seen}")
    rest = len(visits) - MAX_VISIT_LINES
    if rest > 0:
        lines.append(f"  … i {_times_pl(rest)} wcześniej")
    return "\n".join(lines)


def _visit_payload(v: dict) -> dict:
    p = v.get("plate")
    return {
        "start": _when_pl(v["start"]),
        "end": _hhmm(v["end"]),
        "cameras": v.get("cameras") or [],
        "frames": len(v["frames"]),
        "plate": p["plate"] if p else None,
        "plateCertain": bool(p and p["certain"]),
    }


def _range_label(range_hours: int) -> str:
    """User-facing PL label dla okna czasowego.

    Used by search_by_brand_today (latent reference fixed 2026-05-19) and the
    new search_by_waste_today branch. Granularity coarse — we only need to
    convey "dziś" vs "tydzień" vs explicit godziny; sub-hour precision is
    irrelevant for camera-event queries that poll every 60s.
    """
    if range_hours <= 1:
        return "w ostatniej godzinie"
    # 8.h.32: okna pośrednie (np. "ostatnie 12 godzin") mają precyzyjny
    # label — "dzisiaj" sugerowało kalendarzowy dzień, a user pytał o 12h.
    if range_hours < 24:
        return f"w ostatnich {range_hours} godzinach"
    if range_hours == 24:
        return "dzisiaj"
    if range_hours <= 48:
        return "w ostatnich 48 godzinach"
    if range_hours <= 168:
        return "w ostatnim tygodniu"
    days = max(1, round(range_hours / 24))
    return f"w ostatnich {days} dniach"


# Human-readable PL category label dla waste-truck responses. Genitive form
# bo używamy w kontekście „dziś nie było {category}" / „odebrali {category}".
_WASTE_CATEGORY_LABEL_PL: dict[str, str] = {
    "GLASS":   "szkła",
    "PAPER":   "papieru",
    "PLASTIC": "plastiku",
    "BIO":     "odpadów bio",
    "MIXED":   "odpadów zmieszanych",
}


def _waste_category_label(category: str | None) -> str:
    """Genitive PL label dla kategorii. Fallback do generic gdy NULL."""
    if not category:
        return "śmieci"
    return _WASTE_CATEGORY_LABEL_PL.get(category.upper(), category.lower())


# ─────────────────────────────────────────────────────────────────────────────
# waste_pickup_status (Event Intelligence §8, 2026-08-15) — SCHEDULE_VS_OBSERVED
# ─────────────────────────────────────────────────────────────────────────────

def build_waste_pickup_status(
    category: str | None,
    scheduled_today: list[dict],
    observations: list[dict],
    next_event: dict | None,
    schedule_stale_date: str | None,
) -> dict:
    """
    „Czy śmieci już zabrali?" — porównanie harmonogramu (KB) z obserwacjami
    kamer z DZIŚ. Poziomy pewności (spec §6/§8/§18):
      • OBSERVED  = pojazd z oznaczeniem operatora/śmieciarka w kadrze,
      • INFERRED  = „najprawdopodobniej tak" (harmonogram + obserwacja),
      • nigdy nie stwierdzamy WYKONANIA odbioru na podstawie samego wjazdu.
    Odpowiedź jest deterministyczna (bez LLM rewrap) — hedging ma przetrwać.
    """
    cat_label = _waste_category_label(category)
    sched_labels = [
        _waste_category_label(e.get("category_valid") or None) for e in scheduled_today
    ]
    obs_lines: list[str] = []
    for o in observations[:5]:
        time = o.get("time") or "?"
        who = o.get("operator") or o.get("category_label") or "śmieciarka"
        cam = o.get("camera") or "?"
        obs_lines.append(f"  • {time} — pojazd rozpoznany jako {who} (kamera {cam})")

    parts: list[str] = []
    data: dict[str, Any] = {
        "category": category,
        "scheduledToday": scheduled_today,
        "observations": observations,
        "nextEvent": next_event,
        "scheduleStaleDate": schedule_stale_date,
    }

    if scheduled_today and observations:
        parts.append(
            f"Najprawdopodobniej tak. Na dziś zaplanowany jest odbiór "
            f"{', '.join(sched_labels)}, a kamery zarejestrowały:\n" + "\n".join(obs_lines)
        )
        parts.append(
            "(Wjazd śmieciarki nie przesądza, że odbiór został wykonany w całości.)"
        )
    elif scheduled_today and not observations:
        parts.append(
            f"Na dziś zaplanowany jest odbiór {', '.join(sched_labels)}, "
            f"ale kamery nie zarejestrowały jeszcze śmieciarki. "
            f"Możliwe, że jeszcze nie przyjechała."
        )
    elif not scheduled_today and observations:
        parts.append(
            f"W harmonogramie nie ma na dziś odbioru {cat_label}, "
            f"ale kamery zarejestrowały:\n" + "\n".join(obs_lines)
        )
    else:
        parts.append(
            f"Na dziś nie ma zaplanowanego odbioru {cat_label} "
            f"i kamery nie zarejestrowały śmieciarki."
        )
    if next_event and not scheduled_today:
        parts.append(
            f"Najbliższy planowany odbiór: {next_event.get('title', 'odbiór')} "
            f"{next_event.get('date', '?')}."
        )
    if schedule_stale_date:
        parts.append(
            f"Uwaga: wgrany harmonogram kończy się {schedule_stale_date} — "
            f"poproś zarządcę o aktualny."
        )

    return {
        "intent": "waste_pickup_status",
        "parameters": {"category": category} if category else {},
        "answer": " ".join(parts),
        "data": data,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Knowledge base (RAG search) — deterministic template builder.
# ─────────────────────────────────────────────────────────────────────────────

def build_knowledge_response(
    query: str,
    type_filter: str | None,
    hits: list[dict],
) -> dict:
    """
    Deterministyczna odpowiedź z bge-m3 search hits.

    hits[i] = {docId, type, title, chunkIdx, text, score} — z Edge endpointu
    POST /knowledge/search.

    Format (fast mode, gdy req.smart=False):
      • Brak hitów → fixed message „Nie znalazłem informacji…"
      • >=1 hit → lista do 5 cytatów z tytułem/typem/score + skrócony tekst

    Smart mode (req.smart=True) używa tego dict-a jako bazy i nadpisuje
    `answer` LLM-composed natural language odpowiedzią.
    """
    parameters: dict = {"query": query}
    if type_filter:
        parameters["type"] = type_filter

    if not hits:
        # 8.h.31 — uczciwa odpowiedź z podpowiedzią następnego kroku
        # (zamiast suchego „nie znalazłem"): pytania o kontakty/naprawy/
        # awarie routują tu ZAWSZE (nigdy unknown), więc brak hitów znaczy
        # że dokumentu faktycznie nie ma w KB — kieruj usera do zarządcy.
        scope = f" w dokumentach typu {type_filter}" if type_filter else ""
        return {
            "intent": "search_knowledge_base",
            "parameters": parameters,
            "answer": (
                f"Nie znalazłem takiej informacji{scope} w bazie wiedzy "
                f"budynku. Spróbuj zapytać zarządcę lub administrację osiedla."
            ),
            "data": {"hits": [], "hitCount": 0},
        }

    # FAZA 8.h.18 (2026-06-09) — dedup hits per (docId, title) PRZED template
    # answer i przed smart LLM. Bez tego template/LLM widzi 2 raz ten sam
    # dokument (różne chunki) i renderuje obie sekcje z duplikowanym
    # tytułem/score, co user widzi w `DaySummaryCard` jako podwojone wpisy
    # "Co dziś się wydarzy". Zostawiamy 1 entry per dokument — sklejamy
    # texty wszystkich chunków (z separatorem) i bierzemy max score.
    deduped: list[dict] = []
    seen: dict[tuple, int] = {}  # key (docId, title) → index w `deduped`
    for h in hits:
        doc_id = h.get("docId")
        title = h.get("title", "?")
        key = (doc_id, title) if doc_id is not None else (None, title)
        if key in seen:
            # Sklej tekst chunka — może uzupełni info której nie było
            # w pierwszym chunku (np. dalsze daty).
            existing = deduped[seen[key]]
            extra_text = (h.get("text") or "").strip()
            if extra_text and extra_text not in (existing.get("text") or ""):
                existing["text"] = (existing.get("text") or "") + "\n" + extra_text
            # Max score żeby ranking dalej był sensowny.
            try:
                if float(h.get("score", 0)) > float(existing.get("score", 0)):
                    existing["score"] = h.get("score")
            except (TypeError, ValueError):
                pass
        else:
            seen[key] = len(deduped)
            # Shallow copy żeby nie mutować oryginałów (dalej zwracamy
            # w `data.hits` listę pre-dedup do debug-u).
            deduped.append(dict(h))

    # Limit do 5 cytatów dla template-a; LLM może użyć tych samych w smart mode.
    lines: list[str] = []
    for h in deduped[:5]:
        text_short = (h.get("text") or "").replace("\n", " ")
        if len(text_short) > 300:
            text_short = text_short[:300] + "…"
        title = h.get("title", "?")
        doc_type = h.get("type", "?")
        score = float(h.get("score", 0))
        lines.append(f"\n📄 *{title}* ({doc_type}, dopasowanie {score:.2f}):\n{text_short}")

    answer = f"Znalazłem {len(deduped)} fragmentów w bazie wiedzy:" + "\n".join(lines)
    return {
        "intent": "search_knowledge_base",
        "parameters": parameters,
        # Smart mode dostaje `dedupedHits` (single entry per dokument), template
        # dostaje `answer` już bez duplikatów. Klient (BA debug) widzi pełną
        # listę przez `hits` (pre-dedup) — tam można policzyć ile chunków
        # zostało scalonych.
        "answer": answer,
        "data": {"hits": hits, "dedupedHits": deduped, "hitCount": len(deduped)},
    }


# ─────────────────────────────────────────────────────────────────────────────
# Activity summary — multi-aggregate report builder.
# ─────────────────────────────────────────────────────────────────────────────

def _pl_plural(n: int, one: str, few: str, many: str) -> str:
    """
    Polski plural — generyczny helper.
      n=1                     → one  ("auto", "kurier", "pies")
      n=2-4 (oprócz 12-14)    → few  ("auta", "kurierów", "psy")
      n=5+, 0, 11-14, 22, ... → many ("aut", "kurierów", "psów")
    Zwraca pełny fragment "N słowo" (z liczbą).
    """
    if n == 1:
        return f"1 {one}"
    last_two = n % 100
    last = n % 10
    if 12 <= last_two <= 14:
        return f"{n} {many}"
    if 2 <= last <= 4:
        return f"{n} {few}"
    return f"{n} {many}"


def _range_label_for_summary(range_hours: int) -> str:
    """Label dla nagłówka raportu — różny niż _range_label (genitive form)."""
    if range_hours == 1:
        return "ostatniej godziny"
    if range_hours <= 4:
        return f"ostatnich {range_hours} godzin"
    if range_hours == 24:
        return "ostatniej doby"
    if range_hours <= 48:
        return f"ostatnich {range_hours} godzin"
    if range_hours == 168:
        return "ostatniego tygodnia"
    days = max(1, round(range_hours / 24))
    return f"ostatnich {days} dni"


def build_activity_summary(
    range_hours: int,
    lpr: dict,
    vision: dict,
    special_guests: list[dict] | None = None,
    waste_pickups: list[dict] | None = None,
    person_visits: dict | None = None,
) -> dict:
    """
    Składa multi-section answer z LPR + vision aggregates.

    Args:
      range_hours: okno czasowe (1/4/12/24/168/...)
      lpr: jeden wiersz z _LPR_SUMMARY_SQL — keys: total, in_count, out_count,
           matched_count, unmatched_count, gate_opens, courier_count
      vision: jeden wiersz z _VISION_SUMMARY_SQL — keys: frame_count,
              person_frames, dog_frames, cat_frames, truck_frames,
              bicycle_frames, notable_events

    Returns dict z `answer`/`data` w shape kompatybilnym z build().
    """
    # int-fy z aiosqlite Row mogą być None gdy COUNT/SUM nic nie znalazł —
    # COALESCE w SQL daje 0, ale na wszelki wypadek explicit cast.
    def _i(d: dict, k: str) -> int:
        v = d.get(k)
        try:
            return int(v or 0)
        except (TypeError, ValueError):
            return 0

    total       = _i(lpr, "total")
    in_count    = _i(lpr, "in_count")
    out_count   = _i(lpr, "out_count")
    matched     = _i(lpr, "matched_count")
    unmatched   = _i(lpr, "unmatched_count")
    gate_opens  = _i(lpr, "gate_opens")
    couriers    = _i(lpr, "courier_count")

    person_fr   = _i(vision, "person_frames")
    dog_fr      = _i(vision, "dog_frames")
    cat_fr      = _i(vision, "cat_frames")
    truck_fr    = _i(vision, "truck_frames")
    bicycle_fr  = _i(vision, "bicycle_frames")
    notable     = _i(vision, "notable_events")
    frame_cnt   = _i(vision, "frame_count")

    label = _range_label_for_summary(range_hours)  # genitive — "ostatniej doby"
    locative_label = _range_label(range_hours)     # locative  — "dzisiaj" / "w ostatnich 24 godzinach"

    # ── Bez aktywności w ogóle ──
    if total == 0 and frame_cnt == 0:
        return {
            "intent": "recent_activity_summary",
            "parameters": {"range_hours": range_hours},
            "answer": f"{locative_label.capitalize()} nic się nie działo — brak zarejestrowanych zdarzeń.",
            "data": {
                "range_hours": range_hours,
                "lpr": lpr, "vision": vision,
            },
        }

    sections: list[str] = []
    sections.append(f"📊 Podsumowanie {label}:")

    # ── Sekcja: ruch pojazdów ──
    # Day Summary v2 (2026-08-17): liczby ODCZYTÓW, spójne semantycznie —
    # wcześniejsze „wjechało 7 aut, z czego 9 spoza listy" (matched/unmatched
    # liczone od total, nie od in_count) czytało się jak błąd arytmetyczny.
    if total > 0:
        vehicle_lines: list[str] = []
        if in_count > 0:
            vehicle_lines.append(f"{_pl_plural(in_count, 'wjazd', 'wjazdy', 'wjazdów')}")
        if out_count > 0:
            vehicle_lines.append(f"{_pl_plural(out_count, 'wyjazd', 'wyjazdy', 'wyjazdów')}")
        if not vehicle_lines:
            vehicle_lines.append(f"{_pl_plural(total, 'przejazd', 'przejazdy', 'przejazdów')}")
        line = "🚗 Ruch przy bramie: " + " i ".join(vehicle_lines)
        if matched > 0:
            line += f" — w tym {_pl_plural(matched, 'przejazd', 'przejazdy', 'przejazdów')} aut z rejestru osiedla"
        sections.append(line + ".")

    # ── Kurierzy (ogólny licznik LPR-side) ──
    # Pokazywany TYLKO gdy nie ma konkretnych marek (special_guests) —
    # inaczej dublował informację i mylił („3 kurierów" + „Frisco ×3").
    if couriers > 0 and not special_guests:
        sections.append(
            f"📦 Dostawy: {_pl_plural(couriers, 'kurier', 'kurierów', 'kurierów')}."
        )

    # ── Specjalni goście — konkretne marki/usługi (DPD, Bolt, DHL, ...) ──
    # 3 źródła: vision OCR brand, LPR Hikvision brand, LPR owner keyword.
    # Już zdeduplikowane w `_merge_special_guests` na warstwie app.py.
    if special_guests:
        guest_lines: list[str] = []
        # Group by kind dla czytelności (kurierzy razem, taksówki razem itd.)
        groups = {"kurier": [], "taksówka": [], "jedzenie": [], "inne": []}
        for g in special_guests[:8]:  # top 8 per default
            kind = g.get("kind", "inne")
            groups.setdefault(kind, []).append(g)
        kind_emoji = {
            "kurier":    "📦",
            "taksówka":  "🚕",
            "jedzenie":  "🍕",
            "inne":      "•",
        }
        for kind, items in groups.items():
            if not items:
                continue
            parts = [
                f"{g['name']} ×{g['hits']}" if g["hits"] > 1 else g["name"]
                for g in items
            ]
            guest_lines.append(f"{kind_emoji[kind]} {kind.capitalize()}: {', '.join(parts)}")
        if guest_lines:
            sections.append("🚚 Dostawy i usługi na osiedlu:")
            for line in guest_lines:
                sections.append(f"   {line}")

    # ── Śmieciarka — kategorie odbioru z vision OCR ──
    if waste_pickups:
        waste_labels = {
            "GLASS":   "szkło",
            "PAPER":   "papier",
            "PLASTIC": "plastik/metale",
            "BIO":     "bio",
            "MIXED":   "zmieszane",
        }
        waste_lines: list[str] = []
        for w in waste_pickups[:5]:
            cat = (w.get("category") or "").upper()
            label = waste_labels.get(cat, cat.lower() or "śmieci")
            op = w.get("operator")
            last_time = w.get("last_time")  # HH:MM (Day Summary v2)
            suffix = f", {op}" if op else ""
            time_suffix = f" ok. {last_time}" if last_time else ""
            waste_lines.append(f"{label}{suffix}{time_suffix}")
        if waste_lines:
            sections.append("♻️ Śmieciarka była: " + "; ".join(waste_lines) + ".")

    # ── Brama ──
    if gate_opens > 0:
        sections.append(
            f"🚪 Brama otworzyła się {_pl_plural(gate_opens, 'raz', 'razy', 'razy')}."
        )

    # ── Vision: ludzie & zwierzęta ──
    # 2026-05-23: Refactor person line — zamiast „w X klatkach" (mylące, bo
    # YOLO bez person-tracker'a liczy każdą klatkę), używamy temporal-cluster
    # proxy: liczba sesji (wizyt) + szacunkowa liczba unikalnych osób
    # (sum max-per-session). `person_visits` opcjonalne — fallback do
    # starego formatu z explicit „klatkami" gdy nie podano.
    vision_lines: list[str] = []
    if person_visits and (person_visits.get("visits") or 0) > 0:
        # Day Summary v2: sam licznik wizyt — „szacunkowo 160 osób" (suma
        # max-per-sesja) brzmiało absurdalnie i podważało zaufanie do reszty.
        v = int(person_visits["visits"])
        vision_lines.append(
            _pl_plural(v, 'wizyta pieszych', 'wizyty pieszych', 'wizyt pieszych')
        )
    elif person_fr > 0:
        # Fallback gdy person_visits nie podano (kompatybilność wsteczna).
        vision_lines.append(
            _pl_plural(person_fr, 'pojawienie osoby', 'pojawienia osób', 'pojawień osób')
        )
    # Day Summary v2 (2026-08-17): zwierzęta/rowery to liczby KLATEK (bez
    # trackera) — piszemy „ujęć", nie sugerujemy sztuk. Ciężarówki i „archiwum
    # kamery" usunięte całkiem: klatki vanów (36-49 „ciężarówek" na osiedlu
    # domów) i licznik archiwum nic mieszkańcowi nie mówiły.
    if dog_fr > 0:
        vision_lines.append(f"psy ({_pl_plural(dog_fr, 'ujęcie', 'ujęcia', 'ujęć')})")
    if cat_fr > 0:
        vision_lines.append(f"koty ({_pl_plural(cat_fr, 'ujęcie', 'ujęcia', 'ujęć')})")
    if bicycle_fr > 0:
        vision_lines.append(f"rowerzyści ({_pl_plural(bicycle_fr, 'ujęcie', 'ujęcia', 'ujęć')})")

    if vision_lines:
        sections.append("🚶 Przy bramie: " + ", ".join(vision_lines) + ".")

    answer = "\n".join(sections)

    return {
        "intent": "recent_activity_summary",
        "parameters": {"range_hours": range_hours},
        "answer": answer,
        "data": {
            "range_hours": range_hours,
            "lpr": {
                "total":     total,
                "in":        in_count,
                "out":       out_count,
                "matched":   matched,
                "unmatched": unmatched,
                "gate_opens": gate_opens,
                "couriers":  couriers,
            },
            "vision": {
                "frame_count":    frame_cnt,
                "person_frames":  person_fr,
                "dog_frames":     dog_fr,
                "cat_frames":     cat_fr,
                "truck_frames":   truck_fr,
                "bicycle_frames": bicycle_fr,
                "notable_events": notable,
            },
            # Per-brand dane do UI cards (BA dashboard / iOS HomeView).
            "special_guests": special_guests or [],
            "waste_pickups":  waste_pickups or [],
            # 2026-05-23: temporal-cluster proxy dla unikalnych osób.
            # `visits` = sesji (pojawień), `est_persons` = sum(max per session) —
            # przybliżenie unikalnych osób (proxy, NIE ground truth).
            "person_visits":  person_visits or {
                "visits": 0, "est_persons": 0,
                "max_concurrent": 0, "frames_with_person": 0,
            },
        },
    }
