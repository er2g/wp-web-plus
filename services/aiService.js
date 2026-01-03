/**
 * WhatsApp Web Panel - AI Assistant Service
 * Integrates with Gemini or Vertex AI to generate scripts
 */
const axios = require('axios');
const config = require('../config');
const { logger } = require('./logger');

class AiService {
    constructor() {
        this.apiKey = config.GEMINI_API_KEY;
        this.vertexApiKey = config.VERTEX_API_KEY;
        this.model = 'gemini-2.5-flash'; // Default model
        this.provider = 'gemini';
        this.geminiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
        this.vertexBaseUrl = 'https://aiplatform.googleapis.com/v1';
    }

    normalizeProvider(provider) {
        const normalized = String(provider || '').trim().toLowerCase();
        if (!normalized) return this.provider || 'gemini';
        if (normalized === 'vertex' || normalized === 'aiplatform' || normalized === 'vertexai') return 'vertex';
        return 'gemini';
    }

    resolveApiKey(provider, apiKey) {
        const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
        if (trimmed) return trimmed;
        if (provider === 'vertex') return typeof this.vertexApiKey === 'string' ? this.vertexApiKey.trim() : '';
        return typeof this.apiKey === 'string' ? this.apiKey.trim() : '';
    }

    resolveModel(model) {
        const trimmed = typeof model === 'string' ? model.trim() : '';
        return trimmed || this.model;
    }

