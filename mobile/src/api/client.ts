import { API_BASE_URL } from '../config';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
      throw new Error(message);
    }

    return data as T;
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

  async function listChats(input: { accessToken: string; accountId?: string }) {
    return requestJson<Array<{ chat_id: string; name?: string | null }>>('/api/chats', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        ...(input.accountId ? { 'X-Account-Id': input.accountId } : {}),
      },
    });
  }

  return {
    baseUrl,
    mobileLogin,
    mobileAccounts,
    mobileLogout,
    listChats,
  };
}

