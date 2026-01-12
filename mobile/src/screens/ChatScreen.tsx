import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRoute } from '@react-navigation/native';

import { createApiClient } from '../api/client';
import { useSession } from '../session/SessionContext';
import { colors } from '../theme/colors';
import { Button } from '../ui/components/Button';
import type { ChatsStackParamList } from '../navigation/types';
import type { RouteProp } from '@react-navigation/native';

type Message = any;
type ChatRoute = RouteProp<ChatsStackParamList, 'Chat'>;

function getBody(m: any) {
  return String(m?.body ?? m?.message ?? m?.content ?? '').trim();
}

function getTs(m: any) {
  const raw = m?.timestamp ?? m?.created_at ?? m?.createdAt ?? null;
  const n = typeof raw === 'number' ? raw : raw ? Number(raw) : null;
  if (!n || !Number.isFinite(n)) return null;
  // some rows store seconds, some ms
  return n < 10_000_000_000 ? n * 1000 : n;
}

function formatTime(ms: number | null) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString();
}

export function ChatScreen() {
  const route = useRoute<ChatRoute>();
  const session = useSession();
  const api = useMemo(() => createApiClient(), []);
  const callApi = session.callApi;
  const accountId = session.accountId;

  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [mutedUntil, setMutedUntil] = useState<number | null>(null);

  const chatId = route.params.chatId;

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await callApi((accessToken) =>
        api.getChatMessages({
          accessToken,
          accountId: accountId || undefined,
          chatId,
          limit: 80,
          offset: 0,
        })
      );
      setMessages(res.messages || []);
    } catch (err) {
      Alert.alert('Hata', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }, [accountId, api, callApi, chatId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMute = useCallback(async () => {
    try {
      const res = await callApi((accessToken) =>
        api.getChatNotificationSettings({ accessToken, accountId: accountId || undefined, chatId })
      );
      const raw = res?.muted_until ?? res?.mutedUntil ?? null;
      const n = raw === null ? null : Number(raw);
      setMutedUntil(Number.isFinite(n as any) ? (n as any) : null);
    } catch {}
  }, [accountId, api, callApi, chatId]);

  useEffect(() => {
    loadMute();
  }, [loadMute]);

  async function setMute(ms: number | null) {
    setBusy(true);
    try {
      await callApi((accessToken) => api.setChatMute({ accessToken, accountId: accountId || undefined, chatId, mutedUntil: ms }));
      await loadMute();
      Alert.alert('OK', ms ? 'Sohbet sessize alındı.' : 'Sessiz kaldırıldı.');
    } catch (err) {
      Alert.alert('Hata', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    const msg = text.trim();
    if (!msg) return;

    setBusy(true);
    try {
      await callApi((accessToken) =>
        api.sendMessage({
          accessToken,
          accountId: accountId || undefined,
          chatId,
          message: msg,
        })
      );
      setText('');
      await load();
    } catch (err) {
      Alert.alert('Gönderim hatası', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.topActions}>
        <Text style={styles.muteText}>
          {mutedUntil && mutedUntil > Date.now() ? `Sessiz: ${formatTime(mutedUntil)}` : 'Sessiz: kapalı'}
        </Text>
        <View style={styles.muteButtons}>
          <Pressable onPress={() => void setMute(Date.now() + 60 * 60 * 1000)} style={({ pressed }) => [styles.muteBtn, pressed && styles.muteBtnPressed]}>
            <Text style={styles.muteBtnText}>1s</Text>
          </Pressable>
          <Pressable onPress={() => void setMute(Date.now() + 24 * 60 * 60 * 1000)} style={({ pressed }) => [styles.muteBtn, pressed && styles.muteBtnPressed]}>
            <Text style={styles.muteBtnText}>1g</Text>
          </Pressable>
          <Pressable onPress={() => void setMute(null)} style={({ pressed }) => [styles.muteBtn, pressed && styles.muteBtnPressed]}>
            <Text style={styles.muteBtnText}>Aç</Text>
          </Pressable>
        </View>
      </View>
      <FlatList
        data={messages}
        keyExtractor={(item, idx) => String(item?.message_id || item?.id || idx)}
        inverted
        contentContainerStyle={styles.list}
        refreshing={busy}
        onRefresh={load}
        renderItem={({ item }) => {
          const fromMe = Boolean(item?.from_me ?? item?.fromMe);
          const body = getBody(item);
          const time = formatTime(getTs(item));
          if (!body) return null;

          return (
            <View style={[styles.bubble, fromMe ? styles.bubbleMe : styles.bubbleOther]}>
              <Text style={styles.msgText}>{body}</Text>
              {time ? <Text style={styles.msgMeta}>{time}</Text> : null}
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={{ padding: 18 }}>
            <Text style={{ color: colors.subtext }}>Mesaj yok.</Text>
          </View>
        }
      />

      <View style={styles.composer}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Mesaj yaz…"
          placeholderTextColor={colors.subtext}
          style={styles.input}
          multiline
        />
        <View style={{ width: 10 }} />
        <View style={{ width: 100 }}>
          <Button title="Gönder" onPress={handleSend} disabled={!text.trim()} loading={busy} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  topActions: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  muteText: { color: colors.subtext, fontSize: 12, flex: 1 },
  muteButtons: { flexDirection: 'row', gap: 8 },
  muteBtn: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  muteBtnPressed: { opacity: 0.7 },
  muteBtnText: { color: colors.text, fontWeight: '700', fontSize: 12 },
  list: { padding: 16, paddingBottom: 8 },
  bubble: {
    maxWidth: '88%',
    padding: 12,
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bubbleMe: { alignSelf: 'flex-end', backgroundColor: '#13264a' },
  bubbleOther: { alignSelf: 'flex-start', backgroundColor: colors.card },
  msgText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  msgMeta: { marginTop: 8, color: colors.subtext, fontSize: 11 },
  composer: {
    flexDirection: 'row',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
  },
});
