const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { LIMITS, validateMessage, normalizeTemplateVariables } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

const templateSchema = z.object({
    name: z.string()
        .trim()
        .min(1, 'name and content required')
        .max(LIMITS.TEMPLATE_NAME_LENGTH, 'Template name too long (max ' + LIMITS.TEMPLATE_NAME_LENGTH + ' chars)'),
    content: z.string()
        .trim()
        .min(1, 'name and content required')
        .refine(validateMessage, { message: 'Template content too long or invalid' }),
    variables: z.union([
        z.string().max(LIMITS.TEMPLATE_VARIABLES_LENGTH, 'Variables list too long (max ' + LIMITS.TEMPLATE_VARIABLES_LENGTH + ' chars)'),
        z.array(z.string()),
        z.null()
    ]).optional(),
    category: z.union([
        z.string().max(LIMITS.CATEGORY_LENGTH, 'Category too long (max ' + LIMITS.CATEGORY_LENGTH + ' chars)'),
        z.null()
    ]).optional()
}).strict();

router.get('/', (req, res) => {
    res.json(req.account.db.messageTemplates.getAll.all());
});

router.get('/:id', (req, res) => {
    const template = req.account.db.messageTemplates.getById.get(req.params.id);
    if (!template) return sendError(req, res, 404, 'Not found');
    return res.json(template);
});

router.post('/', requireRole(['admin', 'manager']), validate({ body: templateSchema }), (req, res) => {
    const { name, content, variables, category } = req.validatedBody;
    const normalizedVariables = normalizeTemplateVariables(variables);
    const variablesJson = normalizedVariables.length ? JSON.stringify(normalizedVariables) : null;
    const result = req.account.db.messageTemplates.create.run(name.trim(), content, variablesJson, category || null);
    return res.json({ success: true, id: result.lastInsertRowid });
});

router.put('/:id', requireRole(['admin', 'manager']), validate({ body: templateSchema }), (req, res) => {
    const { name, content, variables, category } = req.validatedBody;
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
