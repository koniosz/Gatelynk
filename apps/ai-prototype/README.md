# GateLynk AI Backend (prototype)

Prosty, deterministyczny backend AI. **LLM klasyfikuje intencję, backend wykonuje gotowy SQL.**

## Założenia projektowe

- LLM **nigdy** nie generuje SQL ani user-facing tekstu
- LLM zwraca **wyłącznie** JSON z intencją + parametrami
- SQL jest z zamkniętej whitelisty (`sql_templates.py`)
- Tylko `SELECT`, każde listujące zapytanie ma `LIMIT`
- Parametry przez positional placeholders (`$1`, `$2`) — Postgres parsuje osobno → SQL injection niemożliwe
- Odpowiedzi user-facing są template-owane (`response_builder.py`) — brak halucynacji
- LLM `temperature=0`, `format="json"` → reproducible output

## Architektura

```
        ┌─────────┐
        │  user   │ "Ile białych aut dziś wjechało?"
        └────┬────┘
             │ POST /ask
             ▼
       ┌──────────┐
       │  app.py  │
       └─────┬────┘
             │ classify(question)
             ▼
   ┌─────────────────────┐    1. regex match (większość pytań, <1ms)
   │ intent_classifier   │    2. LLM fallback (Ollama, JSON mode, temp=0)
   │  • classify_regex   │    3. validate() — canonical form + enum check
   │  • classify_llm     │
   │  • validate         │       {"intent": "count_vehicles_by_color_today",
   └──────────┬──────────┘        "parameters": {"color": "white", "direction": "in"}}
              │
              ▼
   ┌─────────────────────┐    Whitelist lookup po `intent` →
   │  sql_templates.py   │    parameterized SELECT z $1, $2, ...
   └──────────┬──────────┘
              │
              ▼
   ┌─────────────────────┐    asyncpg, command_timeout 10s
   │       db.py         │    `execute_safe()` blokuje wszystko != SELECT
   └──────────┬──────────┘    (defense-in-depth)
              │ rows
              ▼
   ┌─────────────────────┐    Template f-string: "Dziś wjechało {n} aut..."
   │ response_builder.py │    Polski plural (1 auto / 2 auta / 5 aut)
   └──────────┬──────────┘    LLM nie ma głosu w tym kroku.
              │
              ▼
        ┌──────────┐
        │  user    │ {"intent":"...","answer":"Dziś wjechało 3 auta...","data":{...}}
        └──────────┘
```

## Intencje (whitelist)

| Intent | Params | Opis |
|--------|--------|------|
| `count_vehicles_today` | `direction?` | Łączna liczba zdarzeń dziś |
| `count_vehicles_by_color_today` | `color` (req), `direction?` | Zdarzenia po kolorze |
| `count_vehicles_by_tag_today` | `tag` (req), `direction?` | Zdarzenia po tagu |
| `courier_today` | `direction?` | Lista wizyt kurierów dziś (tag=kurier OR dostawa) |
| `vehicle_history_by_plate` | `plate` (req) | Pełna historia konkretnej tablicy (LIMIT 50) |
| `last_seen_plate` | `plate` (req) | Ostatnie wystąpienie tablicy |
| `unknown` | — | Wszystko poza tym → fixed message |

### Vocabulary

- **color**: `white` `black` `red` `blue` `green` `yellow` `silver` `gray` `brown` `orange`
- **tag**: `dostawa` `kurier` `mieszkaniec` `gosc` `serwis`
- **direction**: `in` `out`
- **plate**: `^[A-Z0-9]{4,10}$` (PL format ABC1234)

PL→EN aliasy obsługiwane (biały→white, czarny→black, etc).

## Setup

### 1. PostgreSQL

```bash
createdb gatelynk_ai
psql gatelynk_ai < schema.sql
```

### 2. Ollama + model

```bash
# Instalacja: https://ollama.com (macOS .app albo brew install ollama)
ollama serve &           # uruchom daemona

# Pobierz model (zalecane qwen2.5:14b — multilingual, ~9 GB)
ollama pull qwen2.5:14b
```

### 3. Python deps

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Konfiguracja

```bash
cp .env.example .env
# Edytuj DATABASE_URL i OLLAMA_MODEL wedle potrzeb.

# Załaduj env (Bash/Zsh):
set -a; source .env; set +a
```

### 5. Start

```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

Health check:
```bash
curl http://localhost:8000/health
# → {"status":"ok","model":"qwen2.5:14b"}
```

## Przykładowe zapytania

```bash
# 1. Ile białych aut dziś wjechało?
curl -sS http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"Ile białych aut dziś wjechało?"}' | jq

# → {
#     "intent": "count_vehicles_by_color_today",
#     "parameters": {"color":"white","direction":"in"},
#     "answer": "Dziś wjechało 3 auta w kolorze white.",
#     "data": {"count": 3}
#   }


# 2. Czy był dziś kurier?
curl -sS http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"Czy był dziś kurier?"}' | jq

