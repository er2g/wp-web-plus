/**
 * WhatsApp Web Panel - API Routes v3
 * Drive entegrasyonu ile
 */
const express = require('express');
const router = express.Router();
const accountManager = require('../services/accountManager');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const mediaDir = req.account?.config.MEDIA_DIR;
        if (!mediaDir) {
            return cb(new Error('Account media directory not available'));
        }
        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir, { recursive: true });
        }
        cb(null, mediaDir);
    },
    filename: (req, file, cb) => {
        // Sanitize filename to prevent path traversal
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, Date.now() + '-' + safeName);
    }
});
// Constants
const LIMITS = {
    FILE_SIZE_BYTES: 16 * 1024 * 1024,  // 16 MB
    MESSAGE_LENGTH: 10000,
    TRIGGER_LENGTH: 500,
    URL_LENGTH: 2048,
    QUERY_LENGTH: 200,
    CATEGORY_LENGTH: 50,
    PAGINATION: {
        MESSAGES: 500,
        LOGS: 500,
        SCRIPT_LOGS: 200
    }
};

const upload = multer({ storage, limits: { fileSize: LIMITS.FILE_SIZE_BYTES } });

function validateChatId(chatId) {
    if (!chatId || typeof chatId !== 'string') return false;
    // WhatsApp chat IDs are typically phone@c.us or groupId@g.us
    return /^[\w\-@.]+$/.test(chatId) && chatId.length <= 100;
}

function validateMessage(message) {
    if (!message || typeof message !== 'string') return false;
    return message.length <= LIMITS.MESSAGE_LENGTH;
}

function validateUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.length > LIMITS.URL_LENGTH) return false;
    try {
        const parsed = new URL(url);

        // Only allow http/https
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return false;
        }

        // SSRF Protection: Block localhost and internal IPs
        const hostname = parsed.hostname.toLowerCase();

        // Block localhost variations
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
            return false;
        }

        // Block private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
        const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (ipv4Match) {
            const [, a, b] = ipv4Match.map(Number);
            if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0) {
                return false;
            }
        }

        // Block metadata endpoints (AWS, GCP, Azure)
        if (hostname === '169.254.169.254' || hostname.endsWith('.internal')) {
            return false;
        }

        return true;
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
router.use(accountManager.attachAccount.bind(accountManager));

// ============ ACCOUNTS ============
router.get('/accounts', (req, res) => {
    const accounts = accountManager.listAccounts().map(account => {
        const context = accountManager.getAccountContext(account.id);
        return {
            ...account,
            status: context.whatsapp.getStatus().status
        };
    });

    res.json({
        accounts,
        currentAccountId: req.session.accountId || accountManager.getDefaultAccountId()
    });
});

router.post('/accounts', (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) {
        return res.status(400).json({ error: 'Account name required' });
    }

    const account = accountManager.createAccount(name);
    res.json({ success: true, account });
});

router.post('/accounts/select', (req, res) => {
    const accountId = req.body?.accountId;
    if (!accountId) {
        return res.status(400).json({ error: 'Account id required' });
    }
    const account = accountManager.findAccount(accountId);
    if (!account) {
        return res.status(404).json({ error: 'Account not found' });
    }
    req.session.accountId = accountId;
    accountManager.getAccountContext(accountId);
    res.json({ success: true, accountId });
});

// ============ STATUS ============
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

// ============ SYNC & SETTINGS ============
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

router.get('/settings', (req, res) => {
    res.json(req.account.whatsapp.getSettings());
});

router.post('/settings', (req, res) => {
    const settings = req.account.whatsapp.updateSettings(req.body);
    res.json({ success: true, settings });
});

// ============ CHATS ============
router.get('/chats', (req, res) => {
    res.json(req.account.db.chats.getAll.all());
});

router.get('/chats/:id/messages', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, LIMITS.PAGINATION.MESSAGES);
    res.json(req.account.db.messages.getByChatId.all(req.params.id, limit));
});

