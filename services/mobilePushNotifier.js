const axios = require('axios');
const config = require('../config');

const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';

function normalizeAbsoluteUrl(pathOrUrl) {
    if (!pathOrUrl) return null;
    const raw = String(pathOrUrl);
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!config.PUBLIC_BASE_URL) return raw;
    const base = String(config.PUBLIC_BASE_URL).replace(/\/+$/, '');
    const suffix = raw.replace(/^\/+/, '');
    return `${base}/${suffix}`;
}

function chunk(array, size) {
    const out = [];
    for (let i = 0; i < array.length; i += size) {
        out.push(array.slice(i, i + size));
    }
    return out;
}

async function sendFcmLegacy({ serverKey, tokens, notification, data }) {
    if (!serverKey) return { ok: false, error: 'Missing FCM server key' };
    if (!Array.isArray(tokens) || tokens.length === 0) return { ok: true, sent: 0 };

    const batches = chunk(tokens, 500);
    let sent = 0;

    for (const batch of batches) {
        await axios.post(
            FCM_ENDPOINT,
            {
                registration_ids: batch,
                priority: 'high',
                content_available: true,
                notification,
                data
            },
            {
                timeout: 5000,
                headers: {
                    Authorization: `key=${serverKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        sent += batch.length;
    }

    return { ok: true, sent };
}

function createMobilePushNotifier({ getDefaultDb, logger }) {
    async function notifyIncomingMessage({ accountId, msgData, accountDb }) {
        if (!config.PUSH_NOTIFICATIONS_ENABLED) return { ok: true, skipped: true };
        if (!config.PUSH_FCM_SERVER_KEY) return { ok: true, skipped: true };
        if (!msgData || !msgData.chatId || !msgData.messageId) return { ok: true, skipped: true };

        const defaultDb = getDefaultDb();
        const nowMs = Date.now();

        const chat = accountDb?.chats?.getById?.get?.(msgData.chatId) || null;
        const chatName = chat?.name || msgData.fromName || msgData.chatId;
        const chatPhoto = chat?.profile_pic || null;

        const users = defaultDb.users.getAll.all().filter(u => u.is_active);

        let totalSent = 0;
        for (const user of users) {
            const settings = defaultDb.mobileNotificationSettings.getByUserId.get(user.id) || {
                enabled: 1,
                show_sender_name: 1,
                show_sender_photo: 1,
                show_message_preview: 1,
                sound: null
            };

            if (settings.enabled === 0) continue;

            const chatSettings = defaultDb.mobileChatNotificationSettings.getByKey.get(user.id, accountId, msgData.chatId);
            if (chatSettings?.muted_until && Number(chatSettings.muted_until) > nowMs) {
                continue;
            }

            const pushTargets = defaultDb.mobileDevices.getActivePushTargetsByUserId.all(user.id);
            const tokens = pushTargets
                .filter(target => target.push_provider === 'fcm' && target.push_token)
                .map(target => target.push_token);
            if (tokens.length === 0) continue;

            const title = settings.show_sender_name === 0 ? 'Yeni mesaj' : chatName;
            const body = settings.show_message_preview === 0
                ? 'Yeni mesaj'
                : String(msgData.body || (msgData.type === 'document' ? '[Dosya]' : '[Medya]') || '').slice(0, 200);
            const image = settings.show_sender_photo === 0 ? null : normalizeAbsoluteUrl(chatPhoto);

            const notification = {
                title,
                body,
                ...(image ? { image } : {})
            };

            const data = {
                event: 'message',
                accountId: String(accountId || ''),
                chatId: String(msgData.chatId || ''),
                messageId: String(msgData.messageId || ''),
                fromName: String(msgData.fromName || ''),
                hasMedia: msgData.type && msgData.type !== 'chat' ? '1' : '0'
            };

            try {
                const result = await sendFcmLegacy({
                    serverKey: config.PUSH_FCM_SERVER_KEY,
                    tokens,
                    notification,
                    data
                });
                if (result.ok) totalSent += result.sent || 0;
            } catch (error) {
                logger?.warn?.('FCM push failed', {
                    category: 'push',
                    accountId,
                    userId: user.id,
                    error: error?.message || String(error)
                });
            }
        }

        return { ok: true, sent: totalSent };
    }

    async function sendTestPush({ userId, title, body, imageUrl, data }) {
        if (!config.PUSH_NOTIFICATIONS_ENABLED) return { ok: true, skipped: true, reason: 'disabled' };
        if (!config.PUSH_FCM_SERVER_KEY) return { ok: true, skipped: true, reason: 'missing_server_key' };
        if (!userId) return { ok: false, error: 'Missing userId' };

        const defaultDb = getDefaultDb();
        const pushTargets = defaultDb.mobileDevices.getActivePushTargetsByUserId.all(userId);
        const tokens = pushTargets
            .filter(target => target.push_provider === 'fcm' && target.push_token)
            .map(target => target.push_token);

        if (tokens.length === 0) return { ok: true, sent: 0 };

        const notification = {
            title: String(title || 'Test'),
            body: String(body || 'Test notification'),
            ...(imageUrl ? { image: normalizeAbsoluteUrl(imageUrl) } : {})
        };

        const result = await sendFcmLegacy({
            serverKey: config.PUSH_FCM_SERVER_KEY,
            tokens,
            notification,
            data: data && typeof data === 'object' ? data : { event: 'test' }
        });

        return result.ok ? { ok: true, sent: result.sent || 0 } : result;
    }

    function getStatus() {
        return {
            enabled: Boolean(config.PUSH_NOTIFICATIONS_ENABLED),
            hasServerKey: Boolean(config.PUSH_FCM_SERVER_KEY),
            publicBaseUrl: config.PUBLIC_BASE_URL || null
        };
    }

    return { notifyIncomingMessage, sendTestPush, getStatus };
}

module.exports = { createMobilePushNotifier };
