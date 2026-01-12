import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export type PushRegistration = {
  provider: 'fcm' | 'apns';
  token: string;
};

export async function registerForPushAsync(): Promise<PushRegistration | null> {
  const current = await Notifications.getPermissionsAsync();
  if (!current.granted) {
    const requested = await Notifications.requestPermissionsAsync();
    if (!requested.granted) return null;
  }

  const deviceToken = await Notifications.getDevicePushTokenAsync();
  const raw = (deviceToken as any)?.data ? String((deviceToken as any).data) : '';
  if (!raw) return null;

  const provider: 'fcm' | 'apns' = Platform.OS === 'ios' ? 'apns' : 'fcm';
  return { provider, token: raw };
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});
