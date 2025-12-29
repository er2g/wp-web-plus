const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { LIMITS, validateUrl } = require('../../lib/apiValidation');

router.get('/', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.webhooks.getAll.all());
});

router.post('/', requireRole(['admin']), (req, res) => {
    const { name, url, events, is_active } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL. Must be http or https.' });
    }
    const result = req.account.db.webhooks.create.run(name || 'Webhook', url, events || 'message', is_active !== false ? 1 : 0);
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id', requireRole(['admin']), (req, res) => {
    const { name, url, events, is_active } = req.body;
    if (url && !validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL. Must be http or https.' });
    }
    req.account.db.webhooks.update.run(name, url, events, is_active ? 1 : 0, req.params.id);
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

