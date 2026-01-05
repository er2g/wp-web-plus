/**
 * WhatsApp Web Panel - AI Assistant Service
 * Integrates with Gemini or Vertex AI for text and JSON generation
 */
const axios = require('axios');
const config = require('../config');
const { logger } = require('./logger');

class AiService {
    constructor() {
        this.apiKey = config.GEMINI_API_KEY;
        this.vertexApiKey = config.VERTEX_API_KEY;
        this.model = 'gemini-1.5-flash'; // Optimized for speed and cost
        this.provider = 'gemini';
        this.geminiBaseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
        this.vertexBaseUrl = 'https://aiplatform.googleapis.com/v1';
    }

    /**
     * Normalize provider string to 'gemini' or 'vertex'
     */
    normalizeProvider(provider) {
        const normalized = String(provider || '').trim().toLowerCase();
        if (!normalized) return this.provider || 'gemini';
        if (['vertex', 'aiplatform', 'vertexai'].includes(normalized)) return 'vertex';
        return 'gemini';
    }

    /**
     * Resolve API Key based on provider
     */
    resolveApiKey(provider, apiKey) {
        const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
        if (trimmed) return trimmed;
        if (provider === 'vertex') return typeof this.vertexApiKey === 'string' ? this.vertexApiKey.trim() : '';
        return typeof this.apiKey === 'string' ? this.apiKey.trim() : '';
    }

    resolveModel(model) {
        return (typeof model === 'string' && model.trim()) ? model.trim() : this.model;
    }

    buildVertexModelResource(model) {
        const raw = typeof model === 'string' ? model.trim() : '';
        if (!raw) return `publishers/google/models/${this.model}`;

        // Extract clean model ID/path
        const noQuery = raw.split('?')[0];
        let normalized = noQuery.replace(/^https?:\/\/.*\/v1\//, '').replace(/^\/+/, '');
        
        if (!normalized.includes('/')) {
            return `publishers/google/models/${normalized}`;
        }
        return normalized;
    }

    buildRequestUrl({ provider, model, apiKey, method }) {
        if (provider === 'vertex') {
            const resource = this.buildVertexModelResource(model);
            return `${this.vertexBaseUrl}/${resource}:${method}?key=${encodeURIComponent(apiKey)}`;
        }
        return `${this.geminiBaseUrl}/${model}:${method}?key=${encodeURIComponent(apiKey)}`;
    }

    /**
     * Core generation function.
     * Handles text and JSON generation with optional max token looping (for long text).
     */
    async generateDetailed({ prompt, apiKey, model, provider, maxOutputTokens = 8192, temperature = 0.3, jsonMode = false, systemInstruction = null }) {
        const resolvedProvider = this.normalizeProvider(provider);
        const effectiveKey = this.resolveApiKey(resolvedProvider, apiKey);
        const effectiveModel = this.resolveModel(model);

        if (!effectiveKey) throw new Error('AI API key is not configured');
        if (!prompt) throw new Error('Prompt is required');

        const generationConfig = {
            temperature,
            topK: 40,
            topP: 0.95,
            maxOutputTokens
        };

        // Enable JSON mode if requested (Gemini 1.5+ supports this natively)
        if (jsonMode) {
            generationConfig.responseMimeType = "application/json";
        }

        const requestBody = {
            contents: [{
                role: 'user',
                parts: [{ text: String(prompt) }]
            }],
            generationConfig
        };

        if (systemInstruction) {
            requestBody.systemInstruction = {
                parts: [{ text: systemInstruction }]
            };
        }

        try {
            const url = this.buildRequestUrl({
                provider: resolvedProvider,
                model: effectiveModel,
                apiKey: effectiveKey,
                method: 'generateContent'
            });

            const response = await axios.post(url, requestBody);

            const candidate = response.data?.candidates?.[0];
            if (!candidate) throw new Error('No candidates returned from AI');

            const parts = candidate.content?.parts || [];
            const text = parts.map(p => p.text).join('');

            return {
                text,
                finishReason: candidate.finishReason || candidate.finish_reason || null,
                usage: response.data?.usageMetadata || response.data?.usage || null,
                model: effectiveModel,
                provider: resolvedProvider
            };

        } catch (error) {
            const msg = error.response?.data?.error?.message || error.message;
            logger.error('AI Service Error', { error: msg, provider: resolvedProvider, model: effectiveModel });
            throw new Error(`AI generation failed: ${msg}`);
        }
    }

    async generate(options) {
        const result = await this.generateDetailed(options);
        return result.text;
    }

    /**
     * Generates text content.
     */
    async generateText(options) {
        return this.generate({ ...options, jsonMode: false });
    }

    async generateTextDetailed(options) {
        return this.generateDetailed({ ...options, jsonMode: false });
    }

    /**
     * Helper to strip markdown code blocks and conversational text from JSON string
     */
    cleanJson(text) {
        if (typeof text !== 'string') return '';
        let clean = text.trim();
        
        // Find the first '{' and the last '}'
        const firstBrace = clean.indexOf('{');
        const lastBrace = clean.lastIndexOf('}');

        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            clean = clean.slice(firstBrace, lastBrace + 1);
        }
        
        return clean;
    }

    /**
     * Generates and parses JSON content.
     * Retries once on parse error.
     */
    async generateJson(options) {
        try {
            const rawText = await this.generate({ ...options, jsonMode: true });
            const jsonText = this.cleanJson(rawText);
            return JSON.parse(jsonText);
        } catch (error) {
            // Simple retry logic for JSON parsing issues
            logger.warn('JSON Parse failed, retrying once...', { error: error.message });
            try {
                const retryText = await this.generate({ 
                    ...options, 
                    jsonMode: true, 
                    prompt: options.prompt + "\n\nError parsing previous JSON. Ensure valid JSON format (no markdown)." 
                });
                const cleanRetry = this.cleanJson(retryText);
                return JSON.parse(cleanRetry);
            } catch (retryError) {
                throw new Error('Failed to generate valid JSON: ' + retryError.message);
            }
        }
    }
}

module.exports = new AiService();
