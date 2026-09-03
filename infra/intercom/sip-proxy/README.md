# GateLynk SIP proxy (Akuvox E18 → Janus, per-lokal)

Mały rejestrator/proxy SIP umożliwiający **wybieranie do konkretnego lokalu** z
listy kontaktów domofonu Akuvox E18. Akuvox direct-IP nie niesie numeru
wewnętrznego, a `<id>@IP` wymaga konta SIP — ten proces udaje rejestrator
(REGISTER → 200 OK) i przekazuje INVITE do Janusa zachowując numer (= id lokalu).

## Deploy (Edge = Mac Mini `shc_development@100.90.244.90`)
```bash
rsync -az infra/intercom/sip-proxy/ shc_development@100.90.244.90:~/gatelynk-sip-proxy/
ssh shc_development@... 'cd ~/gatelynk-sip-proxy && \
  export PATH=$HOME/.nvm/versions/node/<ver>/bin:$PATH && npm install --omit=dev'
# launchd: com.gatelynk.sipproxy (RunAtLoad + KeepAlive), logi w logs/
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.gatelynk.sipproxy.plist
```

## Konfiguracja E18 (panel web)
1. **Account → Account 1**: Enable; Display/Register/User Name = dowolne (np. `door`);
   Password = dowolne; **Server Host = <edge-ip>** (192.168.1.127), **Port = 5062**;
   Transport = UDP; Register = ON. Status → „Registered".
2. **Access Control → User** (tenanci): per lokal → pole **Phone = `<id-lokalu>`**
   (np. `49`), Name = „Niewinna 4/2 — Szychta". (id lokalu z GateLynk.)
3. **Intercom → Basic → Tenants List**: „Show Tenants of Local Group" + „Click
   Tenants to Dial Out".
4. Dotknięcie tenanta → E18 dzwoni na numer wewnętrzny przez konto → proxy →
   Janus → push tylko do mieszkańców tego lokalu.

## Porty
- `5062/udp` — ten proxy (E18 rejestruje konto + wysyła INVITE tutaj).
- `5060/udp` — Janus (proxy forwarduje tu; fizyczny przycisk dzwoni tu direct-IP).

Env: `SIP_PROXY_PORT` (5062), `JANUS_HOST` (192.168.1.127), `JANUS_PORT` (5060).
