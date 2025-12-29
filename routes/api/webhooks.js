const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { LIMITS, validateUrl } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

const booleanLike = z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (value === true || value === false) return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    return value;
}, z.boolean());

const webhookCreateSchema = z.object({
    name: z.string().trim().max(200).optional(),
    url: z.string()
        .trim()
        .min(1, 'url required')
        .max(LIMITS.URL_LENGTH)
        .refine(validateUrl, { message: 'Invalid URL. Must be http or https.' }),
    events: z.string().trim().max(200).optional(),
    is_active: booleanLike.optional()
}).strict();

const webhookUpdateSchema = z.object({
    name: z.string().trim().max(200).optional(),
    url: z.string()
        .trim()
        .min(1)
        .max(LIMITS.URL_LENGTH)
        .refine(validateUrl, { message: 'Invalid URL. Must be http or https.' })
        .optional(),
    events: z.string().trim().max(200).optional(),
    is_active: booleanLike.optional()
}).strict();

router.get('/', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.webhooks.getAll.all());
});

router.post('/', requireRole(['admin']), validate({ body: webhookCreateSchema }), (req, res) => {
    const { name, url, events, is_active } = req.validatedBody;
    const result = req.account.db.webhooks.create.run(
        name || 'Webhook',
        url,
        events || 'message',
        is_active !== false ? 1 : 0
    );
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id', requireRole(['admin']), validate({ body: webhookUpdateSchema }), (req, res) => {
    const existing = req.account.db.webhooks.getById.get(req.params.id);
    if (!existing) {
        return sendError(req, res, 404, 'Not found');
    }

    const { name, url, events, is_active } = req.validatedBody;
    req.account.db.webhooks.update.run(
        name ?? existing.name,
        url ?? existing.url,
        events ?? existing.events,
        is_active === undefined ? existing.is_active : (is_active ? 1 : 0),
        req.params.id
    );
    return res.json({ success: true });
});

router.delete('/:id', requireRole(['admin']), (req, res) => {
    req.account.db.webhooks.delete.run(req.params.id);
    return res.json({ success: true });
});

router.get('/:id/deliveries', requireRole(['admin']), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, LIMITS.PAGINATION.WEBHOOK_DELIVERIES);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    res.json(req.account.db.webhookDeliveries.getByWebhookId.all(req.params.id, limit, offset));
});

router.post('/deliveries/:id/replay', requireRole(['admin']), async (req, res) => {
    try {
        const delivery = req.account.db.webhookDeliveries.getById.get(req.params.id);
        if (!delivery) {
            return res.status(404).json({ error: 'Delivery not found' });
        }
        await req.account.webhook.replayDelivery(delivery);
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

module.exports = router;
