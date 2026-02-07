# WA Control Plane

Production-oriented Node.js + Express dashboard for managing multiple WhatsApp Web accounts, with observability and operational tooling.

## Features

- Multi-account WhatsApp session management
- Real-time dashboard updates (Socket.IO)
- SQLite-backed persistence
- Background job orchestration
- Security hardening and deployment scripts

## Requirements

- Node.js 18+
- Chromium/Puppeteer dependencies for your OS

## Setup

```bash
cp .env.example .env
npm ci
npm start
```

## Development

```bash
npm run dev
```

## Quality Checks

```bash
npm run lint
npm test
npm run check
```

## PM2 (Production)

```bash
pm2 start ecosystem.config.cjs --env production
```

## Optional Redis

Set `REDIS_URL` to enable shared state and improved multi-process behavior.

## Project Layout

- `routes/`: HTTP routes
- `services/`: domain services
- `public/`: dashboard UI assets
- `docs/`: additional operational docs
- `test/`: automated tests
