import Constants from 'expo-constants';

import { WebViewTabScreen } from './WebViewTabScreen';

function joinPhoneUrl(panelUrl: string) {
  const base = String(panelUrl || '').trim() || 'https://rammfire.com/wp/';
  // Critical: keep `/phone` WITHOUT trailing slash so relative requests like `api/mobile/me`
  // resolve to `${base}api/mobile/me` instead of `${base}phone/api/mobile/me`.
  const normalizedBase = base.replace(/\/+$/, '') + '/';
  return normalizedBase + 'phone';
}

export function PhoneWebViewScreen() {
  const panelUrl = (Constants.expoConfig?.extra as any)?.panelUrl || 'https://rammfire.com/wp/';
  return <WebViewTabScreen url={joinPhoneUrl(panelUrl)} />;
}
