# Gatelynk — Build Guidelines dla Claude Code
## Kierunek: „Glass Depth Premium" (flagowy design aplikacji)

---

## 0. Czym jest ten dokument
To **kompletna specyfikacja budowy** aplikacji mobilnej Gatelynk w kierunku Glass Depth Premium — z pełnym opisem layoutu, wszystkich animacji, interakcji, tokenów i stanów. Pliki HTML w pakiecie to **wysokiej wierności referencje designu** (działające prototypy), NIE kod produkcyjny do skopiowania 1:1. Twoje zadanie: **odtworzyć ten design w docelowym stacku aplikacji** (patrz §1), zachowując pixel-perfect wygląd, wszystkie animacje i timingi.

> Otwórz `Glass Depth Premium.html` w przeglądarce i przeklikaj WSZYSTKO (slider otwierania, kafelki, sheety, badge pory dnia, „Zapytaj AI", odświeżenie briefu AI) — to jest źródło prawdy dla zachowania.

---

## 1. Stack i architektura
- **Preferowany:** React Native (Expo) + Reanimated 3 + Moti/Skia dla zaawansowanych animacji, LUB SwiftUI (iOS-first). Jeśli repo już definiuje stack — trzymaj się go.
- **Blur / glass:** natywny efekt — `expo-blur` (`BlurView intensity`) / `UIVisualEffectView` / Flutter `BackdropFilter`. NIE emuluj półprzezroczystym tłem bez blur.
- **Animacje:** biblioteka natywna sterowana na UI thread (Reanimated worklets / SwiftUI `withAnimation` / Flutter `AnimationController`). Canvas-owe tło aurora → Skia lub natywny shader; dopuszczalne uproszczenie do 3 animowanych gradientów na start.
- **Struktura ekranów:** Home (ten design) + sheety modalne (bottom sheets) + osobne ekrany: Domofon wideo, Guest Invite (web), czat AI, szczegóły sekcji.
- **State:** lokalny stan UI + warstwa serwisowa (API bram/zamka, płatności, przesyłki, LLM). Wszystkie teksty PO POLSKU (i18n-ready, klucze EN w kodzie).

---

## 2. Anatomia ekranu głównego (od góry)
1. **Dynamic Island (rozszerzalny)** — start 124px, po 1.6 s rozwija się do 288px pokazując „● Zbliżasz się · Wjazd 12 m" + CTA; tap = otwarcie wjazdu + toast. Zielona kropka `islandPulse`.
2. **Status bar** — jasny (białe ikony, text-shadow) — leży na zdjęciu.
3. **Powitanie** (`.greet`): kicker „OSIEDLE SŁONECZNE" (11px, .18em, uppercase, 62% biały), „Cześć, **Anna**" (34px/600, -.03em), meta „21°C · pogodnie · wracasz do domu".
4. **Badge pory dnia** (prawy górny róg): ☀︎ Dzień / ◖ Wieczór / ☾ Noc. W prototypie tap przełącza (demo); produkcyjnie sterowane zegarem urządzenia.
5. **Karta główna „Otwórz"** (glass, radius 32):
   - **Grafika drzwi 3D** (`assets/door-open.png`) w prawym górnym rogu — statyczna (świadomie NIE animowana), symbol otwierania,
   - kicker „DOSTĘP", tytuł „Otwórz" (36px/650), status „● Brama · Drzwi · Mój dom",
   - **Slider „Przesuń, aby otworzyć →"** (patrz §4.1),
   - tap w kartę POZA sliderem → sheet „Co chcesz otworzyć?".
6. **Kafelki rząd 1**: Pojazdy · Goście · Płatność (czerwona pulsująca kropka = zaległość).
7. **Kafelki rząd 2**: Zgłoszenia · Przesyłki (badge „1") · Ogłoszenia.
8. **Karta „Asystent osiedla"** (AI brief, patrz §4.4) — zastępuje listę „ostatnia aktywność".
9. **Tab bar (floating pill)** — 3 elementy: „⌂ Dom" (aktywny) · **„✦ Zapytaj AI"** (gradient, otwiera czat) · „Więcej".

---

## 3. Tło — 3 warstwy + pora dnia (KLUCZOWE dla „premium")
### Warstwa 1 — zdjęcie (`.bg-photo`, `assets/building-3.jpg`)
Ken Burns: `scale 1→1.08 + translateY 0→-12px`, **26 s** ease-in-out alternate infinite.
### Warstwa 2 — fluid aurora (canvas `#fluid`, mix-blend screen, opacity .85)
5 orbów na ścieżkach Lissajous (warstwowe sin/cos → ruch nieokresowy), oddychanie ±18%, hue pełznie +4°/s, delikatne przyciąganie do dotyku (lerp .02), render w **22% rozdzielczości** @30 fps, composite `lighter`. Co ~24 s ukośna smuga światła przelatuje przez ekran. **Produkcyjnie:** Skia shader lub 3–4 animowane RadialGradient (uproszczenie akceptowalne).
### Warstwa 3 — cząsteczki (`.particles`, `floatUp`)
14 świetlnych drobinek 2–6px unosi się ku górze, 14–30 s, losowy sway ±40px, opacity 0→.7→0.
### Pora dnia (klasa na scenie, przejścia 1.2 s)
- **tod-day** (7–17): ciepła nakładka `rgba(255,214,140,.16)`, słońce u góry-lewo, `sunBreathe` 9 s.
- **tod-evening** (17–21): nakładka pomarańcz/róż→granat, słońce niżej i pomarańczowe, zdjęcie `brightness(.8) saturate(1.1)`.
- **tod-night** (reszta): ciemnoniebieska nakładka, zdjęcie `brightness(.55) saturate(.8)`, **7 ciepłych świateł okien** (`.night-lights`, `flicker` 6 s różne delays).
- `prefers-reduced-motion` → canvas + cząsteczki OFF, Ken Burns OFF, tabbar bez wejścia.

---

## 4. Animacje i interakcje — pełna lista

### 4.1 Slider „Przesuń, aby otworzyć" (główna akcja)
- Kciuk 50px przeciągany w poziomie; fill podąża za pozycją.
- Etykieta ma animowany połysk `hintShine` (background-clip:text, 160%→-60%).
- Ukończenie (≥ próg): stan sukcesu **zielony**, **ripple** (`rippleAnim`, kółko 0→400px, 1 s), toast „Brama otwarta", auto-reset po **3.2 s**.
- Niepełne przeciągnięcie → kciuk wraca `transform .3s`.
- **Produkcyjnie:** po sukcesie wywołaj API bramy; błąd/timeout → czerwony stan „Nie udało się otworzyć", bez auto-otwarcia.
- Gest: Reanimated `useAnimatedGestureHandler` / SwiftUI `DragGesture`. Ripple na UI thread.

### 4.2 Kafelki (tiles)
- Wejście: `rise` — from `translateY(26px)+blur(6px)+opacity 0`, **800 ms** `cubic-bezier(.22,.9,.3,1)`, **stagger 150 ms** (d1…d6).
- Hover/press: unosi `translateY(-4px) scale(1.02)` spring `cubic-bezier(.34,1.56,.64,1)`; active `scale(.96)`.
- Płatność: czerwona pulsująca kropka; znika po opłaceniu.
- Przesyłki: badge licznika „1".

### 4.3 Glass shimmer
Skośny pas światła przelatuje przez każdą kartę raz na ~18 s (`shimmer`, delays 0/5/10 s per karta — klasy sh1/sh2/sh3).

### 4.4 Karta „Asystent osiedla" (AI brief)
- Najpierw 3 kropki „typing" (`bp`, ~0.9 s), potem **4 linie** pojawiają się kolejno (opacity+translateY, stagger 260 ms).
- Linia = kolorowa kropka 6px + tekst 12.5px z pogrubieniami: „**Dziś:** odbiór śmieci zmieszanych — wystaw kosze przed 7:30." itd.
- Treść: co dziś / co czeka na użytkownika / co nadchodzi / co się wydarzyło.
- Ikona ✦ pulsuje (`sparkPulse` 2.4 s). „↻ Odśwież" regeneruje (stopPropagation). Tap w kartę → sheet Ogłoszenia.
- **Produkcyjnie:** treść generuje LLM z danych osiedla (ogłoszenia, paczki, audyt bramy, płatności). Endpoint zwraca ≤4 linie strukturalne `{dot_color, text_md}`; cache 15 min; skeleton = animacja typing.

### 4.5 Dynamic Island
Rozwinięcie 124→288px, **550 ms** `cubic-bezier(.32,.72,0,1)`; CTA fade-in z opóźnieniem .3 s; zielona kropka `islandPulse`.

### 4.6 Tab bar
Wejście `tabbarIn` (**800 ms**, delay .9 s, translateY 26→0, ZACHOWAJ translateX -50% w keyframes!). Aktywna pigułka `pillIn` spring `cubic-bezier(.34,1.56,.64,1)`. „Zapytaj AI" = gradient `#C5B0FF→#5B7CFA`.

### 4.7 Bottom sheets — wspólny wzorzec
- Scrim `rgba(5,8,16,.45)+blur(10px)`; sheet `rgba(16,20,34,.85)+blur(40px) saturate(180%)`; radius górny 34; grip 40×5.
- Wejście: `translateY(105%)→0`, **380 ms** `cubic-bezier(.32,.72,0,1)`; max-height 80%.
- Zamykanie: swipe-down / tap scrim / ✕.
- Spinner akcji: `spin` 700 ms; sukces „✓" trzyma 3 s.

| Trigger | Sheet | Kluczowe zachowanie |
|---|---|---|
| Karta Otwórz (tap) | „Co chcesz otworzyć?" | Brama wjazdowa / wyjazdowa (CTA „Otwórz"→spinner 1.3 s→„Otwarte ✓" 3 s) / **Brama pożarowa** (czerwona→ekran potwierdzenia) / **Mój dom** (→panel zamka) |
| Brama pożarowa | „Czy na pewno?" | ostrzeżenie o rejestrowaniu zdarzenia; „Tak, otwórz" (czerwony)→spinner→sukces→powiadomienie ochrony |
| Mój dom | Panel zamka (Tedee) | kółko statusu 108px (🔒 fiolet / 🔓 zielony), „Otwórz przez Face ID"→1.3 s→toggle; bateria/online; auto-zamykanie 1 min |
| Pojazdy | Lista aut | polskie tablice (czarne tło/żółta ramka/mono), nota ANPR, „+ Dodaj pojazd" |
| Goście | Zaproszenia | aktywne (● zielone) + nadchodzące (○ fiolet), auto+tablica+okno czasowe, „+ Zaproś gościa" → generuje stronę Guest Invite (patrz referencje) |
| Płatność | Czynsz | zaległość 834,00 zł + odsetki, „Zapłać BLIK"→„Czekam na kod…" 1.8 s→„Zapłacono ✓" + znika kropka alertu |
| Zgłoszenia | Usterki | 3 statusy (oczekuje/w naprawie/rozwiązane), „+ Nowe zgłoszenie" |
| Przesyłki | Paczkomat | kod skrytki **4823** (40px tabular), „Otwórz skrytkę zdalnie"→spinner→„✓" |
| Ogłoszenia / karta AI | Lista ogłoszeń | woda (30.06), śmieci, zebranie, nasadzenia |
| „Zapytaj AI" (tab) | Czat | bąbelki user (gradient) / bot (glass); produkcyjnie LLM z kontekstem osiedla |

---

## 5. Design tokens
### Kolory
- Tło sceny `#0a0d16`; sheet `rgba(16,20,34,.85)`; glass card `rgba(255,255,255,.15)` + border `rgba(255,255,255,.26)`
- Akcent fiolet gradient **`#C5B0FF → #5B7CFA`** (CTA, pille, aktywne, user-bubble); głębszy `#7050E0`
- Orby kafelków: Pojazdy `#5B7CFA→#C067F0` · Goście `#34D399→#5B7CFA` · Płatność/danger `#FF7A89→#C03A4A` · Zgłoszenia `#FBBF24→#D97706` · Przesyłki `#5B9CFA→#3070D0` · Ogłoszenia `#C5B0FF→#8B6BF0`
- Semantyczne: success `#34D399`/`#7BE2A3` · danger `#FF453A` · tablica rej. `#FBC02D` na `#10141f`
### Typografia
**Geist** (Google Fonts / bundled), fallback systemowy; ujemny letter-spacing na nagłówkach (-.02/-.03em). Skala: 36 (tytuł karty) / 34 (powitanie) / 19 (sheet) / 14.5 / 12.5 / 11 (kickery uppercase .12–.18em).
### Glass (przepis)
`background: rgba(255,255,255,.15); backdrop-filter: blur(40px) saturate(180%); border: 1px solid rgba(255,255,255,.26); box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 24px 50px rgba(0,0,0,.38)`
### Promienie
karta główna 32 · kafelki 24 · sheet 34 · slider/pille 999 · telefon 54/42
### Krzywe / timingi (zebrane)
- wejście kart `rise`: 800 ms `cubic-bezier(.22,.9,.3,1)`, stagger 150 ms
- spring (hover/pill): `cubic-bezier(.34,1.56,.64,1)`
- sheety: 380 ms `cubic-bezier(.32,.72,0,1)`
- island: 550 ms `cubic-bezier(.32,.72,0,1)`
- spinner 700 ms · toast 250 ms in / 2.4 s hold · shimmer ~18 s · kenburns 26 s · ripple 1 s

---

## 6. Ikony i grafika
- Ikony: inline SVG 24×24, stroke 1.8–2.2 zaokrąglone → mapuj na **SF Symbols / Lucide** zachowując charakter.
- `assets/door-open.png` — drzwi 3D (symbol otwierania) w karcie głównej. Statyczne.
- `assets/building-3.jpg` — tło (nowoczesna willa o zmierzchu). Produkcyjnie: CDN + warianty rozdzielczości, ewentualnie zdjęcie realnego osiedla.
- Awatar mieszkańca: placeholder — podmień na realne zdjęcie z profilu.

---

## 7. Ekrany powiązane (w `referencje/`)
- **Domofon Wideo.html** — pełnoekranowy ekran połączenia z domofonu: live `<video>`, badge NA ŻYWO, chip rozpoznawania AI, **hold-to-open** (~1.1 s), glass kontrolki (Wycisz/Mów/Rozłącz/Głośnik), aparat (zrzut). Ten sam język glass/fiolet/Geist.
- **Guest Invite.html** + **Guest Invite - Spec.md** — dynamiczna strona zaproszenia gościa (otwierana z linku SMS/mail), z bramami do otwarcia i awaryjnym PIN-em. Spec zawiera model API, JWT, rate-limity, edge case'y.

---

## 8. Kolejność implementacji (priorytety)
1. **Layout + glass tokens** (statyczny ekran, poprawny blur i typografia).
2. **Slider otwierania** + sheet „Co chcesz otworzyć?" + wywołanie API bramy z obsługą błędu.
3. **Kafelki** + wszystkie sheety (Pojazdy/Goście/Płatność/Zgłoszenia/Przesyłki/Ogłoszenia).
4. **Tło adaptacyjne** z porą dnia (start: gradienty; potem canvas/Skia aurora + cząsteczki).
5. **Brief AI** (na start mock o strukturze §4.4, potem podpięcie LLM) + czat „Zapytaj AI".
6. **Dynamic Island**, shimmer, mikro-interakcje, reduced-motion.
7. Ekrany powiązane: Domofon wideo, Guest Invite.

**Trzymaj się timingów i krzywych z §5 — one robią różnicę między „ładne" a „nagradzane premium".**

---

## 9. Prompt startowy dla Claude Code
> Przeczytaj cały README.md, potem otwórz `Glass Depth Premium.html` w przeglądarce i przeklikaj wszystkie interakcje (slider otwierania, każdy kafelek→sheet, brama pożarowa, panel Mój dom, płatność BLIK, przesyłki, badge pory dnia, odświeżenie briefu AI, Zapytaj AI). Zaimplementuj ten ekran główny w naszym stacku (patrz §1) pixel-perfect, z wszystkimi animacjami i timingami z §4–§5. Zacznij od §8 punkt 1. Blur mapuj na natywny efekt, ikony na SF Symbols/Lucide, wszystkie teksty po polsku (i18n-ready). Tło aurora możesz na start uprościć do animowanych gradientów, ale zachowaj pory dnia i reduced-motion. Po Home zrób ekrany z `referencje/`.
