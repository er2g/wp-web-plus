const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { LIMITS } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

const booleanLike = z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (value === true || value === false) return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    return value;
}, z.boolean());

const intLike = (message) => z.preprocess(
    (value) => {
        if (value === undefined || value === null || value === '') return undefined;
        const parsed = parseInt(String(value), 10);
        return Number.isFinite(parsed) ? parsed : value;
    },
    z.number({
        required_error: message,
        invalid_type_error: message
    }).int().positive(message)
);

const nullableIntLike = () => z.preprocess(
    (value) => {
        if (value === undefined || value === '') return undefined;
        if (value === null) return null;
        const parsed = parseInt(String(value), 10);
        return Number.isFinite(parsed) ? parsed : value;
    },
    z.union([z.number().int().positive(), z.null()])
);

const matchTypeSchema = z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === 'startswith') return 'starts';
    if (normalized === 'endswith') return 'ends';
    return normalized;
}, z.enum(['contains', 'exact', 'starts', 'ends', 'regex']).optional());

const autoReplyCreateSchema = z.object({
    trigger_word: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'trigger_word and response or template_id required',
            invalid_type_error: 'trigger_word and response or template_id required'
        })
            .min(1, 'trigger_word and response or template_id required')
            .max(LIMITS.TRIGGER_LENGTH, 'Trigger word too long (max ' + LIMITS.TRIGGER_LENGTH + ' chars)')
    ),
    response: z.preprocess((value) => {
        if (value === undefined || value === null) return undefined;
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        return trimmed ? trimmed : undefined;
    }, z.string().max(LIMITS.MESSAGE_LENGTH, 'Response too long (max ' + LIMITS.MESSAGE_LENGTH + ' chars)').optional()),
    template_id: nullableIntLike().optional(),
    match_type: matchTypeSchema,
    is_active: booleanLike.optional(),
    required_tag_id: nullableIntLike().optional(),
    exclude_tag_id: nullableIntLike().optional()
}).strict().superRefine((data, ctx) => {
    if (!data.response && !data.template_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'trigger_word and response or template_id required',
            path: []
        });
    }
    if (data.match_type === 'regex') {
        try {
            new RegExp(data.trigger_word);
        } catch (e) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Invalid regular expression',
                path: ['trigger_word']
            });
        }
    }
});

router.get('/', (req, res) => {
    return res.json(req.account.db.autoReplies.getAll.all());
});

router.post('/', requireRole(['admin', 'manager']), validate({ body: autoReplyCreateSchema }), (req, res) => {
    const { trigger_word, response, template_id, match_type, is_active, required_tag_id, exclude_tag_id } = req.validatedBody;

    if (template_id) {
        const template = req.account.db.messageTemplates.getById.get(template_id);
        if (!template) {
            return sendError(req, res, 404, 'Template not found');
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
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id', requireRole(['admin', 'manager']), validate({ body: autoReplyCreateSchema }), (req, res) => {
    const existing = req.account.db.autoReplies.getById.get(req.params.id);
    if (!existing) {
        return sendError(req, res, 404, 'Not found');
    }

    const { trigger_word, response, template_id, match_type, is_active, required_tag_id, exclude_tag_id } = req.validatedBody;

    if (template_id) {
        const template = req.account.db.messageTemplates.getById.get(template_id);
        if (!template) {
            return sendError(req, res, 404, 'Template not found');
        }
    }

    const resolvedTemplateId = template_id === undefined ? existing.template_id : (template_id || null);
    const resolvedRequiredTagId = required_tag_id === undefined ? existing.required_tag_id : (required_tag_id || null);
    const resolvedExcludeTagId = exclude_tag_id === undefined ? existing.exclude_tag_id : (exclude_tag_id || null);
    const resolvedMatchType = match_type || existing.match_type || 'contains';
    const resolvedIsActive = is_active === undefined ? existing.is_active : (is_active ? 1 : 0);

    req.account.db.autoReplies.update.run(
        trigger_word,
        response || existing.response || '',
        resolvedTemplateId,
        resolvedMatchType,
        resolvedIsActive,
        resolvedRequiredTagId,
        resolvedExcludeTagId,
        req.params.id
    );
    return res.json({ success: true });
});

router.delete('/:id', requireRole(['admin', 'manager']), (req, res) => {
    req.account.db.autoReplies.delete.run(req.params.id);
    return res.json({ success: true });
});

router.post('/:id/toggle', requireRole(['admin', 'manager']), (req, res) => {
    const reply = req.account.db.autoReplies.getById.get(req.params.id);
    if (!reply) return sendError(req, res, 404, 'Not found');
    req.account.db.autoReplies.toggle.run(reply.is_active ? 0 : 1, req.params.id);
    return res.json({ success: true, is_active: !reply.is_active });
});

module.exports = router;
