const express = require('express');
const router = express.Router();

const { LIMITS, validateChatId, validateNote } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

router.get('/', (req, res) => {
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
    return res.json(chats);
});

router.get('/search', (req, res) => {
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
    return res.json(results);
});

router.get('/:id/messages', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, LIMITS.PAGINATION.MESSAGES);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const messages = req.account.db.messages.getByChatId.all(req.params.id, limit, offset);
    const tags = req.account.db.contactTags.getByChatId.all(req.params.id);
    const notes = req.account.db.notes.getByChatId.all(req.params.id);
    return res.json({ messages, tags, notes });
});

router.get('/:id/tags', (req, res) => {
    return res.json(req.account.db.contactTags.getByChatId.all(req.params.id));
});

router.post('/:id/tags', (req, res) => {
    const chatId = req.params.id;
    const tagId = req.body?.tag_id;
    if (!tagId) {
        return sendError(req, res, 400, 'tag_id required');
    }
    if (!validateChatId(chatId)) {
        return sendError(req, res, 400, 'Invalid chatId format');
    }
    const tag = req.account.db.tags.getById.get(tagId);
    if (!tag) {
        return sendError(req, res, 404, 'Tag not found');
    }
    const chat = req.account.db.chats.getById.get(chatId);
    const name = chat?.name || chatId;
    const phone = chatId && chatId.includes('@c.us') ? chatId.split('@')[0] : null;
    req.account.db.contacts.upsert.run(chatId, name, phone);
    req.account.db.contactTags.add.run(chatId, tagId);
    return res.json({ success: true });
});

router.delete('/:id/tags/:tagId', (req, res) => {
    req.account.db.contactTags.remove.run(req.params.id, req.params.tagId);
    return res.json({ success: true });
});

router.get('/:id/notes', (req, res) => {
    return res.json(req.account.db.notes.getByChatId.all(req.params.id));
});

router.post('/:id/notes', (req, res) => {
    const content = (req.body?.content || '').trim();
    if (!content) {
        return sendError(req, res, 400, 'content required');
    }
    if (!validateNote(content)) {
        return sendError(req, res, 400, 'Note too long');
    }
    if (!validateChatId(req.params.id)) {
        return sendError(req, res, 400, 'Invalid chatId format');
    }
    req.account.db.notes.create.run(req.params.id, content);
    return res.json({ success: true });
});

router.put('/:id/notes/:noteId', (req, res) => {
    const content = (req.body?.content || '').trim();
    if (!content) {
        return sendError(req, res, 400, 'content required');
    }
    if (!validateNote(content)) {
        return sendError(req, res, 400, 'Note too long');
    }
    req.account.db.notes.update.run(content, req.params.noteId, req.params.id);
    return res.json({ success: true });
});

router.delete('/:id/notes/:noteId', (req, res) => {
    req.account.db.notes.delete.run(req.params.noteId, req.params.id);
    return res.json({ success: true });
});

module.exports = router;
