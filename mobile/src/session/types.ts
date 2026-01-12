export type MobileTokens = {
  accessToken: string;
  refreshToken: string;
  tokenType?: string;
  expiresInSec?: number;
};

export type MobileNotificationSettings = {
  enabled: boolean;
  showSenderName: boolean;
  showSenderPhoto: boolean;
  showMessagePreview: boolean;
  sound: string | null;
};

export type MobileDevice = {
  device_id: string;
  platform: string | null;
  push_provider: string | null;
  push_token: string | null;
  app_version: string | null;
  locale: string | null;
  timezone: string | null;
  last_seen_at: number | null;
};

export type MobileAccount = { id: string; name: string; createdAt: number; status?: string };

