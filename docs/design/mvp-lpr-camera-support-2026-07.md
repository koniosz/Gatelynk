# MVP: wsparcie kamer LPR — instalacja z „niewiadomymi" kamerami (2026-07)

**Kontekst.** Pierwsza instalacja MVP: 4 kamery — 2× Hikvision DeepinView
(iDS-2CD7A46G0/P-IZHSY, jak na produkcji Villa Natura — działają) + 2×
**znacznie starsze kamery, model nieznany** (właściciel sprawdzi u klienta).
Instalacja startuje **bez serwera AI** (YOLO/EasyOCR niedostępne — brak
brand-detection i OCR napisów; LPR z kamer ANPR działa niezależnie od AI).

Dokument: (1) audyt założeń sterownika, (2) matryca wsparcia scenariuszy,
(3) ścieżka degradacji „tylko podgląd", (4) narzędzie `lpr-camera-probe`,
(5) pytania do klienta, (6) ryzyka i TODO Cloud.

---

## 1. Audyt sterownika — twarde zależności od firmware

Sterownik: `apps/edge/src/devices/cameras/` (hikvision-lpr.service,
lpr-events.controller + **nowy** anpr-xml-parser, cameras.service).

### Model działania (ważne!)

Edge **NIE polluje** kamery i **NIE używa alertStream**. Model jest
push-based: kamera POST-uje event ANPR (XML/multipart) na
`http://<EDGE>:4000/events/lpr/hikvision/:deviceId`. Edge przy rejestracji
kamery best-effort konfiguruje przez ISAPI:

1. `PUT /ISAPI/Event/notification/httpHosts/1` — rejestracja Edge jako
   odbiorcy eventów (host = auto-detect IP Edge w tym samym /24 co kamera;
   override: env `EDGE_PUBLIC_HOST=ip:port`).
2. `GET/PUT /ISAPI/Event/triggers/{VehicleDetect-1|vehicleDetect-1|VehicleDetect|ANPR-1|anpr-1}`
   — dopięcie „Notify Surveillance Center" do triggera ANPR.

### Twarde założenia (co musi spełniać kamera dla pełnego LPR)

| # | Założenie | Gdzie w kodzie | Co gdy nie spełnione |
|---|-----------|----------------|----------------------|
| 1 | Hikvision ISAPI (XML) | cały hikvision-lpr.service | inna marka = zero LPR (endpoint eventów jest Hikvision-only) |
| 2 | ANPR on-camera (ASIC) + push eventów z tablicą | model biznesowy „kamera=detektor" | kamera bez ANPR nigdy nie POST-uje → cisza, brak odczytów |
| 3 | HTTP host notification (`/ISAPI/Event/notification/httpHosts`) | `configureEventListener` | eventy trzeba skonfigurować ręcznie w panelu WWW kamery |
| 4 | Digest auth (Basic fallback), login domyślny `admin` | `http-digest.ts`, `user()` | 401 → auto-config i snapshot padają (logi warn) |
| 5 | ISAPI po **HTTP** (port z `httpPort`, default 80) | `baseUrl()` — tylko `http://` | kamera HTTPS-only → auto-config LPR nie zadziała (snapshot w CamerasService próbuje też https) |
| 6 | Format eventu: `<EventNotificationAlert>` + `<ANPR><licensePlate>` | `anpr-xml-parser.ts` | po refactorze 2026-07: tolerancja na ver10/ver20/std-cgi namespace, prefiksy NVR, tagi `plate`/`plateNumber`/`originalLicensePlate`, float confidence, JPEG jako octet-stream |
| 7 | Pola vehicle* (kolor/marka/typ) opcjonalne | parser → `handleAnprEvent(extra?)` → `lprInsertRead` (wszystkie kolumny nullable) | starszy firmware bez vehicleInfo → pola NULL, odczyt działa |
| 8 | Trigger ID z listy 5 kandydatów | `ensureAnprTriggering` | inne ID → `no_vehicle_detect_trigger`, ręczne „Notify Surveillance Center" w panelu kamery (komunikat w logu + event-log) |
| 9 | Próg pewności: `/ISAPI/Traffic/channels/{ch}/vehicleDetect` (V5.6+) lub `/ISAPI/Smart/Vehicle/{ch}/vehicleDetect` (V5.7+) | `setConfidence` | starszy firmware 404 na obu → `set:false`, próg tylko w panelu kamery |
| 10 | Snapshot: `/ISAPI/Streaming/channels/{1,101}/picture` | `augmentWithLiveSnapshotIfSmall`, CamerasService | brak → zostaje plate-crop z eventu albo brak zdjęcia (odczyt przeżywa) |
| 11 | `<vehicleLogoRecog>` = numeryczne ID marki (DeepinView V5.7+) | `hikvision-vehicle-brands.ts` | starsze firmware: brak pola → brand NULL (OK) |
| 12 | Whitelista w SQLite Edge (NIE wgrywana do kamery) | architektura edge-only | zaleta: działa z KAŻDĄ kamerą która odda samą tablicę |

