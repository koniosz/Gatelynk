# Przepustka wyjazdowa (Exit Grace Pass) — koncepcja

> Zgłoszenie (Konrad, 2026-07-30): pojazd spoza białej listy (taxi, Frisco itp.),
> który już wjechał na osiedle, powinien móc wyjechać: kamera wyjazdowa
> rozpoznaje tablicę i otwiera szlaban, jeśli od wjazdu minęło ≤ 15 minut.

## 1. Zasada działania (happy path)

```
WJAZD                                  WYJAZD
Kamera IN czyta XY12345                Kamera OUT czyta XY12345
  └─ brak na białej liście              └─ brak na białej liście
  └─ LPR_NO_MATCH dir=IN (jak dziś)     └─ NOWE: sprawdź exit_passes
  └─ NOWE: utwórz przepustkę               └─ ważna (≤15 min)? → OTWÓRZ
     {plate, enteredAt,                    └─ zużyj przepustkę (single-use)
      expiresAt = +15 min}                 └─ access_event: EXIT_PASS_USED
```

Jak pojazd spoza listy w ogóle wjeżdża: mieszkaniec otwiera z apki, wizyta
kurierska (accept), wjazd „na ogonie" za innym autem, harmonogram otwartej
bramy. **W każdym z tych przypadków kamera IN i tak czyta tablicę** — więc
przepustka powstaje niezależnie od tego, kto otworzył szlaban.

## 2. Decyzje projektowe

- **Cała logika na Edge (offline-first)** — jak whitelist i PIN-y: decyzja
  o otwarciu wyjazdu nie może zależeć od internetu. Nowa tabela w Edge SQLite:
  `exit_passes (plate_norm PK, entered_at, expires_at, camera_in, used_at)`.
  Cloud dostaje zdarzenia do audytu (istniejący tunel), nie podejmuje decyzji.
- **Przepustka działa WYŁĄCZNIE na kierunek OUT** — niczego nie wpuszcza,
  więc nie osłabia bezpieczeństwa wjazdu. Single-use: zużyta przy wyjeździe
  (auto, które wyjedzie i wróci, na wjeździe znów podlega normalnym regułom).
- **Dopasowanie tablicy**: ta sama normalizacja co whitelist (uppercase, bez
  spacji). MVP = dopasowanie dokładne + minimalny próg confidence OCR (żeby
  misread nie otwierał szlabanu). Near-miss (odległość 1 znaku) logujemy jako
  warning do przyszłego tuningu, ale NIE otwieramy.
- **Konfiguracja per budynek** w `Building.features` (JSON, już istnieje):
  `exitGrace: { enabled: bool, minutes: 15, afterExpiry: 'OPEN_AND_FLAG'|'DENY' }`
  — synchronizowana na Edge istniejącym `BUILDING_CONFIG_UPDATE` (który dziś
  nie ma konsumenta — to będzie jego pierwszy). Przełącznik + minuty w panelu
  Integratora.
- **Audyt**: nowy typ zdarzenia w `access_events` (reason=`exit_pass`,
  meta: enteredAt, dwellMinutes, passId). W feedzie BA czytelnie:
  „Wyjazd na przepustce — 12 min na osiedlu". Po wygaśnięciu bez wyjazdu:
  zdarzenie `OVERSTAY` (audyt + opcjonalny push do admina).
- **RODO**: tablice spoza listy już dziś trzymamy w lpr_reads/access_events
  z TTL; `exit_passes` są efemeryczne — kasowane przy użyciu, a wygasłe po
  24 h sprzątane cronem.

## 3. ⚠️ Punkt do decyzji właściciela: co po upływie 15 minut?

Reguła „ma 15 minut" wymaga zdefiniowania zachowania PO oknie, bo kurier
Frisco z dostawą do 3 domów potrafi zejść 25 minut, a auto **uwięzione przy
szlabanie wyjazdowym blokuje wyjazd wszystkim**:

- **`OPEN_AND_FLAG` (rekomendowane jako default)**: po oknie szlaban NADAL
  otwiera (nikt nie zostaje uwięziony), ale zdarzenie jest oznaczane jako
  OVERSTAY + powiadomienie do admina. Osiedle zachowuje pełny audyt, zero
  interwencji ręcznych.
