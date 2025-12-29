const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { createAccountUpload } = require('../middleware/upload');
const { validateChatId, validateMessage } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');
const { validate } = require('../middleware/validate');

const upload = createAccountUpload();

const sendBodySchema = z.object({
    chatId: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'chatId and message or media required',
            invalid_type_error: 'chatId and message or media required'
        })
            .min(1, 'chatId and message or media required')
            .refine(validateChatId, { message: 'Invalid chatId format' })
    ),
    message: z.preprocess((value) => {
        if (value === undefined || value === null) return undefined;
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        return trimmed ? trimmed : undefined;
    }, z.string().refine(validateMessage, { message: 'Message too long or invalid' }).optional())
});

router.post('/', upload.single('media'), validate({ body: sendBodySchema }), async (req, res) => {
    try {
        const { chatId, message } = req.validatedBody;
        const messageText = message || '';
        if (!messageText && !req.file) {
            return sendError(req, res, 400, 'chatId and message or media required');
        }
        const options = req.file ? { mediaPath: req.file.path } : {};
        const result = await req.account.whatsapp.sendMessage(chatId, messageText, options);
        return res.json({ success: true, messageId: result.id._serialized });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

module.exports = router;
