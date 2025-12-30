const express = require('express');
const router = express.Router();
const { z } = require('zod');

const aiService = require('../../services/aiService');
const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { sendError } = require('../../lib/httpResponses');

const generateScriptSchema = z.object({
    prompt: z.string().trim().min(1, 'Prompt is required')
}).strict();

const triggerFilterSchema = z.object({
    from: z.string().trim().min(1).optional(),
    contains: z.string().trim().min(1).optional(),
    regex: z.string().trim().min(1).optional(),
    incoming: z.boolean().optional(),
    outgoing: z.boolean().optional(),
    groupOnly: z.boolean().optional(),
    privateOnly: z.boolean().optional()
}).strict();

const aiScriptSchema = z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    trigger_type: z.enum(['message', 'ready', 'manual']).optional(),
    trigger_filter: z.union([triggerFilterSchema, z.null()]).optional(),
    code: z.string().trim().min(1).max(20000)
}).strict();

router.post('/generate-script', requireRole(['admin']), validate({ body: generateScriptSchema }), async (req, res) => {
    try {
        const { prompt } = req.validatedBody;
        const rawScript = await aiService.generateScript(prompt);
        const parsed = aiScriptSchema.parse(rawScript);
        const script = {
            name: parsed.name,
            description: parsed.description || '',
            trigger_type: parsed.trigger_type || 'message',
            trigger_filter: parsed.trigger_filter || undefined,
            code: parsed.code
        };
        return res.json({ success: true, script });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

module.exports = router;
