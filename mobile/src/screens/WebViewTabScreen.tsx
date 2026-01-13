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

const injectedMobileFix = `
(function () {
  try {
    var head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return;

    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      head.appendChild(meta);
    }
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');

    var root = document.documentElement;
    if (root) root.classList.add('wp_panel_webview');

    var applyBodyClass = function () {
      try {
        if (document.body) document.body.classList.add('wp_panel_webview');
      } catch (e) {}
    };
    applyBodyClass();
    document.addEventListener('DOMContentLoaded', applyBodyClass, { once: true });

    var updateViewportVars = function () {
      try {
        var vv = window.visualViewport;
        var height = vv && vv.height ? vv.height : window.innerHeight;
        if (root) root.style.setProperty('--wp_vvh', (height * 0.01) + 'px');

        var kb = 0;
        if (vv && vv.height) {
          kb = Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0));
        }
        if (root) root.style.setProperty('--wp_kb', kb + 'px');
      } catch (e) {}
    };

    updateViewportVars();
    window.addEventListener('resize', updateViewportVars);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportVars);
      window.visualViewport.addEventListener('scroll', updateViewportVars);
    }

    var style = document.getElementById('__wp_panel_mobile_fix');
    if (!style) {
      style = document.createElement('style');
      style.id = '__wp_panel_mobile_fix';
      style.textContent = [
        'html.wp_panel_webview, body.wp_panel_webview {',
        '  height: calc(var(--wp_vvh, 1vh) * 100) !important;',
        '  width: 100% !important;',
        '  overflow-x: hidden !important;',
        '  overscroll-behavior: none !important;',
        '  -webkit-text-size-adjust: 100%;',
        '}',
        'html.wp_panel_webview #uiRoot { height: calc(var(--wp_vvh, 1vh) * 100) !important; }',
        'html.wp_panel_webview .chat-area { height: calc(var(--wp_vvh, 1vh) * 100) !important; }',
        'html.wp_panel_webview .settings-panel { height: calc((var(--wp_vvh, 1vh) * 100) - 16px) !important; }',
        'html.wp_panel_webview textarea, html.wp_panel_webview input { font-size: 16px !important; }',
        'html.wp_panel_webview .chat-input-area { padding-bottom: calc(10px + env(safe-area-inset-bottom)) !important; }',
        'html.wp_panel_webview, body.wp_panel_webview { overscroll-behavior-x: none !important; }',
        'html.wp_panel_webview * { -webkit-tap-highlight-color: rgba(0,0,0,0); }',
      ].join('\\n');
      head.appendChild(style);
    }

    var focusHandler = function (event) {
      try {
        var target = event && event.target ? event.target : null;
        if (!target) return;
        var isTextField = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable;
        if (!isTextField) return;
        updateViewportVars();
        setTimeout(function () {
          try {
            if (typeof target.scrollIntoView === 'function') {
              target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
          } catch (e) {}
          try {
            var container = document.getElementById('messagesContainer');
            if (!container) return;
            var distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            if (distanceFromBottom < 160) container.scrollTop = container.scrollHeight;
          } catch (e) {}
        }, 60);
      } catch (e) {}
    };

    document.addEventListener('focusin', focusHandler);
  } catch (e) {}
})(); true;
`;

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
        injectedJavaScriptBeforeContentLoaded={injectedMobileFix}
        setSupportMultipleWindows={false}
        bounces={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
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
