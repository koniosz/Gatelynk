# Gatelynk — Prompty dla Claude Code
Zmiany do wdrożenia w aplikacji (kierunek **Glass Depth Premium**). Wklejaj sekcje pojedynczo do Claude Code. Referencja wizualna: `Glass Depth Premium.html` (otwórz w przeglądarce i przeklikaj — to źródło prawdy dla wyglądu, animacji i timingów).

---

## Wspólny kontekst (wklej raz na początku sesji)

> Pracujemy nad aplikacją mieszkańca osiedla „Gatelynk" w kierunku **Glass Depth Premium** (iOS 26 liquid-glass × spatial depth, akcent fioletowy). Stack: [WSTAW swój — np. React Native + Reanimated / SwiftUI]. Efekt „glass" mapuj na natywny blur (expo-blur `BlurView` / `UIVisualEffectView` / Flutter `BackdropFilter`), nie na półprzezroczyste tło bez rozmycia. Wszystkie teksty po polsku (i18n-ready). Trzymaj się tokenów:
>
> - **Glass:** `background: rgba(255,255,255,.06–.15)`, `backdrop-blur: 40px saturate(180%)`, border `rgba(255,255,255,.14–.26)`, `box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 24px 50px rgba(0,0,0,.38)`, radius 32 (karty) / 20 (kafelki).
> - **Akcent fiolet:** `#8B6BF0` / gradient `#C5B0FF→#5B7CFA`. **Sukces:** `#34D399`. **Danger/live:** `#FF3B30`.
> - **Font:** Geist (fallback systemowy), nagłówki ujemny letter-spacing (−.02/−.03em).
> - **Krzywe:** wejście `cubic-bezier(.22,.9,.3,1)`, spring `cubic-bezier(.34,1.56,.64,1)`, sheety `cubic-bezier(.32,.72,0,1)`.
> - `prefers-reduced-motion` → wyłącz dekoracyjne animacje (aurora, shimmer, cząsteczki), pokaż stan końcowy.

---

## PROMPT 1 — Kafelek „Dostęp" jako przesuwany deck sekcji (KLUCZOWE)

> Przebuduj kafelek „Dostęp" na ekranie głównym z listy małych przycisków na **pełnoszerokościowy, stronicowany carousel** w stylu aplikacji Mercedes me — **przesuwa się cała sekcja**, jeden swipe = jedna sekcja dostępu.
>
> **Sekcje (w tej kolejności):** Wjazd, Wyjazd, Brama pożarowa, Furtka.
>
> **Każda sekcja (slajd) zawiera, wyśrodkowane w kolumnie:**
> 1. Duży okrągły **dial** (~98–116 px): zewnętrzny **pierścień postępu** (SVG circle, `stroke-dasharray`/`dashoffset`, obwód dla r=54 ≈ 340) + wewnętrzna szklana tarcza z kwadratową ikoną (16 px radius) w kolorze akcentu sekcji.
> 2. **Nazwa** sekcji (23–25 px, weight 650, −.02em).
> 3. **Status** z kropką w kolorze akcentu: „Zamknięta" / „Gotowa" (Brama pożarowa) / itp.
> 4. **Podpowiedź** (11.5 px, opacity .5): „Dotknij, aby otworzyć" (dla pożarowej: „Awaryjne — dotknij, aby otworzyć").
>
> **Akcent per sekcja** (przełącza się przy przewijaniu): Wjazd `#6E8BFF`, Wyjazd `#34D399`, Brama pożarowa `#FF5A5F`, Furtka `#C58BFF`. Całe tło karty ma subtelną **poświatę radialną** w kolorze aktywnej sekcji (opacity ~.16), płynne przejście .5 s. Pierścień, ikona, kropka statusu i kropki paginacji też biorą aktywny akcent (CSS var `--acc`).
>
> **Paginacja:** rząd kropek pod deckiem; aktywna kropka wydłuża się w pasek (width 6→22) w kolorze akcentu (jak w Mercedes me).
>
> **Interakcja otwierania (tap):** dotknięcie diala → pierścień wypełnia się ~0.9 s (`transition: stroke-dashoffset .9s cubic-bezier(.4,0,.2,1)`) → ikona zmienia się w ✓, tarcza zielona, status → „Otwarte" (Winda: „Jedzie ✓"), **toast** (np. „Wjazd otwarty"), auto-reset po 3 s. Zablokuj podwójne wywołanie w trakcie. **Produkcyjnie:** po wypełnieniu wywołaj API otwarcia (Tedee/Nuki/przekaźnik); błąd/timeout → czerwony stan „Nie udało się otworzyć", bez auto-sukcesu.
>
> **Swipe:** dotyk = natywny scroll ze `scroll-snap-type:x mandatory` (`scroll-snap-align:center` na slajdach). Mysz/desktop = drag-to-scroll ze snapem do najbliższej sekcji po puszczeniu. Rozróżnij tap vs drag progiem ~5 px (drag nie otwiera sekcji). Aktualizuj aktywny indeks (kropki + `--acc`) na zdarzeniu scroll (throttle `requestAnimationFrame`).
>
> **Nagłówek karty:** po lewej kicker „DOSTĘP" (tap → pełne menu „Co chcesz otworzyć?": Wjazd, Wyjazd, Brama pożarowa z ekranem potwierdzenia, Mój dom / Tedee). Po prawej dwie ikony (patrz PROMPT 2).
>
> **Wysokość:** kompaktowa — dial ~98 px, ciasne odstępy (nazwa `margin-top:10`, status 5, hint 6, kropki 8). Karta lekko przezroczysta: `background: rgba(255,255,255,.055)`, border `rgba(255,255,255,.14)`, żeby tło aurory subtelnie prześwitywało.

