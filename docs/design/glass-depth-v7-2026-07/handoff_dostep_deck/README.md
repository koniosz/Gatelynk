# Gatelynk — Kafelek „Dostęp" jako deck sekcji + ikony 3D — handoff dla Claude Code

## Co wdrażamy
Sekcja **„Dostęp"** na ekranie głównym Gatelynk: **pełnoszerokościowy, stronicowany carousel** w stylu aplikacji Mercedes me — przesuwa się **cała sekcja**, jeden swipe = jedno wejście. Każde wejście ma duży **dial z pierścieniem postępu**, realistyczną **ikonę 3D** „unoszącą się" w szklanej tarczy, nazwę, status i akcent koloru zmieniający się per sekcja. Kierunek wizualny: **GateLynk Glass** (ciemny, liquid-glass, akcent fiolet).

## Pliki w pakiecie
```
README.md                      ← ten dokument
Glass Depth Premium.html       ← REFERENCJA (otwórz w przeglądarce; przeklikaj deck, kamerę, domofon)
assets/
  ic-szlaban.png               ← ikony 3D wejść (PNG z przezroczystym tłem, ~500–800 px, kwadratowe)
  ic-brama.png
  ic-furtka.png
  ic-pozarowa.png
  ic-drzwi.png
```
> Ikony to gotowe rendery 3D z wyciętym tłem (transparent PNG). Użyj ich bezpośrednio jako assetów w aplikacji (eksportuj @1x/@2x/@3x lub trzymaj wektorowo w atłasie assetów). Renderuj z zachowaniem proporcji (`contain`).

## Fidelity
**High-fidelity.** Layout, glass, kolory, animacje i timingi są finalne. Odtwórz w naszym stacku ([React Native + Reanimated / SwiftUI — wstaw właściwy]); to NIE jest kod do skopiowania 1:1. `backdrop-filter` mapuj na natywny blur (expo-blur / UIVisualEffectView).

## Sekcje decka (kolejność + akcent + ikona)
| # | Nazwa | Ikona | Akcent | Status idle | Teksty akcji |
|---|---|---|---|---|---|
| 1 | Szlaban | `ic-szlaban.png` | `#6E8BFF` | „Opuszczony" | Podnoszę… → Podniesiony → toast „Szlaban podniesiony" |
| 2 | Brama wjazdowa | `ic-brama.png` | `#34D399` | „Zamknięta" | Otwieranie… → Otwarta → toast „Brama wjazdowa otwarta" |
| 3 | Brama pożarowa | `ic-pozarowa.png` | `#FF5A5F` | „Gotowa" | Awaryjne — dotknij; Otwieranie… → Otwarte |
| 4 | Furtka | `ic-furtka.png` | `#C58BFF` | „Zamknięta" | Otwieranie… → Otwarte → toast „Furtka otwarta" |
| 5 | Drzwi wejściowe | `ic-drzwi.png` | `#F0A93E` | „Zamknięte" | Otwieranie… → Otwarte → toast „Drzwi wejściowe otwarte" |

## Budowa jednej sekcji (slajdu)
Wyśrodkowana kolumna:
1. **Dial** (~98 px): SVG **pierścień postępu** (obwód r=54 ≈ 340; `stroke-dasharray:340; stroke-dashoffset:340` → przy otwieraniu `dashoffset:0` w `.9s cubic-bezier(.4,0,.2,1)`), kolor = akcent, `drop-shadow` glow akcentu.
2. **Szklana tarcza** (`.acc-core`, inset ~8 px, koło): jasny **spotlight** radialny `rgba(255,255,255,.5)→.16→.05` + dolna poświata w kolorze akcentu — dzięki temu ciemne metaliczne rendery czytelnie się odcinają. Cień wewnętrzny + zewnętrzny dla głębi.
3. **Ikona 3D** (`img`, ~82 px, `object-fit:contain`, `drop-shadow(0 5px 9px rgba(10,14,30,.55))`).
4. **Nazwa** (23 px, weight 650, −.02em) + **status** z kropką w kolorze akcentu + **podpowiedź** (11.5 px, opacity .5).

## Akcent per sekcja (CSS var `--acc`)
Przy przewijaniu aktywny indeks ustawia `--acc` na karcie → zmienia: pierścień, spotlight tarczy, kropkę statusu, aktywną kropkę paginacji oraz subtelną **poświatę radialną** całej karty (opacity ~.16, przejście .5 s).

