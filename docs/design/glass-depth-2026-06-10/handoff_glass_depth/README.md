# Handoff: Gatelynk — Ekran Główny „Glass Depth Premium"

## Overview
Gatelynk to aplikacja mieszkańca nowoczesnego osiedla/apartamentowca: otwieranie bram i drzwi (access control), winda, goście z dostępem czasowym, pojazdy (ANPR), płatności, zgłoszenia, przesyłki (paczkomat), ogłoszenia oraz asystent AI. Ten pakiet zawiera finalny design ekranu głównego w kierunku **Glass Depth Premium** (iOS 26 liquid glass × spatial depth) wraz z wizualizacjami akcji każdego przycisku (bottom sheets) i adaptacyjnym tłem zależnym od pory dnia.

## About the Design Files
Pliki w tym pakiecie to **referencje designu wykonane w HTML** — działające prototypy pokazujące docelowy wygląd i zachowanie. To NIE jest kod produkcyjny do skopiowania. Zadanie: **odtworzyć te projekty w istniejącym środowisku docelowej aplikacji** (React Native / SwiftUI / Flutter / React web — cokolwiek jest w repo) zgodnie z jego wzorcami, biblioteką komponentów, nawigacją i state managementem. Jeśli środowiska jeszcze nie ma — wybierz najlepszy framework dla aplikacji mobilnej premium i tam zaimplementuj.

## Fidelity
**High-fidelity.** Kolory, typografia, odstępy, promienie, cienie, animacje i interakcje są finalne. Odtwarzaj pixel-perfect, używając natywnych odpowiedników (np. UIVisualEffectView / expo-blur dla glassu).

## Pliki
```
README.md                       ← ten dokument
Glass Depth Premium.html        ← GŁÓWNY prototyp (otwórz w przeglądarce, klikaj wszystko)
assets/building-photo.jpg       ← zdjęcie budynku (hero, tło ekranu)
referencje/
  Guest Invite.html             ← strona zaproszenia gościa (oddzielny deliverable)
  Guest Invite — Spec.md        ← spec techniczny strony zaproszenia (API, JWT, edge cases)
```

## Ekran główny — struktura (od góry)

1. **Dynamic Island (rozszerzony)** — po 1.6 s rozwija się do pigułki „Zbliżasz się · Wjazd 12 m" z zieloną pulsującą kropką; tap = otwarcie wjazdu (toast „Wjazd otwarty"). Szerokość 124→288 px, easing `cubic-bezier(.32,.72,0,1)`, 550 ms.
2. **Powitanie** — kicker „OSIEDLE SŁONECZNE" (11px, letter-spacing .18em, uppercase), „Cześć, **Anna**" (34px, -.03em), meta „21°C · jasno · wracasz do domu" (12px, 62%).
3. **Badge pory dnia** (prawy górny róg) — glass pill pokazujący ☀︎ Dzień / ◖ Wieczór / ☾ Noc; w prototypie klik przełącza tryb (demo), w produkcji sterowane zegarem.
4. **Karta główna „Otwórz"** (glass, radius 32, padding 20/22):
   - sfera 3D w rogu (radial-gradient biały→fiolet→indygo, float 7 s),
   - kicker „DOSTĘP", tytuł „Otwórz" (36px/650), status „● Brama · Drzwi · Mój dom",
   - **slider „Przesuń, aby otworzyć →"** — przeciągnięcie kciuka do końca: fill podąża, sukces = zielony stan + ripple + toast „Brama otwarta", auto-reset po 3.2 s; napis ma animowany połysk (background-clip:text),
   - tap w kartę POZA sliderem → sheet „Co chcesz otworzyć?".
