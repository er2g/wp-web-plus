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

router.post('/generate-script', requireRole(['admin']), validate({ body: generateScriptSchema }), async (req, res) => {
    try {
        const { prompt } = req.validatedBody;
        const script = await aiService.generateScript(prompt);
        return res.json({ success: true, script });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

module.exports = router;
