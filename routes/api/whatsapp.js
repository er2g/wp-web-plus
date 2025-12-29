const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');

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
        res.status(500).json({ error: error.message });
    }
});

router.post('/disconnect', async (req, res) => {
    try {
        await req.account.whatsapp.logout();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/sync', async (req, res) => {
    try {
        const result = await req.account.whatsapp.fullSync();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/sync/progress', (req, res) => {
    res.json(req.account.whatsapp.getSyncProgress());
});

router.get('/settings', requireRole(['admin', 'manager']), (req, res) => {
    res.json(req.account.whatsapp.getSettings());
});

router.post('/settings', requireRole(['admin', 'manager']), (req, res) => {
    const settings = req.account.whatsapp.updateSettings(req.body);
    res.json({ success: true, settings });
});

router.post('/chats/:id/mark-read', async (req, res) => {
    try {
        const result = await req.account.whatsapp.markAsRead(req.params.id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

