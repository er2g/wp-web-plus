# WhatsApp Web Panel

A Node.js + Express dashboard for managing WhatsApp Web sessions (multi-account, SQLite, Socket.IO).

## Requirements

- Node.js 18+
- Puppeteer/Chromium dependencies for WhatsApp Web (varies by server OS)

## Setup

1. Create `.env`:
   - `cp .env.example .env`
   - Update `CORS_ORIGINS`, `SESSION_SECRET`, and `SITE_PASSWORD` / `ADMIN_BOOTSTRAP_PASSWORD`
2. Install dependencies: `npm ci`
3. Start: `npm start`

## Run with PM2

Recommended:

```bash
pm2 start ecosystem.config.cjs --env production
```

Note: Running in **cluster/multi-instance** mode is not recommended unless the
`whatsapp-web.js` session directory (LocalAuth) and `express-session` are shared.
If you still plan to run multiple instances:

- Use a shared session store (for example, Redis) and sticky sessions (Socket.IO)
- Enable a Socket.IO adapter (for example, Redis adapter)
- Background jobs already use a SQLite lock for leader election
  (`ENABLE_BACKGROUND_JOBS=true` can remain enabled)

Example PM2 file: `ecosystem.config.cjs`

## Redis (Optional but Recommended)

If `REDIS_URL` is set:

- `express-session` is stored in Redis (logins survive restarts; ready for multi-instance)
- Socket.IO Redis adapter is enabled (broadcast/room events across instances)
- Login attempt rate-limiting uses Redis (consistent across instances)

Multi-instance setups still require **sticky sessions** (PM2 sticky or Nginx/LB).

## Health Checks

- `GET /healthz` -> `{ ok: true, ... }`
- `GET /readyz` -> `200` when dependencies are ready, `503` otherwise
- During shutdown, `/readyz` returns `503` automatically (`shuttingDown=true`)

## Observability

- `GET /openapi.json` -> OpenAPI spec (`docs/openapi.json`)
- `GET /docs/` -> Swagger UI (admin only)
- `GET /metrics` -> Prometheus metrics (enable with `METRICS_ENABLED=true`;
  `METRICS_TOKEN` is recommended in production)

## Tests

```bash
npm test
```

## Quality Checks

```bash
npm run lint
npm run check
```

## Key Environment Variables

See `.env.example` for full details.

- `CORS_ORIGINS` (required)
- `SESSION_SECRET` (required in production)
- `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` (initial admin user)
- `ENABLE_BACKGROUND_JOBS` (scheduler/cleanup)
- `DATA_DIR`, `LOGS_DIR` (optional directory overrides)
- `SHUTDOWN_TIMEOUT_MS` (graceful shutdown timeout)
- `METRICS_ENABLED`, `METRICS_TOKEN` (optional; `/metrics`)
- `API_RATE_LIMIT_*` (optional; `/api` rate limit settings)
- `PASSWORD_*` (optional; password policy)
- `LOG_RETENTION_DAYS`, `MESSAGE_RETENTION_DAYS` (optional; retention/cleanup)

## Roadmap

Best-practice roadmap: `docs/ROADMAP.md`
