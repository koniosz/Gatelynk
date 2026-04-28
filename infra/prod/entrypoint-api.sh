#!/bin/sh
set -e

# Entrypoint API @ Fly.io.
#
# Fly machines nie mają /dev/net/tun (Firecracker microVM), więc tailscaled
# odpalamy w trybie userspace networking. Stawiamy lokalny HTTP proxy na :1055
# — Node.js (przez undici ProxyAgent) używa go do wszystkich `fetch()` calls
# do hostów w tailnecie (np. Edge na 100.90.244.90:4000). Ruch do publicznych
# hostów też przechodzi przez ten proxy, ale tailscaled forwarduje go normalnie
# przez internet. Bez kosztu wydajnościowego dla naszej skali.
#
# TS_AUTHKEY:   pre-authorized key z https://login.tailscale.com/admin/settings/keys
#               z tagiem `tag:cloud` (ACL ogranicza ruch tag:cloud → tag:edge:4000).
# TS_HOSTNAME:  default `fly-api-${FLY_MACHINE_ID}` — unikalna nazwa per machine,
#               żeby Tailscale nie kolidował przy multi-region / scale-out.

if [ -n "$TS_AUTHKEY" ]; then
  echo "[entrypoint] starting tailscaled (userspace + HTTP proxy on :1055)"
  mkdir -p /var/lib/tailscale /var/run/tailscale

  /usr/sbin/tailscaled \
    --tun=userspace-networking \
    --statedir=/var/lib/tailscale \
    --socket=/var/run/tailscale/tailscaled.sock \
    --outbound-http-proxy-listen=localhost:1055 \
    --socks5-server=localhost:1080 \
    >/var/log/tailscaled.log 2>&1 &

  # Czekamy aż socket będzie gotów (tailscaled startuje ~1s).
  for i in $(seq 1 10); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 1
  done

  HOSTNAME_TS="${TS_HOSTNAME:-fly-api-${FLY_MACHINE_ID:-$(hostname)}}"
  /usr/bin/tailscale up \
    --authkey="$TS_AUTHKEY" \
    --hostname="$HOSTNAME_TS" \
    --accept-routes \
    --accept-dns=false \
    --reset

  echo "[entrypoint] tailscale up — hostname=$HOSTNAME_TS"
  /usr/bin/tailscale status || true

  # Eksportujemy proxy URL dla Node.js (czytane przez EdgeService.fetchEdge()).
  export TS_HTTP_PROXY="http://localhost:1055"
else
  echo "[entrypoint] TS_AUTHKEY not set — skipping tailscale (Edge HTTP fetches will fail)"
fi

# Migracje Prisma → idempotentne. Krytyczne że to LECI ZA tailscalem ale PRZED
# `node main` — gdyby Prisma chciała kiedyś sięgnąć do tailnetowego serwisu,
# byłaby już online.
echo "[entrypoint] running prisma migrate deploy"
pnpm exec prisma migrate deploy

echo "[entrypoint] starting Nest application"
exec node dist/src/main
