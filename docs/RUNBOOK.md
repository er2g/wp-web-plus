# Runbook (Tek Sunucu + PM2)

Bu doküman, projeyi tek sunucuda **stabil** ve **ölçülebilir** şekilde çalıştırmak için pratik operasyon adımlarını özetler.

## Ön Koşullar

- Node.js 18+
- `whatsapp-web.js` için Chromium/Puppeteer bağımlılıkları (distro’ya göre değişir)
- (Önerilir) Redis: `REDIS_URL` set edilirse session + Socket.IO için önerilir (restart sonrası session kalır)
  - (Opsiyonel) Redis Job Queue: `JOB_QUEUE_ENABLED=true` ile scheduler/cleanup + scheduled messages BullMQ üzerinden çalışır

### Redis (Session Store) Kurulumu

Ubuntu için:

```bash
sudo apt-get update
sudo apt-get install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping
```

`.env` içine ekle:

```bash
REDIS_URL=redis://127.0.0.1:6379
REDIS_PREFIX=wp-panel:
```

### Redis Job Queue (BullMQ) (Opsiyonel)

Çoklu instance hedefinde background job’ları standardize etmek için:

```bash
JOB_QUEUE_ENABLED=true
JOB_QUEUE_CONCURRENCY=4
```

Notlar:
- Queue job’ları Redis’te tutulur; bir job aynı anda tek worker tarafından işlenir.
- “Vault locked” durumda scheduled message job’ları retry olur (kullanıcı bir instance’ta login olup hesabı unlock edene kadar).

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

## Media Storage (Local / Drive / S3)

Medya saklama davranışı `MEDIA_STORAGE_PROVIDER` ile seçilir:

- `auto` (default): WhatsApp ayarındaki `uploadToDrive` üzerinden `local` vs `drive` seçer.
- `local`: medya dosyaları `media/` altında kalır.
- `drive`: Google Drive’a upload eder, **public paylaşım kapalıdır** ve medya `api/media/drive/<fileId>` üzerinden **auth ile** servis edilir.
- `s3`: S3 uyumlu storage’a upload eder, medya `api/media/s3/<key>` üzerinden **auth ile** servis edilir.

Drive için:

```bash
DRIVE_FOLDER_ID=...
DRIVE_PUBLIC_SHARING=false
```

S3 için:

```bash
MEDIA_STORAGE_PROVIDER=s3
S3_ENDPOINT=http://127.0.0.1:9000   # MinIO örneği
S3_REGION=us-east-1
S3_BUCKET=wp-panel-media
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
```

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
- Zero-knowledge vault anahtarları RAM’de tutulur; restart sonrası UI “Kilidi Aç” akışı ile parolayı tekrar ister (`POST /auth/unlock`).
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
- **WhatsApp connect takılı kalıyor / Target closed**:
  - `WHATSAPP_INIT_TIMEOUT_MS` ile init timeout koy (varsayılan `60000`).
  - Orphan Chromium prosesleri kalmış olabilir: `pm2 stop whatsapp-panel` → `pkill -f \"user-data-dir=.*data/accounts/.*/session/session\"` → `pm2 restart whatsapp-panel`.
- **CORS sorunları**: `CORS_ORIGINS` doğru domain(ler)i içermeli.
- **/metrics erişimi**: `METRICS_TOKEN` set ise `Authorization: Bearer <token>` zorunlu.
