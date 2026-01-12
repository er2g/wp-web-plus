import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export type PushRegistration = {
  provider: 'fcm' | 'apns';
  token: string;
};

export type PushRegistrationResult =
  | { ok: true; value: PushRegistration }
  | { ok: false; step: string; message: string; detail?: string };

function stringifyError(err: unknown): string {
  if (!err) return '';
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export async function registerForPushAsync(): Promise<PushRegistrationResult> {
  if (!Device.isDevice) {
    return {
      ok: false,
      step: 'device',
      message: 'Emülatör/simülatörde push token alınamaz.',
    };
  }

  let status: Notifications.PermissionStatus = Notifications.PermissionStatus.UNDETERMINED;
  try {
    const existing = await Notifications.getPermissionsAsync();
    status = existing.status;
    if (status !== Notifications.PermissionStatus.GRANTED) {
      const requested = await Notifications.requestPermissionsAsync();
      status = requested.status;
    }
  } catch (err) {
    return { ok: false, step: 'permission', message: 'Bildirim izni sorgulanamadı.', detail: stringifyError(err) };
  }

  if (status !== Notifications.PermissionStatus.GRANTED) {
    return { ok: false, step: 'permission', message: 'Bildirim izni verilmedi.' };
  }

  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#2563eb',
      });
    }
  } catch (err) {
    return { ok: false, step: 'channel', message: 'Bildirim kanalı oluşturulamadı.', detail: stringifyError(err) };
  }

  try {
    const token = await Notifications.getDevicePushTokenAsync();
    if (!token?.data) {
      return {
        ok: false,
        step: 'token',
        message: 'Push token boş döndü.',
        detail: stringifyError(token),
      };
    }

    const provider: PushRegistration['provider'] = token.type === 'apns' ? 'apns' : 'fcm';
    return { ok: true, value: { provider, token: token.data } };
  } catch (err) {
    return {
      ok: false,
      step: 'token',
      message:
        'Push token alınamadı. Android cihazında Google Play Services yoksa / Firebase yapılandırması hatalıysa bu olur.',
      detail: stringifyError(err),
    };
  }
}
