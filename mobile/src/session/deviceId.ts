import { Platform } from 'react-native';

import { getSecureJson, setSecureJson } from '../storage/secure';

const DEVICE_ID_KEY = 'wpPanel.deviceId.v1';

function makeDeviceId() {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `wp-panel-${Platform.OS}-${suffix}`.slice(0, 200);
}

export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await getSecureJson<{ deviceId: string }>(DEVICE_ID_KEY);
  if (existing?.deviceId) return existing.deviceId;
  const deviceId = makeDeviceId();
  await setSecureJson(DEVICE_ID_KEY, { deviceId });
  return deviceId;
}

