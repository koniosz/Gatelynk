# Janus Gateway na Edge (Mac Mini) — instalacja + wpięcie w Edge

Media server SIP↔WebRTC dla domofonu Akuvox ↔ iOS. Projekt:
[`docs/intercom-akuvox-call.md`](../../../docs/intercom-akuvox-call.md), sekcja 3
(rekomendacja: **Janus z `janus.plugin.sip`**).

Janus terminuje SIP od Akuvoxa i wystawia stronę WebRTC do iOS. NestJS Edge
(`apps/edge/src/devices/intercom/janus-media-bridge.ts`) steruje nim przez HTTP
transport. Wszystko za flagą `INTERCOM_CALL_ENABLED` — bez niej Edge nie łączy
się z Janusem (`JanusMediaBridge.connect` zwraca STUB gdy `JANUS_HTTP_URL` puste).

---

## 1. Instalacja — BUILD ZE ŹRÓDEŁ (Homebrew NIE ma formuły `janus`!)

⚠️ **`brew install janus` NIE działa** — janus-gateway nigdy nie był w homebrew-core
(`brew` podpowiada „jansson"/cask „jan"). Trzeba zbudować ze źródeł. Zweryfikowane
na Mac Mini M-series, macOS 26.5 (Edge MVP, 2026-06-14):

```bash
# 1a. zależności (WSZYSTKIE w brew; sofia-sip = SIP plugin, srtp = libsrtp2,
#     libmicrohttpd = transport HTTP/REST :8088 BEZ NIEGO REST=no i Edge nie gada!)
brew install jansson glib libnice srtp openssl@3 libwebsockets libconfig \
             sofia-sip gengetopt pkg-config autoconf automake libtool libmicrohttpd

# 1b. clone + build
git clone --depth 1 https://github.com/meetecho/janus-gateway.git ~/src/janus-gateway
cd ~/src/janus-gateway
export PKG_CONFIG_PATH="/opt/homebrew/lib/pkgconfig:/opt/homebrew/opt/openssl@3/lib/pkgconfig:/opt/homebrew/opt/srtp/lib/pkgconfig:/opt/homebrew/opt/libffi/lib/pkgconfig:/opt/homebrew/opt/libmicrohttpd/lib/pkgconfig"
export CFLAGS="-I/opt/homebrew/include"; export LDFLAGS="-L/opt/homebrew/lib"
sh autogen.sh
./configure --prefix=/opt/homebrew --disable-data-channels --disable-rabbitmq --disable-mqtt --disable-nanomsg
# W podsumowaniu MUSI być: "SIP Gateway: yes" ORAZ "REST (HTTP/HTTPS): yes".
# Jeśli REST=no → brakuje libmicrohttpd, doinstaluj i ./configure ponownie.
make -j$(sysctl -n hw.ncpu) && make install && make configs
```

> **PATCH stałego portu SIP (WAŻNE dla Akuvoxa).** Stock plugin binduje sofia na
> porcie EFEMERYCZNYM (`sip:LOCAL_IP:*` w `src/plugins/janus_sip.c`), który zmienia
> się przy każdym restarcie — Akuvox direct-IP oczekuje 5060. Przypnij:
> ```bash
> sed -i "" "s/:\*;transport=udp/:5060;transport=udp/" src/plugins/janus_sip.c
> make && make install   # przebuduje sam plugin
> ```
> Po tym Janus słucha SIP na `LOCAL_IP:5060` (sprawdź: `lsof -nP -iUDP -a -p $(pgrep -f /opt/homebrew/bin/janus) | grep 5060`).
> Uwaga: 1 guest-handle = 1 stack na 5060 (wystarcza dla 1 połączenia naraz).

## 2. Certyfikat DTLS (self-signed wystarcza dla media WebRTC)

```bash
mkdir -p /opt/homebrew/etc/janus/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout /opt/homebrew/etc/janus/certs/mycert.key \
  -out    /opt/homebrew/etc/janus/certs/mycert.pem \
  -subj "/CN=gatelynk-edge-janus"
```

