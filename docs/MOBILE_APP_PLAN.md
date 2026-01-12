# Mobil Uygulama (Sıfırdan) Planı

Bu repo içinde yeni mobil uygulama hedefi: web panelin temel işlevlerini (giriş, hesap seçimi, sohbetler, mesajlar, gönderim) **en az bakım**, **en az hata yüzeyi** ve **profesyonel release süreci** ile iOS/Android’e taşımak.

## Temel karar: Expo (React Native) – Managed + EAS Build
- Tek kod tabanı (iOS + Android)
- Native ayarlarla boğuşmadan hızlı iterasyon
- Release/OTA update (EAS Update) ile üretimde daha az “yeniden build” ihtiyacı

## Kimlik doğrulama / güvenlik
- Mobil taraf **CSRF kullanmayacak**; sadece `Authorization: Bearer <accessToken>` ile çalışacak.
- Backend zaten mobil için token uçlarını sağlıyor:
  - `POST /api/mobile/login`
  - `POST /api/mobile/refresh`
  - `POST /api/mobile/logout`
  - `GET /api/mobile/me`
  - `GET /api/mobile/accounts`
- Tokenlar cihazda **Secure Store**’da saklanacak (plain AsyncStorage yok).

## API kullanımı (V1)
- Hesap seçimi: `GET /api/mobile/accounts`
- Sohbet listesi: `GET /api/chats`
- Mesajlar: `GET /api/messages`
- Mesaj gönder: `POST /api/send`
- Hesap bağlamı: isteklerde `X-Account-Id: <accountId>` header’ı kullanılacak.

## Gerçek zamanlılık (V1 → V2)
- V1: “pull-to-refresh” + periyodik hafif polling (opsiyonel) ile stabil başlangıç.
- V2: Socket.IO istemcisi eklenip “yeni mesaj” anlık akıtılabilir (daha karmaşık; V1’i geciktirmemek için sonraya).

## Uygulama mimarisi (öneri)
- Expo + TypeScript
- `expo-router` ile ekran/routing
- `@tanstack/react-query` ile cache + retry + background refetch
- `zod` ile API response doğrulama (hataları erken yakalar)
- Tek bir `apiClient`:
  - otomatik `Authorization` header
  - 401’de 1 kez refresh dene, tekrar çağır

## Konfigürasyon
- Mobil uygulamada tek zorunlu env:
  - `EXPO_PUBLIC_API_BASE_URL=https://rammfire.com/wp` (sonunda `/api` yok; client ekleyecek)
- Dev için:
  - emülatörde `http://10.0.2.2:3000` (Android) / `http://localhost:3000` (iOS sim)

## Fazlar
### Faz 0 (Bu PR)
- Repo içinde `mobile/` Expo iskeleti
- Token bazlı auth + API client + temel ekranlar (login + chats placeholder)

### Faz 1 (MVP)
- Login ekranı + token saklama + refresh akışı
- Hesap seçimi (default account auto)
- Sohbet listesi + mesaj listesi + mesaj gönder
- Basit hata ekranları + loading durumları

### Faz 2 (Üretim kalitesi)
- Push token kaydı: `PUT /api/mobile/devices` (FCM/APNS)
- Bildirim ayarları ekranı: `/api/mobile/notification-settings`
- Chat bazlı mute: `/api/mobile/chats/:id/notification-settings`
- Crash reporting (Sentry) + release kanalı (EAS)

## Release akışı (öneri)
- EAS Build:
  - `eas build -p android --profile production`
  - `eas build -p ios --profile production`
- EAS Update (opsiyonel):
  - küçük UI düzeltmeleri için OTA

