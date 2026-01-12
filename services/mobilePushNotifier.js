const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');

const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';
const FCM_V1_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

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

    async function sendFcmV1({ tokens, notification, data }) {
        if (!serviceAccount || !v1ProjectId) return { ok: false, error: 'Missing service account' };
        if (!Array.isArray(tokens) || tokens.length === 0) return { ok: true, sent: 0 };

        const accessToken = await getV1AccessToken();
        if (!accessToken) return { ok: false, error: 'Failed to get FCM v1 access token' };

        const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(v1ProjectId)}/messages:send`;
        const image = notification?.image ? String(notification.image) : null;

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
                            notification: image ? { image } : undefined
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
                const result = serviceAccount
                    ? await sendFcmV1({ tokens, notification, data })
                    : await sendFcmLegacy({
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
        if (!config.PUSH_FCM_SERVER_KEY && !serviceAccount) return { ok: true, skipped: true, reason: 'missing_sender' };
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

        const result = serviceAccount
            ? await sendFcmV1({
                tokens,
                notification,
                data: data && typeof data === 'object' ? data : { event: 'test' }
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
