import { deleteSecureKey, getSecureJson, setSecureJson } from '../storage/secure';
import type { MobileTokens } from './types';

const SESSION_KEY = 'wpPanel.session.v1';

export type PersistedSession = {
  tokens: MobileTokens;
  accountId: string | null;
  baseUrl: string;
};

export async function loadSession(): Promise<PersistedSession | null> {
  return getSecureJson<PersistedSession>(SESSION_KEY);
}

export async function saveSession(session: PersistedSession): Promise<void> {
  await setSecureJson(SESSION_KEY, session);
}

export async function clearSession(): Promise<void> {
  await deleteSecureKey(SESSION_KEY);
}

