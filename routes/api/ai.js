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
    provider: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
        z.enum(['gemini', 'vertex']).optional()
    ),
    model: z.preprocess(
        (value) => (typeof value === 'string' ? value.trim() : value),
        z.string().max(80).optional()
    ),
    maxTokens: z.preprocess(
        (value) => {
            if (value === undefined || value === null || value === '') return undefined;
            const parsed = parseInt(String(value), 10);
            return Number.isFinite(parsed) ? parsed : value;
        },
        z.number().int().min(256).max(8192).optional()
    )
}).strict();

const aiChatAnalysisSchema = z.object({
    chatId: z.string().trim().min(1).max(128),
    chatName: z.string().trim().max(200).optional(),
    model: z.string().trim().min(1).max(80).optional(),
    prompt: z.string().trim().max(2000).optional(),
    messages: z.array(z.string().trim().min(1).max(2000)).min(1).max(1000)
}).strict();

const DEPRECATED_MODELS = new Set(['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash']);
const DEFAULT_MODEL = 'gemini-2.5-flash';

function resolveModel(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (!trimmed) continue;
        if (DEPRECATED_MODELS.has(trimmed)) continue;
        return trimmed;
    }
    const fallback = aiService.model || DEFAULT_MODEL;
    if (typeof fallback === 'string' && fallback.trim() && !DEPRECATED_MODELS.has(fallback.trim())) {
        return fallback.trim();
    }
    return DEFAULT_MODEL;
}

router.post('/generate-script', requireRole(['admin']), validate({ body: generateScriptSchema }), async (req, res) => {
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

        const { prompt } = req.validatedBody;
        const provider = user.ai_provider || aiService.provider || 'gemini';
        const apiKey = user.ai_api_key || (provider === 'vertex' ? aiService.vertexApiKey : aiService.apiKey) || null;
        if (!apiKey) {
            return sendError(req, res, 400, 'AI API anahtari kaydedilmedi');
        }
        const selectedModel = resolveModel(user.ai_model, aiService.model);
        const maxTokensParsed = Number.isFinite(user.ai_max_tokens)
            ? user.ai_max_tokens
            : parseInt(String(user.ai_max_tokens || ''), 10);
        const maxTokens = Number.isFinite(maxTokensParsed)
            ? Math.max(256, Math.min(8192, maxTokensParsed))
            : 2048;

        const rawScript = await aiService.generateScript(prompt, {
            provider,
            apiKey: user.ai_api_key || null,
            model: selectedModel,
            maxOutputTokens: maxTokens,
            temperature: 0.2
        });
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
        provider: user.ai_provider || 'gemini',
        model: user.ai_model || '',
        maxTokens: user.ai_max_tokens || null
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
    const providerRaw = req.validatedBody.provider;
    const modelRaw = req.validatedBody.model;
    const maxTokensRaw = req.validatedBody.maxTokens;

    const nextKey = (apiKeyRaw !== undefined) ? (apiKeyRaw ? apiKeyRaw.trim() : null) : (user.ai_api_key || null);
    const nextProvider = (providerRaw !== undefined) ? providerRaw : (user.ai_provider || null);
    const nextModel = (modelRaw !== undefined) ? (modelRaw ? modelRaw.trim() : null) : (user.ai_model || null);
    const nextMaxTokens = (maxTokensRaw !== undefined)
        ? (Number.isFinite(maxTokensRaw) ? maxTokensRaw : null)
        : (user.ai_max_tokens || null);

    db.users.updateAiConfig.run(nextKey, nextProvider, nextModel, nextMaxTokens, userId);
    return res.json({
        success: true,
        hasKey: Boolean(nextKey),
        provider: nextProvider || 'gemini',
        model: nextModel || '',
        maxTokens: nextMaxTokens || null
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
        const selectedModel = resolveModel(model, user.ai_model, aiService.model);
        const provider = user.ai_provider || aiService.provider || 'gemini';
        const apiKey = user.ai_api_key || (provider === 'vertex' ? aiService.vertexApiKey : aiService.apiKey) || null;
        if (!apiKey) {
            return sendError(req, res, 400, 'AI API anahtari kaydedilmedi');
        }
        const maxTokensParsed = Number.isFinite(user.ai_max_tokens)
            ? user.ai_max_tokens
            : parseInt(String(user.ai_max_tokens || ''), 10);
        const maxTokens = Number.isFinite(maxTokensParsed)
            ? Math.max(256, Math.min(8192, maxTokensParsed))
            : 4096;

        const header = chatName
            ? `Sohbet: ${chatName} (${chatId})`
            : `Sohbet: ${chatId}`;
        const requestText = (prompt && prompt.trim())
            ? prompt.trim()
            : 'Sohbeti analiz et, ozetle, dikkat ceken konulari ve aksiyonlari belirt.';

        const payloadText = `${header}\n\nMesajlar (kisi | tarih saat | icerik):\n${messages.join('\n')}\n\nAnaliz istegi:\n${requestText}`;

        const analysis = await aiService.generateText({
            prompt: payloadText,
            apiKey: user.ai_api_key || null,
            provider,
            model: selectedModel,
            maxOutputTokens: maxTokens,
            temperature: 0.3
        });

        return res.json({ success: true, analysis });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

module.exports = router;
