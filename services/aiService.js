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
        this.model = 'gemini-1.5-flash'; // Optimized for speed and cost
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    }

    async generateScript(prompt) {
        if (!this.apiKey) {
            throw new Error('GEMINI_API_KEY is not configured');
        }

        const systemPrompt = `
You are an expert JavaScript developer for a WhatsApp Web Panel automation system.
Your task is to generate a JavaScript script based on the user's natural language request.

**Runtime Environment (ScriptRunner):**
The code runs in a sandboxed Node.js 'vm' context. You can use standard ES6+ JavaScript.
The code should be wrapped in an async function or just be top-level code (it is wrapped in an async IIFE by the runner).

**Available API:**
1.  **Messaging:**
    *   \`await sendMessage(chatId, message)\`: Sends a text message to a specific chat.
    *   \`await reply(message)\`: Replies to the current message (context aware).

2.  **Data Access:**
    *   \`getChats()\`: Returns array of chats.
    *   \`getMessages(chatId, limit)\`: Returns array of messages.
    *   \`searchMessages(query)\`: Returns array of messages matching query.

3.  **Utilities:**
    *   \`fetch(url, options)\`: A wrapper around axios for HTTP requests.
    *   \`console.log(...)\`, \`console.info(...)\`, \`console.error(...)\`: Logs to system script logs.
    *   \`setTimeout(fn, ms)\`: Standard timeout.
    *   \`storage\`: Simple key-value store. \`storage.get(key)\`, \`storage.set(key, value)\`, \`storage.delete(key)\`, \`storage.clear()\`.

4.  **Context Objects:**
    *   \`msg\`: The incoming message object triggering the script.
        *   \`msg.body\` (string): Message content.
        *   \`msg.from\` (string): Sender ID (e.g., '12345@c.us').
        *   \`msg.to\` (string): Recipient ID.
        *   \`msg.chatId\` (string): Chat ID.
        *   \`msg.fromName\` (string): Sender display name.
        *   \`msg.isGroup\` (boolean): Is group message.
        *   \`msg.isFromMe\` (boolean): Is outgoing message.

**Output Format:**
You must return ONLY a raw JSON object (no markdown formatting, no code blocks) with the following structure:
{
  "name": "Short descriptive name",
  "description": "One sentence description",
  "trigger_type": "message",
  "trigger_filter": { // Optional filter object
    "contains": "keyword", // or "from": "id", or "regex": "pattern"
    "incoming": true // or false
  },
  "code": "The javascript code string"
}

**Example Request:** "Create a script that replies 'Pong' if I send 'Ping'"
**Example Output:**
{
  "name": "Ping Pong",
  "description": "Replies Pong to Ping",
  "trigger_type": "message",
  "trigger_filter": { "contains": "Ping", "incoming": true },
  "code": "await reply('Pong');"
}

**User Request:**
${prompt}
`;

        try {
            const response = await axios.post(
                `${this.baseUrl}/${this.model}:generateContent?key=${this.apiKey}`,
                {
                    contents: [{
                        role: 'user',
                        parts: [{ text: systemPrompt }]
                    }],
                    generationConfig: {
                        temperature: 0.2,
                        topK: 40,
                        topP: 0.95,
                        maxOutputTokens: 2048,
                        responseMimeType: "application/json"
                    }
                }
            );

            if (response.data && response.data.candidates && response.data.candidates.length > 0) {
                const content = response.data.candidates[0].content.parts[0].text;
                try {
                    // Clean up markdown if Gemini adds it despite instructions
                    const cleaned = content.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
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
