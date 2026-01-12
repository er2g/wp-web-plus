const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');

const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';
const FCM_V1_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const PUSH_DEBOUNCE_MS = 1200;
const PUSH_MAX_SYNC_BACKLOG_AGE_MS = 60_000;

function normalizeAbsoluteUrl(pathOrUrl) {
    if (!pathOrUrl) return null;
    const raw = String(pathOrUrl);
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!config.PUBLIC_BASE_URL) return raw;
    const base = String(config.PUBLIC_BASE_URL).replace(/\/+$/, '');
    const suffix = raw.replace(/^\/+/, '');
    return `${base}/${suffix}`;
}

function getPushPublicMediaSecret() {
    return String(config.PUSH_PUBLIC_MEDIA_SECRET || config.SESSION_SECRET || '');
}

function signPublicMedia({ accountId, filename, exp }) {
    const secret = getPushPublicMediaSecret();
    if (!secret) return null;
    const input = `${accountId}:${filename}:${exp}`;
    return crypto.createHmac('sha256', secret).update(input).digest('hex');
}

function createSignedPublicProfilePicUrl({ accountId, filename }) {
    if (!config.PUBLIC_BASE_URL) return null;
    if (!accountId || !filename) return null;
    if (!/^[a-z0-9-]{1,40}$/.test(String(accountId))) return null;
    if (!/^profile_[a-f0-9]{40}\.(jpg|png|webp)$/.test(String(filename))) return null;

    const exp = Date.now() + 24 * 60 * 60 * 1000;
    const sig = signPublicMedia({ accountId: String(accountId), filename: String(filename), exp });
    if (!sig) return null;

    const base = String(config.PUBLIC_BASE_URL).replace(/\/+$/, '');
    return `${base}/public/media/${encodeURIComponent(String(accountId))}/${encodeURIComponent(String(filename))}?exp=${exp}&sig=${sig}`;
}