- **`DENY` (literalnie wg reguły)**: po oknie szlaban nie otwiera — kierowca
  musi dzwonić domofonem / mieszkaniec otwiera z apki. Bezpieczniejsze
  „na papierze", ale generuje realne blokady wyjazdu.

Możliwe rozszerzenie (etap 2, jeśli potrzebne): różne okna per kategoria —
np. wizja rozpoznała brand kuriera (Frisco/DPD z vision_detections) → okno
30 min; taxi → 15 min. Infrastruktura brand-detection już istnieje.

## 4. Zakres implementacji (estymacja ~1 dzień)

| Warstwa | Zmiana |
|---|---|
| Edge SQLite | tabela `exit_passes` + cleanup cron |
| Edge `HikvisionLprService` | hook w ścieżce no-match: dir=IN → create pass; dir=OUT → check+consume+open |
| Edge tunnel | konsument `BUILDING_CONFIG_UPDATE` (exitGrace) + EVT audytu |
| Cloud | `access_events` reason `exit_pass`/`OVERSTAY`, push OVERSTAY (opcja) |
| Panel Integrator | toggle + minuty + polityka po wygaśnięciu |
| Panel BA / iOS | tylko prezentacja w feedzie wejść (etykiety PL) |
| Testy | jednostkowe na Edge (create/consume/expiry/misread) + e2e symulacją odczytu |

Deploy: Edge → Cloud (kolejność bez znaczenia — funkcja za flagą enabled=false
do czasu włączenia w panelu). Zero zmian w routingu domofonu i whitelist.

## 5. Implementacja (2026-07-30)

### Edge (`apps/edge`)

- **`src/devices/cameras/exit-grace.util.ts`** — CZYSTA logika (bez NestJS/
  SQLite, wzorzec `guest-restrictions.util`): `parseExitGraceConfig` (sanityzacja
  configu z Cloud, clamp 5–120 min, default WYŁĄCZONE), `normalizeConfidence`
  (Hikvision 0–100 → 0–1; brak tagu → null = akceptuj, kamera filtruje własnym
  MinTrustLevel), `confidenceAcceptable`, `resolveCameraExitDirection` (kierunek
  z linków `lpr_camera_ap_links` — IN/OUT/MIXED/null; MIXED = kamera pominięta),
  `decideExit` (OPEN/OPEN_FLAG/DENY/NONE + dwellMinutes), `isLevenshteinOne` +
  `findNearMissPlate` (near-miss TYLKO warning w logu).
- **`src/store/store.service.ts`** — tabela `exit_passes (plate_norm PK,
  entered_at, expires_at, camera_device_id, used_at, updated_at)` + metody
  `exitPassUpsert` (INSERT OR REPLACE — nowy wjazd nadpisuje starszy pass,
  used_at wraca do NULL), `exitPassGet`, `exitPassMarkUsed`,
  `exitPassActivePlates`, `exitPassSweep`. Plus `buildingConfigGet()` — czyta
  kv `building:<id>:config` (payload BUILDING_CONFIG_UPDATE, encrypted).
- **`src/devices/cameras/hikvision-lpr.service.ts`** — hook
  `handleExitGraceNoMatch` w ścieżce no-match `handleAnprEvent`:
  - dir=IN (wszystkie linki kamery IN) + confidence ≥ próg
    (`config.confidenceThreshold` ?? 0.8) → upsert passa; audyt wjazdu bez
    zmian (LPR_NO_MATCH jak dotąd).
  - dir=OUT → `decideExit`: ważny → otwarcie ISTNIEJĄCĄ ścieżką multi-fire
    linków LPR→AP (`accessPointExecutor.fire`, nowy trigger `EXIT_PASS`
    mapowany na source 'LPR'), `exitPassMarkUsed` (single-use), LPR_READ z
    `reason='exit_pass'`, `gateOpened=true` + meta `exitPass{enteredAt,
    expiresAt, dwellMinutes, graceMinutes, afterExpiry, entryCameraDeviceId}`;
    wygasły → OPEN_AND_FLAG: otwarcie + `reason='overstay'`; DENY: brak
    otwarcia + `reason='overstay_denied'`; brak passa → zachowanie jak dziś
    (near-miss Levenshtein 1 vs aktywne passy = warning w event_log).
  - Config cache TTL 10 s; sprzątanie passów (wygasłe/zużyte > 24 h, RODO)
    w istniejącym cronie `retentionSweep` (co 1 h).