5. **Rząd kafelków 1**: Pojazdy / Goście / Płatność (czerwona pulsująca kropka przy zaległości). Kafelek: glass radius 24, orb 38px z gradientem, hover unosi (`translateY(-4px) scale(1.02)`, spring), active `scale(.96)`.
6. **Rząd kafelków 2**: Zgłoszenia / Przesyłki (badge „1") / Ogłoszenia.
7. **Karta „Asystent osiedla"** (zamiast listy aktywności) — AI-generowany brief:
   - najpierw 3 kropki „typing" (~0.9 s), potem 4 linie pojawiają się kolejno (opacity+translateY, stagger 260 ms),
   - format linii: kolorowa kropka 6px + tekst 12.5px z pogrubieniami (np. „**Dziś:** odbiór śmieci zmieszanych — wystaw kosze przed 7:30."),
   - struktura treści: co dziś / co czeka na użytkownika / co nadchodzi / co się wydarzyło,
   - „↻ Odśwież" regeneruje brief (stopPropagation), tap w kartę → sheet Ogłoszenia,
   - **produkcyjnie:** treść generuje LLM z danych osiedla (ogłoszenia, paczki, audyt bramy); endpoint zwraca max 4 linie, cache 15 min.
8. **Tab bar (floating pill)** — TYLKO 3 elementy (bez duplikacji kafelków): „⌂ Dom" (aktywny, gradient pill), **„✦ Zapytaj AI"** (wyróżniony gradientowy przycisk, otwiera czat), „Więcej". Wycentrowany `left:50%; translateX(-50%)`; UWAGA: animacja wejścia musi zachowywać translateX (dedykowane keyframes, nie wspólna klasa).

## Bottom sheets (akcje przycisków)
Wspólny wzorzec: scrim `rgba(5,8,16,.45)+blur(10px)`, sheet `rgba(16,20,34,.85)+blur(40px) saturate(180%)`, radius górny 34, grip 40×5, wejście `translateY(105%)→0` 380 ms `cubic-bezier(.32,.72,0,1)`, max-height 80%, nagłówek: kicker uppercase + tytuł 19px + przycisk ✕.

| Trigger | Sheet | Zachowanie |
|---|---|---|
| Karta Otwórz (tap) | „Co chcesz otworzyć?" | 4 wiersze: Brama wjazdowa, wyjazdowa (CTA „Otwórz" → spinner „Otwieram" 1.3 s → „Otwarte ✓" 3 s), Brama pożarowa (czerwona, → ekran potwierdzenia), Mój dom (→ panel zamka) |
| Brama pożarowa | „Czy na pewno?" | ostrzeżenie o rejestrowaniu zdarzenia, „Tak, otwórz bramę" (czerwony) → spinner → sukces → powiadomienie ochrony; „Anuluj" wraca |
| Mój dom | Panel Tedee | kółko statusu 108px (🔒 fiolet / 🔓 zielony), „Otwórz przez Face ID" → 1.3 s → toggle stanu; bateria/online; auto-zamykanie 1 min |
| Kafelek Pojazdy | Lista aut | VW Passat (główny) + Toyota Yaris, polskie tablice (czarne tło, żółta ramka, mono), nota ANPR, „+ Dodaj pojazd" |
| Kafelek Goście | Zaproszenia | aktywne (● zielone) + nadchodzące (○ fiolet), auto+tablica+okno czasowe, „+ Zaproś gościa" |
| Kafelek Płatność | Czynsz | zaległość 834,00 zł + odsetki, „Zapłać BLIK" → „Czekam na kod BLIK…" 1.8 s → „Zapłacono ✓" + znika kropka alertu na kafelku |
| Kafelek Zgłoszenia | Usterki | 3 statusy (oczekuje/w naprawie/rozwiązane), „+ Nowe zgłoszenie" |
| Kafelek Przesyłki | Paczkomat | duży kod skrytki **4823** (40px, tabular), „Otwórz skrytkę zdalnie" → spinner → „Skrytka otwarta ✓", paczka w drodze |
| Kafelek Ogłoszenia / karta AI | Lista ogłoszeń | woda, śmieci, zebranie, nasadzenia |
| „Zapytaj AI" (tab bar) | Czat | bąbelki user (gradient) / bot (glass), mock odpowiedzi: śmieci, czynsz, goście, woda; produkcyjnie LLM |

## Tło (3 warstwy animacji)
1. **Zdjęcie budynku** (`assets/building-photo.jpg`, center 35%, cover) z Ken Burns: scale 1→1.08 + translateY -12px, 26 s alternate.
2. **Fluid aurora — canvas** (`#fluid`, mix-blend screen, opacity .85): 5 orbów na ścieżkach Lissajous (warstwowe sin/cos — ruch nieperiodyczny), oddychanie ±18%, hue pełza +4°/s, delikatne przyciąganie do kursora (18%, lerp .02), render w 22% rozdzielczości (naturalna miękkość) @30 fps, composite `lighter`; co ~24 s ukośna smuga światła przelatuje przez ekran.
3. **Cząsteczki** — 14 świetlnych drobinek 2–6px unosi się ku górze (14–30 s, losowe sway ±40px).

### Pora dnia (adaptacyjne)
Klasa na scenie: `tod-day` (7–17 h) / `tod-evening` (17–21) / `tod-night` (reszta). Przejścia 1.2 s.
- **Dzień**: nakładka ciepła `rgba(255,214,140,.16)→transparent`, słońce (radial, blur 4, „oddycha" 9 s) u góry po lewej.
- **Wieczór**: nakładka pomarańcz/róż → granat, słońce niżej i pomarańczowe, zdjęcie `brightness(.8) saturate(1.1)`.
- **Noc**: ciemnoniebieska nakładka, zdjęcie `brightness(.55) saturate(.8)`, **7 ciepłych świateł okien** (radial ellipse, blur 3, flicker 6 s z różnymi delay) w górnej strefie zdjęcia.
- `prefers-reduced-motion: reduce` → canvas i cząsteczki ukryte, Ken Burns wyłączony, tabbar bez animacji.

## Design tokens
### Kolory
- Tła: scena `#0a0d16`; sheet `rgba(16,20,34,.85)`; glass card `rgba(255,255,255,.15)` + border `rgba(255,255,255,.26)`
- Akcent fioletowy gradient: `#C5B0FF → #5B7CFA` (CTA, pille, user-bubble); głębszy `#7050E0`
- Orby kafelków: Pojazdy `#5B7CFA→#C067F0` · Goście `#34D399→#5B7CFA` · Płatność/danger `#FF7A89→#C03A4A` · Zgłoszenia `#FBBF24→#D97706` · Przesyłki `#5B9CFA→#3070D0` · Ogłoszenia `#C5B0FF→#8B6BF0`
- Semantyczne: success `#34D399`/`#7BE2A3`, danger `#FF453A`, tablica rej. `#FBC02D` na `#10141f`
### Typografia
- **Geist** (Google Fonts), fallback systemowy; letter-spacing ujemny na nagłówkach (-.02/-.03em)
- Skala: 36 (tytuł karty) / 34 (powitanie) / 19 (sheet) / 14.5 / 12.5 / 11 (kickery uppercase .12–.18em)
### Glass (przepis)
`background:rgba(255,255,255,.15); backdrop-filter:blur(40px) saturate(180%); border:1px solid rgba(255,255,255,.26); box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 24px 50px rgba(0,0,0,.38)`
Shimmer: skośny pas światła przelatuje raz na ~18 s (delay 0/5/10 s per karta).
### Promienie
karta główna 32 · kafelki 24 · sheet 34 · slider/pille 999 · telefon 54/42
### Animacje (timingi)
- wejście kart: 800 ms `cubic-bezier(.22,.9,.3,1)`, stagger 150 ms, from `translateY(26px)+blur(6px)`
- sheety: 380 ms `cubic-bezier(.32,.72,0,1)`
- spring hover: `cubic-bezier(.34,1.56,.64,1)`
- spinner 700 ms; toast 250 ms in / 2.4 s hold

## Stany i logika
- `tod`: day|evening|night (zegar + manualny przełącznik demo)
- slider: idle → dragging → success(3.2 s) → idle
- CTA otwarcia: idle → busy(1.3 s) → ok(3 s) → idle
- zamek: locked|unlocked + busy
- płatność: due → busy(1.8 s) → paid (usuwa alert dot)
- brief: typing(0.9 s) → 4 linie staggered; refresh restartuje
Produkcyjnie dochodzi: auth, API bram/zamka (Tedee/Nuki), BLIK, push, LLM dla briefu i czatu — patrz `referencje/Guest Invite — Spec.md` dla wzorca API zaproszeń.

## Assets
- `assets/building-photo.jpg` — zdjęcie hero (w prototypie wpięte przez CSS `url('assets/building-photo.jpg')`; w produkcji CDN + warianty rozdzielczości)
- Ikony: inline SVG 24×24, stroke 1.8–2.2 zaokrąglone; auto = wypełniona sylwetka frontowa (w pliku). Mapuj na SF Symbols / Lucide zachowując charakter.

## Prompt startowy dla Claude Code
> Przeczytaj README.md tego pakietu, potem otwórz `Glass Depth Premium.html` w przeglądarce i przeklikaj wszystkie akcje (slider, kafelki, sheety, badge pory dnia, Zapytaj AI). Zaimplementuj ten ekran w naszej aplikacji zgodnie z naszym stackiem i wzorcami. Priorytety: (1) layout + glass tokens, (2) slider otwarcia + sheet „Co chcesz otworzyć?", (3) kafelki + sheety, (4) adaptacyjne tło z porą dnia (canvas aurora może być uproszczona do gradientów na start), (5) brief AI (na razie mock, struktura pod LLM). Trzymaj się timingów animacji z README.
