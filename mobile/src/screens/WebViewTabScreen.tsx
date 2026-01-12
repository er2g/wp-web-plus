import Constants from 'expo-constants';
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewNavigation } from 'react-native-webview';

import { colors } from '../theme/colors';

function normalizeUrl(url: string) {
  const trimmed = String(url || '').trim();
  return trimmed;
}

function isExternalUrl(url: string) {
  const u = String(url || '').trim().toLowerCase();
  return (
    u.startsWith('tel:') ||
    u.startsWith('mailto:') ||
    u.startsWith('whatsapp:') ||
    u.startsWith('sms:') ||
    u.startsWith('market:') ||
    u.startsWith('intent:') ||
    u.startsWith('tg:') ||
    u.startsWith('fb:') ||
    u.startsWith('instagram:') ||
    u.startsWith('geo:')
  );
}

export function WebViewTabScreen(props: { url: string; headers?: Record<string, string> | undefined; debugLabel?: string }) {
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  const initialUrl = useMemo(() => normalizeUrl(props.url), [props.url]);

  const userAgent = useMemo(() => {
    const base = Platform.select({
      ios: 'WpPanelWebView/iOS',
      android: 'WpPanelWebView/Android',
      default: 'WpPanelWebView',
    });
    const version = Constants.expoConfig?.version || '0';
    return `${base} ${version}`;
  }, []);

  const onNavigationStateChange = useCallback((navState: WebViewNavigation) => {
    setCanGoBack(Boolean(navState.canGoBack));
    setLastUrl(navState.url || null);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (canGoBack) {
          webViewRef.current?.goBack();
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [canGoBack])
  );

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: initialUrl, headers: props.headers }}
        userAgent={userAgent}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        setSupportMultipleWindows={false}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onNavigationStateChange={onNavigationStateChange}
        onShouldStartLoadWithRequest={(req) => {
          const url = String(req.url || '');
          if (isExternalUrl(url)) {
            Linking.openURL(url).catch(() => undefined);
            return false;
          }
          return true;
        }}
        style={styles.webview}
      />

      {loading ? (
        <View pointerEvents="none" style={styles.loadingOverlay}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>Yükleniyor…</Text>
        </View>
      ) : null}

      {props.debugLabel ? (
        <View pointerEvents="none" style={styles.debug}>
          <Text style={styles.debugText}>
            {props.debugLabel}
            {lastUrl ? ` · ${lastUrl}` : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  webview: { flex: 1, backgroundColor: colors.bg },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 18, 32, 0.55)',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 6,
    flexDirection: 'row',
  },
  loadingText: { color: colors.subtext, fontSize: 12 },
  debug: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    padding: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  debugText: { color: colors.subtext, fontSize: 10 },
});
