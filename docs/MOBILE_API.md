# Mobile Backend / API

Bu proje web panel için session + CSRF kullanır. Mobil uygulama için ayrıca **token tabanlı (Bearer JWT)** akış eklendi.

## 1) Giriş / Token

- `POST /api/mobile/login`
  - Body: `{ "username": "...", "password": "...", "accountId": "default", "deviceId": "...", "pushToken": "...", ... }`
  - Response: `{ accessToken, refreshToken, expiresInSec, tokenType, user, notificationSettings }`

- `POST /api/mobile/refresh`
  - Body: `{ "refreshToken": "...", "accountId": "default" }`
  - Refresh token **rotate edilir** (yenisi döner).

- `POST /api/mobile/logout`
  - Header: `Authorization: Bearer <accessToken>`
  - Body: `{ "refreshToken": "...", "all": false }`

## 2) Mevcut `/api/*` endpoint’leri mobilde kullanma

Mobil uygulama, `Authorization: Bearer <accessToken>` ile mevcut web API’lerini de kullanabilir:

- Sohbet listesi: `GET /api/chats`
- Mesajlar: `GET /api/chats/:id/messages`
- Mesaj gönderme: `POST /api/send` (text/media)
- Okundu işaretleme: `POST /api/chats/:id/mark-read`
- Medya: `GET /api/media/:filename`

Not: Bearer ile gelen isteklerde CSRF aranmaz (session/cookie istekleri için CSRF devam eder).

## 3) Cihaz kaydı (Push token)

- `PUT /api/mobile/devices`
  - Header: `Authorization: Bearer <accessToken>`
  - Body: `{ "deviceId": "...", "platform": "android|ios", "pushProvider": "fcm", "pushToken": "..." }`

- `GET /api/mobile/devices`
- `DELETE /api/mobile/devices/:deviceId`

## 4) Bildirim ayarları

- Global ayarlar:
  - `GET /api/mobile/notification-settings`
  - `PUT /api/mobile/notification-settings`
    - Body örnek: `{ "showMessagePreview": false, "showSenderPhoto": true }`

- Chat bazında sessize alma:
  - `GET /api/mobile/chats/:id/notification-settings`
  - `PUT /api/mobile/chats/:id/notification-settings`
    - Body: `{ "mutedUntil": <epochMs|null> }` (`null` -> mute kaldır)

## 5) Hesaplar (multi-account)

- `GET /api/mobile/accounts`
  - Header: `Authorization: Bearer <accessToken>`
  - Response: `{ accounts: [{ id, name, status }], defaultAccountId }`

Mobil isteklerde `X-Account-Id: <accountId>` header’ı ile hangi WhatsApp hesabı kullanılacağı seçilebilir (mevcut `/api/*` endpoint’lerinde de çalışır).

## 6) Push gönderimi (opsiyonel)

Gelen mesajlarda (incoming) push tetiklenmesi için env:

- `PUSH_NOTIFICATIONS_ENABLED=true`
- `PUSH_FCM_SERVER_KEY=...`
- `PUBLIC_BASE_URL=https://panel.domain.com` (bildirim görseli için opsiyonel)

