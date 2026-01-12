import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { createApiClient } from '../api/client';
import { useSession } from '../session/SessionContext';
import type { ChatsStackParamList } from '../navigation/types';
import { colors } from '../theme/colors';
import { Row } from '../ui/components/Row';

type ChatRow = { chat_id: string; name?: string | null; last_message?: string | null; last_message_at?: number | null };

function formatLast(ms: number | null | undefined) {
  if (!ms) return '';
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  return d.toLocaleDateString() === new Date().toLocaleDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString();
}

export function ChatsScreen() {
  const session = useSession();
  const api = useMemo(() => createApiClient(), []);
  const nav = useNavigation<NativeStackNavigationProp<ChatsStackParamList>>();
  const callApi = session.callApi;
  const accountId = session.accountId;

  const [q, setQ] = useState('');
  const [items, setItems] = useState<ChatRow[]>([]);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((c) => (c.name || c.chat_id).toLowerCase().includes(needle));
  }, [items, q]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const list = await callApi((accessToken) => api.listChats({ accessToken, accountId: accountId || undefined }));
      setItems(list as any);
    } catch (err) {
      Alert.alert('Hata', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }, [accountId, api, callApi]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={styles.container}>
      <View style={styles.searchWrap}>
        <Text style={styles.label}>Ara</Text>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="İsim / chat id"
          placeholderTextColor={colors.subtext}
          style={styles.search}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.hint}>Hesap: {session.accountId || '-'}</Text>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.chat_id}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor={colors.subtext} />}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => nav.navigate('Chat', { chatId: item.chat_id, title: item.name || null })}
            style={({ pressed }) => [{ opacity: pressed ? 0.75 : 1 }]}
          >
            <Row
              title={item.name || item.chat_id}
              subtitle={(item.last_message || '').trim() || (item.name ? item.chat_id : null)}
              right={
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  <Text style={{ color: colors.subtext, fontSize: 12 }}>{formatLast(item.last_message_at || null)}</Text>
                  <Text style={{ color: colors.subtext }}>{'›'}</Text>
                </View>
              }
            />
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={{ padding: 18 }}>
            <Text style={{ color: colors.subtext }}>Sohbet bulunamadı.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  searchWrap: { padding: 16, paddingBottom: 8 },
  label: { color: colors.subtext, fontSize: 12, marginBottom: 6 },
  hint: { marginTop: 8, color: colors.subtext, fontSize: 12 },
  search: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
  },
  list: { paddingHorizontal: 16, paddingBottom: 16 },
});
