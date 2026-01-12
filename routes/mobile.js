const express = require('express');
const { z } = require('zod');

const config = require('../config');
const accountManager = require('../services/accountManager');
const { verifyPassword } = require('../services/passwords');
const { sendError } = require('../lib/httpResponses');
const { validateChatId } = require('../lib/apiValidation');
const { validate } = require('./middleware/validate');
const { requireAuth } = require('./middleware/auth');
const {
    issueTokens,
    rotateRefreshToken,
    revokeRefreshToken,
    revokeAllRefreshTokensForUser
} = require('../services/mobileAuth');

function getDefaultDb() {
    return accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
}

function sanitizeUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        displayName: user.display_name || null,
        role: user.role || 'agent',
        isActive: Boolean(user.is_active)
    };
}

function getClientIp(req) {
    return req.ip || req.connection?.remoteAddress || 'unknown';
}

const optionalTrimmedString = () => z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}, z.string().max(500).optional());

const loginBodySchema = z.object({
    username: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.string().min(1).max(80)),
    password: z.preprocess((v) => (typeof v === 'string' ? v : v), z.string().min(1).max(200)),
    accountId: optionalTrimmedString(),
    deviceId: optionalTrimmedString(),
    platform: optionalTrimmedString(),
    pushProvider: z.enum(['fcm', 'apns']).optional(),
    pushToken: optionalTrimmedString(),
    appVersion: optionalTrimmedString(),
    locale: optionalTrimmedString(),
    timezone: optionalTrimmedString()
}).strict();

const refreshBodySchema = z.object({
    refreshToken: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(1).max(5000)),
    accountId: optionalTrimmedString()
}).strict();

const logoutBodySchema = z.object({
    refreshToken: optionalTrimmedString(),
    all: z.preprocess((v) => {
        if (v === undefined || v === null || v === '') return false;
        if (v === true || v === false) return v;
        if (v === 1 || v === '1' || v === 'true') return true;
        if (v === 0 || v === '0' || v === 'false') return false;
        return v;
    }, z.boolean().default(false))
}).strict();

const deviceUpsertSchema = z.object({
    deviceId: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(3).max(200)),
    platform: optionalTrimmedString(),
    pushProvider: z.enum(['fcm', 'apns']).optional(),
    pushToken: optionalTrimmedString(),
    appVersion: optionalTrimmedString(),
    locale: optionalTrimmedString(),
    timezone: optionalTrimmedString()
}).strict();

const notificationSettingsSchema = z.object({
    enabled: z.preprocess((v) => {
        if (v === undefined || v === null || v === '') return undefined;
        if (v === true || v === false) return v;
        if (v === 1 || v === '1' || v === 'true') return true;
        if (v === 0 || v === '0' || v === 'false') return false;
        return v;
    }, z.boolean().optional()),
    showSenderName: z.preprocess((v) => {
        if (v === undefined || v === null || v === '') return undefined;
        if (v === true || v === false) return v;
        if (v === 1 || v === '1' || v === 'true') return true;
        if (v === 0 || v === '0' || v === 'false') return false;
        return v;
    }, z.boolean().optional()),
    showSenderPhoto: z.preprocess((v) => {
        if (v === undefined || v === null || v === '') return undefined;
        if (v === true || v === false) return v;
        if (v === 1 || v === '1' || v === 'true') return true;
        if (v === 0 || v === '0' || v === 'false') return false;
        return v;
    }, z.boolean().optional()),
    showMessagePreview: z.preprocess((v) => {
        if (v === undefined || v === null || v === '') return undefined;
        if (v === true || v === false) return v;
        if (v === 1 || v === '1' || v === 'true') return true;
        if (v === 0 || v === '0' || v === 'false') return false;
        return v;
    }, z.boolean().optional()),
    sound: z.preprocess((v) => {
        if (v === undefined || v === null) return null;
        if (typeof v !== 'string') return v;
        const trimmed = v.trim();
        return trimmed ? trimmed.slice(0, 100) : null;
    }, z.union([z.string(), z.null()]).optional())
}).strict();

const chatIdParamsSchema = z.object({
    id: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().refine(validateChatId, { message: 'Invalid chatId format' }))
}).strict();

const chatNotifSchema = z.object({
    mutedUntil: z.preprocess((v) => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        const parsed = typeof v === 'number' ? v : parseInt(String(v), 10);
        return Number.isFinite(parsed) ? parsed : v;
    }, z.union([z.number().int().nonnegative(), z.null()]).optional())
}).strict();

const pushTestSchema = z.object({
    title: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(1).max(80)).optional(),
    body: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(1).max(200)).optional(),
    imageUrl: optionalTrimmedString(),
    data: z.record(z.string().max(120)).optional()
}).strict();

const router = express.Router();

