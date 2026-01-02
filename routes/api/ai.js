const express = require('express');
const router = express.Router();
const { z } = require('zod');

const aiService = require('../../services/aiService');
const accountManager = require('../../services/accountManager');
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

const aiConfigSchema = z.object({
    apiKey: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string().max(512).optional()
    ),
    model: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string().max(80).optional()
    )
}).strict();

const aiChatAnalysisSchema = z.object({
    chatId: z.string().trim().min(1).max(128),
    chatName: z.string().trim().max(200).optional(),
    model: z.string().trim().min(1).max(80).optional(),
    prompt: z.string().trim().max(2000).optional(),
    messages: z.array(z.string().trim().min(1).max(2000)).min(1).max(1000)
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

router.get('/config', requireRole(['admin']), (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
        return sendError(req, res, 401, 'Not authenticated');
    }
    const db = accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
    const user = db.users.getById.get(userId);
    if (!user) {
        return sendError(req, res, 404, 'User not found');
    }
    return res.json({
        hasKey: Boolean(user.ai_api_key),
        model: user.ai_model || ''
    });
});

router.post('/config', requireRole(['admin']), validate({ body: aiConfigSchema }), (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
        return sendError(req, res, 401, 'Not authenticated');
    }
    const db = accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
    const user = db.users.getById.get(userId);
    if (!user) {
        return sendError(req, res, 404, 'User not found');
    }

    const apiKeyRaw = req.validatedBody.apiKey;
    const modelRaw = req.validatedBody.model;

    const nextKey = (apiKeyRaw !== undefined) ? (apiKeyRaw ? apiKeyRaw.trim() : null) : (user.ai_api_key || null);
    const nextModel = (modelRaw !== undefined) ? (modelRaw ? modelRaw.trim() : null) : (user.ai_model || null);

    db.users.updateAiConfig.run(nextKey, nextModel, userId);
    return res.json({
        success: true,
        hasKey: Boolean(nextKey),
        model: nextModel || ''
    });
});

router.post('/analyze-chat', requireRole(['admin']), validate({ body: aiChatAnalysisSchema }), async (req, res) => {
    try {
        const userId = req.session?.userId;
        if (!userId) {
            return sendError(req, res, 401, 'Not authenticated');
        }
        const db = accountManager.getAccountContext(accountManager.getDefaultAccountId()).db;
        const user = db.users.getById.get(userId);
        if (!user) {
            return sendError(req, res, 404, 'User not found');
        }

        const { chatId, chatName, model, prompt, messages } = req.validatedBody;
        const selectedModel = model || user.ai_model || 'gemini-1.5-flash';
        const apiKey = user.ai_api_key || aiService.apiKey || null;
        if (!apiKey) {
            return sendError(req, res, 400, 'Gemini API anahtari kaydedilmedi');
        }

        const header = chatName
            ? `Sohbet: ${chatName} (${chatId})`
            : `Sohbet: ${chatId}`;
        const requestText = (prompt && prompt.trim())
            ? prompt.trim()
            : 'Sohbeti analiz et, ozetle, dikkat ceken konulari ve aksiyonlari belirt.';

        const payloadText = `${header}\n\nMesajlar (kisi | tarih saat | icerik):\n${messages.join('\n')}\n\nAnaliz istegi:\n${requestText}`;

        const analysis = await aiService.generateText({
            prompt: payloadText,
            apiKey,
            model: selectedModel,
            maxOutputTokens: 2048,
            temperature: 0.3
        });

        return res.json({ success: true, analysis });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

module.exports = router;