**Wniosek z produkcji (probe 2026-07-05):** nawet na działającej
iDS-2CD7A46G0 V5.8.61 lista `/ISAPI/Event/triggers` NIE zawiera triggera
VehicleDetect — ANPR skonfigurowano przez panel WWW. `ensureAnprTriggering`
jest best-effort i tak trzeba traktować: ręczna konfiguracja w panelu kamery
to normalna część instalacji, nie awaria.

### Co się posypie na starszym Hikvision Z ANPR (np. DS-2CD4A26FWD, iDS-TCM/TCG V5.3–5.6)

- ~~inny namespace / brak pól vehicle*~~ → **załatwione** (parser-tolerancja, testy `tools/test-anpr-parser.ts`, 32 asercje)
- `ensureAnprTriggering` może nie trafić w trigger ID → ręczne „Notify
  Surveillance Center" (Configuration → Event → Smart Event / Road Traffic)
- `setConfidence` może zwracać 404 → próg ustawiać w panelu kamery
- starszy firmware bywa czuły na PUT httpHosts w formacie v2 → jeśli 4xx,
  wpisać HTTP listening host ręcznie w panelu (Notification → HTTP Listening)
- ANPR w bardzo starych buildach wysyła tylko plate-crop JPEG →
  `augmentWithLiveSnapshotIfSmall` dociąga pełną scenę przez ISAPI (działa
  jeśli snapshot endpoint żyje)

### Co się posypie na Hikvision BEZ ANPR (DS-2CD2xxx itd.)

- kamera **nigdy nie POST-uje** eventu z tablicą — po prostu cisza
- jeśli ktoś doda ją jako LPR_CAMERA: logi `no_vehicle_detect_trigger`,
  zakładka Odczyty pusta → **rejestrować jako CAMERA** (werdykt probe:
  TYLKO PODGLĄD)

### Inna marka (Dahua / Axis / generic ONVIF)

- LPR: **nie działa w ogóle** (parser i endpoint są Hikvision-only;
  Dahua ma osobny driver LPR w katalogu, ale bez ścieżki eventów na Edge)
- Podgląd: działa — CamerasService ma ścieżki snapshot dla
  Dahua (`/cgi-bin/snapshot.cgi`), Axis (`/axis-cgi/jpg/image.cgi`) +
  generyczny `/snapshot.jpg`; RTSP przez ffmpeg działa markowo-agnostycznie
- ONVIF **nie jest zaimplementowany** (brak stacka) — „ONVIF-compatible"
  na pudełku nam nic nie daje poza nadzieją na standardowe RTSP

---

## 2. Matryca wsparcia — scenariusze na dzień instalacji

Legenda: ✅ działa · 🟡 działa z ręczną konfiguracją · ❌ nie działa

