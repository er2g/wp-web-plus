import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRoute } from '@react-navigation/native';

import { createApiClient } from '../api/client';
import { useRealtime } from '../realtime/RealtimeContext';
import { useSession } from '../session/SessionContext';
import { colors } from '../theme/colors';
import { Button } from '../ui/components/Button';
import type { ChatsStackParamList } from '../navigation/types';
import type { RouteProp } from '@react-navigation/native';

type Message = any & {
  message_id?: string;
  chat_id?: string;
  body?: string | null;
  is_from_me?: number | boolean;
  ack?: number;
  timestamp?: number;
  client_pending?: boolean;
  client_failed?: boolean;
};
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

function createTempId() {
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ackLabel(ack: number) {
  // 0: Pending, 1: Sent, 2: Received, 3: Read, 4: Played
  if (ack === 3 || ack === 4) return { text: '✓✓', color: '#53bdeb' };
  if (ack === 2) return { text: '✓✓', color: colors.subtext };
  if (ack === 1) return { text: '✓', color: colors.subtext };
  return { text: '⏳', color: colors.subtext };
}

export function ChatScreen() {
  const route = useRoute<ChatRoute>();
  const session = useSession();
  const api = useMemo(() => createApiClient(), []);
  const realtime = useRealtime();
  const callApi = session.callApi;
  const accountId = session.accountId;

  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [mutedUntil, setMutedUntil] = useState<number | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const pendingRef = useRef<Map<string, { tempId: string; chatId: string; body: string; timestamp: number; serverMessageId?: string }>>(
    new Map()
  );

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

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const upsertIncoming = useCallback(
    (normalized: any) => {
      const incomingChatId = String(normalized?.chatId || normalized?.chat_id || '').trim();
      if (!incomingChatId || incomingChatId !== chatId) return;

      const serverId = String(normalized?.messageId || normalized?.message_id || '').trim();
      const body = String(normalized?.body || '').trim();
      const ts = Number(normalized?.timestamp) || Date.now();
      const isFromMe = Boolean(normalized?.isFromMe ?? normalized?.is_from_me ?? normalized?.is_from_me === 1);

      // Try to resolve a pending outgoing message by matching body + timestamp proximity.
      if (isFromMe && serverId) {
        const existing = messagesRef.current.some((m) => String(m.message_id || m.id || '') === serverId);
        if (!existing) {
          const candidates = Array.from(pendingRef.current.values()).filter((p) => p.chatId === chatId && !p.serverMessageId);
          let best: (typeof candidates)[number] | null = null;
          let bestDelta = Number.POSITIVE_INFINITY;
          for (const cand of candidates) {
            const delta = Math.abs(ts - cand.timestamp);
            if (delta > 2 * 60 * 1000) continue;
            if (cand.body && body && cand.body !== body) continue;
            if (delta < bestDelta) {
              best = cand;
              bestDelta = delta;
            }
          }
          if (best) {
            pendingRef.current.set(best.tempId, { ...best, serverMessageId: serverId });
            setMessages((prev) =>
              prev.map((m) => {
                if ((m.message_id || m.id) !== best!.tempId) return m;
                return { ...m, message_id: serverId, timestamp: ts, client_pending: false, client_failed: false, ack: m.ack ?? 0 };
              })
            );
            return;
          }
        }
      }

      if (!serverId) return;
      const already = messagesRef.current.some((m) => String(m.message_id || m.id || '') === serverId);
      if (already) return;

      const row: Message = {
        message_id: serverId,
        chat_id: chatId,
        body,
        timestamp: ts,
        is_from_me: isFromMe ? 1 : 0,
        ack: isFromMe ? 0 : 0,
      };
      setMessages((prev) => [row, ...prev]);
    },
    [chatId]
  );

  useEffect(() => {
    const offMessage = realtime.subscribe('message', upsertIncoming);

    const offAck = realtime.subscribe('message_ack', (payload) => {
      const messageId = String(payload?.messageId || payload?.message_id || '').trim();
      const ack = Number(payload?.ack) || 0;
      if (!messageId) return;

      setMessages((prev) =>
        prev.map((m) => {
          const id = String(m.message_id || m.id || '');
          if (id !== messageId) return m;
          return { ...m, ack };
        })
      );
    });

    const offRevoked = realtime.subscribe('message_revoked', (payload) => {
      const messageId = String(payload?.messageId || payload?.message_id || '').trim();
      if (!messageId) return;
      setMessages((prev) =>
        prev.map((m) => {
          const id = String(m.message_id || m.id || '');
          if (id !== messageId) return m;
          return { ...m, type: 'revoked', is_deleted_for_everyone: 1, deleted_for_everyone_at: Date.now() };
        })
      );
    });

    const offMedia = realtime.subscribe('media_downloaded', (payload) => {
      const messageId = String(payload?.messageId || payload?.message_id || '').trim();
      if (!messageId) return;
      setMessages((prev) =>
        prev.map((m) => {
          const id = String(m.message_id || m.id || '');
          if (id !== messageId) return m;
          return { ...m, media_url: payload?.mediaUrl || payload?.media_url || m.media_url, media_mimetype: payload?.mediaMimetype || m.media_mimetype };
        })
      );
    });

    return () => {
      offMessage();
      offAck();
      offRevoked();
      offMedia();
    };
  }, [realtime, upsertIncoming]);

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

    const tempId = createTempId();
    const optimistic: Message = {
      message_id: tempId,
      chat_id: chatId,
      body: msg,
      timestamp: Date.now(),
      is_from_me: 1,
      ack: 0,
      client_pending: true,
      client_failed: false,
    };

    pendingRef.current.set(tempId, { tempId, chatId, body: msg, timestamp: optimistic.timestamp! });
    setMessages((prev) => [optimistic, ...prev]);
    setText('');

    setBusy(true);
    try {
      const result = await callApi((accessToken) =>
        api.sendMessage({
          accessToken,
          accountId: accountId || undefined,
          chatId,
          message: msg,
        })
      );
      const serverMessageId = String((result as any)?.messageId || (result as any)?.message_id || (result as any)?.id || '').trim();
      if (serverMessageId) {
        pendingRef.current.set(tempId, { tempId, chatId, body: msg, timestamp: optimistic.timestamp!, serverMessageId });
        setMessages((prev) =>
          prev.map((m) => {
            if ((m.message_id || m.id) !== tempId) return m;
            return { ...m, message_id: serverMessageId, client_pending: false, client_failed: false };
          })
        );
      } else {
        setMessages((prev) =>
          prev.map((m) => {
            if ((m.message_id || m.id) !== tempId) return m;
            return { ...m, client_pending: false };
          })
        );
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) => {
          if ((m.message_id || m.id) !== tempId) return m;
          return { ...m, client_pending: false, client_failed: true };
        })
      );
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
          const fromMe = Boolean(item?.is_from_me ?? item?.isFromMe ?? item?.from_me ?? item?.fromMe);
          const body = getBody(item);
          const time = formatTime(getTs(item));
          const isMine = Boolean(item?.is_from_me ?? item?.isFromMe ?? fromMe);
          const isDeleted = Boolean(item?.is_deleted_for_everyone ?? item?.isDeletedForEveryone);
          const showBody = isDeleted ? 'Bu mesaj silindi' : body;
          if (!showBody) return null;
          const ack = Number(item?.ack) || 0;
          const state = item?.client_pending ? { text: '⏳', color: colors.subtext } : ackLabel(ack);

          return (
            <View style={[styles.bubble, fromMe ? styles.bubbleMe : styles.bubbleOther]}>
              <Text style={[styles.msgText, isDeleted && styles.msgTextDeleted]}>{showBody}</Text>
              <View style={styles.footer}>
                {time ? <Text style={styles.msgMeta}>{time}</Text> : <View />}
                {isMine ? <Text style={[styles.ack, { color: state.color }]}>{state.text}</Text> : null}
                {item?.client_failed ? <Text style={[styles.ack, { color: colors.danger }]}>!</Text> : null}
              </View>
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
  msgTextDeleted: { color: colors.subtext, fontStyle: 'italic' },
  msgMeta: { marginTop: 8, color: colors.subtext, fontSize: 11 },
  footer: { marginTop: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  ack: { fontSize: 12, fontWeight: '700' },
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