// ============ MESSAGES ============
router.get('/messages', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, LIMITS.PAGINATION.MESSAGES);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    res.json(req.account.db.messages.getAll.all(limit, offset));
});

router.get('/messages/search', (req, res) => {
    const query = (req.query.q || '').substring(0, LIMITS.QUERY_LENGTH);
    if (!query) return res.json([]);
    res.json(req.account.db.messages.search.all('%' + query + '%'));
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
        const result = await req.account.whatsapp.sendMessage(chatId, message, options);
        res.json({ success: true, messageId: result.id._serialized });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ AUTO REPLIES ============
router.get('/auto-replies', (req, res) => {
    res.json(req.account.db.autoReplies.getAll.all());
});

router.post('/auto-replies', (req, res) => {
    const { trigger_word, response, match_type, is_active } = req.body;
    if (!trigger_word || !response) {
        return res.status(400).json({ error: 'trigger_word and response required' });
    }
    // Input length validation
    if (trigger_word.length > LIMITS.TRIGGER_LENGTH) {
        return res.status(400).json({ error: 'Trigger word too long (max ' + LIMITS.TRIGGER_LENGTH + ' chars)' });
    }
    if (response.length > LIMITS.MESSAGE_LENGTH) {
        return res.status(400).json({ error: 'Response too long (max ' + LIMITS.MESSAGE_LENGTH + ' chars)' });
    }
    const result = req.account.db.autoReplies.create.run(trigger_word, response, match_type || 'contains', is_active !== false ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/auto-replies/:id', (req, res) => {
    const { trigger_word, response, match_type, is_active } = req.body;
    req.account.db.autoReplies.update.run(trigger_word, response, match_type || 'contains', is_active ? 1 : 0, req.params.id);
    res.json({ success: true });
});

router.delete('/auto-replies/:id', (req, res) => {
    req.account.db.autoReplies.delete.run(req.params.id);
    res.json({ success: true });
});

router.post('/auto-replies/:id/toggle', (req, res) => {
    const reply = req.account.db.autoReplies.getById.get(req.params.id);
    if (!reply) return res.status(404).json({ error: 'Not found' });
    req.account.db.autoReplies.toggle.run(reply.is_active ? 0 : 1, req.params.id);
    res.json({ success: true, is_active: !reply.is_active });
});

// ============ SCHEDULED ============
router.get('/scheduled', (req, res) => {
    res.json(req.account.db.scheduled.getAll.all());
});

router.post('/scheduled', (req, res) => {
    const { chat_id, chat_name, message, scheduled_at, is_recurring, cron_expression } = req.body;
    if (!chat_id || !message || !scheduled_at) {
        return res.status(400).json({ error: 'chat_id, message and scheduled_at required' });
    }
    // Input validation
    if (!validateChatId(chat_id)) {
        return res.status(400).json({ error: 'Invalid chat_id format' });
    }
    if (!validateMessage(message)) {
        return res.status(400).json({ error: 'Message too long or invalid' });
    }
    const result = req.account.db.scheduled.create.run(chat_id, chat_name || '', message, scheduled_at, is_recurring ? 1 : 0, cron_expression || null);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/scheduled/:id', (req, res) => {
    req.account.db.scheduled.delete.run(req.params.id);
    res.json({ success: true });
});

// ============ WEBHOOKS ============
router.get('/webhooks', (req, res) => {
    res.json(req.account.db.webhooks.getAll.all());
});

router.post('/webhooks', (req, res) => {
    const { name, url, events, is_active } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL. Must be http or https.' });
    }
    const result = req.account.db.webhooks.create.run(name || 'Webhook', url, events || 'message', is_active !== false ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/webhooks/:id', (req, res) => {
    const { name, url, events, is_active } = req.body;
    if (url && !validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL. Must be http or https.' });
    }
    req.account.db.webhooks.update.run(name, url, events, is_active ? 1 : 0, req.params.id);
    res.json({ success: true });
});

router.delete('/webhooks/:id', (req, res) => {
    req.account.db.webhooks.delete.run(req.params.id);
    res.json({ success: true });
});

// ============ SCRIPTS ============
router.get('/scripts', (req, res) => {
    res.json(req.account.db.scripts.getAll.all());
});

router.get('/scripts/:id', (req, res) => {
    const script = req.account.db.scripts.getById.get(req.params.id);
    if (!script) return res.status(404).json({ error: 'Not found' });
    res.json(script);
});

router.post('/scripts', (req, res) => {
    const { name, description, code, trigger_type, trigger_filter, is_active } = req.body;
    if (!name || !code) {
        return res.status(400).json({ error: 'name and code required' });
    }
    const filterJson = trigger_filter ? JSON.stringify(trigger_filter) : null;
    const result = req.account.db.scripts.create.run(name, description || '', code, trigger_type || 'message', filterJson, is_active !== false ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/scripts/:id', (req, res) => {
    const { name, description, code, trigger_type, trigger_filter, is_active } = req.body;
    const filterJson = trigger_filter ? JSON.stringify(trigger_filter) : null;
    req.account.db.scripts.update.run(name, description || '', code, trigger_type || 'message', filterJson, is_active ? 1 : 0, req.params.id);
    res.json({ success: true });
});

router.delete('/scripts/:id', (req, res) => {
    req.account.db.scripts.delete.run(req.params.id);
    res.json({ success: true });
});

router.post('/scripts/:id/toggle', (req, res) => {
    const script = req.account.db.scripts.getById.get(req.params.id);
    if (!script) return res.status(404).json({ error: 'Not found' });
    req.account.db.scripts.toggle.run(script.is_active ? 0 : 1, req.params.id);
    res.json({ success: true, is_active: !script.is_active });
});

router.post('/scripts/:id/run', async (req, res) => {
    const script = req.account.db.scripts.getById.get(req.params.id);
    if (!script) return res.status(404).json({ error: 'Not found' });

    const testData = req.body.testData || {
        chatId: 'test@c.us',
        from: 'test@c.us',
        body: 'Test message',
        isFromMe: false,
        isGroup: false
    };

    const result = await req.account.scriptRunner.runScript(script, testData);
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

    const result = await req.account.scriptRunner.testScript(code, data);
    res.json(result);
});

router.get('/scripts/:id/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, LIMITS.PAGINATION.SCRIPT_LOGS);
    res.json(req.account.db.scriptLogs.getByScript.all(req.params.id, limit));
});

// ============ LOGS ============
router.get('/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, LIMITS.PAGINATION.LOGS);
    const category = (req.query.category || '').substring(0, LIMITS.CATEGORY_LENGTH);
    if (category) {
        res.json(req.account.db.logs.getByCategory.all(category, limit));
    } else {
        res.json(req.account.db.logs.getRecent.all(limit));
    }
});

// ============ STATS ============
router.get('/stats', (req, res) => {
    const msgStats = req.account.db.messages.getStats.get() || { total: 0, sent: 0, received: 0, today: 0 };
    const autoReplies = req.account.db.autoReplies.getAll.all();
    const scheduled = req.account.db.scheduled.getAll.all();
    const webhooks = req.account.db.webhooks.getAll.all();
    const scripts = req.account.db.scripts.getAll.all();

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

    const filePath = path.join(req.account.config.MEDIA_DIR, filename);

    // Verify the resolved path is still within MEDIA_DIR
    const resolvedPath = path.resolve(filePath);
    const resolvedMediaDir = path.resolve(req.account.config.MEDIA_DIR);
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
    res.json(req.account.drive.getStatus());
});

router.post('/drive/migrate', async (req, res) => {
    try {
        const drive = req.account.drive;
        const initialized = await drive.initialize();

        if (!initialized) {
            return res.json({
                success: false,
                error: 'Drive not configured. Please upload OAuth credentials to ' + req.account.config.DATA_DIR
            });
        }

        const result = await drive.migrateExistingFiles(req.account.config.MEDIA_DIR, req.account.db.db);
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
        const drive = req.account.drive;
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