| Scenariusz | Tablice (LPR) | Otwieranie bramy | Podgląd/snapshot | Zdarzenia w audycie | Co trzeba zrobić |
|---|---|---|---|---|---|
| **DeepinView nowy** (V5.7/5.8, iDS-2CD7A46G0 — jak Villa Natura) | ✅ | ✅ (AP-link, multi-AP) | ✅ | ✅ LPR_MATCH/NO_MATCH | Dodać jako LPR_CAMERA, sprawdzić `camera-setup`, ewent. „Notify Surveillance Center" w panelu |
| **Stary Hikvision Z ANPR** (DS-2CD4A26FWD, iDS-TCM/TCG, V5.3–5.6) | ✅/🟡 | ✅ (jak wyżej — whitelist na Edge) | ✅ | ✅ | Probe → LPR_CAMERA; niemal na pewno ręczna konfiguracja triggera+HTTP host w panelu kamery; pola marka/kolor będą puste (parser to znosi) |
| **Hikvision BEZ ANPR** (DS-2CD2xxx, ColorVu — potwierdzone probem na 192.168.1.165 V5.5.160) | ❌ | ❌ (z tej kamery) | ✅ (ISAPI picture + RTSP) | 🟡 tylko podgląd, bez zdarzeń wjazdu | Dodać jako **CAMERA** (rola STANDARD), przypiąć do AP jako podgląd; UI mówi wprost „bez LPR (tylko podgląd)" |
| **Inna marka (Dahua/Axis)** | ❌ | ❌ | ✅ (dedykowane ścieżki snapshot + RTSP) | 🟡 jw. | Dodać jako CAMERA z właściwym manufacturer; sprawdzić RTSP probem |
| **Nieznana marka / brak dostępu** | ❌ | ❌ | 🟡 (jeśli odda RTSP/JPEG) | ❌ | Probe → jeśli NIEKOMPATYBILNA: reset hasła u klienta albo wymiana; minimum to RTSP |

**Bez serwera AI (stan MVP):** brand-detection, OCR napisów (kurierzy),
waste-detection i podsumowania Vision **nie działają** — to funkcje
`vision-detect` + `yolo-vision`, niezależne od LPR. LPR z kamer ANPR
(tablice → whitelist → brama) działa w 100% bez AI. W panelu Integratora
AI Engine zostawić `enabled=false` (kaskada wyłączy zależne features).

---

## 3. Ścieżka degradacji: kamera „tylko podgląd"

Co JUŻ działa (zweryfikowane w kodzie, 2026-07-05):

- **Rejestracja w Edge jako CAMERA** — wizard Edge UI ma typ „Kamera IP"
  (drivery: hikvision-camera, dahua-camera); `DeviceRegistryService`
  rejestruje tylko w `CamerasService` (bez LPR).
- **Snapshot** — `CamerasService.getSnapshot` (digest, http→https fallback,
  ścieżki per manufacturer); Edge UI: DeviceCard thumb, test urządzenia,
  MJPEG live stream (`pipeVideoStream`, ffmpeg RTSP→MJPEG).
- **Cloud panel** — tunnel CMD `CAMERA_SNAPSHOT` istnieje
  (tunnel.service.ts:257); rola `STANDARD` w Cloud od 8.h
  (`LprCamera.role`, `IntegratorCameraSettingsCard`, CAMERA_SYNC_ALL).
- **Komunikacja „nie czyta tablic"** — dobudowane: dropdown kamer w
  Edge UI `LprReadsPage` oznacza urządzenia typu CAMERA jako
  „— bez LPR (tylko podgląd)".

Czego brakuje (TODO Cloud — **nie ruszane**, apps/api + apps/web robią inni):

1. **BA/Integrator: podgląd snapshot dla kamery STANDARD.** Strona devices
   BA pokazuje status/ping/restart, ale nie ma przycisku „Podgląd" —
   dodać wywołanie CMD `CAMERA_SNAPSHOT` przez tunnel (payload
   `{deviceId}` → base64 JPEG) dla kamer `role=STANDARD` i LPR.
2. **Przypięcie kamery-podglądu do punktu dostępu w Cloud.** Model
   `LprCameraAccessPointLink` służy do fire-ów LPR; dla kamery STANDARD
   potrzebny analogiczny link „preview" (rekomendacja: to samo połączenie,
   ale executor NIE fire-uje gdy `role=STANDARD` — dziś Edge i tak nie
   dostanie eventu, więc ryzyka brak; chodzi o UI: karta AP pokazuje
   miniaturę z przypiętej kamery).
3. **Etykieta w panelu BA**: przy kamerze `role=STANDARD` pokazać wprost
   „Ta kamera nie czyta tablic — tylko podgląd" (integrator ma dropdown
   roli, BA nie widzi nic).

---

## 4. Narzędzie: `apps/edge/tools/lpr-camera-probe.ts`

Read-only (same GET-y + RTSP OPTIONS), zero zależności npm, uruchamialne
gołym node ≥ 22.18 (Edge ma v22.22.2 ✓):

```bash
node lpr-camera-probe.ts --ip 192.168.1.64 --user admin --pass 'Haslo!'
# opcje: --port 80 --rtsp-port 554 --channel 1 --listen 8 (sek. alertStream, 0=pomiń) --json
```

