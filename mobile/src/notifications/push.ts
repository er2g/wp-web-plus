import { Platform } from 'react-native';

export type PushRegistration = {
  provider: 'fcm' | 'apns';
  token: string;
};

export async function registerForPushAsync(): Promise<PushRegistration | null> {
  void Platform.OS;
  return null;
}
