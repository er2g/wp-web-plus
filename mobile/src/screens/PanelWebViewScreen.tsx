import Constants from 'expo-constants';

import { WebViewTabScreen } from './WebViewTabScreen';

function ensureTrailingSlash(url: string) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return trimmed;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export function PanelWebViewScreen() {
  const url = ensureTrailingSlash((Constants.expoConfig?.extra as any)?.panelUrl || 'https://rammfire.com/wp/');
  return <WebViewTabScreen url={url} />;
}

