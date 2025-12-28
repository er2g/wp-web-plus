/**
 * WhatsApp Web Panel - API Routes v3
 * Drive entegrasyonu ile
 */
const express = require('express');
const router = express.Router();
const db = require('../database');
const whatsapp = require('../whatsapp');
const scriptRunner = require('../services/scriptRunner');
const multer = require('multer');
const path = require('path');
const config = require('../config');
const fs = require('fs');

// Ensure media directory exists
if (!fs.existsSync(config.MEDIA_DIR)) {
    fs.mkdirSync(config.MEDIA_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: config.MEDIA_DIR,
    filename: (req, file, cb) => {
        // Sanitize filename to prevent path traversal
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, Date.now() + '-' + safeName);
    }
});
const upload = multer({ storage, limits: { fileSize: 16 * 1024 * 1024 } });

// Input validation helpers
const MAX_MESSAGE_LENGTH = 10000;
const MAX_TRIGGER_LENGTH = 500;
const MAX_URL_LENGTH = 2048;

function validateChatId(chatId) {
    if (!chatId || typeof chatId !== 'string') return false;
    // WhatsApp chat IDs are typically phone@c.us or groupId@g.us
    return /^[\w\-@.]+$/.test(chatId) && chatId.length <= 100;
}

function validateMessage(message) {
    if (!message || typeof message !== 'string') return false;
    return message.length <= MAX_MESSAGE_LENGTH;
}

function validateUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.length > MAX_URL_LENGTH) return false;
    try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
        return false;
    }
}

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        next();
    } else {
        res.status(401).json({ error: 'Not authenticated' });
    }
}

router.use(requireAuth);

// ============ STATUS ============
router.get('/status', (req, res) => {
    const waStatus = whatsapp.getStatus();
    const stats = db.messages.getStats.get();
    res.json({
        whatsapp: waStatus,
        stats: stats || { total: 0, sent: 0, received: 0, today: 0 }
    });
});

router.get('/qr', (req, res) => {
    const status = whatsapp.getStatus();
    res.json({ qr: status.qrCode, status: status.status });
});

