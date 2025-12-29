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
const config = require('../config');
const { hashPassword, passwordMeetsPolicy } = require('../services/passwords');
const aiService = require('../services/aiService');

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
    TAG_LENGTH: 60,
    NOTE_LENGTH: 2000,
    URL_LENGTH: 2048,
    QUERY_LENGTH: 200,
    CATEGORY_LENGTH: 50,
    TEMPLATE_NAME_LENGTH: 200,
    TEMPLATE_VARIABLES_LENGTH: 500,
    PAGINATION: {
        MESSAGES: 500,
        LOGS: 500,
        SCRIPT_LOGS: 200,
        WEBHOOK_DELIVERIES: 200
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

function validateNote(note) {
    if (!note || typeof note !== 'string') return false;
    return note.length <= LIMITS.NOTE_LENGTH;
}

function normalizeTemplateVariables(rawVariables) {
    if (!rawVariables) return [];
    if (Array.isArray(rawVariables)) {
        return rawVariables
            .map(item => String(item).trim())
            .filter(Boolean)
            .slice(0, 50);
    }
    if (typeof rawVariables === 'string') {
        return rawVariables
            .split(',')
            .map(item => item.trim())
            .filter(Boolean)
            .slice(0, 50);
    }
    return [];
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

function parseDateRange(query) {
    const now = Date.now();
    const endRaw = query.end ? Number(query.end) : now;
    const startRaw = query.start ? Number(query.start) : endRaw - 7 * 24 * 60 * 60 * 1000;

    if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) {
        return null;
    }

    const start = Math.floor(startRaw);
    const end = Math.floor(endRaw);

    if (start > end) {
        return null;
    }

    return { start, end };
}

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        next();
    } else {
        res.status(401).json({ error: 'Not authenticated' });
    }
}

