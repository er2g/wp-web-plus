import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export type PushRegistration = {
  provider: 'fcm' | 'apns';
  token: string;
};

export async function registerForPushAsync(): Promise<PushRegistration | null> {
  if (!Device.isDevice) return null;

  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync();
      status = requested.status;
    }

    if (status !== 'granted') return null;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#2563eb',
      });
    }

    const token = await Notifications.getDevicePushTokenAsync();
    if (!token?.data) return null;

    const provider: PushRegistration['provider'] = token.type === 'apns' ? 'apns' : 'fcm';
    return { provider, token: token.data };
  } catch {
    return null;
  }
}
