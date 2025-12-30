# Runbook (Tek Sunucu + PM2)

Bu doküman, projeyi tek sunucuda **stabil** ve **ölçülebilir** şekilde çalıştırmak için pratik operasyon adımlarını özetler.

## Ön Koşullar

- Node.js 18+
- `whatsapp-web.js` için Chromium/Puppeteer bağımlılıkları (distro’ya göre değişir)
- (Opsiyonel) Redis: `REDIS_URL` set edilirse session + Socket.IO için önerilir

## Kurulum

1. Env dosyasını oluştur:
   - `cp .env.example .env`
2. Minimum prod ayarları:
   - `NODE_ENV=production`
   - `CORS_ORIGINS=https://panel.example.com` (prod’da `*` kullanma)
   - `SESSION_SECRET=...` (güçlü + rastgele)
   - `ADMIN_BOOTSTRAP_PASSWORD=...` (ilk admin şifresi; sonra UI’dan değiştir)
3. Bağımlılıkları yükle:
   - `npm ci`

## Veri Dizini (State)

- Varsayılan: `DATA_DIR=./data`
- Multi-account dosya yapısı:
  - `data/accounts/<accountId>/whatsapp.db` (SQLite)
  - `data/accounts/<accountId>/session/` (WhatsApp LocalAuth)
  - `data/accounts/<accountId>/media/`
- WhatsApp ayarları (ör. `ghostMode`, `maxMessagesPerChat`) account DB içinde persist edilir.

## PM2 ile Çalıştırma

Önerilen: `ecosystem.config.cjs` kullan.

```bash
pm2 start ecosystem.config.cjs --env production
pm2 status
pm2 logs whatsapp-panel
```

Güncelleme sonrası:

```bash
git pull
npm ci
pm2 restart whatsapp-panel
```

Notlar:
- WhatsApp bağlantısı tek proses/instance ile daha stabil olur (`exec_mode: fork`, `instances: 1`).
- Multi-instance gerekiyorsa Redis session + Socket.IO adapter + sticky session şarttır.
- Graceful shutdown için `shutdown_with_message` + `kill_timeout` ayarlı; uygulama shutdown sırasında `/readyz` → `503` döner.
- `SHUTDOWN_TIMEOUT_MS` (app) < `kill_timeout` (PM2) olacak şekilde ayarla (varsayılanlar uyumlu).

## Health / Readiness / Metrics

- `GET /healthz` → temel yaşam sinyali
- `GET /readyz` → bağımlılıklar (örn. Redis) hazır mı?
- `GET /metrics` → Prometheus (sadece `METRICS_ENABLED=true` iken). Prod’da `METRICS_TOKEN` önerilir.

Önemli metrikler:

- `wp_panel_http_requests_total{method,route,status}`
- `wp_panel_http_request_duration_seconds{method,route,status}`
- `wp_panel_message_pipeline_messages_total{direction}` (`incoming|outgoing`)
- `wp_panel_message_pipeline_task_total{task,outcome}` (`success|error|skipped`)
- `wp_panel_message_pipeline_duration_seconds{direction}`
- `wp_panel_message_pipeline_task_duration_seconds{task,outcome}`
- `wp_panel_background_job_runs_total{accountId,job,outcome}` (`success|error|skipped`)
- `wp_panel_background_job_duration_seconds{accountId,job,outcome}`
- `wp_panel_webhook_deliveries_total{event,outcome}` (`success|error|dropped`)
- `wp_panel_webhook_delivery_duration_seconds{event,outcome}` (retry + backoff dahil)
- `wp_panel_webhook_queue_size{accountId}`
- `wp_panel_webhook_in_flight{accountId}`

## Webhook Tuning (Opsiyonel)

Yük altında webhook delivery sırası birikebilir. Tek sunucuda stabilite için delivery concurrency ve kuyruk limitini ayarlayabilirsin:

- `WEBHOOK_CONCURRENCY` (default `2`)
- `WEBHOOK_QUEUE_LIMIT` (default `2000`)

## Backup / Restore

Basit yaklaşım: `DATA_DIR` altını yedekle.

- En kritik dosyalar:
  - `data/accounts/*/whatsapp.db`
  - `data/accounts/*/session/` (WhatsApp oturumu)

Restore sonrası PM2 restart yeterlidir.

## Sık Sorunlar

- **QR tekrar istiyor**: `session/` dizini silinmiş/bozulmuş olabilir. Backup’tan geri yükle.
- **CORS sorunları**: `CORS_ORIGINS` doğru domain(ler)i içermeli.
- **/metrics erişimi**: `METRICS_TOKEN` set ise `Authorization: Bearer <token>` zorunlu.
