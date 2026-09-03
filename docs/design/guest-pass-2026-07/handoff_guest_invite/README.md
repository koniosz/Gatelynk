# Gatelynk — Guest Invite (strona zaproszenia gościa) — handoff dla Claude Code

## Co to jest
Dynamiczna, publiczna **strona zaproszenia gościa** w Gatelynk. Mieszkaniec generuje ją z aplikacji; gość dostaje **zaszyfrowany link** (SMS / e-mail) i otwiera go w przeglądarce telefonu — bez instalowania aplikacji. Na stronie widzi kto go zaprasza, dane wizyty, **udostępnione wejścia do otwarcia**, awaryjny **PIN** oraz przycisk **nawigacji**. Wersja w tym pakiecie jest w finalnym stylu **GateLynk Glass** (ciemny, szklany, akcent fiolet) — spójnym z aplikacją.

## Plik
```
Guest Invite.html   ← referencja designu (otwórz w przeglądarce; przeklikaj wszystko)
README.md           ← ten dokument
```

## Fidelity
**High-fidelity.** Layout, kolory, glass, typografia, animacje i interakcje są finalne. Odtwórz **w platformie Gatelynk** (front web/SSR strony zaproszenia) zgodnie z naszym stackiem — to NIE jest kod produkcyjny do skopiowania 1:1. Blur mapuj na natywny/CSS `backdrop-filter`, ikony na nasz zestaw.

## Struktura strony (od góry)
1. **Pasek marki** — logo „Gatelynk" + chip „Bezpieczne zaproszenie" (kłódka).
2. **Hero (glass)** — awatar hosta, „Zaprasza Cię **Anna Szychta**", powitanie „Cześć, Marek", karta z danymi: **Adres**, **Mieszkanie**, **Ważność dostępu** (fioletowy akcent), oraz **przycisk „Nawiguj"** (pełna szerokość, akcent) w tej samej karcie. Pod kartą zielony **licznik** „Dostęp aktywny — wygasa za …".
3. **Twoje wejścia (glass lista)** — wiersze: Brama wjazdowa, Drzwi do klatki, Winda — 4 piętro (CTA „Wezwij"), Drzwi mieszkania (Tedee), **Brama pożarowa** (CTA „Awaryjnie"). Każdy wiersz: fioletowy orb ikony + tytuł + podtytuł + CTA pigułka. Tap → spinner „Otwieram" (1.4 s) → „Otwarte ✓" + toast, auto-reset po 3.5 s. **Brama pożarowa** wymaga potwierdzenia w bottom sheet.
4. **Awaryjny PIN (glass)** — 6-cyfrowy kod ukryty kropkami; **pokaż** (oko) i **kopiuj** (schowek → toast). „PIN ważny przez cały czas zaproszenia".
5. **Dobrze wiedzieć (glass)** — zasady (parking gości, cisza nocna, kontakt do ochrony) z zielonymi checkmarkami.
6. **Stopka** — „Link zaszyfrowany end-to-end · ID zaproszenia GTL-…", link „Zgłoś nadużycie".
7. **Bottom sheet potwierdzenia** (brama pożarowa) + **toast**.

## Design tokens (GateLynk Glass)
- **Tło:** ciemny granat `#070a12`/`#0a0e1a` + animowana **aurora** (dwie dryfujące poświaty fiolet/niebieski, blur 60px). `prefers-reduced-motion` → wyłącz.
- **Glass:** `background: linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.045))`, `backdrop-filter: blur(30px) saturate(160%)`, border `rgba(255,255,255,.12)`, `box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 22px 48px rgba(0,0,0,.42)`, radius 20–24.
- **Akcent:** gradient `#C5B0FF → #5B7CFA` (przyciski, orby, „Nawiguj"), glow `rgba(139,107,240,.45)`.
- **Semantyczne:** success `#34D399`/`#7BE2A3` (licznik, checkmarki, „Otwarte"), danger `#FF6B6B`/`#E23B3B` (brama pożarowa), warning `#FBBF24` (PIN).
- **Tekst:** primary `#F4F6FB`, secondary `#C2CADF`, tertiary `#8B96B4`.
- **Font:** Geist (+ Geist Mono na cyfry PIN). Nagłówki ujemny letter-spacing.
- **Timingi:** otwieranie wejścia spinner 1.4 s → „Otwarte" 3.5 s; sheet 300 ms `cubic-bezier(.32,.72,0,1)`; toast 2 s; aurora 22–26 s.

## Logika do wdrożenia produkcyjnie
- **Bezpieczny link:** token (JWT lub podpisany identyfikator) w URL → serwer waliduje ważność (okno czasowe), zakres udostępnionych wejść, hosta i gościa. Wygasłe/odwołane → strona „Zaproszenie wygasło".
- **Licznik** liczony z `expiresAt` z tokenu.
- **Otwieranie wejść:** przycisk → API otwarcia konkretnego zasobu (brama/Tedee/winda/przekaźnik) w kontekście uprawnień z tokenu. Obsłuż błąd/timeout (czerwony stan „Nie udało się otworzyć"). Loguj każde otwarcie (kto/kiedy/które wejście) i powiadom hosta.
- **Brama pożarowa:** potwierdzenie + rejestrowanie zdarzenia i powiadomienie administracji + hosta.
- **PIN:** awaryjny kod offline (gdy brak zasięgu klawiatura przy bramie). Kopiowanie przez `navigator.clipboard`.
- **Nawiguj:** deep-link do map (geo:/Apple/Google Maps) z adresem/koordynatami osiedla.
- Wszystkie teksty po polsku (i18n-ready).

## Prompt startowy dla Claude Code
> Przeczytaj README.md, otwórz `Guest Invite.html` i przetestuj (otwieranie wejść, potwierdzenie bramy pożarowej, PIN pokaż/kopiuj, „Nawiguj", licznik, toasty). Zaimplementuj tę stronę zaproszenia gościa w platformie Gatelynk zgodnie z naszym stackiem, pixel-perfect do referencji, z tokenami i timingami z README. Priorytety: (1) layout + glass + aurora, (2) walidacja bezpiecznego linku (token, okno czasowe, zakres wejść) i licznik z `expiresAt`, (3) otwieranie wejść przez API z logowaniem i obsługą błędu, (4) potwierdzenie bramy pożarowej, (5) PIN + „Nawiguj" (deep-link do map). Blur mapuj na `backdrop-filter`, ikony na nasz zestaw, teksty po polsku (i18n-ready), uszanuj `prefers-reduced-motion`.
