# Akuvox — konfiguracja domofonu (web UI) dla połączeń ↔ iOS

Krok-po-kroku konfiguracja panelu Akuvox (R29/R20/E16/S5xx) żeby dzwonił do
Janusa na Edge. Projekt:
[`docs/intercom-akuvox-call.md`](../../../docs/intercom-akuvox-call.md), sekcja
3 i 8.1.

Wszystko za flagą `INTERCOM_CALL_ENABLED` w Cloud/Edge — sama konfiguracja
Akuvoxa nic nie psuje (PIN-y/Action URL z Fazy 2 działają niezależnie).

---

## 0. Dostęp do web UI

Przeglądarka → `http://<IP_AKUVOXA>` (login admin, hasło z etykiety/seedu).
LAN IP panelu zna Edge (`device_config`) — patrz panel Integratora → Devices.

## 1. Konto SIP → Janus na Edge

`Account → SIP` (Account 1):

| Pole | Wartość |
|------|---------|
| Status / Enable | **On** |
| Display Label | np. `Brama główna` |
| Register Name / User Name | `edge` (część przed `@` z `JANUS_SIP_IDENTITY`) |
| Password | hasło konta SIP (`JANUS_SIP_SECRET`) — gdy używasz registrara |
| SIP Server 1 (Address) | **LAN IP Edge / Mac Mini** (np. `192.168.1.127`) |
| SIP Server 1 (Port) | `5060` |
| Transport | UDP (lub TCP — zgodnie z `janus.plugin.sip.jcfg`) |
| Registration Period | 3600 |

> **Direct-IP (bez registrara)** — prościej do pierwszych testów: pomiń
> Register Name/Password, a w mapowaniu przycisku (sekcja 3) wpisz pełny
> `sip:edge@<IP_EDGE>:5060`. Wtedy w Edge `.env` pomiń `JANUS_SIP_IDENTITY`
> (plugin rejestruje się jako guest).

## 2. Kodeki

`Account → Codec` (audio) i `Phone → Call Feature`/`Codec` (wideo):

- **Audio**: włącz **PCMU (G.711µ)**, **PCMA (G.711a)**, opcjonalnie **G.722**
  (HD audio). Kolejność preferencji dowolna — Janus negocjuje wspólny.
- **Wideo**: **H.264** (Baseline lub Main profile). Rozdzielczość/bitrate
  dopasuj do uploadu w LAN — np. **720p, 1–2 Mbps** (TURN ma `max-bps=3 Mbps`).
  H.264 passthrough (D4) — bez transcodingu po stronie Janusa.

## 3. Mapowanie przycisku panelu → lokal (routing D2)

To realizuje routing **D2** (domofon → unit → mieszkańcy). Dwa warianty:

### a) Domofon klatkowy → konkretny lokal
`Interphone / Push Button` (nazwa zależy od modelu): każdemu przyciskowi/
pozycji na liście lokatorów przypisz numer dzwoniący na właściwy lokal.

- Jeśli Akuvox potrafi wysłać **SIP extension per przycisk** (np.
  `sip:unit15a@<IP_EDGE>`), Edge zmapuje extension → `unitId` i przekaże
  `buttonUnitId` w `INTERCOM_CALL_INVITE`. Cloud zawęzi routing do tego lokalu.
- Mapowanie extension→unitId trzymane jest na Edge (TODO Faza B: tabela/konfig
  na Edge; dziś Cloud rozwiązuje po `intercomDeviceId` → wszyscy mieszkańcy
  klatki/budynku jako fallback).

### b) Brama główna / panel zbiorczy → wszyscy
Jeden przycisk wywołania → jedno konto SIP. Cloud routuje na **wszystkich
mieszkańców budynku** powiązanych z domofonem który ma `bridgeEnabled=true`
(`BuildingIntercom`). Nie trzeba per-przyciskowej mapy.

> W panelu GateLynk (Integrator/BA): ustaw `BuildingIntercom.bridgeEnabled=true`
> dla tego domofonu — bez tego Cloud NIE zadzwoni do nikogo (bezpiecznik D2).

## 4. (Opcjonalnie) DTMF do otwierania bramy z połączenia

`Account → Advanced → DTMF`: typ **RFC2833**. Pozwala mieszkańcowi otworzyć
bramę z ekranu połączenia (reużycie istniejącego `OPEN_DOOR`/relay). Faza D —
iOS musi wysłać DTMF/`OPEN_DOOR`; na razie tylko przygotowanie po stronie panelu.

## 5. (Już skonfigurowane w Fazie 2) Action URL dla PIN-ów

Jeśli ten panel obsługuje też PIN-y gości/mieszkańców (Faza 2/8.a), Action URL
→ `http://<IP_EDGE>:4000/akuvox/event` zostaje **bez zmian**. Połączenia
domofonowe (ta faza) i PIN-y to niezależne ścieżki — nie kolidują.

## 6. Weryfikacja

1. Edge + Janus uruchomione, `INTERCOM_CALL_ENABLED=true`,
   `BuildingIntercom.bridgeEnabled=true`.
2. Naciśnij przycisk wywołania na panelu.
3. Oczekiwane:
   - Janus log: `incomingcall from=sip:...`
   - Edge log: `INTERCOM_CALL_INVITE → Cloud session=...`
   - Cloud log: `INVITE [b#X] session=... via=... → N resident(s)`
   - DB `intercom_call_sessions`: nowy wiersz `RINGING`.
   - (Faza C) iPhone: CallKit pokazuje przychodzące połączenie.
