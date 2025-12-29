const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { LIMITS } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

const scriptTestSchema = z.object({
    code: z.string().trim().min(1, 'code required'),
    testData: z.record(z.any()).optional()
}).strict();

router.get('/', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.scripts.getAll.all());
});

router.get('/:id', requireRole(['admin']), (req, res) => {
    const script = req.account.db.scripts.getById.get(req.params.id);
    if (!script) return sendError(req, res, 404, 'Not found');
    return res.json(script);
});

router.post('/', requireRole(['admin']), (req, res) => {
    const { name, description, code, trigger_type, trigger_filter, is_active } = req.body;
    if (!name || !code) {
        return sendError(req, res, 400, 'name and code required');
    }
    const filterJson = trigger_filter ? JSON.stringify(trigger_filter) : null;
    const result = req.account.db.scripts.create.run(name, description || '', code, trigger_type || 'message', filterJson, is_active !== false ? 1 : 0);
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id', requireRole(['admin']), (req, res) => {
    const { name, description, code, trigger_type, trigger_filter, is_active } = req.body;
    const filterJson = trigger_filter ? JSON.stringify(trigger_filter) : null;
    req.account.db.scripts.update.run(name, description || '', code, trigger_type || 'message', filterJson, is_active ? 1 : 0, req.params.id);
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

router.get('/:id/logs', requireRole(['admin']), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, LIMITS.PAGINATION.SCRIPT_LOGS);
    res.json(req.account.db.scriptLogs.getByScript.all(req.params.id, limit));
});

module.exports = router;
