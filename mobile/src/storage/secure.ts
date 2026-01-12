import * as SecureStore from 'expo-secure-store';

export async function getSecureJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export async function setSecureJson(key: string, value: unknown): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, JSON.stringify(value));
  } catch {
    // Intentionally ignore (some devices/ROMs can throw on keystore access).
  }
}

export async function deleteSecureKey(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Intentionally ignore.
  }
}
