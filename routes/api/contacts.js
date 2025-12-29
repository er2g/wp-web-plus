const express = require('express');
const router = express.Router();

const { validateChatId } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

router.get('/:id/tags', (req, res) => {
    return res.json(req.account.db.contactTags.getByChatId.all(req.params.id));
});

router.post('/:id/tags', (req, res) => {
    const chatId = req.params.id;
    const tagId = req.body?.tag_id;
    if (!tagId) {
        return sendError(req, res, 400, 'tag_id required');
    }
    if (!validateChatId(chatId)) {
        return sendError(req, res, 400, 'Invalid chatId format');
    }
    const tag = req.account.db.tags.getById.get(tagId);
    if (!tag) {
        return sendError(req, res, 404, 'Tag not found');
    }
    const chat = req.account.db.chats.getById.get(chatId);
    const name = chat?.name || chatId;
    const phone = chatId && chatId.includes('@c.us') ? chatId.split('@')[0] : null;
    req.account.db.contacts.upsert.run(chatId, name, phone);
    req.account.db.contactTags.add.run(chatId, tagId);
    return res.json({ success: true });
});

router.delete('/:id/tags/:tagId', (req, res) => {
    req.account.db.contactTags.remove.run(req.params.id, req.params.tagId);
    return res.json({ success: true });
});

module.exports = router;
