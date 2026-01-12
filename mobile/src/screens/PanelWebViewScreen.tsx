import Constants from 'expo-constants';

import { WebViewTabScreen } from './WebViewTabScreen';
import { useSession } from '../session/SessionContext';

function ensureTrailingSlash(url: string) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return trimmed;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export function PanelWebViewScreen() {
  const session = useSession();
  const baseUrl = ensureTrailingSlash(session.baseUrl || (Constants.expoConfig?.extra as any)?.panelUrl || 'https://rammfire.com/wp/');
  const accessToken = session.tokens?.accessToken || null;

  const url = accessToken ? `${baseUrl}auth/mobile/session?redirect=/` : baseUrl;

  return (
    <WebViewTabScreen
      url={url}
      headers={accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined}
    />
  );
}
