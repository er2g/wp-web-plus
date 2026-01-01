const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { LIMITS } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');
const { queryLimit, queryOffset, queryString } = require('../../lib/zodHelpers');
const { validate } = require('../middleware/validate');

const listQuerySchema = z.object({
    limit: queryLimit({ defaultValue: 100, max: LIMITS.PAGINATION.MESSAGES }),
    offset: queryOffset({ defaultValue: 0 })
});

const searchQuerySchema = z.object({
    q: queryString({ defaultValue: '', maxLength: LIMITS.QUERY_LENGTH })
});

const messageIdParamSchema = z.object({
    id: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({ required_error: 'Invalid message id', invalid_type_error: 'Invalid message id' })
            .min(1, 'Invalid message id')
            .max(300, 'Invalid message id')
    )
}).strict();

router.get('/', validate({ query: listQuerySchema }), (req, res) => {
    const { limit, offset } = req.validatedQuery;
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

    return res.json({ messages, tagsByChat, notesByChat });
});

router.get('/search', validate({ query: searchQuerySchema }), (req, res) => {
    const query = req.validatedQuery.q;
    if (!query) return res.json([]);
    return res.json(req.account.db.messages.search.all('%' + query + '%'));
});

router.post('/:id/revoke', validate({ params: messageIdParamSchema }), async (req, res) => {
    try {
        const messageId = req.validatedParams.id;
        const result = await req.account.whatsapp.revokeMessageForEveryone(messageId);
        return res.json(result || { success: true, messageId });
    } catch (error) {
        const message = error?.message || String(error);
        const status = [
            'WhatsApp not connected',
            'Invalid message id',
            'Message not found',
            'herkesten silinemiyor'
        ].some((needle) => message.includes(needle)) ? 400 : 500;
        return sendError(req, res, status, message);
    }
});

module.exports = router;