## 3. Configi

Skopiuj snippety z tego katalogu do configów Janusa i podmień placeholdery
(`local_ip`, `admin_secret`):

```bash
cp janus.jcfg                 /opt/homebrew/etc/janus/janus.jcfg
cp janus.plugin.sip.jcfg      /opt/homebrew/etc/janus/janus.plugin.sip.jcfg
cp janus.transport.http.jcfg  /opt/homebrew/etc/janus/janus.transport.http.jcfg
```

Kluczowe wartości do ustawienia:
- `janus.plugin.sip.jcfg → general.local_ip` = **LAN IP Mac Mini** (np.
  `192.168.1.127`). Akuvox dzwoni na ten adres:5060.
- `janus.transport.http.jcfg → admin.admin_secret` = losowy sekret
  (`openssl rand -hex 16`). Zwykłe API (8088) jest na loopback bez sekretu, ale
  możesz dodać `api_secret` w `janus.jcfg → general` jeśli chcesz — wtedy ustaw
  ten sam w env `JANUS_API_SECRET`.
- `janus.jcfg → nat.stun_server/turn_*` = adres TURN-a z
  [`../coturn/`](../coturn/README.md).

## 4. Uruchomienie jako usługa (launchd)

```bash
cp com.gatelynk.janus.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gatelynk.janus.plist
launchctl print gui/$(id -u)/com.gatelynk.janus       # sprawdź running
tail -f /tmp/janus.out.log
```

(plist owija Janusa w `caffeinate -i` — wymóg macOS Tahoe TCC Local Network,
patrz komentarz w pliku i `apps/edge/install/README.md`.)

## 5. Env w Edge (`apps/edge/.env`)

```ini
INTERCOM_CALL_ENABLED=true
JANUS_HTTP_URL=http://127.0.0.1:8088/janus
# JANUS_API_SECRET=...            # tylko gdy ustawiłeś api_secret w janus.jcfg
JANUS_SIP_IDENTITY=sip:edge@192.168.1.127   # konto SIP na które dzwoni Akuvox
# JANUS_SIP_PROXY=sip:192.168.1.127:5060     # gdy używasz registrara
# JANUS_SIP_REALM=gatelynk
# JANUS_SIP_SECRET=...                        # hasło konta SIP
```

> Bez `JANUS_SIP_IDENTITY` plugin rejestruje się w trybie **guest** (direct-IP):
> Akuvox musi dzwonić wprost na IP:port handle. Z identity = pełna rejestracja
> SIP (Akuvox jako klient registrara).

## 6. Smoke test (bez Akuvoxa)

```bash
# Czy zwykłe API żyje (create session):
curl -s http://127.0.0.1:8088/janus \
  -d '{"janus":"create","transaction":"t1"}'
# → {"janus":"success","transaction":"t1","data":{"id":<number>}}

# Edge boot log po starcie (flaga ON) powinien pokazać:
#   JanusMediaBridge ready — session=<id> sipHandle=<id>
#   SIP registered: ... (lub guest)
```

## 7. Pierwszy realny sygnał end-to-end

Po skonfigurowaniu Akuvoxa ([`../akuvox/README.md`](../akuvox/README.md)) i flag:
naciśnięcie przycisku na panelu → SIP INVITE → Janus `incomingcall` →
`JanusMediaBridge.onIncomingCall` → `INTERCOM_CALL_INVITE` przez tunel do Cloud →
sesja `RINGING` + VoIP push. To pierwszy testowalny milestone Fazy B (jeszcze bez
media iOS — to Faza C). Sprawdź:
- Edge log: `incomingcall from=... → sessionId=...`
- Cloud log: `INVITE [b#X] session=... via=... → N resident(s)`
- DB: wiersz w `intercom_call_sessions` ze stanem `RINGING`.
