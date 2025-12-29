const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { LIMITS } = require('../../lib/apiValidation');

router.get('/', requireRole(['admin']), (req, res) => {
    res.json(req.account.db.scripts.getAll.all());
});

router.get('/:id', requireRole(['admin']), (req, res) => {
    const script = req.account.db.scripts.getById.get(req.params.id);
    if (!script) return res.status(404).json({ error: 'Not found' });
    return res.json(script);
});

router.post('/', requireRole(['admin']), (req, res) => {
    const { name, description, code, trigger_type, trigger_filter, is_active } = req.body;
    if (!name || !code) {
        return res.status(400).json({ error: 'name and code required' });
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
    if (!script) return res.status(404).json({ error: 'Not found' });
    req.account.db.scripts.toggle.run(script.is_active ? 0 : 1, req.params.id);
    return res.json({ success: true, is_active: !script.is_active });
});

router.post('/:id/run', requireRole(['admin']), async (req, res) => {
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
    return res.json(result);
});

router.post('/test', requireRole(['admin']), async (req, res) => {
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
    return res.json(result);
});

router.get('/:id/logs', requireRole(['admin']), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, LIMITS.PAGINATION.SCRIPT_LOGS);
    res.json(req.account.db.scriptLogs.getByScript.all(req.params.id, limit));
});

module.exports = router;

