/**
 * WhatsApp Web Panel - AI Assistant Service
 * Integrates with Google Gemini to generate scripts
 */
const axios = require('axios');
const config = require('../config');
const { logger } = require('./logger');

class AiService {
    constructor() {
        this.apiKey = config.GEMINI_API_KEY;
        this.model = 'gemini-2.5-flash'; // Default model
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    }

    async generateText({ prompt, apiKey, model, maxOutputTokens = 4096, temperature = 0.3 }) {
        const effectiveKey = apiKey || this.apiKey;
        const effectiveModel = model || this.model;
        if (!effectiveKey) {
            throw new Error('GEMINI_API_KEY is not configured');
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
                const response = await axios.post(
                    `${this.baseUrl}/${effectiveModel}:generateContent?key=${effectiveKey}`,
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
        const apiKey = options.apiKey || this.apiKey;
        const model = options.model || this.model;
        const maxOutputTokens = Number.isFinite(options.maxOutputTokens) ? options.maxOutputTokens : 2048;
        const temperature = (typeof options.temperature === 'number') ? options.temperature : 0.2;

        if (!apiKey) {
            throw new Error('GEMINI_API_KEY is not configured');
        }

        const systemPrompt = `
You are an expert JavaScript developer for the "WhatsApp Web Panel" automation system.
Generate a single automation script that runs inside the panel's ScriptRunner.

Runtime environment:
- Your code runs in a sandboxed Node.js \`vm\` context.
- Your code is inserted verbatim inside an async IIFE:
  \`(async () => { /* your code */ })()\`
- Do NOT use \`require()\`, \`process\`, filesystem APIs, or any Node internals.

Available ScriptRunner API (these are the ONLY functions/objects you can rely on):
1) Messaging
  - \`await sendMessage(chatId, text)\`
  - \`await reply(text)\` (requires \`msg.chatId\`; only safe for message-trigger scripts)

2) Data (read-only)
  - \`getChats()\`
  - \`getMessages(chatId, limit = 50)\`
  - \`searchMessages(query)\`

3) HTTP (safe external only)
  - \`await fetch(url, options)\`
    - \`options\`: { method, headers, body }
    - returns: { ok, status, json(), text() }
    - blocks localhost/private/internal addresses and unsafe URLs

4) AI
  - \`await aiGenerate(prompt, options)\`
    - \`options\`: { model, maxTokens, temperature }
    - returns: generated text

5) State + logging
  - \`storage.get(key)\`, \`storage.set(key, value)\`, \`storage.delete(key)\`, \`storage.clear()\`
    - storage is per-script and persists in-memory across runs (resets on server restart)
  - \`console.log/info/warn/error(...)\` (goes to script logs)
  - \`log(...)\` alias (same as \`console.log\`)

6) Timing
  - \`setTimeout(fn, ms)\` (ms is capped at 30000)

Trigger context:
- \`msg\` (alias \`message\`) is the trigger object for \`trigger_type: "message"\`.
  Fields you can use:
  - \`messageId\`, \`chatId\`, \`from\`, \`to\`, \`fromName\`, \`fromNumber\`
  - \`body\`, \`type\`, \`timestamp\` (ms)
  - \`isGroup\`, \`isFromMe\`
  - \`mediaMimetype\`, \`mediaUrl\`, \`mediaPath\` (may be null until background download finishes)

Triggers:
- \`trigger_type\` can be: \`"message"\` | \`"ready"\` | \`"manual"\`
- For \`"ready"\` and \`"manual"\`, \`msg\` may be null/undefined. If you choose those triggers, your code MUST guard against missing \`msg\`.

Pre-run filter (\`trigger_filter\`):
This optional JSON object is applied by the runner BEFORE executing the script (message-trigger scripts only).
Supported keys:
- \`from\`: string (substring match against \`msg.from\`)
- \`contains\`: string (case-insensitive substring match against \`msg.body\`)
- \`regex\`: string (JS regex pattern; the runner applies the \`i\` flag)
- \`incoming\`: boolean (only incoming)
- \`outgoing\`: boolean (only outgoing)
- \`groupOnly\`: boolean (only groups)
- \`privateOnly\`: boolean (only private chats)

Output format:
Return ONLY a raw JSON object (no markdown, no code fences) with:
{
  "name": "Short descriptive name",
  "description": "One sentence description",
  "trigger_type": "message",
  "trigger_filter": { /* optional */ },
  "code": "JavaScript code as a string"
}

Rules:
- Use ONLY the ScriptRunner API listed above.
- Keep code minimal, robust, and readable.
- Do not include secrets or placeholders like API keys in the code.

User request:
${prompt}
`;

        try {
            const response = await axios.post(
                `${this.baseUrl}/${model}:generateContent?key=${apiKey}`,
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
                        responseMimeType: "application/json"
                    }
                }
            );

            if (response.data && response.data.candidates && response.data.candidates.length > 0) {
                const content = response.data.candidates[0].content.parts[0].text;
                try {
                    // Clean up markdown if Gemini adds it despite instructions
                    const cleaned = content.replace(/```json/g, '').replace(/```/g, '').trim();
                    return JSON.parse(cleaned);
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
