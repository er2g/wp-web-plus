import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { createApiClient } from './src/api/client';

export default function App() {
  const api = useMemo(() => createApiClient(), []);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [chats, setChats] = useState<Array<{ chat_id: string; name?: string | null }>>([]);

  async function handleLogin() {
    const u = username.trim().toLowerCase();
    if (!u || !password) {
      Alert.alert('Eksik bilgi', 'Kullanıcı adı ve şifre gerekli.');
      return;
    }

    setBusy(true);
    try {
      const login = await api.mobileLogin({ username: u, password });
      setAccessToken(login.accessToken);
      setRefreshToken(login.refreshToken);

      const accounts = await api.mobileAccounts({ accessToken: login.accessToken });
      setAccountId(accounts.defaultAccountId || accounts.accounts?.[0]?.id || null);

      const list = await api.listChats({
        accessToken: login.accessToken,
        accountId: accounts.defaultAccountId || accounts.accounts?.[0]?.id || undefined,
      });
      setChats(list);
    } catch (error) {
      Alert.alert('Giriş hatası', error instanceof Error ? error.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshChats() {
    if (!accessToken) return;
    setBusy(true);
    try {
      const list = await api.listChats({ accessToken, accountId: accountId || undefined });
      setChats(list);
    } catch (error) {
      Alert.alert('Yenileme hatası', error instanceof Error ? error.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    if (accessToken && refreshToken) {
      try {
        await api.mobileLogout({ accessToken, refreshToken });
      } catch {}
    }
    setAccessToken(null);
    setRefreshToken(null);
    setAccountId(null);
    setChats([]);
    setUsername('');
    setPassword('');
  }

  if (!accessToken) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>WpPanel Mobile (MVP)</Text>
        <Text style={styles.subtitle}>API: {api.baseUrl}</Text>

        <View style={styles.form}>
          <Text style={styles.label}>Kullanıcı adı</Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="ornek: admin"
            value={username}
            onChangeText={setUsername}
            editable={!busy}
          />

          <Text style={styles.label}>Şifre</Text>
          <TextInput
            style={styles.input}
            secureTextEntry
            placeholder="••••••••"
            value={password}
            onChangeText={setPassword}
            editable={!busy}
          />

          <Pressable style={[styles.button, busy && styles.buttonDisabled]} onPress={handleLogin} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Giriş Yap</Text>}
          </Pressable>
        </View>

        <StatusBar style="auto" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>Sohbetler</Text>
          <Text style={styles.subtitle}>Hesap: {accountId || '-'}</Text>
        </View>

        <View style={styles.headerActions}>
          <Pressable style={[styles.smallButton, busy && styles.buttonDisabled]} onPress={handleRefreshChats} disabled={busy}>
            <Text style={styles.smallButtonText}>Yenile</Text>
          </Pressable>
          <Pressable style={styles.smallButton} onPress={handleLogout}>
            <Text style={styles.smallButtonText}>Çıkış</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={chats}
        keyExtractor={(item) => item.chat_id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.chatRow}>
            <Text style={styles.chatTitle}>{item.name || item.chat_id}</Text>
            {item.name ? <Text style={styles.chatSubtitle}>{item.chat_id}</Text> : null}
          </View>
        )}
      />

      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1220',
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#ffffff',
  },
  subtitle: {
    marginTop: 6,
    fontSize: 13,
    color: '#b8c2d8',
  },
  form: {
    marginTop: 22,
    backgroundColor: '#111a2f',
    borderWidth: 1,
    borderColor: '#223055',
    borderRadius: 12,
    padding: 14,
  },
  label: {
    color: '#b8c2d8',
    fontSize: 12,
    marginTop: 10,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#0b1220',
    borderWidth: 1,
    borderColor: '#223055',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#ffffff',
  },
  button: {
    marginTop: 16,
    backgroundColor: '#2563eb',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  headerRow: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerLeft: {
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 10,
  },
  smallButton: {
    backgroundColor: '#111a2f',
    borderWidth: 1,
    borderColor: '#223055',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  smallButtonText: {
    color: '#ffffff',
    fontWeight: '600',
  },
  list: {
    paddingVertical: 12,
  },
  chatRow: {
    backgroundColor: '#111a2f',
    borderWidth: 1,
    borderColor: '#223055',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  chatTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  chatSubtitle: {
    marginTop: 6,
    color: '#b8c2d8',
    fontSize: 12,
  },
});
