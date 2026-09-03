"""
sqlite access — async via aiosqlite, READ-ONLY mode.

INVARIANTY bezpieczeństwa:
  1. Otwieramy z `mode=ro` (sqlite URI) — Edge produkcja chroniona przed
     accidentalnym zapisem. Trzeci poziom obrony.
  2. `execute_safe()` blokuje SQL który nie zaczyna się od SELECT.
     Druga linia obrony.
  3. SQL pochodzi tylko z `sql_templates.py` whitelisty. Pierwsza linia.

Połączenia: sqlite jest tani, nie pool-ujemy. Connection per request.
Edge live database — nie zaszkodzimy concurrency (sqlite WAL handle czytaczy).
"""
from __future__ import annotations

import logging
import urllib.parse
from typing import Any, Sequence

import aiosqlite

from config import CONFIG

log = logging.getLogger(__name__)


def _ro_uri() -> str:
    """sqlite URI dla read-only mode. Plik musi istnieć."""
    path = urllib.parse.quote(CONFIG.sqlite_path)
    return f"file:{path}?mode=ro"


async def execute_safe(sql: str, params: Sequence[Any]) -> list[dict]:
    """
    Wykonuje SELECT na Edge sqlite z parameterized values (?).

    Raises:
      ValueError — gdy SQL nie zaczyna się od SELECT.
      aiosqlite.* — błędy bazy.

    Returns:
      Lista dict (kolumna → wartość).
    """
    stripped = sql.lstrip()
    if not stripped.upper().startswith("SELECT"):
        raise ValueError(
            "Only SELECT allowed. Templates in sql_templates.py muszą "
            "zaczynać się od SELECT."
        )

    async with aiosqlite.connect(_ro_uri(), uri=True, timeout=10.0) as db:
        db.row_factory = aiosqlite.Row
        # 2026-08-15 — Event Intelligence §15: canon_ocr() jako funkcja SQL.
        # Zagnieżdżony łańcuch replace() w SQL przekraczał stos parsera
        # sqlite ("parser stack overflow") — rejestrujemy lustro
        # intent_classifier.canonical_ocr bezpośrednio na połączeniu.
        from intent_classifier import canonical_ocr

        await db.create_function(
            "canon_ocr", 1, lambda s: canonical_ocr(s) if s else "",
        )
        # Enable JSON1 extension (już included w stock sqlite, ale wymuszamy
        # by `json_each` działało w queries dla vehicle_tags).
        async with db.execute(sql, list(params)) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]
