import Constants from 'expo-constants';

import { WebViewTabScreen } from './WebViewTabScreen';

function joinPhoneUrl(panelUrl: string) {
  const trimmed = String(panelUrl || '').trim();
  const base = trimmed || 'https://rammfire.com/wp/';
  try {
    // Critical: keep `/phone` WITHOUT trailing slash so relative requests like `api/mobile/me`
    // resolve to `${base}api/mobile/me` instead of `${base}phone/api/mobile/me`.
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    return new URL('phone', normalizedBase).toString();
  } catch {
    return 'https://rammfire.com/wp/phone';
  }
}

export function PhoneWebViewScreen() {
  const panelUrl = (Constants.expoConfig?.extra as any)?.panelUrl || 'https://rammfire.com/wp/';
  return <WebViewTabScreen url={joinPhoneUrl(panelUrl)} />;
}
