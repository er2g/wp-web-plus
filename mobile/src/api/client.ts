import { API_BASE_URL } from '../config';
import { ApiError } from './errors';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

type MobileLoginResponse = {
  success: true;
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer' | string;
  expiresInSec: number;
  user?: {
    id: number;
    username: string;
    displayName?: string | null;
    role?: string;
    isActive?: boolean;
  };
};

type MobileAccountsResponse = {
  accounts: Array<{ id: string; name: string; createdAt: number; status?: string }>;
  defaultAccountId: string;
};

export function createApiClient() {
  const baseUrl = API_BASE_URL;

  async function requestJson<T>(path: string, opts: RequestInit & { json?: JsonValue } = {}): Promise<T> {
    const url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers = new Headers(opts.headers || {});

    let body = opts.body;
    if (opts.json !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(opts.json);
    }

    const res = await fetch(url, {
      ...opts,
      headers,
      body,
    });

    const text = await res.text();
    const data = text ? (JSON.parse(text) as any) : null;

    if (!res.ok) {
      const message = data?.error || data?.message || `HTTP ${res.status}`;
      throw new ApiError(message, res.status, data);
    }

    return data as T;
  }

  async function mobileRefresh(input: { refreshToken: string; accountId?: string | null }) {
    return requestJson<{
      success: true;
      userId: number;
      accessToken: string;
      refreshToken: string;
      tokenType: 'Bearer' | string;
      expiresInSec: number;
    }>('/api/mobile/refresh', {
      method: 'POST',
      json: {
        refreshToken: input.refreshToken,
        accountId: input.accountId || undefined,
      },
    });
  }

  async function mobileLogin(input: { username: string; password: string }) {
    return requestJson<MobileLoginResponse>('/api/mobile/login', {
      method: 'POST',
      json: {
        username: input.username,
        password: input.password,
      },
    });
  }

  async function mobileAccounts(input: { accessToken: string }) {
    return requestJson<MobileAccountsResponse>('/api/mobile/accounts', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
      },
    });
  }

  async function mobileMe(input: { accessToken: string }) {
    return requestJson<{
      user: { id: number; username: string; displayName?: string | null; role?: string; isActive?: boolean };
      notificationSettings: any;
      devices: any[];
    }>('/api/mobile/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
      },
    });
  }

  async function mobileLogout(input: { accessToken: string; refreshToken?: string | null; all?: boolean }) {
    return requestJson<{ success: true }>('/api/mobile/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
      },
      json: {
        refreshToken: input.refreshToken || undefined,
        all: Boolean(input.all),
      },
    });
  }

  async function upsertDevice(input: {
    accessToken: string;
    deviceId: string;
    platform?: string | null;
    pushProvider?: 'fcm' | 'apns' | undefined;
    pushToken?: string | null;
    appVersion?: string | null;
    locale?: string | null;
    timezone?: string | null;
  }) {
    return requestJson<{ success: true }>('/api/mobile/devices', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${input.accessToken}` },
      json: {
        deviceId: input.deviceId,
        platform: input.platform || undefined,
        pushProvider: input.pushProvider,
        pushToken: input.pushToken || undefined,
        appVersion: input.appVersion || undefined,
        locale: input.locale || undefined,
        timezone: input.timezone || undefined,
      },
    });
  }

  async function getNotificationSettings(input: { accessToken: string }) {
    return requestJson<any>('/api/mobile/notification-settings', {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
  }

  async function updateNotificationSettings(input: {
    accessToken: string;
    enabled?: boolean;
    showSenderName?: boolean;
    showSenderPhoto?: boolean;
    showMessagePreview?: boolean;
    sound?: string | null;
  }) {
    return requestJson<any>('/api/mobile/notification-settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${input.accessToken}` },
      json: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.showSenderName !== undefined ? { showSenderName: input.showSenderName } : {}),
        ...(input.showSenderPhoto !== undefined ? { showSenderPhoto: input.showSenderPhoto } : {}),
        ...(input.showMessagePreview !== undefined ? { showMessagePreview: input.showMessagePreview } : {}),
        ...(input.sound !== undefined ? { sound: input.sound } : {}),
      },
    });
  }

  async function listChats(input: { accessToken: string; accountId?: string }) {
    return requestJson<Array<{ chat_id: string; name?: string | null }>>('/api/chats', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        ...(input.accountId ? { 'X-Account-Id': input.accountId } : {}),
      },
    });
  }

  async function getChatMessages(input: { accessToken: string; accountId?: string; chatId: string; limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (input.limit) params.set('limit', String(input.limit));
    if (input.offset) params.set('offset', String(input.offset));
    const qs = params.toString();
    return requestJson<{ messages: any[]; tags: any[]; notes: any[] }>(`/api/chats/${encodeURIComponent(input.chatId)}/messages${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        ...(input.accountId ? { 'X-Account-Id': input.accountId } : {}),
      },
    });
  }

  async function sendMessage(input: { accessToken: string; accountId?: string; chatId: string; message: string }) {
    return requestJson<{ success: true; messageId: string }>('/api/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        ...(input.accountId ? { 'X-Account-Id': input.accountId } : {}),
      },
      json: {
        chatId: input.chatId,
        message: input.message,
      },
    });
  }

  return {
    baseUrl,
    mobileRefresh,
    mobileLogin,
    mobileAccounts,
    mobileMe,
    mobileLogout,
    mobilePushStatus: async (input: { accessToken: string }) => {
      return requestJson<{ enabled: boolean; hasServerKey: boolean; publicBaseUrl: string | null }>('/api/mobile/push/status', {
        method: 'GET',
        headers: { Authorization: `Bearer ${input.accessToken}` },
      });
    },
    mobilePushTest: async (input: { accessToken: string; title?: string; body?: string }) => {
      return requestJson<{ success: true; result: any }>('/api/mobile/push/test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.accessToken}` },
        json: {
          ...(input.title ? { title: input.title } : {}),
          ...(input.body ? { body: input.body } : {}),
        },
      });
    },
    upsertDevice,
    getNotificationSettings,
    updateNotificationSettings,
    listChats,
    getChatMessages,
    sendMessage,
    getChatNotificationSettings: async (input: { accessToken: string; accountId?: string; chatId: string }) => {
      return requestJson<any>(`/api/mobile/chats/${encodeURIComponent(input.chatId)}/notification-settings`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          ...(input.accountId ? { 'X-Account-Id': input.accountId } : {}),
        },
      });
    },
    setChatMute: async (input: { accessToken: string; accountId?: string; chatId: string; mutedUntil: number | null }) => {
      return requestJson<any>(`/api/mobile/chats/${encodeURIComponent(input.chatId)}/notification-settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          ...(input.accountId ? { 'X-Account-Id': input.accountId } : {}),
        },
        json: { mutedUntil: input.mutedUntil },
      });
    },
  };
}
