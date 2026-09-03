# Połączenie domofonowe Akuvox ↔ iOS (SIP ↔ WebRTC bridge)

> Status: **FAZY A+B+C — KOD GOTOWY** (2026-06-14). Cała funkcja jest za
> feature-flagą `INTERCOM_CALL_ENABLED` (default `false`) na Cloud i Edge. Nic
> nie wpływa na działającą produkcję. Faza B (Janus SIP terminacja, routing,
> state machine, sygnalizacja, coturn) + Faza C (iOS WebRTC do API stasel/WebRTC,
> Cloud generator TURN creds HMAC) napisane bez sprzętu i tsc/swiftc-czyste.
> Pozostają KROKI MANUALNE właściciela (build w Xcode, SPM WebRTC, VoIP cert,
> env TURN, sprzęt Akuvox+Janus+coturn) — sekcja
> [KROKI MANUALNE / SPRZĘTOWE](#8-kroki-manualne--sprzętowe-dla-właściciela).

## 1. Cel i zakres

Dwukierunkowe **audio** + jednokierunkowe **wideo** między domofonem **Akuvox**
(R29/R20/E16/S5xx) a aplikacją **iOS (SwiftUI)**:

- Audio: 2-way (gość ↔ mieszkaniec rozmawiają).
- Wideo: 1-way (mieszkaniec widzi gościa; gość NIE widzi mieszkańca — iPhone nie
  publikuje kamery).
- Działa on-site (mieszkaniec w LAN) i off-site (mieszkaniec poza siecią — relay
  przez TURN).

## 2. Wybrana architektura — Edge SIP↔WebRTC bridge

Decyzja właściciela (nie zmieniać). Akuvox mówi natywnie SIP-em (INVITE, RTP
audio G.711/G.722 + wideo H.264). iOS mówi WebRTC. **Edge (Mac Mini, on-site w
LAN)** jest mostem: terminuje SIP od Akuvoxa i mostkuje media do sesji WebRTC w
aplikacji. NestJS na Edge jest warstwą **ORKIESTRACJI** — zarządza sesjami,
steruje media serverem i emituje eventy istniejącym tunelem Edge↔Cloud. Sam
stos SIP/RTP/WebRTC dostarcza gotowy **media server** (Janus), a nie własny kod.

```
┌──────────┐   SIP INVITE        ┌──────────────────── EDGE (Mac Mini, LAN) ───────────────────┐
│  Akuvox  │  audio G.711/G.722  │  ┌───────────────┐         ┌──────────────────────────────┐ │
│  domofon │  wideo H.264        │  │ Janus media    │  steruje│ NestJS: IntercomCallService   │ │
│  (panel) │ ──── RTP ─────────► │  │ server         │◄────────│ (orkiestracja sesji)          │ │
│          │ ◄─── RTP audio ──── │  │  • SIP plugin  │  Admin  │  • mapuje deviceId→unit→       │ │
└──────────┘                     │  │  • VideoRoom / │  API    │    residenci                  │ │
                                 │  │    Streaming   │         │  • MediaBridge (abstrakcja)   │ │
                                 │  └──────┬─────────┘         │  • emituje EVT przez tunel     │ │
                                 │         │ WebRTC (SRTP/DTLS)└───────────┬───────────────────┘ │
                                 └─────────┼───────────────────────────────┼─────────────────────┘
                                           │ media (audio 2-way,           │ sygnalizacja (WS tunel)
                                           │ wideo 1-way)                  │ INTERCOM_CALL_INVITE / SIGNAL
                            ICE: STUN/TURN │                               ▼
                                           │                    ┌──────────────────┐
                                           │                    │  Cloud API (Fly)  │
                                           │                    │  EdgeGateway WS   │
                                           │                    │  + VoIP push      │
                                           │                    │  + resident HTTPS │
                                           │                    └─────────┬─────────┘
                                           │                              │ APNs VoIP push (PushKit)
                                           │                              ▼
                                           │                    ┌──────────────────┐
                                           └───── WebRTC ──────►│  iOS (SwiftUI)    │
                                            (audio↑↓, wideo↓)   │  PushKit→CallKit  │
                                                                │  WebRTC peer      │
                                                                └──────────────────┘
```

### Przepływ end-to-end (happy path, mieszkaniec w LAN)

1. Gość naciska przycisk wywołania na panelu Akuvox.
2. Akuvox wysyła **SIP INVITE** na endpoint Edge (registrar Janus SIP plugin albo
   direct IP call). SDP oferuje audio (G.711/G.722) + wideo (H.264).
3. Janus terminuje SIP, tworzy wewnętrzną sesję media. NestJS `IntercomCallService`
   dostaje event od Janusa (`registered`/`incomingcall`), tworzy
   `IntercomCallSession` (stan `INCOMING`), rozwiązuje **kogo wołać**
   (deviceId → access point/intercom → unit → residenci, sekcja 6).
4. Edge emituje przez tunel `INTERCOM_CALL_INVITE` (Edge→Cloud) z `sessionId`,
   `buildingId`, `intercomDeviceId`, listą `residentIds`, opcjonalnym snapshotem.
5. Cloud zapisuje sesję, dla każdego mieszkańca wysyła **VoIP push (PushKit/APNs
   topic `.voip`)** z `sessionId` w payloadzie.
6. iOS budzi się przez `PKPushRegistry`, **natychmiast** woła
   `CXProvider.reportNewIncomingCall` → CallKit pokazuje natywny ekran połączenia
   (obowiązek systemu: VoIP push MUSI zgłosić CallKit, inaczej iOS ubije apkę).
7. Mieszkaniec odbiera. iOS:
   - `POST /api/resident/intercom/calls/:id/answer` (Cloud→Edge przez tunel:
     `INTERCOM_CALL_ANSWER`).
   - WebRTC handshake: iOS tworzy `RTCPeerConnection`, wymienia SDP offer/answer
     i ICE z Edge (Janus) przez kanał sygnalizacji (`INTERCOM_SIGNAL`,
     dwukierunkowo, transport: resident HTTPS/SSE — sekcja 5).
   - ICE łączy bezpośrednio przez LAN (host candidate) albo przez STUN.
8. Media płynie: Janus mostkuje RTP↔WebRTC. Mieszkaniec słyszy i widzi gościa,
   gość słyszy mieszkańca. Stan sesji → `ACTIVE`.
9. Rozłączenie (dowolna strona): `POST .../hangup` → `INTERCOM_CALL_HANGUP` →
   Janus zamyka SIP BYE do Akuvoxa + WebRTC. Stan → `ENDED` (+ `endReason`).
   `access_events` dostaje wpis `INTERCOM_CALL`.

### Scenariusz off-site (mieszkaniec poza LAN)

Kroki 1–6 identyczne (VoIP push idzie przez APNs niezależnie od sieci). W kroku 7
ICE nie znajdzie ścieżki host/LAN, więc:

- iOS i Janus zbierają kandydatów **STUN** (publiczny adres) i **TURN** (relay).
- Gdy NAT obu stron jest symetryczny / brak peer-reflexive — media leci przez
  **TURN relay** (coturn). To gwarantuje połączenie kosztem latencji.
- Edge musi być osiągalny dla zewnętrznego iPhone'a: media nie idzie do Edge
  bezpośrednio po jego LAN IP — TURN serwer jest publicznie dostępnym punktem
  styku, a Janus zgłasza swoje publiczne ICE candidate (`nat_1_1_mapping` /
  TURN). Patrz sekcja TURN w krokach manualnych.

## 3. Wybór media servera — Janus vs FreeSWITCH

| Kryterium | **Janus (SIP plugin)** ✅ rekomendacja | FreeSWITCH (mod_sofia + mod_verto/WebRTC) |
|---|---|---|
| Model | WebRTC-first gateway; SIP plugin terminuje SIP i wystawia stronę WebRTC | Pełny softswitch/PBX; WebRTC jako dodatek |
| macOS (Edge = Mac Mini) | Builduje się przez Homebrew/źródła; lekki, mało zależności | Cięższy build, zaprojektowany pod Linux/serwer; na macOS bardziej kłopotliwy |
| Sterowanie z Node | Czyste **HTTP/WebSocket Admin API** + per-plugin API — łatwe do orkiestracji z NestJS | ESL (Event Socket Library) + dialplan XML — więcej telco-konceptów |
| Złożoność do naszego use-case | Minimalna: 1 SIP leg ↔ 1 WebRTC leg, audio 2-way + wideo 1-way | Overkill — pełny PBX, którego nie potrzebujemy |
| H.264 passthrough | Wspiera (transcoding zwykle niepotrzebny — Akuvox i iOS oba H.264) | Wspiera, ale konfiguracja cięższa |
| Społeczność/dokumentacja pod WebRTC bridge | Bardzo dobra, dużo przykładów SIP↔WebRTC | Dobra, ale głównie telco |

**Rekomendacja: Janus Gateway z `janus.plugin.sip`.** Powody:
- Edge to Mac Mini z ograniczonymi zasobami i bez admina telco — Janus jest
  lżejszy i prostszy do uruchomienia/utrzymania.
- Orkiestracja z NestJS przez HTTP Admin API mapuje się 1:1 na nasz wzorzec
  serwisów (jak `IntercomService` woła HTTP do urządzeń).
- Nasz scenariusz to dokładnie „1 SIP ↔ 1 WebRTC", co jest kanonicznym
  przykładem Janus SIP plugin.

FreeSWITCH zostaje jako fallback gdyby Janus nie radził sobie z konkretnym
firmware Akuvoxa (np. nietypowy kodek/SDP) — abstrakcja `MediaBridge` na Edge
pozwala podmienić backend bez ruszania orkiestracji.

### Co Akuvox musi mieć skonfigurowane (web UI domofonu)

Domofon dzwoni do Edge na dwa możliwe sposoby — wybierz jeden:

1. **SIP account / registrar (rekomendowane)** — Akuvox rejestruje się jako
   klient SIP do Janus SIP plugin:
   - `Account → SIP`: server = IP Edge, port 5060 (UDP/TCP), user/pass =
     konto utworzone w Janus/registrarze.
   - Wywołanie przycisku → dial do `sip:<unit-or-edge-extension>@<edge-ip>`.
2. **Direct IP call (bez registrara)** — Akuvox dzwoni wprost na IP:port Janusa.
   Prostsze do testów, ale mniej elastyczne przy wielu domofonach.

Wspólne ustawienia Akuvox:
- **Kodeki audio**: włącz PCMU/PCMA (G.711) i/lub G.722.
- **Kodek wideo**: H.264 (Baseline/Main), rozdzielczość/bitrate dopasowane do
  uploadu w LAN (np. 720p / ~1–2 Mbps).
- **Push/call key mapping**: przycisk → numer/extension który routuje na unit
  (patrz sekcja 6). Można też wywoływać jedną „centralną" extension i routować
  po stronie Edge na podstawie `intercomDeviceId`.
- DTMF do otwierania drzwi (RFC2833) — opcjonalnie, jeśli mieszkaniec ma
  otwierać bramę z poziomu połączenia (reużywamy istniejącego `OPEN_DOOR`).

> Pola w bazie pod tę konfigurację już istnieją (nieużywane): `BuildingIntercom.
> sipServer / sipAccount / sipPassword` (`schema.prisma:601-603`). Nowe pola
> mostu/TURN dochodzą w sekcji 4.

## 4. Model danych

### Nowy model `IntercomCallSession`

Ścieżka migracji: `apps/api/prisma/migrations/20260613090000_add_intercom_call_sessions/migration.sql`
(stały timestamp wymagany przez zlecenie — NIE `Date.now`).

```prisma
model IntercomCallSession {
  id               String    @id @default(uuid())   // = sessionId w tunelu/push/WebRTC
  buildingId       Int
  building         Building  @relation(fields: [buildingId], references: [id], onDelete: Cascade)
  intercomDeviceId String?   // Edge device UUID domofonu (BuildingIntercom.edgeDeviceId)
  intercomName     String?   // snapshot nazwy panelu (np. "Brama główna")
  // Kogo wołano: unit + residenci (residentId rozwiązany na Edge przy INVITE).
  unitId           Int?
  unitLabel        String?   // snapshot "Klatka A/15A"
  // Mieszkaniec który ODEBRAŁ (pierwszy answer wygrywa). NULL gdy MISSED.
  answeredById     Int?
  state            String    @default("INCOMING")   // INCOMING|RINGING|ACTIVE|ENDED|MISSED
  startedAt        DateTime  @default(now())
  ringingAt        DateTime?
  answeredAt       DateTime?
  endedAt          DateTime?
  endReason        String?   // ANSWERED_HANGUP|CALLER_HANGUP|TIMEOUT|DECLINED|ERROR|NO_DEVICE
  meta             Json?     // ad-hoc: snapshotUrl, codecAudio, codecVideo, turnUsed...
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  @@index([buildingId, startedAt(sort: Desc)])
  @@index([state])
  @@map("intercom_call_sessions")
}
```

Back-relation w `Building`: `intercomCallSessions IntercomCallSession[]`.

### Pola konfiguracyjne mostu — na `BuildingIntercom`

Rozszerzamy istniejący model (te same migracje), nie nowa tabela — konfiguracja
mostu jest per-domofon/budynek:

```prisma
// na model BuildingIntercom (schema.prisma:594):
sipDomain     String?   // domena/registrar SIP (gdy inna niż IP Edge)
turnUrl       String?   // np. turn:turn.gatelynk.com:3478
turnUsername  String?
turnPassword  String?   // sanitizeDeviceConfig już filtruje *Password do Cloud
bridgeEnabled Boolean   @default(false)  // most aktywny dla tego domofonu
```

> `sipServer/sipAccount/sipPassword` zostają jak są (rejestracja Akuvox→Janus).
> Nowe `turn*` służą stronie WebRTC (iOS + Janus dostają ICE servers).

## 5. Protokół sygnalizacji

### Decyzja: jak iOS dostaje offer/answer/ICE

**Sygnalizacja Edge↔Cloud = istniejący WS tunel.** Sygnalizacja Cloud↔iOS =
**resident HTTPS (request/response) + SSE do odbioru** (a NIE osobny WS do apki).

Uzasadnienie:
- iOS nie ma dziś trwałego WS do Cloud — cały resident API to HTTPS+JWT
  (`APIClient`), a asystent/proxy do Edge idzie przez `undici` + `TS_HTTP_PROXY`
  (`resident-assistant.controller.ts`). Trzymamy się tego wzorca — zero nowej
  infrastruktury WS po stronie klienta, spójnie z resztą scaffoldu.
- WebRTC sygnalizacja jest krótka (offer/answer + paczka ICE) i toleruje
  request/response. ICE candidates spływające asynchronicznie z Edge odbieramy
  przez **SSE** (`GET .../signal/stream`) — ten sam transport, którym Edge AI
  ma już `/assistant/ask-stream`. Trickle ICE z iOS w górę idzie POST-em.
- Push budzący apkę i tak jest osobnym kanałem (VoIP/APNs), więc nie potrzebujemy
  WS „do dzwonienia".

> OTWARTA DECYZJA D1 (sekcja 9): jeśli latencja zestawienia okaże się za duża,
> wariant B = dedykowany resident WS. Scaffold jest tak ułożony, że transport
> sygnalizacji jest schowany za endpointami `signal` — podmiana nie rusza
> CallManager ani Edge.

### Nowe wiadomości tunelu (Edge ↔ Cloud) — spójne po obu stronach

Dodane do `TunnelAction` (Edge `tunnel.types.ts`) ORAZ obsługiwane w Cloud
`edge.gateway.ts`:

| Akcja | Kierunek | Payload | Opis |
|---|---|---|---|
| `INTERCOM_CALL_INVITE` | Edge→Cloud (EVT) | `{ sessionId, intercomDeviceId, intercomName?, unitId?, unitLabel?, residentIds:number[], snapshotUrl? }` | Akuvox zadzwonił; Edge rozwiązał kogo wołać. Cloud tworzy sesję + VoIP push. |
| `INTERCOM_CALL_ANSWER` | Cloud→Edge (CMD) | `{ sessionId, residentId }` | Mieszkaniec odebrał; Edge zleca Janusowi przygotowanie WebRTC. |
| `INTERCOM_CALL_DECLINE` | Cloud→Edge (CMD) | `{ sessionId, residentId }` | Odrzucenie (lub timeout) — Edge wysyła SIP reject/BYE. |
| `INTERCOM_SIGNAL` | dwukierunkowo | `{ sessionId, kind:'offer'\|'answer'\|'ice', sdp?, candidate?, from:'edge'\|'app' }` | WebRTC SDP/ICE między iOS a Janusem (przez Cloud relay). |
| `INTERCOM_CALL_HANGUP` | Cloud→Edge (CMD) | `{ sessionId, by:'app'\|'caller'\|'system' }` | Rozłączenie inicjowane przez apkę/system. |
| `INTERCOM_CALL_ENDED` | Edge→Cloud (EVT) | `{ sessionId, endReason }` | Janus/Akuvox zakończył; Cloud zamyka sesję + `access_events`. |

### Nowe endpointy Cloud (resident, guard `jwt-resident`)

Prefiks globalny `/api`. Wszystkie za flagą `INTERCOM_CALL_ENABLED` (404/503 gdy
off). Proxy do Edge wzorowane na `resident-assistant.controller.ts` (undici +
`TS_HTTP_PROXY` + `getEdgeIpForBuilding`).

| Metoda + ścieżka | Opis |
|---|---|
| `POST /resident/intercom/voip-token` | Rejestracja **VoIP** push tokenu (PushKit) — osobny od zwykłego APNs. Body `{ token }`. |
| `GET  /resident/intercom/calls/active` | Lista aktywnych/dzwoniących sesji mieszkańca (fallback gdy push zgubiony). |
| `POST /resident/intercom/calls/:id/answer` | Odbierz — wyzwala `INTERCOM_CALL_ANSWER` do Edge. |
| `POST /resident/intercom/calls/:id/decline` | Odrzuć — `INTERCOM_CALL_DECLINE`. |
| `POST /resident/intercom/calls/:id/hangup` | Rozłącz aktywne — `INTERCOM_CALL_HANGUP`. |
| `POST /resident/intercom/calls/:id/signal` | Wyślij offer/answer/ICE od apki → Edge (`INTERCOM_SIGNAL from:app`). |
| `GET  /resident/intercom/calls/:id/signal/stream` | **SSE**: strumień sygnalizacji Edge→apka (answer/ICE `from:edge`). |
| `GET  /resident/intercom/calls/:id/ice-servers` | Lista `iceServers` (STUN + TURN z krótkożyciowymi creds HMAC) dla `RTCConfiguration`. Faza C. |

## 6. Mapowanie domofon → kogo wołać

Z naciśnięcia na panelu wiemy `intercomDeviceId` (Edge device UUID). Łańcuch:

```
Akuvox panel (intercomDeviceId / SIP extension)
  → BuildingIntercom.edgeDeviceId  (schema.prisma:604)         [który domofon]
  → AccessPoint / Unit                                          [który lokal]
  → UnitResident pivot (untilDate IS NULL OR > NOW())           [aktywni lokatorzy]
  → Resident[]                                                  [kogo wołać]
  → PushToken (kanał voip)                                      [na które urządzenia]
```

Istniejące relacje w schemacie, które wykorzystujemy:
- `BuildingIntercom.edgeDeviceId` — link panel → fizyczne urządzenie Edge.
- `Stairwell.units` + `Unit.stairwellId` — domofon klatkowy obsługuje lokale klatki.
- `UnitResident` pivot (`schema.prisma:834`) — kto mieszka w lokalu (z oknem
  ważności jak w `collectPlateSyncItems` LATERAL JOIN — wzorzec do reużycia).
- `PushToken` (`schema.prisma:819`) — rozszerzony o `kind` (`apns`|`voip`).

**Warianty routingu** (OTWARTA DECYZJA D2):
- **Domofon klatkowy → konkretny lokal**: przycisk na panelu = numer lokalu →
  Edge mapuje extension/przycisk → `unitId` → residenci tego lokalu.
- **Brama główna / panel zbiorczy**: jeden przycisk → wołamy wszystkich
  mieszkańców powiązanych z access pointem (lub wybór lokalu na panelu).

Domyślnie scaffold rozwiązuje „domofon → unit → residenci"; gdy brak unit-mapy,
fallback = wszyscy residenci budynku z włączonym `bridgeEnabled` (bezpieczny,
ale szeroki — do zawężenia przy konfiguracji sprzętu).

## 7. Roadmapa fazowa

### Faza A — Szkielet (TA ITERACJA) ✅
- Dokument projektowy (ten plik).
- Prisma `IntercomCallSession` + pola mostu + migracja `20260613090000`.
- Tunnel: 6 nowych akcji intercom (Cloud + Edge spójnie).
- Cloud: stub-endpointy resident (guard OK, logika `TODO`), VoIP push channel
  (stub + `TODO` o certyfikacie/topicu).
- Edge: `IntercomCallService` (orkiestracja) + `MediaBridge` (abstrakcja, impl Janus
  stub) + controller; wpięte za flagą.
- iOS: `VoIPManager`, `CallManager`, `IntercomCallView`, modele — kompilują się
  bez WebRTC (`#if canImport(WebRTC)`), degradują do stub-logów.
- **DoD**: `prisma validate/generate` pass, `tsc` api+edge pass, pliki iOS
  składniowo poprawne i izolowane. Flaga OFF — zero wpływu na prod. **Brak
  sprzętu.**

### Faza B — Media server + SIP terminacja 🟡 KOD GOTOWY (2026-06-14), czeka na sprzęt
Zaimplementowane bez sprzętu (wszystko za flagą, tsc-czyste):
- `JanusMediaBridge` — realny klient HTTP long-poll Janus + `janus.plugin.sip`:
  create→attach→register→long-poll(`incomingcall`/`accepted`/`hangup`/trickle)→
  `accept`/`decline`/`hangup`, relay SDP/ICE. Env `JANUS_HTTP_URL/...`.
- Routing D2 (Cloud `resolveResidentsForInvite`) — pełny, deterministyczny.
- State machine sesji INCOMING→RINGING→ACTIVE→ENDED/MISSED + timeout 35 s +
  first-answer-wins (D5) z CANCEL przez SSE.
- Sygnalizacja Cloud (D1) — działająca: SSE stream + POST signal + relay tunelem.
- VoIP push payload (CallKit: callerName/sessionId/unitLabel/hasVideo/snapshotUrl).
- Provisioning: `infra/intercom/{coturn,janus,akuvox}` (configi + README + plist).

Pliki do uruchomienia na sprzęcie (właściciel):
- Janus na Edge (`infra/intercom/janus/README.md`) + Akuvox web UI
  (`infra/intercom/akuvox/README.md`) + coturn na VPS FRA
  (`infra/intercom/coturn/README.md`).
- **DoD (sprzętowy)**: Akuvox dzwoni → Janus terminuje SIP → `INTERCOM_CALL_INVITE`
  ląduje w Cloud → sesja `RINGING` + VoIP push. (Media iOS = Faza C.)
  **Wymaga: domofon + Janus + (off-site) coturn.**

### Faza C — WebRTC po stronie iOS 🟡 KOD GOTOWY (2026-06-14), czeka na Xcode/sprzęt
Zaimplementowane bez Xcode/frameworka (wszystko za flagą; iOS pisany do API
`stasel/WebRTC` = libwebrtc, weryfikowalny dopiero przy buildzie właściciela;
Cloud tsc-czysty):

- **iOS `CallManager`** — realny `RTCPeerConnection` za `#if canImport(WebRTC)`:
  `RTCPeerConnectionFactory` (audio+wideo decoder), `RTCConfiguration`
  (unifiedPlan, `iceServers` z Cloud), transceiver audio `.sendRecv`
  (mikrofon↑ + audio gościa↓) + wideo `.recvOnly` (gość↓, iPhone NIE publikuje
  kamery = 1-way). Handshake przez ISTNIEJĄCY kanał (POST answer + SSE):
  Janus offerer → `setRemoteDescription(offer)` → `answer` →
  `setLocalDescription` → POST signal; trickle ICE w obie strony. Pełny
  teardown w hangup/cancel/CANCEL (close peer, stop tracki, oddaj audio).
- **iOS `RTCAudioSession`** — tryb manualAudio: kategoria playAndRecord /
  voiceChat ustawiana w `configureAudioSession`, AKTYWACJA dopiero w CallKit
  `didActivate` (obowiązkowy punkt styku CallKit↔WebRTC), zwolnienie w
  `didDeactivate`. `toggleMute` steruje `localAudioTrack.isEnabled`,
  `toggleSpeaker` przez `RTCAudioSession.overrideOutputAudioPort`.
- **iOS `IntercomCallView`** — `RTCMTLVideoView` (Metal) jako `RemoteVideoView:
  UIViewRepresentable` renderujący `CallManager.remoteVideoTrack` gościa;
  fallback placeholder gdy track jeszcze nie przyszedł (audio-only / handshake).
  Bez podglądu własnej kamery (1-way). DesignSystem (GLColor/GLRadius).
- **Ścieżka `#if !canImport(WebRTC)`** dalej kompiluje się jako no-op
  (stub-logi) — to jedyne co weryfikowalne `swiftc -typecheck` bez frameworka.
- **Cloud generator TURN creds (use-auth-secret HMAC)** — `TurnCredentialsService`
  (`apps/api/src/resident/turn-credentials.service.ts`): `username =
  "{expiryUnix}:{subject}"`, `password = base64(HMAC_SHA1(TURN_STATIC_SECRET,
  username))`, TTL 3600s. Endpoint `GET /resident/intercom/calls/:id/ice-servers`
  (guard jwt-resident, za flagą) zwraca STUN publiczny + TURN budynku z creds.
  Brak `TURN_STATIC_SECRET`/`turnUrl` → sam STUN (LAN OK, off-site nie). Gdy
  coturn na `lt-cred-mech` → service podaje statyczne `BuildingIntercom.turn*`.

Pliki do uruchomienia (właściciel, sekcja 8.4–8.7 niżej): SPM `stasel/WebRTC`,
3 pliki Swift do targetu, capabilities (voip+audio), VoIP cert/topic, env
`TURN_STATIC_SECRET` + `BuildingIntercom.turnUrl`, coturn na VPS FRA.
- **DoD (sprzętowy)**: mieszkaniec odbiera na iPhonie, słyszy + widzi gościa,
  gość słyszy mieszkańca, on-site i off-site. **Wymaga: TURN, build w Xcode,
  VoIP push cert, domofon + Janus.**

### Faza D — Twardzenie 🛡️
- Reconnect/retry sygnalizacji, timeouty (np. 30 s no-answer → MISSED + push
  „nieodebrane"), wiele urządzeń mieszkańca (first-answer wins, reszta CallKit
  end), DND/cisza nocna (reużyj `setDnd`), audyt + statystyki połączeń,
  otwieranie bramy z ekranu połączenia (reużyj `OPEN_DOOR`/`HOLD_OPEN`).
- **DoD**: edge-case'y pokryte, e2e test scenariusz, metryki w BA panelu.

## 8. KROKI MANUALNE / SPRZĘTOWE dla właściciela

### 8.1 Akuvox (web UI domofonu)
- Account → SIP: server = IP Edge (np. `192.168.1.127`), port `5060`, user/pass.
- Codec: audio PCMU+PCMA(+G.722), wideo H.264.
- Przycisk wywołania → extension/numer routujący na lokal (patrz sekcja 6).
- (Opcjonalnie) DTMF RFC2833 dla otwierania bramy z połączenia.

### 8.2 Media server (Janus) na Edge (Mac Mini)
- Instalacja: `brew install janus` (lub build ze źródeł janus-gateway) +
  zależności (libnice, libsrtp, usrsctp, libwebsockets).
- Włącz `janus.plugin.sip` (`janus.plugin.sip.jcfg`) + transport HTTP/WebSocket
  (`janus.transport.http.jcfg` / `...websockets.jcfg`).
- Admin API: ustaw `admin_secret`, wystaw na `127.0.0.1` (NestJS łączy się
  lokalnie). NIE wystawiaj Admin API na LAN/WAN.
- Uruchom jako usługa (launchd plist analogicznie do
  `com.gatelynk.edge.plist` / `com.gatelynk.yolo.plist`).
- W Edge `.env`: `INTERCOM_CALL_ENABLED=true`, `JANUS_ADMIN_URL`,
  `JANUS_ADMIN_SECRET`, `JANUS_SIP_REALM`.

### 8.3 TURN/STUN (coturn) — off-site relay
- Hosting: **publiczny VPS** (nie Edge — Edge jest za NAT-em LAN). Rekomendacja:
  mała instancja w tym samym regionie co Cloud (FRA) albo na Synology z
  publicznym portem (patrz `reference_synology`). coturn: porty `3478/udp+tcp`
  (+ `5349` TLS), zakres relay `49152–65535/udp`.
- Konfiguracja: `realm`, `use-auth-secret` + `static-auth-secret` (TURN REST
  API — Cloud generuje krótkożyciowe creds HMAC, sekcja niżej). `turnserver.conf`
  w repo (`infra/intercom/coturn/`) JEST na `use-auth-secret` — generator Cloud
  pasuje do tego. Alternatywa `lt-cred-mech` (statyczne user/pass) jest
  zakomentowana w configu — wtedy wpisz `turnUsername/turnPassword` ręcznie do
  `BuildingIntercom`, a Cloud poda je bez HMAC (`turnSource:'static'`).
- **Env w Cloud (Fly):** `TURN_STATIC_SECRET` MUSI być identyczny z
  `static-auth-secret` w `turnserver.conf`:
  ```bash
  openssl rand -hex 32                              # wygeneruj raz
  flyctl secrets set TURN_STATIC_SECRET=<hex> -a gatelynk-api
  # ten sam <hex> wstaw jako static-auth-secret w turnserver.conf na VPS
  ```
- **Per-budynek:** ustaw `BuildingIntercom.turnUrl` (np.
  `turn:turn-fra.gatelynk.com:3478`) + `bridgeEnabled=true`. Generator Cloud
  (`TurnCredentialsService`) bierze `turnUrl` stamtąd i dokleja świeże
  username/password (HMAC-SHA1, TTL 3600s) per żądanie ice-servers.
- iOS dostaje `iceServers` przez `GET /api/resident/intercom/calls/:id/ice-servers`
  (STUN publiczny + TURN z creds). Janus po stronie Edge dostaje TURN tą samą
  drogą (te same `static-auth-secret`/`realm`) lub przez `nat_1_1_mapping` —
  ustaw żeby zgłaszał osiągalne candidate.
- **Bez konfiguracji TURN** (`TURN_STATIC_SECRET` lub `turnUrl` puste) endpoint
  zwraca SAM STUN → on-site/LAN działa, off-site (symetryczny NAT) NIE. To
  bezpieczny default za flagą.

### 8.4 Xcode — pliki do dodania do targetu `GateLynk` (NIE Glass)
3 pliki Swift Fazy A/B/C (File → Add Files to "GateLynk", **tylko target
GateLynk**, „Copy items if needed" = OFF, bo już są w drzewie):
- `apps/ios/GateLynk/Services/VoIPManager.swift`
- `apps/ios/GateLynk/Services/CallManager.swift`  (Faza C — realny RTCPeerConnection)
- `apps/ios/GateLynk/Views/Resident/IntercomCallView.swift`  (Faza C — RTCMTLVideoView)
- (`Models/Models.swift` już w targecie — tylko edytowany, nic do dodania.)

> Pułapka pbxproj (CLAUDE.md #12): pliki dodajemy RĘCZNIE w Xcode (File → Add
> Files), **NIE** edytujemy `project.pbxproj` tekstowo/skryptem — phantom refs
> wywalają build. Po dodaniu: `plutil -lint apps/ios/GateLynk.xcodeproj/project.pbxproj`.
> Pliki są self-contained — cały kod WebRTC za `#if canImport(WebRTC)`, więc
> dodanie ich do targetu PRZED dodaniem pakietu SPM dalej się kompiluje (no-op).

### 8.5 WebRTC przez SPM
- Xcode → File → Add Package Dependencies →
  `https://github.com/stasel/WebRTC` (prebuilt XCFramework, dobry dla iOS 17).
  - Alternatywa: Google `https://github.com/webrtc-sdk/Specs` (CocoaPods) lub
    własny build libwebrtc — cięższe. Rekomendacja: `stasel/WebRTC`.
- Dodaj produkt `WebRTC` do targetu `GateLynk`. Bez tego kroku kod
  `CallManager`/`IntercomCallView` kompiluje się jako no-op (`#if canImport(WebRTC)`).
- Kod używa publicznego API libwebrtc (identyczne w `stasel/WebRTC`):
  `RTCPeerConnectionFactory`, `RTCConfiguration`, `RTCIceServer`,
  `RTCSessionDescription`, `RTCIceCandidate`, `RTCRtpTransceiver(Init)`,
  `RTCAudioSession`/`RTCAudioSessionConfiguration`, `RTCMTLVideoView`,
  `RTCVideoTrack`. Po dodaniu pakietu te symbole się rozwiążą i media się włączy
  — przed tym `swiftc -typecheck` przechodzi tylko dla ścieżki bez WebRTC.
- **Flow ICE servers**: po odebraniu `CallManager.startWebRTC` woła
  `GET /api/resident/intercom/calls/:id/ice-servers` (sekcja 5) → dostaje STUN +
  TURN z krótkożyciowymi creds → wstrzykuje do `RTCConfiguration.iceServers`.
  Bez TURN (brak `TURN_STATIC_SECRET`/`turnUrl`) działa tylko on-site (STUN/LAN).

### 8.6 Capabilities / entitlements / Info.plist (target GateLynk)
- **Signing & Capabilities → Background Modes**: zaznacz `Voice over IP` (voip)
  oraz `Audio, AirPlay, and Picture in Picture` (audio). To dopisuje do
  `Info.plist`:
  ```xml
  <key>UIBackgroundModes</key><array><string>voip</string><string>audio</string></array>
  ```
- **Push Notifications** capability (już jest `aps-environment`).
- **Info.plist usage strings** — TYLKO mikrofon (2-way audio):
  ```xml
  <key>NSMicrophoneUsageDescription</key>
  <string>Mikrofon jest używany do rozmowy z gościem przy domofonie.</string>
  ```
  **`NSCameraUsageDescription` NIE jest potrzebny.** Wideo jest 1-way
  (`recvOnly`): iPhone NIE publikuje kamery, `CallManager` nie tworzy
  `RTCCameraVideoCapturer` ani local video track, więc libwebrtc nigdy nie
  poprosi o `AVCaptureDevice` kamery → iOS nie wymaga camera-usage stringa.
  (Dodanie go nie szkodzi, ale jest mylące — App Review pyta po co kamera.)
- Background mode `voip` jest WYMAGANY żeby PushKit dostarczał VoIP push przy
  zablokowanym/uśpionym ekranie; `audio` żeby media WebRTC grało w tle podczas
  rozmowy. Bez nich połączenie nie zadziała na realnym urządzeniu.

### 8.7 VoIP push (PushKit) — osobny flow od zwykłego APNs
- VoIP push to **osobny token** (`PKPushRegistry`, typ `.voip`) i **osobny
  topic** APNs = `<bundleId>.voip`.
- Cert/key: ten sam APNs **Auth Key (.p8)** co zwykły push działa dla VoIP —
  różnica jest w `apns-topic` (`...voip`) i `apns-push-type: voip`. Nie trzeba
  osobnego certyfikatu p12, ale **provisioning profile musi mieć włączone Push
  Notifications + (zalecane) PushKit** i App ID z aps-environment.
- Cloud `PushService.sendVoip(...)` (scaffold) używa istniejącego
  `apn.Provider`, ale ustawia `note.topic = bundleId + '.voip'` i
  `note.pushType = 'voip'`. Token VoIP zapisywany w `push_tokens.kind='voip'`.
- W produkcji VoIP push **musi** natychmiast zgłosić CallKit (wymóg Apple od
  iOS 13) — inaczej system ubije apkę i zablokuje kolejne VoIP pushe.

### 8.8 Checklista uruchomienia end-to-end (kolejność)

Kod (Fazy A/B/C) jest gotowy i za flagą. Żeby zrealizować realne połączenie:

1. **Sprzęt media (Faza B DoD):** Janus na Edge (`infra/intercom/janus/README.md`)
   + Akuvox web UI (`infra/intercom/akuvox/README.md`, sekcja 8.1). Test:
   przycisk na panelu → Janus `incomingcall`.
2. **coturn na VPS FRA** (off-site): `infra/intercom/coturn/README.md`. Wygeneruj
   `static-auth-secret` (`openssl rand -hex 32`), podmień placeholdery w
   `turnserver.conf`, otwórz porty 3478/5349 + relay 49152-65535/udp.
3. **Cloud env:** `flyctl secrets set INTERCOM_CALL_ENABLED=true
   TURN_STATIC_SECRET=<ten sam hex> -a gatelynk-api`. Migracja
   `20260613090000` już applied (Faza A) — nic nowego do migrowania w Fazie C.
4. **Dane budynku:** ustaw `BuildingIntercom.bridgeEnabled=true`,
   `turnUrl='turn:turn-fra...:3478'`, `edgeDeviceId` = UUID panelu (routing D2).
5. **Xcode (sekcja 8.4/8.5):** dodaj 3 pliki Swift do targetu GateLynk ręcznie,
   dodaj pakiet SPM `stasel/WebRTC` (produkt `WebRTC`). `plutil -lint` na pbxproj.
6. **Capabilities (8.6):** Background Modes voip+audio, Push Notifications,
   `NSMicrophoneUsageDescription` w Info.plist. (Camera — NIE.)
7. **VoIP push (8.7):** App ID z Push; w Cloud `APN_AUTH_KEY/KEY_ID/TEAM_ID/
   BUNDLE_ID` (już używane do APNs) — `sendVoipToResident` doda topic `.voip`.
8. **Build na urządzeniu** (NIE symulator — PushKit/CallKit/mikrofon wymagają
   fizycznego iPhone'a). Zaloguj się jako mieszkaniec; `VoIPManager` zarejestruje
   token VoIP (POST `/voip-token`).
9. **Test on-site:** mieszkaniec w LAN, naciśnij panel → VoIP push → CallKit →
   Odbierz → słychać+widać gościa, gość słyszy mieszkańca (ICE host/STUN).
10. **Test off-site:** mieszkaniec poza LAN (LTE) → to samo, media przez TURN
    relay. Sprawdź log Cloud `iceServers ... turn=hmac` + coturn relay alloc.

## 9. OTWARTE DECYZJE (do rozstrzygnięcia przez właściciela)

- **D1 — Transport sygnalizacji Cloud↔iOS.** ✅ ROZSTRZYGNIĘTE (2026-06-13):
  **HTTPS POST + SSE** (default scaffold — spójne z istniejącym resident API,
  zero nowego WS po stronie klienta). Dedykowany WS odłożony do ewentualnej
  optymalizacji latencji w przyszłości.
- **D2 — Routing przycisku panelu → lokal.** ✅ ROZSTRZYGNIĘTE (2026-06-13):
  default — domofon→unit→residenci; fallback = wszyscy `bridgeEnabled` w budynku.
  Konfiguracja przycisków Akuvox mapuje przycisk → `unitId`; „brama główna" bez
  przypisanego lokalu woła wszystkich powiązanych z `bridgeEnabled`.
- **D3 — Hosting TURN.** ✅ ROZSTRZYGNIĘTE (2026-06-13): **VPS — region Frankfurt
  (FRA)**. coturn na publicznym VPS, porty 3478/5349 + relay 49152-65535; creds →
  `BuildingIntercom.turnUrl/turnUsername/turnPassword`.
- **D4 — Transcoding wideo.** Zakładamy H.264 passthrough (Akuvox i iOS oba
  H.264). Jeśli konkretny firmware Akuvox negocjuje inaczej — może być potrzebny
  transcoding w Januszie (koszt CPU na Mac Mini) lub przejście na FreeSWITCH.
- **D5 — Wiele urządzeń mieszkańca / wielu mieszkańców.** ✅ ZAIMPLEMENTOWANE
  (Faza B, 2026-06-14): first-answer-wins przez atomowy `updateMany` na
  `answeredById IS NULL` (Cloud). Przegrane urządzenia + timeout/koniec dostają
  sygnał **CANCEL** przez SSE (`kind:'ice'` z `candidate.cancel=true, reason`) →
  iOS kończy CallKit (`CXEndCallAction`, reason `answeredElsewhere`). Endpoint
  `answer` zwraca `{ won }` żeby apka wiedziała od razu (bez czekania na SSE).

### Decyzje rozstrzygnięte w Fazie B (2026-06-14)

- **D6 — Routing D2: który model domofonu = jaka pula mieszkańców.** Rozwiązuje
  Cloud (`IntercomCallService.resolveResidentsForInvite`), bo mapa unit→resident
  żyje w Postgres. Łańcuch: (1) przycisk→`buttonUnitId`/`unitId` = tylko ten
  lokal; (2) `intercomDeviceId`→`BuildingIntercom.edgeDeviceId` (brama zbiorcza)
  = wszyscy mieszkańcy budynku; (3) `StairwellIntercom` po `config->>'edgeDeviceId'`
  = mieszkańcy klatki; (4) fallback = wszyscy mieszkańcy budynku **o ile**
  którykolwiek domofon ma `bridgeEnabled=true` (bezpiecznik). Aktywne okno
  `unit_residents.untilDate IS NULL OR > NOW()` (jak `collectPlateSyncItems`).
  > OTWARTE: mapa SIP-extension/relayIndex → `unitId` po stronie Edge
  > (`buttonUnitId`) nie jest jeszcze wypełniana — Edge zawsze wysyła
  > `intercomDeviceId`, więc domofon klatkowy póki co woła całą klatkę. Domknąć
  > gdy Akuvox potwierdzi format per-przyciskowych extensions na sprzęcie.

- **D7 — TURN autoryzacja.** ✅ ZAIMPLEMENTOWANE (Faza C, 2026-06-14). Wybrany
  `use-auth-secret` (TURN REST API, krótkożyciowe HMAC creds) —
  `infra/intercom/coturn/turnserver.conf`. Generator HMAC w Cloud
  (`apps/api/src/resident/turn-credentials.service.ts`): `username =
  "{expiryUnix}:{sessionId-residentId}"`, `password = base64(HMAC_SHA1(
  TURN_STATIC_SECRET, username))`, TTL 3600s. iOS pobiera przez
  `GET /resident/intercom/calls/:id/ice-servers` (per żądanie, świeże creds).
  Fallback: brak secretu/`turnUrl` → sam STUN; coturn `lt-cred-mech` →
  statyczne `BuildingIntercom.turn*` (`turnSource:'static'`). Wszystko za flagą.
  > OTWARTE: te same `iceServers` musi dostać Janus na Edge. Dziś generator
  > obsługuje iOS; Janus konfiguruje TURN własnym configiem z tym samym
  > `static-auth-secret`/`realm` (albo `nat_1_1_mapping`). Domknąć przy realnym
  > teście off-site na sprzęcie (czy Janus zgłasza relay candidate).

- **D8 — Timeout no-answer.** 35 s (`IntercomCallService.RINGING_TIMEOUT_MS`).
  RINGING > 35 s → `MISSED` + `INTERCOM_CALL_DECLINE(reason:TIMEOUT)` do Edge +
  CANCEL do urządzeń. Konfigurowalne stałą.

- **D9 — Janus transport sterowania.** HTTP long-poll (nie WS) —
  `JanusMediaBridge` używa `axios` (Edge już zależy). `JANUS_HTTP_URL` na
  `127.0.0.1:8088/janus`, Admin API 8089 osobno (tylko monitoring). Bez
  `JANUS_HTTP_URL` most jest STUB-em (Edge startuje normalnie).

## 10. Następna faza po zatwierdzeniu

Po akceptacji szkieletu i ustawieniu sprzętu: **Faza B** (Janus + Akuvox SIP) —
implementacja `JanusMediaBridge` przeciw realnemu Admin API, tak aby
`INTERCOM_CALL_INVITE` realnie wpadał do Cloud po naciśnięciu panelu. To
pierwszy krok dający namacalny sygnał end-to-end bez ruszania iOS media.

## 11. Multi-station — N stacji per budynek (2026-07-05)

Rozszerzenie całej ścieżki rozmów na wiele stacji (np. 3× R29: „Wejście
główne", „Brama wschodnia", „Klatka B"). Bez zmian schematu — `BuildingIntercom`
miał już `name/edgeDeviceId/bridgeEnabled` per stacja.

### Architektura

```
R29 #1 (192.168.1.100) ─┐  SIP INVITE (direct-IP)   fromUri zawiera IP stacji
R29 #2 (192.168.1.101) ─┼───────► Janus (1 handle SIP, guest) ──► Edge
R29 #3 (192.168.1.102) ─┘         │ IntercomCallService:
                                  │  fromUri→IP→intercom_bridge/device_config
                                  │  → intercomDeviceId=UUID + intercomName
                                  ▼
                       INTERCOM_CALL_INVITE { intercomDeviceId, intercomName }
                                  ▼
              Cloud: BuildingIntercom.edgeDeviceId match → bridgeEnabled?
                     → routing D2 → VoIP push z NAZWĄ stacji → iOS CallKit
```

- **Tożsamość stacji (incoming):** Edge mapuje SIP fromUri (IP Akuvoxa) na
  UUID urządzenia + nazwę stacji i wysyła w INVITE. Cloud dopasowuje
  `BuildingIntercom.edgeDeviceId` (gating `bridgeEnabled` per stacja) —
  sesja + VoIP push niosą nazwę TEJ stacji (CallKit + UI). Fallback: stary
  Edge wysyła surowy fromUri → routing spada na fallback-building (jak dotąd).
- **Rejestr stacji Cloud→Edge:** `INTERCOM_SYNC_ALL` (wzorzec *_SYNC_ALL) —
  mirror `building_intercoms` → Edge sqlite `intercom_bridge`. Push przy
  reconnect (`pushAccessPointSync`) + live po edycji w panelu Integratora
  (`IntegratorService.updateIntercom`). Zero ręcznej konfiguracji na Edge.
- **Outbound (mieszkaniec→stacja):** `GET /resident/intercom/stations` zwraca
  stacje z mostem; iOS przy >1 pokazuje wybór (confirmationDialog), POST
  `call-station` przyjmuje `{ intercomId }`. Bez `intercomId`: 1 stacja = jak
  dotąd (backward-compat), >1 = 400 `STATION_CHOICE_REQUIRED` z listą.
- **Panel Integratora:** IntercomsModule — toggle „Rozmowy: ON/OFF"
  (bridgeEnabled) per stacja + zmiana nazwy inline (nazwa = to co widzi
  mieszkaniec na ekranie połączenia).

### Ograniczenie równoległości (świadome)

Janus SIP plugin na Edge ma **jeden handle = jedna aktywna rozmowa na
budynek** (wszystkie stacje dzwonią direct-IP na ten sam handle). Dwie
równoległe rozmowy z dwóch stacji NIE są wspierane:

- **Incoming podczas rozmowy:** Janus sam odpowiada 486 Busy (gość słyszy
  zajętość), emituje `missed_call` → Edge wysyła EVT `INTERCOM_STATION_BUSY`
  (audit w logach Cloud). Sesja nie powstaje.
- **Outbound podczas rozmowy:** Cloud busy-guard (aktywna sesja w budynku,
  okno 10 min) → 409 `STATION_BUSY` („Stacja zajęta — trwa inne połączenie").
  Race złapany na Edge → `INTERCOM_CALL_ENDED reason=STATION_BUSY` → iOS
  pokazuje komunikat.
- Zniesienie limitu = osobne handle SIP per stacja (Janus `helper` sessions)
  — zaplanować w Fazie D jeśli klient wymaga równoległych rozmów.

### TURN przy wielu stacjach

`TurnCredentialsService` bierze `turnUrl` z PIERWSZEJ stacji z
`bridgeEnabled=true AND turnUrl IS NOT NULL` — TURN jest per-budynek
(wspólny coturn FRA), więc przy 3 stacjach wystarczy ustawić `turnUrl` na
jednej (zalecane: na wszystkich, dla czytelności). Nic nie jest hardcoded
na Villa Naturę: nowy budynek = nowe wiersze `building_intercoms` + ten sam
`TURN_STATIC_SECRET`.

### Kolejność wdrożenia (ważne!)

1. **Przed deployem Edge**: upewnij się że wiersz `building_intercoms`
   każdej stacji ma poprawny `edgeDeviceId` (UUID z rejestru urządzeń Edge)
   i `bridgeEnabled=true`. Po zmianie Edge wysyła UUID zamiast fromUri —
   Cloud dopasuje KONKRETNĄ stację i jej `bridgeEnabled` decyduje o
   dzwonieniu (dotąd: fallback „jakikolwiek most w budynku").
2. Deploy Cloud (obsługuje stare i nowe payloady INVITE).
3. Deploy Edge (restart Janus PRZED Edge — gotcha Villa Natura).
4. iOS — nowa apka z wyborem stacji; stara apka działa przy 1 stacji.

## 12. R29 vs E18C — matryca różnic + konfiguracja krok po kroku (2026-07-08)

Live-test z podłączoną fizycznie kasetą **Akuvox R29** (LAN `192.168.1.109`,
MAC `0c:11:05:0d:4c:89`, **firmware 29.30.10.128**, HW 29.3.4, MODELID=29)
obok istniejącej stacji **E18C** (`192.168.1.100`, ekran dotykowy 7"). To jest
runbook pod MVP „3× R29 u klienta".

### 12.1 Matryca różnic (zweryfikowana na sprzęcie)

| Cecha | E18C (`.100`) — DZIAŁA prod | R29 (`.109`) — fw 29.30.10.128 |
|---|---|---|
| **OpenDoor High-Security** `GET /fcgi/OpenDoor?action=OpenDoor&DoorNum={relay+1}` (digest, hasło API) | ✅ retcode 0 (log Edge „✅ Akuvox OpenDoor OK") | ❌ **HTTP 503** (lighttpd) — endpoint zablokowany DOPÓKI na urządzeniu nie włączysz „Open Relay via HTTP" |
| **OpenDoor legacy** `GET /fcgi/do?action=OpenDoor` | n/d (używa HS) | ❌ `"please use new interface"` |
| **Fast snapshot HTTP** `:8080/picture.jpg` (digest, hasło API) | ✅ ~195 KB, ~50 ms (log „Akuvox HTTP snapshot OK") | ❌ 401 (hasło API nieustawione/niewłączone) |
| **GetSnapshot** `/fcgi/do?action=GetSnapshot` | (nieużywane) | ❌ zwraca formularz HTML 88 B, NIE JPEG |
| **Snapshot fallback RTSP** `rtsp://IP:554/live/ch00_0` | ✅ | ✅ **~68 KB, ~900 ms** (Edge automatycznie fallbackuje — działa) |
| **RTSP DESCRIBE** `live/ch00_0` / `live/ch01_0` | ✅ | ✅ 200 (oba streamy) |
| **SIP tryb** | account mode → wymaga lokalnego **sip-proxy :5062** (REGISTER „door") | direct-IP → INVITE prosto do Janusa `:5060`, **user-part niesiony** (patrz 12.3) |
| **Remote Phonebook** | ❌ brak (kontakty przez import `UserData.tgz`) | ✅ **MA** (Phone → Remote Phonebook URL → Cloud endpoint D6) |
| Panel web / logowanie | stare `do?action=Encrypt` → `CreateSession` | to samo (Base64(rand+hasło) → PostEncode backtick-escape) |

**Wniosek nr 1 (KRYTYCZNY dla MVP):** na R29 z fabryki OpenDoor przez HTTP jest
WYŁĄCZONY (503). Sterownik Edge (branch Akuvox high-security w
`intercom.service.ts`) działa identycznie jak dla E18C, ale urządzenie odrzuca
żądanie. Trzeba **włączyć relay-over-HTTP w panelu R29** (12.2 krok 4) —
inaczej „Otwórz" z apki/portiera/PIN/LPR nie zadziała mimo że Edge loguje próbę.

**Wniosek nr 2:** snapshot na R29 działa TYLKO przez RTSP fallback (wolniejszy).
Żeby mieć szybki HTTP snapshot (~50 ms) jak E18C, trzeba ustawić hasło API na
R29 i podać je Edge jako `rtspPassword` w configu urządzenia (dziś puste →
driver używa domyślnego `admin`, które R29 odrzuca).

### 12.2 Konfiguracja R29 krok po kroku (panel web `https://<ip>`)

1. **Login**: `admin` / hasło web. R29 szyfruje: `Base64(randStr+hasło)` →
   PostEncode (backtick-escape `&`→`` `B ``, `=`→`` `C ``, `+`→`` `K ``) →
   POST `SubmitData` do `fcgi/do?id=1` z `Operation=CreateSession`.
2. **Sieć**: statyczne IP w podsieci LAN Edge (`192.168.1.x`), brama, DNS.
3. **SIP (Account)**: serwer = LAN IP Edge/Janusa (`192.168.1.127`), port `5060`,
   transport UDP. R29 dzwoni direct-IP — user-part = numer z książki (12.3).
4. **Relay → „Open Relay via HTTP" (KLUCZOWE)**: Intercom → Relay → włącz
   HTTP command dla OpenDoor i ustaw HTTP username/password. To hasło podaj
   Edge jako `rtspPassword` (pole „hasło API"). Bez tego kroku HS OpenDoor = 503.
5. **Remote Phonebook**: Phone → Remote Phonebook → URL (endpoint D6 — żyje
   w CHMURZE, NIE na Edge; R29 pobiera go przez internet):
   `https://gatelynk-api.fly.dev/api/intercom/phonebook?b=<buildingId>&t=<token>&host=<edge-lan-ip>`
   (dla Villa Natura b=9, host=192.168.1.127 — `host` to IP Edge do dzwonienia,
   NIE adres pobierania). Zwraca XML `<Directory>` z
   `<Contact Office="unitId@host"/>`. Dotknięcie kontaktu → INVITE do Janusa
   z user-part = `unitId`.
6. **RTSP**: domyślne `live/ch00_0` na `:554` — Edge już to zna.

### 12.3 SIP direct-IP niesie user-part — punktowe dzwonienie bez sip-proxy

Cloud endpoint D6 (`apps/api/src/resident/intercom-phonebook.controller.ts`)
generuje `Office="<unitId>@<edgeLanIp>"`. Gdy gość dotknie kontaktu, R29 wysyła
INVITE na `sip:<unitId>@<edgeLanIp>:5060`. Janus terminuje →
`IntercomCallService.onIncomingCall` czyta `toExtension = unitId` →
`dialedExtension` → Cloud routuje do mieszkańców TEGO lokalu
(`intercom-call.service.ts:237` dopasowuje ext do unitu). **Dzięki temu R29 nie
potrzebuje sip-proxy :5062** (który E18C potrzebował w account mode). Mapowanie
która stacja dzwoni: `resolveStationByIp` po źródłowym IP INVITE
(`intercom_bridge` → fallback `device_config`).

> Weryfikacja na żywo (2026-07-08): SIP i Remote Phonebook wymagają device-side
> konfiguracji panelu R29 (kroki 3–5); w logach Edge/sip-proxy nie było jeszcze
> INVITE/REGISTER z `.109` (ostatni ruch sip-proxy `.100`/„door" 2026-06-23).
> Architektura i endpoint D6 potwierdzone w kodzie; ostateczny test end-to-end
> po wciśnięciu przycisku wymaga fizycznego dostępu do kasety.

### 12.4 Sterownik — stan i rekomendacje

- `packages/device-drivers/src/catalog/akuvox.ts`: R29/R29C/E16* były już na
  liście; dodano **E18C/E18** (żeby `resolveDriver` mapował E18C po korekcie
  metadanych) + `knownIssues` z ustaleniami fw 29.30.10.128.
- OpenDoor i fast-snapshot w `intercom.service.ts` / `device-registry.service.ts`
  są **manufacturer-keyed** (`manufacturer.includes('akuvox')`), więc zmiana
  `model` na E18C NIE psuje E18C, a R29 używa tej samej ścieżki. Problem R29
  (503 / 401) jest **device-side** (włącz relay-HTTP + hasło API), nie w kodzie.
- Rekomendacja przed MVP: driver mógłby po niepowodzeniu HS OpenDoor spróbować
  wariantów i zapamiętać działający per-urządzenie — ale dopóki relay-HTTP na
  R29 nie jest włączony, ŻADEN wariant nie zadziała. Priorytet = checklista
  device-side (12.2 krok 4), nie kod.
