const express = require('express');
const router = express.Router();

const { createAccountUpload } = require('../middleware/upload');
const { validateChatId, validateMessage } = require('../../lib/apiValidation');

const upload = createAccountUpload();

router.post('/', upload.single('media'), async (req, res) => {
    try {
        const body = req.body || {};
        const chatId = body.chatId;
        const message = body.message;
        const trimmedMessage = (message || '').trim();
        if (!chatId || (!trimmedMessage && !req.file)) {
            return res.status(400).json({ error: 'chatId and message or media required' });
        }
        if (!validateChatId(chatId)) {
            return res.status(400).json({ error: 'Invalid chatId format' });
        }
        if (trimmedMessage && !validateMessage(trimmedMessage)) {
            return res.status(400).json({ error: 'Message too long or invalid' });
        }
        const options = req.file ? { mediaPath: req.file.path } : {};
        const result = await req.account.whatsapp.sendMessage(chatId, trimmedMessage, options);
        return res.json({ success: true, messageId: result.id._serialized });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

module.exports = router;
