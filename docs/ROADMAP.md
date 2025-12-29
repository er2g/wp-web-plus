# Roadmap (Best Practices)

Bu doküman, projeyi daha **stabil**, **test edilebilir** ve **ölçeklenebilir** hale getirmek için önerilen adımları öncelik sırasıyla listeler.

## Kısa vadeli (hemen katkı / düşük risk)

- **Request validation standardı**: `/api` altındaki endpoint’ler için ortak bir validation middleware’ine geç (Zod/Ajv gibi). Şimdilik kritik endpoint’lerden (send/webhooks/scripts) başlayıp kademeli genişlet.
- **Error response standardı**: Tüm hatalarda `{ error, requestId }` formatını garanti et (özellikle 4xx validation hataları).
- **Metrics güvenliği**: `METRICS_ENABLED=true` kullanılacaksa prod’da `METRICS_TOKEN` ile koru; dış dünyaya açık ise ters proxy’den de IP allowlist uygula.
- **OpenAPI’yi canlı tut**: `docs/openapi.json` kapsamını yeni endpoint ekledikçe güncelle; CI’da en azından JSON parse + kritik path’lerin varlığını doğrula.
- **Test katmanları**: Var olan entegrasyon testlerini (node:test) koru; yeni feature eklerken “önce test” ile ilerle.

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

