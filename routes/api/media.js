const express = require('express');
const router = express.Router();
const { z } = require('zod');

const fs = require('fs');
const path = require('path');
const { LIMITS, validateChatId } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');
const { queryLimit, queryOffset, queryString } = require('../../lib/zodHelpers');
const { validate } = require('../middleware/validate');

const booleanLike = z.preprocess((value) => {
    const firstValue = Array.isArray(value) ? value[0] : value;
    if (firstValue === undefined || firstValue === null || firstValue === '') return undefined;
    if (firstValue === true || firstValue === false) return firstValue;
    if (firstValue === 1 || firstValue === '1' || firstValue === 'true') return true;
    if (firstValue === 0 || firstValue === '0' || firstValue === 'false') return false;
    return firstValue;
}, z.boolean());

const chatIdQuerySchema = z.preprocess(
    (value) => {
        const firstValue = Array.isArray(value) ? value[0] : value;
        if (firstValue === undefined || firstValue === null || firstValue === '') return undefined;
        return typeof firstValue === 'string' ? firstValue.trim() : String(firstValue).trim();
    },
    z.string({ invalid_type_error: 'Invalid chatId format' })
        .refine(validateChatId, { message: 'Invalid chatId format' })
        .optional()
);

const kindQuerySchema = z.preprocess(
    (value) => {
        const firstValue = Array.isArray(value) ? value[0] : value;
        if (firstValue === undefined || firstValue === null || firstValue === '') return undefined;
        return typeof firstValue === 'string' ? firstValue.trim() : String(firstValue).trim();
    },
    z.enum(['all', 'image', 'video', 'document', 'audio', 'sticker', 'other']).catch('all')
);

const mediaItemsQuerySchema = z.object({
    chatId: chatIdQuerySchema,
    kind: kindQuerySchema.optional().default('all'),
    downloaded: booleanLike.optional(),
    q: queryString({ defaultValue: '', maxLength: LIMITS.QUERY_LENGTH, trim: true }),
    limit: queryLimit({ defaultValue: 80, max: 200 }),
    offset: queryOffset({ defaultValue: 0 })
});

const enqueueBodySchema = z.object({
    messageId: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'messageId required',
            invalid_type_error: 'messageId required'
        })
            .min(1, 'messageId required')
            .max(300, 'Invalid message id')
    )
}).strict();

