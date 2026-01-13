import { useMemo, useState } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { createApiClient } from '../api/client';
import { useSession } from '../session/SessionContext';
import { colors } from '../theme/colors';
import { Button } from '../ui/components/Button';

function ensureTrailingSlash(url: string) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return trimmed;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

async function openUrl(url: string) {
  try {
    await Linking.openURL(url);
  } catch (err) {
    Alert.alert('Açılamadı', err instanceof Error ? err.message : 'Bilinmeyen hata');
  }
}

export function ToolsScreen() {
  const session = useSession();
  const api = useMemo(() => createApiClient(), []);
  const base = useMemo(() => ensureTrailingSlash(session.baseUrl), [session.baseUrl]);
  const [busy, setBusy] = useState(false);

  async function openAuthed(path: string) {
    if (session.status !== 'signedIn' || !session.tokens?.accessToken) {
      await openUrl(`${base}${path.replace(/^\/+/, '')}`);
      return;
    }
    setBusy(true);
    try {
      const res = await session.callApi((accessToken) =>
        api.mobileBrowserSessionLink({ accessToken, redirect: `/${path.replace(/^\/+/, '')}` })
      );
      await openUrl(res.url);
    } catch (err) {
      Alert.alert('Açılamadı', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Araçlar</Text>
      <Text style={styles.sub}>
        Buradaki linkler uygulama içinde WebView açmaz; gerekiyorsa tarayıcıya yönlendirir. Native ekranlara geçiş devam ediyor.
      </Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Panel</Text>
        <Button title="Web Panel (tarayıcıda)" onPress={() => void openAuthed('/')} loading={busy} />
        <View style={{ height: 10 }} />
        <Button title="Raporlar" variant="ghost" onPress={() => void openAuthed('/reports.html')} loading={busy} />
        <View style={{ height: 10 }} />
        <Button title="Admin Chat" variant="ghost" onPress={() => void openAuthed('/admin-chat.html')} loading={busy} />
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Not</Text>
        <Text style={styles.note}>
          Hedef: sohbetler + mesajlaşma %100 native ve WhatsApp’a çok yakın. Web’deki diğer modüller (scripts/templates/scheduled vb)
          de sırayla native taşınacak.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 24, gap: 14 },
  h1: { color: colors.text, fontSize: 22, fontWeight: '800' },
  sub: { color: colors.subtext, fontSize: 13, lineHeight: 18 },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 14,
  },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: '800', marginBottom: 10 },
  note: { color: colors.subtext, fontSize: 13, lineHeight: 18 },
});
