const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { LIMITS } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

router.get('/', (req, res) => {
    return res.json(req.account.db.autoReplies.getAll.all());
});

router.post('/', requireRole(['admin', 'manager']), (req, res) => {
    const { trigger_word, response, template_id, match_type, is_active, required_tag_id, exclude_tag_id } = req.body;
    if (!trigger_word || (!response && !template_id)) {
        return sendError(req, res, 400, 'trigger_word and response or template_id required');
    }
    if (trigger_word.length > LIMITS.TRIGGER_LENGTH) {
        return sendError(req, res, 400, 'Trigger word too long (max ' + LIMITS.TRIGGER_LENGTH + ' chars)');
    }
    if (response && response.length > LIMITS.MESSAGE_LENGTH) {
        return sendError(req, res, 400, 'Response too long (max ' + LIMITS.MESSAGE_LENGTH + ' chars)');
    }
    if (match_type === 'regex') {
        try {
            new RegExp(trigger_word);
        } catch (e) {
            return sendError(req, res, 400, 'Invalid regular expression');
        }
    }
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

router.put('/:id', requireRole(['admin', 'manager']), (req, res) => {
    const { trigger_word, response, template_id, match_type, is_active, required_tag_id, exclude_tag_id } = req.body;
    if (match_type === 'regex') {
        try {
            new RegExp(trigger_word);
        } catch (e) {
            return sendError(req, res, 400, 'Invalid regular expression');
        }
    }
    if (template_id) {
        const template = req.account.db.messageTemplates.getById.get(template_id);
        if (!template) {
            return sendError(req, res, 404, 'Template not found');
        }
    }
    req.account.db.autoReplies.update.run(
        trigger_word,
        response || '',
        template_id || null,
        match_type || 'contains',
        is_active ? 1 : 0,
        required_tag_id || null,
        exclude_tag_id || null,
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