router.post('/connect', async (req, res) => {
    try {
        await whatsapp.initialize();
        res.json({ success: true, message: 'Initializing...' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/disconnect', async (req, res) => {
    try {
        await whatsapp.logout();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ SYNC & SETTINGS ============
router.post('/sync', async (req, res) => {
    try {
        const result = await whatsapp.fullSync();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/sync/progress', (req, res) => {
    res.json(whatsapp.getSyncProgress());
});

router.get('/settings', (req, res) => {
    res.json(whatsapp.getSettings());
});

router.post('/settings', (req, res) => {
    const settings = whatsapp.updateSettings(req.body);
    res.json({ success: true, settings });
});

// ============ CHATS ============
router.get('/chats', (req, res) => {
    res.json(db.chats.getAll.all());
});

router.get('/chats/:id/messages', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500); // Cap at 500
    res.json(db.messages.getByChatId.all(req.params.id, limit));
});

// ============ MESSAGES ============
router.get('/messages', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500); // Cap at 500
    const offset = Math.max(parseInt(req.query.offset) || 0, 0); // Ensure non-negative
    res.json(db.messages.getAll.all(limit, offset));
});

router.get('/messages/search', (req, res) => {
    const query = (req.query.q || '').substring(0, 200); // Limit query length
    if (!query) return res.json([]);
    res.json(db.messages.search.all('%' + query + '%'));
});

router.post('/send', upload.single('media'), async (req, res) => {
    try {
        const { chatId, message } = req.body;
        if (!chatId || !message) {
            return res.status(400).json({ error: 'chatId and message required' });
        }
        if (!validateChatId(chatId)) {
            return res.status(400).json({ error: 'Invalid chatId format' });
        }
        if (!validateMessage(message)) {
            return res.status(400).json({ error: 'Message too long or invalid' });
        }
        const options = req.file ? { mediaPath: req.file.path } : {};
        const result = await whatsapp.sendMessage(chatId, message, options);
        res.json({ success: true, messageId: result.id._serialized });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ AUTO REPLIES ============
router.get('/auto-replies', (req, res) => {
    res.json(db.autoReplies.getAll.all());
});

router.post('/auto-replies', (req, res) => {
    const { trigger_word, response, match_type, is_active } = req.body;
    if (!trigger_word || !response) {
        return res.status(400).json({ error: 'trigger_word and response required' });
    }
    const result = db.autoReplies.create.run(trigger_word, response, match_type || 'contains', is_active !== false ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/auto-replies/:id', (req, res) => {
    const { trigger_word, response, match_type, is_active } = req.body;
    db.autoReplies.update.run(trigger_word, response, match_type || 'contains', is_active ? 1 : 0, req.params.id);
    res.json({ success: true });
});

router.delete('/auto-replies/:id', (req, res) => {
    db.autoReplies.delete.run(req.params.id);
    res.json({ success: true });
});

router.post('/auto-replies/:id/toggle', (req, res) => {
    const reply = db.autoReplies.getById.get(req.params.id);
    if (!reply) return res.status(404).json({ error: 'Not found' });
    db.autoReplies.toggle.run(reply.is_active ? 0 : 1, req.params.id);
    res.json({ success: true, is_active: !reply.is_active });
});

// ============ SCHEDULED ============
router.get('/scheduled', (req, res) => {
    res.json(db.scheduled.getAll.all());
});

router.post('/scheduled', (req, res) => {
    const { chat_id, chat_name, message, scheduled_at, is_recurring, cron_expression } = req.body;
    if (!chat_id || !message || !scheduled_at) {
        return res.status(400).json({ error: 'chat_id, message and scheduled_at required' });
    }
    const result = db.scheduled.create.run(chat_id, chat_name || '', message, scheduled_at, is_recurring ? 1 : 0, cron_expression || null);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/scheduled/:id', (req, res) => {
    db.scheduled.delete.run(req.params.id);
    res.json({ success: true });
});

// ============ WEBHOOKS ============
router.get('/webhooks', (req, res) => {
    res.json(db.webhooks.getAll.all());
});

router.post('/webhooks', (req, res) => {
    const { name, url, events, is_active } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL. Must be http or https.' });
    }
    const result = db.webhooks.create.run(name || 'Webhook', url, events || 'message', is_active !== false ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/webhooks/:id', (req, res) => {
    const { name, url, events, is_active } = req.body;
    if (url && !validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL. Must be http or https.' });
    }
    db.webhooks.update.run(name, url, events, is_active ? 1 : 0, req.params.id);
    res.json({ success: true });
});

router.delete('/webhooks/:id', (req, res) => {
    db.webhooks.delete.run(req.params.id);
    res.json({ success: true });
});

// ============ SCRIPTS ============
router.get('/scripts', (req, res) => {
    res.json(db.scripts.getAll.all());
});

router.get('/scripts/:id', (req, res) => {
    const script = db.scripts.getById.get(req.params.id);
    if (!script) return res.status(404).json({ error: 'Not found' });
    res.json(script);
});

router.post('/scripts', (req, res) => {
    const { name, description, code, trigger_type, trigger_filter, is_active } = req.body;
    if (!name || !code) {
        return res.status(400).json({ error: 'name and code required' });
    }
    const filterJson = trigger_filter ? JSON.stringify(trigger_filter) : null;
    const result = db.scripts.create.run(name, description || '', code, trigger_type || 'message', filterJson, is_active !== false ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/scripts/:id', (req, res) => {
    const { name, description, code, trigger_type, trigger_filter, is_active } = req.body;
    const filterJson = trigger_filter ? JSON.stringify(trigger_filter) : null;
    db.scripts.update.run(name, description || '', code, trigger_type || 'message', filterJson, is_active ? 1 : 0, req.params.id);
    res.json({ success: true });
});

router.delete('/scripts/:id', (req, res) => {
    db.scripts.delete.run(req.params.id);
    res.json({ success: true });
});

router.post('/scripts/:id/toggle', (req, res) => {
    const script = db.scripts.getById.get(req.params.id);
    if (!script) return res.status(404).json({ error: 'Not found' });
    db.scripts.toggle.run(script.is_active ? 0 : 1, req.params.id);
    res.json({ success: true, is_active: !script.is_active });
});

router.post('/scripts/:id/run', async (req, res) => {
    const script = db.scripts.getById.get(req.params.id);
    if (!script) return res.status(404).json({ error: 'Not found' });

    const testData = req.body.testData || {
        chatId: 'test@c.us',
        from: 'test@c.us',
        body: 'Test message',
        isFromMe: false,
        isGroup: false
    };

    const result = await scriptRunner.runScript(script, testData);
    res.json(result);
});

router.post('/scripts/test', async (req, res) => {
    const { code, testData } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });

    const data = testData || {
        chatId: 'test@c.us',
        from: 'test@c.us',
        body: 'Test message',
        isFromMe: false,
        isGroup: false
    };

    const result = await scriptRunner.testScript(code, data);
    res.json(result);
});

router.get('/scripts/:id/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(db.scriptLogs.getByScript.all(req.params.id, limit));
});

// ============ LOGS ============
router.get('/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const category = req.query.category;
    if (category) {
        res.json(db.logs.getByCategory.all(category, limit));
    } else {
        res.json(db.logs.getRecent.all(limit));
    }
});

// ============ STATS ============
router.get('/stats', (req, res) => {
    const msgStats = db.messages.getStats.get() || { total: 0, sent: 0, received: 0, today: 0 };
    const autoReplies = db.autoReplies.getAll.all();
    const scheduled = db.scheduled.getAll.all();
    const webhooks = db.webhooks.getAll.all();
    const scripts = db.scripts.getAll.all();

    res.json({
        messages: msgStats,
        autoReplies: {
            total: autoReplies.length,
            active: autoReplies.filter(r => r.is_active).length,
            totalReplies: autoReplies.reduce((sum, r) => sum + r.reply_count, 0)
        },
        scheduled: {
            total: scheduled.length,
            pending: scheduled.filter(s => !s.is_sent).length
        },
        webhooks: {
            total: webhooks.length,
            active: webhooks.filter(w => w.is_active).length
        },
        scripts: {
            total: scripts.length,
            active: scripts.filter(s => s.is_active).length,
            totalRuns: scripts.reduce((sum, s) => sum + s.run_count, 0)
        }
    });
});

// ============ MEDIA ============
router.get('/media/:filename', (req, res) => {
    const filename = req.params.filename;

    // Comprehensive path traversal protection
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\') ||
        filename.includes('\0') || filename.includes('%') || filename.includes(':')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }

    // Whitelist allowed characters (alphanumeric, dash, underscore, dot)
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename characters' });
    }

    const filePath = path.join(config.MEDIA_DIR, filename);

    // Verify the resolved path is still within MEDIA_DIR
    const resolvedPath = path.resolve(filePath);
    const resolvedMediaDir = path.resolve(config.MEDIA_DIR);
    if (!resolvedPath.startsWith(resolvedMediaDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid file path' });
    }

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    res.sendFile(filePath);
});

// ============ GOOGLE DRIVE ============
router.get('/drive/status', (req, res) => {
    try {
        const drive = require('../drive');
        res.json(drive.getStatus());
    } catch (error) {
        const keyPath = path.join(config.DATA_DIR, 'drive-service-account.json');
        res.json({
            configured: fs.existsSync(keyPath),
            keyPath: keyPath,
            initialized: false,
            error: error.message
        });
    }
});

router.post('/drive/migrate', async (req, res) => {
    try {
        const drive = require('../drive');
        const initialized = await drive.initialize();

        if (!initialized) {
            return res.json({
                success: false,
                error: 'Drive not configured. Please upload service account JSON to ' + path.join(config.DATA_DIR, 'drive-service-account.json')
            });
        }

        const result = await drive.migrateExistingFiles(config.MEDIA_DIR, db.db);
        res.json({
            success: true,
            migrated: result.migrated,
            failed: result.failed
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/drive/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
        const drive = require('../drive');
        const initialized = await drive.initialize();

        if (!initialized) {
            return res.status(400).json({ error: 'Drive not configured' });
        }

        const result = await drive.uploadFile(req.file.path, req.file.mimetype);

        // Lokal dosyayi sil
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            fileId: result.id,
            downloadLink: result.downloadLink,
            viewLink: result.viewLink
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
