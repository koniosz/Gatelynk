# GateLynk

Aplikacja do zarządzania wspólnotami mieszkaniowymi.

## Struktura projektu

```
apps/
  api/      → Backend NestJS (port 3000)
  web/      → Panel admina Next.js (port 3001)
  mobile/   → Aplikacja mobilna React Native + Expo
packages/
  shared/   → Wspólne typy TypeScript
```

## Uruchomienie

### Wymagania
- Node.js 20+
- pnpm 10+
- PostgreSQL 15+

### Instalacja

```bash
pnpm install
```

### Baza danych

```bash
# Skopiuj .env i ustaw DATABASE_URL
cp apps/api/.env.example apps/api/.env

# Uruchom migracje
pnpm db:migrate

# Załaduj dane startowe (plany licencji, typy lokali)
pnpm --filter @gatelynk/api db:seed
```

### Uruchomienie dev

```bash
# Wszystkie aplikacje jednocześnie
pnpm dev

# Lub osobno:
pnpm --filter @gatelynk/api dev      # API: http://localhost:3000/api
pnpm --filter @gatelynk/web dev      # Panel: http://localhost:3001
pnpm --filter @gatelynk/mobile dev   # Expo
```

### Generowanie klucza licencyjnego (dev)

```bash
curl -X POST http://localhost:3000/api/license/generate \
  -H "Content-Type: application/json" \
  -d '{"planCode": "starter", "validDays": 365}'
```

## Moduły Etapu 1

- **Auth** — rejestracja/logowanie admina, JWT
- **License** — klucze licencyjne, plany, limity
- **Buildings** — CRUD budynków
- **Units** — CRUD lokali + typy lokali (systemowe + własne)
- **Residents** — CRUD mieszkańców + przypisanie do lokalu
- **Invitations** — zaproszenia emailem (Resend)
