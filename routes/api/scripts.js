const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { LIMITS } = require('../../lib/apiValidation');
const { queryLimit } = require('../../lib/zodHelpers');
const { sendError } = require('../../lib/httpResponses');

const booleanLike = z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (value === true || value === false) return value;
    if (value === 1 || value === '1' || value === 'true') return true;
    if (value === 0 || value === '0' || value === 'false') return false;
    return value;
}, z.boolean());

const scriptUpsertSchema = z.object({
    name: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'name and code required',
            invalid_type_error: 'name and code required'
        }).min(1, 'name and code required')
    ),
    description: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim().slice(0, 500) : value),
        z.string().optional()
    ),
    code: z.string({
        required_error: 'name and code required',
        invalid_type_error: 'name and code required'
    }).min(1, 'name and code required'),
    trigger_type: z.preprocess((value) => {
        if (value === undefined || value === null) return undefined;
        if (typeof value !== 'string') return value;
        const normalized = value.trim().toLowerCase();
        return normalized ? normalized : undefined;
    }, z.enum(['message', 'ready', 'manual']).optional()),
    trigger_filter: z.union([z.record(z.any()), z.null()]).optional(),
    is_active: booleanLike.optional()
}).strict();

const scriptTestSchema = z.object({
    code: z.string().trim().min(1, 'code required'),
    testData: z.record(z.any()).optional()
}).strict();

const scriptLogsQuerySchema = z.object({
    limit: queryLimit({ defaultValue: 50, max: LIMITS.PAGINATION.SCRIPT_LOGS })
});

router.get('/', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.scripts.getAll.all());
});

router.get('/:id', requireRole(['admin']), (req, res) => {
    const script = req.account.db.scripts.getById.get(req.params.id);
    if (!script) return sendError(req, res, 404, 'Not found');
    return res.json(script);
});

router.post('/', requireRole(['admin']), validate({ body: scriptUpsertSchema }), (req, res) => {
    const { name, description, code, trigger_type, trigger_filter, is_active } = req.validatedBody;
    const filterJson = trigger_filter ? JSON.stringify(trigger_filter) : null;
    const result = req.account.db.scripts.create.run(
        name,
        description || '',
        code,
        trigger_type || 'message',
        filterJson,
        is_active !== false ? 1 : 0
    );
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id', requireRole(['admin']), validate({ body: scriptUpsertSchema }), (req, res) => {
    const existing = req.account.db.scripts.getById.get(req.params.id);
    if (!existing) {
        return sendError(req, res, 404, 'Not found');
    }

    const { name, description, code, trigger_type, trigger_filter, is_active } = req.validatedBody;

    const resolvedTriggerType = trigger_type || existing.trigger_type || 'message';
    const resolvedDescription = description === undefined ? (existing.description || '') : description;
    const resolvedFilterJson = trigger_filter === undefined
        ? existing.trigger_filter
        : trigger_filter === null
            ? null
            : JSON.stringify(trigger_filter);
    const resolvedIsActive = is_active === undefined ? existing.is_active : (is_active ? 1 : 0);

    req.account.db.scripts.update.run(
        name,
        resolvedDescription,
        code,
        resolvedTriggerType,
        resolvedFilterJson,
        resolvedIsActive,
        req.params.id
    );
    return res.json({ success: true });
});

router.delete('/:id', requireRole(['admin']), (req, res) => {
    req.account.db.scripts.delete.run(req.params.id);
    return res.json({ success: true });
});

router.post('/:id/toggle', requireRole(['admin']), (req, res) => {
    const script = req.account.db.scripts.getById.get(req.params.id);
    if (!script) return sendError(req, res, 404, 'Not found');
    req.account.db.scripts.toggle.run(script.is_active ? 0 : 1, req.params.id);
    return res.json({ success: true, is_active: !script.is_active });
});

router.post('/:id/run', requireRole(['admin']), async (req, res) => {
    const script = req.account.db.scripts.getById.get(req.params.id);
    if (!script) return sendError(req, res, 404, 'Not found');

    const testData = req.body.testData || {
        chatId: 'test@c.us',
        from: 'test@c.us',
        body: 'Test message',
        isFromMe: false,
        isGroup: false
    };

    const result = await req.account.scriptRunner.runScript(script, testData);
    return res.json(result);
});

router.post('/test', requireRole(['admin']), validate({ body: scriptTestSchema }), async (req, res) => {
    const { code, testData } = req.validatedBody;

    const data = testData || {
        chatId: 'test@c.us',
        from: 'test@c.us',
        body: 'Test message',
        isFromMe: false,
        isGroup: false
    };

    const result = await req.account.scriptRunner.testScript(code, data);
    return res.json(result);
});

router.get('/:id/logs', requireRole(['admin']), validate({ query: scriptLogsQuerySchema }), (req, res) => {
    const { limit } = req.validatedQuery;
    return res.json(req.account.db.scriptLogs.getByScript.all(req.params.id, limit));
});

module.exports = router;
