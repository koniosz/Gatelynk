# VN — runbook drugiej instalacji produkcyjnej

> ## ⚠️ ZMIANA ZAKRESU (Konrad, 2026-07-30, po powstaniu runbooka)
> **Dzwonienie stacja→mieszkaniec zostaje NATYWNIE w Akuvox (SmartPlus)** —
> GateLynk NIE obsługuje rozmów przychodzących na starcie VN. Z aplikacji
> GateLynk potrzebne są tylko: **(a) podgląd kamery domofonu, (b) rozmowa
> WYCHODZĄCA apka→stacja, (c) otwieranie elektrozaczepów.**
> Konsekwencje dla faz:
> - F0.10 Janus: **ZOSTAJE** (rozmowa wychodząca go wymaga) + turnUrl SQL
>   (LTE) — bez zmian.
> - F2: **POMIJAMY** Remote Phonebook / Directory Sync / routing per-lokal /
>   VoIP push. R29 konfigurowane pod SmartPlus przez Akuvox/klienta.
>   **PreventSIPHacking=0 NADAL OBOWIĄZKOWE** (inaczej INVITE z Janusa przy
>   rozmowie wychodzącej dostaje 488) + Auto-Answer ON (apka dzwoni, stacja
>   auto-odbiera) + Direct IP 5060 accept. `bridgeEnabled=true` na stacjach
>   (wybór stacji w apce).
> - Checklist odbiorowy: pozycje „rozmowa przychodząca / push / phonebook"
>   NIEAKTUALNE; zostaje: podgląd + rozmowa wychodząca z KAŻDEJ z 3 stacji
>   (WiFi i LTE) + otwarcie zaczepu z apki i z rozmowy.
> - Directory Sync v2 / kontakty na ekranie: wraca, gdyby klient zrezygnował
>   ze SmartPlus (infrastruktura gotowa; uwaga na contactAuthority=SMARTPLUS).
>
> ## ✅ Mac Mini VN GOTOWY (2026-07-31) — F0.7–F0.11 wykonane zdalnie
> Sprzęt: Mac mini M1 8 GB, **macOS 26.6** (po czystej instalacji), konto
> `gatelynkvn`, hostname `gatelynk-edge-vn`, Tailscale **100.90.0.42**
> (LAN podczas przygotowania: 192.168.1.114 — **ZMIENI SIĘ na obiekcie!**).
> Dostęp: `ssh vn` (alias w ~/.ssh/config laptopa) + pulpit `vnc://100.90.0.42`.
> - system: `pmset sleep 0 disksleep 0 autorestart 1`; ⚠️ **auto-login konta
>   MUSI być włączony** (bez tego launchd user-agents nie wstaną po restarcie).
> - Xcode CLT, Homebrew 6.0.13, Node 22 (nvm, `~/.nvm/versions/node/v22.23.2`).
> - **Edge**: `~/gatelynk-edge` (dist+public+web/dist, scrubbed package.json,
>   `@gatelynk/device-drivers` wgrany PO `npm install` — pułapka #9), launchd
>   `com.gatelynk.edge` z `MACHINE_ID=gatelynk-edge-vn`,
>   `INTERCOM_CALL_ENABLED=true`, `JANUS_HTTP_URL`. Stan: **nieaktywowany**
>   (czeka na kod GLEX). pm2 czysty (brak konkurentów o :4000).
> - **Janus 1.4.2 ze źródeł** (`~/src/janus-gateway`): oba patche nałożone
>   (port SIP 5060 + macOS connect socklen), `configure` z `SIP Gateway: yes` +
>   `REST HTTP: yes`. ⚠️ **CFLAGS obowiązkowe**: `export CFLAGS=-I/opt/homebrew/include`
>   (bez tego `fatal error: 'stun/usages/bind.h' file not found` — pkg-config
>   libnice podaje tylko `include/nice`). Brakująca formuła: `libconfig`.
>   Certy DTLS: `/opt/homebrew/etc/janus/certs/` (ścieżka z `janus.jcfg`,
>   NIE `share/janus/certs` z README). launchd `com.gatelynk.janus`.
> - **TURN w janus.jcfg ODKOMENTOWANY OD RAZU** (turn_user `2097208599:janusvn`,
>   HMAC z prod `TURN_STATIC_SECRET`) — lekcja Villa Natury: zakomentowany TURN
>   = cisza na LTE. Boot-log potwierdza `TURN server to use: 91.99.212.240:3478`.
> - **Weryfikacja**: Edge `:4000` 200 (nieaktywowany), Janus `:8088` HTTP,
>   `SIP registered: edge`, **`192.168.1.114:5060` UDP LISTEN**.
> - strażnik `com.gatelynk.aihealth` (`~/gatelynk-health`) — na start pilnuje
>   TYLKO Edge `:4000`; checki AI dopisać przy dopinaniu kamer.
>
> ### ⚠️ DO ZROBIENIA NA OBIEKCIE (zmiana LAN IP!)
> Po wpięciu w sieć VN zaktualizować w `/opt/homebrew/etc/janus/janus.plugin.sip.jcfg`:
> `local_ip` i `local_media_ip` na NOWY LAN IP Edge, potem restart **Janus → Edge**
> (kolejność obowiązkowa). Zalecana rezerwacja DHCP/statyczny IP dla Mac Mini.
> Uwaga: szablon w repo ma zaszyte 192.168.1.127 (Villa Natura) — hardcode do
> uszablonowania.
>
> ## Status wykonania F0 (2026-07-30)
> - [x] F0.1 Building: **Osiedle VN, ul. Komfortowa 1** — building **#11**
> - [x] F0.2 objectType HOUSING_ESTATE (has_concierge=false, delivery_to_door)
>   + permissions: AI OFF (kaskada), **payments ON**, reservations/parcels OFF
> - [x] F0.4 Konto BA: garymuwaut@gmail.com (id 9, „Konrad (VN)")
> - [ ] F0.3 lokale (przez CSV w F4), F0.5 GLEX (dzień przed wyjazdem),
>   F0.6 CSV mieszkańców, F0.7–F0.11 Mac Mini (Konrad na miejscu → potem
>   zdalna instalacja Edge/Janus/aihealth po Tailscale)

> Wersja: 2026-07-30 (audyt + plan; agent). Kodowa nazwa obiektu: **VN**.
> Sprzęt: dedykowany **Mac Mini** (nowy Edge), **3× Akuvox R29** (Wjazd, Wyjazd,
> Brama garażowa), **2× Hikvision DS-2CD4A26FWD-IZS** (LPR Wjazd + Wyjazd),
> AI: **współdzielony Mac Studio M4 Max** (Tailscale `100.99.26.17`) — kamery
> do OCR/AI dopinane PÓŹNIEJ, **start bez AI**. Mieszkańcy: 5–10 realnych
> testowych z aplikacją **GateLynk Glass** (prod).
>
> Dokumenty bazowe: `docs/design/mvp-runbook-instalacja.md` (generyczny dzień
> instalacji), `docs/design/mvp-lpr-camera-support-2026-07.md` (WS-B, matryca
> kamer), `docs/design/onboarding-instalacja-budynku-2026-07.md` (design PR-1..11),
> `docs/akuvox-directory-v2-installer.md` (Directory Sync v2, 12 kroków),
> `docs/intercom-akuvox-call.md`, `docs/exit-grace-pass.md`,
> `infra/intercom/janus/README.md`, `apps/edge/install/README.md`,
> CLAUDE.md pułapki #9–#11 (deploy Edge) i #19 (domofon).
>
> **Twarda zasada:** Villa Natura (b9) to produkcja referencyjna — żaden krok
> poniżej nie dotyka jej Edge'a, urządzeń ani danych.

---

## 0. AUDYT GOTOWOŚCI PLATFORMY (stan na 2026-07-30, zweryfikowane w kodzie)

### 0.1 Multi-tenant: drugi Building + drugi Edge — ✅ GOTOWE

| Obszar | Stan | Dowód w kodzie |
|---|---|---|
| Aktywacja Edge kodem `GLEX-XXXX-XXXX-XXXX` (jednorazowy, TTL) | ✅ | `apps/api/src/edge/edge.service.ts` (`generateActivationCode` ~:299), `POST /api/edge/activate` |
| Throttle aktywacji (PR-1) — stały czas odpowiedzi + limit prób/IP | ✅ | `apps/api/src/edge/activation-throttle.service.ts`, `edge.controller.ts:37` |
| PIN Edge UI (PR-2) | ✅ | ekran Ustawienia Edge UI; PIN w kv (`ui.pinHash`) |
| Readiness endpoint + badge (PR-3/4) | ✅ | `apps/api/src/integrator/readiness.service.ts` — checki: Edge online, urządzenia, AP binding + test 7 dni, LPR linki + ostatni LPR_MATCH, BA, lokale, mieszkańcy aktywowani, zaproszenia; `skip` dla konsjerża/AI gdy wyłączone |
| Setup-hub (WS-C) | ✅ | `apps/web/src/app/(integrator-dashboard)/integrator/buildings/[id]/setup/` (+ `import/`, `invitations/`) |
| Import CSV mieszkańców | ✅ | `apps/api/src/residents-import/` (csv-parser, dry-run, idempotencja, `no-email.constants.ts`) |
| Zaproszenia e-mail (Resend) + accept-page | ✅ | `apps/api/src/invitations/` + strona `/accept-invitation`; bez `RESEND_API_KEY` → przycisk „link" do ręcznego kopiowania |
| Izolacja multi-tenant | ✅ testy | `apps/api/test/multi-tenant-isolation.e2e-spec.ts` (5 testów) + tenant-guardy (`adminId`/`buildingIds`) w serwisach |
| Sync Cloud↔Edge przy reconnect | ✅ | `EdgeGateway.pushAccessPointSync`: AP/SCHEDULE/LPR_LINK/CAMERA/PLATE/RESIDENT_PIN/**INTERCOM**_SYNC_ALL + outbox (Faza 7.6) |

### 0.2 Domofony — multi-station (WS-A) — ✅ GOTOWE dla 3 stacji

- **Rejestr stacji**: Cloud `building_intercoms` → CMD `INTERCOM_SYNC_ALL`
  (replace-all, `apps/api/src/integrator/integrator.service.ts:320-346`) → Edge
  sqlite `intercom_bridge` (`apps/edge/src/tunnel/tunnel.service.ts:545`).
  Model danych nie ogranicza liczby stacji — 3× R29 wchodzi bez zmian.
- **Wybór stacji w apce**: `GET /api/resident/intercom/stations` +
  `POST /api/resident/intercom/call-station {intercomId}`; przy >1 stacji bez
  wyboru → `STATION_CHOICE_REQUIRED` z listą (`apps/api/src/resident/
  intercom-call.service.ts:438+`). Glass ma picker (`GlassGateSheet`/`GlassHomeView`).
- **Busy**: 1 uchwyt SIP Janusa = **1 rozmowa na budynek naraz**. Cloud busy-guard
  (sesje INCOMING/RINGING/ACTIVE, okno 10 min) → 409 `STATION_BUSY`; Edge łapie
  race (`INTERCOM_STATION_BUSY`, `intercom-call.service.ts:258-263`). Świadome
  ograniczenie — wystarczy na osiedle; NIE obiecywać rozmów równoległych.
- **Brama garażowa** = trzecia stacja + osobny AccessPoint (przekaźnik R29,
  relay 0/1 → DoorNum 1/2). AP-y są per przekaźnik — model pokrywa. ⚠️ Przycisk
  „Otwórz" NA EKRANIE ROZMOWY wyzwala zawsze **relay 0 stacji, z którą trwa
  rozmowa** (`intercom-snapshot.controller.ts:125`) — z rozmowy na „Wjeździe"
  nie otworzysz garażu; garaż z apki działa normalną ścieżką AP (kafel).
- **Przychodzące**: dialedExtension → unit → mieszkańcy lokalu (fallback-all
  dla fizycznego przycisku); Remote Phonebook endpoint per budynek (0.3).
- ⚠️ **KRYTYCZNE przy 3 stacjach — wypełnić `ipAddress` I `edgeDeviceId` dla
  KAŻDEJ stacji w `building_intercoms`.** Fallbacki Edge zakładały 1 panel:
  `resolveAkuvoxIp` (outbound) przy braku dopasowania bierze „pierwszy INTERCOM
  z IP" → wybór „Garaż" może zadzwonić na „Wjazd"; `resolveStationByIp`
  (incoming) przy >1 stacji bez matcha IP → fallback-all bez nazwy stacji
  (cicha degradacja, tylko warn w logu). Rezerwacje DHCP dla R29 obowiązkowe.

### 0.3 Znane pułapki R29 z produkcji (OBOWIĄZKOWE przy każdej stacji)

1. **`PreventSIPHacking=0`** (Account → Advanced → odznacz „Prevent SIP Hacking")
   — inaczej INVITE od Janusa dostaje **488** i rozmowy wychodzące padają.
   Dotyczy każdego R29 spiętego ze SmartPlus. Probe bez telefonu: `r29probe.py`
   (INVITE G.711; 200=OK, 488=blocker).
2. **Direct IP włączony, port 5060** (Intercom → Basic → Direct IP).
3. **Przycisk fizyczny**: Key Setting → **Number = LAN IP Edge VN** (samo IP).
4. **Auto Answer ON** (Intercom → Call Feature; Mode=Video, Delay=0) — wymagane
   dla rozmów WYCHODZĄCYCH apka→stacja (stacja musi odebrać INVITE Janusa).
5. **Remote Phonebook per budynek**: `https://gatelynk-api.fly.dev/api/intercom/
   phonebook?b=<buildingId>&t=<token>&host=<LAN-IP-Edge-VN>` — token statyczny
   per budynek: `HMAC-SHA256(JWT_SECRET, "phonebook:<buildingId>")` hex[0:24]
   (`IntercomPhonebookController.tokenFor`). **NIE kopiować tokenu b9.**
   `host` MUSI być LAN IP Edge VN (nie Tailscale!).
6. **Firmware: od startu 29.30.10.465 LTS.** Na 29.30.10.128 importer kontaktów
   jest ZEPSUTY (odrzuca nawet własny eksport) — na .128 działa tylko Remote
   Phonebook. Na 465 działa import template'u przez **Directory Sync v2**
   (panel Integratora; template MUSI pochodzić z realnego eksportu urządzenia
   o tej parze model+firmware — procedura 12 kroków w
   `docs/akuvox-directory-v2-installer.md`).
7. **Hasło API ≠ hasło web**: digest/RTSP/OpenDoor używa `rtspPassword ?? 'admin'`.
   High Security Mode → działa TYLKO `https://<ip>/fcgi/OpenDoor?action=OpenDoor&
   DoorNum=<relayIndex+1>` (obsłużone w `intercom.service.openDoor`).
8. **Action URL** (PIN-y/keypad): `http://<edge-vn>:4000/akuvox/event`.
9. **„Open Relay via HTTP" jest fabrycznie WYŁĄCZONE** (OpenDoor → 503), a hasło
   API bywa nieustawione (szybki snapshot 401 → wolny fallback RTSP ~900 ms) —
   włączyć/ustawić na KAŻDEJ z 3 kaset, inaczej „Otwórz" nie działa mimo
   poprawnych logów Edge.
10. Opcjonalne zawężenie po wyłączeniu PreventSIPHacking: CallFeature
    AllowedIPList = IP Edge VN.

### 0.4 Nowy Edge od zera (Mac Mini) — procedura ISTNIEJE, ale jest RĘCZNA

- launchd: `apps/edge/install/com.gatelynk.edge.plist` + README. **UWAGA:
  szablon plist w repo NIE zawiera env `MACHINE_ID` ani `INTERCOM_CALL_ENABLED`
  — trzeba dodać PlistBuddy (F0.9).** `MACHINE_ID` jest krytyczny: klucz
  szyfrowania kv derywowany z env **albo hostname** (`apps/edge/src/store/
  store.service.ts:115-119`) — zmiana hostname (DHCP/Bonjour!) bez MACHINE_ID
  = utrata tokenu tunelu („tunnel standby", pamięć `reference_edge_machineid_gotcha`).
- **Janus ze źródeł** (brew nie ma formuły): `infra/intercom/janus/README.md` +
  **2 patche obowiązkowe**: (a) port SIP `:*`→`:5060` w `janus_sip.c`,
  (b) `infra/intercom/janus/janus_sip_macos_connect_fix.patch` (długość
  `connect()` na macOS — bez niego BRAK audio telefon→domofon). Re-aplikować po
  każdym `make clean`/reinstalacji.
- **sip-proxy: POMIJAMY dla VN.** To rejestrator dla **E18** (tenant dzwoni przez
  konto SIP). R29 z Remote Phonebook dzwoni URI `<unit.id>@<host>` direct-IP —
  proxy zbędne. (Fallback gdyby direct-dial z listy nie działał na sprzęcie:
  postawić sip-proxy jak w `infra/intercom/sip-proxy/README.md`, konto `door` na
  R29, Preferred SIP Server = Edge:5062.)
- **coturn**: ISTNIEJĄCY `turn.gatelynk.com` (91.99.212.240) obsłuży oba osiedla
  — TURN jest per-sesja (HMAC z `TURN_STATIC_SECRET`), nie per-budynek. Per
  budynek ustawiamy tylko `building_intercoms.turnUrl='turns:turn.gatelynk.com:443?transport=tcp'`
  + `bridgeEnabled=true`. ⚠️ **`turnUrl`/`turnUsername`/`turnPassword` NIE mają
  żadnego settera w UI ani API** (panel Integratora edytuje tylko name/ip/sip/
  bridgeEnabled) — dla VN wpisać **ręcznym SQL-em** na prod DB (jak przy b9).
  Cloud bierze PIERWSZĄ stację z `bridgeEnabled=true AND turnUrl IS NOT NULL` —
  wystarczy jedna, ale dla czytelności ustawić na wszystkich 3.
  **Janus VN** też musi mieć `turn_*` w swojej `janus.jcfg` (długożyciowy cred
  HMAC — pułapka #19: bez tego cisza na LTE). ⚠️ **Snippet w repo
  `infra/intercom/janus/janus.jcfg` ma `turn_*` ZAKOMENTOWANE** (nigdy nie
  zaktualizowany po naprawie 2026-07-29) — kopiowanie 1:1 odtwarza bug
  „WiFi OK / LTE cisza". Po instalacji: `grep turn_ janus.jcfg` + boot-log.

### 0.5 LPR — stare kamery (WS-B) — ✅ POKRYTE, wymaga probe + ręcznej konfiguracji

- Model push-based: kamera POST-uje ANPR na
  `http://<edge>:4000/events/lpr/hikvision/:deviceId`; Edge best-effort
  konfiguruje `httpHosts` + trigger przez ISAPI (`apps/edge/src/devices/cameras/
  hikvision-lpr.service.ts`).
- **DS-2CD4A26FWD-IZS jest wprost w matrycy WS-B** („Stary Hikvision Z ANPR,
  V5.3–5.6": ✅/🟡): parser `anpr-xml-parser.ts` toleruje stare namespace'y/pola
  (32 asercje w `apps/edge/tools/test-anpr-parser.ts`), whitelista żyje na Edge
  (kamera nie musi jej wspierać), pola marka/kolor będą NULL (OK).
- **Do zrobienia na sprzęcie (nie w kodzie):** probe
  `apps/edge/tools/lpr-camera-probe.ts`; niemal na pewno ręcznie w panelu kamery:
  „Notify Surveillance Center" na triggerze ANPR + HTTP Listening host (Edge),
  próg confidence; HTTP (nie HTTPS-only); NTP. Jeśli probe → „TYLKO PODGLĄD"
  (brak ANPR w firmware) — kamera zostaje STANDARD (podgląd), LPR na tym wjeździe
  nie działa → eskalacja do właściciela (wymiana/UPGRADE firmware).
- **Znane luki dla V5.3–5.6 (z audytu kodu):** (a) auto-config `httpHosts` PUT
  idzie w formacie ver20 — stare firmware bywa ver10-only i nie ma fallbacku
  w kodzie → wtedy HTTP Listening ręcznie w panelu; (b) `configureEventListener`
  woła się TYLKO przy `addDevice` (start Edge też re-rejestruje), a endpoint
  `POST /lpr/:id/camera-setup` odtwarza wyłącznie trigger — po utracie configu
  przez kamerę (reboot/zanik zasilania) ratunkiem jest restart Edge;
  (c) wizard Edge NIE zna modelu DS-2CD4A26FWD (discovery podpowie „Kamera IP")
  — **rejestrować JAWNIE jako „Kamera LPR"**, pole „Tryb listy tablic" w
  wizardzie zignorować (martwe — whitelista zawsze na Edge).
- **✅ NAPRAWIONE w tym audycie (2026-07-30): delta-sync whitelisty przy ≥2
  kamerach.** `PLATE_UPSERT/PLATE_DELETE` z Cloud (bez `cameraDeviceId`) trafiał
  tylko do PIERWSZEJ zarejestrowanej kamery — nowy pojazd otwierałby tylko
  Wjazd, a zablokowany nadal wyjeżdżał, aż do reconnectu (PLATE_SYNC_ALL).
  Fix: fan-out na wszystkie kamery w `apps/edge/src/tunnel/tunnel.service.ts`
  (wzorzec PLATE_SYNC_ALL); build Edge czysty. Weryfikacja na obiekcie:
  `sqlite3 store.db "SELECT camera_device_id,count(*) FROM lpr_plates GROUP BY 1"`
  — obie kamery muszą mieć tę samą liczbę po dodaniu/usunięciu pojazdu.
- **Przepustka wyjazdowa (exit grace) — ZAIMPLEMENTOWANA E2E**: Edge
  `exit-grace.util.ts` + hook w `hikvision-lpr.service.ts:433`
  (`handleExitGraceNoMatch`), konfiguracja `Building.features.exitGrace`
  z panelu Integratora, audyt EXIT_PASS/OVERSTAY w access_events. Wymaga
  poprawnych **kierunków IN/OUT na linkach LPR↔AP** — dlatego linki są krytyczne
  (kamera z mieszanymi kierunkami linków = exit-grace pomija ją PO CICHU).
  Status: kod z 2026-07-30, **default wyłączone i jeszcze niezdeployowane na
  prod Cloud** — przed F5 sprawdzić, czy `flyctl deploy -a gatelynk-api` z tym
  kodem poszedł (Edge VN dostaje świeży dist, więc stronę Edge ma). Decyzja
  właściciela: polityka `OPEN_AND_FLAG` (już podjęta 2026-07-30).

### 0.6 Współdzielony Mac Studio (AI) — start BEZ AI

- `AiEngineConfig` ma `@@unique(buildingId)` i **brak unique na `url`**
  (`apps/api/prisma/schema.prisma:448+`) → dwa budynki mogą wskazywać ten sam
  URL Mac Studio. Docelowo (później): drugi wiersz `ai_engines` dla VN z
  `url=http://100.99.26.17:11500` — UWAGA: Edge VN musi mieć wtedy Tailscale
  (URL TS, nie LAN). Na start: **NIE konfigurować karty AI Engine dla VN**.
- Wyłączenia w Permissions Matrix VN (Integrator → Permissions):
  `feat_ai_engine=false` (MASTER — kaskada w `hasPermission` sama zgasi
  `vision_dashboard`, `fall_detection`, `brand_detection`, `plate_ocr`), plus
  jawnie `feat_vision_ai=false` (legacy alias). LPR/whitelist działa bez AI.
- Bez konsjerża: `has_concierge=false` w features (readiness → „nie dotyczy").
- Healthcheck launchd `com.gatelynk.aihealth` na Mac Mini VN: na start pilnuje
  **tylko** `localhost:4000/health` (edge-node). Sekcje :8000 (ai-prototype)
  i :11434 (Ollama) dopisać dopiero przy dopięciu AI. (Plist nie jest w repo —
  wzorować się na kopii z Edge Villa Natura, wyciąć checki AI.)

### 0.7 Tailscale

- Mac Mini VN dołączyć do tailnetu z **tag:edge** — istniejące ACL
  `tag:cloud → tag:edge:4000` obejmie go automatycznie (miniaturki LPR w panelu
  idą przez TS proxy — patrz `apps/api/src/edge/edge.service.ts:16`).
- SSH: włączyć `tailscale up --ssh` lub klucz w `authorized_keys`; zanotować
  IP 100.x. Mac Studio już jest w tailnecie (100.99.26.17).
- `MACHINE_ID` w plist od dnia 1 (patrz 0.4).

### 0.8 Hardcody / ryzyka znalezione w audycie kodu

| Znalezisko | Plik | Blokuje VN? | Działanie |
|---|---|---|---|
| Fallbacki env na LAN Villa Natury: `YOLO_URL` → `http://192.168.1.109:11500`, `VISION_LLM_OLLAMA_URL` → `...:11434` | `apps/edge/src/devices/cameras/vision-detect.service.ts:354`, `vision-llm-summarizer.service.ts:39` | NIE (DB ma priorytet; VN startuje bez AI, feat_ai_engine=off) | Przy dopięciu AI: ustawić URL w panelu Integratora (nie env) |
| `AkuvoxStationCard` default prop `edgeIp='192.168.1.127'` | `apps/web/src/components/AkuvoxStationCard.tsx:18` | NIE (tylko tekst instrukcji w UI) | Przy wyświetlaniu dla VN podać właściwe IP (prop) |
| „Villa Natura"/b9 w komentarzach, seedach i spec-ach | m.in. `apps/api/prisma/seed-villa-natura.ts`, `resident-assistant.service.spec.ts` | NIE | — |
| 1 rozmowa domofonowa na budynek naraz (1 uchwyt SIP) | `intercom-call.service.ts` (busy-guard) | NIE (świadome) | Komunikować klientowi; przyszłość: multi-handle |
| Token phonebook = pochodna JWT_SECRET | `intercom-phonebook.controller.ts` | NIE | Wygenerować token dla VN (nie kopiować b9) |
| Repo-plist Edge bez `MACHINE_ID`/`INTERCOM_CALL_ENABLED` | `apps/edge/install/com.gatelynk.edge.plist` | TAK, jeśli pominięte | Krok F0.9 (PlistBuddy) — obowiązkowy |
| `INTERCOM_CALL_ENABLED` musi być w plist Edge **i** w Fly secrets (już jest na Cloud) | pamięć projektowa | NIE | Tylko plist VN |
| Konto BA tworzone w legacy panelu superadmina | design doc PR-6 | NIE (obejście istnieje) | Krok F0.4 |
| **PLATE_UPSERT/DELETE tylko do 1. kamery** (delta-sync whitelisty) | `apps/edge/src/tunnel/tunnel.service.ts` (dispatch), Cloud `syncPlateToEdge` bez cameraDeviceId | TAK przy 2 kamerach | ✅ **NAPRAWIONE 2026-07-30** — fan-out na wszystkie kamery (patrz 0.5) |
| `turnUrl/turnUsername/turnPassword` bez settera w UI/API | `IntercomsModule.tsx`, `integrator.service.ts` | TAK dla LTE | Ręczny SQL na `building_intercoms` (F2); docelowo pole w panelu |
| `infra/intercom/janus/janus.jcfg` — `turn_*` zakomentowane (stale po fixie 2026-07-29) | `infra/intercom/janus/janus.jcfg:42-50` | TAK dla LTE, jeśli skopiowane 1:1 | Odkomentować przy instalacji (F0.10) + zaktualizować snippet w repo |
| `janus.plugin.sip.jcfg` `local_ip="192.168.1.127"` (LAN Villi) | `infra/intercom/janus/janus.plugin.sip.jcfg:16` | TAK, jeśli skopiowane 1:1 | Podmienić na LAN IP Edge VN (F0.10) |
| Plist Edge: ścieżki `/Users/shc_development/...`, Node v22.22.2, `OLLAMA_URL=192.168.1.109` (stale nawet dla b9) | `apps/edge/install/com.gatelynk.edge.plist:56-135` | TAK, jeśli skopiowany 1:1 | F0.9: nowy plist z właściwym userem/ścieżkami, BEZ `OLLAMA_URL`/`GLE_LLM_MODEL`, Z `MACHINE_ID` |
| Alerty monitoringu AI-health bez `buildingId` (dedupe po nazwie komponentu, wspólny adresat) | `apps/api/src/monitoring/monitoring.service.ts:20-68`, `infra/monitoring/ai-health-check.sh` | NIE na start (VN pilnuje tylko edge-node) | Przy dopięciu AI: dodać buildingId do payloadu/dedupe |
| Zero testów e2e: aktywacja (throttle, cross-tenant, TTL), readiness (batch >1 budynku), import CSV, zaproszenia | `apps/api/test/` | NIE (ryzyko jakościowe) | Backlog D (hardening); readiness batch pierwszy raz realnie ruszy przy 2 budynkach |
| Brak `Building.status` COMMISSIONING (PR-7) | schema.prisma | NIE | Sprzątanie danych testowych ręcznie (F5.4) |
| `LprCamera.role` default `'LPR'` — zwykła kamera blokuje check readiness `lpr` | schema + readiness | NIE | Przy dodawaniu zwykłych kamer: rola STANDARD w panelu |

**Wniosek audytu: platforma jest gotowa na drugą instalację; w kodzie wykonano
jedną drobną poprawkę (fan-out PLATE_UPSERT/DELETE na wszystkie kamery LPR —
patrz 0.5), reszta to konfiguracja + provisioning + testy na sprzęcie.**
Otwarte ryzyka sprzętowe: (a) rzeczywisty stan ANPR/firmware DS-2CD4A26FWD-IZS,
(b) direct-dial z Remote Phonebook na R29 fw 465 (fallback: sip-proxy),
(c) jakość LTE/TURN w lokalizacji VN.

---

## F0 — Przygotowanie zdalne (przed wyjazdem; Konrad zdalnie + panel; ~0,5–1 dnia)

**F0.1 — Building VN w Cloud** (panel Integratora → Dashboard → Dodaj obiekt).
Nazwa, adres, `objectType` (⚠️ pytanie otwarte #1 — osiedle domów =
HOUSING_ESTATE, blok = BUILDING; ustawia defaulty features/permissions).
*Done:* obiekt widoczny na dashboardzie, readiness = not_ready (naturalne).

**F0.2 — Typ obiektu i funkcje** (strona obiektu → karta „Typ obiektu i funkcje"
+ Permissions Matrix): `has_concierge=false`; `feat_ai_engine=false` (kaskada
zgasi vision/fall/brand/plate_ocr), `feat_vision_ai=false`; zostawić ON:
vehicles, guests, guest_portal, resident_pin, lpr_audit, tickets, notifications;
payments/reservations/parcels/courier_visits wg decyzji właściciela (pytanie #6).
*Done:* w matrycy brak zielonych przy funkcjach AI; readiness pokazuje AI = skip.

**F0.3 — Struktura**: stairwells/units (panel → obiekt → Klatki/Lokale) — minimum
lokale dla 5–10 testowych mieszkańców (reszta może dojść importem CSV, który
tworzy lokale). ⚠️ numeracja lokali: `unit.id` będzie numerem wybierania na
domofonie — jeśli klient chce direct-dial po numerze domu, nadać lokalom czyste
numeryczne `number` (pytanie #5).

**F0.4 — Konto BA** (legacy panel superadmina `(dashboard)/buildings/[id]` —
PR-6 jeszcze nie przeniósł tego do Integratora). *Done:* readiness check
„Administrator budynku" = ok.

**F0.5 — Kod aktywacyjny Edge**: strona obiektu → Urządzenia → „Edge / kod
aktywacyjny" → Generuj (typ EDGE). Kod `GLEX-…`, **TTL 24 h — generować dzień
przed wyjazdem** albo wygenerować nowy na miejscu przez telefon. Zapisać.

**F0.6 — CSV mieszkańców** od właściciela/zarządcy (imię; nazwisko; email;
telefon; lokal; ulica — polskie nagłówki OK, separator `;` lub `,`).
Wgrać do setup-hub → **dry-run** (nic nie zapisuje) — wyłapać błędy zawczasu.

**F0.7 — Mac Mini: system.** Konto (proponowane `gatelynk_vn`), auto-login,
`pmset -a sleep 0 autorestart 1`, wyłączyć auto-update macOS w sezonie wdrożenia,
**ustawić STAŁY hostname** (`sudo scutil --set HostName gatelynk-edge-vn` — i tak
mamy MACHINE_ID, ale porządek pomaga). Zainstalować: Xcode CLT, Homebrew, nvm +
Node 22 (`nvm install 22`), ffmpeg (`apps/edge/install/setup-ffmpeg-tahoe.sh`
jeśli macOS 26/Tahoe).

**F0.8 — Mac Mini: Tailscale.** `tailscale up` → w admin console nadać
**tag:edge**; sprawdzić z Cloud-perspektywy że ACL przepuszcza (po aktywacji
Edge: miniaturki LPR w panelu = dowód). Włączyć Tailscale SSH lub dodać klucz.
*Done:* `tailscale status` pokazuje maszynę; ssh z laptopa działa.

**F0.9 — Mac Mini: aplikacja Edge.** Build lokalnie w monorepo
(`pnpm --filter @gatelynk/edge build` — wcześniej cleanup iCloud-duplikatów,
pułapka #12), potem na Mac Mini `~/gatelynk-edge/`:
- rsync `apps/edge/dist/` + `public/` + `web/dist` (UI); **NIE rsync monorepo
  `package.json`** (pułapka #9 — workspace-protokół wywala npm). Skopiować
  scrubbed package.json (bez `@gatelynk/device-drivers`), `npm install`
  (PATH z nvm — pułapka #10), a `packages/device-drivers/dist` rsync ręcznie do
  `node_modules/@gatelynk/device-drivers/`.
- plist: `cp apps/edge/install/com.gatelynk.edge.plist ~/Library/LaunchAgents/`
  i **dopisać env** (PlistBuddy):
  ```
  MACHINE_ID = gatelynk-edge-vn            # OBOWIĄZKOWE od dnia 1
  CLOUD_URL  = https://gatelynk-api.fly.dev
  INTERCOM_CALL_ENABLED = true
  JANUS_HTTP_URL = http://127.0.0.1:8088/janus
  # EDGE_PUBLIC_HOST = <ip-edge>:4000     # tylko gdy kamery w innym /24
  ```
  `launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.gatelynk.edge.plist`.
- **Sprawdzić że NIE ma** konkurencyjnych menedżerów: `pm2 list` (pusty!),
  brak `pl.gatelynk.edge` — na Villa Naturze duplikaty walczyły o :4000.
*Done:* `curl localhost:4000/activation/status` odpowiada (nieaktywowany).

**F0.10 — Mac Mini: Janus ze źródeł** wg `infra/intercom/janus/README.md`:
deps brew (koniecznie `sofia-sip`, `srtp`, **`libmicrohttpd`**), clone, **patch
portu 5060** (sed w `janus_sip.c`), **`patch -p1 < infra/intercom/janus/
janus_sip_macos_connect_fix.patch`** (bez tego brak audia telefon→domofon!),
configure (`SIP Gateway: yes`, `REST: yes`), make install, cert DTLS, configi
z `infra/intercom/janus/` (`ip`/`admin_ip` w transport.http — NIE `interface`),
`janus.plugin.sip.jcfg`: `local_media_ip=<LAN-IP-Edge-VN>`. W `janus.jcfg`
sekcja `nat`: `turn_server=91.99.212.240, turn_port=3478, turn_type=udp,
turn_user/pwd` = długożyciowy cred HMAC (`printf 'user' | openssl dgst -binary
-sha1 -hmac $TURN_STATIC_SECRET | base64`). launchd `com.gatelynk.janus.plist`
(w repo). *Done:* boot-log Janusa: nasłuch SIP `<LAN-IP>:5060` + `TURN server
to use: 91.99.212.240:3478 (udp)`.

**F0.11 — aihealth**: LaunchAgent `com.gatelynk.aihealth` na Mac Mini VN
(skopiować z Edge VN wzorzec z Villa Natury) pilnujący **tylko**
`localhost:4000/health`; checki :8000/:11434 dopisać przy dopięciu AI.

**F0.12 — Zakupy/logistyka**: firmware R29 **29.30.10.465 LTS** pobrany na
laptopa; dane admin do DS-2CD4A26 od klienta (lub zgoda na hard-reset);
patchcordy, PoE, laptop w LAN.

**Kryterium wyjścia F0:** obiekt w Cloud z BA i permissions; Mac Mini z Edge
(nieaktywowany), Janusem, Tailscale, launchd; kod GLEX w kieszeni; CSV po dry-run.

---

## F1 — Sieć + Edge on-site (Konrad on-site; ~2–4 h)

1. Fizycznie: Mac Mini + switch; 3× R29 i 2× LPR w tym samym LAN/VLAN co Edge.
   **Rezerwacje DHCP** (lub statyczne IP) dla Edge, 3× R29, 2× LPR — spisać
   tabelę IP (pytanie #2: adresacja LAN VN).
2. Warunek: Edge ma internet; `ping` do każdego urządzenia z Mac Mini.
3. **Aktywacja**: laptop w LAN → `http://<ip-edge>:4000/ui` → Ustawienia → kod
   `GLEX-…` → Aktywuj (throttle 5/min/IP — przy literówce odczekać). Ustawić
   **PIN Edge UI**; PIN do dokumentacji obiektu.
4. Weryfikacja tunelu: Edge UI „Połączono z Cloud — <VN>"; log Edge:
   `Tunnel connected` + seria `*_SYNC_ALL`; setup-hub check „Bramka Edge = ✓".
   **Po każdym restarcie Edge w tej fazie: restart Janus → potem Edge**
   (pułapka #19; objaw złej kolejności: `Two seconds passed and still no NUA`).
5. Gdy „tunnel standby" mimo aktywacji → procedura re-aktywacji z pamięci
   `reference_edge_machineid_gotcha` (deactivate lokalnie → reset flagi w Cloud
   DB → activate nowym kodem).

**Kryterium wyjścia:** readiness: Edge=ok; Edge widoczny online na dashboardzie.

---

## F2 — Domofony 3× R29 (Konrad on-site + panel; ~0,5–1 dzień)

Dla KAŻDEJ z 3 stacji (Wjazd, Wyjazd, Brama garażowa):

1. **Firmware → 29.30.10.465 LTS** (web UI → Upgrade). Backup konfiguracji przed.
2. Konfiguracja stacji (checklista 0.3): PreventSIPHacking=0 · Direct IP 5060 ·
   Key Setting Number=`<LAN-IP-Edge>` · Auto Answer ON · Action URL
   `http://<edge>:4000/akuvox/event` · hasła (web + API/rtsp) do dokumentacji.
3. **Edge UI → Dodaj urządzenie** (wizard: typ INTERCOM → akuvox → IP/hasła →
   test → nazwa robocza „R29 Wjazd" itd.). Test snapshot + „Wyzwól" przekaźnik.
4. **Panel Integratora → obiekt → Urządzenia → Domofony**: utworzyć 3 wpisy
   `building_intercoms` — nazwa (to widzi mieszkaniec w CallKit!), model R29,
   **`ipAddress` (LAN, z rezerwacji DHCP)**, powiązanie `edgeDeviceId`,
   **`bridgeEnabled=true`**. Zapis → Cloud pcha `INTERCOM_SYNC_ALL`; log Edge:
   `replaced 3 station(s)`. Następnie **ręcznym SQL-em** (brak pola w UI):
   `UPDATE building_intercoms SET "turnUrl"='turns:turn.gatelynk.com:443?transport=tcp'
   WHERE "buildingId"=<id>;` (przez flyctl ssh + node-script, pułapka #15).
5. **Access pointy** (panel → Punkty dostępu): AP per przekaźnik z kategorią
   (VEHICLE_ENTRY / VEHICLE_EXIT / GARAGE — nazwy AP: pytanie #4), binding
   device→relay→durationMs; test przyciskiem (wpis liczy się do readiness).
   Pamiętaj: relay 0 = DoorNum 1, relay 1 = DoorNum 2.
6. **Remote Phonebook**: Phone → Remote Phonebook URL =
   `https://gatelynk-api.fly.dev/api/intercom/phonebook?b=<id>&t=<token>&host=<LAN-IP-Edge>`
   (+ interwał odświeżania). Token: wyliczyć wg 0.3 pkt 5 (skrypt/node na prod).
   Weryfikacja: lista lokali z nazwiskami na ekranie stacji (po F4-imporcie).
7. **(Opcjonalnie od startu / pytanie #7)** Directory Sync v2 zamiast Remote
   Phonebook: procedura 12 kroków `docs/akuvox-directory-v2-installer.md`
   (eksport LOKALNYCH kontaktów jako template → upload → mapowanie → dry-run →
   import). Wymaga realnego template z R29@465 — pierwszy raz zrobić na 1 stacji.
8. **Testy per stacja**: (a) przycisk fizyczny → push VoIP w Glass → odbiór →
   2-way audio + obraz (hybryda snapshot); (b) dotknięcie lokalu na liście →
   dzwoni TYLKO ten lokal; (c) z apki: „Połącz z domofonem" → picker 3 stacji →
   każda stacja auto-odbiera, 2-way audio; (d) przycisk „Otwórz" w rozmowie →
   przekaźnik. Testy (a)+(c) powtórzyć **na LTE** (wyłączyć WiFi!) — to
   weryfikuje TURN. (e) rozmowa nr 2 w trakcie rozmowy → komunikat „Stacja
   zajęta" (nie crash).

**Pułapki fazy:** kolejność restartów Janus→Edge; jeśli lista kontaktów dzwoni
„Account Unavailable" → fallback sip-proxy (0.4); głucha rozmowa → pułapka #19
(diagnoza: log Edge `SIP registered: edge`, log Janusa, logi `[Call]` z Xcode).

**Kryterium wyjścia:** 3× stacja z kompletem testów (a)–(e), w tym LTE.

---

## F3 — LPR 2× DS-2CD4A26FWD-IZS (Konrad on-site + panel; ~0,5 dnia)

1. **Probe każdej kamery**: `node apps/edge/tools/lpr-camera-probe.ts --ip <ip>
   --user admin --pass '<hasło>' --listen 8` (NIE zgadywać haseł — lockout po
   ~5 próbach!). Oczekiwany werdykt: „PEŁNY LPR" lub „LPR MOŻLIWY (ręczna
   konfiguracja)". Werdykt „TYLKO PODGLĄD" = kamera bez ANPR → decyzja
   właściciela (rejestrować jako CAMERA, wjazd bez auto-otwierania).
2. Panel WWW kamery (starszy firmware V5.3–5.6 — spodziewaj się ręcznej roboty):
   Road Traffic / Vehicle Detection włączone + **„Notify Surveillance Center"**;
   HTTP Listening host = `<ip-edge>:4000` jeśli auto-config `httpHosts` padł
   (log Edge); próg confidence w panelu (setConfidence może dać 404); **HTTP
   włączone** (nie HTTPS-only); **NTP** zsynchronizowany.
3. **Edge UI → Dodaj urządzenie** — **JAWNIE wybrać typ „Kamera LPR"**
   (discovery podpowie „Kamera IP", bo regex nie zna DS-2CD4A26FWD — nie ufać
   podpowiedzi; pole „Tryb listy tablic" zignorować). Test połączenia.
4. **Panel Integratora → Powiązania LPR**: kamera Wjazd → AP Wjazd, **direction
   IN**; kamera Wyjazd → AP Wyjazd, **direction OUT**. Kierunki są KRYTYCZNE
   (przepustka wyjazdowa liczy IN→OUT).
5. Test: pojazd testowy do whitelisty (BA → Pojazdy, APPROVED) → przejazd →
   szlaban otwiera, `LPR_MATCH dir=IN` w access-events; wyjazd → `dir=OUT`.
   **Sprawdzić fan-out na OBIE kamery** (fix z 0.5):
   `sqlite3 ~/gatelynk-edge/data/store.db "SELECT camera_device_id,count(*)
   FROM lpr_plates GROUP BY 1"` — równe liczby. Odczyty `unknown` przy
   nieczytelnej tablicy to norma (starsza optyka = więcej UNKNOWN).
6. **Bez AI**: nie obiecywać rozpoznawania kurierów/napisów — LPR ANPR działa
   w 100% bez AI (matryca WS-B).

**Kryterium wyjścia:** obie kamery z werdyktem probe, LPR_MATCH na żywym
przejeździe w obu kierunkach, readiness „Kamery LPR" = ✓.

---

## F4 — Mieszkańcy + aplikacje (Konrad panel/zdalnie; ~2–3 h + czas mieszkańców)

1. **Import CSV**: setup-hub → Import mieszkańców → dry-run → „Importuj N".
   Idempotentny — poprawka pliku i ponowny upload nie dubluje.
2. **Zaproszenia**: setup-hub → Zaproszenia → „Wyślij zaproszenia (N)".
   Mieszkaniec: mail → `/accept-invitation` → hasło → login w **GateLynk Glass**
   (App Store, prod). „Bez e-maila" → BA uzupełnia adres → ponowić.
3. Weryfikacja per mieszkaniec: login (przy wielu budynkach — picker), push
   token + **VoIP token** rejestrują się po zalogowaniu; „Otwórz" na AP działa.
4. **Pojazdy**: mieszkańcy dodają w apce (PENDING) → BA approve → whitelist
   (outbox/PLATE_UPSERT; pełny stan i tak zjedzie przy każdym reconnect —
   PLATE_SYNC_ALL). Ewentualnie arkusz pojazdów wgrywa BA ręcznie.
5. **PIN-y**: mieszkaniec ustawia „Mój PIN do bramy" (klawiatura R29 — offline
   first); gość z PIN-em (guest_portal) — test wpisania na stacji.
6. Remote Phonebook na stacjach odświeży się wg interwału — sprawdzić listę
   lokali z nazwiskami po imporcie (pkt F2.6).

**Kryterium wyjścia:** 5–10 kont aktywnych (readiness „Mieszkańcy" ✓),
≥1 pojazd APPROVED na whitelist, ≥1 PIN działa na stacji.

---

## F5 — Testy odbiorowe + przepustka wyjazdowa (Konrad on-site; ~2–3 h)

1. Przejść **Checklist odbiorowy** (sekcja niżej) w całości.
2. **(Opcjonalnie, decyzja właściciela — pytanie #8)** Włączyć przepustkę
   wyjazdową: panel Integratora → obiekt → exit grace: `enabled=true`,
   `minutes=15`, polityka `OPEN_AND_FLAG` (rekomendowana — nie więzi aut przy
   szlabanie; `DENY` = literalna reguła 15 min). Test: obce auto wjeżdża
   (otwarcie z apki) → wyjazd <15 min → szlaban sam otwiera, w feedzie
   „Wyjazd na przepustce"; wyjazd >15 min → wg polityki (+OVERSTAY w audycie).
3. Setup-hub → Odśwież: **wszystkie checki ✓ lub „nie dotyczy"** (Konsjerż, AI).
   Status: Gotowy.
4. Posprzątać dane testowe (gość testowy, wpisy testowe, ewentualne konto demo).

---

## F6 — Przekazanie (Konrad; ~1–2 h)

1. **Dokumentacja obiektu** (przekazywana właścicielowi + kopia u nas): tabela
   IP (Edge, 3× R29, 2× LPR), hasła urządzeń (web + API), PIN Edge UI, kod BA,
   token phonebook, MACHINE_ID, IP Tailscale Edge.
2. **Backupy**: eksport konfiguracji każdego R29 (Upgrade→Others) i configu
   Edge (Edge UI eksport / `ExportConfigModal`); kopia `janus.jcfg*` i plist;
   na Edge katalog `~/gatelynk_backups/`.
3. **Monitoring**: obiekt na dashboardzie Integratora (readiness badge, alerty
   Edge offline); aihealth aktywny; wpis do rutyny „sprawdź po deployach".
4. Szkolenie BA (30 min): panel BA v2 — mieszkańcy, pojazdy (approve), goście,
   feed wejść; kiedy dzwonić do integratora.
5. Zapisać nauki z wdrożenia do repo (aktualizacja tego runbooka po F6!).

---

## Pytania otwarte do właściciela (odpowiedzi wpisać przed F0)

1. **objectType VN** — osiedle domów (HOUSING_ESTATE) czy blok (BUILDING)?
   (steruje defaultami features/permissions i etykietami w apce).
2. **Adresacja LAN** — czy jest zarządzalny router/DHCP z rezerwacjami? Podsieć?
   Kto zarządza siecią obiektu?
3. **Tailscale/bastion** — Mac Mini VN w tailnecie z Tailscale SSH (rekomendacja:
   TAK, jak wyżej) — potwierdzić; czy dodatkowo bastion przez Edge do innych
   urządzeń LAN?
4. **Nazwy AP** — jak mają się nazywać w apce (np. „Wjazd", „Wyjazd", „Garaż")?
   Kategorie AP dla bramy garażowej?
5. **Ile lokali docelowo** i jaka numeracja? Czy direct-dial z klawiatury po
   numerze domu ma działać (→ czyste numeryczne `unit.number`)?
6. **Funkcje w apce na start**: payments? reservations? parcels? courier_visits?
   (bez decyzji: OFF — mniej „martwych" ekranów).
7. **Grupy kontaktowe na domofonie od startu** (Directory Sync v2 z grupowaniem
   po klatce/ulicy) czy płaska lista z Remote Phonebook? (Remote Phonebook =
   szybciej; Directory v2 = ładniej, wymaga template z urządzenia).
8. **Przepustka wyjazdowa** — włączać od startu? Polityka po 15 min:
   OPEN_AND_FLAG (rekomendacja) czy DENY?
9. **Stare kamery**: czy klient akceptuje scenariusz „tylko podgląd" jeśli
   DS-2CD4A26 okaże się bez sprawnego ANPR (do czasu wymiany)?
10. Dane dostępowe: hasła admin do kamer LPR — są? Jeśli nie: zgoda na hard-reset?

---

## Checklist odbiorowy (wszystko = TAK przed przekazaniem)

**Domofony (każda z 3 stacji: Wjazd / Wyjazd / Garaż):**
- [ ] Przycisk fizyczny → push VoIP → odbiór w Glass → 2-way audio + obraz (on-site WiFi)
- [ ] To samo **na LTE** (WiFi w telefonie wyłączone)
- [ ] Wybór lokalu z listy na stacji → dzwoni tylko ten lokal
- [ ] Rozmowa wychodząca z apki (picker stacji) → auto-answer → 2-way audio (WiFi **i** LTE)
- [ ] „Otwórz" w trakcie rozmowy → przekaźnik działa
- [ ] Druga równoległa rozmowa → czytelne „Stacja zajęta"

**LPR:**
- [ ] Wjazd: tablica testowa z whitelisty → szlaban otwiera, `LPR_MATCH dir=IN` w feedzie
- [ ] Wyjazd: `LPR_MATCH dir=OUT`
- [ ] Tablica spoza listy → brama NIE otwiera, `LPR_NO_MATCH` w audycie
- [ ] (jeśli włączona) przepustka wyjazdowa: obcy pojazd wyjeżdża <15 min → otwarcie + wpis

**Aplikacja / mieszkańcy:**
- [ ] Zaproszenie e-mail → ustawienie hasła → login w Glass
- [ ] „Otwórz" z apki na każdym AP → `REMOTE_OPEN` w historii
- [ ] Zaproszenie gościa z PIN → PIN działa na klawiaturze stacji → `PIN_USED`
- [ ] PIN mieszkańca działa
- [ ] Push (zwykły) dochodzi; VoIP push budzi apkę z zabitego stanu
- [ ] Pojazd dodany w apce → approve BA → działa na wjeździe

**Audyt / panel:**
- [ ] Feed wejść (BA) pokazuje wszystkie powyższe zdarzenia z właściwymi typami
- [ ] Readiness: wszystkie checki ✓ / „nie dotyczy"; dashboard: Edge online
- [ ] Restart Edge (procedura Janus→Edge) → wszystko wraca samo (SYNC_ALL w logu)
- [ ] Wyłączenie internetu na 5 min → PIN i LPR działają offline; po powrocie zdarzenia dosyłają się do Cloud

---

## Estymacja

| Faza | Czas | Kto |
|---|---|---|
| F0 przygotowanie zdalne | 0,5–1 dnia | Konrad zdalnie |
| F1 sieć + Edge on-site | 2–4 h | Konrad on-site |
| F2 domofony 3× R29 | 0,5–1 dzień | Konrad on-site |
| F3 LPR 2× stare Hikvision | 0,5 dnia (ryzyko: +0,5 przy upartym firmware) | Konrad on-site |
| F4 mieszkańcy + aplikacje | 2–3 h + spływ mieszkańców (dni) | Konrad panel |
| F5 testy odbiorowe | 2–3 h | Konrad on-site |
| F6 przekazanie | 1–2 h | Konrad |
| **Razem robocizna** | **~3–4 dni robocze** (w tym 2 dni on-site) | |

Bufor ryzyka: +1 dzień (stare kamery LPR / direct-dial R29 / sieć obiektu).