function requireRole(roles = []) {
    return (req, res, next) => {
        const role = req.session?.role;
        if (!role || !roles.includes(role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        return next();
    };
}

router.use(requireAuth);
router.use(accountManager.attachAccount.bind(accountManager));

// ============ ACCOUNTS ============
router.get('/accounts', requireRole(['admin']), (req, res) => {
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

router.post('/accounts', requireRole(['admin']), (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) {
        return res.status(400).json({ error: 'Account name required' });
    }

    const account = accountManager.createAccount(name);
    res.json({ success: true, account });
});

router.post('/accounts/select', requireRole(['admin']), (req, res) => {
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

// ============ CHATS ============
router.get('/chats', (req, res) => {
    const tagFilter = (req.query.tag || '').trim();
    if (!tagFilter) {
        return res.json(req.account.db.chats.getAll.all());
    }

    const tagId = /^\d+$/.test(tagFilter) ? parseInt(tagFilter, 10) : null;
    const chatIdsRows = tagId
        ? req.account.db.contactTags.getChatIdsByTagId.all(tagId)
        : req.account.db.contactTags.getChatIdsByTagName.all(tagFilter);
    const chatIds = chatIdsRows.map(row => row.chat_id);
    if (!chatIds.length) {
        return res.json([]);
    }

    const placeholders = chatIds.map(() => '?').join(',');
    const chats = req.account.db.db.prepare(
        `SELECT * FROM chats WHERE chat_id IN (${placeholders}) ORDER BY last_message_at DESC`
    ).all(...chatIds);
    res.json(chats);
});

router.get('/chats/search', (req, res) => {
    const query = (req.query.q || '').substring(0, LIMITS.QUERY_LENGTH).trim();
    const tagFilter = (req.query.tag || '').trim();
    const noteQuery = (req.query.note || '').substring(0, LIMITS.QUERY_LENGTH).trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, LIMITS.PAGINATION.MESSAGES);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    if (!query && !tagFilter && !noteQuery) return res.json([]);

    let chatIds = null;
    if (tagFilter) {
        const tagId = /^\d+$/.test(tagFilter) ? parseInt(tagFilter, 10) : null;
        const rows = tagId
            ? req.account.db.contactTags.getChatIdsByTagId.all(tagId)
            : req.account.db.contactTags.getChatIdsByTagName.all(tagFilter);
        chatIds = new Set(rows.map(row => row.chat_id));
    }

    if (noteQuery) {
        const rows = req.account.db.notes.searchChatIds.all('%' + noteQuery + '%');
        const noteIds = new Set(rows.map(row => row.chat_id));
        if (chatIds) {
            chatIds = new Set([...chatIds].filter(id => noteIds.has(id)));
        } else {
            chatIds = noteIds;
        }
    }

    if (chatIds && chatIds.size === 0) {
        return res.json([]);
    }

    if (!chatIds && query) {
        return res.json(req.account.db.chats.search.all('%' + query + '%', limit, offset));
    }

    const filterIds = chatIds ? Array.from(chatIds) : null;
    if (query) {
        const placeholders = filterIds ? filterIds.map(() => '?').join(',') : '';
        const params = ['%' + query + '%'];
        if (filterIds) {
            params.push(...filterIds);
        }
        params.push(limit, offset);
        const results = req.account.db.db.prepare(`
            SELECT * FROM chats
            WHERE name LIKE ?
            ${filterIds ? `AND chat_id IN (${placeholders})` : ''}
            ORDER BY last_message_at DESC
            LIMIT ? OFFSET ?
        `).all(...params);
        return res.json(results);
    }

    const placeholders = filterIds.map(() => '?').join(',');
    const results = req.account.db.db.prepare(`
        SELECT * FROM chats
        WHERE chat_id IN (${placeholders})
        ORDER BY last_message_at DESC
        LIMIT ? OFFSET ?
    `).all(...filterIds, limit, offset);
    res.json(results);
});

router.get('/chats/:id/messages', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, LIMITS.PAGINATION.MESSAGES);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const messages = req.account.db.messages.getByChatId.all(req.params.id, limit, offset);
    const tags = req.account.db.contactTags.getByChatId.all(req.params.id);
    const notes = req.account.db.notes.getByChatId.all(req.params.id);
    res.json({ messages, tags, notes });
});

// ============ MESSAGES ============
router.get('/messages', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, LIMITS.PAGINATION.MESSAGES);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const messages = req.account.db.messages.getAll.all(limit, offset);
    const chatIds = Array.from(new Set(messages.map(message => message.chat_id).filter(Boolean)));
    if (!chatIds.length) {
        return res.json({ messages, tagsByChat: {}, notesByChat: {} });
    }

    const placeholders = chatIds.map(() => '?').join(',');
    const tagRows = req.account.db.db.prepare(`
        SELECT contact_tags.chat_id, tags.id, tags.name, tags.color
        FROM contact_tags
        JOIN tags ON tags.id = contact_tags.tag_id
        WHERE contact_tags.chat_id IN (${placeholders})
        ORDER BY tags.name ASC
    `).all(...chatIds);
    const noteRows = req.account.db.db.prepare(`
        SELECT id, chat_id, content, created_at, updated_at
        FROM notes
        WHERE chat_id IN (${placeholders})
        ORDER BY created_at DESC
    `).all(...chatIds);

    const tagsByChat = {};
    tagRows.forEach(row => {
        if (!tagsByChat[row.chat_id]) {
            tagsByChat[row.chat_id] = [];
        }
        tagsByChat[row.chat_id].push({ id: row.id, name: row.name, color: row.color });
    });

    const notesByChat = {};
    noteRows.forEach(note => {
        if (!notesByChat[note.chat_id]) {
            notesByChat[note.chat_id] = [];
        }
        notesByChat[note.chat_id].push(note);
    });

    res.json({ messages, tagsByChat, notesByChat });
});

router.get('/messages/search', (req, res) => {
    const query = (req.query.q || '').substring(0, LIMITS.QUERY_LENGTH);
    if (!query) return res.json([]);
    res.json(req.account.db.messages.search.all('%' + query + '%'));
});

// ============ TAGS & NOTES ============
router.get('/tags', (req, res) => {
    res.json(req.account.db.tags.getAll.all());
});

router.post('/tags', (req, res) => {
    const name = (req.body?.name || '').trim();
    const color = (req.body?.color || '').trim() || null;
    if (!name) {
        return res.status(400).json({ error: 'name required' });
    }
    if (name.length > LIMITS.TAG_LENGTH) {
        return res.status(400).json({ error: 'Tag name too long' });
    }
    const existing = req.account.db.tags.getByName.get(name);
    if (existing) {
        return res.json({ success: true, id: existing.id, tag: existing });
    }
    const result = req.account.db.tags.create.run(name, color);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/tags/:id', (req, res) => {
    const name = (req.body?.name || '').trim();
    const color = (req.body?.color || '').trim() || null;
    if (!name) {
        return res.status(400).json({ error: 'name required' });
    }
    if (name.length > LIMITS.TAG_LENGTH) {
        return res.status(400).json({ error: 'Tag name too long' });
    }
    req.account.db.tags.update.run(name, color, req.params.id);
    res.json({ success: true });
});