## Paginacja
Rząd kropek pod deckiem; aktywna wydłuża się w pasek (6→22 px) w kolorze akcentu (jak w Mercedes me). Liczba kropek = liczba sekcji (generowana z danych).

## Interakcja
- **Swipe:** dotyk = natywny scroll `scroll-snap-type:x mandatory` (`scroll-snap-align:center`). Desktop = drag-to-scroll ze snapem do najbliższej sekcji po puszczeniu. Tap vs drag rozróżniaj progiem ~5 px (drag nie otwiera).
- **Otwieranie (tap w dial):** pierścień wypełnia się ~0.9 s → ikona zmienia się w duży ✓ (w kółku), tarcza + pierścień zielone (`#34D399`), status → „Otwarte/Podniesiony", **toast**, auto-reset po 3 s. Blokuj podwójne wywołanie w trakcie.
- **Produkcyjnie:** po wypełnieniu wywołaj API otwarcia zasobu (Tedee/Nuki/szlaban/przekaźnik); błąd/timeout → czerwony stan „Nie udało się otworzyć", bez auto-sukcesu. Loguj zdarzenie; **Brama pożarowa** → dodatkowo rejestruj i powiadom ochronę/administrację.
- **Nagłówek karty:** lewo — kicker „DOSTĘP" (tap → pełne menu „Co chcesz otworzyć?"). Prawo — 2 ikony glass: **kamera** (sheet podglądu live) i **domofon** (sheet rozmowy: Mów / Otwórz / Rozłącz, wspólny kadr wideo). Szczegóły w referencji + osobnym pliku Domofon.

## Karta „Dostęp" — glass
Wyraźnie przezroczysta, liquid-glass: `background: rgba(255,255,255,.02)`, `backdrop-filter: blur(11px) saturate(150%)` (celowo NIEwysoki blur — mocniejszy zamienia szkło w lity panel), border `rgba(255,255,255,.12)`, `box-shadow: inset 0 1px 0 rgba(255,255,255,.34), inset 0 -1px 0 rgba(255,255,255,.05), 0 22px 48px rgba(0,0,0,.4)`. Kompaktowa wysokość (dial 98, ciasne odstępy).

## Tokeny / timingi
- Akcenty per sekcja jak w tabeli; sukces `#34D399`; danger `#FF5A5F`.
- Pierścień otwierania: `.9s cubic-bezier(.4,0,.2,1)`. Spring hover: `cubic-bezier(.34,1.56,.64,1)`. Sheety: 380 ms `cubic-bezier(.32,.72,0,1)`. Toast 2 s. Przejście akcentu .35–.5 s.
- Font: Geist. `prefers-reduced-motion` → bez dekoracyjnych animacji, od razu stan końcowy.

## Uwaga o ikonach
Rendery są ciemne/metaliczne — **muszą leżeć na jasnym spotlightcie tarczy**, nie na kolorowym chipie (własne kolory renderów kłóciłyby się z akcentem). Zachowaj margines (ikona ~82 px w tarczy ~90 px). Eksportuj w 2×/3× dla ostrości na retina.

## Prompt startowy dla Claude Code
> Przeczytaj README.md i otwórz `Glass Depth Premium.html` (przeklikaj deck „Dostęp": swipe między sekcjami, tap w dial = otwieranie, kamera/domofon w nagłówku). Zaimplementuj sekcję „Dostęp" jako pełnoszerokościowy, stronicowany carousel wejść w naszym stacku, pixel-perfect do referencji. Użyj gotowych ikon 3D z `assets/` (transparent PNG) na jasnym spotlightcie szklanej tarczy. Priorytety: (1) deck + snap + drag-to-scroll + paginacja z aktywnym paskiem, (2) akcent per sekcja przez zmienną koloru (pierścień, spotlight, kropki, poświata karty), (3) tap-to-open: wypełnienie pierścienia .9 s → ✓ zielony → toast → reset, z wywołaniem API i obsługą błędu (Brama pożarowa: potwierdzenie + log + powiadomienie), (4) nagłówek: kamera (podgląd live) i domofon (rozmowa) jako bottom sheety, (5) karta liquid-glass (niski blur!), reduced-motion. Sekcje i akcenty wg tabeli w README. Teksty po polsku (i18n-ready).