# → {
#     "intent": "courier_today",
#     "parameters": {},
#     "answer": "Dziś było 4 wizyty kurierów:\n  • 2026-05-19 12:30 — WE12345 [kurier, dostawa, white]\n  ...",
#     "data": {"count": 4, "visits": [...]}
#   }


# 3. Kiedy ostatnio była tablica WE12345?
curl -sS http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"Kiedy ostatnio była tablica WE12345?"}' | jq

# → {
#     "intent": "last_seen_plate",
#     "parameters": {"plate":"WE12345"},
#     "answer": "Tablica WE12345 ostatnio wyjechał 2026-05-19 13:00, kolor white, tagi: kurier, dostawa.",
#     "data": {...}
#   }


# 4. Ile aut z tagiem dostawa wjechało dzisiaj?
curl -sS http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"Ile aut z tagiem dostawa wjechało dzisiaj?"}' | jq

# → {
#     "intent": "count_vehicles_by_tag_today",
#     "parameters": {"tag":"dostawa","direction":"in"},
#     "answer": "Dziś wjechały 2 auta z tagiem dostawa.",
#     "data": {"count": 2}
#   }


# 5. Off-topic — unknown
curl -sS http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"Jaka jest stolica Francji?"}' | jq

# → {
#     "intent": "unknown",
#     "parameters": {},
#     "answer": "Nie potrafię jeszcze odpowiedzieć na to pytanie.",
#     "data": null
#   }
```

## Performance

| Path | Czas | % zapytań |
|------|------|-----------|
| Regex match | ~1 ms | ~70-80% codziennych pytań |
| LLM fallback (qwen2.5:14b cold) | ~3-5 s (model load) | rzadkie |
| LLM fallback (qwen2.5:14b warm) | ~200-500 ms | reszta |
| SQL execute (indexed) | ~5-30 ms | każde |

## Gwarancje bezpieczeństwa

1. **LLM nie wykonuje SQL.** Nawet jeśli model halucynuje SQL injection — backend ignoruje to. SQL pochodzi wyłącznie z `TEMPLATES` dict.
2. **Tylko SELECT.** `db.execute_safe()` `raise ValueError` jeśli SQL nie zaczyna się od SELECT. Druga linia obrony.
3. **Parameterized values.** Wszystkie wartości przez `$1`, `$2` placeholders — Postgres parsuje SQL i wartości osobno. Nie ma sposobu by wartość parametru "uciekła" do SQL.
4. **Whitelisty enum-ów.** color/tag/direction muszą być w canonical set, plate musi pasować do regex `^[A-Z0-9]{4,10}$`. Każdy mismatch → intent='unknown'.
5. **LIMIT na listach.** courier_today: 20, vehicle_history_by_plate: 50, last_seen_plate: 1.
6. **Command timeout.** asyncpg `command_timeout=10s` — żadne zapytanie nie zwiesi backendu.
7. **Pytanie max 500 chars.** Pydantic field constraint przed wysyłką do LLM.
8. **Read-only DB user (zalecane w prod):** `GRANT SELECT ON vehicle_events TO ai_user`.

## Plik na plik

| Plik | Co robi |
|------|---------|
| `app.py` | FastAPI endpoint `POST /ask`, orchestrates flow |
| `intent_classifier.py` | Regex + LLM JSON classification + validation |
| `sql_templates.py` | Whitelist gotowych parameterized SELECT-ów |
| `db.py` | asyncpg pool + `execute_safe()` (tylko SELECT) |
| `response_builder.py` | Template-based answer formatting (PL plural, no LLM) |
| `config.py` | Env var → dataclass |
| `schema.sql` | DB schema + seed data dla smoke testu |
| `requirements.txt` | Python deps (FastAPI, asyncpg, httpx, pydantic) |
| `.env.example` | Template env vars |

## Co nie zrobione (świadomie out-of-scope dla MVP)

- Fine-tuning modelu (nie potrzeba — JSON mode + temp=0 + walidacja wystarczają)
- Vector database / RAG (osobny system dla long-form Q&A)
- OCR dla skanowanych dokumentów (out of scope)
- Embeddings dla semantic search po tags/colors (nie potrzeba, exact match wystarczy)
- Authentication (dodaj JWT middleware w produkcji)
- Rate limiting (np. via slowapi gdy >1 req/s)
- Audit log z każdego pytania (osobny logger lub OpenTelemetry)

## Rozszerzanie systemu

Dodanie nowej intencji to **3 pliki**:

1. **`sql_templates.py`** — dodaj klucz w `TEMPLATES` dict
2. **`intent_classifier.py`** — dodaj do `VALID_INTENTS`, regex w `classify_regex` (opcjonalne), dodaj do LLM_SYSTEM_PROMPT, dodaj walidację w `validate()`
3. **`response_builder.py`** — dodaj branch w `build()` z f-string template

Nie trzeba touchować `app.py`, `db.py` ani `config.py` — flow jest data-driven.