router.delete('/tags/:id', (req, res) => {
    req.account.db.db.prepare('DELETE FROM contact_tags WHERE tag_id = ?').run(req.params.id);
    req.account.db.tags.delete.run(req.params.id);
    res.json({ success: true });
});

router.get('/chats/:id/tags', (req, res) => {
    res.json(req.account.db.contactTags.getByChatId.all(req.params.id));
});

router.post('/chats/:id/tags', (req, res) => {
    const chatId = req.params.id;
    const tagId = req.body?.tag_id;
    if (!tagId) {
        return res.status(400).json({ error: 'tag_id required' });
    }
    if (!validateChatId(chatId)) {
        return res.status(400).json({ error: 'Invalid chatId format' });
    }
    const tag = req.account.db.tags.getById.get(tagId);
    if (!tag) {
        return res.status(404).json({ error: 'Tag not found' });
    }
    const chat = req.account.db.chats.getById.get(chatId);
    const name = chat?.name || chatId;
    const phone = chatId && chatId.includes('@c.us') ? chatId.split('@')[0] : null;
    req.account.db.contacts.upsert.run(chatId, name, phone);
    req.account.db.contactTags.add.run(chatId, tagId);
    res.json({ success: true });
});

router.delete('/chats/:id/tags/:tagId', (req, res) => {
    req.account.db.contactTags.remove.run(req.params.id, req.params.tagId);
    res.json({ success: true });
});

router.get('/contacts/:id/tags', (req, res) => {
    res.json(req.account.db.contactTags.getByChatId.all(req.params.id));
});

router.post('/contacts/:id/tags', (req, res) => {
    const chatId = req.params.id;
    const tagId = req.body?.tag_id;
    if (!tagId) {
        return res.status(400).json({ error: 'tag_id required' });
    }
    if (!validateChatId(chatId)) {
        return res.status(400).json({ error: 'Invalid chatId format' });
    }
    const tag = req.account.db.tags.getById.get(tagId);
    if (!tag) {
        return res.status(404).json({ error: 'Tag not found' });
    }
    const chat = req.account.db.chats.getById.get(chatId);
    const name = chat?.name || chatId;
    const phone = chatId && chatId.includes('@c.us') ? chatId.split('@')[0] : null;
    req.account.db.contacts.upsert.run(chatId, name, phone);
    req.account.db.contactTags.add.run(chatId, tagId);
    res.json({ success: true });
});

router.delete('/contacts/:id/tags/:tagId', (req, res) => {
    req.account.db.contactTags.remove.run(req.params.id, req.params.tagId);
    res.json({ success: true });
});

router.get('/chats/:id/notes', (req, res) => {
    res.json(req.account.db.notes.getByChatId.all(req.params.id));
});

router.post('/chats/:id/notes', (req, res) => {
    const content = (req.body?.content || '').trim();
    if (!content) {
        return res.status(400).json({ error: 'content required' });
    }
    if (!validateNote(content)) {
        return res.status(400).json({ error: 'Note too long' });
    }
    if (!validateChatId(req.params.id)) {
        return res.status(400).json({ error: 'Invalid chatId format' });
    }
    req.account.db.notes.create.run(req.params.id, content);
    res.json({ success: true });
});

router.put('/chats/:id/notes/:noteId', (req, res) => {
    const content = (req.body?.content || '').trim();
    if (!content) {
        return res.status(400).json({ error: 'content required' });
    }
    if (!validateNote(content)) {
        return res.status(400).json({ error: 'Note too long' });
    }
    req.account.db.notes.update.run(content, req.params.noteId, req.params.id);
    res.json({ success: true });
});

router.delete('/chats/:id/notes/:noteId', (req, res) => {
    req.account.db.notes.delete.run(req.params.noteId, req.params.id);
    res.json({ success: true });
});

