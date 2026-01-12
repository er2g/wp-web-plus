# WpPanel Mobile

Bu klasör `wp-panel` backend’i için (token bazlı) yeni mobil uygulama başlangıcıdır.

## Kurulum
1) `cd mobile`
2) `npm install`
3) API adresini ver:
   - üretim: `EXPO_PUBLIC_API_BASE_URL=https://rammfire.com/wp`
   - local: `EXPO_PUBLIC_API_BASE_URL=http://localhost:3000`

Örnek:
```bash
cd mobile
export EXPO_PUBLIC_API_BASE_URL="https://rammfire.com/wp"
npm install
npm run android
```

## Özellikler (şu an)
- Token bazlı giriş + kalıcı oturum (SecureStore)
- Sohbet listesi + arama
- Sohbet detayında mesajlar + mesaj gönderme
- Mobil bildirim ayarları (backend `/api/mobile/notification-settings`)
- Sohbet sessize alma (backend `/api/mobile/chats/:id/notification-settings`)
- Cihaz kaydı (push entegrasyonu için hazır API: `/api/mobile/devices`)

Not: Push bildirimleri için Android’de Firebase yapılandırması (`google-services.json`) gerekir.

## Kontroller
- `npm run typecheck`
- `npm run doctor`

## Backend gereksinimi
- Mobil login: `POST /api/mobile/login`
- Bearer token ile REST: `GET /api/chats` vb.

Detaylı yol haritası: `docs/MOBILE_APP_PLAN.md`
