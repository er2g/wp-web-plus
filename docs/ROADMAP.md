# Roadmap (Best Practices)

Bu doküman, projeyi daha **stabil**, **test edilebilir** ve **ölçeklenebilir** hale getirmek için önerilen adımları öncelik sırasıyla listeler.

## Durum (tamamlananlar)

- **Request validation (Zod)**: `/api` endpoint’lerinde standard validation middleware + tutarlı `400` response (`{ error, requestId, issues[] }`).
- **Error response standardı**: `/api` ve `/auth` için tutarlı `{ error, requestId }` + JSON `404`.
- **Observability**: `/openapi.json`, `/docs` (admin), `/metrics` (token ile) + pipeline/webhook metrikleri.
- **State persistence**: WhatsApp ayarları DB’de persist (restart sonrası stabil).
- **Graceful shutdown**: webhook queue drain + `/readyz` shutdown state + PM2 kill_timeout uyumu.
- **CI kalite kapısı**: `npm run lint` + `npm test` (GitHub Actions).

## Kısa vadeli (hemen katkı / düşük risk)

- **OpenAPI’yi canlı tut**: yeni endpoint/alan ekledikçe `docs/openapi.json` güncelle.
- **Alerting/SLO**: 5xx oranı, latency p95, webhook error rate, CPU/RAM gibi temel alarmlar.
- **Üretim secrets**: `.env` yerine secret store (en azından PM2 env + dosya izinleri).

## Orta vadeli (ölçek / servis orkestrasyonu)

- **API vs Worker ayrımı (PM2)**:
  - API prosesleri: HTTP + Socket.IO (stateless).
  - Worker prosesi: WhatsApp bağlantısı (LocalAuth) + scheduler/cleanup + webhook/script side-effect’leri.
  - İletişim: Redis pub/sub veya queue (BullMQ) ile event taşıma; DB sadece state persistence.
- **Multi-instance prensibi**:
  - `express-session` için Redis store + Socket.IO Redis adapter + **sticky session**.
  - WhatsApp Web oturumu (LocalAuth) çoğaltılamaz; tek worker öner.
- **Idempotency & retry**:
  - Webhook delivery replay ve send endpoint’lerinde idempotency key / job id ile tekrarları güvenli hale getir.

## Uzun vadeli (operasyonel olgunluk)

- **Tracing**: OpenTelemetry ile request → message pipeline → webhook/script chain’i izlenebilir hale getir.
- **SLO/Alerting**: `/readyz`, `/metrics` üzerinden temel alarm setleri (5xx oranı, latency p95, queue lag, webhook hata oranı).
- **Dağıtım standardı**: Docker/compose veya systemd + PM2 runbook; secrets yönetimi (dotenv yerine secret store).
