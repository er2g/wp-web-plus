import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../session/SessionContext';
import { colors } from '../theme/colors';
import { Button } from '../ui/components/Button';
import { Field } from '../ui/components/Field';

export function LoginScreen() {
  const session = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleLogin() {
    const u = username.trim().toLowerCase();
    if (!u || !password) {
      Alert.alert('Eksik bilgi', 'Kullanıcı adı ve şifre gerekli.');
      return;
    }

    setBusy(true);
    try {
      await session.signIn({ username: u, password });
    } catch (err) {
      Alert.alert('Giriş hatası', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>WpPanel Mobile</Text>
        <Text style={styles.subtitle}>API: {session.baseUrl}</Text>

        <View style={styles.card}>
          <Field
            label="Kullanıcı adı"
            value={username}
            onChangeText={setUsername}
            placeholder="ornek: admin"
            editable={!busy}
            autoCapitalize="none"
          />
          <Field
            label="Şifre"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureTextEntry
            editable={!busy}
          />

          <View style={{ height: 14 }} />
          <Button title="Giriş Yap" onPress={handleLogin} loading={busy} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 16 },
  title: { fontSize: 24, fontWeight: '800', color: colors.text },
  subtitle: { marginTop: 6, fontSize: 13, color: colors.subtext },
  card: {
    marginTop: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 14,
  },
});

