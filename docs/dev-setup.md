# Dev setup — Mac Mini Cloud + Edge

Stack uruchamia się w jednym miejscu (Mac Mini, Tailscale `100.90.244.90`).
Pozwala dewelopować bez kupowania chmury, a kiedy będzie gotowe na prod —
ten sam `docker-compose.yml` przelatuje na Hetznera/AWS bez zmian w kodzie.

## Topologia

```
                                         ┌──────────────────────────┐
                                         │  Mac Mini (Tailscale     │
                                         │  100.90.244.90, LAN      │
                                         │  192.168.1.127)          │
                                         │                          │
   MacBook (dev) ─── Tailscale ────────► │  Cloud (Docker compose)  │
                                         │  ├─ postgres :5432       │
                                         │  ├─ api      :3000       │
                                         │  └─ web      :3001       │
                                         │                          │
                                         │  Edge (pm2, native)      │
   iPhone (Tailscale) ──────────────────►│  └─ edge     :4000       │
                                         │     ├─ kamera 192.168.x  │
                                         │     └─ tunel ws→localhost│
                                         └──────────────────────────┘
```

Edge zostaje w pm2 — potrzebuje LAN-u (192.168.1.x) dla kamer i bramy
domofonu, więc Docker network namespace przeszkadzałby.

## Pierwsze uruchomienie

### 1. Container engine na Mac Mini

**OrbStack** (rekomendacja po pierwszym setupie): GUI menu bar app + Docker
CLI. Pierwsze uruchomienie wymaga GUI (Screen Sharing albo fizycznie).

**colima** (jeśli wolisz w pełni headless via SSH):
```bash
ssh shc_development@100.90.244.90 '
  curl -L https://github.com/abiosoft/colima/releases/latest/download/colima-Darwin-arm64 -o /tmp/colima
  curl -L https://github.com/docker/cli/releases/latest/download/docker-darwin-arm64.tgz | tar -xzv -C /tmp/
  mkdir -p ~/bin
  install /tmp/colima ~/bin/colima
  install /tmp/docker/docker ~/bin/docker
  echo "export PATH=\$HOME/bin:\$PATH" >> ~/.zshrc
'
ssh shc_development@100.90.244.90 'PATH=$HOME/bin:$PATH colima start --cpu 4 --memory 6 --disk 30 --arch aarch64'
```

Po wyborze sprawdź `docker ps` — powinno działać bez błędu.

### 2. Wgranie repo na Mac Mini

```bash
# Z MacBooka, w katalogu z repo:
rsync -avz --exclude node_modules --exclude .next --exclude dist \
      --exclude apps/edge/data --exclude .git \
      ./ shc_development@100.90.244.90:~/gatelynk-cloud/
```

### 3. Sekrety i .env

```bash
ssh shc_development@100.90.244.90 '
  cd ~/gatelynk-cloud/infra/dev
  cp .env.example .env
  # Wypełnij .env: POSTGRES_PASSWORD, RESEND_API_KEY, APN_*
  # JWT_SECRET ZOSTAW na "dev-secret-change-in-prod" — to ten sam
  # którym podpisany jest aktywny token Edge.
'
```

Klucz APN (.p8) wgraj do `infra/dev/secrets/AuthKey.p8` na Mac Mini.

### 4. Migracja danych z MacBooka

```bash
# Lokalnie:
/opt/homebrew/Cellar/postgresql@16/16.13/bin/pg_dump -U konradsz gatelynk \
  --no-owner --no-acl --clean --if-exists > /tmp/gatelynk-dump.sql

# Wgraj na Mac Mini:
scp /tmp/gatelynk-dump.sql shc_development@100.90.244.90:/tmp/
```

### 5. Start stacka

```bash
ssh shc_development@100.90.244.90 '
  cd ~/gatelynk-cloud/infra/dev
  docker compose up -d --build
  # Poczekaj aż API zaaplikuje migracje (logi: docker compose logs -f api)
  # Wgraj dump:
  docker compose exec -T postgres psql -U gatelynk gatelynk < /tmp/gatelynk-dump.sql
'
```

