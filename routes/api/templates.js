const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { LIMITS, validateMessage, normalizeTemplateVariables } = require('../../lib/apiValidation');

router.get('/', (req, res) => {
    res.json(req.account.db.messageTemplates.getAll.all());
});

router.get('/:id', (req, res) => {
    const template = req.account.db.messageTemplates.getById.get(req.params.id);
    if (!template) return res.status(404).json({ error: 'Not found' });
    return res.json(template);
});

router.post('/', requireRole(['admin', 'manager']), (req, res) => {
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
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id', requireRole(['admin', 'manager']), (req, res) => {
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
    return res.json({ success: true });
});

router.delete('/:id', requireRole(['admin', 'manager']), (req, res) => {
    req.account.db.messageTemplates.delete.run(req.params.id);
    return res.json({ success: true });
});

module.exports = router;