router.post('/login', validate({ body: loginBodySchema }), (req, res) => {
    const body = req.validatedBody;
    const db = getDefaultDb();
    const user = db.users.getByUsername.get(body.username);

    if (!user || !user.is_active || !verifyPassword(body.password, user.password_salt, user.password_hash)) {
        return sendError(req, res, 401, 'Invalid credentials');
    }

    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const tokens = issueTokens({
        db,
        user,
        accountId: body.accountId || accountManager.getDefaultAccountId(),
        deviceId: body.deviceId || null,
        ip,
        userAgent
    });

    if (body.deviceId) {
        const existingDevices = db.mobileDevices.getAllByUserId.all(user.id);
        const alreadyKnown = existingDevices.some(device => device.device_id === body.deviceId);
        const activeCount = db.mobileDevices.countActiveByUserId.get(user.id)?.count || 0;
        const maxDevices = Math.max(1, Number(config.MOBILE_MAX_DEVICES_PER_USER) || 20);
        if (!alreadyKnown && activeCount >= maxDevices) {
            return sendError(req, res, 400, 'Too many devices registered');
        }
        db.mobileDevices.upsert.run(
            user.id,
            body.deviceId,
            body.platform || null,
            body.pushProvider || 'fcm',
            body.pushToken || null,
            body.appVersion || null,
            body.locale || null,
            body.timezone || null,
            Date.now()
        );
    }

    const notif = db.mobileNotificationSettings.getByUserId.get(user.id);
    return res.json({
        success: true,
        ...tokens,
        user: sanitizeUser(user),
        notificationSettings: notif || null
    });
});

router.post('/refresh', validate({ body: refreshBodySchema }), (req, res) => {
    const db = getDefaultDb();
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || null;

    try {
        const rotated = rotateRefreshToken({
            db,
            oldRefreshToken: req.validatedBody.refreshToken,
            accountId: req.validatedBody.accountId || accountManager.getDefaultAccountId(),
            ip,
            userAgent
        });
        return res.json({ success: true, ...rotated });
    } catch (error) {
        return sendError(req, res, error.status || 401, error.message || 'Unauthorized');
    }
});

router.post('/logout', requireAuth, validate({ body: logoutBodySchema }), (req, res) => {
    const db = getDefaultDb();
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) {
        return sendError(req, res, 401, 'Not authenticated');
    }

    if (req.validatedBody.all === true) {
        revokeAllRefreshTokensForUser({ db, userId });
        db.mobileDevices.deactivateAllByUserId.run(userId);
        return res.json({ success: true });
    }

    if (req.validatedBody.refreshToken) {
        revokeRefreshToken({ db, refreshToken: req.validatedBody.refreshToken });
    }
    return res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
    const db = getDefaultDb();
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) return sendError(req, res, 401, 'Not authenticated');

    const user = db.users.getById.get(userId);
    if (!user || !user.is_active) return sendError(req, res, 401, 'Not authenticated');

    db.mobileNotificationSettings.ensureDefault.run(userId);
    const notificationSettings = db.mobileNotificationSettings.getByUserId.get(userId);
    const devices = db.mobileDevices.getAllByUserId.all(userId);

    return res.json({
        user: sanitizeUser(user),
        notificationSettings,
        devices
    });
});

router.get('/accounts', requireAuth, (req, res) => {
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) return sendError(req, res, 401, 'Not authenticated');

    const accounts = accountManager.listAccounts().map(account => {
        const context = accountManager.getAccountContext(account.id);
        return {
            id: account.id,
            name: account.name,
            createdAt: account.createdAt,
            status: context?.whatsapp?.getStatus?.()?.status || 'unknown'
        };
    });

    return res.json({
        accounts,
        defaultAccountId: accountManager.getDefaultAccountId()
    });
});

router.get('/devices', requireAuth, (req, res) => {
    const db = getDefaultDb();
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) return sendError(req, res, 401, 'Not authenticated');
    return res.json(db.mobileDevices.getAllByUserId.all(userId));
});

router.put('/devices', requireAuth, validate({ body: deviceUpsertSchema }), (req, res) => {
    const db = getDefaultDb();
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) return sendError(req, res, 401, 'Not authenticated');

    const existingDevices = db.mobileDevices.getAllByUserId.all(userId);
    const alreadyKnown = existingDevices.some(device => device.device_id === req.validatedBody.deviceId);
    const activeCount = db.mobileDevices.countActiveByUserId.get(userId)?.count || 0;
    const maxDevices = Math.max(1, Number(config.MOBILE_MAX_DEVICES_PER_USER) || 20);
    if (!alreadyKnown && activeCount >= maxDevices) {
        return sendError(req, res, 400, 'Too many devices registered');
    }

    const body = req.validatedBody;
    db.mobileDevices.upsert.run(
        userId,
        body.deviceId,
        body.platform || null,
        body.pushProvider || 'fcm',
        body.pushToken || null,
        body.appVersion || null,
        body.locale || null,
        body.timezone || null,
        Date.now()
    );
    return res.json({ success: true });
});

