import Constants from 'expo-constants';

function normalizeBaseUrl(raw: string) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function fromExpoExtra(): string {
  const extra = Constants.expoConfig?.extra as any;
  return normalizeBaseUrl(extra?.panelUrl || '');
}

export const API_BASE_URL =
  normalizeBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL || '') || fromExpoExtra() || 'https://rammfire.com/wp';