router.post('/download-all', async (req, res) => {
    try {
        const result = await req.account.whatsapp.enqueueMissingMediaAll();
        return res.json({
            success: true,
            ...result,
            message: 'Tum sohbetlerde eksik medyalar indirme kuyruguna eklendi.'
        });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

router.get('/items', validate({ query: mediaItemsQuerySchema }), (req, res) => {
    const { chatId, kind, downloaded, q, limit, offset } = req.validatedQuery;

    const where = [];
    const params = [];

    where.push(`(m.type IS NULL OR m.type != 'revoked')`);
    where.push(`(m.is_deleted_for_everyone IS NULL OR m.is_deleted_for_everyone = 0)`);
    where.push(`(
        (m.media_url IS NOT NULL AND m.media_url != '')
        OR (m.media_path IS NOT NULL AND m.media_path != '')
        OR (m.media_mimetype IS NOT NULL AND m.media_mimetype != '')
        OR (m.type IN ('image','gif','video','document','audio','ptt','sticker'))
    )`);

    if (chatId) {
        where.push('m.chat_id = ?');
        params.push(chatId);
    }

    if (typeof downloaded === 'boolean') {
        if (downloaded) {
            where.push(`(
                (m.media_url IS NOT NULL AND m.media_url != '')
                OR (m.media_path IS NOT NULL AND m.media_path != '')
            )`);
        } else {
            where.push(`(
                (m.media_url IS NULL OR m.media_url = '')
                AND (m.media_path IS NULL OR m.media_path = '')
            )`);
        }
    }

    if (q) {
        where.push(`(
            COALESCE(c.name, '') LIKE ?
            OR COALESCE(m.body, '') LIKE ?
            OR COALESCE(m.chat_id, '') LIKE ?
        )`);
        const needle = '%' + q + '%';
        params.push(needle, needle, needle);
    }

    const knownTypes = ['image', 'gif', 'video', 'document', 'audio', 'ptt', 'sticker'];
    if (kind && kind !== 'all') {
        if (kind === 'image') {
            where.push(`(m.type IN ('image','gif') OR (m.media_mimetype LIKE 'image/%' AND (m.type IS NULL OR m.type != 'sticker')))`);
        } else if (kind === 'video') {
            where.push(`(m.type = 'video' OR m.media_mimetype LIKE 'video/%')`);
        } else if (kind === 'audio') {
            where.push(`(m.type IN ('audio','ptt') OR m.media_mimetype LIKE 'audio/%')`);
        } else if (kind === 'document') {
            where.push(`(m.type = 'document')`);
        } else if (kind === 'sticker') {
            where.push(`(m.type = 'sticker')`);
        } else if (kind === 'other') {
            where.push(`(m.type IS NULL OR m.type = '' OR m.type NOT IN (${knownTypes.map(() => '?').join(',')}))`);
            params.push(...knownTypes);
        }
    }

    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const effectiveLimit = Math.min(201, Number(limit) + 1);

    const rows = req.account.db.db.prepare(`
        SELECT
            m.message_id,
            m.chat_id,
            COALESCE(c.name, m.chat_id) AS chat_name,
            COALESCE(c.is_group, 0) AS chat_is_group,
            COALESCE(c.is_archived, 0) AS chat_is_archived,
            m.type,
            m.body,
            m.timestamp,
            m.media_url,
            m.media_mimetype,
            CASE
                WHEN (m.media_url IS NOT NULL AND m.media_url != '') OR (m.media_path IS NOT NULL AND m.media_path != '') THEN 1
                ELSE 0
            END AS is_downloaded
        FROM messages m
        LEFT JOIN chats c ON c.chat_id = m.chat_id
        ${whereSql}
        ORDER BY m.timestamp DESC
        LIMIT ? OFFSET ?
    `).all(...params, effectiveLimit, offset);

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;

    const items = trimmed.map((row) => {
        const normalizedType = row.type || '';
        let normalizedKind = 'other';
        if (['image', 'gif'].includes(normalizedType)) normalizedKind = 'image';
        else if (normalizedType === 'video') normalizedKind = 'video';
        else if (normalizedType === 'document') normalizedKind = 'document';
        else if (['audio', 'ptt'].includes(normalizedType)) normalizedKind = 'audio';
        else if (normalizedType === 'sticker') normalizedKind = 'sticker';
        else if (typeof row.media_mimetype === 'string') {
            const mm = row.media_mimetype.toLowerCase();
            if (mm.startsWith('image/')) normalizedKind = 'image';
            else if (mm.startsWith('video/')) normalizedKind = 'video';
            else if (mm.startsWith('audio/')) normalizedKind = 'audio';
            else normalizedKind = 'document';
        }

        return {
            message_id: row.message_id,
            chat_id: row.chat_id,
            chat_name: row.chat_name,
            chat_is_group: row.chat_is_group,
            chat_is_archived: row.chat_is_archived,
            type: normalizedType,
            kind: normalizedKind,
            body: row.body,
            timestamp: row.timestamp,
            media_url: row.media_url,
            media_mimetype: row.media_mimetype,
            is_downloaded: row.is_downloaded
        };
    });

    return res.json({ items, hasMore });
});

router.post('/enqueue', validate({ body: enqueueBodySchema }), (req, res) => {
    try {
        const messageId = req.validatedBody.messageId;
        const enqueued = Boolean(req.account?.whatsapp?.enqueueMediaDownload?.(messageId));
        return res.json({ success: true, enqueued });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

router.get('/:filename', (req, res) => {
    const filename = req.params.filename;

    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\') ||
        filename.includes('\0') || filename.includes('%') || filename.includes(':')) {
        return sendError(req, res, 400, 'Invalid filename');
    }

    if (!/^[\p{L}\p{N} _.\-()]+$/u.test(filename)) {
        return sendError(req, res, 400, 'Invalid filename characters');
    }

    const filePath = path.join(req.account.config.MEDIA_DIR, filename);

    const resolvedPath = path.resolve(filePath);
    const resolvedMediaDir = path.resolve(req.account.config.MEDIA_DIR);
    if (!resolvedPath.startsWith(resolvedMediaDir + path.sep)) {
        return sendError(req, res, 400, 'Invalid file path');
    }

    if (!fs.existsSync(filePath)) {
        return sendError(req, res, 404, 'File not found');
    }
    return res.sendFile(filePath);
});

module.exports = router;
