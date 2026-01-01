const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { LIMITS, validateChatId, validateNote } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');
const { queryLimit, queryOffset, queryString } = require('../../lib/zodHelpers');
const { validate } = require('../middleware/validate');

const booleanLike = z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === true || value === false) return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    return value;
}, z.boolean());

const intLike = (message) => z.preprocess(
    (value) => {
        if (value === undefined || value === null || value === '') return value;
        const parsed = parseInt(String(value), 10);
        return Number.isFinite(parsed) ? parsed : value;
    },
    z.number({
        required_error: message,
        invalid_type_error: message
    }).int().positive(message)
);

const chatIdParamSchema = z.object({
    id: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'Invalid chatId format',
            invalid_type_error: 'Invalid chatId format'
        }).refine(validateChatId, { message: 'Invalid chatId format' })
    )
}).strict();

const tagIdBodySchema = z.object({
    tag_id: intLike('tag_id required')
}).strict();

const noteBodySchema = z.object({
    content: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'content required',
            invalid_type_error: 'content required'
        })
            .min(1, 'content required')
            .refine(validateNote, { message: 'Note too long' })
    )
}).strict();

const noteParamsSchema = z.object({
    id: chatIdParamSchema.shape.id,
    noteId: intLike('Invalid note id')
}).strict();

const chatSearchQuerySchema = z.object({
    q: queryString({ defaultValue: '', maxLength: LIMITS.QUERY_LENGTH, trim: true }),
    tag: queryString({ defaultValue: '', maxLength: LIMITS.QUERY_LENGTH, trim: true }),
    note: queryString({ defaultValue: '', maxLength: LIMITS.QUERY_LENGTH, trim: true }),
    archived: booleanLike.optional().default(false),
    limit: queryLimit({ defaultValue: 50, max: LIMITS.PAGINATION.MESSAGES }),
    offset: queryOffset({ defaultValue: 0 })
});

const paginationQuerySchema = z.object({
    limit: queryLimit({ defaultValue: 50, max: LIMITS.PAGINATION.MESSAGES }),
    offset: queryOffset({ defaultValue: 0 })
});

const tagParamsSchema = z.object({
    id: chatIdParamSchema.shape.id,
    tagId: intLike('Invalid tag id')
}).strict();

router.get('/', (req, res) => {
    const tagFilter = (req.query.tag || '').trim();
    const archivedQuery = req.query.archived;
    const archived = archivedQuery === true || archivedQuery === 1
        || (typeof archivedQuery === 'string' && ['1', 'true'].includes(archivedQuery.trim().toLowerCase()));
    const archivedFlag = archived ? 1 : 0;

    if (!tagFilter) {
        const list = archived ? req.account.db.chats.getArchived.all() : req.account.db.chats.getActive.all();
        return res.json(list);
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
        `SELECT * FROM chats WHERE is_archived = ? AND chat_id IN (${placeholders}) ORDER BY last_message_at DESC`
    ).all(archivedFlag, ...chatIds);
    return res.json(chats);
});

router.get('/search', validate({ query: chatSearchQuerySchema }), (req, res) => {
    const { q: query, tag: tagFilter, note: noteQuery, archived, limit, offset } = req.validatedQuery;
    const archivedFlag = archived ? 1 : 0;

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
        const results = req.account.db.db.prepare(`
            SELECT * FROM chats
            WHERE is_archived = ?
              AND name LIKE ?
            ORDER BY last_message_at DESC
            LIMIT ? OFFSET ?
        `).all(archivedFlag, '%' + query + '%', limit, offset);
        return res.json(results);
    }

    const filterIds = chatIds ? Array.from(chatIds) : null;
    if (query) {
        const placeholders = filterIds ? filterIds.map(() => '?').join(',') : '';
        const params = [archivedFlag, '%' + query + '%'];
        if (filterIds) {
            params.push(...filterIds);
        }
        params.push(limit, offset);
        const results = req.account.db.db.prepare(`
            SELECT * FROM chats
            WHERE is_archived = ?
              AND name LIKE ?
              ${filterIds ? `AND chat_id IN (${placeholders})` : ''}
            ORDER BY last_message_at DESC
            LIMIT ? OFFSET ?
        `).all(...params);
        return res.json(results);
    }

    const placeholders = filterIds.map(() => '?').join(',');
    const results = req.account.db.db.prepare(`
        SELECT * FROM chats
        WHERE is_archived = ?
          AND chat_id IN (${placeholders})
        ORDER BY last_message_at DESC
        LIMIT ? OFFSET ?
    `).all(archivedFlag, ...filterIds, limit, offset);
    return res.json(results);
});