    buildVertexModelResource(model) {
        const raw = typeof model === 'string' ? model.trim() : '';
        if (!raw) return `publishers/google/models/${this.model}`;

        // If someone pastes a full URL, extract the resource path after /v1/.
        if (/^https?:\/\//i.test(raw)) {
            try {
                const url = new URL(raw);
                const pathname = String(url.pathname || '');
                const withoutPrefix = pathname.replace(/^\/?v1\//, '').replace(/^\/+/, '');
                const withoutOp = withoutPrefix.split(':')[0];
                if (withoutOp) return withoutOp;
            } catch (e) {}
        }

        const noQuery = raw.split('?')[0];
        const withoutOp = noQuery.split(':')[0];
        const normalized = withoutOp.replace(/^\/?v1\//, '').replace(/^\/+/, '');
        if (normalized.includes('/')) {
            return normalized;
        }
        return `publishers/google/models/${normalized}`;
    }

    buildRequestUrl({ provider, model, apiKey, method }) {
        if (provider === 'vertex') {
            const resource = this.buildVertexModelResource(model);
            return `${this.vertexBaseUrl}/${resource}:${method}?key=${encodeURIComponent(apiKey)}`;
        }
        return `${this.geminiBaseUrl}/${model}:${method}?key=${encodeURIComponent(apiKey)}`;
    }

    async generateText({ prompt, apiKey, model, provider, maxOutputTokens = 4096, temperature = 0.3 }) {
        const resolvedProvider = this.normalizeProvider(provider);
        const effectiveKey = this.resolveApiKey(resolvedProvider, apiKey);
        const effectiveModel = this.resolveModel(model);
        if (!effectiveKey) {
            throw new Error('AI API key is not configured');
        }
        if (!prompt) {
            throw new Error('Prompt is required');
        }

        try {
            const originalPrompt = String(prompt);
            const maxContinuations = 3;
            let accumulated = '';
            let attemptPrompt = originalPrompt;

            for (let attempt = 0; attempt <= maxContinuations; attempt++) {
                const url = this.buildRequestUrl({
                    provider: resolvedProvider,
                    model: effectiveModel,
                    apiKey: effectiveKey,
                    method: 'generateContent'
                });
                const response = await axios.post(
                    url,
                    {
                        contents: [{
                            role: 'user',
                            parts: [{ text: attemptPrompt }]
                        }],
                        generationConfig: {
                            temperature,
                            topK: 40,
                            topP: 0.95,
                            maxOutputTokens
                        }
                    }
                );

                const candidate = response.data?.candidates?.[0];
                const parts = candidate?.content?.parts || [];
                const chunk = parts.map(part => part?.text || '').join('');
                if (chunk) {
                    accumulated += chunk;
                }

                const finishReasonRaw = candidate?.finishReason ?? candidate?.finish_reason;
                const finishReason = typeof finishReasonRaw === 'string'
                    ? finishReasonRaw.trim().toUpperCase()
                    : String(finishReasonRaw || '').trim().toUpperCase();

                const isMaxTokens = finishReason === 'MAX_TOKENS'
                    || finishReason === 'MAX_OUTPUT_TOKENS'
                    || finishReason.includes('MAX_TOKENS');
                if (!isMaxTokens || attempt >= maxContinuations) {
                    break;
                }

                const tail = accumulated.slice(-2000);
                attemptPrompt = [
                    'Your previous response was cut off because it hit the maximum output token limit.',
                    '',
                    'Original request:',
                    originalPrompt,
                    '',
                    'Partial answer so far (tail):',
                    tail,
                    '',
                    'Continue EXACTLY from where you left off.',
                    '- Do NOT repeat any text you already wrote.',
                    '- Do NOT restart or summarize.',
                    '- Do NOT add prefaces like "Sure" or "Continuing".',
                    '- If the continuation starts a new word, include a leading space.'
                ].join('\n');
            }

            const text = accumulated.trim();
            if (!text) {
                throw new Error('No response from AI');
            }
            return text;
        } catch (error) {
            logger.error('AI text generation failed', {
                error: error.message,
                response: error.response?.data
            });
            throw new Error('AI generation failed: ' + (error.response?.data?.error?.message || error.message));
        }
    }

    async generateScript(prompt, options = {}) {
        const resolvedProvider = this.normalizeProvider(options.provider);
        const apiKey = this.resolveApiKey(resolvedProvider, options.apiKey);
        const model = this.resolveModel(options.model);
        const maxOutputTokens = Number.isFinite(options.maxOutputTokens) ? options.maxOutputTokens : 2048;
        const temperature = (typeof options.temperature === 'number') ? options.temperature : 0.2;

        if (!apiKey) {
            throw new Error('AI API key is not configured');
        }

        const systemPrompt = `
You are a senior automation engineer for the "WhatsApp Web Panel" scripting system.
Your job is to turn the user's request into ONE runnable script.

Think through the request step by step internally, but output ONLY the final JSON.

Output format (strict JSON only, no markdown):
{
  "name": "Short descriptive name",
  "description": "One sentence description",
  "trigger_type": "message | ready | manual",
  "trigger_filter": { /* optional */ },
  "code": "JavaScript code as a string"
}

Rules:
- Output ONLY the JSON object. No extra text.
- Use double quotes. The JSON must parse.
- Use ONLY the ScriptRunner API below. No require(), no process, no fs.
- Do NOT invent chat IDs or phone numbers. If a full chat id is explicitly provided, you may use trigger_filter.chatIds.
- If the scope is unclear, keep trigger_filter minimal and rely on the caller to scope chats.

Available ScriptRunner API:
1) Messaging
  - await sendMessage(chatId, text)
  - await reply(text)  // only if msg.chatId exists
2) Data (read-only)
  - getChats()
  - getMessages(chatId, limit = 50, offset = 0)
  - searchMessages(query)
3) HTTP (safe external only)
  - await fetch(url, { method, headers, body })
4) AI
  - await aiGenerate(prompt, { model, maxTokens, temperature })
5) State + logging
  - storage.get/set/delete/clear (per-script in-memory)
  - console.log/info/warn/error, log(...)
6) Timing
  - setTimeout(fn, ms)  // ms capped at 30000

Trigger context (msg / message):
- messageId, chatId, from, to, fromName, fromNumber, body, type, timestamp
- isGroup, isFromMe, mediaMimetype, mediaUrl, mediaPath

Pre-run filter (trigger_filter):
- from, contains, regex, incoming, outgoing, groupOnly, privateOnly, chatIds (optional array)

Behavior guidance:
- For auto-reply tasks: run only on incoming messages, skip if msg is missing or isFromMe.
- Use storage to de-duplicate (e.g., last message id or timestamp).
- If history is requested, call getMessages(chatId, N), sort oldest->newest, and format as "name | time | text".
- Use aiGenerate for the reply and keep it natural and concise.
- Add randomized delay if requested (setTimeout).
- Guard against empty bodies and missing msg for ready/manual triggers.

User request:
${prompt}
`;

        try {
            const url = this.buildRequestUrl({
                provider: resolvedProvider,
                model,
                apiKey,
                method: 'generateContent'
            });
            const response = await axios.post(
                url,
                {
                    contents: [{
                        role: 'user',
                        parts: [{ text: systemPrompt }]
                    }],
                    generationConfig: {
                        temperature,
                        topK: 40,
                        topP: 0.95,
                        maxOutputTokens,
                        ...(resolvedProvider === 'gemini' ? { responseMimeType: 'application/json' } : {})
                    }
                }
            );

            if (response.data && response.data.candidates && response.data.candidates.length > 0) {
                const parts = response.data?.candidates?.[0]?.content?.parts || [];
                const content = parts.map(part => part?.text || '').join('');
                try {
                    // Clean up markdown if Gemini adds it despite instructions
                    const cleaned = content.replace(/```json/g, '').replace(/```/g, '').trim();
                    try {
                        return JSON.parse(cleaned);
                    } catch (e) {
                        const start = cleaned.indexOf('{');
                        const end = cleaned.lastIndexOf('}');
                        if (start >= 0 && end > start) {
                            return JSON.parse(cleaned.slice(start, end + 1));
                        }
                        throw e;
                    }
                } catch (e) {
                    logger.error('AI JSON parse error', { error: e.message, content });
                    throw new Error('Failed to parse AI response');
                }
            } else {
                throw new Error('No response from AI');
            }
        } catch (error) {
            logger.error('AI generation failed', {
                error: error.message,
                response: error.response?.data
            });
            throw new Error('AI generation failed: ' + (error.response?.data?.error?.message || error.message));
        }
    }
}

module.exports = new AiService();