function normalizeChatPhotoUrl({ accountId, chatPhoto }) {
    if (!chatPhoto) return null;
    const raw = String(chatPhoto);
    if (raw.startsWith('api/media/')) {
        const filename = raw.slice('api/media/'.length).split('?')[0];
        const decoded = decodeURIComponent(filename);
        const signed = createSignedPublicProfilePicUrl({ accountId, filename: decoded });
        if (signed) return signed;
    }
    return normalizeAbsoluteUrl(raw);
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
        const collapseKey = notification?.tag || undefined;
        await axios.post(
            FCM_ENDPOINT,
            {
                registration_ids: batch,
                priority: 'high',
                content_available: true,
                ...(collapseKey ? { collapse_key: collapseKey } : {}),
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

function base64UrlEncode(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
    return buf
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function readServiceAccount() {
    const rawInline = config.PUSH_FCM_SERVICE_ACCOUNT_JSON ? String(config.PUSH_FCM_SERVICE_ACCOUNT_JSON).trim() : '';
    if (rawInline) {
        try {
            return JSON.parse(rawInline);
        } catch {
            return null;
        }
    }

    const path = config.PUSH_FCM_SERVICE_ACCOUNT_PATH ? String(config.PUSH_FCM_SERVICE_ACCOUNT_PATH).trim() : '';
    if (!path) return null;
    try {
        if (!fs.existsSync(path)) return null;
        return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

function signServiceAccountJwt({ clientEmail, privateKey, tokenUri }) {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iss: clientEmail,
        scope: FCM_V1_SCOPE,
        aud: tokenUri,
        iat: nowSec,
        exp: nowSec + 3600
    };

    const unsigned = `${base64UrlEncode(Buffer.from(JSON.stringify(header)))}.${base64UrlEncode(Buffer.from(JSON.stringify(payload)))}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    const signature = signer.sign(privateKey);
    return `${unsigned}.${base64UrlEncode(signature)}`;
}

function createMobilePushNotifier({ getDefaultDb, logger }) {
    const serviceAccount = readServiceAccount();
    const v1ProjectId = serviceAccount?.project_id ? String(serviceAccount.project_id) : null;

    const pendingByKey = new Map();

    function makeChatTag({ accountId, chatId }) {
        const raw = `${String(accountId || '')}:${String(chatId || '')}`;
        const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
        return `chat_${hash}`;
    }

    let cachedV1Token = null;
    let cachedV1TokenExpMs = 0;

    async function getV1AccessToken() {
        if (!serviceAccount) return null;
        const nowMs = Date.now();
        if (cachedV1Token && cachedV1TokenExpMs - nowMs > 60_000) return cachedV1Token;

        const clientEmail = serviceAccount.client_email;
        const privateKey = serviceAccount.private_key;
        const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
        if (!clientEmail || !privateKey) return null;

        const assertion = signServiceAccountJwt({ clientEmail, privateKey, tokenUri });
        const body = new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion
        }).toString();

        const res = await axios.post(tokenUri, body, {
            timeout: 5000,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = res?.data?.access_token ? String(res.data.access_token) : null;
        const expiresInSec = Number(res?.data?.expires_in || 3600);
        if (!accessToken) return null;

        cachedV1Token = accessToken;
        cachedV1TokenExpMs = nowMs + Math.max(60, expiresInSec) * 1000;
        return accessToken;
    }

    async function sendFcmV1({ tokens, notification, data, channelId, tag, notificationCount }) {
        if (!serviceAccount || !v1ProjectId) return { ok: false, error: 'Missing service account' };
        if (!Array.isArray(tokens) || tokens.length === 0) return { ok: true, sent: 0 };

        const accessToken = await getV1AccessToken();
        if (!accessToken) return { ok: false, error: 'Failed to get FCM v1 access token' };

        const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(v1ProjectId)}/messages:send`;
        const image = notification?.image ? String(notification.image) : null;
        const resolvedChannelId = channelId || notification?.android_channel_id || 'messages_strong';
        const resolvedTag = tag || notification?.tag || null;
        const resolvedCount = Number.isFinite(notificationCount) ? notificationCount : null;

        let sent = 0;
        for (const token of tokens) {
            await axios.post(
                endpoint,
                {
                    message: {
                        token,
                        notification: {
                            title: notification?.title || undefined,
                            body: notification?.body || undefined,
                            ...(image ? { image } : {})
                        },
                        android: {
                            priority: 'HIGH',
                            notification: {
                                channel_id: resolvedChannelId,
                                ...(resolvedTag ? { tag: resolvedTag } : {}),
                                ...(resolvedCount && resolvedCount > 1 ? { notification_count: resolvedCount } : {}),
                                ...(image ? { image } : {})
                            }
                        },
                        data: data && typeof data === 'object' ? data : undefined
                    }
                },
                {
                    timeout: 5000,
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            sent += 1;
        }

        return { ok: true, sent };
    }

    async function notifyIncomingMessage({ accountId, msgData, accountDb }) {
        if (!config.PUSH_NOTIFICATIONS_ENABLED) return { ok: true, skipped: true };
        if (!config.PUSH_FCM_SERVER_KEY && !serviceAccount) return { ok: true, skipped: true };
        if (!msgData || !msgData.chatId || !msgData.messageId) return { ok: true, skipped: true };

        const defaultDb = getDefaultDb();
        const nowMs = Date.now();
        const msgTs = Number(msgData.timestamp) || 0;

        try {
            const running = accountDb?.syncRuns?.getRunning?.get?.() || null;
            if (running && msgTs && (nowMs - msgTs) > PUSH_MAX_SYNC_BACKLOG_AGE_MS) {
                return { ok: true, skipped: true, reason: 'sync_backlog' };
            }
        } catch (e) {}

        const chat = accountDb?.chats?.getById?.get?.(msgData.chatId) || null;
        const chatName = chat?.name || msgData.fromName || msgData.chatId;
        const chatPhoto = chat?.profile_pic || null;

        const users = defaultDb.users.getAll.all().filter(u => u.is_active);

        const previewFromMsg = () => {
            const body = String(msgData.body || '').trim();
            if (body) return body;
            if (msgData.type === 'document') return '[Dosya]';
            if (msgData.type && msgData.type !== 'chat') return '[Medya]';
            return '';
        };

        for (const user of users) {
            const settings = defaultDb.mobileNotificationSettings.getByUserId.get(user.id) || {
                enabled: 1,
                show_sender_name: 1,
                show_sender_photo: 1,
                show_message_preview: 1,
                android_channel: 'messages_strong',
                sound: null
            };

            if (settings.enabled === 0) continue;

            const chatSettings = defaultDb.mobileChatNotificationSettings.getByKey.get(user.id, accountId, msgData.chatId);
            if (chatSettings?.muted_until && Number(chatSettings.muted_until) > nowMs) {
                continue;
            }

            const channelId = chatSettings?.android_channel
                ? (chatSettings.android_channel === 'messages' ? 'messages' : 'messages_strong')
                : (settings.android_channel === 'messages' ? 'messages' : 'messages_strong');

            const pushTargets = defaultDb.mobileDevices.getActivePushTargetsByUserId.all(user.id);
            const tokens = pushTargets
                .filter(target => target.push_provider === 'fcm' && target.push_token)
                .map(target => target.push_token);
            if (tokens.length === 0) continue;

            const key = `${user.id}:${String(accountId || '')}:${String(msgData.chatId || '')}`;
            const pending = pendingByKey.get(key);
            const tag = makeChatTag({ accountId, chatId: msgData.chatId });

            if (pending) {
                pending.count += 1;
                const nextPreview = previewFromMsg();
                if (nextPreview) pending.lastPreview = nextPreview;
                pending.lastMessageId = msgData.messageId || pending.lastMessageId;
                pending.lastFromName = msgData.fromName || pending.lastFromName;
                pending.channelId = channelId;
                continue;
            }

            const entry = {
                timer: null,
                count: 1,
                lastPreview: previewFromMsg() || null,
                lastMessageId: msgData.messageId,
                lastFromName: msgData.fromName || null,
                channelId
            };

            entry.timer = setTimeout(async () => {
                pendingByKey.delete(key);

                const title = settings.show_sender_name === 0 ? 'Yeni mesaj' : chatName;
                const snippet = String(entry.lastPreview || 'Yeni mesaj').slice(0, 200);
                const body = settings.show_message_preview === 0
                    ? (entry.count > 1 ? `(${entry.count} yeni mesaj)` : 'Yeni mesaj')
                    : (entry.count > 1 ? `(${entry.count} yeni mesaj) ${snippet}` : snippet || 'Yeni mesaj');

                const image = settings.show_sender_photo === 0 ? null : normalizeChatPhotoUrl({ accountId, chatPhoto });

                const notification = {
                    title,
                    body,
                    android_channel_id: entry.channelId,
                    tag,
                    ...(image ? { image } : {})
                };

                const data = {
                    event: 'message',
                    accountId: String(accountId || ''),
                    chatId: String(msgData.chatId || ''),
                    messageId: String(entry.lastMessageId || ''),
                    fromName: String(entry.lastFromName || ''),
                    hasMedia: msgData.type && msgData.type !== 'chat' ? '1' : '0',
                    count: String(entry.count)
                };

                try {
                    const result = serviceAccount
                        ? await sendFcmV1({ tokens, notification, data, channelId: entry.channelId, tag, notificationCount: entry.count })
                        : await sendFcmLegacy({
                            serverKey: config.PUSH_FCM_SERVER_KEY,
                            tokens,
                            notification,
                            data
                        });
                    void result;
                } catch (error) {
                    logger?.warn?.('FCM push failed', {
                        category: 'push',
                        accountId,
                        userId: user.id,
                        error: error?.message || String(error)
                    });
                }
            }, PUSH_DEBOUNCE_MS);

            pendingByKey.set(key, entry);
        }

        return { ok: true, queued: true };
    }

    async function sendTestPush({ userId, title, body, imageUrl, data }) {
        if (!config.PUSH_NOTIFICATIONS_ENABLED) return { ok: true, skipped: true, reason: 'disabled' };
        if (!config.PUSH_FCM_SERVER_KEY && !serviceAccount) return { ok: true, skipped: true, reason: 'missing_sender' };
        if (!userId) return { ok: false, error: 'Missing userId' };

        const defaultDb = getDefaultDb();
        const settings = defaultDb.mobileNotificationSettings.getByUserId.get(userId) || { android_channel: 'messages_strong' };
        const channelId = settings.android_channel === 'messages' ? 'messages' : 'messages_strong';
        const pushTargets = defaultDb.mobileDevices.getActivePushTargetsByUserId.all(userId);
        const tokens = pushTargets
            .filter(target => target.push_provider === 'fcm' && target.push_token)
            .map(target => target.push_token);

        if (tokens.length === 0) return { ok: true, sent: 0 };

        const notification = {
            title: String(title || 'Test'),
            body: String(body || 'Test notification'),
            android_channel_id: channelId,
            tag: 'test',
            ...(imageUrl ? { image: normalizeAbsoluteUrl(imageUrl) } : {})
        };

        const result = serviceAccount
            ? await sendFcmV1({
                tokens,
                notification,
                data: data && typeof data === 'object' ? data : { event: 'test' },
                channelId,
                tag: 'test',
                notificationCount: 1
            })
            : await sendFcmLegacy({
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
            mode: serviceAccount ? 'v1' : (config.PUSH_FCM_SERVER_KEY ? 'legacy' : 'disabled'),
            hasServerKey: Boolean(config.PUSH_FCM_SERVER_KEY),
            hasServiceAccount: Boolean(serviceAccount),
            projectId: v1ProjectId,
            publicBaseUrl: config.PUBLIC_BASE_URL || null
        };
    }

    return { notifyIncomingMessage, sendTestPush, getStatus };
}

module.exports = { createMobilePushNotifier };
