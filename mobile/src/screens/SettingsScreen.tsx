import Constants from 'expo-constants';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { Platform } from 'react-native';

import { createApiClient } from '../api/client';
import { registerForPushAsync } from '../notifications/push';
import { useSession } from '../session/SessionContext';
import { getOrCreateDeviceId } from '../session/deviceId';
import { colors } from '../theme/colors';
import { Button } from '../ui/components/Button';
import { Row } from '../ui/components/Row';

function ToggleRow(props: { title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row
      title={props.title}
      subtitle={props.subtitle || null}
      right={<Switch value={props.value} onValueChange={props.onChange} trackColor={{ true: colors.primary }} />}
    />
  );
}

export function SettingsScreen() {
  const session = useSession();
  const api = useMemo(() => createApiClient(), []);
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState(session.notificationSettings?.sound || '');
  const [accountModal, setAccountModal] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<{ enabled: boolean; hasServerKey: boolean; publicBaseUrl: string | null } | null>(null);

  useEffect(() => {
    setSound(session.notificationSettings?.sound || '');
  }, [session.notificationSettings?.sound]);

  useEffect(() => {
    getOrCreateDeviceId().then(setDeviceId).catch(() => setDeviceId(null));
  }, []);

  useEffect(() => {
    if (session.status !== 'signedIn') return;
    void session
      .callApi((accessToken) => api.mobilePushStatus({ accessToken }))
      .then(setPushStatus)
      .catch(() => setPushStatus(null));
  }, [api, session]);

  async function applyNotifPatch(patch: any) {
    setBusy(true);
    try {
      await session.updateNotificationSettings(patch);
    } catch (err) {
      Alert.alert('Hata', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh() {
    setBusy(true);
    try {
      await session.refreshBootstrap();
    } catch (err) {
      Alert.alert('Hata', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveNotif() {
    setBusy(true);
    try {
      await session.updateNotificationSettings({
        sound: sound.trim() ? sound.trim().slice(0, 100) : null,
      });
      Alert.alert('Kaydedildi', 'Bildirim ayarları güncellendi.');
    } catch (err) {
      Alert.alert('Hata', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await session.signOut();
  }

  async function handleSelectAccount(id: string) {
    setAccountModal(false);
    await session.setAccountId(id);
    Alert.alert('Hesap seçildi', id);
  }

  async function handleRegisterDevice() {
    setBusy(true);
    try {
      // Re-run bootstrap; it upserts device info.
      await session.refreshBootstrap();
      Alert.alert('OK', 'Cihaz bilgisi güncellendi.');
    } catch (err) {
      Alert.alert('Hata', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  async function handleEnablePush() {
    setBusy(true);
    try {
      const registration = await registerForPushAsync();
      if (!registration) {
        Alert.alert(
          'Push aktif değil',
          'Bildirim izni verilmemiş olabilir ya da Android tarafında Firebase (google-services.json) yapılandırması eksik olabilir.'
        );
        return;
      }

      const id = deviceId || (await getOrCreateDeviceId());
      await session.callApi((accessToken) =>
        api.upsertDevice({
          accessToken,
          deviceId: id,
          platform: Platform.OS,
          pushProvider: registration.provider,
          pushToken: registration.token,
          appVersion: Constants.expoConfig?.version || null,
          locale: null,
          timezone: null,
        })
      );

      await session.refreshBootstrap();
      Alert.alert('OK', 'Push token kaydedildi.');
    } catch (err) {
      Alert.alert('Hata', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  async function handleTestPush() {
    setBusy(true);
    try {
      const result = await session.callApi((accessToken) =>
        api.mobilePushTest({
          accessToken,
          title: 'WpPanel Test',
          body: 'Bildirim geldi mi?',
        })
      );
      Alert.alert('Test sonucu', JSON.stringify(result.result || result, null, 2));
    } catch (err) {
      Alert.alert('Hata', err instanceof Error ? err.message : 'Bilinmeyen hata');
    } finally {
      setBusy(false);
    }
  }

  const ns = session.notificationSettings;
  const notifEnabled = ns?.enabled ?? true;
  const showSenderName = ns?.showSenderName ?? true;
  const showSenderPhoto = ns?.showSenderPhoto ?? true;
  const showMessagePreview = ns?.showMessagePreview ?? true;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Ayarlar</Text>
      <Text style={styles.sub}>API: {session.baseUrl}</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Hesap</Text>
        <Pressable onPress={() => setAccountModal(true)}>
          <Row title="Aktif hesap" subtitle={session.accountId || '-'} right={<Text style={{ color: colors.subtext }}>{'›'}</Text>} />
        </Pressable>
        <Button title="Yenile (Me / Accounts)" onPress={handleRefresh} loading={busy} variant="ghost" />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Bildirim Ayarları</Text>
        <ToggleRow
          title="Bildirimler"
          subtitle="Genel bildirimleri aç/kapat"
          value={notifEnabled}
          onChange={(v) => void applyNotifPatch({ enabled: v })}
        />
        <ToggleRow
          title="Gönderen adı"
          subtitle="Bildirimde isim göster"
          value={showSenderName}
          onChange={(v) => void applyNotifPatch({ showSenderName: v })}
        />
        <ToggleRow
          title="Gönderen foto"
          subtitle="Bildirimde foto göster"
          value={showSenderPhoto}
          onChange={(v) => void applyNotifPatch({ showSenderPhoto: v })}
        />
        <ToggleRow
          title="Mesaj önizleme"
          subtitle="Bildirimde mesaj içeriği"
          value={showMessagePreview}
          onChange={(v) => void applyNotifPatch({ showMessagePreview: v })}
        />

        <View style={styles.card}>
          <Text style={styles.label}>Bildirim sesi (opsiyonel)</Text>
          <TextInput
            value={sound}
            onChangeText={setSound}
            placeholder="örn: default"
            placeholderTextColor={colors.subtext}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={{ height: 12 }} />
          <Button title="Sesi Kaydet" onPress={handleSaveNotif} loading={busy} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Cihaz / Push</Text>
        <Row title="DeviceId" subtitle={deviceId || '-'} />
        <Row
          title="Sunucu push"
          subtitle={
            pushStatus
              ? pushStatus.enabled
                ? pushStatus.hasServerKey
                  ? 'Açık (FCM hazır)'
                  : 'Açık (FCM anahtarı yok)'
                : 'Kapalı'
              : '-'
          }
        />
        <Row
          title="Kayıtlı cihaz sayısı"
          subtitle={`${session.devices?.length || 0}`}
          right={<Text style={{ color: colors.subtext }}>{notifEnabled ? '✓' : ''}</Text>}
        />
        <Button title="Cihaz kaydını güncelle" onPress={handleRegisterDevice} loading={busy} variant="ghost" />
        <Button title="Push izni ver & token kaydet" onPress={handleEnablePush} loading={busy} variant="ghost" />
        <Button title="Test bildirim gönder" onPress={handleTestPush} loading={busy} variant="ghost" />
        <Text style={styles.note}>Not: `expo run` / EAS build ile gerçek cihazda push token daha stabil alınır.</Text>
      </View>

      <View style={styles.section}>
        <Button title="Çıkış Yap" onPress={handleLogout} variant="danger" />
      </View>

      <Modal visible={accountModal} transparent animationType="fade" onRequestClose={() => setAccountModal(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setAccountModal(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Hesap Seç</Text>
            {session.accounts.map((a) => (
              <Pressable key={a.id} onPress={() => handleSelectAccount(a.id)} style={styles.modalItem}>
                <Text style={styles.modalItemTitle}>{a.name}</Text>
                <Text style={styles.modalItemSub}>{a.id}</Text>
              </Pressable>
            ))}
            <View style={{ height: 10 }} />
            <Button title="Kapat" onPress={() => setAccountModal(false)} variant="ghost" />
          </View>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 24 },
  h1: { color: colors.text, fontSize: 22, fontWeight: '800' },
  sub: { marginTop: 6, color: colors.subtext, fontSize: 13 },
  section: { marginTop: 18, gap: 10 },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
  },
  label: { color: colors.subtext, fontSize: 12, marginBottom: 6 },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
  },
  note: { marginTop: 6, color: colors.subtext, fontSize: 12, lineHeight: 18 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', padding: 16, justifyContent: 'center' },
  modalCard: { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.border, padding: 14 },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: 10 },
  modalItem: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalItemTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  modalItemSub: { marginTop: 4, color: colors.subtext, fontSize: 12 },
});
