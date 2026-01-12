import type { ReactNode } from 'react';
import { Component } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme/colors';

type Props = {
  children: ReactNode;
  onError?: (err: Error) => void;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <View style={styles.container}>
        <Text style={styles.title}>Uygulama hatası</Text>
        <Text style={styles.subtitle}>Açılışta bir hata oldu. Aşağıdaki mesajı bana at, hemen düzeltelim.</Text>
        <View style={styles.card}>
          <Text style={styles.mono}>{String(this.state.error?.message || 'Unknown error')}</Text>
        </View>
        <Pressable style={styles.button} onPress={() => this.setState({ error: null })}>
          <Text style={styles.buttonText}>Tekrar dene</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 16, justifyContent: 'center' },
  title: { color: colors.text, fontSize: 22, fontWeight: '900' },
  subtitle: { marginTop: 8, color: colors.subtext, fontSize: 13, lineHeight: 18 },
  card: {
    marginTop: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
  },
  mono: { color: colors.text, fontSize: 12 },
  button: { marginTop: 14, backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#06110a', fontWeight: '900' },
});
