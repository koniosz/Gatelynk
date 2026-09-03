# Urządzenie dostępu offline (PoE keypad) — „GateLynk Sentry"

> Status: **PROJEKT — czeka na akceptację właściciela** (2026-07-18). Zero zmian
> w kodzie produkcyjnym, zero zmian na urządzeniach Villa Natura. Dokument
> powstał po audycie kodu Edge (`intercom-pin`, `tunnel`, `access-points`,
> `hikvision-lpr`, `store`) i Cloud (`edge.gateway`, `edge-outbox`, `guests/*`,
> `resident.setIntercomPin`, `access-events`). Decyzje sprzętowe i otwarte
> pytania — sekcja [OTWARTE DECYZJE](#13-otwarte-decyzje-dla-właściciela).

## 1. Cel i zakres

Mieszkaniec, gość i kurier muszą móc wejść/wjechać na osiedle, gdy zawiedzie
**dowolna** warstwa: internet, Cloud, Edge (Mac Mini), LAN, telefon użytkownika.
Rozwiązanie: proste, tanie urządzenie zasilane po PoE, montowane przy
wejściu/wjeździe, które:

- trzyma **lokalną kopię poświadczeń** (PIN-y mieszkańców, PIN-y gości z oknem
  czasowym/harmonogramem/limitem użyć, w kolejnych fazach karty NFC i kody
  kryptograficzne weryfikowalne bez żadnej synchronizacji),
- waliduje je **całkowicie lokalnie** i wyzwala przekaźnik bramy/furtki
  **bezpośrednio stykiem bezpotencjałowym** (bez pośrednictwa LAN),
- synchronizuje się delta+snapshot z Edge po LAN (wzorce `*_SYNC_ALL` już
  istniejące w platformie), a gdy Edge padnie — działa na ostatnim snapshocie,
- buforuje zdarzenia i po odzyskaniu łączności backfilluje audyt do
  `access_events` w chmurze (istniejące eventy `GUEST_PIN_USED` /
  `GUEST_ACCESS_USED` / `GUEST_ACCESS_DENIED` / `RESIDENT_PIN_USED`).

Poza zakresem iteracji 1: implementacja firmware, zmiany w kodzie platformy,
zakup sprzętu. Ten dokument = architektura + wybór sprzętu (warianty) +
protokół + plan faz.

## 2. Macierz awarii — stan obecny (audyt kodu, 2026-07-18)

### 2.1 Ustalenie kluczowe (korekta wcześniejszego założenia)

**Kamery LPR Hikvision NIE trzymają własnej whitelisty.** Komentarz w
`apps/edge/src/devices/cameras/hikvision-lpr.service.ts:18-40` mówi wprost:
firmware DeepinView V5.8.x nie akceptuje ISAPI `plateInfoList`, więc lista
tablic żyje wyłącznie w SQLite Edge (`lpr_plates`), kamera jest **tylko
detektorem**, a decyzja i wyzwolenie przekaźnika zapadają na Edge
(`AccessPointExecutor.fire`). Kolumna `LprCamera.whitelistMode`
(`edge`/`camera`/`hybrid`) istnieje w schemacie, ale tryb `camera` nie jest
zaimplementowany dla obecnego firmware. **Wniosek: przy padzie Edge nie działa
NIC — także wjazd LPR.** To silniejsze uzasadnienie dla urządzenia offline niż
pierwotnie zakładano.

### 2.2 Jak działa dziś (ścieżki krytyczne)

```
GOŚĆ/MIESZKANIEC wpisuje PIN na Akuvox
  → Akuvox Action URL (HTTP po LAN) → Edge :4000/akuvox/event
  → IntercomPinService: match w SQLite (guest_pins → resident_pins),
    ograniczenia offline (okno, harmonogram TZ, allowlista AP, limit użyć)
  → AccessPointExecutor.fire → driver.pulse (HTTP po LAN do urządzenia)
  → EVT audytu tunelem; gdy WS down → event_queue (SQLite, bez dropu)

AUTO wjeżdża
  → kamera Hikvision ANPR event (XML po LAN) → Edge
  → match lpr_plates + cooldown + ograniczenia gościa
  → lpr_camera_ap_links → AccessPointExecutor.fire → pulse
  → lpr_reads (synced_to_cloud=0/1, backfill 500/rundę)
```

### 2.3 Macierz: tryb awarii × wejście

Legenda: ✅ działa · 🟡 działa częściowo/z zastrzeżeniem · ❌ nie działa.
Kolumna „po wdrożeniu" = z urządzeniem offline (Sentry) przy danym wejściu.

| Tryb awarii | Wjazd LPR | Furtka / PIN na domofonie | Domofon (rozmowa) | Zdalne „Otwórz" (app) | **Po wdrożeniu Sentry** |
|---|---|---|---|---|---|
| **Wszystko działa** | ✅ | ✅ | ✅ | ✅ | ✅ (Sentry = dodatkowy punkt) |
| **Cloud down** (internet/Fly) | ✅ whitelist lokalna | ✅ walidacja lokalna Edge | ❌ (sygnalizacja przez Cloud) | ❌ | ✅ bez zmian + Sentry ✅ |
| **Edge down** (Mac Mini) | ❌ kamera = tylko detektor (§2.1) | ❌ Action URL nie odpowiada | ❌ | ❌ (komenda idzie przez Edge) | **✅ PIN/NFC/kod na Sentry** (LPR dalej ❌ — auto wjeżdża po otwarciu bramy PIN-em) |
| **LAN down** (switch/kabel do urządzenia) | 🟡 walidacja przejdzie, `pulse` po LAN padnie → `gate_error` | 🟡 jw. | ❌ | 🟡 jw. | **✅ Sentry ma własny styk** — nie potrzebuje LAN do otwarcia |
| **Prąd down** (brak zasilania przy wejściu) | ❌ | ❌ | ❌ | ❌ | 🟡 **tylko z UPS na switchu PoE** (rekomendacja instalacyjna §9); napęd bramy też bez prądu — furtka z zamkiem rewersyjnym + klucz mechaniczny |
| **Telefon down** (rozładowany / brak apki) | ✅ (tablica) | ✅ (PIN z pamięci) | 🟡 gość może dzwonić, mieszkaniec nie odbierze | ❌ | ✅ PIN/karta NFC — zero zależności od telefonu |

### 2.4 Macierz: tryb awarii × aktor (stan obecny, bez Sentry)

| Aktor | Cloud down | Edge down | LAN down | Telefon down |
|---|---|---|---|---|
| **Mieszkaniec** | ✅ LPR + PIN (`resident_pins` lokalne) | ❌ wszystko | 🟡 walidacja OK, otwarcie ❌ | ✅ LPR + PIN |
| **Gość** | ✅ PIN + tablica gościa (okno/limity liczone lokalnie: `guest_pins.allowed_aps/schedule/cloud_uses` + `guest_uses`) — 🟡 **nowy** gość utworzony w trakcie awarii nie zsyncuje się (outbox dostarczy po reconnect) | ❌ wszystko | 🟡 jw. | ✅ PIN z zaproszenia (SMS/mail/kartka) |
| **Kurier** | 🟡 kod 4-cyfrowy → `COURIER_VISIT_NEW` wymaga Cloud (push do mieszkańców) → ❌; tablica na whiteliście (DELIVERY) ✅ | ❌ | 🟡 | ✅ jak gość |

Bufory audytu (dziś, potwierdzone w kodzie): `event_queue` (SQLite, FIFO,
flush 100/30 s, retry bez limitu) + `lpr_reads.synced_to_cloud` (backfill
500/rundę). Idempotencja po stronie Cloud: `dedupKey`/`useId`/`edgeReadId` +
`WHERE NOT EXISTS`. **Sentry powiela dokładnie ten wzorzec o poziom niżej.**

## 3. Architektura — umiejscowienie w systemie

Sentry to **trzeci poziom degradacji**, poniżej Cloud i Edge. Zasada: każdy
poziom działa na ostatnim znanym stanie poziomu wyżej.

```
┌──────────── CLOUD (Fly.io) ─────────────┐
│ Postgres: guests, residents.intercomPin, │   source of truth poświadczeń
│ vehicles, access_events, edge_sync_outbox│
└───────────────┬─────────────────────────┘
                │ WS tunnel /api/edge/tunnel (outbox + *_SYNC_ALL @ reconnect)
┌───────────────▼──────────── EDGE (Mac Mini, LAN) ────────────┐
│ SQLite: guest_pins, resident_pins, lpr_plates, access_points, │  poziom 1 offline
│ event_queue · IntercomPinService · AccessPointExecutor        │  (Cloud down OK)
│                                                               │
│  NOWE: OfflineKeypadService (WS server dla Sentry)            │
│   • CRED_SYNC_ALL / CRED_UPSERT / CRED_DELETE (podpisane)     │
│   • ingest EVENT_BATCH → event_queue → Cloud                  │
└───────┬───────────────────────────────────────────────────────┘
        │ LAN (WS klient → Edge :4000; TLS/Noise; snapshot podpisany Ed25519)
┌───────▼──────────── SENTRY (przy wejściu, PoE) ───────────────┐
│ ESP32-POE-ISO · klawiatura IP65 · (F2: NFC) · RTC bateryjny   │  poziom 2 offline
│ Flash (szyfrowany): snapshot poświadczeń + ring-buffer zdarzeń │  (Edge down OK)
│ PRZEKAŹNIK NO/C (styk bezpotencjałowy) ──── wprost do bramy ──┼──► napęd bramy /
│ tamper switch · rate-limit prób PIN                            │    zamek furtki
└────────────────────────────────────────────────────────────────┘
```

Decyzje architektoniczne (uzasadnienie):

1. **Sentry rozmawia z Edge, nie z Cloud.** Edge już jest agregatorem
   poświadczeń budynku (sekcja 2.2) i jedynym miejscem, gdzie wolno trzymać
   sekrety urządzeń (zasada projektu: sekrety NIGDY plaintext w chmurze —
   `sanitizeDeviceConfig` w `edge.gateway.ts` filtruje hasła). Bezpośredni
   fallback LTE do Cloud — poza MVP (D6, §13).
2. **Sentry ma własny przekaźnik.** To jedyny sposób zamknięcia trybu „LAN
   down": walidacja i wyzwolenie muszą być w jednym pudełku, styk idzie kablem
   do sterownika bramy / zamka. Gdy Edge żyje, Sentry może też być zwykłym
   output-driverem dla platformy (AP binding, §10).
3. **Always-local:** Sentry waliduje lokalnie ZAWSZE, także gdy Edge jest
   online (jedna ścieżka kodu = testowana codziennie, nie tylko w awarii).
   Po walidacji wysyła zdarzenie do Edge (online) lub buforuje (offline).
   Analogia: tak samo działa dziś Edge względem Cloud.
4. **Snapshot > delta.** Delta (`CRED_UPSERT/DELETE`) dla świeżości, pełny
   podpisany snapshot (`CRED_SYNC_ALL`) przy każdym reconnect — dokładnie
   wzorzec `PLATE_SYNC_ALL`/`PIN_SYNC_ALL` z 8.h.25/8.h.2, który już
   zamknął klasę bugów „wieczny drift po zgubionej delcie".

## 4. Wybór sprzętu — szczegóły, warianty + BOM

Sprzęt rozbijamy na dwie niezależne decyzje: **kontroler** (K1–K3, decyzja D1)
i **konstrukcja mechaniczna panelu** (M1–M3, decyzja D2). Dowolna para K×M
jest technicznie spójna; rekomendowane pary — §4.8.

### 4.1 Kontroler — warianty K1–K3 (decyzja D1)

Weryfikacja specyfikacji 2026-07-18 (źródła na końcu sekcji):

| Kryterium | **K1: Olimex ESP32-POE-ISO(-IND)** | **K2: Silicognition wESP32** | K3: dowolny ESP32 + splitter PoE 802.3af→12 V |
|---|---|---|---|
| Cena | ~140 zł (wariant 16 MB; IND nieco drożej) | ~200–250 zł | ~80 zł (płytka) + ~60–80 zł (splitter) |
| PoE | 802.3af (TPS2375), **izolacja 3000 V DC** | **802.3at Type 1 Class 0**, izolacja 1500 Vrms, Mode A+B | zależnie od splittera (zwykle af, 10–15 W) |
| **Budżet mocy** | ⚠️ **2 W** — izolowana przetwornica DC-DC 5 V→5 V ogranicza CAŁY pobór do 2 W | **12,95 W na V+ (12 V)** lub 5 W przy 5 V (zworka); dodatkowo 3,3 V do 6 W | 10–15 W z splittera |
| Zakres temperatur | wersje **-IND: −40…+85 °C** (komercyjne 0…70 °C) | **niepotwierdzony** (brak wariantu przemysłowego w dokumentacji — do testu mrozowego) | zależnie od komponentów |
| Flash / moduł | ESP32-WROOM-32, warianty 16 MB | ESP32-WROOM-32E, **16 MB** (rev 7+) | dowolny |
| Zasilenie zamka 12 V z PoE | ❌ (2 W to za mało na rygiel ~6 W) | ✅ **V+ 12 V zasili rygiel furtki chwilowo** (~6 W ≪ 13 W) — jeden kabel ETH robi klawiaturę + zamek | ✅ z 12 V splittera |
| Kryptografia | flash encryption + Secure Boot v2 (eFuse), HW AES/SHA; Ed25519 przez monocypher | jw. (ten sam SoC) | jw. |
| Ocena | najbezpieczniejszy termicznie, ciasny energetycznie | najwygodniejszy energetycznie, ryzyko temperaturowe | najtańszy w rozbudowie, najwięcej pudełek/punktów awarii |

**Rekomendacja: K1 (ESP32-POE-ISO-IND)** jako baza — urządzenie wisi na
zewnątrz przez polską zimę, gwarantowany zakres −40…+85 °C bije wygodę
energetyczną. Budżet 2 W jest wykonalny (bilans w §4.5) pod warunkiem: styk
bezpotencjałowy (nie zasilamy zamka), przekaźniki czułe/bistabilne, NFC
z duty-cycle. **K2 (wESP32) jako wariant dla furtki z ryglem 12 V** — jeden
kabel ETH załatwia wszystko, ale przed użyciem na zewnątrz wymagany test
komorą mrozową / zima na obiekcie testowym (albo montaż w szafce z grzałką).

Dlaczego nie Raspberry Pi (CM4/CM5 + carrier PoE, ~350–500 zł): 3–7 W poboru,
karta SD/eMMC koruptująca się przy zanikach zasilania, pełny OS do utwardzenia
(readonly rootfs, watchdog), boot dziesiątki sekund vs < 1 s. Zostaje planem B,
gdyby firmware C okazał się za ciasny (nie powinien: baza poświadczeń osiedla
55 domów < 100 kB, snapshot CBOR mieści się w RAM).

Dlaczego nie gotowy kontroler przemysłowy (300–800 zł): zamknięty firmware =
brak naszego protokołu sync (okna czasowe gości, limity użyć, backfill do
`access_events`). Cofa nas do kodów statycznych.

**Rozważone: M5Stack Tough ESP32** (~200–250 zł; ESP32 16 MB flash + 8 MB
PSRAM, RTC BM8563, RS-485, szczelna obudowa, dotykowy IPS 2"). Odrzucony
jako urządzenie wejściowe z trzech powodów (weryfikacja 2026-07-18):
1. **Brak Ethernet/PoE** — łączność tylko Wi-Fi; Ethernet wymaga osobnego
   modułu/mostka (Unit PoESP32 po UART) + osobnego zasilania. Nasz wymóg
   bazowy (jeden kabel PoE, zero Wi-Fi w łańcuchu bezpieczeństwa) jest
   dokładnie odwrotny.
2. **Pojemnościowy ekran dotykowy jako klawiatura zewnętrzna** — krople
   deszczu generują fałszywe dotknięcia, zimowe rękawiczki nie działają,
   mróz/szron degraduje digitizer, a 2-calowa szyba przy publicznej furtce
   to naturalny cel wandalizmu. Do tego smudge-attack: ślady palców na
   szkle zdradzają cyfry PIN-u.
3. Zakres temperatur pracy nieudeklarowany w dokumentacji (brak wariantu
   przemysłowego), obudowa „dust/waterproof" bez formalnej klasy IP65.

Sensowne zastosowania Tough w projekcie: **terminal serwisowy** w szafce
bramy (RS-485 do kontrolera — diagnostyka, re-arm tampera bez laptopa)
albo szybki prototyp UI w Fazie 0. NIE jako panel przy wejściu.

### 4.2 Panel wejściowy — warianty M1–M3 (decyzja D2)

Najtrudniejszy element całego projektu to NIE elektronika, tylko **front:
wodoodporny (IP65+), wandaloodporny, mrozoodporny panel z klawiaturą**.
Stąd trzy warianty:

- **M1 — panel zintegrowany (własny):** nasza obudowa, metalowa klawiatura
  matrycowa 3×4 IP65 (~80–150 zł), za frontem antena PN5180 (F2). Zalety:
  pełna kontrola, prawdziwa kryptografia DESFire od F2. Wady: sami
  odpowiadamy za szczelność/wandaloodporność frontu — najwyższe ryzyko
  mechaniczne MVP.
- **M2 — gotowy panel Wiegand + nasz kontroler** ✅ **rekomendacja MVP:**
  kupny hermetyczny czytnik z klawiaturą (IP66, metal, 13,56 MHz + PIN,
  interfejs Wiegand 26/34, zasilanie 9–15 V, ~120–250 zł — rynek kontroli
  dostępu ma dziesiątki takich paneli) podłączony 4 żyłami (12 V, GND, D0,
  D1) do kontrolera Sentry w puszce **po stronie chronionej**. Zalety:
  najtrudniejsza część kupiona i sprawdzona rynkowo; naturalny split
  (przekaźnik nigdy po stronie publicznej); czytnik NFC „gratis" od MVP.
  Wady: Wiegand jest plaintext (podsłuch/wstrzyknięcie na przewodach —
  ograniczone, bo przewód biegnie po stronie chronionej i ma < 1–2 m);
  NFC tylko w trybie **UID** (patrz §4.6 — wystarczające na F2-lite, pełna
  kryptografia karty wymaga M1/M3).
- **M3 — własny panel + OSDP (RS-485, szyfrowane)** — docelowy wariant
  produkcyjny (F4): mała płytka panelu (klawiatura + PN5180 + MCU
  ESP32-C3/STM32) rozmawiająca z kontrolerem OSDP v2 po RS-485. Standard
  branżowy, kanał szyfrowany, do 1200 m przewodu.

**Rekomendacja MVP: K1 + M2** (szczegół par — §4.8). M1 tylko jeśli chcemy
własny front już teraz; M3 dopiero w F4.

### 4.3 Elektronika kontrolera — interfejsy i budżet GPIO

Na ESP32 z Ethernetem RMII (PHY zjada ~9 GPIO) zostaje ~10–12 wolnych pinów —
wystarczy przy dyscyplinie magistral:

| Peryferium | Interfejs | Piny | Uwagi |
|---|---|---|---|
| RTC DS3231SN | I²C (współdzielona) | 2 | ±2 ppm, bateria CR2032 (5–8 lat); alternatywa RV-3028 (niższy pobór) |
| Skaner klawiatury (M1) | I²C — **TCA8418** | (0 — na wspólnej magistrali) | dedykowany kontroler klawiatur 8×10, przerwanie na 1 pinie; oszczędza 7 GPIO vs matryca wprost |
| Panel Wiegand (M2) | 2× GPIO (D0/D1, przerwania) | 2 | poziomy 5 V → konwerter/dzielnik do 3,3 V |
| PN5180 (M1/M3, F2) | SPI | 5 | NSS/SCK/MOSI/MISO + BUSY/RST |
| Przekaźniki ×2 | GPIO + driver (ULN2003/tranzystor) | 2 | §4.4 |
| Tamper | GPIO (przerwanie, pull-up) | 1 | kontaktron lub mikrostyk |
| Buzzer + LED×2 | GPIO / PWM | 3 | LED status dostępu + dioda serwisowa |
| RS-485 (M3, F4) | UART + DE | 3 | transceiver MAX3485/THVD1450 |
| Secure element (opcja, F4) | I²C — ATECC608B | (0) | uwaga: ATECC liczy ECDSA P-256, nie Ed25519 — użycie SE oznacza zmianę schematu podpisów snapshotów na P-256; w MVP wystarcza flash encryption + eFuse |

### 4.4 Przekaźniki i sterowanie zamkiem

- **2× przekaźnik SPDT (NO/NC/C)**, styki min. 2 A/30 V DC (wejścia
  sterowników bram to sygnały niskonapięciowe; 230 V nie przełączamy nigdy —
  granica bezpieczeństwa i uprawnień SEP):
  - **#1** → wejście „otwórz" sterownika bramy / rygiel furtki,
  - **#2** → rezerwa: druga brama, oświetlenie, syrena tamper.
- Na K1 (budżet 2 W): przekaźniki **czułe** (cewka ~0,2 W) albo
  **bistabilne** (impuls, zero poboru w spoczynku) + drivery z diodą
  gaszącą; na K2/K3 zwykłe moduły 5 V wystarczą.
- Warystor/RC-snubber równolegle do styków (cewki zamków = indukcyjność,
  iskrzenie skraca życie styków).
- **Zamek furtki — decyzja instalacyjna per obiekt** (do runbooka):
  - *fail-secure* (rygiel standardowy, otwiera impuls) — bez prądu zamknięte;
    wymaga klucza mechanicznego jako wyjścia awaryjnego,
  - *fail-safe* (rewersyjny, zwora) — bez prądu otwarte; wymagany na drogach
    ewakuacyjnych (ppoż. decyduje, nie my).
  - Zasilanie zamka: z szafki bramy (K1) albo z V+ 12 V wESP32 (K2 — jeden
    kabel ETH na słupek).
- Przy wjeździe: styk #1 równolegle do istniejącego wejścia sterownika
  szlabanu/bramy (obok przekaźnika Akuvox/Hikvision, które odpala dziś Edge) —
  logiczne OR, kanały w pełni niezależne.

### 4.5 Bilans mocy (krytyczne dla K1 — limit 2 W / 400 mA @ 5 V)

| Odbiornik | Średnio | Szczyt | Mitygacja na K1 |
|---|---|---|---|
| ESP32 + ETH aktywny | ~0,7 W | ~0,9 W | Wi-Fi/BT wyłączone na stałe (radio nieużywane) |
| Przekaźnik (cewka, czas otwarcia ~1 s) | ~0 W (rzadko) | 0,2–0,36 W | czuła cewka 0,2 W lub bistabilny ~0 W |
| PN5180 pole RF (F2, M1) | ~0,1 W (duty 10 %) | 0,75–1,25 W | polling 100 ms co 1 s; pole ciągłe tylko po wykryciu karty; szczyt NIGDY równocześnie z przekaźnikiem (sekwencja: odczyt → pole off → przekaźnik) |
| Podświetlenie klawiatury | 0,1–0,2 W | 0,2 W | PWM, przygaszone nocą, full po pierwszym klawiszu |
| Panel Wiegand (M2) | 0,6–1,8 W | 2 W+ | ⚠️ **panel 12 V NIE zmieści się w 2 W K1 razem z resztą** → M2 wymaga K2/K3 albo osobnego zasilania panelu z szafki |
| **Suma K1+M1** | **~0,9–1,1 W** | **~1,6–1,9 W** | mieści się w 2 W z sekwencjonowaniem szczytów |

Wniosek twardy: **para K1+M2 wymaga zasilenia panelu Wiegand poza budżetem
PoE kontrolera** (np. 12 V z szafki bramy) — bez tego wybieramy K2 albo K3.
To główny argument par rekomendowanych w §4.8.

### 4.6 NFC — czytniki i realny poziom bezpieczeństwa (F2)

| Ścieżka | Sprzęt | Co naprawdę weryfikujemy | Bezpieczeństwo |
|---|---|---|---|
| **F2-lite (M2)** | czytnik wbudowany w kupny panel Wiegand | **UID karty** (CSN) przesłany Wiegandem | umiarkowane: UID 7-bajtowy da się sklonować „magic card"; wystarczające dla furtki osiedlowej jako wygoda, NIE jako jedyne zabezpieczenie |
| **F2-full (M1/M3)** | **PN5180** (SPI) — pełny ISO 14443-4 | **kryptograficzna autoryzacja DESFire EV3** (AES, klucz per instalacja, nieklonowalne) | wysokie |
| odrzucone | RC522 (~10 zł) | tylko proste 14443A, słaby zasięg, brak wsparcia EV3 | — |
| odrzucone | PN532 | działa, ale PN5180 ma lepszy RF i pełniejszy stos przy tej samej ~cenie (~60 zł) | — |

Karty: **DESFire EV3 2K/4K** (~4–8 zł/szt.) — nawet w trybie UID (F2-lite)
kupujemy od razu EV3, żeby te same karty przeszły na F2-full bez wymiany.
MIFARE Classic odrzucone (złamany 2008, klony za grosze).

### 4.7 Ochrona środowiskowa i przepięciowa (urządzenie outdoor)

- **Temperatura:** elektronika w wersji IND (−40…+85 °C) — K1-IND; kondensat:
  membrana wentylacyjna (Gore-vent, ~10 zł) zamiast szczelnego pudełka
  „na amen", lakier konforemny na PCB.
- **Obudowa MVP:** poliwęglanowa skrzynka IP65 UV-stabilna (Fibox/Gainta,
  ~60–120 zł), dławice M12/M16, montaż: elektronika po stronie chronionej
  (M2: tylko panel na zewnątrz).
- **Przepięcia:** linie do panelu (D0/D1/12 V) i do zamka — diody TVS +
  rezystory szeregowe; Ethernet po stronie PoE ma izolację 3000 V DC (K1),
  ale przy trasach kablowych na zewnątrz budynku dodać ogranicznik
  przepięć LAN (gigabit surge protector, ~50 zł) przy switchu — standard
  instalacyjny jak dla kamer IP.
- **ESD klawiatury:** panel metalowy uziemiony; wariant M1 — klawiatura
  z membraną i TVS na liniach matrycy.

### 4.8 Rekomendowane pary K×M i BOM

**Para P1 (rekomendacja MVP): K1-IND + M2** — kontroler mrozoodporny
w puszce przy szafce bramy, kupny panel Wiegand na słupku, panel zasilany
12 V z szafki (jest tam zasilacz napędu):

| Element | Przykład | Cena szac. |
|---|---|---|
| Kontroler | Olimex **ESP32-POE-ISO-IND** (16 MB) | ~160 zł |
| Panel | hermetyczny czytnik 13,56 MHz + klawiatura, Wiegand 26/34, IP66, metal | ~150–250 zł |
| RTC | DS3231 + CR2032 | ~15 zł |
| Przekaźniki | 2× moduł czuły SPDT + driver | ~20 zł |
| Konwerter poziomów | Wiegand 5 V → 3,3 V (dzielniki/bufor) | ~5 zł |
| Tamper + buzzer + LED serwisowa | | ~20 zł |
| Obudowa kontrolera | IP65 poliwęglan + dławice + Gore-vent | ~90 zł |
| Ochrona | TVS, warystory, surge LAN przy switchu | ~70 zł |
| Drobnica (przewody, złączki, śruby bezpieczne torx) | | ~40 zł |
| **Razem P1** | | **~570–680 zł/szt.** |

**Para P2 (furtka „jeden kabel"): K2 + M2** — wESP32 zasila panel i rygiel
12 V z PoE 802.3at; wymaga switcha 802.3at i testu mrozowego wESP32:
~640–750 zł/szt. (kontroler +60 zł, odpada zasilanie z szafki).

**Para P3 (pełna kontrola frontu): K1-IND + M1** — własny panel z klawiaturą
matrycową IP65 + PN5180 za frontem; najtańsza (~450–560 zł), ale całe ryzyko
mechaniczne frontu po naszej stronie. Sensowna dla prototypu Fazy 0
(na biurku front nie musi być odporny).

Dla porównania: Akuvox R29 ~4–6 tys. zł/szt. Trzy wejścia Villa Natura
w parze P1 ≈ **1,8–2,0 tys. zł** łącznie.

### 4.9 Lista zakupowa Fazy 0 (prototyp na biurku, ~550 zł)

1× ESP32-POE-ISO (może być komercyjny, nie IND — biurko), 1× tani panel
Wiegand z klawiaturą (ten sam model co docelowy!), 1× klawiatura matrycowa
3×4 + TCA8418 (porównanie M1 vs M2 w praktyce), DS3231, 2× moduł
przekaźnika, PN5180 (wstępne testy NFC), zasilacz 12 V (symulacja szafki),
switch PoE 802.3af (jeśli brak), karty DESFire EV3 ×5, drobnica stykowa.
Cel: zmierzyć realny bilans mocy (§4.5) i czas boot→gotowość, zanim
zamrozimy wybór pary K×M.

Źródła specyfikacji: [Olimex ESP32-POE-ISO (GitHub — 3000 VDC isolation)](https://github.com/OLIMEX/ESP32-POE-ISO),
[User Manual Olimex (2 W limit przetwornicy, warianty -IND −40…+85 °C)](https://www.mouser.com/catalog/specsheets/Olimex_02-16-2026_ESP32-POE-user-manual.pdf),
[wESP32 — 802.3at, 12,95 W @ 12 V, 16 MB flash](https://wesp32.com/),
[wESP32 Product Brief](https://wesp32.com/files/wESP32-Product-Brief.pdf).

## 5. Lokalna baza poświadczeń

Sentry trzyma w szyfrowanym flashu (LittleFS + flash encryption) snapshot
ograniczony do **swojego zakresu** (minimalizacja: tylko poświadczenia ważne
dla AP, do których Sentry jest przypięty):

```
credentials.snapshot  (CBOR/protobuf, podpisany Ed25519 przez Edge)
├─ meta: { version (monotoniczny), issuedAt, buildingId, apIds[], edgePubKeyId }
├─ resident_pins[]: { residentId, pinHash }          // permanentne
├─ guest_pins[]:    { guestId, pinHash, validFrom, validUntil,
│                     allowedAps[]|null, schedule{days,startTime,endTime,tz}|null,
│                     maxUses|null, cloudUses }       // 1:1 z guest_pins Edge
├─ nfc_cards[]:     { credId, ownerType, ownerId, uidHash | desfireKeyRef }  // Faza 2
└─ offline_code_secret: K_building (32 B)             // Faza 3, tylko device+Edge
```

Zasady:

- **PIN-y jako HMAC-SHA256(pepper_device, pin)**, nie plaintext. Uwaga
  uczciwie: przy przestrzeni 10⁴–10⁶ hash nie chroni przed brute-force po
  zrzucie flasha — realną ochroną jest flash encryption (klucz w eFuse,
  nieodczytywalny). Hash chroni przed „casual read" i logami.
- **Okna czasowe i harmonogramy liczone identycznie jak na Edge** — port
  logiki `guest-restrictions.util.ts` (czyste funkcje, łatwe do przepisania
  1:1 do C; te same testy wektorowe po obu stronach). Strefa czasowa: Sentry
  dostaje w snapshotcie prekompilowane reguły offsetów dla Europe/Warsaw
  (przejścia DST na 2 lata w przód) — ESP32 nie ma bazy tz.
- **Limit użyć gości:** lokalny licznik `uses` + snapshot `cloudUses` z Edge —
  ta sama semantyka eventual-consistency co dziś między Edge a Cloud
  (udokumentowane okno niedokładności, akceptowane).
- **Rollback protection:** Sentry odrzuca snapshot z `version` ≤ ostatniego
  zastosowanego (zapis wersji w NVS). Uniemożliwia podstawienie starego
  snapshotu z ważnym wtedy, a odwołanym dziś, PIN-em.
- **Czas:** RTC DS3231 + sync czasu od Edge przy każdym połączeniu (+ NTP
  fallback). Gdy RTC zgłasza utratę czasu (wymiana baterii), Sentry przechodzi
  w tryb degradacji: akceptuje **tylko** resident_pins (bez okien czasowych),
  gości odrzuca z powodem `NO_TIME` — fail-closed dla poświadczeń zależnych
  od czasu.

### 5.1 Kody kryptograficzne dla gości (Faza 3) — weryfikacja bez sync

Problem, którego snapshot nie rozwiązuje: gość utworzony **w trakcie** awarii
Edge/Cloud nie trafi do Sentry. Rozwiązanie: kod weryfikowalny kryptograficznie
bez jakiejkolwiek synchronizacji:

```
kod_gościa (8 cyfr) = truncate8( HMAC-SHA256( K_building,
                        "guest" ‖ bucket_start ‖ bucket_end ) )
```

- `K_building` — 32-bajtowy sekret per budynek, generowany na **Edge**,
  przechowywany TYLKO na Edge i w Sentry (zasada: sekrety nie w chmurze; kto
  generuje kod przy padzie Edge — patrz D5, §13).
- `bucket_*` — okno ważności zaokrąglone do godziny; zaproszenie niesie kod +
  okno; Sentry liczy HMAC dla okna deklarowanego wpisem na klawiaturze
  (UX: `kod` + `#`, urządzenie próbuje bieżące okna ±tolerancja).
- Właściwości: działa dla gościa zaproszonego minutę temu mimo Edge down;
  **nie ma per-gość odwołania** (odwołalny dopiero przez rotację `K_building`)
  — dlatego to kanał AWARYJNY, oznaczony w UI, z krótkimi oknami (≤ 24 h),
  a nie zamiennik normalnych PIN-ów.
- Audyt: Sentry loguje `OFFLINE_CODE_USED` z oknem — po backfillu Cloud
  dopasowuje do zaproszeń po czasie wystawienia.

## 6. Protokół synchronizacji Sentry ↔ Edge

Transport: **WS klient (Sentry) → Edge :4000** (nowy namespace
`/sentry/tunnel`), zabezpieczenie: TLS nie jest praktyczne w LAN bez PKI —
zamiast tego **Noise XX / albo lekki kanał: klucz sesyjny z ECDH na kluczach
prowizjonowanych** (szczegół do rozstrzygnięcia w implementacji; wymóg twardy:
poświadczenia nie latają plaintext po LAN, wzajemna autentykacja
urządzenie↔Edge). Semantyka lustrzana do tunelu Cloud↔Edge:

| Wiadomość | Kierunek | Payload | Analogia istniejąca |
|---|---|---|---|
| `HELLO` | S→E | `{ deviceId, fwVersion, snapshotVersion, nonce }` | STATUS |
| `CRED_SYNC_ALL` | E→S | pełny podpisany snapshot (§5) — **przy każdym reconnect** oraz gdy `snapshotVersion` Sentry ≠ bieżąca | `PLATE_SYNC_ALL` (8.h.25) |
| `CRED_UPSERT` / `CRED_DELETE` | E→S | delta pojedynczego poświadczenia (podpisana, z `version`) | `PIN_UPSERT/DELETE` |
| `TIME_SYNC` | E→S | `{ epochMs, tzRules }` | — |
| `EVENT_BATCH` | S→E | `[{ uuid, seq, ts, kind, credRef, apId, opened, reason }]` | `event_queue` flush |
| `EVENT_ACK` | E→S | `{ uuids[] }` — Sentry kasuje z ring-buffera dopiero po ACK | `ackQueue` |
| `CONFIG_UPDATE` | E→S | hold-time przekaźnika, polityka rate-limit, tryb pracy | `DEVICE_CONFIG_UPDATE` |
| `FIRE` | E→S | `{ apId, durationMs, reqId }` — zdalne otwarcie przez Sentry (AP binding, §10) | `OPEN_DOOR` |
| `OTA_OFFER` | E→S | `{ fwVersion, sha256, url(Edge-local), sig }` | — |

Zasady:

- **Edge jest stroną bierną w pushu do Cloud**: eventy z `EVENT_BATCH` Edge
  wkłada w istniejący mechanizm `tunnelSend`/`event_queue` — Cloud widzi je
  jako te same EVT co dziś (`GUEST_PIN_USED`, `GUEST_ACCESS_USED` z `useId`,
  `GUEST_ACCESS_DENIED`, `RESIDENT_PIN_USED`), z `meta.source='SENTRY'` +
  `meta.sentryDeviceId`. Zero nowych ścieżek w Cloud dla MVP (nowe typy
  eventów tylko dla `OFFLINE_CODE_USED` w Fazie 3).
- **Dedup end-to-end:** `uuid` zdarzenia nadaje Sentry; Edge przekazuje go
  jako `useId`/`dedupKey` — istniejący `ON CONFLICT DO NOTHING` w Cloud
  (`guest_access_uses.dedupKey`) załatwia idempotencję potrójnego retry
  (Sentry→Edge→Cloud).
- **Licznik użyć gościa:** Edge po ingest `EVENT_BATCH` dopisuje do własnych
  `guest_uses` (przez istniejące `store.guestUseRecord` z dedup_key), więc
  limity liczą się spójnie między kanałami (Akuvox PIN + Sentry PIN).
- Reconnect/backoff: identyczna polityka jak Edge→Cloud (expo 2 s→60 s,
  watchdog braku PONG).

## 7. Bufor zdarzeń offline + backfill

- Ring-buffer w LittleFS: rekordy ~64 B, wydzielona partycja 512 kB → ~8 000
  zdarzeń (tygodnie ruchu furtki). Zapis append-only + checkpoint, wear
  leveling z LittleFS; przy przepełnieniu nadpisywane najstarsze **już
  ACK-nięte**, a gdy wszystko nie-ACK — najstarsze w ogóle (z licznikiem
  `dropped` raportowanym w HELLO, żeby utrata była widoczna, nie cicha).
- `seq` monotoniczny per urządzenie (NVS) — Edge wykrywa luki (dowód
  manipulacji lub przepełnienia).
- Po reconnect: Sentry wysyła batchami po 100 (wzorzec flush `SyncService`),
  Edge ACK-uje, dalej standardowa droga do `access_events`.

## 8. Bezpieczeństwo

| Warstwa | Mechanizm |
|---|---|
| Sekrety | tylko Sentry + Edge (zasada projektu). Cloud zna wyłącznie metadane (nazwa, wersja fw, online). `K_building` i klucze kanału nigdy w tunelu Cloud↔Edge ani logach |
| Storage | ESP32 flash encryption (klucz w eFuse) + Secure Boot v2; PIN-y hashowane (HMAC z pepperem urządzenia) |
| Kanał S↔E | wzajemna autentykacja kluczami z provisioning (§10.2), szyfrowanie sesji; odrzucanie wiadomości bez podpisu/z złym `version` |
| Snapshot | podpis Ed25519 kluczem Edge + monotoniczna wersja (anty-rollback) |
| Brute force | rate-limit na urządzeniu: 5 błędnych PIN-ów → lockout 30 s, potem wykładniczo do 5 min; każdy błędny PIN → zdarzenie `PIN_REJECTED` (jak dziś `GUEST_PIN_REJECTED`); lockout liczony per urządzenie, nie per PIN |
| Tamper | styk otwarcia obudowy → zdarzenie `TAMPER` (wysoki priorytet w backfillu) + opcjonalnie dezaktywacja wyjścia przekaźnika do czasu re-arm z panelu |
| Fail-closed | brak snapshotu / zły podpis / utrata czasu → tryb degradacji (§5), nigdy „otwórz wszystkim" |
| OTA | obraz podpisany, dual-partition z automatycznym rollbackiem po nieudanym boot |

## 9. Zasilanie i przekaźnik

- **PoE 802.3af** z switcha przy wejściu / w szafce bramy. Pobór < 2 W
  (klasa 0/1).
- **Rekomendacja instalacyjna (do runbooka):** switch PoE zasilający Sentry
  (i docelowo kamery/domofon) na małym UPS-ie (np. 600 VA) → przy zaniku
  prądu wejście PIN działa dalej. Uwaga: napęd bramy przesuwnej bez prądu i
  tak nie ruszy — priorytet UPS dla **furtki** (zamek elektryczny rewersyjny,
  fail-safe/fail-secure do wyboru zarządcy) + zawsze klucz mechaniczny jako
  ostateczność (wymóg ppoż. niezależnie od nas).
- **Wyjście:** 2× przekaźnik NO/NC/C (styk bezpotencjałowy): #1 → wejście
  „otwórz" sterownika bramy / zamek furtki, #2 rezerwa (oświetlenie, druga
  brama, syrena tamper). Hold-time konfigurowalny (`durationMs`, default
  800 ms — spójnie z `AccessPoint.durationMs`).
- Okablowanie przy wjeździe: Sentry w/przy szafce sterownika bramy
  (równolegle do wyjścia przekaźnika Akuvox/Hikvision, które podłącza dziś
  Edge) — logiczne OR na wejściu sterownika, kanały są niezależne.

## 10. Integracja z platformą

### 10.1 Nowe elementy (bez zmian w istniejących ścieżkach)

- **Edge:** moduł `apps/edge/src/devices/sentry/` — `SentryTunnelGateway`
  (WS server), `SentrySyncService` (budowa snapshotów z istniejących tabel
  `guest_pins`/`resident_pins`/`access_points` — zero nowych źródeł prawdy),
  `SentryEventIngestService` (EVENT_BATCH → `guestUseRecord` + `sendEvent`).
  Nowe tabele SQLite: `sentry_devices` (deviceId, klucze publiczne, fw,
  lastSeen, snapshotVersion), `sentry_provisioning` (kody parowania).
- **Drivery:** wpis w `packages/device-drivers` katalogu (typ `SENTRY`) +
  `SentryOutputDriver` w `OutputDriverRegistry` — gdy Edge żyje, AP może
  używać przekaźnika Sentry przez `FIRE` (Sentry = pełnoprawny output jak
  Akuvox relay / Hikvision ISAPI / LanSwitch / Nuki).
- **Cloud:** Sentry widoczny przez istniejący mirror `DEVICE_UPSERT` →
  `EdgeDeviceMirror` (nowy typ `SENTRY`; hasła/klucze filtrowane jak dziś
  przez `sanitizeDeviceConfig`). Panel Integratora: karta na wzór
  `IntegratorAiEngineCard` — status online/lastSeen/wersja snapshotu/fw,
  licznik zbuforowanych zdarzeń, przycisk „Test przekaźnika" (jak AP_TEST_FIRE).
  AP binding: istniejący ekran „Punkty dostępu" — Sentry pojawia się jako
  urządzenie wyjściowe.
- **Audyt:** `access_events.meta.source='SENTRY'` — filtr w istniejącym
  feedzie; bez zmian schematu w MVP.

### 10.2 Provisioning (wzorzec aktywacji Edge)

1. Integrator w Edge UI: „Dodaj urządzenie → Sentry" → Edge generuje kod
   parowania (TTL 15 min) — analogia kodu aktywacyjnego Edge (GLEX).
2. Sentry świeży (tryb AP Wi-Fi konfiguracyjny albo przycisk serwisowy) →
   instalator podaje IP Edge + kod → wymiana kluczy (Sentry generuje parę,
   wysyła pubkey z kodem; Edge zapisuje i odsyła swój pubkey + `K_building`
   + pierwszy snapshot).
3. Od tej chwili zero konfiguracji ręcznej — wszystko przez sync.

## 11. Roadmapa fazowa

### Faza 0 — Prototyp na biurku (2–3 tyg.) ⏳
Zakupy wg §4.9 (~550 zł). ESP32-POE-ISO + obie ścieżki panelu (Wiegand M2
i matryca+TCA8418 M1) + przekaźnik + DS3231. Firmware szkielet (ESP-IDF):
ETH up, WS klient, LittleFS, wpis PIN → przekaźnik na sztywnej liście.
**DoD:** wpisany PIN otwiera przekaźnik; odcięcie kabla ETH niczego nie
zmienia; zmierzony realny bilans mocy (§4.5) → zamrożenie wyboru pary K×M.

### Faza 1 — MVP: PIN + sync + backfill (4–6 tyg.) ⏳
Pełny protokół §6 (CRED_SYNC_ALL/UPSERT/DELETE, EVENT_BATCH+ACK, TIME_SYNC),
moduł Sentry na Edge, port `guest-restrictions` do C (te same wektory
testowe), ring-buffer, rate-limit, tamper, provisioning §10.2, karta w panelu
Integratora, `SentryOutputDriver`. **DoD:** scenariusz e2e: utwórz gościa w
iOS → PIN działa na Sentry; wyłącz Edge → PIN dalej działa; włącz Edge →
zdarzenia widoczne w `access_events` z `meta.source='SENTRY'`; test na obiekcie
testowym (NIE Villa Natura do czasu decyzji).

### Faza 2 — NFC (2–3 tyg.) ⏳
Dwa poziomy (§4.6): **F2-lite** (panel M2 czyta UID karty — zero nowego
sprzętu, umiarkowane bezpieczeństwo) i **F2-full** (PN5180 + kryptograficzna
autoryzacja DESFire EV3 — wymaga M1/M3). Karty od razu **DESFire EV3**
(rekomendacja D4), żeby przejście lite→full nie wymagało wymiany kart.
Model `nfc_credentials` w Cloud (mieszkaniec ⇄ karta), wydawanie kart
w panelu BA, sync przez ten sam snapshot. **DoD:** karta mieszkańca otwiera
furtkę przy Edge down.

### Faza 3 — Kody kryptograficzne gości (2 tyg.) ⏳
§5.1: `K_building` na Edge+Sentry, generator kodów w flow zaproszenia
(z fallbackiem UI gdy Edge offline — patrz D5), weryfikacja HMAC na
urządzeniu, nowy typ audytu `OFFLINE_CODE_USED`. **DoD:** gość zaproszony
przy wyłączonym Edge wchodzi kodem z zaproszenia.

### Faza 4 — Produkcja małoseryjna (8–12 tyg., równolegle od F2) ⏳
Custom PCB (ESP32-WROOM + PoE PD + RTC + NFC na jednej płytce), dedykowana
obudowa IP65 (front metal/poliwęglan), wariant split RS-485 (D2), badania
CE/EMC (dyrektywa RED jeśli NFC/Wi-Fi aktywne — realny koszt: kilkanaście–
kilkadziesiąt tys. zł w labie), instrukcja montażu do runbooka
instalacyjnego, seria pilotażowa 10–20 szt.

### Ryzyka główne

| Ryzyko | Mitygacja |
|---|---|
| Firmware C/C++ to nowa kompetencja w projekcie (dotąd TS/Swift/Python) | Faza 0 jako spike; alternatywnie ESP-IDF + komponenty gotowe; wariant B (Linux/Node) jako plan B |
| Dryf zegara / utrata RTC → złe decyzje o oknach gości | DS3231 (±2 ppm), TIME_SYNC przy każdym połączeniu, tryb degradacji fail-closed §5 |
| Zrzut flasha ze skradzionego urządzenia | flash encryption + eFuse; PIN-y hashowane; `K_building` rotowalny z Edge |
| Przepełnienie bufora zdarzeń przy długim offline | licznik `dropped` raportowany, sizing 8k zdarzeń ≫ realny ruch |
| CE/RED dla produkcji | MVP = instalacje własne/pilotaż; certyfikacja dopiero w F4 z realnym budżetem |
| „Drugi mózg" rozjedzie się z Edge w logice ograniczeń | jedna specyfikacja + wspólne wektory testowe dla `guest-restrictions` (TS i C), CI porównuje wyniki |

## 12. Co Sentry ZMIENIA w macierzy (stan docelowy po F3)

| Tryb awarii | Mieszkaniec | Gość | Kurier |
|---|---|---|---|
| Cloud down | ✅ PIN/NFC/LPR | ✅ PIN (istniejący) + kod HMAC (nowy gość) | ✅ kod HMAC od mieszkańca / tablica |
| Edge down | ✅ PIN/NFC na Sentry (LPR ❌ — wjazd PIN-em) | ✅ PIN ze snapshotu + kod HMAC | ✅ kod HMAC |
| LAN down | ✅ Sentry autonomiczne (własny styk) | ✅ | ✅ |
| Prąd down | 🟡 UPS na PoE (furtka) + klucz mechaniczny | 🟡 | 🟡 |
| Telefon down | ✅ PIN/karta | ✅ PIN/kod z zaproszenia | ✅ |

Jedyna pozostała twarda zależność: zasilanie (fizyka) — adresowana
rekomendacją UPS + kluczem mechanicznym.

## 13. OTWARTE DECYZJE (dla właściciela)

- **D1 — Kontroler.** Rekomendacja: **K1 — Olimex ESP32-POE-ISO-IND**
  (mrozoodporny −40…+85 °C; budżet 2 W zarządzalny wg §4.5). Alternatywy:
  K2 wESP32 (13 W, zasili rygiel 12 V z PoE — ale zakres temperatur
  niepotwierdzony, wymaga testu mrozowego), K3 ESP32+splitter. RPi i gotowe
  kontrolery odrzucone (§4.1).
- **D2 — Panel wejściowy.** Rekomendacja: **M2 — kupny hermetyczny panel
  Wiegand (klawiatura + czytnik 13,56 MHz, IP66)** + kontroler Sentry
  w puszce po stronie chronionej; panel zasilany 12 V z szafki bramy
  (konsekwencja bilansu mocy §4.5). Naturalny split od MVP; własny panel
  z OSDP (M3) w fazie produkcyjnej. Rekomendowana para: **P1 = K1-IND + M2**
  (§4.8, ~570–680 zł/szt.).
- **D3 — Tryb pracy przy żywym Edge.** Rekomendacja: **always-local** (Sentry
  zawsze waliduje sam; §3 pkt 3). Alternatywa pass-through przez Edge odpada
  (ścieżka awaryjna testowana tylko w awarii = nietestowana).
- **D4 — Standard NFC.** Rekomendacja: karty **DESFire EV3** (~4–8 zł/szt.)
  od pierwszego dnia, w dwóch krokach: F2-lite = odczyt UID przez panel M2
  (wygoda, umiarkowane bezpieczeństwo — UID klonowalny „magic card"),
  F2-full = kryptograficzna autoryzacja EV3 przez PN5180 (M1/M3). MIFARE
  Classic odrzucone (złamany 2008). Do potwierdzenia przy F2.
- **D5 — Generowanie kodów HMAC gdy Edge offline.** `K_building` ma nie
  opuszczać Edge+Sentry. Ale gdy mieszkaniec tworzy gościa w iOS przy
  martwym Edge, Cloud nie zna sekretu i nie wygeneruje kodu. Warianty:
  (a) kod generuje tylko Edge — przy Edge down brak kodów dla NOWYCH gości
  (istniejące PIN-y ze snapshotu działają); (b) kopia `K_building` w Cloud
  szyfrowana kluczem trzymanym w Fly secrets — łamie literę zasady „sekrety
  tylko Edge", ale zamyka scenariusz w 100%. **Rekomendacja: (a) w F3**,
  z możliwością przejścia na (b) świadomą decyzją.
- **D6 — Fallback sync przez LTE prosto z Cloud.** Rekomendacja: **NIE w
  MVP** (koszt modemu+SIM per urządzenie, nowa powierzchnia ataku; snapshot
  ze zdrowego okresu + kody HMAC pokrywają scenariusze). Wrócić, jeśli
  praktyka pokaże wielodniowe awarie Edge.
- **D7 — Zakres pilotażu.** Ile sztuk i które wejścia (propozycja: 1×
  prototyp na biurku → 1× furtka obiektu testowego; Villa Natura dopiero po
  akceptacji i okresie próbnym). Decyzja też: czy Sentry przy wjeździe ma
  być alternatywą dla LPR (PIN dla aut przy padzie Edge) już w MVP.
- **D8 — UX kodów.** Długość kodu HMAC (rekomendacja 8 cyfr + `#`),
  sygnalizacja (LED/buzzer), podświetlenie klawiatury, komunikat „tryb
  awaryjny" (czy urządzenie ma jakkolwiek sygnalizować brak łączności z Edge
  — rekomendacja: dyskretna dioda serwisowa, bez informowania postronnych).

## 14. Następny krok po akceptacji

Po decyzjach D1–D3: zamówienie elementów Fazy 0 (~500 zł), spike firmware
(szkielet ESP-IDF + WS + przekaźnik), równolegle szczegółowa specyfikacja
protokołu §6 (schematy CBOR, wektory testowe `guest-restrictions`). Żadnych
zmian w produkcyjnym kodzie do czasu zakończenia Fazy 0.