router.delete('/devices/:deviceId', requireAuth, (req, res) => {
    const db = getDefaultDb();
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) return sendError(req, res, 401, 'Not authenticated');
    const deviceId = String(req.params.deviceId || '').trim();
    if (!deviceId) return sendError(req, res, 400, 'Invalid deviceId');
    db.mobileDevices.deactivate.run(userId, deviceId);
    return res.json({ success: true });
});

router.get('/notification-settings', requireAuth, (req, res) => {
    const db = getDefaultDb();
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) return sendError(req, res, 401, 'Not authenticated');
    db.mobileNotificationSettings.ensureDefault.run(userId);
    return res.json(db.mobileNotificationSettings.getByUserId.get(userId));
});

router.put('/notification-settings', requireAuth, validate({ body: notificationSettingsSchema }), (req, res) => {
    const db = getDefaultDb();
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) return sendError(req, res, 401, 'Not authenticated');

    db.mobileNotificationSettings.ensureDefault.run(userId);
    const current = db.mobileNotificationSettings.getByUserId.get(userId) || {};
    const body = req.validatedBody;

    const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (current.enabled ?? 1);
    const showSenderName = body.showSenderName !== undefined ? (body.showSenderName ? 1 : 0) : (current.show_sender_name ?? 1);
    const showSenderPhoto = body.showSenderPhoto !== undefined ? (body.showSenderPhoto ? 1 : 0) : (current.show_sender_photo ?? 1);
    const showMessagePreview = body.showMessagePreview !== undefined ? (body.showMessagePreview ? 1 : 0) : (current.show_message_preview ?? 1);
    const sound = body.sound !== undefined ? body.sound : (current.sound ?? null);

    db.mobileNotificationSettings.upsert.run(
        userId,
        enabled,
        showSenderName,
        showSenderPhoto,
        showMessagePreview,
        sound
    );

    return res.json({ success: true, settings: db.mobileNotificationSettings.getByUserId.get(userId) });
});

router.get('/chats/:id/notification-settings', requireAuth, validate({ params: chatIdParamsSchema }), (req, res) => {
    const db = getDefaultDb();
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) return sendError(req, res, 401, 'Not authenticated');

    const accountId = String(req.headers['x-account-id'] || req.query.accountId || req.auth?.accountId || accountManager.getDefaultAccountId());
    const row = db.mobileChatNotificationSettings.getByKey.get(userId, accountId, req.validatedParams.id);
    return res.json(row || { user_id: userId, account_id: accountId, chat_id: req.validatedParams.id, muted_until: null });
});

router.put('/chats/:id/notification-settings', requireAuth, validate({ params: chatIdParamsSchema, body: chatNotifSchema }), (req, res) => {
    const db = getDefaultDb();
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) return sendError(req, res, 401, 'Not authenticated');

    const accountId = String(req.headers['x-account-id'] || req.query.accountId || req.auth?.accountId || accountManager.getDefaultAccountId());
    const chatId = req.validatedParams.id;

    if (req.validatedBody.mutedUntil === undefined) {
        return sendError(req, res, 400, 'mutedUntil required');
    }

    if (req.validatedBody.mutedUntil === null) {
        db.mobileChatNotificationSettings.clearMute.run(userId, accountId, chatId);
        const row = db.mobileChatNotificationSettings.getByKey.get(userId, accountId, chatId);
        return res.json({ success: true, settings: row || { user_id: userId, account_id: accountId, chat_id: chatId, muted_until: null } });
    }

    db.mobileChatNotificationSettings.upsertMutedUntil.run(userId, accountId, chatId, req.validatedBody.mutedUntil);
    const row = db.mobileChatNotificationSettings.getByKey.get(userId, accountId, chatId);
    return res.json({ success: true, settings: row });
});

router.get('/push/status', requireAuth, (req, res) => {
    return res.json(
        accountManager.mobilePushNotifier?.getStatus?.()
        || { enabled: false, mode: 'disabled', hasServerKey: false, hasServiceAccount: false, projectId: null, publicBaseUrl: null }
    );
});

router.post('/push/test', requireAuth, validate({ body: pushTestSchema }), async (req, res) => {
    const userId = req.auth?.userId || req.session?.userId;
    if (!userId) return sendError(req, res, 401, 'Not authenticated');

    try {
        const result = await accountManager.mobilePushNotifier?.sendTestPush?.({
            userId,
            title: req.validatedBody.title || undefined,
            body: req.validatedBody.body || undefined,
            imageUrl: req.validatedBody.imageUrl || undefined,
            data: req.validatedBody.data || undefined
        });
        return res.json({ success: true, result: result || null });
    } catch (error) {
        return sendError(req, res, 500, error?.message || 'Push failed');
    }
});

module.exports = router;