router.post('/:id/archive', validate({ params: chatIdParamSchema }), async (req, res) => {
    const chatId = req.validatedParams.id;
    const chat = req.account.db.chats.getById.get(chatId);
    if (!chat) {
        return sendError(req, res, 404, 'Chat not found');
    }

    req.account.db.chats.setArchived.run(1, chatId);

    if (typeof req.account.whatsapp.archiveChat === 'function') {
        try {
            await req.account.whatsapp.archiveChat(chatId);
        } catch (error) {
            req.log?.warn?.('WhatsApp archive failed', { chatId, error: error.message });
        }
    }

    return res.json({ success: true });
});

router.post('/:id/unarchive', validate({ params: chatIdParamSchema }), async (req, res) => {
    const chatId = req.validatedParams.id;
    const chat = req.account.db.chats.getById.get(chatId);
    if (!chat) {
        return sendError(req, res, 404, 'Chat not found');
    }

    req.account.db.chats.setArchived.run(0, chatId);

    if (typeof req.account.whatsapp.unarchiveChat === 'function') {
        try {
            await req.account.whatsapp.unarchiveChat(chatId);
        } catch (error) {
            req.log?.warn?.('WhatsApp unarchive failed', { chatId, error: error.message });
        }
    }

    return res.json({ success: true });
});

router.get('/:id/messages', validate({ params: chatIdParamSchema, query: paginationQuerySchema }), async (req, res) => {
    const { limit, offset } = req.validatedQuery;
    const chatId = req.validatedParams.id;

    if (offset === 0 && req.account?.whatsapp?.isReady?.()) {
        try {
            await req.account.whatsapp.ensureChatCaughtUp(chatId, { limit: Math.max(250, limit) });
        } catch (error) {
            req.log?.warn?.('Chat catch-up sync failed', { chatId, error: error.message });
        }
    }

    const messages = req.account.db.messages.getByChatId.all(chatId, limit, offset);
    const tags = req.account.db.contactTags.getByChatId.all(chatId);
    const notes = req.account.db.notes.getByChatId.all(chatId);
    return res.json({ messages, tags, notes });
});

router.get('/:id/tags', validate({ params: chatIdParamSchema }), (req, res) => {
    return res.json(req.account.db.contactTags.getByChatId.all(req.validatedParams.id));
});

router.post('/:id/tags', validate({ params: chatIdParamSchema, body: tagIdBodySchema }), (req, res) => {
    const chatId = req.validatedParams.id;
    const tagId = req.validatedBody.tag_id;
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

router.delete('/:id/tags/:tagId', validate({ params: tagParamsSchema }), (req, res) => {
    req.account.db.contactTags.remove.run(req.validatedParams.id, req.validatedParams.tagId);
    return res.json({ success: true });
});

router.get('/:id/notes', validate({ params: chatIdParamSchema }), (req, res) => {
    return res.json(req.account.db.notes.getByChatId.all(req.validatedParams.id));
});

router.post('/:id/notes', validate({ params: chatIdParamSchema, body: noteBodySchema }), (req, res) => {
    req.account.db.notes.create.run(req.validatedParams.id, req.validatedBody.content);
    return res.json({ success: true });
});

router.put('/:id/notes/:noteId', validate({ params: noteParamsSchema, body: noteBodySchema }), (req, res) => {
    req.account.db.notes.update.run(req.validatedBody.content, req.validatedParams.noteId, req.validatedParams.id);
    return res.json({ success: true });
});

router.delete('/:id/notes/:noteId', validate({ params: noteParamsSchema }), (req, res) => {
    req.account.db.notes.delete.run(req.validatedParams.noteId, req.validatedParams.id);
    return res.json({ success: true });
});

router.post('/:id/refresh-picture', validate({ params: chatIdParamSchema }), async (req, res) => {
    try {
        const result = await req.account.whatsapp.refreshChatPicture(req.validatedParams.id);
        if (!result.success) {
            return sendError(req, res, 500, result.error);
        }
        return res.json({ success: true, url: result.url });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

router.post('/:id/force-media', validate({ params: chatIdParamSchema }), async (req, res) => {
    try {
        // Run in background to avoid timeout
        req.account.whatsapp.forceDownloadChatMedia(req.validatedParams.id)
            .then(result => {
                req.log.info('Media recovery completed', result);
            })
            .catch(err => {
                req.log.error('Media recovery failed', { error: err.message });
            });

        return res.json({ success: true, message: 'Medya kurtarma islemi arka planda baslatildi. Dosyalar indikce ekrana dusecektir.' });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

module.exports = router;
