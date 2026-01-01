const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { validateChatId } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');
const { validate } = require('../middleware/validate');

const intLike = (message) => z.preprocess(
    (value) => {
        if (value === undefined || value === null || value === '') return value;
        const parsed = parseInt(String(value), 10);
        return Number.isFinite(parsed) ? parsed : value;
    },
    z.number({
        required_error: message,
        invalid_type_error: message
    }).int().positive(message)
);

const chatIdParamSchema = z.object({
    id: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string({
            required_error: 'Invalid chatId format',
            invalid_type_error: 'Invalid chatId format'
        }).refine(validateChatId, { message: 'Invalid chatId format' })
    )
}).strict();

const tagIdBodySchema = z.object({
    tag_id: intLike('tag_id required')
}).strict();

const tagParamsSchema = z.object({
    id: chatIdParamSchema.shape.id,
    tagId: intLike('Invalid tag id')
}).strict();

router.get('/:id/tags', validate({ params: chatIdParamSchema }), (req, res) => {
    return res.json(req.account.db.contactTags.getByChatId.all(req.validatedParams.id));
});

router.post('/:id/tags', validate({ params: chatIdParamSchema, body: tagIdBodySchema }), (req, res) => {
    const chatId = req.validatedParams.id;
    const tagId = req.validatedBody.tag_id;
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

router.delete('/:id/tags/:tagId', validate({ params: tagParamsSchema }), (req, res) => {
    req.account.db.contactTags.remove.run(req.validatedParams.id, req.validatedParams.tagId);
    return res.json({ success: true });
});

router.get('/:id/profile-picture', validate({ params: chatIdParamSchema }), async (req, res) => {
    try {
        const url = await req.account.whatsapp.getProfilePictureUrl(req.validatedParams.id);
        return res.json({ success: true, url: url || null });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

module.exports = router;