Sprawdza: deviceInfo (model/fw/serial) → ANPR config (2 ścieżki ISAPI) →
Event/triggers → httpHosts → snapshot (ISAPI + Dahua + generic) → RTSP
OPTIONS → opcjonalny nasłuch alertStream. Werdykty:

- **PEŁNY LPR** → rejestruj jako LPR_CAMERA
- **LPR MOŻLIWY (ręczna konfiguracja)** → ANPR jest, httpHosts nie — panel kamery
- **TYLKO PODGLĄD** → rejestruj jako CAMERA
- **BRAK DOSTĘPU** → złe hasło (uwaga: Hikvision blokuje konto po ~5 próbach)
- **NIEKOMPATYBILNA** → nic nie odpowiada

Zweryfikowane na produkcji Villa Natura (2026-07-05):
`iDS-2CD7A46G0/P-IZHSY V5.8.61` → **PEŁNY LPR**;
`DS-2CD2087G2-L V5.5.160` (ColorVu, bez ANPR) → **TYLKO PODGLĄD** —
oba werdykty zgodne ze stanem faktycznym.

Testy parsera: `pnpm --filter @gatelynk/edge build && node apps/edge/tools/test-anpr-parser.ts`
(32 asercje na 8 wariantach firmware — musi być zielone przed deployem
zmian w `anpr-xml-parser.ts` / `lpr-events.controller.ts`).

---

## 5. Pytania do właściciela / klienta PRZED instalacją

1. **Model z tabliczki** obu starych kamer (naklejka na obudowie/spodzie:
   `DS-…` / `iDS-…` + wersja). Zdjęcie tabliczki wystarczy.
2. **Marka** — czy na pewno Hikvision? (logo na obudowie; jeśli Dahua/inne —
   od razu wiadomo że tylko podgląd).
3. **Dostęp admin**: login + hasło do panelu WWW kamer. Jeśli hasło
   nieznane — czy klient zgadza się na **hard reset** kamery (przycisk
   RESET ~10 s przy zasilaniu; konfiguracja przepada)?
4. **Firmware** — jeśli jest dostęp do panelu: Configuration → System →
   Device Information (screenshot).
5. **Czy w menu kamery istnieje** cokolwiek z: „Road Traffic", „Smart
   Event → Vehicle Detection", „ANPR"? (jest = kamera ma ANPR).
6. **Sieć**: czy stare kamery są w tym samym LAN/VLAN co przyszły Edge?
   Statyczne IP czy DHCP? (Edge auto-detect zakłada wspólny /24 — inaczej
   trzeba `EDGE_PUBLIC_HOST`).
7. **Zasilanie/okablowanie**: PoE ze switcha czy zasilacze lokalne?
8. **Gdzie patrzą** stare kamery — na wjazd (kandydat na LPR jeśli mają
   ANPR) czy ogólny plac (podgląd wystarczy)?
9. Czy klient akceptuje scenariusz, w którym stare kamery dają **tylko
   podgląd** (bez automatycznego otwierania bramy) do czasu ewentualnej
   wymiany?

## 6. Ryzyka

- **Stare kamery mogą w ogóle nie mieć ANPR** — wtedy MVP ma tylko 2 punkty
  LPR (DeepinView). Ustalić z klientem PRZED instalacją które wjazdy
  dostają automatyczne otwieranie.
- **Zablokowane konto admin** po próbach zgadywania hasła (Hikvision lockout
  ~30 min) — nie brute-forcować na miejscu, użyć probe raz z poprawnymi
  danymi.
- **Firmware V5.3-** miewa uszkodzone/niepełne ISAPI — probe pokaże,
  ale konfigurację eventów robić przez panel WWW.
- **HTTPS-only ISAPI** (wymuszone w security settings) — auto-config LPR
  używa tylko http; workaround: włączyć HTTP w panelu kamery (LAN-only, za
  NAT-em — akceptowalne).
- **Brak AI**: nikt nie powinien obiecywać klientowi rozpoznawania kurierów
  / napisów / podsumowań — to wymaga serwera AI (Mac Studio / MacBook),
  którego w MVP nie ma.
- **UNKNOWN reads**: kamera ANPR przy nieczytelnej tablicy wysyła
  `licensePlate=unknown` — Edge celowo to loguje (odczyt + snapshot,
  bez otwierania). Na starszych kamerach z gorszą optyką będzie tego
  więcej — to nie bug.
