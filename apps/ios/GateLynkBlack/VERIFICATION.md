# GateLynk_black — weryfikacja kontynuacji (2026-09-30)

Gałąź `codex/gatelynk-black-vnext` (baza `5a50a87`), kontynuacja commitu `3666b60`.
Xcode 26.5, symulatory iOS 26.5: „GateLynk Black QA 390" (390×844) i „GateLynk Black QA 375" (375×812).
Bez merge, bez publikacji, bez zmian serwera i konfiguracji bram.

## Ocena stanu zastanego

Implementacja z `3666b60` odpowiada wzorcowi (390 i 375): paleta, Barlow Semi Condensed,
Lucide, karuzela wejść z API, kamera/status/CTA na jednej karcie, sześć skrótów, informacja
kontekstowa z realnych danych, AI, nawigacja Dom/Dostęp/Sprawy/Osiedle. Rozdzielenie stanów
(„Polecenie przyjęte" / „Wynik nieznany" / błąd) i niezależny stan per `gateId` — zgodne
z kontraktem API (przyjęcie polecenia, bez telemetrii). Świadome różnice z 03-IMPLEMENTACJA
zachowane (bez podglądu sąsiedniej karty, bez sztucznego zegara/baterii/ramki).

Udokumentowany brak wobec referencji `compact-offline.png`: natywnie był tylko znacznik
„Ostatni obraz", bez nakładki „Obraz nieaktualny" i bez akcji odświeżenia.

## Zmiany w tej kontynuacji

| Plik | Zmiana |
|---|---|
| `GateLynkBlack/BlackAccessDeck.swift` | Nakładka „Obraz nieaktualny" + „Odśwież podgląd" (geometria i kolory `.gc-offline` z makiety) dla obrazu nieaktualnego (≥15 s) lub po błędzie pobrania; przycisk odświeżenia także w stanie „Podgląd niedostępny"; ręczne odświeżenie restartuje pętlę pobierania (`refreshTick` w `cameraTaskID`). Nakładka dotyczy wyłącznie podglądu — sterowanie bramą pozostaje dostępne. Selektor wejść przy >3 wejściach dosuwa wybrany segment do widoku (`ScrollViewReader`), także po zmianie karty gestem; Reduce Motion bez animacji. |
| `GateLynkBlack/BlackPreview.swift` | Warianty izolowanego podglądu (Debug) przez `-black-preview-variant`: `many-gates` (5 wejść, długa nazwa), `long-names` (długa nazwa nieruchomości i imię), `empty` (brak wejść i paczki), `camera-offline`. Bez argumentu — dotychczasowy podgląd. |
| `BlackUITests/BlackUITests.swift` | +2 testy: nakładka offline nie blokuje świadomego otwarcia i nie znika po przyjęciu polecenia; pięć wejść — selektor i karta pozostają spójne, sterowanie należy tylko do wybranego wejścia. |

Nie zmieniano plików wspólnych (Glass, AppDelegate, modele) ani zasobów (44 SVG, 3 TTF).

## Wyniki

| Kontrola | Wynik |
|---|---|
| GateLynk_black Debug (iPhone 17 sim) | PASS |
| GateLynk_black Release (generic iOS Simulator) | PASS |
| GateLynkGlass Debug (regresja wspólnych plików) | PASS |
| BlackLogicTests | 13/13 PASS |
| BlackUITests — QA 390 (5 dotychczasowych) | 5/5 PASS (69 s) |
| BlackUITests — QA 375 `testDraggingAwayCancelsAnUnfinishedHold` | PASS |
| BlackUITests — QA 390 (2 nowe) | 2/2 PASS |

Kontrola wizualna (zrzuty `simctl io screenshot`, podgląd izolowany, dane przykładowe) —
oba rozmiary: `default`, `camera-offline`, `many-gates`, `long-names`, `empty` oraz
`default` przy Dynamic Type `AccessibilityL`:
- `camera-offline` odpowiada `compact-offline.png` (przyciemnienie, ikona, tekst, przycisk);
- `many-gates`: 4 z 5 etykiet widoczne, selektor przewijany, wskaźnik 5 kropek;
- `long-names`: nazwa nieruchomości obcięta wielokropkiem, powitanie łamie się na 2 linie, nagłówek rośnie, treść przewija się;
- `empty`: karta „Brak dostępnych wejść" z przejściem do „Wszystkie wejścia", brak stałej informacji o paczce;
- `AccessibilityL`: powitanie i CTA łamią się, siatka skrótów 2 kolumny, nic nie jest przycięte, treść przewija się; dolna nawigacja mieści cztery etykiety.

## Ograniczenia (bez zmian wobec 04-WERYFIKACJA)

- Brak testów fizycznych bram, kamer, domofonu, APNs/VoIP i zalogowanej sesji produkcyjnej.
  Podpisy/App ID dla `com.gatelynk.app.black` nie były konfigurowane.
- Pełny audyt VoiceOver (kolejność fokusu, odczyt wszystkich elementów) nie był wykonany
  narzędziem dostępności; etykiety i nazwana akcja otwierania istnieją i są objęte testami UI.
- Dynamic Type sprawdzono dla rozmiaru domyślnego i `AccessibilityL`; pozostałe rozmiary,
  iPad i orientacja pozioma — poza zakresem.
- W trybie podglądu przycisk „Odśwież podgląd" nie ma źródła obrazu do odświeżenia (dane przykładowe).
