/**
 * WhatsApp Web Panel - AI Assistant Service
 * Integrates with Gemini or Vertex AI for text generation
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
}

module.exports = new AiService();
