# WhatsApp Web Panel

Node.js + Express tabanlı WhatsApp yönetim paneli (multi-account, SQLite, Socket.IO).

## Gereksinimler

- Node.js 18+
- WhatsApp Web bağlantısı için Puppeteer/Chromium bağımlılıkları (sunucu ortamına göre değişir)

## Kurulum

1. `.env` oluştur:
   - `cp .env.example .env`
   - `CORS_ORIGINS`, `SESSION_SECRET`, `SITE_PASSWORD`/`ADMIN_BOOTSTRAP_PASSWORD` değerlerini güncelle
2. Bağımlılıkları yükle: `npm install`
3. Çalıştır: `npm start`

## PM2 ile Çalıştırma

Basit kullanım:

```bash
pm2 start server.js --name whatsapp-panel
```

Not: `whatsapp-web.js` oturum dizinini (LocalAuth) ve `express-session`’ı paylaşımlı hale getirmeden **cluster/multi-instance** çalıştırmak önerilmez. Eğer yine de birden çok instance çalıştıracaksan:

- Session store (örn. Redis) + sticky session (Socket.IO) kur
- Socket.IO adapter (örn. Redis adapter) kullan
- Arka plan job’ları için leader seçim mekanizması SQLite lock ile var (`ENABLE_BACKGROUND_JOBS=true` kalabilir)

Örnek PM2 dosyası: `ecosystem.config.cjs`

## Redis (Opsiyonel ama Önerilir)

`REDIS_URL` set edilirse:

- `express-session` store Redis’e taşınır (restart sonrası login korunur, multi-instance için hazır olur)
- Socket.IO Redis adapter devreye girer (broadcast/room event’leri instance’lar arası yayılır)
- Login denemesi rate-limit’i Redis üzerinden çalışır (multi-instance tutarlı olur)

Multi-instance için ayrıca **sticky session** gerekir (PM2 tarafında sticky veya Nginx/LB ile).

## Sağlık Kontrolü

- `GET /healthz` → `{ ok: true, ... }`
- `GET /readyz` → bağımlılıklar hazırsa `200`, değilse `503`

## Observability

- `GET /openapi.json` → OpenAPI spec (`docs/openapi.json`)
- `GET /docs/` → Swagger UI (sadece `admin`)
- `GET /metrics` → Prometheus metrics (`METRICS_ENABLED=true` ile açılır; prod ortamında `METRICS_TOKEN` kullanman önerilir)

## Test

```bash
npm test
```

## Önemli Ortam Değişkenleri

Detaylar için `.env.example`.

- `CORS_ORIGINS` (zorunlu)
- `SESSION_SECRET` (prod’da zorunlu)
- `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` (ilk admin kullanıcı)
- `ENABLE_BACKGROUND_JOBS` (scheduler/cleanup)
- `DATA_DIR`, `LOGS_DIR` (opsiyonel dizin override)
- `METRICS_ENABLED`, `METRICS_TOKEN` (opsiyonel; `/metrics`)
- `API_RATE_LIMIT_*` (opsiyonel; `/api` rate limit ayarları)
- `PASSWORD_*` (opsiyonel; parola politikası)
- `LOG_RETENTION_DAYS`, `MESSAGE_RETENTION_DAYS` (opsiyonel; retention/cleanup)

## Roadmap

Best-practice yol haritası: `docs/ROADMAP.md`
