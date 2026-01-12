import Constants from 'expo-constants';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { createApiClient } from '../api/client';
import { isUnauthorizedError } from '../api/errors';
import { API_BASE_URL } from '../config';
import { getOrCreateDeviceId } from './deviceId';
import { clearSession, loadSession, saveSession } from './sessionStore';
import type { MobileAccount, MobileDevice, MobileNotificationSettings, MobileTokens } from './types';

type SessionState = {
  status: 'loading' | 'signedOut' | 'signedIn';
  tokens: MobileTokens | null;
  accountId: string | null;
  accounts: MobileAccount[];
  notificationSettings: MobileNotificationSettings | null;
  devices: MobileDevice[];
  baseUrl: string;
};

type SessionActions = {
  signIn: (input: { username: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  setAccountId: (accountId: string) => Promise<void>;
  refreshBootstrap: () => Promise<void>;
  updateNotificationSettings: (patch: Partial<MobileNotificationSettings>) => Promise<void>;
  callApi: <T>(fn: (accessToken: string) => Promise<T>) => Promise<T>;
};

type SessionContextValue = SessionState & SessionActions;

const SessionContext = createContext<SessionContextValue | null>(null);

function normalizeSettings(row: any): MobileNotificationSettings {
  const enabled = row?.enabled ?? row?.is_enabled ?? 1;
  const showSenderName = row?.showSenderName ?? row?.show_sender_name ?? 1;
  const showSenderPhoto = row?.showSenderPhoto ?? row?.show_sender_photo ?? 1;
  const showMessagePreview = row?.showMessagePreview ?? row?.show_message_preview ?? 1;
  const sound = row?.sound ?? null;

  return {
    enabled: Boolean(enabled),
    showSenderName: Boolean(showSenderName),
    showSenderPhoto: Boolean(showSenderPhoto),
    showMessagePreview: Boolean(showMessagePreview),
    sound: sound ? String(sound) : null,
  };
}

export function SessionProvider(props: { children: ReactNode }) {
  const api = useMemo(() => createApiClient(), []);
  const baseUrl = api.baseUrl || API_BASE_URL;

  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [tokens, setTokens] = useState<MobileTokens | null>(null);
  const [accountId, setAccountIdState] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<MobileAccount[]>([]);
  const [notificationSettings, setNotificationSettings] = useState<MobileNotificationSettings | null>(null);
  const [devices, setDevices] = useState<MobileDevice[]>([]);

  const tokensRef = useRef<MobileTokens | null>(null);
  const accountIdRef = useRef<string | null>(null);

  const persist = useCallback(
    async (next: { tokens: MobileTokens; accountId: string | null }) => {
      await saveSession({ tokens: next.tokens, accountId: next.accountId, baseUrl });
    },
    [baseUrl]
  );

  const clearPersisted = useCallback(async () => {
    await clearSession();
  }, []);

  const rotateTokens = useCallback(
    async (input: { refreshToken: string; accountId: string | null }) => {
      const rotated = await api.mobileRefresh({ refreshToken: input.refreshToken, accountId: input.accountId });
      const nextTokens: MobileTokens = {
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
        tokenType: rotated.tokenType,
        expiresInSec: rotated.expiresInSec,
      };
      tokensRef.current = nextTokens;
      setTokens(nextTokens);
      await persist({ tokens: nextTokens, accountId: input.accountId });
      return nextTokens;
    },
    [api, persist]
  );

  const withAccessToken = useCallback(
    async <T,>(fn: (accessToken: string) => Promise<T>): Promise<T> => {
      const currentTokens = tokensRef.current;
      const currentAccountId = accountIdRef.current;
      if (!currentTokens?.accessToken) throw new Error('Not authenticated');
      try {
        return await fn(currentTokens.accessToken);
      } catch (err) {
        if (!isUnauthorizedError(err) || !currentTokens.refreshToken) throw err;
        const refreshed = await rotateTokens({ refreshToken: currentTokens.refreshToken, accountId: currentAccountId });
        return fn(refreshed.accessToken);
      }
    },
    [rotateTokens]
  );

  const refreshBootstrap = useCallback(async () => {
    if (!tokensRef.current) return;

    const me = await withAccessToken((accessToken) => api.mobileMe({ accessToken }));
    setNotificationSettings(normalizeSettings(me.notificationSettings));
    setDevices(Array.isArray(me.devices) ? (me.devices as any) : []);

    const acc = await withAccessToken((accessToken) => api.mobileAccounts({ accessToken }));
    setAccounts(acc.accounts || []);
    const nextAccountId = accountIdRef.current || acc.defaultAccountId || acc.accounts?.[0]?.id || null;
    if (nextAccountId !== accountIdRef.current) {
      accountIdRef.current = nextAccountId;
      setAccountIdState(nextAccountId);
      if (tokensRef.current) await persist({ tokens: tokensRef.current, accountId: nextAccountId });
    }

    const deviceId = await getOrCreateDeviceId();
    await withAccessToken((accessToken) =>
      api.upsertDevice({
        accessToken,
        deviceId,
        platform: Platform.OS,
        pushProvider: Platform.OS === 'ios' ? 'apns' : 'fcm',
        pushToken: null,
        appVersion: Constants.expoConfig?.version || null,
        locale: null,
        timezone: null,
      })
    );
  }, [api, persist, withAccessToken]);

  const bootstrapFromStorage = useCallback(async () => {
    const saved = await loadSession();
    if (!saved) {
      setStatus('signedOut');
      return;
    }
    if (saved.baseUrl && saved.baseUrl !== baseUrl) {
      await clearPersisted();
      setStatus('signedOut');
      return;
    }

    tokensRef.current = saved.tokens;
    accountIdRef.current = saved.accountId || null;
    setTokens(saved.tokens);
    setAccountIdState(saved.accountId || null);
    setStatus('signedIn');

    try {
      await refreshBootstrap();
    } catch (err) {
      if (isUnauthorizedError(err)) {
        tokensRef.current = null;
        accountIdRef.current = null;
        setTokens(null);
        setAccountIdState(null);
        setAccounts([]);
        setNotificationSettings(null);
        setDevices([]);
        await clearPersisted();
        setStatus('signedOut');
      }
    }
  }, [baseUrl, clearPersisted, refreshBootstrap]);

  useEffect(() => {
    bootstrapFromStorage();
  }, [bootstrapFromStorage]);

  const signIn = useCallback(
    async (input: { username: string; password: string }) => {
      const login = await api.mobileLogin({
        username: input.username.trim().toLowerCase(),
        password: input.password,
      });

      const nextTokens: MobileTokens = {
        accessToken: login.accessToken,
        refreshToken: login.refreshToken,
        tokenType: login.tokenType,
        expiresInSec: login.expiresInSec,
      };

      tokensRef.current = nextTokens;
      setTokens(nextTokens);
      setStatus('signedIn');

      const acc = await api.mobileAccounts({ accessToken: nextTokens.accessToken });
      const nextAccountId = acc.defaultAccountId || acc.accounts?.[0]?.id || null;
      setAccounts(acc.accounts || []);
      accountIdRef.current = nextAccountId;
      setAccountIdState(nextAccountId);
      await persist({ tokens: nextTokens, accountId: nextAccountId });

      await refreshBootstrap();
    },
    [api, persist, refreshBootstrap]
  );

  const signOut = useCallback(async () => {
    try {
      if (tokens?.accessToken) {
        await api.mobileLogout({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || undefined });
      }
    } catch {}

    setStatus('signedOut');
    tokensRef.current = null;
    accountIdRef.current = null;
    setTokens(null);
    setAccountIdState(null);
    setAccounts([]);
    setNotificationSettings(null);
    setDevices([]);
    await clearPersisted();
  }, [api, clearPersisted, tokens]);

  const setAccountId = useCallback(
    async (nextAccountId: string) => {
      accountIdRef.current = nextAccountId;
      setAccountIdState(nextAccountId);
      if (tokensRef.current) await persist({ tokens: tokensRef.current, accountId: nextAccountId });
    },
    [persist]
  );

  const updateNotificationSettings = useCallback(
    async (patch: Partial<MobileNotificationSettings>) => {
      await withAccessToken((accessToken) =>
        api.updateNotificationSettings({
          accessToken,
          enabled: patch.enabled,
          showSenderName: patch.showSenderName,
          showSenderPhoto: patch.showSenderPhoto,
          showMessagePreview: patch.showMessagePreview,
          sound: patch.sound,
        })
      );

      const updated = await withAccessToken((accessToken) => api.getNotificationSettings({ accessToken }));
      setNotificationSettings(normalizeSettings(updated));
    },
    [api, withAccessToken]
  );

  const value: SessionContextValue = {
    status,
    tokens,
    accountId,
    accounts,
    notificationSettings,
    devices,
    baseUrl,
    signIn,
    signOut,
    setAccountId,
    refreshBootstrap,
    updateNotificationSettings,
    callApi: withAccessToken,
  };

  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('SessionProvider missing');
  return ctx;
}
