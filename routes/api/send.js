const express = require('express');
const router = express.Router();

const { createAccountUpload } = require('../middleware/upload');
const { validateChatId, validateMessage } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

const upload = createAccountUpload();

router.post('/', upload.single('media'), async (req, res) => {
    try {
        const body = req.body || {};
        const chatId = body.chatId;
        const message = body.message;
        const trimmedMessage = (message || '').trim();
        if (!chatId || (!trimmedMessage && !req.file)) {
            return sendError(req, res, 400, 'chatId and message or media required');
        }
        if (!validateChatId(chatId)) {
            return sendError(req, res, 400, 'Invalid chatId format');
        }
        if (trimmedMessage && !validateMessage(trimmedMessage)) {
            return sendError(req, res, 400, 'Message too long or invalid');
        }
        const options = req.file ? { mediaPath: req.file.path } : {};
        const result = await req.account.whatsapp.sendMessage(chatId, trimmedMessage, options);
        return res.json({ success: true, messageId: result.id._serialized });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

module.exports = router;
