# Instalacja Edge na Mac Mini (launchd)

Bez service managera Edge wraca do trybu „ręcznego" — admin musi SSH-ować
i odpalać `npm run start:prod` w `tmux`. Po `REBOOT` przez panel BA
(Faza 5) proces ginie i **nie wstaje**. Z launchd-em to się dzieje samo.

## Pierwszorazowa instalacja

Założenia:
- Mac Mini, użytkownik `shc_development` ma katalog `~/gatelynk-edge`
  z deploy-em (clone repo + `npm install` + `npm run build`)
- Node.js zainstalowany przez Homebrew (`/opt/homebrew/bin/node`)
- Plik `.env` w `apps/edge/` ma sekrety (TUNNEL_TOKEN itp.)

```bash
# 1. Skopiuj plist do systemowego LaunchDaemons (wymaga sudo)
sudo cp apps/edge/install/com.gatelynk.edge.plist /Library/LaunchDaemons/

# 2. Permissions — launchd wymaga root:wheel + 644
sudo chown root:wheel /Library/LaunchDaemons/com.gatelynk.edge.plist
sudo chmod 644 /Library/LaunchDaemons/com.gatelynk.edge.plist

# 3. Załaduj do launchd (od macOS 10.10 — `bootstrap` zamiast `load`)
sudo launchctl bootstrap system /Library/LaunchDaemons/com.gatelynk.edge.plist

# 4. Sprawdź że Edge wstał
sudo launchctl print system/com.gatelynk.edge | head -20
tail -f /var/log/gatelynk-edge.log
```

## Operacje codzienne

```bash
# Status
sudo launchctl print system/com.gatelynk.edge

# Wymuś restart (testing — Mac Mini nie potrzebuje, BA panel to robi)
sudo launchctl kickstart -k system/com.gatelynk.edge

# Logi (live)
tail -f /var/log/gatelynk-edge.log
tail -f /var/log/gatelynk-edge.err.log

# Stop (np. przed update)
sudo launchctl bootout system /Library/LaunchDaemons/com.gatelynk.edge.plist

# Update kodu + restart
cd ~/gatelynk-edge
git pull
pnpm install --frozen-lockfile
pnpm --filter @gatelynk/edge build
sudo launchctl kickstart -k system/com.gatelynk.edge
```

## Co robi `KeepAlive=true`

Launchd auto-restartuje proces przy KAŻDYM exit (intencjonalnym `process.exit(0)`
z REBOOT handlera, crashu, OOM, kill -9 z zewnątrz). Throttle 10s zapobiega
crash-loop-owi.

Skutek dla Fazy 5 RESTART:
1. BA klika „Restart" w panelu
2. Cloud wysyła CMD `REBOOT` przez tunel WS
3. Edge `tunnel.service.ts` woła `process.exit(0)` po 3s delay (żeby ACK doszedł)
4. Launchd zauważa exit, czeka 10s (ThrottleInterval), startuje proces od nowa
5. Edge reconnect-uje tunel WS, BA panel widzi „online" znowu po ~15s

## Troubleshooting

**Edge nie startuje:**
- Sprawdź `/var/log/gatelynk-edge.err.log` — najczęściej brak `node` w PATH
  albo `dist/main` nie istnieje (musisz zrobić `pnpm build` najpierw)
- `sudo launchctl print system/com.gatelynk.edge` pokazuje exit code

**Permission denied on socket / file:**
- Plist ustawia `UserName=shc_development` — Edge chodzi pod tym userem.
  Wszystko w `~/gatelynk-edge` musi być readable przez tego usera.
  `chown -R shc_development:staff ~/gatelynk-edge`

**Plist zmieniony, nie działa:**
- Po edycji plist trzeba `bootout` + `bootstrap` (nie wystarczy `kickstart -k`)

## Alternatywa: pm2

Jeśli wolisz pm2 (większość deweloperów Node.js zna ten flow):

```bash
npm install -g pm2
cd ~/gatelynk-edge
pm2 start apps/edge/dist/main --name gatelynk-edge
pm2 save
pm2 startup launchd  # generuje launchd plist który auto-startuje pm2 daemon
# Postępuj zgodnie z output-em pm2 (uruchomi sudo pm2-runtime startup launchd)
```

pm2 daje fancy dashboard (`pm2 monit`) i lepszą rotację logów. Plist powyżej
zostawiamy jako oficjalny wariant bez extra deps.
