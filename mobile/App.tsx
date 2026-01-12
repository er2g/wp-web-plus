import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { RootNavigator } from './src/navigation/RootNavigator';
import { RealtimeProvider } from './src/realtime/RealtimeContext';
import { SessionProvider, useSession } from './src/session/SessionContext';
import { colors } from './src/theme/colors';

export default function App() {
  return (
    <SessionProvider>
      <RealtimeProvider>
        <AppShell />
      </RealtimeProvider>
    </SessionProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});

function AppShell() {
  const session = useSession();

  if (session.status === 'loading') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.subtext }}>Yükleniyor…</Text>
        </View>
        <StatusBar style="light" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <RootNavigator />
      <StatusBar style="light" />
    </SafeAreaView>
  );
}
