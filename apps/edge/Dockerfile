# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Native build tools for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
# Install all deps including devDeps (needed for nest build)
RUN npm install

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npm run build

# Prune devDeps from node_modules for production
RUN npm prune --production

# ── Stage 2: Production ───────────────────────────────────────────────────────
FROM node:22-alpine AS production

# tini for proper PID 1 / signal handling
RUN apk add --no-cache tini

WORKDIR /app

COPY --from=builder /app/dist          ./dist
COPY --from=builder /app/node_modules  ./node_modules
COPY package.json ./

ENV NODE_ENV=production
ENV PORT=4000
ENV STORE_PATH=/data/store.db
ENV LOG_LEVEL=info

# Persistent volume for SQLite DB + token store
VOLUME ["/data"]

# Admin/setup API
EXPOSE 4000
# Embedded MQTT broker (LAN devices)
EXPOSE 1883

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
