const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { validateChatId } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

const booleanLike = z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (value === true || value === false) return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    return value;
}, z.boolean());

const optionalPositiveInt = z.preprocess(
    (value) => {
        if (value === undefined || value === null || value === '') return undefined;
        const parsed = parseInt(String(value), 10);
        return Number.isFinite(parsed) ? parsed : value;
    },
    z.number().int().positive().optional()
);

const whatsappSettingsSchema = z.object({
    downloadMedia: booleanLike.optional(),
    syncOnConnect: booleanLike.optional(),
    maxMessagesPerChat: optionalPositiveInt.refine((value) => value === undefined || value <= 5000, {
        message: 'maxMessagesPerChat too large'
    }),
    uploadToDrive: booleanLike.optional(),
    downloadMediaOnSync: booleanLike.optional(),
    ghostMode: booleanLike.optional()
}).strict();

const chatIdParamSchema = z.object({
    id: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'Invalid chatId format',
            invalid_type_error: 'Invalid chatId format'
        }).refine(validateChatId, { message: 'Invalid chatId format' })
    )
}).strict();

router.get('/status', (req, res) => {
    const { whatsapp, db } = req.account;
    const waStatus = whatsapp.getStatus();
    const stats = db.messages.getStats.get();
    res.json({
        whatsapp: waStatus,
        stats: stats || { total: 0, sent: 0, received: 0, today: 0 }
    });
});

router.get('/qr', (req, res) => {
    const status = req.account.whatsapp.getStatus();
    res.json({ qr: status.qrCode, status: status.status });
});

router.post('/connect', async (req, res) => {
    try {
        await req.account.whatsapp.initialize();
        res.json({ success: true, message: 'Initializing...' });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

router.post('/disconnect', async (req, res) => {
    try {
        await req.account.whatsapp.logout();
        res.json({ success: true });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

router.post('/sync', async (req, res) => {
    try {
        const result = await req.account.whatsapp.fullSync();
        res.json(result);
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

router.get('/sync/progress', (req, res) => {
    res.json(req.account.whatsapp.getSyncProgress());
});

router.get('/settings', requireRole(['admin', 'manager']), (req, res) => {
    res.json(req.account.whatsapp.getSettings());
});

router.post('/settings', requireRole(['admin', 'manager']), validate({ body: whatsappSettingsSchema }), (req, res) => {
    const settings = req.account.whatsapp.updateSettings(req.validatedBody);
    res.json({ success: true, settings });
});

router.post('/chats/:id/mark-read', validate({ params: chatIdParamSchema }), async (req, res) => {
    try {
        const result = await req.account.whatsapp.markAsRead(req.validatedParams.id);
        res.json(result);
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

module.exports = router;
