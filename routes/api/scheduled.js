const express = require('express');

const router = express.Router();

const { validateChatId, validateMessage } = require('../../lib/apiValidation');

router.get('/', (req, res) => {
    res.json(req.account.db.scheduled.getAll.all());
});

router.post('/', (req, res) => {
    const { chat_id, chat_name, message, template_id, scheduled_at, is_recurring, cron_expression } = req.body;
    if (!chat_id || (!message && !template_id) || !scheduled_at) {
        return res.status(400).json({ error: 'chat_id, message or template_id, and scheduled_at required' });
    }

    if (!validateChatId(chat_id)) {
        return res.status(400).json({ error: 'Invalid chat_id format' });
    }
    if (message && !validateMessage(message)) {
        return res.status(400).json({ error: 'Message too long or invalid' });
    }

    let resolvedMessage = message || '';
    if (template_id) {
        const template = req.account.db.messageTemplates.getById.get(template_id);
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }
        if (!resolvedMessage) {
            resolvedMessage = template.content;
        }
    }

    if (is_recurring && !cron_expression) {
        return res.status(400).json({ error: 'cron_expression required for recurring schedule' });
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
            return res.status(400).json({ error: 'Invalid cron_expression' });
        }
    }

    return res.json({ success: true, id: result.lastInsertRowid });
});

router.delete('/:id', (req, res) => {
    const scheduledId = parseInt(req.params.id, 10);
    if (Number.isNaN(scheduledId)) {
        return res.status(400).json({ error: 'Invalid scheduled id' });
    }
    req.account.scheduler.removeRecurring(scheduledId);
    req.account.db.scheduled.delete.run(scheduledId);
    return res.json({ success: true });
});

module.exports = router;
