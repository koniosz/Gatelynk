# coturn (TURN/STUN) — instalacja na czystym VPS (Ubuntu, region FRA)

TURN relay dla domofonu Akuvox ↔ iOS off-site. Projekt:
[`docs/intercom-akuvox-call.md`](../../../docs/intercom-akuvox-call.md), decyzja
**D3 = publiczny VPS, region Frankfurt (FRA)**.

Edge (Mac Mini) jest za NAT-em LAN, więc TURN **nie może** żyć na Edge — musi być
publicznie osiągalny. iPhone poza siecią i Janus (na Edge) dostają te same
`iceServers` (STUN + TURN) i media leci przez relay gdy bezpośrednia ścieżka ICE
nie istnieje.

Wszystko jest za flagą `INTERCOM_CALL_ENABLED` w Cloud/Edge — postawienie TURN-a
nie wpływa na produkcję dopóki flaga jest OFF.

---

## 0. Wymagania

- VPS Ubuntu 22.04/24.04 w regionie FRA (Hetzner CX/Falkenstein, OVH FRA,
  Contabo DE — dowolny z publicznym IPv4).
- Domena `turn.gatelynk.com` (lub subdomena) wskazująca A-rekordem na publiczny
  IP VPS-a (Cloudflare DNS — wyłącz proxy/„chmurkę", TURN potrzebuje surowego IP).
- Otwarte porty (firewall VPS + ewentualny security group provider-a):
  | Port | Proto | Cel |
  |------|-------|-----|
  | 3478 | UDP+TCP | STUN/TURN plain |
  | 5349 | UDP+TCP | TURN over TLS/DTLS |
  | 49152–65535 | UDP | zakres relay (media) |
  | 80 | TCP | tylko na czas wydania certu Let's Encrypt (HTTP-01) |

## 1. Instalacja

```bash
sudo apt update
sudo apt install -y coturn
# Włącz daemon (Debian/Ubuntu domyślnie startuje wyłączony):
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

## 2. Firewall (ufw)

```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:65535/udp
sudo ufw allow 80/tcp        # tylko do wydania certu; można potem zamknąć
sudo ufw enable
```

> Jeśli provider ma osobny **security group / cloud firewall** (Hetzner, AWS) —
> dodaj te same reguły tam. Zakres `49152-65535/udp` jest kluczowy; bez niego
> handshake ICE przejdzie, ale media (relay) nie popłyną.

## 3. Certyfikat TLS (Let's Encrypt)

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d turn.gatelynk.com
# Cert ląduje w /etc/letsencrypt/live/turn.gatelynk.com/{fullchain,privkey}.pem
# coturn musi mieć prawo czytać klucz:
sudo usermod -aG ssl-cert turnserver 2>/dev/null || true
sudo chmod 0750 /etc/letsencrypt/{live,archive}
```

Auto-odnawianie + reload coturn po renew:

```bash
echo '#!/bin/sh
systemctl restart coturn' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/restart-coturn.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/restart-coturn.sh
```

## 4. Konfiguracja

Skopiuj [`turnserver.conf`](./turnserver.conf) z tego repo i podmień placeholdery:

```bash
sudo cp turnserver.conf /etc/turnserver.conf
sudo mkdir -p /var/log/turnserver && sudo chown turnserver:turnserver /var/log/turnserver

# Wygeneruj sekret dla TURN REST API (use-auth-secret):
openssl rand -hex 32        # → wklej jako <STATIC_SECRET>

sudo sed -i \
  -e "s/<PUBLIC_IP>/$(curl -s ifconfig.me)/" \
  -e 's/<TURN_REALM>/turn.gatelynk.com/g' \
  -e 's/<STATIC_SECRET>/PASTE_HEX_SECRET_HERE/' \
  /etc/turnserver.conf
```

**Mechanizm autoryzacji: `use-auth-secret` (TURN REST API).** Cloud generuje
krótkożyciowe credentials z `static-auth-secret` (HMAC-SHA1) i wypełnia nimi
`BuildingIntercom.turnUrl/turnUsername/turnPassword` przy zestawianiu połączenia:

```
username = "<unix_expiry_ts>:gatelynk"        # np. "1781000000:gatelynk"
password = base64( HMAC_SHA1(static-auth-secret, username) )
turnUrl  = "turn:turn.gatelynk.com:3478?transport=udp"
           (+ "turns:turn.gatelynk.com:5349?transport=tcp" dla TLS)
```

> **TODO Faza C (Cloud):** generator tych creds nie jest jeszcze zaimplementowany
> w Cloud (`IntercomCallService`). Dziś `turn*` można wpisać ręcznie (wariant
> long-term — patrz komentarz w `turnserver.conf`). Generator HMAC dojdzie razem
> z iOS WebRTC (potrzebuje realnego peera do testu).

## 5. systemd (start + autostart)

coturn instaluje jednostkę `coturn.service`. Wystarczy:

```bash
sudo systemctl enable --now coturn
sudo systemctl status coturn        # active (running)
```

## 6. Test

Z dowolnej maszyny z zainstalowanym coturn (`apt install coturn` daje też klienta):

```bash
# STUN — sam binding (sprawdza port 3478):
turnutils_stunclient turn.gatelynk.com

# TURN allocate (use-auth-secret): wygeneruj efemeryczne creds tym samym sekretem
SECRET=PASTE_HEX_SECRET_HERE
USER="$(($(date +%s)+3600)):gatelynk"
PASS=$(echo -n "$USER" | openssl dgst -binary -sha1 -hmac "$SECRET" | openssl base64)
turnutils_uclient -v -u "$USER" -w "$PASS" -y turn.gatelynk.com
```

Sukces = log `allocate sent`/`success` + relay address z publicznego IP VPS-a.
Online można też użyć
[Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/):
wpisz `turn:turn.gatelynk.com:3478` + wygenerowane user/pass → powinieneś dostać
kandydata typu `relay`.

## 7. Wpięcie w GateLynk

- W `BuildingIntercom` danego domofonu ustaw `bridgeEnabled=true` oraz
  `turnUrl/turnUsername/turnPassword` (ręcznie lub przez generator Cloud).
- Edge (Janus) i iOS przekażą te `iceServers` swoim `RTCPeerConnection`/Janus
  config. Janus dodatkowo: ustaw `nat_1_1_mapping` na publiczny IP, jeśli Edge
  ma być osiągalny bezpośrednio — patrz `infra/intercom/janus/README.md`.