router.post('/send', upload.single('media'), async (req, res) => {
    try {
        const { chatId, message } = req.body;
        const trimmedMessage = (message || '').trim();
        if (!chatId || (!trimmedMessage && !req.file)) {
            return res.status(400).json({ error: 'chatId and message or media required' });
        }
        if (!validateChatId(chatId)) {
            return res.status(400).json({ error: 'Invalid chatId format' });
        }
        if (trimmedMessage && !validateMessage(trimmedMessage)) {
            return res.status(400).json({ error: 'Message too long or invalid' });
        }
        const options = req.file ? { mediaPath: req.file.path } : {};
        const result = await req.account.whatsapp.sendMessage(chatId, trimmedMessage, options);
        res.json({ success: true, messageId: result.id._serialized });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ AUTO REPLIES ============
router.get('/auto-replies', (req, res) => {
    res.json(req.account.db.autoReplies.getAll.all());
});

router.post('/auto-replies', requireRole(['admin', 'manager']), (req, res) => {
    const { trigger_word, response, template_id, match_type, is_active, required_tag_id, exclude_tag_id } = req.body;
    if (!trigger_word || (!response && !template_id)) {
        return res.status(400).json({ error: 'trigger_word and response or template_id required' });
    }
    // Input length validation
    if (trigger_word.length > LIMITS.TRIGGER_LENGTH) {
        return res.status(400).json({ error: 'Trigger word too long (max ' + LIMITS.TRIGGER_LENGTH + ' chars)' });
    }
    if (response && response.length > LIMITS.MESSAGE_LENGTH) {
        return res.status(400).json({ error: 'Response too long (max ' + LIMITS.MESSAGE_LENGTH + ' chars)' });
    }
    if (match_type === 'regex') {
        try {
            new RegExp(trigger_word);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid regular expression' });
        }
    }
    if (template_id) {
        const template = req.account.db.messageTemplates.getById.get(template_id);
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }
    }
    const result = req.account.db.autoReplies.create.run(
        trigger_word,
        response || '',
        template_id || null,
        match_type || 'contains',
        is_active !== false ? 1 : 0,
        required_tag_id || null,
        exclude_tag_id || null
    );
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/auto-replies/:id', requireRole(['admin', 'manager']), (req, res) => {
    const { trigger_word, response, template_id, match_type, is_active, required_tag_id, exclude_tag_id } = req.body;
    if (match_type === 'regex') {
        try {
            new RegExp(trigger_word);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid regular expression' });
        }
    }
    if (template_id) {
        const template = req.account.db.messageTemplates.getById.get(template_id);
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }
    }
    req.account.db.autoReplies.update.run(
        trigger_word,
        response || '',
        template_id || null,
        match_type || 'contains',
        is_active ? 1 : 0,
        required_tag_id || null,
        exclude_tag_id || null,
        req.params.id
    );
    res.json({ success: true });
});

router.delete('/auto-replies/:id', requireRole(['admin', 'manager']), (req, res) => {
    req.account.db.autoReplies.delete.run(req.params.id);
    res.json({ success: true });
});

router.post('/auto-replies/:id/toggle', requireRole(['admin', 'manager']), (req, res) => {
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
    const { chat_id, chat_name, message, template_id, scheduled_at, is_recurring, cron_expression } = req.body;
    if (!chat_id || (!message && !template_id) || !scheduled_at) {
        return res.status(400).json({ error: 'chat_id, message or template_id, and scheduled_at required' });
    }
    // Input validation
    if (!validateChatId(chat_id)) {
        return res.status(400).json({ error: 'Invalid chat_id format' });
    }
    if (message && !validateMessage(message)) {
        return res.status(400).json({ error: 'Message too long or invalid' });
    }
    let resolvedMessage = message || '';
    if (template_id) {
        const template = req.account.db.messageTemplates.getById.get(template_id);
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }
        if (!resolvedMessage) {
            resolvedMessage = template.content;
        }
    }
    if (is_recurring && !cron_expression) {
        return res.status(400).json({ error: 'cron_expression required for recurring schedule' });
    }
    const result = req.account.db.scheduled.create.run(
        chat_id,
        chat_name || '',
        resolvedMessage,
        template_id || null,
        scheduled_at,
        is_recurring ? 1 : 0,
        cron_expression || null
    );
    if (is_recurring && cron_expression) {
        const scheduled = req.account.db.scheduled.getById.get(result.lastInsertRowid);
        if (!req.account.scheduler.setupRecurring(
            scheduled.id,
            cron_expression,
            scheduled.chat_id,
            scheduled.message,
            scheduled.template_id,
            scheduled.chat_name
        )) {
            req.account.db.scheduled.delete.run(scheduled.id);
            return res.status(400).json({ error: 'Invalid cron_expression' });
        }
    }
    res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/scheduled/:id', (req, res) => {
    const scheduledId = parseInt(req.params.id, 10);
    if (Number.isNaN(scheduledId)) {
        return res.status(400).json({ error: 'Invalid scheduled id' });
    }
    req.account.scheduler.removeRecurring(scheduledId);
    req.account.db.scheduled.delete.run(scheduledId);
    res.json({ success: true });
});

