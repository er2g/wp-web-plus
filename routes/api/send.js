const express = require('express');
const router = express.Router();
const { z } = require('zod');
const fs = require('fs');

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
    }, z.string().refine(validateMessage, { message: 'Message too long or invalid' }).optional()),
    quotedMessageId: z.preprocess((value) => {
        if (value === undefined || value === null) return undefined;
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        return trimmed ? trimmed : undefined;
    }, z.string().max(200, 'Invalid quotedMessageId').optional()),
    sendAsSticker: z.preprocess((value) => {
        if (value === undefined || value === null || value === '') return undefined;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
            if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        }
        return value;
    }, z.boolean().optional())
});

router.post('/', upload.single('media'), validate({ body: sendBodySchema }), async (req, res) => {
    const mediaPath = req.file?.path;
    try {
        const { chatId, message, quotedMessageId, sendAsSticker } = req.validatedBody;
        const messageText = message || '';
        if (!messageText && !mediaPath) {
            return sendError(req, res, 400, 'chatId and message or media required');
        }
        const options = mediaPath ? { mediaPath } : {};
        if (quotedMessageId) {
            options.quotedMessageId = quotedMessageId;
        }
        if (mediaPath && sendAsSticker === true) {
            options.sendAsSticker = true;
        }
        const result = await req.account.whatsapp.sendMessage(chatId, messageText, options);
        return res.json({ success: true, messageId: result.id._serialized });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    } finally {
        if (mediaPath) {
            try {
                fs.unlinkSync(mediaPath);
            } catch (cleanupError) {
                req.log?.warn?.('Send media cleanup failed', { error: cleanupError.message });
            }
        }
    }
});

module.exports = router;
