function normalizeBaseUrl(raw: string) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export const API_BASE_URL =
  normalizeBaseUrl(process.env.EXPO_PUBLIC_API_BASE_URL || '') || 'https://rammfire.com/wp';