---

## PROMPT 2 — Podgląd z kamery + Domofon (KLUCZOWE)

> W nagłówku kafelka „Dostęp" (prawy górny róg) dodaj **dwie dyskretne okrągłe ikony glass** (34 px, `rgba(255,255,255,.08)` + blur): **kamera** i **słuchawka (domofon)**.
>
> **Ikona kamery → bottom sheet „Podgląd — kamera brama główna":**
> - Duży kadr wideo (radius 18, wys. ~190) — **pełny obraz z kamery** (`object-fit: cover`). W prototypie to statyczne zdjęcie; **produkcyjnie podstaw `<video>` / stream (WebRTC/RTSP/HLS)**.
> - Nakładka gradientu góra/dół dla czytelności.
> - Badge **„● NA ŻYWO"** (czerwony `#FF3B30`, migająca kropka 1.2 s) w lewym górnym rogu; znacznik czasu w prawym dolnym (`tabular-nums`).
> - Przycisk **„Połącz z domofonem"** → przechodzi do sheetu domofonu.
>
> **Ikona słuchawki → bottom sheet „Domofon — brama główna":**
> - Ten sam kadr live (badge NA ŻYWO) + etykieta „Gość przy bramie" na obrazie.
> - Rząd 3 kontrolek (glass, kolumna ikona+podpis): **Mów** (mikrofon, toggle — po włączeniu zielony), **Otwórz** (kłódka, fioletowy gradient → toast „Brama otwarta" + zamknij sheet), **Rozłącz** (słuchawka obrócona 135°, czerwony → zamknij sheet).
> - **Produkcyjnie:** Mów = push-to-talk (WebRTC audio), Otwórz = API bramy, Rozłącz = zakończ sesję wideo i wróć.
>
> **Wspólny wzorzec sheeta:** scrim `rgba(5,8,16,.45)+blur(10px)`; panel `rgba(16,20,34,.85)+blur(40px) saturate(180%)`, górny radius 34, uchwyt (grip) 40×5; wejście `translateY(105%)→0` 380 ms `cubic-bezier(.32,.72,0,1)`; zamknięcie swipe-down / tap scrim / ✕.
>
> **Kluczowe:** podgląd kamery i domofon współdzielą ten sam komponent kadru live — z podglądu można jednym tapnięciem przejść do rozmowy. Gdy ktoś **dzwoni** domofonem, ten sam ekran otwiera się jako połączenie przychodzące (pełny ekran, Odbierz/Odrzuć) — patrz osobny plik `Domofon Wideo.html` jeśli go masz.

---

## PROMPT 3 — Przesuwający się motyw Glass po kafelkach (shimmer)

> Dodaj **przesuwający się refleks światła („glass shimmer")** przechodzący po szklanych kafelkach — subtelny, premium, jak odbicie na szkle.
>
> - Na każdej szklanej powierzchni (kafelki quick-action, karta Dostęp, karta Asystent) skośny **pas światła** (gradient `transparent → rgba(255,255,255,.14) → transparent`, kąt ~120°) przesuwa się w poprzek raz na ~**18 s**.
> - **Rozfazuj** starty między kafelkami (np. delay 0 s / 5 s / 10 s), żeby refleks „wędrował" po siatce, a nie błyskał wszędzie naraz.
> - Implementacja: nakładany element/pseudo z gradientem, animowany `translateX` (od −150% do 150%) albo `background-position`; `mix-blend-mode: screen` lub `overlay`, `pointer-events:none`, przycięty do promienia kafelka (`overflow:hidden`).
> - Ruch powolny i ledwo widoczny (to akcent, nie rozprasza). Wyłącz przy `prefers-reduced-motion`.
> - Natywnie: RN Reanimated `withRepeat(withTiming(..., 18000))` na `translateX` maski gradientowej (expo-linear-gradient) / SwiftUI `.mask` z animowanym `LinearGradient` w `.repeatForever(autoreverses:false)`.
>
> **Efekt docelowy:** siatka kafelków wygląda jak realne szkło, po którym co chwilę delikatnie „przejeżdża" światło — spójne z żywym, animowanym tłem aurory.

---

## Kolejność wdrożenia
1. PROMPT 1 (deck „Dostęp") — rdzeń zmiany.
2. PROMPT 2 (kamera + domofon) — ikony w nagłówku decka + sheety.
3. PROMPT 3 (glass shimmer) — warstwa wykończeniowa na wszystkich kafelkach.

Po każdym kroku porównaj z `Glass Depth Premium.html` (te same odstępy, kolory, timingi).
