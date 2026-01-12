import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { RootNavigator } from './src/navigation/RootNavigator';
import { ErrorBoundary } from './src/crash/ErrorBoundary';
import { SessionProvider } from './src/session/SessionContext';
import { colors } from './src/theme/colors';

export default function App() {
  const [fatal, setFatal] = useState<Error | null>(null);

  useEffect(() => {
    const ErrorUtilsAny = (global as any)?.ErrorUtils;
    if (!ErrorUtilsAny?.setGlobalHandler) return;

    const previousHandler = ErrorUtilsAny.getGlobalHandler?.() || null;
    ErrorUtilsAny.setGlobalHandler((err: any, isFatal: boolean) => {
      const error = err instanceof Error ? err : new Error(String(err?.message || err));
      console.error('Global JS error', { message: error.message, isFatal });
      setFatal(error);
    });

    return () => {
      if (previousHandler) ErrorUtilsAny.setGlobalHandler(previousHandler);
    };
  }, []);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      {fatal ? (
        <View style={{ flex: 1, padding: 16, justifyContent: 'center' }}>
          <Text style={{ color: colors.text, fontSize: 22, fontWeight: '900' }}>Uygulama hatası</Text>
          <Text style={{ marginTop: 8, color: colors.subtext, fontSize: 13, lineHeight: 18 }}>
            Açılışta hata aldı. Bu mesajı bana at.
          </Text>
          <View
            style={{
              marginTop: 14,
              backgroundColor: colors.card,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 12,
              padding: 12,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 12 }}>{fatal.message}</Text>
          </View>
        </View>
      ) : (
        <ErrorBoundary onError={(e) => console.error('React render error', e)}>
          <SessionProvider>
            <RootNavigator />
          </SessionProvider>
        </ErrorBoundary>
      )}
      <StatusBar style="light" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
