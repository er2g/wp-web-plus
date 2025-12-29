const express = require('express');

const router = express.Router();
const { z } = require('zod');

const { validate } = require('../middleware/validate');
const { validateChatId, validateMessage } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

const booleanLike = z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (value === true || value === false) return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    return value;
}, z.boolean());

const scheduleCreateSchema = z.object({
    chat_id: z.string()
        .trim()
        .min(1, 'chat_id, message or template_id, and scheduled_at required')
        .refine(validateChatId, { message: 'Invalid chat_id format' }),
    chat_name: z.preprocess((value) => (typeof value === 'string' ? value.trim() : value), z.string()).optional(),
    message: z.preprocess((value) => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        return trimmed ? trimmed : undefined;
    }, z.string().refine(validateMessage, { message: 'Message too long or invalid' }).optional()),
    template_id: z.preprocess((value) => {
        if (value === null || value === undefined || value === '') return undefined;
        const parsed = parseInt(String(value), 10);
        return Number.isFinite(parsed) ? parsed : value;
    }, z.number().int().positive().optional()),
    scheduled_at: z.string().trim().min(1, 'chat_id, message or template_id, and scheduled_at required'),
    is_recurring: booleanLike.optional(),
    cron_expression: z.preprocess((value) => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        return trimmed ? trimmed : undefined;
    }, z.string().optional())
}).strict().superRefine((data, ctx) => {
    if (!data.message && !data.template_id) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'chat_id, message or template_id, and scheduled_at required',
            path: []
        });
    }
    if (data.is_recurring && !data.cron_expression) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'cron_expression required for recurring schedule',
            path: ['cron_expression']
        });
    }
});

router.get('/', (req, res) => {
    res.json(req.account.db.scheduled.getAll.all());
});

router.post('/', validate({ body: scheduleCreateSchema }), (req, res) => {
    const { chat_id, chat_name, message, template_id, scheduled_at, is_recurring, cron_expression } = req.validatedBody;

    let resolvedMessage = message || '';
    if (template_id) {
        const template = req.account.db.messageTemplates.getById.get(template_id);
        if (!template) {
            return sendError(req, res, 404, 'Template not found');
        }
        if (!resolvedMessage) {
            resolvedMessage = template.content;
        }
    }

    if (is_recurring && !cron_expression) {
        return sendError(req, res, 400, 'cron_expression required for recurring schedule');
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
            return sendError(req, res, 400, 'Invalid cron_expression');
        }
    }

    return res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/:id', (req, res) => {
    const scheduledId = parseInt(req.params.id, 10);
    if (Number.isNaN(scheduledId)) {
        return sendError(req, res, 400, 'Invalid scheduled id');
    }
    req.account.scheduler.removeRecurring(scheduledId);
    req.account.db.scheduled.delete.run(scheduledId);
    return res.json({ success: true });
});

module.exports = router;