// ============ WEBHOOKS ============
router.get('/webhooks', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.webhooks.getAll.all());
});

router.post('/webhooks', requireRole(['admin']), (req, res) => {
    const { name, url, events, is_active } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL. Must be http or https.' });
    }
    const result = req.account.db.webhooks.create.run(name || 'Webhook', url, events || 'message', is_active !== false ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/webhooks/:id', requireRole(['admin']), (req, res) => {
    const { name, url, events, is_active } = req.body;
    if (url && !validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL. Must be http or https.' });
    }
    req.account.db.webhooks.update.run(name, url, events, is_active ? 1 : 0, req.params.id);
    res.json({ success: true });
});

router.delete('/webhooks/:id', requireRole(['admin']), (req, res) => {
    req.account.db.webhooks.delete.run(req.params.id);
    res.json({ success: true });
});

router.get('/webhooks/:id/deliveries', requireRole(['admin']), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, LIMITS.PAGINATION.WEBHOOK_DELIVERIES);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    res.json(req.account.db.webhookDeliveries.getByWebhookId.all(req.params.id, limit, offset));
});

router.post('/webhooks/deliveries/:id/replay', requireRole(['admin']), async (req, res) => {
    try {
        const delivery = req.account.db.webhookDeliveries.getById.get(req.params.id);
        if (!delivery) {
            return res.status(404).json({ error: 'Delivery not found' });
        }
        await req.account.webhook.replayDelivery(delivery);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ SCRIPTS ============
router.get('/scripts', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.scripts.getAll.all());
});

router.get('/scripts/:id', requireRole(['admin']), (req, res) => {
    const script = req.account.db.scripts.getById.get(req.params.id);
    if (!script) return res.status(404).json({ error: 'Not found' });
    res.json(script);
});

router.post('/scripts', requireRole(['admin']), (req, res) => {
    const { name, description, code, trigger_type, trigger_filter, is_active } = req.body;
    if (!name || !code) {
        return res.status(400).json({ error: 'name and code required' });
    }
    const filterJson = trigger_filter ? JSON.stringify(trigger_filter) : null;
    const result = req.account.db.scripts.create.run(name, description || '', code, trigger_type || 'message', filterJson, is_active !== false ? 1 : 0);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/scripts/:id', requireRole(['admin']), (req, res) => {
    const { name, description, code, trigger_type, trigger_filter, is_active } = req.body;
    const filterJson = trigger_filter ? JSON.stringify(trigger_filter) : null;
    req.account.db.scripts.update.run(name, description || '', code, trigger_type || 'message', filterJson, is_active ? 1 : 0, req.params.id);
    res.json({ success: true });
});

router.delete('/scripts/:id', requireRole(['admin']), (req, res) => {
    req.account.db.scripts.delete.run(req.params.id);
    res.json({ success: true });
});

router.post('/scripts/:id/toggle', requireRole(['admin']), (req, res) => {
    const script = req.account.db.scripts.getById.get(req.params.id);
    if (!script) return res.status(404).json({ error: 'Not found' });
    req.account.db.scripts.toggle.run(script.is_active ? 0 : 1, req.params.id);
    res.json({ success: true, is_active: !script.is_active });
});

router.post('/scripts/:id/run', requireRole(['admin']), async (req, res) => {
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

router.post('/scripts/test', requireRole(['admin']), async (req, res) => {
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

router.post('/ai/generate-script', requireRole(['admin']), async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }
        const script = await aiService.generateScript(prompt);
        res.json({ success: true, script });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/scripts/:id/logs', requireRole(['admin']), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, LIMITS.PAGINATION.SCRIPT_LOGS);
    res.json(req.account.db.scriptLogs.getByScript.all(req.params.id, limit));
});

// ============ TEMPLATES ============
router.get('/templates', (req, res) => {
    res.json(req.account.db.messageTemplates.getAll.all());
});

router.get('/templates/:id', (req, res) => {
    const template = req.account.db.messageTemplates.getById.get(req.params.id);
    if (!template) return res.status(404).json({ error: 'Not found' });
    res.json(template);
});

router.post('/templates', requireRole(['admin', 'manager']), (req, res) => {
    const { name, content, variables, category } = req.body;
    if (!name || !content) {
        return res.status(400).json({ error: 'name and content required' });
    }
    if (name.length > LIMITS.TEMPLATE_NAME_LENGTH) {
        return res.status(400).json({ error: 'Template name too long (max ' + LIMITS.TEMPLATE_NAME_LENGTH + ' chars)' });
    }
    if (!validateMessage(content)) {
        return res.status(400).json({ error: 'Template content too long or invalid' });
    }
    if (typeof variables === 'string' && variables.length > LIMITS.TEMPLATE_VARIABLES_LENGTH) {
        return res.status(400).json({ error: 'Variables list too long (max ' + LIMITS.TEMPLATE_VARIABLES_LENGTH + ' chars)' });
    }
    if (category && category.length > LIMITS.CATEGORY_LENGTH) {
        return res.status(400).json({ error: 'Category too long (max ' + LIMITS.CATEGORY_LENGTH + ' chars)' });
    }
    const normalizedVariables = normalizeTemplateVariables(variables);
    const variablesJson = normalizedVariables.length ? JSON.stringify(normalizedVariables) : null;
    const result = req.account.db.messageTemplates.create.run(name.trim(), content, variablesJson, category || null);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/templates/:id', requireRole(['admin', 'manager']), (req, res) => {
    const { name, content, variables, category } = req.body;
    if (!name || !content) {
        return res.status(400).json({ error: 'name and content required' });
    }
    if (name.length > LIMITS.TEMPLATE_NAME_LENGTH) {
        return res.status(400).json({ error: 'Template name too long (max ' + LIMITS.TEMPLATE_NAME_LENGTH + ' chars)' });
    }
    if (!validateMessage(content)) {
        return res.status(400).json({ error: 'Template content too long or invalid' });
    }
    if (typeof variables === 'string' && variables.length > LIMITS.TEMPLATE_VARIABLES_LENGTH) {
        return res.status(400).json({ error: 'Variables list too long (max ' + LIMITS.TEMPLATE_VARIABLES_LENGTH + ' chars)' });
    }
    if (category && category.length > LIMITS.CATEGORY_LENGTH) {
        return res.status(400).json({ error: 'Category too long (max ' + LIMITS.CATEGORY_LENGTH + ' chars)' });
    }
    const normalizedVariables = normalizeTemplateVariables(variables);
    const variablesJson = normalizedVariables.length ? JSON.stringify(normalizedVariables) : null;
    req.account.db.messageTemplates.update.run(name.trim(), content, variablesJson, category || null, req.params.id);
    res.json({ success: true });
});

router.delete('/templates/:id', requireRole(['admin', 'manager']), (req, res) => {
    req.account.db.messageTemplates.delete.run(req.params.id);
    res.json({ success: true });
});

// ============ LOGS ============
router.get('/logs', requireRole(['admin']), (req, res) => {
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

// ============ REPORTS ============
router.get('/reports/overview', (req, res) => {
    const range = parseDateRange(req.query);
    if (!range) {
        return res.status(400).json({ error: 'Invalid date range' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 5, 25);

    const overview = req.account.db.reports.getOverview.get(range.start, range.end) || {
        total: 0,
        sent: 0,
        received: 0,
        active_chats: 0
    };
    const topChats = req.account.db.reports.getTopChats.all(range.start, range.end, limit);

    res.json({
        range,
        overview,
        topChats
    });
});

router.get('/reports/trends', (req, res) => {
    const range = parseDateRange(req.query);
    if (!range) {
        return res.status(400).json({ error: 'Invalid date range' });
    }

    const interval = (req.query.interval || 'daily').toLowerCase();
    const points = interval === 'weekly'
        ? req.account.db.reports.getWeeklyTrend.all(range.start, range.end)
        : req.account.db.reports.getDailyTrend.all(range.start, range.end);

    res.json({
        range,
        interval: interval === 'weekly' ? 'weekly' : 'daily',
        points
    });
});

router.get('/reports/response-time', (req, res) => {
    const range = parseDateRange(req.query);
    if (!range) {
        return res.status(400).json({ error: 'Invalid date range' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 5, 25);
    const interval = (req.query.interval || 'daily').toLowerCase();

    const summary = req.account.db.reports.getResponseTimeSummary.get(range.start, range.end) || {
        responses: 0,
        avg_ms: null,
        min_ms: null,
        max_ms: null
    };
    const byChat = req.account.db.reports.getResponseTimeByChat.all(range.start, range.end, limit);
    const trend = interval === 'weekly'
        ? req.account.db.reports.getResponseTimeTrendWeekly.all(range.start, range.end)
        : req.account.db.reports.getResponseTimeTrendDaily.all(range.start, range.end);

    res.json({
        range,
        interval: interval === 'weekly' ? 'weekly' : 'daily',
        summary,
        byChat,
        trend
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

// ============ USERS & ROLES ============
router.get('/roles', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.roles.getAll.all());
});

router.post('/roles', requireRole(['admin']), (req, res) => {
    const name = (req.body?.name || '').trim().toLowerCase();
    const description = (req.body?.description || '').trim().slice(0, 120);
    if (!name) {
        return res.status(400).json({ error: 'Role name required' });
    }
    if (!/^[a-z0-9_-]{3,30}$/.test(name)) {
        return res.status(400).json({ error: 'Invalid role name' });
    }
    if (req.account.db.roles.getByName.get(name)) {
        return res.status(409).json({ error: 'Role already exists' });
    }
    const result = req.account.db.roles.create.run(name, description || null);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/roles/:id', requireRole(['admin']), (req, res) => {
    const roleId = parseInt(req.params.id, 10);
    if (Number.isNaN(roleId)) {
        return res.status(400).json({ error: 'Invalid role id' });
    }
    const assignedCount = req.account.db.userRoles.countByRole.get(roleId).count;
    if (assignedCount > 0) {
        return res.status(400).json({ error: 'Role is assigned to users' });
    }
    req.account.db.roles.delete.run(roleId);
    res.json({ success: true });
});

router.get('/users', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.users.getAll.all());
});

router.post('/users', requireRole(['admin']), (req, res) => {
    const username = (req.body?.username || '').trim().toLowerCase();
    const displayName = (req.body?.display_name || '').trim().slice(0, 80);
    const password = req.body?.password || '';
    const roleId = parseInt(req.body?.roleId, 10);

    if (!username || !password || Number.isNaN(roleId)) {
        return res.status(400).json({ error: 'username, password and roleId required' });
    }
    if (!/^[a-z0-9._-]{3,50}$/.test(username)) {
        return res.status(400).json({ error: 'Invalid username' });
    }
    if (!passwordMeetsPolicy(password, config.PASSWORD_POLICY)) {
        return res.status(400).json({ error: 'Password does not meet policy' });
    }
    if (req.account.db.users.getByUsername.get(username)) {
        return res.status(409).json({ error: 'Username already exists' });
    }
    const role = req.account.db.roles.getById.get(roleId);
    if (!role) {
        return res.status(404).json({ error: 'Role not found' });
    }

    const { hash, salt } = hashPassword(password);
    const result = req.account.db.users.create.run(username, displayName || username, hash, salt, 1);
    req.account.db.userRoles.assign.run(result.lastInsertRowid, roleId);
    res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/users/:id/role', requireRole(['admin']), (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const roleId = parseInt(req.body?.roleId, 10);
    if (Number.isNaN(userId) || Number.isNaN(roleId)) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    const role = req.account.db.roles.getById.get(roleId);
    if (!role) {
        return res.status(404).json({ error: 'Role not found' });
    }
    const user = req.account.db.users.getById.get(userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    req.account.db.userRoles.clear.run(userId);
    req.account.db.userRoles.assign.run(userId, roleId);
    res.json({ success: true });
});

router.delete('/users/:id', requireRole(['admin']), (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (Number.isNaN(userId)) {
        return res.status(400).json({ error: 'Invalid user id' });
    }
    if (req.session?.userId === userId) {
        return res.status(400).json({ error: 'Cannot delete active user' });
    }
    req.account.db.users.delete.run(userId);
    res.json({ success: true });
});

router.put('/users/me/preferences', (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const preferences = req.body;
    if (!preferences) {
        return res.status(400).json({ error: 'Preferences required' });
    }
    const preferencesJson = JSON.stringify(preferences);
    req.account.db.users.updatePreferences.run(preferencesJson, userId);
    res.json({ success: true });
});

module.exports = router;