- **`src/tunnel/tunnel.service.ts`** — `BUILDING_CONFIG_UPDATE` ma teraz
  pierwszego konsumenta (log z exitGrace); zapis do kv bez zmian.

### Cloud (`apps/api`)

- **`src/buildings/buildings.constants.ts`** — `ExitGraceConfig`,
  `DEFAULT_EXIT_GRACE` (enabled=false, 15 min, OPEN_AND_FLAG),
  `normalizeExitGrace` (lustro parsera Edge); `normalizeFeatures` PRZENOSI
  `exitGrace` (wcześniej strip-owało nieznane pola — PATCH object-type
  kasowałby config); `updateObjectType` dodatkowo zachowuje istniejące
  exitGrace gdy body go nie podaje.
- **`src/integrator/*`** — `GET/PATCH /integrator/buildings/:id/exit-grace`
  (partial update + walidacja; zapis do `Building.features.exitGrace` JSON —
  **bez migracji**), po zapisie push `BUILDING_CONFIG_UPDATE` (outbox+tunnel)
  + audit `EXIT_GRACE_UPDATE`.
- **`src/edge/edge.gateway.ts`** — `pushAccessPointSync` (reconnect Edge)
  dosyła `BUILDING_CONFIG_UPDATE` razem z resztą SYNC_ALL (wzorzec
  CAMERA_SYNC_ALL/8.h.2) — świeży/przywrócony Edge zna config bez PATCH-a.
- **`src/lpr-reads/lpr-reads.service.ts`** — LPR_READ niesie opcjonalne
  `exitPass` → ląduje w `access_events.meta` (reason to TEXT — bez migracji;
  typ eventu pozostaje `LPR_NO_MATCH`, `gateOpened=true` dla exit_pass).
  Reason `overstay`/`overstay_denied` → push do adminów budynku (cooldown
  5 min per budynek+tablica). UWAGA ograniczenie: APNs zna tylko tokeny
  mieszkańców (`push_tokens.residentId`) — push trafia do KONT MIESZKAŃCA
  o e-mailu admina budynku w tym budynku; admin bez takiego konta widzi
  zdarzenie w feedzie „Wejścia (audit)".

### Panel / UI (`apps/web`)

- **Integrator** — karta „🎫 Przepustka wyjazdowa"
  (`.../buildings/[id]/devices/IntegratorExitGraceCard.tsx`): toggle enabled,
  minuty 5–120, polityka OPEN_AND_FLAG/DENY, zapis → PATCH exit-grace.
- **Etykiety PL** — `src/lib/access-events.ts`: `EXIT_GRACE_REASON_LABEL` +
  `exitPassLabel(ev)` („Wyjazd na przepustce (X min na osiedlu)",
  „Przekroczony czas pobytu") w `eventSecondary`; BA v2 vehicles page:
  `REASON_LABEL` rozszerzone o exit_pass/overstay/overstay_denied.

### Testy

`apps/edge/src/devices/cameras/exit-grace.util.spec.ts` — 17 testów node:test
(create/nadpisanie okna, consume single-use, expiry, OPEN_AND_FLAG, DENY,
near-miss-nie-otwiera, confidence-za-niski, parsing configu, kierunek z
linków). `nest build` exclude-uje `**/*spec.ts` — spec kompilowany standalone
(instrukcja w nagłówku pliku). Buildy: Edge ✓, API ✓ (`tsc --noEmit` ✓),
web `tsc --noEmit` ✓.

### Etap 2 (nie zaimplementowane)

- Okna per kategoria z brand-detection (Frisco/DPD z `vision_detections` →
  dłuższe okno; taxi → 15 min) — infrastruktura brand-detection istnieje.
- Natywne push-tokeny dla BA/Concierge (zdejmie obejście e-mail przy OVERSTAY).

## 6. Status

- [x] Decyzja (Konrad, 2026-07-30): **OPEN_AND_FLAG**, okno 15 min (konfigurowalne)
- [x] Implementacja (2026-07-30) — Edge + Cloud + panel Integratora + etykiety PL + testy; default WYŁĄCZONE
- [ ] Deploy (Edge rsync dist + restart, Cloud flyctl) — wykonuje Konrad
- [ ] Włączenie w panelu Integratora + test na osiedlu z prawdziwym autem spoza listy
