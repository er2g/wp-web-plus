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

## Backend gereksinimi
- Mobil login: `POST /api/mobile/login`
- Bearer token ile REST: `GET /api/chats` vb.

Detaylı yol haritası: `docs/MOBILE_APP_PLAN.md`