### 6. Przekierowanie Edge na nową API

Edge ma w SQLite zapisany `cloudUrl=http://<stara-konradsz-IP>:3000`.
Po przeniesieniu Cloud na Mac Mini zmień to na `http://localhost:3000`
(loopback — Edge i Cloud są na tym samym hoście).

Skrypt aktualizujący w `infra/dev/scripts/edge-update-cloud-url.js` —
pisze do encrypted SQLite store używając tej samej krzywej deryacji klucza
co `apps/edge/src/store/store.service.ts:deriveKey`.

```bash
ssh shc_development@100.90.244.90 '
  PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH \
  MACHINE_ID=gatelynk-edge-shc-fc6g16f4mq \
  node ~/gatelynk-cloud/infra/dev/scripts/edge-update-cloud-url.js \
    http://localhost:3000
  PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH pm2 restart gatelynk-edge
'
```

## Codzienny dev loop

```bash
# Zmiana kodu API/Web → rebuild i restart kontenerów
ssh shc_development@100.90.244.90 '
  cd ~/gatelynk-cloud/infra/dev
  docker compose up -d --build api web
'

# Logi
ssh shc_development@100.90.244.90 'cd ~/gatelynk-cloud/infra/dev && docker compose logs -f --tail=100 api'

# Prisma migrations
ssh shc_development@100.90.244.90 '
  cd ~/gatelynk-cloud/infra/dev
  docker compose exec api pnpm exec prisma migrate dev --name <opisowa-nazwa>
'

# Studio (port-forward na MacBooka)
ssh -L 5555:localhost:5555 shc_development@100.90.244.90
# w sesji SSH:
#   cd ~/gatelynk-cloud/infra/dev && docker compose exec api pnpm exec prisma studio --hostname 0.0.0.0
# w przeglądarce na MacBooku: http://localhost:5555
```

## Co się zmieni przy migracji do prawdziwej chmury

Konfiguracja jest pomyślana tak, żeby przeniesienie nie wymagało zmian w
kodzie:

| Element | Dev (Mac Mini) | Prod (np. Hetzner) |
|---------|----------------|---------------------|
| `docker-compose.yml` | `infra/dev/` | `infra/prod/` (kopia + HTTPS reverse proxy) |
| `JWT_SECRET` | `dev-secret-change-in-prod` (16+ znaków) | `openssl rand -hex 32` (32+, NODE_ENV=production) |
| `FRONTEND_URL` | `http://100.90.244.90:3001` | `https://app.gatelynk.com` |
| `NEXT_PUBLIC_API_URL` | `http://100.90.244.90:3000/api` | `https://api.gatelynk.com/api` |
| Edge `cloudUrl` | `http://localhost:3000` | `https://api.gatelynk.com` |
| TLS | brak (Tailscale i tak szyfruje) | Caddy/Traefik przed compose |

Migracja DB: `pg_dump` z Mac Mini → `psql` na produkcję.

## Częste problemy

- **`docker compose up` failuje na warstwie deps** — usuń lokalne `node_modules`
  i `pnpm-lock.yaml` na Mac Mini (jeśli wgrałeś przez przypadek), bo
  hostowy lockfile może nie matchować architektury kontenera. Lockfile w
  contextu jest OK — `.dockerignore` go nie wyklucza.
- **Edge dalej pokazuje offline po `cloudUrl` update** — sprawdź czy
  `MACHINE_ID` jest TYM SAMYM którego użyto przy aktywacji (logi pm2
  `~/.pm2/logs/gatelynk-edge-out.log`). Bez tego decryption fail.
- **CORS error w przeglądarce** — `FRONTEND_URL` w `.env` musi DOKŁADNIE
  matchować schemat+host+port pod którym hitujesz Web (`http://...:3001`).
- **API restart loop z `Refresh token rejected`** — JWT_SECRET nie matchuje
  tego co Edge ma w storze. Albo zmień JWT_SECRET na `dev-secret-change-in-prod`,
  albo re-aktywuj Edge'a.
